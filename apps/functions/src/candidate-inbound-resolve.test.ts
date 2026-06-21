import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { buildHelloWekruitOpenerBody, buildBindCodeOpenerBody } from "@pa/pa-orchestrator"
import { resolveInboundUserId } from "./candidate-inbound-resolve.js"
import { issueBindCode } from "./bind-code.js"

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

  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const tx = {
      get: (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (
        ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> },
        d: DocData,
        o?: { merge?: boolean },
      ) => {
        void ref.set(d, o)
      },
    }
    return fn(tx)
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

test("REGRESSION: live +18563790960 dup pair resolves stably to the oldest-createdAt live-thread doc (cv_parsed orphan never hijacks)", async () => {
  // Reproduces the EXACT live incident the .ops/dedup-pa-users-doc.mjs script targets:
  // a `/login` CV upload wrote the résumé-extracted phone DIRECTLY onto a SECOND
  // pa-users (`phoneE164Source=cv_parsed`), bypassing bindPhoneToCandidate's preflight,
  // so the same phone is held by TWO docs with NO phone handle to catch it.
  //   - KEEP  5ace89cd...  createdAt 2026-06-02 — OLDEST; owns the live iMessage session.
  //   - DUP   8VNKhFhc...  createdAt 2026-06-03 — NEWER; doc id sorts FIRST (digit '8' <
  //                        hex '5'? no — but '8VNK...' vs '5ace...' → '5' < '8', KEEP sorts
  //                        first here; the resolver must NOT rely on id order anyway).
  // The resolver must pick the oldest-createdAt doc DETERMINISTICALLY and STABLY across
  // turns — this is the SAME canonical the dedup script keeps, so resolution can never flap
  // away from the doc that owns the live thread (and the merge will fold the orphan INTO it).
  const fakeDb = new FakeFirestore()
  const phoneE164 = "+18563790960"
  const KEEP = "5ace89cd-bef5-45b4-895f-d9c2dd7c8e2d"
  const DUP = "8VNKhFhcKhl5gv422IE3"
  // DUP is NEWER (createdAt) but carries the enrichment (résumé/tags) — must still LOSE the pick.
  fakeDb.seed(PA_COLLECTIONS.users, DUP, {
    id: DUP,
    source: "candidate",
    phoneE164,
    phoneE164Source: "cv_parsed",
    createdAt: "2026-06-03T16:00:23.659Z",
    updatedAt: "2026-06-04T18:44:08.605Z",
    tags: { skills: ["python", "react"] },
    latestResumeArtifactId: "candidate_upload_dup",
  })
  fakeDb.seed(PA_COLLECTIONS.users, KEEP, {
    id: KEEP,
    source: "candidate",
    phoneE164,
    createdAt: "2026-06-02T21:57:31.138Z",
    updatedAt: "2026-06-04T18:48:20.233Z",
  })
  const db = fakeDb as unknown as Firestore

  // No opener token → pure phone lookup → deterministic multi-match tiebreak.
  const resolved = await resolveInboundUserId(db, phoneE164, "Im open to relocation")
  assert.equal(resolved, KEEP, "oldest-createdAt live-thread doc wins, never the newer cv_parsed orphan")

  // STABLE across repeated turns (cannot flap to the orphan even though it was updated later
  // AND carries the enrichment — createdAt is immutable so the pick is permanent).
  for (const turn of ["sure", "what roles do you have?", "yeah Im interested"]) {
    assert.equal(await resolveInboundUserId(db, phoneE164, turn), KEEP, `stable on turn: ${turn}`)
  }
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

// ──────────── transit-safe bind code opener (2026-06-13) ────────────────────

test("resolveInboundUserId binds the texted phone via a valid bind-code opener", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "cand_bindcode_ok_01"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore

  const code = await issueBindCode(db, candidateId)
  const opener = buildBindCodeOpenerBody(code)
  const resolved = await resolveInboundUserId(db, "+14155550111", opener)
  assert.equal(resolved, candidateId)

  // Phone bound to the candidate the code maps to.
  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(userSnap.data()?.phoneE164, "+14155550111")
  // Code marked used (single-use).
  const codeSnap = await db.collection(PA_COLLECTIONS.bindCodes).doc(code).get()
  assert.equal(codeSnap.data()?.used, true)
})

test("REGRESSION (José/Aniket 2026-06-15): a valid bind-code OVERRIDES an unverified cv_parsed résumé phone — texting phone binds, not dead silence", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "cand_resume_phone_override_01"
  // cv-ingest wrote a résumé-derived phone (unverified) that DIFFERS from the
  // real phone the candidate is texting from. Pre-fix, bindPhoneToCandidate
  // returned phone_mismatch_different_entity → fell to phone lookup → null →
  // "can't start from this phone" → dead silence.
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, {
    id: candidateId,
    source: "candidate",
    phoneE164: "+17867211987",
    phoneE164Source: "cv_parsed",
  })
  const db = fakeDb as unknown as Firestore

  const code = await issueBindCode(db, candidateId)
  const textingPhone = "+17869150039"
  const resolved = await resolveInboundUserId(db, textingPhone, buildBindCodeOpenerBody(code))
  assert.equal(resolved, candidateId, "bind-code proves identity → real texting phone binds, never dead silence")

  const u = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(u.data()?.phoneE164, textingPhone, "real SMS phone overwrites the unverified résumé guess")
  assert.equal(u.data()?.phoneE164Source, "sms_bind", "marker flips to verified SMS bind")
})

