import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { buildHelloWekruitOpenerBody } from "@pa/pa-orchestrator"
import { resolveInboundUserId } from "./candidate-inbound-resolve.js"

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
    const next = opts?.merge ? { ...prev, ...data } : { ...data }
    for (const [key, value] of Object.entries(next)) {
      if (value?.constructor?.name === "DeleteTransform") delete next[key]
    }
    coll.set(this.id, next)
    this.store.set(this.collectionPath, coll)
  }

  async update(data: DocData) {
    const coll = this.store.get(this.collectionPath) ?? new Map()
    const next = { ...(coll.get(this.id) ?? {}) }
    for (const [key, value] of Object.entries(data)) {
      if (value?.constructor?.name === "DeleteTransform") delete next[key]
      else next[key] = value
    }
    coll.set(this.id, next)
    this.store.set(this.collectionPath, coll)
  }
}

class FakeQuery {
  constructor(
    protected readonly store: Store,
    protected readonly collectionPath: string,
    private readonly field?: string,
    private readonly value?: unknown,
  ) {}

  where(field: string, _op: "==", value: unknown) {
    return new FakeQuery(this.store, this.collectionPath, field, value)
  }

  limit() {
    return this
  }

  async get() {
    const coll = this.store.get(this.collectionPath) ?? new Map()
    const docs = [...coll.entries()]
      .filter(([, data]) => (this.field ? data[this.field] === this.value : true))
      .map(([id, data]) => ({ id, data: () => data }))
    return { empty: docs.length === 0, docs }
  }
}

class FakeCollection extends FakeQuery {
  constructor(store: Store, collectionPath: string) {
    super(store, collectionPath)
  }

  doc(id: string) {
    return new FakeDocRef(this.store, this.collectionPath, id)
  }
}

class FakeFirestore {
  private readonly store: Store = new Map()

  collection(path: string) {
    return new FakeCollection(this.store, path)
  }

  seed(path: string, id: string, data: DocData) {
    new FakeDocRef(this.store, path, id).set(data)
  }
}

test("resolveInboundUserId binds phone from Hello, WeKruit! opener suffix", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "cand_opener_bind_01"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore

  const opener = buildHelloWekruitOpenerBody(candidateId)
  const resolved = await resolveInboundUserId(db, "+14155550182", opener)
  assert.equal(resolved, candidateId)

  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(userSnap.data()?.phoneE164, "+14155550182")
})

test("resolveInboundUserId lets Hello, WeKruit! opener replace stale phone ownership", async () => {
  const fakeDb = new FakeFirestore()
  const staleUserId = "stale_phone_owner_01"
  const candidateId = "cand_opener_rebind_01"
  const phoneE164 = "+14155550183"
  fakeDb.seed(PA_COLLECTIONS.users, staleUserId, {
    id: staleUserId,
    source: "admin",
    phoneE164,
    phoneE164Source: "cv_parsed",
  })
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "WeKruit_Laid_Off" })
  const db = fakeDb as unknown as Firestore

  const opener = buildHelloWekruitOpenerBody(candidateId)
  const resolved = await resolveInboundUserId(db, phoneE164, opener)
  assert.equal(resolved, candidateId)

  const staleSnap = await db.collection(PA_COLLECTIONS.users).doc(staleUserId).get()
  assert.equal(staleSnap.data()?.phoneE164, null)
  assert.equal(staleSnap.data()?.phoneE164Source, null)
  assert.equal(typeof staleSnap.data()?.phoneE164ReleasedAt, "string")

  const candidateSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(candidateSnap.data()?.phoneE164, phoneE164)

  const followupResolved = await resolveInboundUserId(db, phoneE164, "remote or NYC")
  assert.equal(followupResolved, candidateId)
})
