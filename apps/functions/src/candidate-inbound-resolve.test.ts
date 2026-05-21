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

test("DEV_BYPASS_PHONE (+14243201960): Hello, WeKruit! opener replaces stale phone ownership", async () => {
  // Adam directive 2026-05-21 — the dev/test phone (+14243201960) is the
  // ONLY phone for which the opener may release a prior owner and reassign
  // ownership. Every other number is strict (1 email = 1 phone).
  const fakeDb = new FakeFirestore()
  const staleUserId = "stale_phone_owner_01"
  const candidateId = "cand_opener_rebind_01"
  const phoneE164 = "+14243201960"
  fakeDb.seed(PA_COLLECTIONS.users, staleUserId, {
    id: staleUserId,
    source: "admin",
    phoneE164,
    phoneE164Source: "cv_parsed",
    dailyJobRecSubscribe: { optedIn: true, optedInAt: "2026-05-21T04:13:06.769Z" },
    postMatchRetention: { stage: "await_prescreen" },
    collabInvitePending: { jobId: "job_123" },
  })
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "WeKruit_Laid_Off" })
  fakeDb.seed("pa-job-profiles", staleUserId, { userId: staleUserId, status: "active" })
  const db = fakeDb as unknown as Firestore

  const opener = buildHelloWekruitOpenerBody(candidateId)
  const resolved = await resolveInboundUserId(db, phoneE164, opener)
  assert.equal(resolved, candidateId)

  const staleSnap = await db.collection(PA_COLLECTIONS.users).doc(staleUserId).get()
  assert.equal(staleSnap.data()?.phoneE164, null)
  assert.equal(staleSnap.data()?.phoneE164Source, null)
  assert.equal(typeof staleSnap.data()?.phoneE164ReleasedAt, "string")
  assert.deepEqual(staleSnap.data()?.dailyJobRecSubscribe, {
    optedIn: false,
    optedOutAt: staleSnap.data()?.phoneE164ReleasedAt,
    source: "dev_phone_rebind_release",
  })
  assert.equal(staleSnap.data()?.postMatchRetention, null)
  assert.equal(staleSnap.data()?.collabInvitePending, null)

  const staleProfileSnap = await db.collection("pa-job-profiles").doc(staleUserId).get()
  assert.equal(staleProfileSnap.data()?.status, "paused")
  assert.equal(staleProfileSnap.data()?.source, "dev_phone_rebind_release")

  const candidateSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(candidateSnap.data()?.phoneE164, phoneE164)

  const followupResolved = await resolveInboundUserId(db, phoneE164, "remote or NYC")
  assert.equal(followupResolved, candidateId)
})

test("non-dev phone: Hello, WeKruit! opener REJECTS when phone is already owned by another candidate", async () => {
  // Adam invariant 2026-05-21 — every phone other than DEV_BYPASS_PHONE
  // is strict 1:1. An opener pointing at a different candidate from a
  // phone that already owns another pa-users must throw identity_conflict
  // and leave both pa-users unchanged.
  const fakeDb = new FakeFirestore()
  const ownerUserId = "phone_owner_strict_01"
  const candidateId = "cand_opener_reject_01"
  const phoneE164 = "+14155550199"
  fakeDb.seed(PA_COLLECTIONS.users, ownerUserId, {
    id: ownerUserId,
    source: "candidate",
    phoneE164,
    phoneE164Source: "candidate",
  })
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore

  const opener = buildHelloWekruitOpenerBody(candidateId)
  await assert.rejects(
    async () => {
      await resolveInboundUserId(db, phoneE164, opener)
    },
    /identity_conflict:(pa_users_phone_mismatch|phone_handle_owner_mismatch|pa_users_phone_already_taken)/,
  )

  // Both pa-users rows unchanged — the strict pre-flight checks ran
  // before any write.
  const ownerSnap = await db.collection(PA_COLLECTIONS.users).doc(ownerUserId).get()
  assert.equal(ownerSnap.data()?.phoneE164, phoneE164)
  const candidateSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(candidateSnap.data()?.phoneE164, undefined)
})
