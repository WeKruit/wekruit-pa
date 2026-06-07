/**
 * proactive-scheduling-invite.test.ts — deterministic, network-free proof of the
 * two HITL→scheduling gaps for thin Claire.
 *
 *   GAP 1 (proactive invite on commit): a dev-uid PASS commit, run through the
 *     REAL runReviewEvaluationAttempt, fires a proactive interview invite that
 *     offers REAL-ish slots and texts the candidate — instead of waiting for them
 *     to come back. Idempotent (re-commit never double-invites) and fail-open
 *     (an invite failure never fails the commit).
 *
 *   GAP 2 (widenable gate, inert default): isSchedulingEligible returns true for a
 *     dev uid at default, false for a random uid at default, and true for a random
 *     uid ONLY when the paSchedulingEnabled flag's allowlist includes them. Proves
 *     the default is byte-identical to today (dev-uids-only) for a real candidate:
 *     NO proactive invite and the scheduling tools stay gated.
 *
 * Drives the REAL production seam against an in-memory Firestore — no Sendblue, no
 * Cal.com, no @openai/agents SDK (the offer builder + send are injected spies, but
 * the GATE + opt-out + idempotency + commit are the real code).
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createEvaluationAttemptId,
  type EvaluationAttempt,
} from "@pa/core-types"
import { _clearFeatureFlagCache, setFlag } from "@pa/pa-persistence"
import { runReviewEvaluationAttempt } from "../../src/evaluation-attempts.js"
import {
  markFirstInterviewStarted,
  markPrescreenReviewPending,
} from "../../src/prescreen-outcome-service.js"
import {
  isSchedulingEligible,
  SCHEDULING_FLAG_KEY,
} from "../../src/claire-agent/scheduling-gate.js"
import {
  sendProactiveSchedulingInvite,
  composeSchedulingInviteText,
} from "../../src/claire-agent/scheduling-invite.js"

const ADAM_UID = "8fEwIduUrzxZsblHHsNz" // dev uid (SCHEDULING_DEV_UIDS floor)
const RANDOM_UID = "someRealCandidateUid0001"
const TEST_JOB_ID = "dev-hitl-sched-test-software_engineering"
const NOW = "2026-06-02T12:00:00.000Z"
const PRESCREEN_SESSIONS = "pa-prescreen-sessions"
const FEATURE_FLAGS = "pa-feature-flags"

const ADMIN_AUTH = { uid: "operator-harness", token: { admin: true as const } }

type Doc = Record<string, unknown>
type Store = Map<string, Map<string, Doc>>

function makeStore(): Store {
  return new Map([
    ...Object.values(PA_COLLECTIONS).map((name) => [name, new Map<string, Doc>()] as const),
    [PRESCREEN_SESSIONS, new Map<string, Doc>()] as const,
    [FEATURE_FLAGS, new Map<string, Doc>()] as const,
    ["matching-jobs", new Map<string, Doc>()] as const,
    ["pa-jobs", new Map<string, Doc>()] as const,
  ])
}

// In-memory Firestore: doc get/set + runTransaction + minimal where().get() +
// nested subcollections (mirrors hitl-to-scheduling-harness.test.ts).
function makeFakeFirestore(store: Store): Firestore {
  function col(name: string): Map<string, Doc> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }
  function docRef(collectionName: string, id: string) {
    return {
      id,
      _collectionName: collectionName,
      _id: id,
      collection(sub: string) {
        return collection(`${collectionName}/${id}/${sub}`)
      },
      async get() {
        const data = col(collectionName).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Doc, opts?: { merge?: boolean }) {
        const current = col(collectionName).get(id)
        col(collectionName).set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
    }
  }
  type Filter = { field: string; value: unknown }
  function makeQuery(collectionName: string, filters: Filter[]) {
    return {
      where(field: string, _op: string, value: unknown) {
        return makeQuery(collectionName, [...filters, { field, value }])
      },
      limit(_n: number) {
        return makeQuery(collectionName, filters)
      },
      async get() {
        const docs = [...col(collectionName).entries()]
          .filter(([, data]) => filters.every((f) => (data as Doc)[f.field] === f.value))
          .map(([id, data]) => ({ id, exists: true, data: () => data }))
        return { empty: docs.length === 0, size: docs.length, docs }
      },
    }
  }
  function collection(collectionName: string) {
    return {
      doc(id: string) {
        return docRef(collectionName, id)
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(collectionName, []).where(field, op, value)
      },
    }
  }
  const db = {
    collection,
    async runTransaction<T>(fn: (tx: {
      get: (ref: ReturnType<typeof docRef>) => Promise<{ exists: boolean; id: string; data: () => Doc | undefined }>
      set: (ref: ReturnType<typeof docRef>, data: Doc, opts?: { merge?: boolean }) => void
      update: (ref: ReturnType<typeof docRef>, data: Doc) => void
    }) => Promise<T>): Promise<T> {
      const writes: Array<{ ref: ReturnType<typeof docRef>; data: Doc; opts?: { merge?: boolean } }> = []
      const tx = {
        async get(ref: ReturnType<typeof docRef>) {
          const data = col(ref._collectionName).get(ref._id)
          return { exists: data !== undefined, id: ref._id, data: () => data }
        },
        set(ref: ReturnType<typeof docRef>, data: Doc, opts?: { merge?: boolean }) {
          writes.push({ ref, data, opts })
        },
        update(ref: ReturnType<typeof docRef>, data: Doc) {
          writes.push({ ref, data, opts: { merge: true } })
        },
      }
      const result = await fn(tx)
      for (const w of writes) {
        const current = col(w.ref._collectionName).get(w.ref._id)
        col(w.ref._collectionName).set(
          w.ref._id,
          w.opts?.merge && current ? { ...current, ...w.data } : { ...w.data },
        )
      }
      return result
    },
  }
  return db as unknown as Firestore
}

const SESSION_ID = `dev-hitl-sched-${ADAM_UID}-${TEST_JOB_ID}`

function seedAttempt(candidateId: string): EvaluationAttempt {
  const attemptId = createEvaluationAttemptId({
    source: "prescreen",
    candidateId,
    jobId: TEST_JOB_ID,
    prescreenSessionId: SESSION_ID,
  })
  return {
    schemaVersion: 1,
    attemptId,
    source: "prescreen",
    purpose: "employment_prescreen",
    candidateId,
    jobId: TEST_JOB_ID,
    prescreenSessionId: SESSION_ID,
    rubricVersion: "prescreen-config-v1",
    algorithmVersion: "screening-eval-harness",
    evaluator: { kind: "hybrid", promptVersion: "harness" },
    dimensions: [],
    gates: [],
    weightedFitScore: 0.9,
    evidenceConfidence: 0.9,
    missingEvidence: [],
    riskFlags: [],
    proposedOutcome: { kind: "pass", prescreenTerminal: "PASS" },
    reviewPriority: "normal",
    explanation: "Harness-seeded PASS for proactive-invite proof.",
    evidence: [],
    humanReview: { status: "pending" },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

async function seedPendingPass(db: Firestore, store: Store, attempt: EvaluationAttempt, candidateId: string) {
  store.get(PA_COLLECTIONS.evaluationAttempts)!.set(attempt.attemptId, attempt)
  await markFirstInterviewStarted({ db, sessionId: SESSION_ID, userId: candidateId, jobId: TEST_JOB_ID, occurredAt: NOW })
  await markPrescreenReviewPending({ db, sessionId: SESSION_ID, userId: candidateId, jobId: TEST_JOB_ID, terminal: "PASS", occurredAt: NOW })
  store.get(PRESCREEN_SESSIONS)!.set(SESSION_ID, {
    sessionId: SESSION_ID,
    userId: candidateId,
    jobId: TEST_JOB_ID,
    e164: "+14243201960",
    terminal: "PASS",
    terminalReason: "Harness-seeded strong answers.",
    score: 1,
    scoreMax: 1,
    terminalActionPendingReview: true,
    evaluationAttemptId: attempt.attemptId,
    review: { status: "pending", evaluationAttemptId: attempt.attemptId, proposedTerminal: "PASS", pendingAt: NOW, updatedAt: NOW },
    updatedAt: NOW,
  })
  store.get("matching-jobs")!.set(TEST_JOB_ID, {
    jobTitle: "Software Engineer",
    companyName: "WeKruit Harness",
    roleFunction: ["software_engineering"],
  })
}

/** A deterministic offer-builder spy that returns real-ish slots (no Cal.com). */
function fakeOfferOk() {
  const calls: Array<{ userId: string; jobId?: string }> = []
  const build = (async (ctx: { userId: string; jobId?: string }) => {
    calls.push({ userId: ctx.userId, jobId: ctx.jobId })
    return {
      ok: true as const,
      jobId: TEST_JOB_ID,
      eventTypeId: 5847961,
      timeZone: "America/New_York",
      slots: [
        { number: 1, iso: "2026-06-03T13:00:00.000Z", label: "Tue Jun 3, 9:00 AM EDT" },
        { number: 2, iso: "2026-06-04T18:00:00.000Z", label: "Wed Jun 4, 2:00 PM EDT" },
        { number: 3, iso: "2026-06-05T20:00:00.000Z", label: "Thu Jun 5, 4:00 PM EDT" },
      ],
      count: 3,
      filteredEmpty: false,
    }
  }) as never
  return { build, calls }
}

