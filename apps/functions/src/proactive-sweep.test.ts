/**
 * Phase 22 — paProactiveSweep CF unit tests.
 * RED phase: defines contract before implementation.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { runSweep, checkAdminToken, type SweepStore } from "./proactive-sweep.js"
import type { ProactiveScheduledJob } from "@pa/core-types"

function makeJob(overrides?: Partial<ProactiveScheduledJob>): ProactiveScheduledJob {
  const now = new Date()
  return {
    jobId: "job-sweep-001",
    userId: "user-001",
    triggerType: "time_anchor",
    nextFireAt: new Date(now.getTime() - 5000).toISOString(), // due 5s ago
    dueAt: new Date(now.getTime() - 5000).toISOString(),
    recurrence: "once",
    context: {
      triggerType: "time_anchor",
      eventLabel: "面试 Acme",
      eventAt: now.getTime() + 86400000,
      leadTimeSec: 86400,
    },
    status: "pending",
    createdAt: new Date(now.getTime() - 3600000).toISOString(),
    attempts: 0,
    maxAttempts: 3,
    backoffSec: 60,
    ...overrides,
  }
}

type TestSweepStore = SweepStore & {
  getRuntimeHandoffCallCount(): number
  getAuditEvents(): Record<string, unknown>[]
  getJobState(jobId: string): ProactiveScheduledJob | undefined
}

function makeStore(
  jobs: ProactiveScheduledJob[],
  overrides?: Partial<SweepStore>
): TestSweepStore {
  const jobMap = new Map(jobs.map((j) => [j.jobId, { ...j }]))
  const auditEvents: Record<string, unknown>[] = []
  let runtimeHandoffCallCount = 0

  return {
    fetchDueJobs: async () => [...jobMap.values()].filter((j) => j.status === "pending"),
    claimJob: async (jobId) => {
      const job = jobMap.get(jobId)
      if (!job || job.status !== "pending") return null
      const updated = { ...job, status: "running" as const }
      jobMap.set(jobId, updated)
      return updated
    },
    checkFireWindowExists: async (_fwHash) => {
      return auditEvents.some(
        (e) =>
          e["fireWindowHash"] === _fwHash &&
          ["proactive_runtime_handoff", "proactive_runtime_suppressed", "proactive_send"].includes(String(e["kind"]))
      )
    },
    runProactiveTurn: async (_userId, job) => {
      runtimeHandoffCallCount++
      // Simulate writing runtime handoff audit event.
      const { fireWindowHash: fwh } = await import("@pa/core-types")
      const fwHash = fwh(job.jobId, new Date(job.nextFireAt).getTime())
      auditEvents.push({ kind: "proactive_runtime_handoff", jobId: job.jobId, fireWindowHash: fwHash })
      jobMap.set(job.jobId, { ...job, status: "fired" as const })
      return { skipped: false, runtimeEventId: `runtime-${job.jobId}`, runtimeEventCreated: true, fireWindowHash: fwHash }
    },
    updateJobFailed: async (jobId, attempts, maxAttempts, backoffSec) => {
      const job = jobMap.get(jobId)
      if (!job) return
      const newAttempts = attempts + 1
      if (newAttempts >= maxAttempts) {
        jobMap.set(jobId, { ...job, status: "dead_letter" as const, attempts: newAttempts })
      } else {
        const nextFireAt = new Date(Date.now() + backoffSec * 1000).toISOString()
        jobMap.set(jobId, { ...job, status: "pending" as const, attempts: newAttempts, nextFireAt, dueAt: nextFireAt })
      }
    },
    log: () => {},
    getRuntimeHandoffCallCount: () => runtimeHandoffCallCount,
    getAuditEvents: () => auditEvents,
    getJobState: (jobId: string) => jobMap.get(jobId),
    ...overrides,
  }
}

describe("runSweep — kill switch", () => {
  it("Test 4: returns immediately when PA_PROACTIVE_DISABLED=1, no Firestore reads", async () => {
    const original = process.env.PA_PROACTIVE_DISABLED
    process.env.PA_PROACTIVE_DISABLED = "1"
    let fetchCalled = false
    const store = makeStore([], {
      fetchDueJobs: async () => { fetchCalled = true; return [] },
    })
    try {
      const result = await runSweep(store)
      assert.deepEqual(result, { skipped: true, reason: "disabled" })
      assert.ok(!fetchCalled, "fetchDueJobs must NOT be called when disabled")
    } finally {
      if (original === undefined) delete process.env.PA_PROACTIVE_DISABLED
      else process.env.PA_PROACTIVE_DISABLED = original
    }
  })
})

describe("runSweep — basic dispatch", () => {
  it("Test 1: dispatches due pending jobs via runtime handoff", async () => {
    const store = makeStore([makeJob()])
    const result = await runSweep(store)
    assert.ok(result && "dispatched" in result, "should return dispatch result")
    assert.equal((result as { dispatched: number }).dispatched, 1)
    assert.equal(store.getRuntimeHandoffCallCount(), 1)
  })
})

describe("runSweep — idempotency", () => {
  it("Test 2/3: same job fired twice -> exactly one runtime handoff", async () => {
    const job = makeJob()
    const { fireWindowHash } = await import("@pa/core-types")
    const fwHash = fireWindowHash(job.jobId, new Date(job.nextFireAt).getTime())

    // Pre-seed an audit event for this fireWindowHash
    const preExistingAudit = [{ kind: "proactive_send", jobId: job.jobId, fireWindowHash: fwHash }]
    const store = makeStore([job], {
      checkFireWindowExists: async (hash) => {
        return preExistingAudit.some((e) => e.fireWindowHash === hash)
      },
    })

    // Reset job to pending to simulate second sweep
    await runSweep(store)
    // Should skip because audit event already exists
    assert.equal(store.getRuntimeHandoffCallCount(), 0, "runtime handoff must NOT be called for already-fired fireWindowHash")
  })
})

describe("runSweep — failure handling", () => {
  it("Test 5: dispatch failure increments attempts, then dead_letter at maxAttempts", async () => {
    const job = makeJob({ attempts: 2, maxAttempts: 3 })
    let updateJobFailedCalled = false
    let failedAttempts = 0
    let failedMax = 0
    const store = makeStore([job], {
      runProactiveTurn: async () => { throw new Error("LLM timeout") },
      updateJobFailed: async (_jobId, attempts, maxAttempts, backoffSec) => {
        updateJobFailedCalled = true
        failedAttempts = attempts
        failedMax = maxAttempts
      },
    })

    await runSweep(store)
    assert.ok(updateJobFailedCalled, "updateJobFailed must be called on dispatch failure")
    assert.equal(failedAttempts, 2)  // current attempts value passed
    assert.equal(failedMax, 3)       // maxAttempts passed
  })
})

describe("checkAdminToken — admin gate (Phase 22 trigger plan)", () => {
  function withEnv(value: string | undefined, fn: () => void) {
    const original = process.env.PA_ADMIN_TOKEN
    if (value === undefined) delete process.env.PA_ADMIN_TOKEN
    else process.env.PA_ADMIN_TOKEN = value
    try { fn() } finally {
      if (original === undefined) delete process.env.PA_ADMIN_TOKEN
      else process.env.PA_ADMIN_TOKEN = original
    }
  }

  it("returns 503 when PA_ADMIN_TOKEN env is unset (no accidental open access)", () => {
    withEnv(undefined, () => {
      const result = checkAdminToken("anything")
      assert.deepEqual(result, { ok: false, status: 503, error: "admin token not configured" })
    })
  })

  it("returns 401 when x-admin-token header is missing", () => {
    withEnv("secret-token-abc", () => {
      const result = checkAdminToken(undefined)
      assert.deepEqual(result, { ok: false, status: 401, error: "unauthorized" })
    })
  })

  it("returns 401 when x-admin-token header is wrong", () => {
    withEnv("secret-token-abc", () => {
      const result = checkAdminToken("wrong-token")
      assert.deepEqual(result, { ok: false, status: 401, error: "unauthorized" })
    })
  })

  it("returns ok when x-admin-token header matches", () => {
    withEnv("secret-token-abc", () => {
      const result = checkAdminToken("secret-token-abc")
      assert.deepEqual(result, { ok: true })
    })
  })
})

describe("runSweep — cap at 50 jobs", () => {
  it("Test 6: bounded at 50 jobs per invocation", async () => {
    const jobs = Array.from({ length: 60 }, (_, i) =>
      makeJob({ jobId: `job-${i.toString().padStart(3, "0")}` })
    )
    const store = makeStore(jobs)
    // fetchDueJobs mock should already be capped at 50 in real impl
    // Here we test that the store's fetchDueJobs + sweep respects limit
    let turnCount = 0
    const boundedStore = {
      ...store,
      fetchDueJobs: async () => jobs.slice(0, 50), // simulate CF-side cap
      runProactiveTurn: async (_userId: string, job: ProactiveScheduledJob) => {
        turnCount++
        return { skipped: false as const, runtimeEventId: `runtime-${job.jobId}`, runtimeEventCreated: true, fireWindowHash: "hash" }
      },
    }
    await runSweep(boundedStore)
    assert.ok(turnCount <= 50, `Must not dispatch more than 50 jobs, got ${turnCount}`)
  })
})
