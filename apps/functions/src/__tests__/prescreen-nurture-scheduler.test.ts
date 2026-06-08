/**
 * Prescreen-NURTURE scheduler unit tests — cadence timing, max, flag-off → 0.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  scheduleNurtures,
  computeNextNurture,
  nurtureScheduledJobId,
  DEFAULT_NURTURE_CADENCE,
  PRESCREEN_NURTURE_FLAG,
  PRESCREEN_NURTURE_TYPE,
  type NurtureSchedulerStore,
  type PrescreenNurtureScheduledJob,
} from "../prescreen-nurture-scheduler.js"
import type { NurtureEligible } from "../prescreen-nurture-enumerator.js"
import { _clearFeatureFlagCache } from "@pa/pa-persistence"

const NOW = new Date("2026-06-02T00:00:00.000Z")
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const ENTERED_25H = new Date(NOW.getTime() - 25 * HOUR).toISOString()

type StateRow = { candidateId: string; jobId: string; prescreenSessionId?: string; stateUpdatedAt: string }
type SessionRow = { terminal: string | null; totalNurtureSent: number; lastNurtureAt: string | null }

function makeSchedulerStore(args: {
  states: StateRow[]
  sessions: Record<string, SessionRow>
  lifecycle?: Record<string, string>
}): NurtureSchedulerStore & { created: PrescreenNurtureScheduledJob[] } {
  const created: PrescreenNurtureScheduledJob[] = []
  return {
    created,
    db: undefined, // no db → flag falls to env/default
    async fetchReviewPendingStates(dueBeforeIso, limit) {
      return args.states.filter((s) => s.stateUpdatedAt <= dueBeforeIso).slice(0, limit)
    },
    async fetchSession(sessionId) {
      return args.sessions[sessionId] ?? null
    },
    async fetchUserLifecycleState(userId) {
      return args.lifecycle?.[userId]
    },
    async upsertScheduledJob(job) {
      const existing = created.some((j) => j.jobId === job.jobId)
      created.push(job)
      return { created: !existing }
    },
    log: () => {},
  }
}

function enableFlag() {
  process.env[PRESCREEN_NURTURE_FLAG] = "1"
  _clearFeatureFlagCache()
}
function disableFlag() {
  delete process.env[PRESCREEN_NURTURE_FLAG]
  _clearFeatureFlagCache()
}

describe("scheduleNurtures — flag gate (default OFF)", () => {
  beforeEach(disableFlag)
  afterEach(disableFlag)

  it("schedules 0 and does not enumerate when the flag is OFF", async () => {
    let enumerated = false
    const store = makeSchedulerStore({
      states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: ENTERED_25H }],
      sessions: { s1: { terminal: "PASS", totalNurtureSent: 0, lastNurtureAt: null } },
    })
    store.fetchReviewPendingStates = async () => {
      enumerated = true
      return []
    }
    const res = await scheduleNurtures(store, { now: () => NOW })
    assert.deepEqual(res, { skipped: "disabled", enumerated: 0, scheduled: 0, notDue: 0 })
    assert.equal(store.created.length, 0)
    assert.equal(enumerated, false, "must not enumerate when flag OFF")
  })
})

describe("scheduleNurtures — flag ON, first nurture", () => {
  beforeEach(enableFlag)
  afterEach(disableFlag)

  it("schedules nurture #1 for an eligible candidate past the 24h delay", async () => {
    const store = makeSchedulerStore({
      states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: ENTERED_25H }],
      sessions: { s1: { terminal: "PASS", totalNurtureSent: 0, lastNurtureAt: null } },
    })
    const res = await scheduleNurtures(store, { now: () => NOW })
    assert.equal(res.scheduled, 1)
    assert.equal(store.created.length, 1)
    const job = store.created[0]!
    assert.equal(job.nurturingType, PRESCREEN_NURTURE_TYPE)
    assert.equal(job.userId, "u1")
    assert.equal(job.opportunityJobId, "j1")
    assert.equal(job.sessionId, "s1")
    assert.equal(job.nurturingNumber, 1)
    assert.equal(job.status, "pending")
    assert.equal(job.dueAt, job.nextFireAt)
    assert.equal(
      job.jobId,
      nurtureScheduledJobId({ candidateId: "u1", jobId: "j1", nurturingNumber: 1 })
    )
  })

  it("does NOT schedule a 2nd nurture before the 7d interval elapses", async () => {
    // 1 already sent only 1 day ago → interval (7d) not yet elapsed.
    const oneDayAgo = new Date(NOW.getTime() - 1 * DAY).toISOString()
    const store = makeSchedulerStore({
      states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: ENTERED_25H }],
      sessions: { s1: { terminal: "PASS", totalNurtureSent: 1, lastNurtureAt: oneDayAgo } },
    })
    const res = await scheduleNurtures(store, { now: () => NOW })
    assert.equal(res.scheduled, 0)
    assert.equal(res.notDue, 1)
    assert.equal(store.created.length, 0)
  })

  it("schedules nurture #2 once 7d have elapsed since the last", async () => {
    const eightDaysAgo = new Date(NOW.getTime() - 8 * DAY).toISOString()
    const store = makeSchedulerStore({
      states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: ENTERED_25H }],
      sessions: { s1: { terminal: "PASS", totalNurtureSent: 1, lastNurtureAt: eightDaysAgo } },
    })
    const res = await scheduleNurtures(store, { now: () => NOW })
    assert.equal(res.scheduled, 1)
    assert.equal(store.created[0]!.nurturingNumber, 2)
  })

  it("does not schedule past the max cap", async () => {
    const longAgo = new Date(NOW.getTime() - 30 * DAY).toISOString()
    const store = makeSchedulerStore({
      states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: ENTERED_25H }],
      sessions: {
        s1: {
          terminal: "PASS",
          totalNurtureSent: DEFAULT_NURTURE_CADENCE.maxNurturesPerSession,
          lastNurtureAt: longAgo,
        },
      },
    })
    const res = await scheduleNurtures(store, { now: () => NOW })
    assert.equal(res.scheduled, 0)
    assert.equal(res.enumerated, 0, "capped candidate filtered out at enumeration")
  })
})

describe("computeNextNurture — cadence math", () => {
  function eligible(over: Partial<NurtureEligible>): NurtureEligible {
    return {
      candidateId: "u1",
      jobId: "j1",
      sessionId: "s1",
      prescreenTerminal: "PASS",
      totalNurtureSent: 0,
      lastNurtureAt: null,
      stateUpdatedAt: ENTERED_25H,
      ...over,
    }
  }

  it("nurture #1 fires at stateUpdatedAt + 24h and is due", () => {
    const next = computeNextNurture(eligible({}), NOW)
    assert.ok(next)
    assert.equal(next!.nurturingNumber, 1)
    const expected = new Date(new Date(ENTERED_25H).getTime() + DEFAULT_NURTURE_CADENCE.firstNurtureDelayMs)
    assert.equal(next!.nextFireAt, expected.toISOString())
  })

  it("returns null at the cap", () => {
    const next = computeNextNurture(
      eligible({ totalNurtureSent: DEFAULT_NURTURE_CADENCE.maxNurturesPerSession }),
      NOW
    )
    assert.equal(next, null)
  })

  it("returns null when the next interval has not elapsed", () => {
    const recent = new Date(NOW.getTime() - 1 * DAY).toISOString()
    const next = computeNextNurture(eligible({ totalNurtureSent: 1, lastNurtureAt: recent }), NOW)
    assert.equal(next, null)
  })
})
