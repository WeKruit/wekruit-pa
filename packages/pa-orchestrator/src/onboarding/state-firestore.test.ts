/**
 * Unit tests for FirestorePipelineStateProvider.
 *
 * Uses an in-memory fake Firestore that satisfies the FirestoreLike +
 * FirestoreTxLike interfaces. Verifies:
 *   - load() of empty doc returns emptyPipelineState
 *   - save() persists under field
 *   - load() round-trips collected/attempts maps
 *   - incrementAttempt() bumps counter via tx
 *   - missing field on doc returns empty state (defensive)
 */
import test from "node:test"
import assert from "node:assert/strict"

import { FirestorePipelineStateProvider } from "./state-firestore.js"
import { emptyPipelineState, type PipelineState } from "./pipeline.js"

interface DocSlot {
  exists: boolean
  data: Record<string, unknown>
}

function makeFakeFirestore() {
  const docs = new Map<string, DocSlot>()
  const refFor = (collName: string, docId: string) => {
    const key = `${collName}/${docId}`
    return {
      _key: key,
      get: async () => {
        const d = docs.get(key)
        return {
          exists: !!d?.exists,
          data: () => d?.data ?? {},
        }
      },
      set: async (data: Record<string, unknown>, opts?: { merge: boolean }) => {
        const cur = docs.get(key) ?? { exists: true, data: {} }
        cur.exists = true
        cur.data = opts?.merge ? { ...cur.data, ...data } : { ...data }
        docs.set(key, cur)
      },
    }
  }
  const collection = (collName: string) => ({
    doc: (docId: string) => refFor(collName, docId),
  })
  return {
    db: {
      collection,
      runTransaction: async <T>(fn: (tx: {
        get(ref: unknown): Promise<{ exists: boolean; data(): unknown }>
        set(ref: unknown, data: Record<string, unknown>, opts?: { merge: boolean }): unknown
      }) => Promise<T>) => {
        const tx = {
          get: async (ref: unknown) => {
            const r = ref as { _key: string }
            const d = docs.get(r._key)
            return {
              exists: !!d?.exists,
              data: () => d?.data ?? {},
            }
          },
          set: (ref: unknown, data: Record<string, unknown>, opts?: { merge: boolean }) => {
            const r = ref as { _key: string }
            const cur = docs.get(r._key) ?? { exists: true, data: {} }
            cur.exists = true
            cur.data = opts?.merge ? { ...cur.data, ...data } : { ...data }
            docs.set(r._key, cur)
            return undefined
          },
        }
        return fn(tx)
      },
    },
    docs,
  }
}

test("FirestorePipelineStateProvider: empty doc → emptyPipelineState", async () => {
  const { db } = makeFakeFirestore()
  const provider = new FirestorePipelineStateProvider({ db: db as any })
  const state = await provider.load("u1")
  assert.deepEqual(state, emptyPipelineState())
})

test("FirestorePipelineStateProvider: save + load round-trip", async () => {
  const { db, docs } = makeFakeFirestore()
  const provider = new FirestorePipelineStateProvider({ db: db as any })
  const state: PipelineState = {
    currentQId: "q_role",
    collected: { q_lang: "zh", q_email: "alex@gmail.com" },
    attempts: { q_role: 2 },
    halted: null,
    lang: "zh",
    completed: false,
  }
  await provider.save("u1", state)
  const stored = docs.get("pa-users/u1")
  assert.ok(stored?.exists)
  assert.deepEqual((stored!.data as { pipelineState: PipelineState }).pipelineState, state)

  const reloaded = await provider.load("u1")
  assert.deepEqual(reloaded, state)
})

test("FirestorePipelineStateProvider: missing pipelineState field → empty state", async () => {
  const { db, docs } = makeFakeFirestore()
  // Pre-populate a user doc WITHOUT pipelineState (e.g. legacy user).
  docs.set("pa-users/u1", {
    exists: true,
    data: { onboardingState: "q_role_asked", someOther: "field" },
  })
  const provider = new FirestorePipelineStateProvider({ db: db as any })
  const state = await provider.load("u1")
  assert.deepEqual(state, emptyPipelineState())
})

test("FirestorePipelineStateProvider: incrementAttempt bumps counter via tx", async () => {
  const { db } = makeFakeFirestore()
  const provider = new FirestorePipelineStateProvider({ db: db as any })
  // Pre-stage: state with attempts={q_role: 2}
  await provider.save("u1", {
    ...emptyPipelineState(),
    currentQId: "q_role",
    attempts: { q_role: 2 },
  })
  const next = await provider.incrementAttempt!("u1", "q_role")
  assert.equal(next, 3)
  const reloaded = await provider.load("u1")
  assert.equal(reloaded.attempts.q_role, 3)
})

test("FirestorePipelineStateProvider: incrementAttempt on fresh user starts at 1", async () => {
  const { db } = makeFakeFirestore()
  const provider = new FirestorePipelineStateProvider({ db: db as any })
  const next = await provider.incrementAttempt!("u_new", "q_lang")
  assert.equal(next, 1)
})

test("FirestorePipelineStateProvider: custom fieldName + collection", async () => {
  const { db, docs } = makeFakeFirestore()
  const provider = new FirestorePipelineStateProvider({
    db: db as any,
    collectionName: "test-users",
    fieldName: "altState",
  })
  await provider.save("u1", {
    ...emptyPipelineState(),
    currentQId: "q_role",
  })
  const stored = docs.get("test-users/u1")
  assert.ok(stored)
  assert.equal((stored!.data as { altState: PipelineState }).altState.currentQId, "q_role")
})
