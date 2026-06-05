import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  runCandidatePhoneLinkStart,
  runCandidatePhoneLinkVerify,
  type CandidatePhoneLinkDeps,
} from "./candidate-phone-link.js"

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

class FakeCollection {
  constructor(
    private readonly store: Store,
    readonly collectionPath: string,
  ) {}

  doc(id: string) {
    return new FakeDocRef(this.store, this.collectionPath, id)
  }
}

class FakeFirestore {
  readonly store: Store = new Map()

  collection(path: string) {
    return new FakeCollection(this.store, path)
  }

  read(path: string, id: string): DocData | undefined {
    return this.store.get(path)?.get(id)
  }

  seed(path: string, id: string, data: DocData) {
    const coll = this.store.get(path) ?? new Map()
    coll.set(id, data)
    this.store.set(path, coll)
  }
}

function fakeDb(): Firestore & { fake: FakeFirestore } {
  const fake = new FakeFirestore()
  return Object.assign(fake as unknown as Firestore, { fake })
}

function auth(uid = "firebase-1") {
  return {
    uid,
    token: {
      email: "Person@Example.com",
      email_verified: true,
      name: "Person One",
    },
  }
}

function baseDeps(db: Firestore): CandidatePhoneLinkDeps & {
  outbounds: Array<Record<string, unknown>>
  linked: Array<Record<string, unknown>>
  profiles: Array<Record<string, unknown>>
} {
  const outbounds: Array<Record<string, unknown>> = []
  const linked: Array<Record<string, unknown>> = []
  const profiles: Array<Record<string, unknown>> = []
  return {
    db,
    outbounds,
    linked,
    profiles,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
    requestId: () => "phone-link-req-1",
    code: () => "123456",
    loadCandidateByPhone: async (_db, phoneE164) => ({
      candidateId: "cand-phone",
      user: {
        id: "cand-phone",
        phoneE164,
        claireConversationStarted: true,
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }),
    claireConversationStarted: async () => true,
    enqueueOutbound: async (_db, input) => {
      outbounds.push({ ...input })
      return { id: "out_1", created: true }
    },
    linkCandidateHandle: async (_db, input) => {
      linked.push({ ...input })
      return {
        created: true,
        handle: {
          handleId: `${input.kind}_handle`,
          candidateId: input.candidateId,
          kind: input.kind,
          handleHash: `${input.kind}_hash_1234567890`,
          source: input.source,
          verifiedAt: input.verified ? "2026-06-05T00:00:00.000Z" : null,
          deliverable: input.deliverable,
          createdAt: "2026-06-05T00:00:00.000Z",
        },
      }
    },
    loadSelfProfileHandles: async () => [
      { kind: "phone", source: "candidate", verifiedAt: "2026-06-05T00:00:00.000Z" },
      { kind: "email", source: "candidate", verifiedAt: "2026-06-05T00:00:00.000Z" },
    ],
    writeCandidateSelfProfile: async (_db, input) => {
      profiles.push({ ...input })
      return {
        candidateId: input.candidateId,
        lifecycleState: "prospect",
        handles: input.handles ?? [],
        createdAt: input.now ?? "2026-06-05T00:00:00.000Z",
      }
    },
  }
}

test("runCandidatePhoneLinkStart sends a code only to an existing Claire phone thread", async () => {
  const db = fakeDb()
  const deps = baseDeps(db)

  const result = await runCandidatePhoneLinkStart({ phone: "(415) 555-0100" }, auth(), deps)

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.requestId, "phone-link-req-1")
    assert.equal(result.phoneMasked, "+14***00")
    assert.equal(result.expiresAt, "2026-06-05T00:10:00.000Z")
  }
  assert.equal(deps.outbounds.length, 1)
  assert.deepEqual(deps.outbounds[0], {
    userId: "cand-phone",
    toE164: "+14155550100",
    body: "WeKruit verification code: 123456. Use it to connect this web account to your Claire text thread. It expires in 10 minutes.",
    idempotencyKey: "candidate_phone_link:firebase-1:cand-phone:phone-link-req-1",
    runtimeApproved: true,
    runtimeSource: "pa_identity_notice",
  })
  const row = db.fake.read("pa-candidate-phone-link-verifications", "phone-link-req-1")
  assert.equal(row?.status, "pending")
  assert.equal(row?.candidateId, "cand-phone")
})

