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

  assert.equal(
    calls[0]?.allowCreate,
    undefined,
    "LinkedIn OAuth path passes through the default (allowCreate=true via the persistence layer)",
  )
})

test("runCandidateMagicLinkVerify stamps layoffhedge on first-time pa-users create", async () => {
  const db = fakeDb()
  const { status, result } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-1", source: "layoffhedge" },
    undefined,
    {
      db,
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