function fakeSendSpy() {
  const sends: Array<Record<string, unknown>> = []
  const sendSms = (async (args: Record<string, unknown>) => {
    sends.push(args)
    return { outboundId: `out-${sends.length}`, created: true }
  }) as never
  return { sendSms, sends }
}

// ── GAP 2 — the gate resolver. ──────────────────────────────────────────────

test("Gap 2: gate is inert at default — dev uid true, random uid false (no flag doc)", async () => {
  _clearFeatureFlagCache()
  const store = makeStore()
  const db = makeFakeFirestore(store)
  // No flag doc seeded → default OFF.
  assert.equal(await isSchedulingEligible(db, ADAM_UID), true, "dev uid eligible at default")
  assert.equal(await isSchedulingEligible(db, RANDOM_UID), false, "random uid NOT eligible at default (inert)")
  assert.equal(await isSchedulingEligible(db, ""), false, "empty uid never eligible")
})

test("Gap 2: a random uid becomes eligible ONLY when the flag allowlist includes them", async () => {
  _clearFeatureFlagCache()
  const store = makeStore()
  const db = makeFakeFirestore(store)
  // Ramp: Adam adds the real candidate to the paSchedulingEnabled allowlist (no deploy).
  await setFlag(
    db,
    SCHEDULING_FLAG_KEY,
    { value: false, type: "bool", scope: "perUser", allowlist: [RANDOM_UID], blocklist: [] },
    { actor: "adam", reason: "ramp scheduling to one real candidate" },
  )
  _clearFeatureFlagCache()
  assert.equal(await isSchedulingEligible(db, RANDOM_UID), true, "allowlisted real candidate now eligible")
  assert.equal(await isSchedulingEligible(db, "anotherNonListedUid00000"), false, "a different non-listed uid still NOT eligible")
  assert.equal(await isSchedulingEligible(db, ADAM_UID), true, "dev uid still eligible (floor)")
})

