import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  runCandidateMagicLinkVerify,
  type CandidateMagicLinkVerifyDeps,
} from "../candidate-magic-link-verify.js"

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
  private readonly store: Store = new Map()

  collection(path: string) {
    return new FakeCollection(this.store, path)
  }

  seed(path: string, id: string, data: DocData) {
    new FakeDocRef(this.store, path, id).set(data)
  }
}

function fakeDb(): Firestore {
  return new FakeFirestore() as unknown as Firestore
}

const REFERRAL_TEST_DEPS = {
  attachReferralOnSignup: async () => ({}),
} satisfies Pick<CandidateMagicLinkVerifyDeps, "attachReferralOnSignup">

test("runCandidateMagicLinkVerify claims profile for verified email", async () => {
  const calls: Array<Record<string, unknown>> = []
  const db = fakeDb()
  const { result, status } = await runCandidateMagicLinkVerify(
    {
      firebaseIdToken: "token-1",
      browserUid: "browser-1",
      displayName: "Candidate One",
    },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "firebase-1",
        email: "Person@Example.COM",
        email_verified: true,
        name: "Candidate One",
      }),
      claimProfile: async (_db, input) => {
        calls.push({ ...input })
        return {
          candidateId: "cand-1",
          authMapping: {
            firebaseUid: "firebase-1",
            candidateId: "cand-1",
            createdAt: "2026-05-20T00:00:00.000Z",
          },
          emailHandle: {
            handleId: "email_hash",
            candidateId: "cand-1",
            kind: "email" as const,
            handleHash: "hashhashhashhash",
            source: "candidate" as const,
            createdAt: "2026-05-20T00:00:00.000Z",
          },
          claimedEventId: "ident_claimed",
          idempotent: false,
          selfProfile: {
            candidateId: "cand-1",
            lifecycleState: "claimed" as const,
            handles: [{ kind: "email" as const, source: "candidate" as const }],
            createdAt: "2026-05-20T00:00:00.000Z",
          },
        }
      },
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    }
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.candidateId, "cand-1")
    assert.equal(result.idempotent, false)
    assert.equal(result.intakeComplete, false)
    assert.equal(result.claireConversationStarted, false)
    assert.equal(result.hasResumeOnFile, false)
    assert.equal(result.portalReady, false)
    assert.equal(result.linkedinLinkedViaOauth, false)
  }
  // Adam directive 2026-05-21 — magic-link is a first-class L1 entry, so
  // the runtime no longer overrides claimCandidateProfile's default
  // `allowCreate=true`. We don't forward an `allowCreate` field.
  assert.deepEqual(calls[0], {
    firebaseUid: "firebase-1",
    email: "person@example.com",
    browserUid: "browser-1",
    displayName: "Candidate One",
  })
})

test("runCandidateMagicLinkVerify forwards stored referral slug after verified signup", async () => {
  const referralCalls: Array<Record<string, unknown>> = []
  const db = fakeDb()
  const { result, status } = await runCandidateMagicLinkVerify(
    {
      firebaseIdToken: "token-ref",
      referralSlug: "Maya-Chen",
    },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "firebase-ref",
        email: "ReferralUser@Example.COM",
        email_verified: true,
        name: "Referral User",
      }),
      claimProfile: async () => ({
        candidateId: "cand-ref",
        authMapping: {
          firebaseUid: "firebase-ref",
          candidateId: "cand-ref",
          createdAt: "2026-05-29T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-ref",
          kind: "email" as const,
          handleHash: "hashhashhashhash",
          source: "candidate" as const,
          createdAt: "2026-05-29T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: false,
        selfProfile: {
          candidateId: "cand-ref",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-29T00:00:00.000Z",
        },
      }),
      attachReferralOnSignup: async (args) => {
        referralCalls.push({ ...args })
        return { matchedReferralId: "link_maya-chen_test" }
      },
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    }
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  assert.deepEqual(referralCalls, [
    {
      uid: "cand-ref",
      email: "referraluser@example.com",
      referralSlug: "Maya-Chen",
    },
  ])
})

