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

test("resolveInboundUserId binds phone from job interview opener token", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "cand_job_bind_01"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore

  const resolved = await resolveInboundUserId(
    db,
    "+14155550183",
    `WeKruit_photon-macos-devops_${candidateId}_Job`,
  )
  assert.equal(resolved, candidateId)

  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(userSnap.data()?.phoneE164, "+14155550183")
})

test("resolveInboundUserId replaces malformed stored phone with Sendblue-confirmed job token phone", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "cand_job_malformed_phone_01"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, {
    id: candidateId,
    source: "candidate",
    phoneE164: "+08149313759",
  })
  const db = fakeDb as unknown as Firestore

  const resolved = await resolveInboundUserId(
    db,
    "+12693203158",
    `WeKruit_hs-11005308-paradigm-gtm-growth_${candidateId}_Job`,
  )
  assert.equal(resolved, candidateId)

  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(userSnap.data()?.phoneE164, "+12693203158")
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

test("DEV_BYPASS_PHONE follow-up resolves to active post-prescreen recommendation user over cold duplicate", async () => {
  const fakeDb = new FakeFirestore()
  const phoneE164 = "+14243201960"
  fakeDb.seed(PA_COLLECTIONS.users, "cold_onboarding_duplicate", {
    id: "cold_onboarding_duplicate",
    source: "candidate",
    phoneE164,
    onboardingState: "pending",
    workSession: {
      kind: "shared_onboarding",
      status: "active",
      boundary: "website_sms_onboarding",
      currentQuestionId: "main_goal",
      startedAt: "2026-05-27T15:30:59.533Z",
    },
    sharedOnboarding: {
      status: "active",
      completed: false,
      currentQuestionId: "main_goal",
    },
    updatedAt: "2026-05-27T15:30:59.533Z",
  })
  fakeDb.seed(PA_COLLECTIONS.users, "post_prescreen_recommendation_user", {
    id: "post_prescreen_recommendation_user",
    source: "candidate",
    phoneE164,
    onboardingState: "pending",
    workSession: {
      kind: "shared_onboarding",
      status: "active",
      boundary: "website_sms_onboarding",
      startSource: "post_prescreen_pass",
      currentQuestionId: "main_goal",
      postPrescreenContext: {
        jobTitle: "Software Engineer - Fullstack",
        company: "Rain",
      },
      startedAt: "2026-05-24T04:57:01.194Z",
    },
    sharedOnboarding: {
      status: "active",
      completed: false,
      currentQuestionId: "main_goal",
    },
    postMatchRetention: {
      stage: "await_liked",
      recCount: 2,
      startedAt: "2026-05-24T05:07:14.601Z",
      updatedAt: "2026-05-24T05:07:14.601Z",
    },
    updatedAt: "2026-05-24T16:53:12.821Z",
  })
  const db = fakeDb as unknown as Firestore

  const resolved = await resolveInboundUserId(db, phoneE164, "Sure")

  assert.equal(resolved, "post_prescreen_recommendation_user")
})

test("non-dev phone with TWO matching pa-users picks oldest createdAt deterministically (not doc-name order)", async () => {
  // Identity hardening 2026-05-28 — guard against the latent flap: Firestore's
  // implicit order is doc-name asc, so a newer orphan whose id sorts FIRST
  // would hijack the thread. Resolution must be stable on the original
  // (oldest createdAt) profile regardless of doc-name order.
  const fakeDb = new FakeFirestore()
  const phoneE164 = "+14155550234"
  // "aaa_orphan" sorts BEFORE "zzz_original" by doc name, but is the NEWER doc.
  fakeDb.seed(PA_COLLECTIONS.users, "aaa_orphan", {
    id: "aaa_orphan",
    source: "candidate",
    phoneE164,
    createdAt: "2026-05-26T18:33:30.836Z",
    updatedAt: "2026-05-28T19:22:07.386Z",
  })
  fakeDb.seed(PA_COLLECTIONS.users, "zzz_original", {
    id: "zzz_original",
    source: "candidate",
    phoneE164,
    createdAt: "2026-05-21T21:40:04.862Z",
    updatedAt: "2026-05-28T19:47:09.252Z",
  })
  const db = fakeDb as unknown as Firestore

  // No opener token → pure phone lookup path → deterministic tiebreak.
  const resolved = await resolveInboundUserId(db, phoneE164, "remote or NYC")
  assert.equal(resolved, "zzz_original", "oldest createdAt wins, not doc-name-first orphan")

  // Stable across repeated turns.
  const again = await resolveInboundUserId(db, phoneE164, "any AI startups?")
  assert.equal(again, "zzz_original")
})

test("non-dev phone multi-match falls back to most-recent updatedAt when createdAt is absent", async () => {
  const fakeDb = new FakeFirestore()
  const phoneE164 = "+14155550235"
  fakeDb.seed(PA_COLLECTIONS.users, "doc_stale", {
    id: "doc_stale",
    source: "candidate",
    phoneE164,
    updatedAt: "2026-05-20T00:00:00.000Z",
  })
  fakeDb.seed(PA_COLLECTIONS.users, "doc_fresh", {
    id: "doc_fresh",
    source: "candidate",
    phoneE164,
    updatedAt: "2026-05-28T00:00:00.000Z",
  })
  const db = fakeDb as unknown as Firestore

  const resolved = await resolveInboundUserId(db, phoneE164, "hi")
  assert.equal(resolved, "doc_fresh", "no createdAt on either → most-recent updatedAt wins")
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
