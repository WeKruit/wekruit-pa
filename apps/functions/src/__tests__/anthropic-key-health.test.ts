/**
 * anthropic-key-health unit tests — classify + run (injected fetch/notify/dedupe).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  classifyAnthropicPing,
  isPageableAnthropicVerdict,
  runAnthropicKeyHealth,
} from "../anthropic-key-health.js"

describe("classifyAnthropicPing", () => {
  it("200 → ok", () => {
    assert.equal(classifyAnthropicPing({ status: 200 }).verdict, "ok")
  })
  it("401/403 → revoked", () => {
    assert.equal(classifyAnthropicPing({ status: 401 }).verdict, "revoked")
    assert.equal(classifyAnthropicPing({ status: 403 }).verdict, "revoked")
  })
  it("429 → quota-exhausted", () => {
    assert.equal(classifyAnthropicPing({ status: 429 }).verdict, "quota-exhausted")
  })
  it("billing_error body → quota-exhausted", () => {
    const v = classifyAnthropicPing({ status: 400, body: JSON.stringify({ error: { type: "billing_error" } }) })
    assert.equal(v.verdict, "quota-exhausted")
  })
  it("5xx → unknown (no page)", () => {
    const v = classifyAnthropicPing({ status: 503 })
    assert.equal(v.verdict, "unknown")
    assert.equal(isPageableAnthropicVerdict(v.verdict), false)
  })
})

function fakeNotify() {
  const calls: Array<{ level: string; title: string }> = []
  const notify = (async (i: { level: string; title: string }) => {
    calls.push({ level: i.level, title: i.title })
    return { slack: { posted: false, reason: "skipped" as const }, email: { ok: false, status: 0, reason: "t" }, deduped: false, anyDelivered: false }
  }) as never
  return { calls, notify }
}

describe("runAnthropicKeyHealth", () => {
  it("skips when no key", async () => {
    const { calls, notify } = fakeNotify()
    const r = await runAnthropicKeyHealth({ apiKey: "", notify })
    assert.equal(r.verdict, "skipped")
    assert.equal(calls.length, 0)
  })

  it("401 → fires revoked alert (error level)", async () => {
    const { calls, notify } = fakeNotify()
    const fetchImpl = (async () => ({ status: 401, async text() { return JSON.stringify({ error: { type: "authentication_error" } }) } })) as unknown as typeof fetch
    const r = await runAnthropicKeyHealth({ apiKey: "sk-ant-xxxxxxxxxxx", notify, fetchImpl })
    assert.equal(r.verdict, "revoked")
    assert.deepEqual(r.alertsFired, ["anthropic-key-revoked"])
    assert.equal(calls[0].level, "error")
  })

  it("200 → ok, no alert", async () => {
    const { calls, notify } = fakeNotify()
    const fetchImpl = (async () => ({ status: 200, async text() { return "{}" } })) as unknown as typeof fetch
    const r = await runAnthropicKeyHealth({ apiKey: "sk-ant-xxxxxxxxxxx", notify, fetchImpl })
    assert.equal(r.verdict, "ok")
    assert.equal(calls.length, 0)
  })

  it("dedupe gate suppresses a same-day repeat", async () => {
    const { calls, notify } = fakeNotify()
    const fetchImpl = (async () => ({ status: 429, async text() { return "{}" } })) as unknown as typeof fetch
    const claimed = new Set<string>()
    const claimAlert = async (kind: string) => {
      if (claimed.has(kind)) return false
      claimed.add(kind)
      return true
    }
    const a = await runAnthropicKeyHealth({ apiKey: "sk-ant-xxxxxxxxxxx", notify, fetchImpl, claimAlert })
    const b = await runAnthropicKeyHealth({ apiKey: "sk-ant-xxxxxxxxxxx", notify, fetchImpl, claimAlert })
    assert.deepEqual(a.alertsFired, ["anthropic-key-quota-exhausted"])
    assert.deepEqual(b.alertsDeduped, ["anthropic-key-quota-exhausted"])
    assert.equal(calls.length, 1, "only the first run alerts")
  })
})