test("runCandidateMagicLinkVerify returns sticky sender number for the canonical candidate", async () => {
  const calls: Array<{ candidateId: string; userData: Record<string, unknown> | null }> = []
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-1", {
    intakeCompletedAt: "2026-05-21T00:00:00.000Z",
  })
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-1" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "firebase-1",
        email: "person@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-1",
        authMapping: {
          firebaseUid: "firebase-1",
          candidateId: "cand-1",
          createdAt: "2026-05-21T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-1",
          kind: "email" as const,
          handleHash: "hashhashhashhash",
          source: "candidate" as const,
          createdAt: "2026-05-21T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-1",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-21T00:00:00.000Z",
        },
      }),
      assignSenderNumber: async (_db, candidateId, userData) => {
        calls.push({ candidateId, userData })
        return { senderNumber: "+17174919939", senderGroupId: "public" }
      },
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    }
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.candidateId, "cand-1")
  assert.equal(calls[0]?.userData?.intakeCompletedAt, "2026-05-21T00:00:00.000Z")
  if (result.ok) {
    assert.equal(result.senderNumber, "+17174919939")
    assert.equal(result.senderGroupId, "public")
  }
})

test("runCandidateMagicLinkVerify links LinkedIn OAuth identity for li_* uid", async () => {
  const linkCalls: Array<Record<string, unknown>> = []
  const db = fakeDb()
  const { result, status } = await runCandidateMagicLinkVerify(
    {
      firebaseIdToken: "token-li",
      linkedinSignIn: true,
    },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "li_abc123",
        email: "person@example.com",
        email_verified: true,
        linkedinSub: "sub-99",
      }),
      claimProfile: async () => ({
        candidateId: "cand-li",
        authMapping: {
          firebaseUid: "li_abc123",
          candidateId: "cand-li",
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-li",
          kind: "email" as const,
          handleHash: "hashhashhashhash",
          source: "candidate" as const,
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: false,
        selfProfile: {
          candidateId: "cand-li",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      }),
      linkLinkedin: async (_db, input) => {
        linkCalls.push({ ...input })
        return {
          handle: {
            handleId: `linkedin__${input.value}`,
            handleHash: "test-hash",
            kind: "linkedin" as const,
            valueLast4: input.value.slice(-4),
            source: input.source ?? "candidate",
            verified: input.verified ?? false,
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z",
          } as never,
          created: true,
        }
      },
      hasResumeOnFile: async () => false,
    }
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.candidateId, "cand-li")
    assert.equal(result.linkedinLinkedViaOauth, true)
    assert.equal(result.linkedinUrl, null)
  }
  assert.equal(linkCalls.length, 1)
  assert.equal(linkCalls[0]?.value, "https://www.linkedin.com/oauth-linked/sub-99")

  const userSnap = await db.collection(PA_COLLECTIONS.users).doc("cand-li").get()
  assert.equal(userSnap.data()?.linkedinOauthLinked, true)
  assert.equal("linkedinUrl" in (userSnap.data() ?? {}), false)
})

test("runCandidateMagicLinkVerify allows wekruit.com workspace emails at public launch", async () => {
  const db = fakeDb()
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-1" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "firebase-admin",
        email: "admin1@wekruit.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-admin",
        authMapping: {
          firebaseUid: "firebase-admin",
          candidateId: "cand-admin",
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-admin",
          kind: "email" as const,
          handleHash: "hashhashhashhash",
          source: "candidate" as const,
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-admin",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      }),
      hasResumeOnFile: async () => false,
    }
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.candidateId, "cand-admin")
    assert.equal(result.idempotent, true)
    assert.equal(result.claireConversationStarted, false)
  }
})

