/**
 * prescreen-review-sla.test.ts — 2026-06-10 trust audit (fixes 9 + 10).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import {
  paPrescreenReviewSlaHandler,
  PRESCREEN_NUDGE_COPY,
  REVIEW_SLA_MS,
} from "./prescreen-review-sla.js"

const NOW = new Date("2026-06-10T09:00:00Z")
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()
const HOUR = 60 * 60 * 1000

type DocData = Record<string, unknown>

function makeFakeDb(initial: Record<string, Record<string, DocData>> = {}) {
  const stores = new Map<string, Map<string, DocData>>()
  for (const [coll, rows] of Object.entries(initial)) {
    stores.set(coll, new Map(Object.entries(rows)))
  }
  function bucket(coll: string): Map<string, DocData> {
    if (!stores.has(coll)) stores.set(coll, new Map())
    return stores.get(coll)!
  }
  const db = {
    collection(coll: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const d = bucket(coll).get(id)
              return { exists: d !== undefined, data: () => d, id }
            },
            async set(data: DocData, opts?: { merge?: boolean }) {
              if (opts?.merge) bucket(coll).set(id, { ...(bucket(coll).get(id) ?? {}), ...data })
              else bucket(coll).set(id, { ...data })
            },
          }
        },
        where(field: string, _op: string, value: unknown) {
          return {
            limit(max: number) {
              return {
                async get() {
                  const docs = [...bucket(coll).entries()]
                    .filter(([, d]) => d[field] === value)
                    .slice(0, max)
                    .map(([id, data]) => ({ id, data: () => data }))
                  return { docs, empty: docs.length === 0, size: docs.length }
                },
              }
            },
          }
        },
      }
    },
  } as unknown as Firestore
  return { db, stores }
}

function fakeEnqueue() {
  const calls: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const enqueue = async (_db: unknown, input: { idempotencyKey: string } & Record<string, unknown>) => {
    calls.push(input)
    if (seen.has(input.idempotencyKey)) return { id: `out_${input.idempotencyKey}`, created: false }
    seen.add(input.idempotencyKey)
    return { id: `out_${input.idempotencyKey}`, created: true }
  }
  return { calls, enqueue: enqueue as never }
}

describe("fix 9 — pendingReview SLA alarm (read-only)", () => {
  it("counts >48h pendingReview sessions, logs breach with per-job breakdown, alerts Slack", async () => {
    const { db, stores } = makeFakeDb({
      "pa-prescreen-sessions": {
        old1: {
          userId: "u1",
          jobId: "job-a",
          terminal: "PASS",
          terminalActionPendingReview: true,
          updatedAt: iso(72 * HOUR),
        },
        old2: {
          userId: "u2",
          jobId: "job-a",
          terminal: "PASS",
          terminalActionPendingReview: true,
          updatedAt: iso(50 * HOUR),
        },
        old3: {
          userId: "u3",
          jobId: "job-b",
          terminal: "PASS",
          terminalActionPendingReview: true,
          updatedAt: iso(120 * HOUR),
        },
        fresh: {
          userId: "u4",
          jobId: "job-a",
          terminal: "PASS",
          terminalActionPendingReview: true,
          updatedAt: iso(2 * HOUR),
        },
      },
    })
    const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
    const alerts: Array<Record<string, unknown>> = []
    const sessionsBefore = JSON.stringify([...stores.get("pa-prescreen-sessions")!.entries()])

    const result = await paPrescreenReviewSlaHandler({
      db,
      now: () => NOW,
      log: (event, payload) => logs.push({ event, payload }),
      postSlackAlert: (async (input: Record<string, unknown>) => {
        alerts.push(input)
        return { posted: true }
      }) as never,
      enqueueOutbound: fakeEnqueue().enqueue,
    })

    assert.equal(result.pendingReviewTotal, 4)
    assert.equal(result.slaBreached, 3, ">48h only")
    assert.equal(result.perJob["job-a"], 2)
    assert.equal(result.perJob["job-b"], 1)
    assert.equal(result.oldestAgeHours, 120)
    const breach = logs.find((l) => l.event === "pa.prescreen.review_sla_breach")
    assert.ok(breach, "breach log emitted")
    assert.equal(breach!.payload?.count, 3)
    assert.equal(alerts.length, 1, "Slack alert fired")
    // READ-ONLY: pendingReview sessions untouched (no terminal/no review mutation).
    const sessionsAfter = JSON.stringify([...stores.get("pa-prescreen-sessions")!.entries()])
    assert.equal(sessionsAfter, sessionsBefore, "the SLA half mutates nothing")
    assert.equal(REVIEW_SLA_MS, 48 * HOUR)
  })

  it("no breach → no alert, ok log only", async () => {
    const { db } = makeFakeDb({
      "pa-prescreen-sessions": {
        fresh: { userId: "u1", jobId: "j", terminalActionPendingReview: true, updatedAt: iso(HOUR) },
      },
    })
    const logs: string[] = []
    const alerts: unknown[] = []
    const result = await paPrescreenReviewSlaHandler({
      db,
      now: () => NOW,
      log: (event) => logs.push(event),
      postSlackAlert: (async (i: unknown) => {
        alerts.push(i)
        return { posted: true }
      }) as never,
      enqueueOutbound: fakeEnqueue().enqueue,
    })
    assert.equal(result.slaBreached, 0)
    assert.equal(alerts.length, 0)
    assert.ok(logs.includes("pa.prescreen.review_sla_ok"))
  })
})

describe("fix 10 — stalled-screen 24h nudge (canary-gated, idempotent)", () => {
  const openSessions = (): Record<string, DocData> => ({
    stalled_canary: {
      userId: "canary-user",
      jobId: "job-a",
      terminal: null,
      e164: "+14243201960",
      updatedAt: iso(30 * HOUR),
    },
    stalled_noncanary: {
      userId: "regular-user",
      jobId: "job-a",
      terminal: null,
      e164: "+15550001111",
      updatedAt: iso(30 * HOUR),
    },
    active_recent: {
      userId: "canary-user-2",
      jobId: "job-b",
      terminal: null,
      e164: "+14243201961",
      updatedAt: iso(2 * HOUR),
    },
  })

  it("nudges ONLY the canary user's stalled session, once, with the locked warm copy", async () => {
    const { db, stores } = makeFakeDb({ "pa-prescreen-sessions": openSessions() })
    const { calls, enqueue } = fakeEnqueue()
    const result = await paPrescreenReviewSlaHandler({
      db,
      now: () => NOW,
      log: () => {},
      postSlackAlert: (async () => ({ posted: true })) as never,
      enqueueOutbound: enqueue,
      isNudgeCanary: (userId) => userId === "canary-user",
    })
    assert.equal(result.nudgeCandidates, 2, "two stalled sessions found")
    assert.equal(result.nudgesSent, 1, "only the canary user is nudged")
    assert.equal(result.nudgesSkippedCanary, 1, "the non-canary user is skipped")
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.body, PRESCREEN_NUDGE_COPY)
    assert.equal(calls[0]!.idempotencyKey, "prescreen-nudge-stalled_canary")
    assert.equal(calls[0]!.toE164, "+14243201960")
    assert.equal(calls[0]!.runtimeApproved, true)
    // Session stamped so future sweeps short-circuit.
    const stamped = stores.get("pa-prescreen-sessions")!.get("stalled_canary")!
    assert.ok(stamped.nudgeSentAt)
  })

  it("IDEMPOTENT: a second sweep run sends nothing new", async () => {
    const { db } = makeFakeDb({ "pa-prescreen-sessions": openSessions() })
    const { calls, enqueue } = fakeEnqueue()
    const deps = {
      db,
      now: () => NOW,
      log: () => {},
      postSlackAlert: (async () => ({ posted: true })) as never,
      enqueueOutbound: enqueue,
      isNudgeCanary: (userId: string) => userId === "canary-user",
    }
    const first = await paPrescreenReviewSlaHandler(deps)
    assert.equal(first.nudgesSent, 1)
    const second = await paPrescreenReviewSlaHandler(deps)
    assert.equal(second.nudgesSent, 0, "no second nudge for the same session")
    assert.ok(second.nudgesSkippedIdempotent >= 1)
    assert.equal(calls.length, 1, "the enqueue seam was only ever hit once (nudgeSentAt short-circuit)")
  })

  it("even WITHOUT the nudgeSentAt stamp, the enqueueOutbound idempotencyKey blocks a double-send", async () => {
    // Simulate the stamp write being lost (e.g. crash after enqueue): the
    // deterministic doc id derived from `prescreen-nudge-<sessionId>` still
    // dedups at the outbound layer.
    const sessions = openSessions()
    const { db, stores } = makeFakeDb({ "pa-prescreen-sessions": sessions })
    const { calls, enqueue } = fakeEnqueue()
    const deps = {
      db,
      now: () => NOW,
      log: () => {},
      postSlackAlert: (async () => ({ posted: true })) as never,
      enqueueOutbound: enqueue,
      isNudgeCanary: (userId: string) => userId === "canary-user",
    }
    const first = await paPrescreenReviewSlaHandler(deps)
    assert.equal(first.nudgesSent, 1)
    // wipe the stamp — force the second run down to the enqueue seam
    const row = stores.get("pa-prescreen-sessions")!.get("stalled_canary")!
    delete row.nudgeSentAt
    const second = await paPrescreenReviewSlaHandler(deps)
    assert.equal(second.nudgesSent, 0)
    assert.equal(second.nudgesSkippedIdempotent, 1, "created:false counted as idempotent skip")
    assert.equal(calls.length, 2, "enqueue called again but deduped by idempotencyKey")
  })

  it("falls back to the pa-users phone when the session has no e164 [nudge]", async () => {
    const { db } = makeFakeDb({
      "pa-prescreen-sessions": {
        s1: { userId: "canary-user", jobId: "j", terminal: null, updatedAt: iso(30 * HOUR) },
      },
      "pa-users": { "canary-user": { phoneE164: "+14243209999" } },
    })
    const { calls, enqueue } = fakeEnqueue()
    const result = await paPrescreenReviewSlaHandler({
      db,
      now: () => NOW,
      log: () => {},
      postSlackAlert: (async () => ({ posted: true })) as never,
      enqueueOutbound: enqueue,
      isNudgeCanary: () => true,
    })
    assert.equal(result.nudgesSent, 1)
    assert.equal(calls[0]!.toE164, "+14243209999")
  })
})

describe("fix 11 — auto-draft backstop (drafts missing pending-review sessions, never sends)", () => {
  it("drafts ONLY pending sessions missing review.autoDraft; skips those already drafted", async () => {
    const { db } = makeFakeDb({
      "pa-prescreen-sessions": {
        needs_draft_fail: {
          userId: "u1",
          jobId: "job-a",
          terminal: "FAIL",
          terminalActionPendingReview: true,
          evaluationAttemptId: "att-1",
          score: 0.4,
          scoreMax: 1,
          updatedAt: iso(11 * 24 * HOUR), // >10 days pending
          review: { proposedTerminal: "FAIL", status: "pending" },
        },
        already_drafted: {
          userId: "u2",
          jobId: "job-a",
          terminal: "HARD_STOP",
          terminalActionPendingReview: true,
          review: { proposedTerminal: "HARD_STOP", status: "pending", autoDraft: { candidateMessageBody: "already here" } },
        },
        needs_draft_pass: {
          userId: "u3",
          jobId: "job-b",
          terminal: "PASS",
          terminalActionPendingReview: true,
          review: { proposedTerminal: "PASS", status: "pending" },
        },
      },
    })
    const drafted: Array<Record<string, unknown>> = []
    const result = await paPrescreenReviewSlaHandler({
      db,
      now: () => NOW,
      log: () => {},
      postSlackAlert: (async () => ({ posted: true })) as never,
      enqueueOutbound: fakeEnqueue().enqueue,
      generateAutoDraft: (async (a: Record<string, unknown>) => {
        drafted.push(a)
        return { stored: true }
      }) as never,
    })

    assert.equal(result.backstopDrafted, 2, "the two undrafted pending sessions get a draft")
    assert.equal(result.backstopDraftFailed, 0)
    const ids = drafted.map((d) => d.sessionId).sort()
    assert.deepEqual(ids, ["needs_draft_fail", "needs_draft_pass"])
    assert.ok(!ids.includes("already_drafted"), "a session with review.autoDraft is skipped")
    // The drafter receives the resolved terminal + ids from the session.
    const failCall = drafted.find((d) => d.sessionId === "needs_draft_fail")!
    assert.equal(failCall.terminal, "FAIL")
    assert.equal(failCall.candidateId, "u1")
    assert.equal(failCall.jobId, "job-a")
    assert.equal(failCall.attemptId, "att-1")
  })

  it("is fail-open: a drafter error increments backstopDraftFailed, never throws", async () => {
    const { db } = makeFakeDb({
      "pa-prescreen-sessions": {
        s1: {
          userId: "u1",
          jobId: "j",
          terminal: "FAIL",
          terminalActionPendingReview: true,
          review: { proposedTerminal: "FAIL" },
        },
      },
    })
    const result = await paPrescreenReviewSlaHandler({
      db,
      now: () => NOW,
      log: () => {},
      postSlackAlert: (async () => ({ posted: true })) as never,
      enqueueOutbound: fakeEnqueue().enqueue,
      generateAutoDraft: (async () => {
        throw new Error("LLM down")
      }) as never,
    })
    // generateAndStorePrescreenAutoDraft itself is fail-open, but the sweep also
    // guards each row, so a throwing drafter increments the failure counter.
    assert.equal(result.backstopDraftFailed, 1)
    assert.equal(result.backstopDrafted, 0)
  })
})