// ── GAP 1 — proactive invite on a PASS commit. ──────────────────────────────

test("Gap 1: commit of a DEV-uid PASS fires a proactive offer_interview_slots invite to the candidate", async () => {
  _clearFeatureFlagCache()
  const store = makeStore()
  const db = makeFakeFirestore(store)
  const attempt = seedAttempt(ADAM_UID)
  await seedPendingPass(db, store, attempt, ADAM_UID)

  const offer = fakeOfferOk()
  const send = fakeSendSpy()
  const decisionSms: Array<Record<string, unknown>> = []

  const result = await runReviewEvaluationAttempt(
    {
      attemptId: attempt.attemptId,
      status: "approved",
      finalOutcome: { prescreenTerminal: "PASS" },
      candidateMessageBody: "Great news — WeKruit wants to move you forward.",
      decisionReason: "Strong ownership.",
      recommendedActions: ["Watch for the next WeKruit text."],
    },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      // decision SMS stub (the existing committed path).
      sendSms: async (args) => {
        decisionSms.push(args as unknown as Record<string, unknown>)
        return { outboundId: "decision-out", created: true } as never
      },
      // Gap-1 invite wired with REAL sendProactiveSchedulingInvite but spied seams.
      sendSchedulingInvite: (inviteArgs) =>
        sendProactiveSchedulingInvite({ ...inviteArgs, buildOffer: offer.build, sendSms: send.sendSms }),
    },
  )

  assert.equal(result.prescreenOutcomeCommitted, true, "PASS committed")
  assert.equal(decisionSms.length, 1, "exactly one decision SMS (unchanged)")

  // The proactive invite fired: the offer builder was called for THIS candidate+job…
  assert.equal(offer.calls.length, 1, "offer_interview_slots core invoked once")
  assert.equal(offer.calls[0]!.userId, ADAM_UID)
  assert.equal(offer.calls[0]!.jobId, TEST_JOB_ID)
  // …and the invite was texted with the REAL slots.
  assert.ok(send.sends.length >= 1, "at least one invite bubble queued")
  assert.equal(send.sends[0]!.userId, ADAM_UID)
  assert.equal(send.sends[0]!.to, "+14243201960")
  assert.equal(send.sends[0]!.runtimeSource, "pa_proactive_scheduling_invite")
  const inviteBody = send.sends.map((s) => String(s.content)).join("\n")
  assert.match(inviteBody, /9:00 AM EDT/, "invite carries the real offered slot label")
  // …and the session is stamped so a re-commit won't double-invite.
  const session = store.get(PRESCREEN_SESSIONS)!.get(SESSION_ID)!
  assert.equal(session.schedulingInviteSentAt, NOW, "schedulingInviteSentAt stamped")
})