test("runCandidateMagicLinkVerify reports portalReady when Claire inbound exists", async () => {
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-claire", {
    intakeCompletedAt: "2026-05-19T00:00:00.000Z",
    phoneE164: "+14155550100",
    latestResumeArtifactId: "artifact-1",
  })
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-claire" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "firebase-claire",
        email: "claire@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-claire",
        authMapping: {
          firebaseUid: "firebase-claire",
          candidateId: "cand-claire",
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-claire",
          kind: "email" as const,
          handleHash: "hashhashhashhash",
          source: "candidate" as const,
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-claire",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => true,
      hasResumeOnFile: async () => true,
    },
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.intakeComplete, true)
    assert.equal(result.claireConversationStarted, true)
    assert.equal(result.hasResumeOnFile, true)
    assert.equal(result.portalReady, true)
  }
})

test("runCandidateMagicLinkVerify keeps portalReady false without Claire inbound", async () => {
  const db = fakeDb()
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-claire" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "firebase-claire",
        email: "claire@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-claire",
        authMapping: {
          firebaseUid: "firebase-claire",
          candidateId: "cand-claire",
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-claire",
          kind: "email" as const,
          handleHash: "hashhashhashhash",
          source: "candidate" as const,
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-claire",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => true,
    },
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.claireConversationStarted, false)
    assert.equal(result.hasResumeOnFile, true)
    assert.equal(result.portalReady, false)
  }
})

test("runCandidateMagicLinkVerify reports claireConversationStarted from Claire gate", async () => {
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-claire", {
    intakeCompletedAt: "2026-05-19T00:00:00.000Z",
    phoneE164: "+14155550100",
  })
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-claire" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "firebase-claire",
        email: "claire@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-claire",
        authMapping: {
          firebaseUid: "firebase-claire",
          candidateId: "cand-claire",
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-claire",
          kind: "email" as const,
          handleHash: "hashhashhashhash",
          source: "candidate" as const,
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-claire",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => true,
      hasResumeOnFile: async () => false,
    },
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.intakeComplete, true)
    assert.equal(result.claireConversationStarted, true)
    assert.equal(result.hasResumeOnFile, false)
    assert.equal(result.portalReady, false)
  }
})

// ---------- Phone-code-verified Claire thread = portal-ready (2026-06-11) --

test("runCandidateMagicLinkVerify reports portalReady for phone-linked Claire users without a resume", async () => {
  // Adam 2026-06-11: a verified phone link to an existing Claire thread IS
  // proof of onboarding via chat — a resume must not gate the portal.
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-claire", {
    phoneE164: "+14155550100",
    phoneE164Source: "phone_code_verified_claire_thread",
    phoneLinkedAt: "2026-06-10T00:00:00.000Z",
  })
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-claire" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "firebase-claire",
        email: "claire@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-claire",
        authMapping: {
          firebaseUid: "firebase-claire",
          candidateId: "cand-claire",
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-claire",
          kind: "email" as const,
          handleHash: "hashhashhashhash",
          source: "candidate" as const,
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-claire",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => true,
      hasResumeOnFile: async () => false,
    },
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.claireConversationStarted, true)
    assert.equal(result.hasResumeOnFile, false)
    assert.equal(result.portalReady, true)
  }
})

test("runCandidateMagicLinkVerify keeps portalReady false for phone-linked users without Claire inbound", async () => {
  // Phone link alone is not enough — readiness still requires the Claire
  // conversation gate.
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-claire", {
    phoneE164: "+14155550100",
    phoneE164Source: "phone_code_verified_claire_thread",
    phoneLinkedAt: "2026-06-10T00:00:00.000Z",
  })
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-claire" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "firebase-claire",
        email: "claire@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-claire",
        authMapping: {
          firebaseUid: "firebase-claire",
          candidateId: "cand-claire",
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-claire",
          kind: "email" as const,
          handleHash: "hashhashhashhash",
          source: "candidate" as const,
          createdAt: "2026-05-20T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-claire",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-20T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    },
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.portalReady, false)
  }
})

// ---------- Identity hardening 2026-05-21 (L1-entry gate) -----------------

