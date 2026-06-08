/**
 * Prescreen-NURTURE dispatch unit tests — personalization handoff, idempotency
 * (no double-nurture), runtime-block, metrics stamping + audit.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  dispatchNurture,
  nurtureFireSeed,
  isPrescreenNurtureJob,
  type NurtureDispatchStore,
} from "../prescreen-nurture-dispatch.js"
import type { PrescreenNurtureScheduledJob } from "../prescreen-nurture-scheduler.js"
import { fireWindowHash } from "@pa/core-types"

function makeJob(over?: Partial<PrescreenNurtureScheduledJob>): PrescreenNurtureScheduledJob {
  const nextFireAt = new Date("2026-06-02T00:00:00.000Z").toISOString()
  return {
    jobId: "nurture-u1-j1-1",
    nurturingType: "prescreen_review_nurture",
    userId: "u1",
    opportunityJobId: "j1",
    sessionId: "s1",
    nurturingNumber: 1,
    prescreenTerminal: "PASS",
    status: "pending",
    nextFireAt,
    dueAt: nextFireAt,
    createdAt: nextFireAt,
    attempts: 0,
    maxAttempts: 3,
    backoffSec: 300,
    ...over,
  }
}

type TestDispatchStore = NurtureDispatchStore & {
  audits: Record<string, unknown>[]
  stamped: { sessionId: string; n: number }[]
  handoffs: number
  firedHashes: Set<string>
}

function makeStore(over?: Partial<NurtureDispatchStore>): TestDispatchStore {
  const store = {
    audits: [] as Record<string, unknown>[],
    stamped: [] as { sessionId: string; n: number }[],
    handoffs: 0,
    firedHashes: new Set<string>(),
    composer: {
      fetchJob: async () => ({ title: "SWE", company: "Acme" }),
      fetchSessionScore: async () => ({}),
      fetchPreferredLanguage: async () => "en",
    },
    async checkFireWindowExists(fwHash: string) {
      return store.firedHashes.has(fwHash)
    },
    async enqueueRuntimeEvent() {
      store.handoffs++
      return { ok: true as const, runtimeEventId: `re-${store.handoffs}`, created: true }
    },
    async stampSessionNurtured(sessionId: string, n: number) {
      store.stamped.push({ sessionId, n })
    },
    async writeAuditEvent(row: Record<string, unknown>) {
      store.audits.push(row)
      // Mirror production: only a *sent* row marks the window as fired (a
      // suppressed window had no send and must stay retryable).
      if (row["fireWindowHash"] && row["kind"] === "prescreen_nurture_sent") {
        store.firedHashes.add(String(row["fireWindowHash"]))
      }
    },
    log: () => {},
  } as TestDispatchStore
  Object.assign(store, over)
  return store
}

describe("dispatchNurture — happy path", () => {
  it("hands off to Claire runtime, stamps metrics, writes a sent audit", async () => {
    const store = makeStore()
    const job = makeJob()
    const res = await dispatchNurture(job, store)
    assert.equal(res.dispatched, true)
    assert.equal(store.handoffs, 1)
    assert.deepEqual(store.stamped, [{ sessionId: "s1", n: 1 }])
    assert.equal(store.audits.length, 1)
    assert.equal(store.audits[0]!.kind, "prescreen_nurture_sent")
    assert.equal(store.audits[0]!.nurturingNumber, 1)
  })

  it("passes personalized context (eventKind v1, job facts) into the handoff", async () => {
    let captured: Record<string, unknown> | undefined
    const store = makeStore({
      async enqueueRuntimeEvent(_u, input) {
        captured = input.context
        return { ok: true, runtimeEventId: "re", created: true }
      },
    })
    await dispatchNurture(makeJob(), store)
    assert.ok(captured)
    assert.equal(captured!.eventKind, "prescreen_review_nurture_v1")
    assert.equal(captured!.jobTitle, "SWE")
    assert.equal(captured!.companyName, "Acme")
    assert.equal(captured!.prescreenTerminal, "PASS")
    assert.equal(captured!.source, "prescreen_review_nurture")
  })
})

describe("dispatchNurture — idempotency (no double-nurture)", () => {
  it("skips when an audit row for the same fire window already exists", async () => {
    const job = makeJob()
    const seed = nurtureFireSeed({
      candidateId: job.userId,
      jobId: job.opportunityJobId,
      nurturingNumber: job.nurturingNumber,
    })
    const fwHash = fireWindowHash(seed, new Date(job.nextFireAt).getTime())
    const store = makeStore()
    store.firedHashes.add(fwHash) // pre-seed: already fired this window
    const res = await dispatchNurture(job, store)
    assert.deepEqual(res, { dispatched: false, reason: "already_fired" })
    assert.equal(store.handoffs, 0, "no handoff on idempotent skip")
    assert.equal(store.stamped.length, 0, "no metric bump on idempotent skip")
  })

  it("dispatching twice in the same window fires exactly one handoff", async () => {
    const store = makeStore()
    const job = makeJob()
    const a = await dispatchNurture(job, store)
    const b = await dispatchNurture(job, store)
    assert.equal(a.dispatched, true)
    assert.equal(b.dispatched, false)
    assert.equal(store.handoffs, 1)
    assert.equal(store.stamped.length, 1)
  })
})

describe("dispatchNurture — runtime block (fail-open)", () => {
  it("does not stamp metrics and writes a suppressed audit when handoff is blocked", async () => {
    const store = makeStore({
      async enqueueRuntimeEvent() {
        return { ok: false, reason: "no_existing_session" }
      },
    })
    const res = await dispatchNurture(makeJob(), store)
    assert.equal(res.dispatched, false)
    assert.equal((res as { reason: string }).reason, "runtime_blocked")
    assert.equal(store.stamped.length, 0)
    assert.equal(store.audits[0]!.kind, "prescreen_nurture_suppressed")
    // A suppressed window is NOT marked fired → it can be retried later.
    assert.equal(store.firedHashes.size, 0)
  })
})

describe("isPrescreenNurtureJob", () => {
  it("detects nurture rows by nurturingType", () => {
    assert.equal(isPrescreenNurtureJob(makeJob() as unknown as Record<string, unknown>), true)
    assert.equal(isPrescreenNurtureJob({ triggerType: "time_anchor" }), false)
    assert.equal(isPrescreenNurtureJob(null), false)
    assert.equal(isPrescreenNurtureJob(undefined), false)
  })
})
