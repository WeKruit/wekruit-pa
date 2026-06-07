/**
 * Prescreen-NURTURE enumerator unit tests — filtering, opt-out respect, cap.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  enumerateNurtureCandidates,
  NURTURE_BLOCKED_LIFECYCLE_STATES,
  type NurtureEnumeratorStore,
} from "../prescreen-nurture-enumerator.js"
import { DEFAULT_NURTURE_CADENCE } from "../prescreen-nurture-scheduler.js"

type StateRow = {
  candidateId: string
  jobId: string
  prescreenSessionId?: string
  stateUpdatedAt: string
}
type SessionRow = { terminal: string | null; totalNurtureSent: number; lastNurtureAt: string | null }

function makeStore(args: {
  states: StateRow[]
  sessions?: Record<string, SessionRow>
  lifecycle?: Record<string, string>
}): NurtureEnumeratorStore & { logs: unknown[][] } {
  const logs: unknown[][] = []
  return {
    logs,
    async fetchReviewPendingStates(dueBeforeIso, limit) {
      return args.states
        .filter((s) => s.stateUpdatedAt <= dueBeforeIso)
        .slice(0, limit)
    },
    async fetchSession(sessionId) {
      return args.sessions?.[sessionId] ?? null
    },
    async fetchUserLifecycleState(userId) {
      return args.lifecycle?.[userId]
    },
    log: (...a) => logs.push(a),
  }
}

const NOW = new Date("2026-06-02T00:00:00.000Z")
// 25h ago — past the 24h firstNurtureDelay.
const ENTERED = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString()
// 10h ago — NOT yet past the 24h firstNurtureDelay.
const RECENT = new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString()

describe("enumerateNurtureCandidates — happy path", () => {
  it("returns an eligible candidate past firstNurtureDelay with a terminal session", async () => {
    const store = makeStore({
      states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: ENTERED }],
      sessions: { s1: { terminal: "PASS", totalNurtureSent: 0, lastNurtureAt: null } },
      lifecycle: { u1: "active_job_seeker" },
    })
    const out = await enumerateNurtureCandidates(store, { now: () => NOW })
    assert.equal(out.length, 1)
    assert.deepEqual(
      { id: out[0]!.candidateId, job: out[0]!.jobId, term: out[0]!.prescreenTerminal, sent: out[0]!.totalNurtureSent },
      { id: "u1", job: "j1", term: "PASS", sent: 0 }
    )
  })
})

describe("enumerateNurtureCandidates — firstNurtureDelay window", () => {
  it("does not surface states that entered review-pending too recently", async () => {
    // The store's fetchReviewPendingStates honors dueBefore = now - 24h, so a
    // 10h-old state is filtered at the query boundary.
    const store = makeStore({
      states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: RECENT }],
      sessions: { s1: { terminal: "PASS", totalNurtureSent: 0, lastNurtureAt: null } },
    })
    const out = await enumerateNurtureCandidates(store, { now: () => NOW })
    assert.equal(out.length, 0)
  })
})

describe("enumerateNurtureCandidates — opt-out respect", () => {
  for (const blocked of NURTURE_BLOCKED_LIFECYCLE_STATES) {
    it(`skips a candidate whose lifecycleState is ${blocked}`, async () => {
      const store = makeStore({
        states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: ENTERED }],
        sessions: { s1: { terminal: "PASS", totalNurtureSent: 0, lastNurtureAt: null } },
        lifecycle: { u1: blocked },
      })
      const out = await enumerateNurtureCandidates(store, { now: () => NOW })
      assert.equal(out.length, 0)
    })
  }
})

describe("enumerateNurtureCandidates — cap", () => {
  it(`drops a session at the max (${DEFAULT_NURTURE_CADENCE.maxNurturesPerSession})`, async () => {
    const store = makeStore({
      states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: ENTERED }],
      sessions: {
        s1: {
          terminal: "PASS",
          totalNurtureSent: DEFAULT_NURTURE_CADENCE.maxNurturesPerSession,
          lastNurtureAt: ENTERED,
        },
      },
    })
    const out = await enumerateNurtureCandidates(store, { now: () => NOW })
    assert.equal(out.length, 0)
  })

  it("keeps a session just below the cap", async () => {
    const store = makeStore({
      states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: ENTERED }],
      sessions: {
        s1: {
          terminal: "PASS",
          totalNurtureSent: DEFAULT_NURTURE_CADENCE.maxNurturesPerSession - 1,
          lastNurtureAt: ENTERED,
        },
      },
    })
    const out = await enumerateNurtureCandidates(store, { now: () => NOW })
    assert.equal(out.length, 1)
  })
})

describe("enumerateNurtureCandidates — guards", () => {
  it("skips states with no session id", async () => {
    const store = makeStore({
      states: [{ candidateId: "u1", jobId: "j1", stateUpdatedAt: ENTERED }],
    })
    const out = await enumerateNurtureCandidates(store, { now: () => NOW })
    assert.equal(out.length, 0)
  })

  it("skips sessions with no terminal (still in progress)", async () => {
    const store = makeStore({
      states: [{ candidateId: "u1", jobId: "j1", prescreenSessionId: "s1", stateUpdatedAt: ENTERED }],
      sessions: { s1: { terminal: null, totalNurtureSent: 0, lastNurtureAt: null } },
    })
    const out = await enumerateNurtureCandidates(store, { now: () => NOW })
    assert.equal(out.length, 0)
  })

  it("fails open: a throwing session read skips that row, keeps the rest", async () => {
    const store = makeStore({
      states: [
        { candidateId: "u1", jobId: "j1", prescreenSessionId: "bad", stateUpdatedAt: ENTERED },
        { candidateId: "u2", jobId: "j2", prescreenSessionId: "s2", stateUpdatedAt: ENTERED },
      ],
      sessions: { s2: { terminal: "FAIL", totalNurtureSent: 1, lastNurtureAt: ENTERED } },
    })
    store.fetchSession = async (id) => {
      if (id === "bad") throw new Error("boom")
      return { terminal: "FAIL", totalNurtureSent: 1, lastNurtureAt: ENTERED }
    }
    const out = await enumerateNurtureCandidates(store, { now: () => NOW })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.candidateId, "u2")
  })

  it("fails open: a throwing states query returns []", async () => {
    const store = makeStore({ states: [] })
    store.fetchReviewPendingStates = async () => {
      throw new Error("index missing")
    }
    const out = await enumerateNurtureCandidates(store, { now: () => NOW })
    assert.deepEqual(out, [])
  })
})