test("runCandidateMagicLinkVerify creates account for unknown email (magic-link is a first-class L1 entry)", async () => {
  // Adam directive 2026-05-21 — magic-link with an unknown email behaves
  // exactly like first-time Gmail OAuth: claim/create a fresh pa-users.
  // No L1-entry gate, no `allowCreate` forwarded from the CF — the
  // default behavior of claimCandidateProfile is sufficient.
  const calls: Array<Record<string, unknown>> = []
  const db = fakeDb()
  const { result, status } = await runCandidateMagicLinkVerify(
    {
      firebaseIdToken: "token-newuser",
      browserUid: "browser-newuser",
    },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "firebase-newuser-1",
        email: "freshperson@example.com",
        email_verified: true,
        signInProvider: "password",
      }),
      claimProfile: async (_db, input) => {
        calls.push({ ...input })
        return {
          candidateId: "cand-newuser-1",
          authMapping: {
            firebaseUid: "firebase-newuser-1",
            candidateId: "cand-newuser-1",
            createdAt: "2026-05-21T00:00:00.000Z",
          },
          emailHandle: {
            handleId: "email_hash",
            candidateId: "cand-newuser-1",
            kind: "email" as const,
            handleHash: "hashhashhashhash",
            source: "candidate" as const,
            createdAt: "2026-05-21T00:00:00.000Z",
          },
          claimedEventId: "ident_claimed",
          idempotent: false,
          selfProfile: {
            candidateId: "cand-newuser-1",
            lifecycleState: "claimed" as const,
            handles: [{ kind: "email" as const, source: "candidate" as const }],
            createdAt: "2026-05-21T00:00:00.000Z",
          },
        }
      },
      hasResumeOnFile: async () => false,
    }
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  assert.equal(calls[0]?.allowCreate, undefined, "CF does not override claimProfile default (allowCreate=true)")
})

test("runCandidateMagicLinkVerify still passes allowCreate=true when LinkedIn custom-token path is used", async () => {
  const calls: Array<Record<string, unknown>> = []
  const db = fakeDb()
  await runCandidateMagicLinkVerify(
    {
      firebaseIdToken: "token-li-2",
      linkedinSignIn: true,
    },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "li_xyz789",
        linkedinEmail: "person@linkedin.com",
        linkedinSub: "sub-77",
      }),
      claimProfile: async (_db, input) => {
        calls.push({ ...input })
        return {
          candidateId: "cand-li-2",
          authMapping: {
            firebaseUid: "li_xyz789",
            candidateId: "cand-li-2",
            createdAt: "2026-05-21T00:00:00.000Z",
          },
          emailHandle: {
            handleId: "email_hash",
            candidateId: "cand-li-2",
            kind: "email" as const,
            handleHash: "hashhashhashhash",
            source: "candidate" as const,
            createdAt: "2026-05-21T00:00:00.000Z",
          },
          claimedEventId: "ident_claimed",
          idempotent: false,
          selfProfile: {
            candidateId: "cand-li-2",
            lifecycleState: "claimed" as const,
            handles: [{ kind: "email" as const, source: "candidate" as const }],
            createdAt: "2026-05-21T00:00:00.000Z",
          },
        }
      },
      linkLinkedin: async () => ({
        handle: {
          handleId: "linkedin_hash",
          handleHash: "hashhash",
          kind: "linkedin" as const,
          source: "candidate" as const,
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z",
        } as never,
        created: true,
      }),
      hasResumeOnFile: async () => false,
    }
  )

  assert.equal(
    calls[0]?.allowCreate,
    undefined,
    "LinkedIn OAuth path passes through the default (allowCreate=true via the persistence layer)",
  )
  assert.equal(calls[0]?.email, "person@linkedin.com")
})