test("Gap 1: re-commit does NOT double-invite (idempotent on the session stamp)", async () => {
  _clearFeatureFlagCache()
  const store = makeStore()
  const db = makeFakeFirestore(store)
  const attempt = seedAttempt(ADAM_UID)
  await seedPendingPass(db, store, attempt, ADAM_UID)

  const offer = fakeOfferOk()
  const send = fakeSendSpy()
  const deps = {
    db,
    now: () => NOW,
    sendSms: (async () => ({ outboundId: "decision-out", created: true })) as never,
    sendSchedulingInvite: (inviteArgs: Parameters<typeof sendProactiveSchedulingInvite>[0]) =>
      sendProactiveSchedulingInvite({ ...inviteArgs, buildOffer: offer.build, sendSms: send.sendSms }),
  }
  const input = {
    attemptId: attempt.attemptId,
    status: "approved" as const,
    finalOutcome: { prescreenTerminal: "PASS" as const },
    candidateMessageBody: "Great news — moving you forward.",
    decisionReason: "Strong.",
    recommendedActions: ["Watch for the next text."],
  }

  await runReviewEvaluationAttempt(input, ADMIN_AUTH, deps)
  const firstSends = send.sends.length
  assert.ok(firstSends >= 1, "first commit invited")

  // Re-commit the SAME attempt → the schedulingInviteSentAt stamp short-circuits.
  await runReviewEvaluationAttempt(input, ADMIN_AUTH, deps)
  assert.equal(offer.calls.length, 1, "offer builder NOT called again on re-commit")
  assert.equal(send.sends.length, firstSends, "NO additional invite bubbles on re-commit")
})

test("Gap 1: an invite-send failure does NOT fail the commit (fail-open)", async () => {
  _clearFeatureFlagCache()
  const store = makeStore()
  const db = makeFakeFirestore(store)
  const attempt = seedAttempt(ADAM_UID)
  await seedPendingPass(db, store, attempt, ADAM_UID)

  const result = await runReviewEvaluationAttempt(
    {
      attemptId: attempt.attemptId,
      status: "approved",
      finalOutcome: { prescreenTerminal: "PASS" },
      candidateMessageBody: "Great news.",
      decisionReason: "Strong.",
      recommendedActions: ["Watch for the next text."],
    },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      sendSms: (async () => ({ outboundId: "decision-out", created: true })) as never,
      // The whole invite throws — the commit must still succeed.
      sendSchedulingInvite: (async () => {
        throw new Error("boom: invite path exploded")
      }) as never,
    },
  )
  assert.equal(result.prescreenOutcomeCommitted, true, "PASS still committed despite invite blow-up")
})

// ── GAP 1 + GAP 2 — the inert default for a REAL candidate. ─────────────────

