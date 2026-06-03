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

test("resolveInboundUserId binds phone from the verification-code opener suffix", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "cand_opener_bind_01"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore

  const opener = buildHelloWekruitOpenerBody(candidateId)
  // The current built body is a start-greeting (2026-06-02 #2); token = QR tracking, not a code.
  assert.ok(opener.startsWith("Hi, WeKruit!"))
  const resolved = await resolveInboundUserId(db, "+14155550182", opener)
  assert.equal(resolved, candidateId)

  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(userSnap.data()?.phoneE164, "+14155550182")
})

test("resolveInboundUserId still binds phone from the LEGACY Hello, WeKruit! opener (in-flight QR links)", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "cand_legacy_opener_bind_01"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore

  // Hard-coded OLD body — a QR code already printed/in the wild emits this verbatim.
  const legacyOpener = `Hello, WeKruit! ${candidateId}`
  const resolved = await resolveInboundUserId(db, "+14155550199", legacyOpener)
  assert.equal(resolved, candidateId)

  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(userSnap.data()?.phoneE164, "+14155550199")
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

test("non-dev phone: opener for B from a phone OWNED BY A resolves to A (phone = unique key), never cross-binds B", async () => {
  // Adam policy 2026-05-29 — phone is the unique identity key. An opener that
  // names candidate B but arrives from a phone already owned by entity A must
  // resolve to A (the phone owner), NOT bind/steal the phone for B, and NOT
  // throw (no stuck `running` event). B is left completely unchanged.
  const fakeDb = new FakeFirestore()
  const ownerUserId = "phoneOwnerStrictAAAA"
  const candidateId = "candOpenerRejectBBBB"
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
  const resolved = await resolveInboundUserId(db, phoneE164, opener)
  assert.equal(resolved, ownerUserId, "phone owner wins — resolve to A, not the opener-named B")

  // A keeps the phone; B never received it.
  const ownerSnap = await db.collection(PA_COLLECTIONS.users).doc(ownerUserId).get()
  assert.equal(ownerSnap.data()?.phoneE164, phoneE164)
  const candidateSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(candidateSnap.data()?.phoneE164, undefined, "B never cross-bound to A's phone")
})

test("non-dev phone: opener for X from a DIFFERENT phone than X's existing phone does NOT cross-bind", async () => {
  // X already owns +14155550100. An opener naming X arrives from +14155550999
  // (a different number). Different phone = different entity → do NOT bind the
  // new number to X, do NOT merge. The texted phone has no owner → resolve null
  // (caller treats it as a fresh entity keyed by that phone). X is unchanged.
  const fakeDb = new FakeFirestore()
  const candidateId = "candDiffPhoneAAAAAAA"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, {
    id: candidateId,
    source: "candidate",
    phoneE164: "+14155550100",
  })
  const db = fakeDb as unknown as Firestore

  const opener = buildHelloWekruitOpenerBody(candidateId)
  const resolved = await resolveInboundUserId(db, "+14155550999", opener)
  assert.equal(resolved, null, "different phone → no cross-bind, no owner for texted phone → null")

  const snap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(snap.data()?.phoneE164, "+14155550100", "X's existing phone untouched")
})

test("non-dev phone: opener collapses same-phone signup duplicates and recognizes the merged entity (Yogesh shape)", async () => {
  // Two profiles signed up 2 min apart with different emails but the SAME phone
  // (+18303265553). The candidate texts the opener FROM that same phone. The
  // resolver merges the duplicates (oldest createdAt canonical) and recognizes
  // the merged entity — keeping both emails + both userIds.
  const fakeDb = new FakeFirestore()
  const phone = "+18303265553"
  // Real-world doc ids from the production incident (20-char Firestore ids).
  const canonicalId = "Uu3ZeLnEMyyIMBFHV3uM"
  const dupId = "ECyfCDNOCg2SEH8CzlRQ"
  fakeDb.seed(PA_COLLECTIONS.users, canonicalId, {
    id: canonicalId,
    source: "candidate",
    phoneE164: phone,
    email: "yogeshsavirigana@gmail.com",
    createdAt: "2026-05-29T17:44:22.000Z",
    tags: { skills: ["python"] },
  })
  fakeDb.seed(PA_COLLECTIONS.users, dupId, {
    id: dupId,
    source: "candidate",
    phoneE164: phone,
    email: "yogi.savirigana1996@gmail.com",
    createdAt: "2026-05-29T17:46:11.000Z",
    tags: { skills: ["react"] },
  })
  const db = fakeDb as unknown as Firestore

  const opener = buildHelloWekruitOpenerBody(canonicalId)
  const resolved = await resolveInboundUserId(db, phone, opener)
  assert.equal(resolved, canonicalId, "resolves to the oldest-createdAt canonical entity")

  // Duplicate folded: tombstoned + emails + userId preserved on canonical.
  const dupSnap = await db.collection(PA_COLLECTIONS.users).doc(dupId).get()
  assert.equal(dupSnap.data()?.mergedInto, canonicalId)
  const canonicalSnap = await db.collection(PA_COLLECTIONS.users).doc(canonicalId).get()
  assert.deepEqual((canonicalSnap.data()?.tags as Record<string, unknown>).skills, ["python", "react"])
  assert.deepEqual(canonicalSnap.data()?.altEmails, ["yogi.savirigana1996@gmail.com"])
  assert.deepEqual(canonicalSnap.data()?.aliasUserIds, [dupId])
})
