import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { runCandidateMagicLinkVerify } from "../candidate-magic-link-verify.js"

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
  // Identity hardening 2026-05-21 — `allowCreate: false` because the test
  // mocks verifyIdToken without signInProvider, which the runtime treats
  // as the email-magic-link path (claim-only). The mock claimProfile
  // returns success regardless, so the assertion below only documents
  // the value the runtime now passes through.
  assert.deepEqual(calls[0], {
    firebaseUid: "firebase-1",
    email: "person@example.com",
    browserUid: "browser-1",
    displayName: "Candidate One",
    allowCreate: false,
  })
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
    assert.match(String(result.linkedinUrl), /oauth-linked\/sub-99/)
  }
  assert.equal(linkCalls.length, 1)
  assert.equal(linkCalls[0]?.value, "https://www.linkedin.com/oauth-linked/sub-99")

  const userSnap = await db.collection(PA_COLLECTIONS.users).doc("cand-li").get()
  assert.equal(userSnap.data()?.linkedinOauthLinked, true)
})

test("runCandidateMagicLinkVerify allows wekruit.com workspace emails at public launch", async () => {
  const db = fakeDb()
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-1" },
    undefined,
    {
      db,
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

// ---------- Identity hardening 2026-05-21 (L1-entry gate) -----------------

test("runCandidateMagicLinkVerify allows create when signInProvider=google.com (Gmail OAuth = L1 entry)", async () => {
  const calls: Array<Record<string, unknown>> = []
  const db = fakeDb()
  const { result, status } = await runCandidateMagicLinkVerify(
    {
      firebaseIdToken: "token-google",
      browserUid: "browser-google",
    },
    undefined,
    {
      db,
      verifyIdToken: async () => ({
        uid: "firebase-google-1",
        email: "newperson@gmail.com",
        email_verified: true,
        signInProvider: "google.com",
      }),
      claimProfile: async (_db, input) => {
        calls.push({ ...input })
        return {
          candidateId: "cand-google-1",
          authMapping: {
            firebaseUid: "firebase-google-1",
            candidateId: "cand-google-1",
            createdAt: "2026-05-21T00:00:00.000Z",
          },
          emailHandle: {
            handleId: "email_hash",
            candidateId: "cand-google-1",
            kind: "email" as const,
            handleHash: "hashhashhashhash",
            source: "candidate" as const,
            createdAt: "2026-05-21T00:00:00.000Z",
          },
          claimedEventId: "ident_claimed",
          idempotent: false,
          selfProfile: {
            candidateId: "cand-google-1",
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
  assert.equal(calls[0]?.allowCreate, true, "Google OAuth path must allow pa-users creation")
})

test("runCandidateMagicLinkVerify rejects email-link claim when email has no existing handle (requires_l1_signup)", async () => {
  const db = fakeDb()
  const { result, status } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-unknown" },
    undefined,
    {
      db,
      verifyIdToken: async () => ({
        uid: "firebase-unknown",
        email: "stranger@example.com",
        email_verified: true,
        signInProvider: "password",
      }),
      claimProfile: async () => {
        // Simulate what real claimCandidateProfile does when allowCreate=false
        // and the email is not yet in pa-candidate-handles.
        throw new Error("requires_l1_signup:no_existing_handle")
      },
    }
  )

  assert.equal(status, 404, "404 surfaces the L1-signup-required gate to the client")
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, "requires_l1_signup")
  }
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
      verifyIdToken: async () => ({
        uid: "li_xyz789",
        email: "person@linkedin.com",
        email_verified: true,
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

  assert.equal(calls[0]?.allowCreate, true, "LinkedIn OAuth path must allow pa-users creation")
})
