import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  candidateClaireConversationStarted,
  candidateHasResumeOnFile,
  markClaireConversationStarted,
} from "../candidate-claire-conversation.js"

type DocData = Record<string, unknown>
type Store = Map<string, Map<string, DocData>>

class FakeDocRef {
  constructor(
    private readonly store: Store,
    readonly collectionPath: string,
    readonly id: string,
  ) {}

  async get() {
    const data = this.store.get(this.collectionPath)?.get(this.id)
    return { id: this.id, exists: data !== undefined, data: () => data }
  }

  async set(data: DocData, opts?: { merge?: boolean }) {
    const coll = this.store.get(this.collectionPath) ?? new Map()
    const prev = coll.get(this.id) ?? {}
    coll.set(this.id, opts?.merge ? { ...prev, ...data } : data)
    this.store.set(this.collectionPath, coll)
  }
}

class FakeQuery {
  constructor(
    private readonly store: Store,
    private readonly collectionPath: string,
    private readonly filters: Array<{ field: string; op: string; value: unknown }>,
    private readonly limitN: number,
  ) {}

  limit(n: number) {
    return new FakeQuery(this.store, this.collectionPath, this.filters, n)
  }

  async get() {
    const coll = this.store.get(this.collectionPath) ?? new Map()
    const docs = [...coll.entries()]
      .filter(([, data]) =>
        this.filters.every(({ field, op, value }) => {
          const actual = data[field]
          if (op === "==") return actual === value
          return false
        }),
      )
      .slice(0, this.limitN)
      .map(([id, data]) => ({
        id,
        data: () => data,
      }))
    return { empty: docs.length === 0, docs, size: docs.length }
  }
}

class FakeCollection {
  constructor(
    private readonly store: Store,
    readonly collectionPath: string,
  ) {}

  doc(id: string) {
    return new FakeDocRef(this.store, this.collectionPath, id)
  }

  where(field: string, op: string, value: unknown) {
    return new FakeQuery(this.store, this.collectionPath, [{ field, op, value }], 100)
  }
}

class FakeFirestore {
  readonly store: Store = new Map()

  collection(path: string) {
    return new FakeCollection(this.store, path)
  }

  seed(path: string, id: string, data: DocData) {
    const coll = this.store.get(path) ?? new Map()
    coll.set(id, data)
    this.store.set(path, coll)
  }
}

function fakeDb(): Firestore {
  return new FakeFirestore() as unknown as Firestore
}

test("candidateClaireConversationStarted is false without bound phone", async () => {
  const db = fakeDb()
  const started = await candidateClaireConversationStarted(db, "cand-1", {})
  assert.equal(started, false)
})

test("candidateClaireConversationStarted is true with phone and session inbound", async () => {
  const db = fakeDb() as unknown as FakeFirestore
  db.seed(PA_COLLECTIONS.sessions, "sess-1", {
    userId: "cand-1",
    lastInboundAt: "2026-05-20T00:00:00.000Z",
  })
  const started = await candidateClaireConversationStarted(db as unknown as Firestore, "cand-1", {
    phoneE164: "+14155550100",
  })
  assert.equal(started, true)
})

test("candidateClaireConversationStarted is true with explicit marker", async () => {
  const db = fakeDb()
  const started = await candidateClaireConversationStarted(db, "cand-1", {
    claireConversationStarted: true,
  })
  assert.equal(started, true)
})

test("candidateClaireConversationStarted falls back to inbound events", async () => {
  const db = fakeDb() as unknown as FakeFirestore
  db.seed(PA_COLLECTIONS.inboundEvents, "inb-1", {
    userId: "cand-1",
    status: "completed",
  })
  const started = await candidateClaireConversationStarted(db as unknown as Firestore, "cand-1", {
    phoneE164: "+14155550100",
  })
  assert.equal(started, true)
})

test("candidateHasResumeOnFile is true with latestResumeArtifactId on pa-users", async () => {
  const db = fakeDb()
  const hasResume = await candidateHasResumeOnFile(db, "cand-1", {
    latestResumeArtifactId: "artifact-abc",
  })
  assert.equal(hasResume, true)
})

test("candidateHasResumeOnFile falls back to resumeArtifacts subcollection", async () => {
  const db = fakeDb() as unknown as FakeFirestore
  db.seed(PA_COLLECTIONS.resumeArtifacts, "art-1", {
    candidateId: "cand-2",
    status: "parsed",
  })
  const hasResume = await candidateHasResumeOnFile(db as unknown as Firestore, "cand-2", {})
  assert.equal(hasResume, true)
})

test("markClaireConversationStarted stamps pa-users once", async () => {
  const db = fakeDb() as unknown as FakeFirestore
  await markClaireConversationStarted(db as unknown as Firestore, "cand-3")
  const first = db.store.get(PA_COLLECTIONS.users)?.get("cand-3")
  assert.equal(first?.claireConversationStarted, true)
  assert.ok(typeof first?.claireConversationStartedAt === "string")
  await markClaireConversationStarted(db as unknown as Firestore, "cand-3")
  const second = db.store.get(PA_COLLECTIONS.users)?.get("cand-3")
  assert.equal(second?.claireConversationStartedAt, first?.claireConversationStartedAt)
})