test("runCandidateMagicLinkVerify stamps layoffhedge on first-time pa-users create", async () => {
  const db = fakeDb()
  const { status, result } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-1", source: "layoffhedge" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "fb-1",
        email: "new.layoffhedge@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-lh-1",
        authMapping: {
          firebaseUid: "fb-1",
          candidateId: "cand-lh-1",
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-lh-1",
          kind: "email" as const,
          handleHash: "h",
          source: "candidate" as const,
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: false,
        selfProfile: {
          candidateId: "cand-lh-1",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-27T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    },
  )
  assert.equal(status, 200)
  assert.equal(result.ok, true)

  const snap = await db.collection(PA_COLLECTIONS.users).doc("cand-lh-1").get()
  assert.equal((snap.data() as { source?: string } | undefined)?.source, "layoffhedge")
})

test("runCandidateMagicLinkVerify stamps YC Startup School and returns known profile summary", async () => {
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-yc-1", {
    candidateContext: { jobTitle: "Founder", lastCompany: "Tiny AI" },
    linkedinUrl: "https://linkedin.com/in/founder",
  })

  const { status, result } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-yc", source: "yc_startup_school" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "fb-yc",
        email: "founder@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-yc-1",
        authMapping: {
          firebaseUid: "fb-yc",
          candidateId: "cand-yc-1",
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-yc-1",
          kind: "email" as const,
          handleHash: "h",
          source: "candidate" as const,
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: false,
        selfProfile: {
          candidateId: "cand-yc-1",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-27T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    },
  )

  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.profileSummary, "Founder at Tiny AI")
    assert.equal(result.hasExistingProfileInfo, true)
    assert.equal(result.linkedinUrl, "https://linkedin.com/in/founder")
  }
  const snap = await db.collection(PA_COLLECTIONS.users).doc("cand-yc-1").get()
  assert.equal((snap.data() as { source?: string } | undefined)?.source, "yc_startup_school")
})

test("runCandidateMagicLinkVerify does NOT overwrite an existing pa-users.source", async () => {
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-lh-2", {
    source: "candidate",
    createdAt: "2026-04-01T00:00:00.000Z",
  })

  const { status, result } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-2", source: "layoffhedge" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "fb-2",
        email: "returning@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-lh-2",
        authMapping: {
          firebaseUid: "fb-2",
          candidateId: "cand-lh-2",
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-lh-2",
          kind: "email" as const,
          handleHash: "h",
          source: "candidate" as const,
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-lh-2",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-27T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    },
  )
  assert.equal(status, 200)
  assert.equal(result.ok, true)

  const snap = await db.collection(PA_COLLECTIONS.users).doc("cand-lh-2").get()
  assert.equal(
    (snap.data() as { source?: string } | undefined)?.source,
    "candidate",
    "returning user must keep first-stamped source",
  )
})

