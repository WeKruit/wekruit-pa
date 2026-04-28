/**
 * Phase 22 — runProactiveTurn unit tests.
 * RED phase: defines contract before implementation.
 */
import { describe, it, mock } from "node:test"
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
    runTurn: async (_userId: string, _input: { role: string; content: string; meta?: Record<string, unknown> }) => ({
      text: "好的，明天面试 Acme 记得准备充分哦。",
      usage: undefined,
    }),
    normalizeOutput: (text: string) => ({ text, chunks: [text] }),
    enqueueOutbound: async (_userId: string, _body: string, _opts?: Record<string, unknown>) => ({
      outboundId: `outbound-${Date.now()}`,
    }),
    writeAuditEvent: async (_row: Record<string, unknown>) => {},
    updateJobStatus: async (_jobId: string, _patch: Record<string, unknown>) => {},
    rearmJob: async (_jobId: string, _nextFireAt: string) => {},
    getUserPhoneE164: async (_userId: string) => "+16505551234",
    log: () => {},
    ...overrides,
  }
}

describe("runProactiveTurn — happy path", () => {
  it("Test 2: synthetic input uses user role with system-trigger marker", async () => {
    let capturedInput: { role: string; content: string; meta?: Record<string, unknown> } | undefined
    const store = makeStore({
      runTurn: async (_userId, input) => {
        capturedInput = input
        return { text: "明天加油！", usage: undefined }
      },
    })
    await runProactiveTurn("user-001", makeJob(), store)
    assert.ok(capturedInput, "runTurn should have been called")
    assert.equal(capturedInput!.role, "user", "role must stay 'user' to preserve Voice v1 few-shot anchoring")
    assert.ok(capturedInput!.content.includes("[system-trigger:time_anchor]"), "content must include system-trigger marker")
    assert.equal(capturedInput!.meta?.source, "proactive")
    assert.equal(capturedInput!.meta?.triggerType, "time_anchor")
    assert.equal(capturedInput!.meta?.jobId, "job-test-001")
  })

  it("Test 3: output passes through normalizer before enqueue", async () => {
    let normalizeCalled = false
    const store = makeStore({
      normalizeOutput: (text) => {
        normalizeCalled = true
        return { text, chunks: [text] }
      },
    })
    await runProactiveTurn("user-001", makeJob(), store)
    assert.ok(normalizeCalled, "normalizer must be called on proactive output")
  })

  it("Test 4: enqueues to pa_outbound with source=proactive and proactiveJobId", async () => {
    let enqueuedOpts: Record<string, unknown> | undefined
    const store = makeStore({
      enqueueOutbound: async (_userId, _body, opts) => {
        enqueuedOpts = opts
        return { outboundId: "out-123" }
      },
    })
    await runProactiveTurn("user-001", makeJob(), store)
    assert.ok(enqueuedOpts, "enqueueOutbound should have been called")
    assert.equal(enqueuedOpts!["source"], "proactive")
    assert.equal(enqueuedOpts!["proactiveJobId"], "job-test-001")
  })

  it("Test 5: writes pa_audit_events row with kind=proactive_send", async () => {
    let auditRow: Record<string, unknown> | undefined
    const store = makeStore({
      writeAuditEvent: async (row) => {
        auditRow = row
      },
    })
    await runProactiveTurn("user-001", makeJob(), store)
    assert.ok(auditRow, "writeAuditEvent must be called")
    assert.equal(auditRow!["kind"], "proactive_send")
    assert.equal(auditRow!["userId"], "user-001")
    assert.equal(auditRow!["jobId"], "job-test-001")
    assert.equal(auditRow!["triggerType"], "time_anchor")
    assert.ok(typeof auditRow!["fireWindowHash"] === "string", "fireWindowHash must be a string")
    assert.ok(typeof auditRow!["outboundId"] === "string", "outboundId must be a string")
  })
})

describe("runProactiveTurn — kill switch", () => {
  it("Test 6: returns skipped when PA_PROACTIVE_DISABLED=1", async () => {
    const original = process.env.PA_PROACTIVE_DISABLED
    process.env.PA_PROACTIVE_DISABLED = "1"
    let enqueueCalled = false
    let auditCalled = false
    const store = makeStore({
      enqueueOutbound: async () => { enqueueCalled = true; return { outboundId: "x" } },
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
