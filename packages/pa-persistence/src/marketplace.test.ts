import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createCandidateJobStateId,
  createEmployerVisibleProfileId,
  type CandidateJobEvent,
  type CandidateLifecycleEvent,
  type CorrectionEvent,
  type EmployerVisibleProfile,
  type FeedbackEvent,
} from "@pa/core-types"
import {
  applyCandidateJobEvent,
  applyCandidateLifecycleEvent,
  writeCorrectionEvent,
  writeEmployerVisibleProfile,
  writeFeedbackEvent,
} from "./marketplace.js"

type Store = Map<string, Map<string, Record<string, unknown>>>

const now = "2026-05-13T12:00:00.000Z"

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  function col(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }

  function docRef(collectionName: string, id: string) {
    return {
      id,
      _collectionName: collectionName,
      _id: id,
      async get() {
        const data = col(collectionName).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const current = col(collectionName).get(id)
        col(collectionName).set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
    }
  }

  function collection(collectionName: string) {
    return {
      doc(id: string) {
        return docRef(collectionName, id)
      },
    }
  }

  const db = {
    collection,
    async runTransaction<T>(fn: (tx: {
      get: (ref: ReturnType<typeof docRef>) => Promise<{ exists: boolean; id: string; data: () => Record<string, unknown> | undefined }>
      set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>, opts?: { merge?: boolean }) => void
    }) => Promise<T>): Promise<T> {
      const writes: Array<{
        ref: ReturnType<typeof docRef>
        data: Record<string, unknown>
        opts?: { merge?: boolean }
      }> = []
      const tx = {
        async get(ref: ReturnType<typeof docRef>) {
          const data = col(ref._collectionName).get(ref._id)
          return { exists: data !== undefined, id: ref._id, data: () => data }
        },
        set(ref: ReturnType<typeof docRef>, data: Record<string, unknown>, opts?: { merge?: boolean }) {
          writes.push({ ref, data, opts })
        },
      }
      const result = await fn(tx)
      for (const w of writes) {
        const current = col(w.ref._collectionName).get(w.ref._id)
        col(w.ref._collectionName).set(
          w.ref._id,
          w.opts?.merge && current ? { ...current, ...w.data } : { ...w.data }
        )
      }
      return result
    },
  }

  return { db: db as unknown as Firestore, store }
}

function lifecycle(type: CandidateLifecycleEvent["type"], over: Partial<CandidateLifecycleEvent> = {}): CandidateLifecycleEvent {
  return {
    eventId: `lc-${type}`,
    candidateId: "cand-1",
    actor: "system",
    occurredAt: now,
    evidence: [{ source: "system", summary: "test" }],
    type,
    ...(over as Record<string, unknown>),
  } as CandidateLifecycleEvent
}

function job(type: CandidateJobEvent["type"], over: Partial<CandidateJobEvent> = {}): CandidateJobEvent {
  return {
    eventId: `job-${type}`,
    candidateId: "cand-1",
    jobId: "job-1",
    actor: "system",
    occurredAt: now,
    evidence: [{ source: "system", summary: "test" }],
    type,
    ...(over as Record<string, unknown>),
  } as CandidateJobEvent
}

test("applyCandidateLifecycleEvent writes pa-users marketplace fields plus one audit row", async () => {
  const { db, store } = makeFakeFirestore()
  const res = await applyCandidateLifecycleEvent(db, lifecycle("profile_created"))
  assert.equal(res.state, "profile_created")
  assert.equal(res.idempotent, false)

  const user = store.get(PA_COLLECTIONS.users)!.get("cand-1")!
  assert.equal(user.candidateLifecycleState, "profile_created")
  assert.equal(user.lifecycleReason, "global_profile_exists")
  assert.equal(user.marketplaceProfile, undefined)
  assert.equal(store.get(PA_COLLECTIONS.auditEvents)!.size, 1)

  const dup = await applyCandidateLifecycleEvent(db, lifecycle("profile_created"))
  assert.equal(dup.idempotent, true)
  assert.equal(store.get(PA_COLLECTIONS.auditEvents)!.size, 1)
})

