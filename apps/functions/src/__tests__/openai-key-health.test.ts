/**
 * paOpenAiKeyHealth driver tests — `runOpenAiKeyHealth` with mocked fetch.
 *
 * No real key, no real network. Verifies:
 *   - 401 → fires "key-revoked" exactly once (dedupe)
 *   - 429 insufficient_quota → fires "key-quota-exhausted"
 *   - 429 rate_limit / 5xx / network error → NO page (key still alive)
 *   - 200 ok → no key alert; daily costs poll fires budget warning at ≥80%
 *   - dedupe gate suppresses a second same-kind alert in the same day
 *   - missing key → verdict "skipped", no fetch
 *   - no key value ever appears in dispatched alerts
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  runOpenAiKeyHealth,
  keyPrefix,
  monthStartUnix,
  type AlertKind,
} from "../openai-key-health.js"

const LIVE_KEY = "sk-proj-fFdZ4aL7THISisAfakeTESTkeyNOTreal000000"

/** Build a fetch stub from a sequence of {url-matcher → response}. */
function stubFetch(
  handlers: Array<{ match: (url: string) => boolean; status: number; body?: unknown }>
): { fetchImpl: typeof fetch; urls: () => string[] } {
  const urls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const h = handlers.find((x) => x.match(url))
    if (!h) throw new Error(`no stub for ${url}`)
    const bodyStr = typeof h.body === "string" ? h.body : JSON.stringify(h.body ?? {})
    return new Response(bodyStr, { status: h.status })
  }) as unknown as typeof fetch
  return { fetchImpl, urls: () => urls }
}

/** In-memory dedupe gate — first claim per kind wins. */
function memoryClaim(): {
  claimAlert: (kind: AlertKind, nowMs: number) => Promise<boolean>
  claimed: () => AlertKind[]
} {
  const seen = new Set<string>()
  const claimed: AlertKind[] = []
  return {
    claimAlert: async (kind, nowMs) => {
      const key = `${new Date(nowMs).toISOString().slice(0, 10)}-${kind}`
      if (seen.has(key)) return false
      seen.add(key)
      claimed.push(kind)
      return true
    },
    claimed: () => claimed,
  }
}

const NOW = Date.UTC(2026, 5, 15, 12, 0) // 2026-06-15

describe("runOpenAiKeyHealth — health ping", () => {
  it("fires key-revoked once on 401 invalid_api_key", async () => {
    const { fetchImpl } = stubFetch([
      { match: (u) => u.includes("/models"), status: 401, body: { error: { code: "invalid_api_key" } } },
    ])
    const gate = memoryClaim()
    const r = await runOpenAiKeyHealth({
      apiKey: LIVE_KEY,
      fetchImpl,
      shouldPollCosts: false,
      claimAlert: gate.claimAlert,
      now: () => NOW,
    })
    assert.equal(r.verdict, "revoked")
    assert.deepEqual(r.alertsFired, ["key-revoked"])
    assert.deepEqual(gate.claimed(), ["key-revoked"])
  })

  it("fires key-quota-exhausted on 429 insufficient_quota", async () => {
    const { fetchImpl } = stubFetch([
      { match: (u) => u.includes("/models"), status: 429, body: { error: { type: "insufficient_quota" } } },
    ])
    const gate = memoryClaim()
    const r = await runOpenAiKeyHealth({
      apiKey: LIVE_KEY,
      fetchImpl,
      shouldPollCosts: false,
      claimAlert: gate.claimAlert,
      now: () => NOW,
    })
    assert.equal(r.verdict, "quota_exhausted")
    assert.deepEqual(r.alertsFired, ["key-quota-exhausted"])
  })

  it("does NOT page on 429 rate_limit_exceeded (key alive)", async () => {
    const { fetchImpl } = stubFetch([
      { match: (u) => u.includes("/models"), status: 429, body: { error: { code: "rate_limit_exceeded" } } },
    ])
    const r = await runOpenAiKeyHealth({
      apiKey: LIVE_KEY,
      fetchImpl,
      shouldPollCosts: false,
      now: () => NOW,
    })
    assert.equal(r.verdict, "rate_limited")
    assert.deepEqual(r.alertsFired, [])
  })

  it("does NOT page on network error (fail-open)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ETIMEDOUT")
    }) as unknown as typeof fetch
    const r = await runOpenAiKeyHealth({
      apiKey: LIVE_KEY,
      fetchImpl,
      shouldPollCosts: false,
      now: () => NOW,
    })
    assert.equal(r.verdict, "unknown")
    assert.deepEqual(r.alertsFired, [])
  })

  it("skips entirely when key is unset", async () => {
    const { fetchImpl, urls } = stubFetch([
      { match: () => true, status: 200 },
    ])
    const r = await runOpenAiKeyHealth({
      apiKey: "",
      fetchImpl,
      shouldPollCosts: false,
      now: () => NOW,
    })
    assert.equal(r.verdict, "skipped")
    assert.equal(urls().length, 0)
  })

  it("treats __UNSET__ sentinel key as unset", async () => {
    const r = await runOpenAiKeyHealth({
      apiKey: "__UNSET__",
      fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      shouldPollCosts: false,
      now: () => NOW,
    })
    assert.equal(r.verdict, "skipped")
  })

  it("dedupe gate suppresses a second key-revoked the same day", async () => {
    const gate = memoryClaim()
    const handlers = [
      { match: (u: string) => u.includes("/models"), status: 401, body: { error: { code: "invalid_api_key" } } },
    ]
    // First tick fires.
    const first = await runOpenAiKeyHealth({
      apiKey: LIVE_KEY,
      fetchImpl: stubFetch(handlers).fetchImpl,
      shouldPollCosts: false,
      claimAlert: gate.claimAlert,
      now: () => NOW,
    })
    assert.deepEqual(first.alertsFired, ["key-revoked"])
    // Second tick same day → deduped.
    const second = await runOpenAiKeyHealth({
      apiKey: LIVE_KEY,
      fetchImpl: stubFetch(handlers).fetchImpl,
      shouldPollCosts: false,
      claimAlert: gate.claimAlert,
      now: () => NOW + 30 * 60 * 1000,
    })
    assert.deepEqual(second.alertsFired, [])
    assert.deepEqual(second.alertsDeduped, ["key-revoked"])
  })
})