test("Default (no flag): a NON-eligible candidate's PASS sends NO proactive scheduling invite", async () => {
  _clearFeatureFlagCache()
  const store = makeStore()
  const db = makeFakeFirestore(store)
  const attempt = seedAttempt(RANDOM_UID)
  await seedPendingPass(db, store, attempt, RANDOM_UID)
  // Make the session phone the candidate's, not a dev phone.
  store.get(PRESCREEN_SESSIONS)!.get(SESSION_ID)!.e164 = "+15555550123"

  const offer = fakeOfferOk()
  const send = fakeSendSpy()
  const decisionSms: Array<Record<string, unknown>> = []

  const result = await runReviewEvaluationAttempt(
    {
      attemptId: attempt.attemptId,
      status: "approved",
      finalOutcome: { prescreenTerminal: "PASS" },
      candidateMessageBody: "Great news.",
      decisionReason: "Strong.",
      recommendedActions: ["Watch for the next text."],
    },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      sendSms: async (args) => {
        decisionSms.push(args as unknown as Record<string, unknown>)
        return { outboundId: "decision-out", created: true } as never
      },
      // REAL invite logic, but the gate is the real isSchedulingEligible → at the
      // default (no flag) a random candidate is NOT eligible → no offer, no send.
      sendSchedulingInvite: (inviteArgs) =>
        sendProactiveSchedulingInvite({ ...inviteArgs, buildOffer: offer.build, sendSms: send.sendSms }),
    },
  )

  assert.equal(result.prescreenOutcomeCommitted, true, "PASS committed (decision SMS still sends)")
  assert.equal(decisionSms.length, 1, "the existing decision SMS is unchanged")
  // The proactive invite is INERT for a real candidate at default.
  assert.equal(offer.calls.length, 0, "offer builder NOT invoked for a non-eligible candidate")
  assert.equal(send.sends.length, 0, "NO proactive scheduling invite sent")
  const session = store.get(PRESCREEN_SESSIONS)!.get(SESSION_ID)!
  assert.equal(session.schedulingInviteSentAt, undefined, "no invite stamp written")
})

test("Gap 1: a non-PASS (FAIL) commit sends NO proactive scheduling invite even for a dev uid", async () => {
  _clearFeatureFlagCache()
  const store = makeStore()
  const db = makeFakeFirestore(store)
  const attempt = seedAttempt(ADAM_UID)
  await seedPendingPass(db, store, attempt, ADAM_UID)

  const offer = fakeOfferOk()
  const send = fakeSendSpy()

  await runReviewEvaluationAttempt(
    {
      attemptId: attempt.attemptId,
      status: "overridden",
      finalOutcome: { prescreenTerminal: "FAIL" },
      candidateMessageBody: "Thanks for the time — not a fit for this specific role.",
      decisionReason: "Insufficient direct evidence.",
      recommendedActions: ["Keep your profile active."],
    },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      sendSms: (async () => ({ outboundId: "decision-out", created: true })) as never,
      sendSchedulingInvite: (inviteArgs) =>
        sendProactiveSchedulingInvite({ ...inviteArgs, buildOffer: offer.build, sendSms: send.sendSms }),
    },
  )
  assert.equal(offer.calls.length, 0, "no offer on a FAIL commit")
  assert.equal(send.sends.length, 0, "no proactive invite on a FAIL commit")
})

// ── unit: copy composer ─────────────────────────────────────────────────────

test("composeSchedulingInviteText renders ≤4 numbered slots + a reply instruction", () => {
  const bubbles = composeSchedulingInviteText([
    { label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" },
  ])
  assert.equal(bubbles.length, 2)
  assert.match(bubbles[0]!, /first interview/i)
  assert.match(bubbles[1]!, /1\. A/)
  assert.match(bubbles[1]!, /4\. D/)
  assert.doesNotMatch(bubbles[1]!, /5\. E/, "caps at 4 slots")
  assert.match(bubbles[1]!, /Reply with the number/i)
})

// ── opt-out gate ────────────────────────────────────────────────────────────

test("Gap 1: an opted-out dev candidate gets NO proactive invite", async () => {
  _clearFeatureFlagCache()
  const store = makeStore()
  const db = makeFakeFirestore(store)
  // Dev uid is eligible, but lifecycle is opted_out → must not message.
  store.get(PA_COLLECTIONS.users)!.set(ADAM_UID, { candidateLifecycleState: "opted_out" })
  const offer = fakeOfferOk()
  const send = fakeSendSpy()
  const outcome = await sendProactiveSchedulingInvite({
    db,
    candidateId: ADAM_UID,
    jobId: TEST_JOB_ID,
    toE164: "+14243201960",
    sessionId: SESSION_ID,
    nowIso: NOW,
    buildOffer: offer.build,
    sendSms: send.sendSms,
  })
  assert.deepEqual(outcome, { sent: false, reason: "opted_out" })
  assert.equal(offer.calls.length, 0, "no Cal.com offer for an opted-out candidate")
  assert.equal(send.sends.length, 0, "no invite for an opted-out candidate")
})
