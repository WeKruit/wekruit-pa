import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  createCandidateJobStateId,
  createEmployerVisibleProfileId,
} from "@pa/core-types"
import {
  buildPrescreenStartedEvent,
  markFirstInterviewStarted,
  markPrescreenTerminalOutcome,
} from "./prescreen-outcome-service.js"

type Store = Map<string, Map<string, Record<string, unknown>>>

const now = "2026-05-13T12:00:00.000Z"

function makeStore(): Store {
  return new Map([
    ...Object.values(PA_COLLECTIONS).map((name) => [name, new Map()] as const),
    ["pa-prescreen-sessions", new Map()] as const,
  ])
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
      collection(subcollectionName: string) {
        return collection(`${collectionName}/${id}/${subcollectionName}`)
      },
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

test("buildPrescreenStartedEvent has no match-score gate input", () => {
  const event = buildPrescreenStartedEvent({
    db: makeFakeFirestore().db,
    sessionId: "ps-1",
    userId: "cand-1",
    jobId: "job-1",
    occurredAt: now,
  })
  assert.equal(event.type, "prescreen_started")
  assert.equal(event.prescreenSessionId, "ps-1")
  assert.equal("matchScore" in event, false)
})

test("markFirstInterviewStarted records direct candidate prescreen_started", async () => {
  const { db, store } = makeFakeFirestore()
  await markFirstInterviewStarted({
    db,
    sessionId: "ps-direct",
    userId: "cand-1",
    jobId: "job-1",
    occurredAt: now,
  })
  const state = store.get(PA_COLLECTIONS.candidateJobStates)!.get(createCandidateJobStateId("cand-1", "job-1"))!
  assert.equal(state.state, "prescreen_started")
  assert.equal(state.prescreenSessionId, "ps-direct")
})

test("markFirstInterviewStarted records outbound candidate prescreen_started", async () => {
  const { db, store } = makeFakeFirestore()
  const stateId = createCandidateJobStateId("cand-1", "job-1")
  store.get(PA_COLLECTIONS.candidateJobStates)!.set(stateId, {
    id: stateId,
    candidateId: "cand-1",
    jobId: "job-1",
    state: "outbound_sent",
    stateUpdatedAt: now,
  })
  await markFirstInterviewStarted({
    db,
    sessionId: "ps-outbound",
    userId: "cand-1",
    jobId: "job-1",
    occurredAt: now,
  })
  const state = store.get(PA_COLLECTIONS.candidateJobStates)!.get(stateId)!
  assert.equal(state.state, "prescreen_started")
  assert.equal(state.prescreenSessionId, "ps-outbound")
})

test("markPrescreenTerminalOutcome creates snapshot only for PASS", async () => {
  const passed = makeFakeFirestore()
  await markFirstInterviewStarted({
    db: passed.db,
    sessionId: "ps-pass",
    userId: "cand-1",
    jobId: "job-1",
    occurredAt: now,
  })
  passed.store.get("pa-prescreen-sessions")!.set("ps-pass", {
    sessionId: "ps-pass",
    userId: "cand-1",
    jobId: "job-1",
    terminal: "PASS",
    terminalReason: "Strong React answer. Email alice@example.com.",
    score: 1,
    scoreMax: 1,
  })
  await markPrescreenTerminalOutcome({
    db: passed.db,
    sessionId: "ps-pass",
    userId: "cand-1",
    jobId: "job-1",
    terminal: "PASS",
    occurredAt: now,
  })
  const state = passed.store.get(PA_COLLECTIONS.candidateJobStates)!.get(createCandidateJobStateId("cand-1", "job-1"))!
  assert.equal(state.state, "employer_visible")
  assert.equal(state.employerVisibleProfileId, createEmployerVisibleProfileId("job-1", "cand-1"))
  const snapshot = passed.store.get(PA_COLLECTIONS.employerVisibleProfiles)!.get(createEmployerVisibleProfileId("job-1", "cand-1"))!
  assert.match(String(snapshot.passReason), /\[redacted email\]/)

  const failed = makeFakeFirestore()
  await markFirstInterviewStarted({
    db: failed.db,
    sessionId: "ps-fail",
    userId: "cand-1",
    jobId: "job-1",
    occurredAt: now,
  })
  await markPrescreenTerminalOutcome({
    db: failed.db,
    sessionId: "ps-fail",
    userId: "cand-1",
    jobId: "job-1",
    terminal: "HARD_STOP",
    occurredAt: now,
  })
  assert.equal(failed.store.get(PA_COLLECTIONS.employerVisibleProfiles)!.size, 0)
  assert.equal(
    failed.store.get(PA_COLLECTIONS.candidateJobStates)!.get(createCandidateJobStateId("cand-1", "job-1"))!.state,
    "not_passed"
  )
})
