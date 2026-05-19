import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  LayoffTrigger,
  type LayoffTriggerDeps,
} from "./layoff.js"

function makeCtx(overrides: Partial<{ text: string; fromNumber: string; hasMedia: boolean }> = {}) {
  return {
    text: overrides.text ?? "WeKruit_LAID_OFF",
    fromNumber: overrides.fromNumber ?? "+13054507715",
    messageHandle: "h-layoff-1",
    receivedAtIso: "2026-05-15T10:00:00Z",
    log: () => undefined,
    hasMedia: overrides.hasMedia ?? false,
  }
}

function makeDeps(over: Partial<LayoffTriggerDeps> = {}) {
  const audit: Array<Record<string, unknown>> = []
  const starts: Array<{ userId: string; toE164: string }> = []
  const idem = new Map<string, number>()
  const deps: LayoffTriggerDeps = {
    lookupUserByPhone: over.lookupUserByPhone ?? (async () => "u_layoff"),
    runLayoffStart:
      over.runLayoffStart ??
      (async (args) => {
        starts.push(args)
      }),
    getLastFiredMs: over.getLastFiredMs ?? (async (userId) => idem.get(userId) ?? null),
    setLastFiredMs:
      over.setLastFiredMs ??
      (async (userId, ms) => {
        idem.set(userId, ms)
      }),
    audit: async (event) => {
      audit.push(event)
    },
    now: over.now ?? (() => 1_700_000_000_000),
  }
  return { deps, audit, starts, idem }
}

describe("LayoffTrigger.match", () => {
  it("matches every case-variant of the legacy layoff + candidate source tokens", () => {
    // 2026-05-19 — Adam mixed-case "WeKruit_Laid_Off" bypassed the original
    // case-sensitive guard, which let legacy onboarding restore a layoff
    // session and leak the email Q. Match must be case-insensitive across
    // both layoff and candidate-hi tokens so no variant escapes suppression.
    const t = new LayoffTrigger(makeDeps().deps)
    assert.equal(t.match("WeKruit_LAID_OFF"), true)
    assert.equal(t.match("WeKruit_Laid_Off"), true)
    assert.equal(t.match("wekruit_laid_off"), true)
    assert.equal(t.match("hi WeKruit_LAID_OFF there"), true)
    assert.equal(t.match("WeKruit_Laid_Off!"), true)
    assert.equal(t.match("WeKruit_CANDIDATE_HI"), true)
    assert.equal(t.match("wekruit_candidate_hi"), true)
  })

  it("does not match unrelated triggers or the generic Hello, WeKruit opener", () => {
    const t = new LayoffTrigger(makeDeps().deps)
    assert.equal(t.match("WeKruit_job_user_Job"), false)
    assert.equal(t.match("__PA_FIND_MATCH__"), false)
    assert.equal(t.match("Hello, WeKruit!"), false)
    assert.equal(t.match("hello wekruit"), false)
    assert.equal(t.match("plain text from a candidate"), false)
  })
})

describe("LayoffTrigger.handle", () => {
  it("refuses direct manual layoff trigger handling", async () => {
    const { deps, starts, audit } = makeDeps()
    const t = new LayoffTrigger(deps)
    const result = await t.handle(makeCtx())

    assert.deepEqual(result, { kind: "unauthorized", reason: "manual_layoff_trigger_disabled" })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(starts, [])
    assert.equal(audit.some((event) => event.reason === "manual_layoff_trigger_disabled"), true)
  })

  it("rejects media-attached layoff triggers", async () => {
    const t = new LayoffTrigger(makeDeps().deps)
    const result = await t.handle(makeCtx({ hasMedia: true }))

    assert.equal(result.kind, "unauthorized")
  })
})
