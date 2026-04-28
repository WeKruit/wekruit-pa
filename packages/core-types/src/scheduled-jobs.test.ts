/**
 * Phase 22 — pa_scheduled_jobs proactive schema + idempotency helper tests.
 * RED phase: these tests define the contract before implementation.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

// These imports will fail until the module is created (RED phase)
import {
  type ProactiveTriggerType,
  type ProactiveRecurrence,
  type ProactiveJobContext,
  type ScheduledJob,
  fireWindowHash,
  PROACTIVE_JOB_STATUS,
} from "./scheduled-jobs.js"

describe("ProactiveTriggerType", () => {
  it("accepts exactly the 3 v1 trigger types", () => {
    const types: ProactiveTriggerType[] = ["time_anchor", "silence_anchor", "application_followup"]
    assert.equal(types.length, 3)
    assert.ok(types.includes("time_anchor"))
    assert.ok(types.includes("silence_anchor"))
    assert.ok(types.includes("application_followup"))
  })
})

describe("ProactiveRecurrence", () => {
  it("accepts only 'once' and 'silence_rearm'", () => {
    const vals: ProactiveRecurrence[] = ["once", "silence_rearm"]
    assert.equal(vals.length, 2)
  })
})

describe("ProactiveJobContext discriminated union", () => {
  it("time_anchor variant requires eventLabel, eventAt, leadTimeSec", () => {
    const ctx: ProactiveJobContext = {
      triggerType: "time_anchor",
      eventLabel: "面试 Acme",
      eventAt: Date.now(),
      leadTimeSec: 86400,
    }
    assert.equal(ctx.triggerType, "time_anchor")
    assert.equal(ctx.eventLabel, "面试 Acme")
    assert.equal(ctx.leadTimeSec, 86400)
  })

  it("silence_anchor variant requires windowSec, lastUserMsgAt", () => {
    const ctx: ProactiveJobContext = {
      triggerType: "silence_anchor",
      windowSec: 259200,
      lastUserMsgAt: Date.now() - 300000,
    }
    assert.equal(ctx.triggerType, "silence_anchor")
    assert.equal(ctx.windowSec, 259200)
  })

  it("application_followup variant requires companyName, jobTitle, appliedAt, followupAfterSec", () => {
    const ctx: ProactiveJobContext = {
      triggerType: "application_followup",
      companyName: "Globex",
      jobTitle: "SWE",
      appliedAt: Date.now() - 86400000,
      followupAfterSec: 259200,
    }
    assert.equal(ctx.triggerType, "application_followup")
    assert.equal(ctx.companyName, "Globex")
  })
})

describe("fireWindowHash", () => {
  it("returns deterministic sha1 hex for same inputs", () => {
    const jobId = "job-abc-123"
    const nowMs = 1720000000000
    const h1 = fireWindowHash(jobId, nowMs)
    const h2 = fireWindowHash(jobId, nowMs)
    assert.equal(h1, h2)
    assert.match(h1, /^[0-9a-f]{40}$/)
  })

  it("different fire window (different minute) produces different hash", () => {
    const jobId = "job-abc-123"
    const base = 1720000000000
    const h1 = fireWindowHash(jobId, base)
    const h2 = fireWindowHash(jobId, base + 60001) // next minute
    assert.notEqual(h1, h2)
  })

  it("same minute bucket (within same 60s) produces same hash", () => {
    const jobId = "job-abc-123"
    const base = 1720000000000
    // floor(base/60000) === floor((base+59999)/60000) if base is minute-aligned
    const alignedMs = Math.floor(base / 60000) * 60000
    const h1 = fireWindowHash(jobId, alignedMs)
    const h2 = fireWindowHash(jobId, alignedMs + 59999)
    assert.equal(h1, h2)
  })

  it("different jobId with same timestamp produces different hash", () => {
    const nowMs = 1720000000000
    const h1 = fireWindowHash("job-a", nowMs)
    const h2 = fireWindowHash("job-b", nowMs)
    assert.notEqual(h1, h2)
  })
})

describe("ScheduledJob type extends Phase 7 base fields", () => {
  it("ScheduledJob includes dueAt and Phase 7 base fields", () => {
    // Type-level test: construct a ScheduledJob and verify dueAt is present
    const job: ScheduledJob = {
      jobId: "job-001",
      userId: "user-001",
      triggerType: "time_anchor",
      nextFireAt: "2026-05-01T10:00:00.000Z",
      dueAt: "2026-05-01T10:00:00.000Z",
      recurrence: "once",
      context: {
        triggerType: "time_anchor",
        eventLabel: "Test event",
        eventAt: Date.now() + 86400000,
        leadTimeSec: 3600,
      },
      status: "pending",
      createdAt: new Date().toISOString(),
      attempts: 0,
      maxAttempts: 3,
      backoffSec: 60,
    }
    assert.equal(job.dueAt, job.nextFireAt)
    assert.equal(job.attempts, 0)
    assert.equal(job.maxAttempts, 3)
    assert.equal(job.backoffSec, 60)
  })
})

describe("PROACTIVE_JOB_STATUS", () => {
  it("includes all expected status values", () => {
    assert.ok("pending" in PROACTIVE_JOB_STATUS)
    assert.ok("running" in PROACTIVE_JOB_STATUS)
    assert.ok("fired" in PROACTIVE_JOB_STATUS)
    assert.ok("cancelled_by_user" in PROACTIVE_JOB_STATUS)
    assert.ok("failed" in PROACTIVE_JOB_STATUS)
    assert.ok("dead_letter" in PROACTIVE_JOB_STATUS)
  })
})
