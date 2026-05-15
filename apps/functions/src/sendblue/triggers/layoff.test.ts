import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  LayoffTrigger,
  LAYOFF_TRIGGER_IDEMPOTENCY_WINDOW_MS,
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
  it("matches the WeKruit_LAID_OFF source trigger", () => {
    const t = new LayoffTrigger(makeDeps().deps)
    assert.equal(t.match("WeKruit_LAID_OFF"), true)
    assert.equal(t.match("hi WeKruit_LAID_OFF"), true)
    assert.equal(t.match("WeKruit_job_user_Job"), false)
  })
})

describe("LayoffTrigger.handle", () => {
  it("starts the shared layoff kickoff for the phone-resolved pa-user", async () => {
    const { deps, starts, audit } = makeDeps()
    const t = new LayoffTrigger(deps)
    const result = await t.handle(makeCtx())

    assert.deepEqual(result, { kind: "handled", action: "layoff_triggered" })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(starts, [{ userId: "u_layoff", toE164: "+13054507715" }])
    assert.equal(audit.some((event) => event.type === "trigger_fired" && event.trigger === "layoff"), true)
  })

  it("rejects unresolved phone numbers instead of creating a parallel user", async () => {
    const { deps, audit } = makeDeps({ lookupUserByPhone: async () => null })
    const t = new LayoffTrigger(deps)
    const result = await t.handle(makeCtx())

    assert.equal(result.kind, "unauthorized")
    assert.equal(audit.some((event) => event.reason === "phone_not_resolved"), true)
  })

  it("dedupes repeated source triggers inside the 60-minute window", async () => {
    const now = 1_700_000_000_000
    const { deps } = makeDeps({
      getLastFiredMs: async () => now - LAYOFF_TRIGGER_IDEMPOTENCY_WINDOW_MS + 1,
      now: () => now,
    })
    const t = new LayoffTrigger(deps)
    const result = await t.handle(makeCtx())

    assert.deepEqual(result, { kind: "handled", action: "layoff_deduped" })
  })

  it("rejects media-attached layoff triggers", async () => {
    const t = new LayoffTrigger(makeDeps().deps)
    const result = await t.handle(makeCtx({ hasMedia: true }))

    assert.equal(result.kind, "unauthorized")
  })
})