test("runCandidateMagicLinkVerify stamps first signup entry for public job sign-in", async () => {
  const db = fakeDb()
  const { status, result } = await runCandidateMagicLinkVerify(
    {
      firebaseIdToken: "token-job-entry",
      source: "candidate",
      registrationEntry: {
        kind: "job_prescreen",
        path: "/j/wekruit-37429d02-photon-macos-devops",
        jobId: "wekruit-37429d02-photon-macos-devops",
      },
    },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "fb-job-entry",
        email: "job.entry@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-job-entry",
        authMapping: {
          firebaseUid: "fb-job-entry",
          candidateId: "cand-job-entry",
          createdAt: "2026-05-30T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-job-entry",
          kind: "email" as const,
          handleHash: "h",
          source: "candidate" as const,
          createdAt: "2026-05-30T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: false,
        selfProfile: {
          candidateId: "cand-job-entry",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-30T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    },
  )
  assert.equal(status, 200)
  assert.equal(result.ok, true)

  const snap = await db.collection(PA_COLLECTIONS.users).doc("cand-job-entry").get()
  const data = snap.data() as { firstSignupEntry?: Record<string, unknown>; lastSignupEntry?: Record<string, unknown> } | undefined
  assert.equal(data?.firstSignupEntry?.kind, "job_prescreen")
  assert.equal(data?.firstSignupEntry?.path, "/j/wekruit-37429d02-photon-macos-devops")
  assert.equal(data?.firstSignupEntry?.jobId, "wekruit-37429d02-photon-macos-devops")
  assert.equal(data?.firstSignupEntry?.source, "candidate")
  assert.equal(typeof data?.firstSignupEntry?.capturedAt, "string")
  assert.deepEqual(data?.lastSignupEntry, data?.firstSignupEntry)
})

test("runCandidateMagicLinkVerify keeps original first signup entry on later sign-ins", async () => {
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-job-returning", {
    firstSignupEntry: {
      kind: "job_prescreen",
      path: "/j/wekruit-original-job",
      jobId: "wekruit-original-job",
      source: "candidate",
      capturedAt: "2026-05-01T00:00:00.000Z",
    },
  })

  const { status, result } = await runCandidateMagicLinkVerify(
    {
      firebaseIdToken: "token-job-returning",
      source: "candidate",
      registrationEntry: {
        kind: "job_prescreen",
        path: "/j/wekruit-later-job",
        jobId: "wekruit-later-job",
      },
    },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "fb-job-returning",
        email: "job.returning@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-job-returning",
        authMapping: {
          firebaseUid: "fb-job-returning",
          candidateId: "cand-job-returning",
          createdAt: "2026-05-30T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-job-returning",
          kind: "email" as const,
          handleHash: "h",
          source: "candidate" as const,
          createdAt: "2026-05-30T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-job-returning",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-30T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    },
  )
  assert.equal(status, 200)
  assert.equal(result.ok, true)

  const snap = await db.collection(PA_COLLECTIONS.users).doc("cand-job-returning").get()
  const data = snap.data() as { firstSignupEntry?: Record<string, unknown>; lastSignupEntry?: Record<string, unknown> } | undefined
  assert.equal(data?.firstSignupEntry?.path, "/j/wekruit-original-job")
  assert.equal(data?.lastSignupEntry?.path, "/j/wekruit-later-job")
  assert.equal(data?.lastSignupEntry?.jobId, "wekruit-later-job")
})

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY-UX-PRD §2.3.3 — website-origin entry event seam (Builder A)
// ─────────────────────────────────────────────────────────────────────────────

function claimBlobFor(candidateId: string, firebaseUid: string) {
  return async () => ({
    candidateId,
    authMapping: { firebaseUid, candidateId, createdAt: "2026-06-12T00:00:00.000Z" },
    emailHandle: {
      handleId: "email_hash",
      candidateId,
      kind: "email" as const,
      handleHash: "h",
      source: "candidate" as const,
      createdAt: "2026-06-12T00:00:00.000Z",
    },
    claimedEventId: "ident_claimed",
    idempotent: true,
    selfProfile: {
      candidateId,
      lifecycleState: "claimed" as const,
      handles: [{ kind: "email" as const, source: "candidate" as const }],
      createdAt: "2026-06-12T00:00:00.000Z",
    },
  })
}

test("verify emits the website entry with a per-login-flow id and the §2.4 state", async () => {
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-entry", {
    pitchedAt: "2026-06-01T00:00:00.000Z",
  })
  const entryCalls: Array<{ state: Record<string, unknown>; opts: Record<string, unknown> }> = []
  const { result, status } = await runCandidateMagicLinkVerify(
    {
      firebaseIdToken: "token-entry",
      source: "candidate",
      registrationEntry: { kind: "job_prescreen", path: "/j/wekruit-demo-job", jobId: "wekruit-demo-job" },
    },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "fb-entry",
        email: "entry@example.com",
        email_verified: true,
        signInProvider: "google.com",
        authTime: 1765432100,
      }),
      claimProfile: claimBlobFor("cand-entry", "fb-entry"),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => true,
      processWebsiteEntry: (async (_db: unknown, state: never, opts: never) => {
        entryCalls.push({ state, opts })
        return { recorded: true, emitted: true, pendingEmit: false }
      }) as never,
    },
  )
  assert.equal(status, 200)
  assert.equal(result.ok, true)
  assert.equal(entryCalls.length, 1)
  const { state, opts } = entryCalls[0]!
  assert.equal(state.candidateId, "cand-entry")
  assert.equal(state.authProvider, "google")
  assert.equal(state.resumeStatus, "parsed")
  assert.equal(state.jobIdContext, "wekruit-demo-job")
  assert.equal(state.pitchAlreadySent, true)
  assert.equal(opts.flowId, "login:1765432100")
  assert.equal(opts.source, "candidate_verify")
  assert.equal(opts.newEvidence, false)
})

