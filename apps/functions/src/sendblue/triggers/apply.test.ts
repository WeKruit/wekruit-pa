/**
 * v1.9 Phase 85 — ApplyTrigger tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ApplyTrigger } from "./apply.js"

function makeCtx(overrides: Partial<{ text: string; fromNumber: string; hasMedia: boolean }> = {}) {
  return {
    text: overrides.text ?? "WeKruit_jobA_user42_Apply",
    fromNumber: overrides.fromNumber ?? "+15555550000",
    messageHandle: "h1",
    receivedAtIso: "2026-05-12T10:00:00Z",
    log: () => undefined,
    hasMedia: overrides.hasMedia ?? false,
  }
}

function makeDeps(over: Partial<ConstructorParameters<typeof ApplyTrigger>[0]> = {}) {
  const audit: Array<Record<string, unknown>> = []
  const idem = new Map<string, number>()
  return {
    audit,
    idem,
    deps: {
      lookupUserByPhone: over.lookupUserByPhone ?? (async () => "user42"),
      findRecentPass: over.findRecentPass ?? (async () => null),
      runPiiConfirm: over.runPiiConfirm ?? (async () => undefined),
      runPreScreen: over.runPreScreen ?? (async () => undefined),
      getLastFiredMs: over.getLastFiredMs ?? (async (j, u) => idem.get(`${j}|${u}`) ?? null),
      setLastFiredMs:
        over.setLastFiredMs ??
        (async (j, u, ms) => {
          idem.set(`${j}|${u}`, ms)
        }),
      audit: async (e: Record<string, unknown>) => {
        audit.push(e)
      },
      now: over.now ?? (() => 1_700_000_000_000),
    },
  }
}

describe("ApplyTrigger.match", () => {
  it("matches WeKruit_<jobId>_<userId>_Apply", () => {
    const t = new ApplyTrigger(makeDeps().deps)
    assert.equal(t.match("WeKruit_abc_def_Apply"), true)
    assert.equal(t.match("hey check WeKruit_abc_def_Apply please"), true)
  })
  it("rejects _Job variant", () => {
    const t = new ApplyTrigger(makeDeps().deps)
    assert.equal(t.match("WeKruit_abc_def_Job"), false)
  })
  it("rejects garbage", () => {
    const t = new ApplyTrigger(makeDeps().deps)
    assert.equal(t.match(""), false)
    assert.equal(t.match("hello"), false)
  })
})

describe("ApplyTrigger.handle — verified PASS branch", () => {
  it("fires PII confirm when recent PASS found", async () => {
    let piiCalled = false
    const { deps } = makeDeps({
      findRecentPass: async () => ({ sessionId: "ps_jobA_user42_20260510", terminalAtMs: 1_699_000_000_000 }),
      runPiiConfirm: async () => {
        piiCalled = true
      },
    })
    const t = new ApplyTrigger(deps)
    const r = await t.handle(makeCtx())
    assert.deepEqual(r, { kind: "handled", action: "pii_confirm" })
    // Wait microtask for fire-and-forget chain
    await new Promise((r) => setImmediate(r))
    assert.equal(piiCalled, true)
  })
})

describe("ApplyTrigger.handle — fallback branch", () => {
  it("falls back to prescreen when no PASS within 30d", async () => {
    let preCalled = false
    const { deps } = makeDeps({
      findRecentPass: async () => null,
      runPreScreen: async () => {
        preCalled = true
      },
    })
    const t = new ApplyTrigger(deps)
    const r = await t.handle(makeCtx())
    assert.deepEqual(r, { kind: "handled", action: "prescreen_fallback" })
    await new Promise((r) => setImmediate(r))
    assert.equal(preCalled, true)
  })
})

describe("ApplyTrigger.handle — auth", () => {
  it("rejects when sender userId mismatch", async () => {
    const { deps, audit } = makeDeps({
      lookupUserByPhone: async () => "user99",
    })
    const t = new ApplyTrigger(deps)
    const r = await t.handle(makeCtx())
    assert.equal(r.kind, "unauthorized")
    assert.ok(audit.some((a) => a.kind === "trigger.apply.unauthorized"))
  })
  it("rejects when sender unknown", async () => {
    const { deps } = makeDeps({ lookupUserByPhone: async () => null })
    const t = new ApplyTrigger(deps)
    const r = await t.handle(makeCtx())
    assert.equal(r.kind, "unauthorized")
  })
})

describe("ApplyTrigger.handle — idempotency", () => {
  it("dedupes within 60-min window", async () => {
    const { deps } = makeDeps()
    deps.getLastFiredMs = async () => 1_700_000_000_000 - 30 * 60 * 1000
    const t = new ApplyTrigger(deps)
    const r = await t.handle(makeCtx())
    assert.deepEqual(r, { kind: "handled", action: "deduped" })
  })
})

describe("ApplyTrigger.handle — media", () => {
  it("rejects media-attached", async () => {
    const t = new ApplyTrigger(makeDeps().deps)
    const r = await t.handle(makeCtx({ hasMedia: true }))
    assert.equal(r.kind, "unauthorized")
  })
})
