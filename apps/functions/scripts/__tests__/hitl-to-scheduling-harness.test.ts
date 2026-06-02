/**
 * hitl-to-scheduling-harness.test.ts — deterministic, network-free proof of the
 * HITL-commit -> scheduling linkage for thin Claire.
 *
 * Drives the REAL production seam end to end against an in-memory Firestore:
 *
 *   1. seed a pa-prescreen-sessions doc in the exact shape commitPrescreenOutcome
 *      expects (terminal PASS, terminalActionPendingReview=true, review pending,
 *      e164 present) + the matching pa-evaluation-attempts doc.
 *   2. invoke the REAL runReviewEvaluationAttempt (the body of the callable
 *      paReviewEvaluationAttempt) with status:"approved" and an admin auth token.
 *      Only sendSms is stubbed — markPrescreenOutcome is the REAL
 *      markPrescreenTerminalOutcome -> applyPassedCandidateSnapshot, so the
 *      employer-visible profile is written by the real reducer, not the test.
 *   3. assert the commit side effects: terminalActionPendingReview flips false,
 *      pa-candidate-job-states -> employer_visible, and
 *      pa-employer-visible-profiles/{jobId}__{candidateId} now exists.
 *   4. call the REAL listSchedulableJobs (the query behind offer_interview_slots)
 *      for Adam's dev uid and assert the committed TEST job appears — and that the
 *      dev-mimic jobs do NOT (the mimic only fires when the real query is empty).
 *
 * This is the load-bearing proof: a real dashboard PASS commit makes that exact
 * job schedulable. No Sendblue, no Cal.com, no network.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createCandidateJobStateId,
  createEmployerVisibleProfileId,
  createEvaluationAttemptId,
  type EvaluationAttempt,
} from "@pa/core-types"
import { runReviewEvaluationAttempt } from "../../src/evaluation-attempts.js"
import {
  markFirstInterviewStarted,
  markPrescreenReviewPending,
} from "../../src/prescreen-outcome-service.js"
import {
  listSchedulableJobs,
  SCHEDULING_DEV_UIDS,
} from "../../src/claire-agent/tools/scheduling-tools.js"
import type { ClaireToolContext } from "../../src/claire-agent/types.js"

// Adam's dev uid (+14243201960) — in SCHEDULING_DEV_UIDS.
const ADAM_UID = "8fEwIduUrzxZsblHHsNz"
const TEST_JOB_ID = "dev-hitl-sched-test-software_engineering"
const NOW = "2026-06-02T12:00:00.000Z"
const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

const ADMIN_AUTH = {
  uid: "operator-harness",
  token: { admin: true as const },
}

type Doc = Record<string, unknown>
type Store = Map<string, Map<string, Doc>>

// ---------------------------------------------------------------------------
// In-memory Firestore: doc get/set + runTransaction + minimal where().get().
// Extends the prescreen-outcome-service.test.ts fake with equality queries so
// listSchedulableJobs' .where("candidateId","==",uid) resolves.
// ---------------------------------------------------------------------------
function makeStore(): Store {
  return new Map([
    ...Object.values(PA_COLLECTIONS).map((name) => [name, new Map<string, Doc>()] as const),
    [PRESCREEN_SESSIONS, new Map<string, Doc>()] as const,
    ["matching-jobs", new Map<string, Doc>()] as const,
    ["pa-jobs", new Map<string, Doc>()] as const,
  ])
}

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

function seedAttempt(): EvaluationAttempt {
  const attemptId = createEvaluationAttemptId({
    source: "prescreen",
    candidateId: ADAM_UID,
    jobId: TEST_JOB_ID,
    prescreenSessionId: SESSION_ID,
  })
  return {
    schemaVersion: 1,
    attemptId,
    source: "prescreen",
    purpose: "employment_prescreen",
    candidateId: ADAM_UID,
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
    explanation: "Harness-seeded PASS for HITL->scheduling linkage proof.",
    evidence: [],
    humanReview: { status: "pending" },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

async function seedPendingPass(db: Firestore, store: Store, attempt: EvaluationAttempt) {
  store.get(PA_COLLECTIONS.evaluationAttempts)!.set(attempt.attemptId, attempt)
  // Drive the REAL state-machine entry the same way finalizePrescreenForHumanReview
  // does in prod: prescreen_started -> prescreen_review_pending. The HITL commit's
  // applyPassedCandidateSnapshot enforces prescreen_passed is only valid FROM
  // prescreen_review_pending, so this is the faithful precondition (a hand-written
  // doc would skip that real guard).
  await markFirstInterviewStarted({
    db,
    sessionId: SESSION_ID,
    userId: ADAM_UID,
    jobId: TEST_JOB_ID,
    occurredAt: NOW,
  })
  await markPrescreenReviewPending({
    db,
    sessionId: SESSION_ID,
    userId: ADAM_UID,
    jobId: TEST_JOB_ID,
    terminal: "PASS",
    occurredAt: NOW,
  })
  store.get(PRESCREEN_SESSIONS)!.set(SESSION_ID, {
    sessionId: SESSION_ID,
    userId: ADAM_UID,
    jobId: TEST_JOB_ID,
    e164: "+14243201960",
    terminal: "PASS",
    terminalReason: "Harness-seeded strong answers.",
    score: 1,
    scoreMax: 1,
    terminalActionPendingReview: true,
    evaluationAttemptId: attempt.attemptId,
    review: {
      status: "pending",
      evaluationAttemptId: attempt.attemptId,
      proposedTerminal: "PASS",
      pendingAt: NOW,
      updatedAt: NOW,
    },
    updatedAt: NOW,
  })
  // matching-jobs label source so listSchedulableJobs resolves a human label.
  store.get("matching-jobs")!.set(TEST_JOB_ID, {
    jobTitle: "Software Engineer",
    companyName: "WeKruit HITL Harness",
    roleFunction: ["software_engineering"],
  })
}

function ctxFor(uid: string, db: Firestore): ClaireToolContext {
  return {
    db,
    userId: uid,
    sessionId: "harness-session",
    lang: "en",
    transport: {} as ClaireToolContext["transport"],
    judgeModel: "harness",
    log: () => {},
    nowIso: () => NOW,
  }
}

test("Adam's uid is in the scheduling dev allowlist (precondition)", () => {
  assert.equal(SCHEDULING_DEV_UIDS.has(ADAM_UID), true)
})

test("REAL HITL approve commit makes the committed TEST job schedulable (and not the dev-mimic)", async () => {
  const store = makeStore()
  const db = makeFakeFirestore(store)
  const attempt = seedAttempt()
  await seedPendingPass(db, store, attempt)

  // ── Before: the real schedulable list is the dev-mimic (no committed pass yet).
  const before = await listSchedulableJobs(ctxFor(ADAM_UID, db))
  const beforeIds = before.map((j) => j.jobId)
  assert.ok(
    beforeIds.includes("dev-metavoice-swe") || beforeIds.includes("dev-helium-design"),
    `expected dev-mimic before commit, got ${JSON.stringify(beforeIds)}`,
  )
  assert.equal(beforeIds.includes(TEST_JOB_ID), false)

  // ── Commit the PASS through the REAL callable body. Only SMS is stubbed.
  const sent: Array<Record<string, unknown>> = []
  const result = await runReviewEvaluationAttempt(
    {
      attemptId: attempt.attemptId,
      status: "approved",
      finalOutcome: { prescreenTerminal: "PASS" },
      candidateMessageBody:
        "Great news — WeKruit reviewed your first screen and wants to move you forward to the next step.",
      decisionReason: "Strong, direct ownership in the screen.",
      recommendedActions: ["Watch for the next WeKruit text."],
    },
    ADMIN_AUTH,
    {
      db,
      now: () => NOW,
      sendSms: async (args) => {
        sent.push(args as unknown as Record<string, unknown>)
        return { outboundId: "harness-out-1", created: true } as never
      },
    },
  )

  // ── Commit assertions.
  assert.equal(result.prescreenOutcomeCommitted, true)
  assert.equal(sent.length, 1, "exactly one (stubbed) decision SMS")
  const session = store.get(PRESCREEN_SESSIONS)!.get(SESSION_ID)!
  assert.equal(session.terminalActionPendingReview, false, "pending-review flag flipped")
  assert.equal((session.review as Record<string, unknown>).status, "approved")

  const snapshotId = createEmployerVisibleProfileId(TEST_JOB_ID, ADAM_UID)
  const snapshot = store.get(PA_COLLECTIONS.employerVisibleProfiles)!.get(snapshotId)
  assert.ok(snapshot, `employer-visible profile ${snapshotId} must exist after commit`)
  assert.equal((snapshot as Record<string, unknown>).candidateId, ADAM_UID)
  assert.equal((snapshot as Record<string, unknown>).jobId, TEST_JOB_ID)

  const state = store.get(PA_COLLECTIONS.candidateJobStates)!.get(createCandidateJobStateId(ADAM_UID, TEST_JOB_ID))!
  assert.equal(state.state, "employer_visible")

  // ── The linkage: the committed TEST job is now schedulable, mimic is gone.
  const after = await listSchedulableJobs(ctxFor(ADAM_UID, db))
  const afterIds = after.map((j) => j.jobId)
  assert.ok(afterIds.includes(TEST_JOB_ID), `committed job must be schedulable, got ${JSON.stringify(afterIds)}`)
  assert.equal(afterIds.includes("dev-metavoice-swe"), false, "dev-mimic must NOT appear once a real pass exists")
  assert.equal(afterIds.includes("dev-helium-design"), false)
  // label resolved from matching-jobs.
  const testJob = after.find((j) => j.jobId === TEST_JOB_ID)!
  assert.match(testJob.label, /Software Engineer/)
})

test("a NON-dev uid with a committed pass gets the job in the list but tools gate scheduling", async () => {
  // listSchedulableJobs itself is NOT gated (it returns real committed passes for
  // anyone); the GATE is inside offer_interview_slots/book_interview_slot. Prove
  // the real query returns the committed job for a non-dev too, with NO dev-mimic
  // leakage (mimic is dev-only).
  const store = makeStore()
  const db = makeFakeFirestore(store)
  const NON_DEV = "someRandomCandidateUid000"
  store.get(PA_COLLECTIONS.employerVisibleProfiles)!.set(
    createEmployerVisibleProfileId("real-job-xyz", NON_DEV),
    { candidateId: NON_DEV, jobId: "real-job-xyz" },
  )
  const jobs = await listSchedulableJobs(ctxFor(NON_DEV, db))
  assert.deepEqual(jobs.map((j) => j.jobId), ["real-job-xyz"])

  // And a non-dev with NO committed pass gets an EMPTY list (no dev-mimic phantom).
  const empty = await listSchedulableJobs(ctxFor("anotherNonDevUid00000000", db))
  assert.deepEqual(empty, [])
})