test("runCandidatePhoneLinkStart refuses phones without Claire inbound evidence", async () => {
  const db = fakeDb()
  const deps = baseDeps(db)
  deps.claireConversationStarted = async () => false

  const result = await runCandidatePhoneLinkStart({ phone: "+14155550100" }, auth(), deps)

  assert.deepEqual(result, {
    ok: false,
    reason: "no_claire_thread",
    message: "We could not find a Claire text thread for that phone. Use onboarding, or text Claire from that number first.",
  })
  assert.equal(deps.outbounds.length, 0)
})

test("runCandidatePhoneLinkVerify maps the signed-in account to the phone candidate", async () => {
  const db = fakeDb()
  const deps = baseDeps(db)
  await runCandidatePhoneLinkStart({ phone: "+14155550100" }, auth(), deps)
  db.fake.seed(PA_COLLECTIONS.users, "cand-phone", {
    id: "cand-phone",
    phoneE164: "+14155550100",
    claireConversationStarted: true,
    senderNumber: "+17174919939",
  })

  const result = await runCandidatePhoneLinkVerify(
    { requestId: "phone-link-req-1", code: "123456" },
    auth(),
    deps,
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.candidateId, "cand-phone")
    assert.equal(result.portalReady, true)
  }
  const authMapping = db.fake.read(PA_COLLECTIONS.candidateAuth, "firebase-1")
  assert.equal(authMapping?.candidateId, "cand-phone")
  assert.equal(authMapping?.emailHandleId, "email_handle")
  const user = db.fake.read(PA_COLLECTIONS.users, "cand-phone")
  assert.equal(user?.email, "person@example.com")
  assert.equal(user?.phoneE164Source, "phone_code_verified_claire_thread")
  assert.equal(deps.linked.length, 2)
  assert.equal(deps.linked[0]?.kind, "email")
  assert.equal(deps.linked[1]?.kind, "phone")
  assert.equal(deps.profiles[0]?.candidateId, "cand-phone")
})

test("runCandidatePhoneLinkVerify rejects an incorrect code and records attempts", async () => {
  const db = fakeDb()
  const deps = baseDeps(db)
  await runCandidatePhoneLinkStart({ phone: "+14155550100" }, auth(), deps)

  const result = await runCandidatePhoneLinkVerify(
    { requestId: "phone-link-req-1", code: "000000" },
    auth(),
    deps,
  )

  assert.deepEqual(result, {
    ok: false,
    reason: "invalid_code",
    message: "That code did not match. Check Claire's text and try again.",
  })
  const row = db.fake.read("pa-candidate-phone-link-verifications", "phone-link-req-1")
  assert.equal(row?.attempts, 1)
})

test("runCandidatePhoneLinkVerify fails closed when the Firebase uid is already mapped elsewhere", async () => {
  const db = fakeDb()
  const deps = baseDeps(db)
  await runCandidatePhoneLinkStart({ phone: "+14155550100" }, auth(), deps)
  db.fake.seed(PA_COLLECTIONS.users, "cand-phone", {
    id: "cand-phone",
    phoneE164: "+14155550100",
    claireConversationStarted: true,
  })
  db.fake.seed(PA_COLLECTIONS.candidateAuth, "firebase-1", {
    firebaseUid: "firebase-1",
    candidateId: "other-candidate",
    createdAt: "2026-06-01T00:00:00.000Z",
  })

  const result = await runCandidatePhoneLinkVerify(
    { requestId: "phone-link-req-1", code: "123456" },
    auth(),
    deps,
  )

  assert.deepEqual(result, {
    ok: false,
    reason: "auth_conflict",
    message: "This sign-in is already attached to another WeKruit profile. We need to review it.",
  })
  assert.equal(deps.linked.length, 0)
})