test("verify skips the entry event without auth_time (no nowIso/content-hash fallback)", async () => {
  const db = fakeDb()
  const entryCalls: unknown[] = []
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-noauthtime" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "fb-nat",
        email: "nat@example.com",
        email_verified: true,
      }),
      claimProfile: claimBlobFor("cand-nat", "fb-nat"),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => true,
      processWebsiteEntry: (async (...args: unknown[]) => {
        entryCalls.push(args)
        return { recorded: true, emitted: false, pendingEmit: false }
      }) as never,
    },
  )
  assert.equal(status, 200)
  assert.equal(result.ok, true)
  assert.equal(entryCalls.length, 0)
})

test("verify entry-event failure never breaks sign-in", async () => {
  const db = fakeDb()
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-entry-fail" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "fb-ef",
        email: "ef@example.com",
        email_verified: true,
        authTime: 99,
      }),
      claimProfile: claimBlobFor("cand-ef", "fb-ef"),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
      processWebsiteEntry: (async () => {
        throw new Error("boom")
      }) as never,
    },
  )
  assert.equal(status, 200)
  assert.equal(result.ok, true)
})

test("LinkedIn OAuth login with the OIDC profile claim links the CANONICAL url, not the marker", async () => {
  const db = fakeDb()
  const linkCalls: Array<Record<string, unknown>> = []
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-li-real", linkedinSignIn: true },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "li_real",
        email: "real@example.com",
        email_verified: true,
        linkedinSub: "sub-real",
        linkedinProfileUrl: "https://www.linkedin.com/in/real-person/",
        linkedinPicture: "https://media.licdn.com/dms/image/v2/abc/profile.jpg",
        authTime: 1765432200,
      }),
      claimProfile: claimBlobFor("cand-li-real", "li_real"),
      linkLinkedin: async (_db, input) => {
        linkCalls.push({ ...input })
        return { handle: {} as never, created: true }
      },
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
      processWebsiteEntry: (async () => ({ recorded: true, emitted: false, pendingEmit: false })) as never,
    },
  )
  assert.equal(status, 200)
  assert.equal(result.ok, true)
  assert.equal(linkCalls.length, 1)
  const linked = String(linkCalls[0]?.value ?? "")
  assert.ok(!linked.includes("/oauth-linked/"), `expected canonical url, got ${linked}`)
  assert.ok(linked.includes("linkedin.com/in/real-person"), linked)
  const userSnap = await db.collection(PA_COLLECTIONS.users).doc("cand-li-real").get()
  const data = userSnap.data() as Record<string, unknown>
  assert.equal(data.linkedinOauthPicture, "https://media.licdn.com/dms/image/v2/abc/profile.jpg")
  assert.equal(data.linkedinOauthSub, "sub-real")
  if (result.ok) {
    assert.ok(String(result.linkedinUrl ?? "").includes("linkedin.com/in/real-person"))
  }
})

test("verify result exposes phoneLinkVerified for the Talk-to-Claire CTA decision", async () => {
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-plv", {
    phoneE164Source: "phone_code_verified_claire_thread",
  })
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-plv" },
    undefined,
    {
      db,
      ...REFERRAL_TEST_DEPS,
      verifyIdToken: async () => ({
        uid: "fb-plv",
        email: "plv@example.com",
        email_verified: true,
      }),
      claimProfile: claimBlobFor("cand-plv", "fb-plv"),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    },
  )
  assert.equal(status, 200)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.phoneLinkVerified, true)
  }
})