test("applyCandidateJobEvent keeps NOT_PASS job-specific and does not mutate pa-users", async () => {
  const { db, store } = makeFakeFirestore()
  await applyCandidateJobEvent(db, job("prescreen_started"))
  const result = await applyCandidateJobEvent(db, job("prescreen_not_passed"))
  assert.equal(result.state, "not_passed")
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 0)

  const stateDoc = store.get(PA_COLLECTIONS.candidateJobStates)!.get(createCandidateJobStateId("cand-1", "job-1"))!
  assert.equal(stateDoc.state, "not_passed")
  assert.equal(stateDoc.reason, "candidate_retained_for_other_jobs")
})

test("applyCandidateJobEvent does not use match score as an interview gate", async () => {
  const { db } = makeFakeFirestore()
  const result = await applyCandidateJobEvent(db, job("prescreen_started", { matchScore: 0.01 }))
  assert.equal(result.state, "prescreen_started")
})

test("feedback and correction events are append-only with conflict detection", async () => {
  const { db } = makeFakeFirestore()
  const feedback: FeedbackEvent = {
    eventId: "fb-1",
    kind: "match_feedback",
    actor: "operator",
    candidateId: "cand-1",
    jobId: "job-1",
    evidence: [],
    payloadRedacted: {},
    createdAt: now,
  }
  assert.equal((await writeFeedbackEvent(db, feedback)).created, true)
  assert.equal((await writeFeedbackEvent(db, feedback)).created, false)
  await assert.rejects(
    () => writeFeedbackEvent(db, { ...feedback, outcome: "changed" }),
    /conflicting_duplicate_event/
  )

  const correction: CorrectionEvent = {
    eventId: "corr-1",
    targetType: "candidate_profile",
    targetId: "cand-1",
    actor: "operator",
    reason: "wrong tag",
    evidence: [],
    beforeRedacted: {},
    afterRedacted: {},
    createdAt: now,
  }
  assert.equal((await writeCorrectionEvent(db, correction)).created, true)
  assert.equal((await writeCorrectionEvent(db, correction)).created, false)
  await assert.rejects(
    () => writeCorrectionEvent(db, { ...correction, reason: "different" }),
    /conflicting_duplicate_event/
  )
})

test("employer-visible snapshot requires passed candidate-job state", async () => {
  const { db, store } = makeFakeFirestore()
  const stateId = createCandidateJobStateId("cand-1", "job-1")
  store.get(PA_COLLECTIONS.candidateJobStates)!.set(stateId, {
    id: stateId,
    candidateId: "cand-1",
    jobId: "job-1",
    state: "prescreen_started",
    stateUpdatedAt: now,
  })
  const snapshot: EmployerVisibleProfile = {
    snapshotId: createEmployerVisibleProfileId("job-1", "cand-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    candidateJobStateId: stateId,
    createdFromState: "passed",
    createdBy: "system",
    createdAt: now,
  }
  await assert.rejects(() => writeEmployerVisibleProfile(db, snapshot), /requires_passed_state/)

  store.get(PA_COLLECTIONS.candidateJobStates)!.set(stateId, {
    id: stateId,
    candidateId: "cand-1",
    jobId: "job-1",
    state: "passed",
    stateUpdatedAt: now,
  })
  await assert.rejects(
    () =>
      writeEmployerVisibleProfile(db, {
        ...snapshot,
        snapshotId: createEmployerVisibleProfileId("job-2", "cand-1"),
        jobId: "job-2",
      }),
    /candidate_job_link_mismatch/
  )

  const result = await writeEmployerVisibleProfile(db, snapshot)
  assert.equal(result.created, true)
  assert.equal(store.get(PA_COLLECTIONS.employerVisibleProfiles)!.size, 1)
})