test("a VERIFIED differing phone still blocks a bind-code cross-bind (guard intact — only cv_parsed is overridable)", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "cand_verified_phone_block_01"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, {
    id: candidateId,
    source: "candidate",
    phoneE164: "+17867211987",
    phoneE164Source: "sms_bind", // a real verified phone, NOT a résumé guess
  })
  const db = fakeDb as unknown as Firestore

  const code = await issueBindCode(db, candidateId)
  const resolved = await resolveInboundUserId(db, "+17869150039", buildBindCodeOpenerBody(code))
  // Different VERIFIED phone → different entity → falls to phone lookup → null. No hijack.
  assert.equal(resolved, null, "a verified differing phone must NOT be cross-bound")
})

test("a REUSED bind code (different phone) does NOT bind a wrong account → falls to phone lookup (null)", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "cand_bindcode_reuse_01"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore

  const code = await issueBindCode(db, candidateId)
  // First use from phone A binds.
  assert.equal(await resolveInboundUserId(db, "+14155550222", buildBindCodeOpenerBody(code)), candidateId)
  // A DIFFERENT phone presents the same (now-used) code → code_used → no token
  // bind → resolve by THAT phone (unknown) → null. Never the wrong account.
  const resolved = await resolveInboundUserId(db, "+14155550333", buildBindCodeOpenerBody(code))
  assert.equal(resolved, null)
})

test("an UNKNOWN bind code → no bind, falls through to phone lookup (null), never throws", async () => {
  const fakeDb = new FakeFirestore()
  const db = fakeDb as unknown as Firestore
  // "ABCD2345" is a valid SHAPE but was never minted.
  const resolved = await resolveInboundUserId(db, "+14155550444", buildBindCodeOpenerBody("ABCD2345"))
  assert.equal(resolved, null)
})

test("a CORRUPTED bind code (excluded glyph) → no match, no wrong bind (null)", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "cand_bindcode_corrupt_01"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore
  const code = await issueBindCode(db, candidateId)
  // Corrupt one char into an EXCLUDED glyph (O). The opener prefix is preserved.
  const corruptedOpener = buildBindCodeOpenerBody(code).slice(0, -1) + "O"
  const resolved = await resolveInboundUserId(db, "+14155550555", corruptedOpener)
  assert.equal(resolved, null)
  // The real code is still unused (the corrupted form never matched it).
  const codeSnap = await db.collection(PA_COLLECTIONS.bindCodes).doc(code).get()
  assert.equal(codeSnap.data()?.used, false)
})

test("LEGACY raw-uid opener still binds (back-compat) — uids are never bind codes", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "aBcD1eFgH2iJkLmNoPqR" // 20-char push-id-like uid
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore
  // Legacy verification-code opener carrying the raw uid.
  const opener = `Hi, WeKruit, my verification code is ${candidateId}`
  const resolved = await resolveInboundUserId(db, "+14155550666", opener)
  assert.equal(resolved, candidateId)
})

