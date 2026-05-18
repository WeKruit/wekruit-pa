/**
 * Phase 22 — runProactiveTurn unit tests.
 * RED phase: defines contract before implementation.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { runProactiveTurn, type ProactiveTurnStore } from "./proactive-turn.js"
import type { ProactiveScheduledJob } from "@pa/core-types"

function makeJob(overrides?: Partial<ProactiveScheduledJob>): ProactiveScheduledJob {
  return {
    jobId: "job-test-001",
    userId: "user-test-001",
    triggerType: "time_anchor",
    nextFireAt: new Date(Date.now() - 5000).toISOString(),
    dueAt: new Date(Date.now() - 5000).toISOString(),
    recurrence: "once",
    context: {
      triggerType: "time_anchor",
      eventLabel: "面试 Acme",
      eventAt: Date.now() + 86400000,
      leadTimeSec: 86400,
    },
    status: "pending",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    attempts: 0,
    maxAttempts: 3,
    backoffSec: 60,
    ...overrides,
  }
}

function makeStore(overrides?: Partial<ProactiveTurnStore>): ProactiveTurnStore {
  return {
    enqueueRuntimeEvent: async () => ({
      ok: true,
      runtimeEventId: `runtime-${Date.now()}`,
      created: true,
    }),
    writeAuditEvent: async (_row: Record<string, unknown>) => {},
    updateJobStatus: async (_jobId: string, _patch: Record<string, unknown>) => {},
    rearmJob: async (_jobId: string, _nextFireAt: string) => {},
    log: () => {},
    ...overrides,
  }
}

describe("runProactiveTurn — happy path", () => {
  it("Test 2: enqueues a structured runtime event, not candidate-visible copy", async () => {
    let capturedInput: { eventKind: string; idempotencyKey: string; context: Record<string, unknown> } | undefined
    const store = makeStore({
      enqueueRuntimeEvent: async (_userId, input) => {
        capturedInput = input
        return { ok: true, runtimeEventId: "runtime-123", created: true }
      },
    })
    await runProactiveTurn("user-001", makeJob(), store)
    assert.ok(capturedInput, "runtime handoff should have been enqueued")
    assert.equal(capturedInput!.eventKind, "proactive_time_anchor")
    assert.ok(capturedInput!.idempotencyKey.startsWith("proactive:job-test-001:"))
    assert.equal(capturedInput!.context["source"], "proactive_scheduled")
    assert.equal(capturedInput!.context["scheduledJobId"], "job-test-001")
    assert.equal(capturedInput!.context["triggerType"], "time_anchor")
    assert.ok(!("candidateVisibleMessage" in capturedInput!.context), "producer must not pass candidate-visible copy")
  })

  it("Test 3: writes runtime handoff audit", async () => {
    let auditRow: Record<string, unknown> | undefined
    const store = makeStore({
      writeAuditEvent: async (row) => {
        auditRow = row
      },
    })
    await runProactiveTurn("user-001", makeJob(), store)
    assert.ok(auditRow, "writeAuditEvent must be called")
    assert.equal(auditRow!["kind"], "proactive_runtime_handoff")
    assert.equal(typeof auditRow!["runtimeEventId"], "string")
  })

  it("Test 4: updates job status after runtime handoff", async () => {
    let patch: Record<string, unknown> | undefined
    const store = makeStore({
      updateJobStatus: async (_jobId, p) => {
        patch = p
      },
    })
    await runProactiveTurn("user-001", makeJob(), store)
    assert.ok(patch, "updateJobStatus should have been called")
    assert.equal(patch!["status"], "fired")
  })

  it("Test 5: blocks instead of sending when runtime handoff is not allowed", async () => {
    let auditRow: Record<string, unknown> | undefined
    let statusPatch: Record<string, unknown> | undefined
    const store = makeStore({
      enqueueRuntimeEvent: async () => ({ ok: false, reason: "no_existing_session" }),
      writeAuditEvent: async (row) => {
        auditRow = row
      },
      updateJobStatus: async (_jobId, patch) => {
        statusPatch = patch
      },
    })
    const result = await runProactiveTurn("user-001", makeJob(), store)
    assert.equal(result.skipped, true)
    if (!result.skipped) throw new Error("expected runtime handoff to be skipped")
    assert.equal(result.reason, "runtime_handoff_blocked")
    assert.equal(result.runtimeReason, "no_existing_session")
    assert.equal(typeof result.fireWindowHash, "string")
    assert.ok(auditRow, "writeAuditEvent must be called")
    assert.equal(auditRow!["kind"], "proactive_runtime_suppressed")
    assert.equal(auditRow!["userId"], "user-001")
    assert.equal(auditRow!["jobId"], "job-test-001")
    assert.equal(statusPatch!["status"], "failed")
  })
})

describe("runProactiveTurn — kill switch", () => {
  it("Test 6: returns skipped when PA_PROACTIVE_DISABLED=1", async () => {
    const original = process.env.PA_PROACTIVE_DISABLED
    process.env.PA_PROACTIVE_DISABLED = "1"
    let enqueueCalled = false
    let auditCalled = false
    const store = makeStore({
      enqueueRuntimeEvent: async () => {
        enqueueCalled = true
        return { ok: true, runtimeEventId: "runtime-x", created: true }
      },
      writeAuditEvent: async () => { auditCalled = true },
    })
    try {
      const result = await runProactiveTurn("user-001", makeJob(), store)
      assert.deepEqual(result, { skipped: true, reason: "disabled" })
      assert.ok(!enqueueCalled, "enqueue must NOT be called when disabled")
      assert.ok(!auditCalled, "audit must NOT be called when disabled")
    } finally {
      if (original === undefined) delete process.env.PA_PROACTIVE_DISABLED
      else process.env.PA_PROACTIVE_DISABLED = original
    }
  })
})

describe("runProactiveTurn — silence_rearm recurrence", () => {
  it("re-arms job when recurrence=silence_rearm after firing", async () => {
    let rearmCalled = false
    let rearmNextFireAt: string | undefined
    const store = makeStore({
      rearmJob: async (_jobId, nextFireAt) => {
        rearmCalled = true
        rearmNextFireAt = nextFireAt
      },
    })
    const job = makeJob({
      triggerType: "silence_anchor",
      recurrence: "silence_rearm",
      context: {
        triggerType: "silence_anchor",
        windowSec: 259200,
        lastUserMsgAt: Date.now() - 300000,
      },
    })
    await runProactiveTurn("user-001", job, store)
    assert.ok(rearmCalled, "rearmJob must be called for silence_rearm recurrence")
    // nextFireAt must be in the future (now + windowSec * 1000)
    const rearmedMs = new Date(rearmNextFireAt!).getTime()
    assert.ok(rearmedMs > Date.now(), "re-armed nextFireAt must be in the future")
  })
})