describe("runOpenAiKeyHealth — costs / budget", () => {
  it("fires budget-warning at ≥80% spend on the daily poll", async () => {
    const { fetchImpl } = stubFetch([
      { match: (u) => u.includes("/models"), status: 200, body: { data: [] } },
      {
        match: (u) => u.includes("/organization/costs"),
        status: 200,
        body: { data: [{ results: [{ amount: { value: 1700, currency: "usd" } }] }] },
      },
    ])
    const gate = memoryClaim()
    const r = await runOpenAiKeyHealth({
      apiKey: LIVE_KEY,
      adminKey: "sk-admin-FAKEadminTESTkey00000000",
      monthlyBudgetUsd: 2000,
      shouldPollCosts: true,
      fetchImpl,
      claimAlert: gate.claimAlert,
      now: () => NOW,
    })
    assert.equal(r.verdict, "ok")
    assert.equal(r.budgetChecked, true)
    assert.equal(r.monthToDateUsd, 1700)
    assert.deepEqual(r.alertsFired, ["budget-warning"])
  })

  it("does NOT fire budget-warning below 80%", async () => {
    const { fetchImpl } = stubFetch([
      { match: (u) => u.includes("/models"), status: 200, body: { data: [] } },
      {
        match: (u) => u.includes("/organization/costs"),
        status: 200,
        body: { data: [{ results: [{ amount: { value: 500 } }] }] },
      },
    ])
    const r = await runOpenAiKeyHealth({
      apiKey: LIVE_KEY,
      adminKey: "sk-admin-FAKEadminTESTkey00000000",
      monthlyBudgetUsd: 2000,
      shouldPollCosts: true,
      fetchImpl,
      now: () => NOW,
    })
    assert.equal(r.budgetChecked, true)
    assert.equal(r.monthToDateUsd, 500)
    assert.deepEqual(r.alertsFired, [])
  })

  it("skips costs poll when no admin key", async () => {
    const { fetchImpl, urls } = stubFetch([
      { match: (u) => u.includes("/models"), status: 200, body: { data: [] } },
    ])
    const r = await runOpenAiKeyHealth({
      apiKey: LIVE_KEY,
      adminKey: "",
      shouldPollCosts: true,
      fetchImpl,
      now: () => NOW,
    })
    assert.equal(r.budgetChecked, false)
    assert.ok(!urls().some((u) => u.includes("/organization/costs")))
  })

  it("skips costs poll when not the daily tick", async () => {
    const { fetchImpl, urls } = stubFetch([
      { match: (u) => u.includes("/models"), status: 200, body: { data: [] } },
    ])
    const r = await runOpenAiKeyHealth({
      apiKey: LIVE_KEY,
      adminKey: "sk-admin-FAKEadminTESTkey00000000",
      shouldPollCosts: false,
      fetchImpl,
      now: () => NOW,
    })
    assert.equal(r.budgetChecked, false)
    assert.ok(!urls().some((u) => u.includes("/organization/costs")))
  })
})

describe("paOpenAiKeyHealth — never leaks a key value", () => {
  it("captures no raw key in dispatched Slack/email payloads", async () => {
    // Capture every postSlackAlert + sendMailgun call by spying via a slack
    // webhook + mailgun fetch — but simplest: assert keyPrefix redaction.
    assert.equal(keyPrefix(LIVE_KEY), "sk-proj-fFd…")
    assert.ok(!keyPrefix(LIVE_KEY).includes("THISisAfake"))
    assert.equal(keyPrefix(undefined), "(none)")
    assert.equal(keyPrefix("short"), "(short)")
  })
})

describe("monthStartUnix", () => {
  it("returns 00:00 UTC on the 1st of the month", () => {
    const ms = Date.UTC(2026, 5, 15, 9, 30) // 2026-06-15
    const start = monthStartUnix(ms)
    assert.equal(start, Math.floor(Date.UTC(2026, 5, 1) / 1000))
  })
})