// ──────── bind code embedded in the PRESCREEN JOB token (2026-06-14) ─────────
// The WEBSITE-FIRST candidate (registered on /j/:jobId, has a candidateId, phone
// NOT yet bound to that web account) pastes `WeKruit_<jobId>_<bindCode>_Job`. The
// bind code is the web→phone IDENTITY BRIDGE: first text binds the texted phone
// to the EXISTING web profile (resume/tags intact), never spawns a duplicate.

test("TEST 1 — web-registered unbound phone + WeKruit_<job>_<bindCode>_Job → resolves bindCode→candidateId, BINDS the phone (no duplicate account)", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "web_first_unbound_01"
  // The web profile exists (resume/tags), but has NO phone yet.
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, {
    id: candidateId,
    source: "candidate",
    tags: { skills: ["typescript", "react"] },
  })
  const db = fakeDb as unknown as Firestore

  const code = await issueBindCode(db, candidateId)
  const token = `WeKruit_hs-10996795-invoko-product-manager_${code}_Job`
  const resolved = await resolveInboundUserId(db, "+19196855995", token)
  assert.equal(resolved, candidateId, "resolves to the EXISTING web candidate, not a new prospect")

  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(userSnap.data()?.phoneE164, "+19196855995", "texted phone now bound to the web profile")
  // Resume/tags preserved (no clobber, no split entity).
  assert.deepEqual((userSnap.data()?.tags as Record<string, unknown>).skills, ["typescript", "react"])
  const codeSnap = await db.collection(PA_COLLECTIONS.bindCodes).doc(code).get()
  assert.equal(codeSnap.data()?.used, true, "bind code consumed (single-use)")
})

test("TEST 2 — repeat paste (3×) of the same bindCode job token → ONE bind, idempotent (consumed code, then phone-is-auth)", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "web_first_unbound_idem_01"
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore

  const code = await issueBindCode(db, candidateId)
  const token = `WeKruit_hs-10996795-invoko-product-manager_${code}_Job`

  // The 3 repeated weekend pastes (+19196855995 pasted the token 3×).
  for (const _attempt of [1, 2, 3]) {
    const resolved = await resolveInboundUserId(db, "+19196855995", token)
    assert.equal(resolved, candidateId, "every paste resolves to the SAME web candidate")
  }
  // Still exactly one account holds the phone (no duplicate from re-paste).
  const all = await db
    .collection(PA_COLLECTIONS.users)
    .where("phoneE164", "==", "+19196855995")
    .get()
  assert.equal(all.docs.length, 1, "exactly ONE account bound to the phone after 3 pastes")
  assert.equal(all.docs[0]!.id, candidateId)
})

test("TEST 4 — legacy uid embedded in the job token still binds (back-compat)", async () => {
  const fakeDb = new FakeFirestore()
  const candidateId = "aBcD1eFgH2iJkLmNoPqZ" // 20-char push-id-like uid (not bind-code shape)
  fakeDb.seed(PA_COLLECTIONS.users, candidateId, { id: candidateId, source: "candidate" })
  const db = fakeDb as unknown as Firestore

  const resolved = await resolveInboundUserId(db, "+14155551212", `WeKruit_photon-macos-devops_${candidateId}_Job`)
  assert.equal(resolved, candidateId)
  const userSnap = await db.collection(PA_COLLECTIONS.users).doc(candidateId).get()
  assert.equal(userSnap.data()?.phoneE164, "+14155551212")
})

test("TEST 5 — UNKNOWN bindCode in the job token + unbound phone → no bind, no duplicate account (null → caller surfaces graceful notice)", async () => {
  const fakeDb = new FakeFirestore()
  const db = fakeDb as unknown as Firestore
  // Valid SHAPE but never minted (e.g. expired then GC'd, or a stale link).
  const token = "WeKruit_hs-10996795-invoko-product-manager_ABCD2345_Job"
  const resolved = await resolveInboundUserId(db, "+14155559999", token)
  assert.equal(resolved, null, "unknown code → no bind; phone unresolved → null (graceful-notice path)")
  // No account was created or bound to the phone.
  const all = await db
    .collection(PA_COLLECTIONS.users)
    .where("phoneE164", "==", "+14155559999")
    .get()
  assert.equal(all.docs.length, 0, "no duplicate/new account created from an unknown code")
})
