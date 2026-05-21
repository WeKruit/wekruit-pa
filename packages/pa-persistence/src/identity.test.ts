import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  claimCandidateProfile,
  hashCandidateHandle,
  linkCandidateHandle,
  resolveCandidateIdentity,
  writeCandidateSelfProfile,
} from "./identity.js"

type Store = Map<string, Map<string, Record<string, unknown>>>

const now = "2026-05-13T12:00:00.000Z"

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  function col(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }

  let auto = 1
  function docRef(collectionName: string, id?: string) {
    const docId = id ?? `auto_${auto++}`
    return {
      id: docId,
      _collectionName: collectionName,
      _id: docId,
      async get() {
        const data = col(collectionName).get(docId)
        return { exists: data !== undefined, id: docId, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const current = col(collectionName).get(docId)
        col(collectionName).set(docId, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
    }
  }

  function collection(collectionName: string) {
    return {
      doc(id?: string) {
        return docRef(collectionName, id)
      },
      where(field: string, _op: string, value: unknown) {
        return {
          limit() {
            return {
              async get() {
                const docs = Array.from(col(collectionName).entries())
                  .filter(([, data]) => data[field] === value)
                  .map(([id, data]) => ({ id, data: () => data }))
                return { empty: docs.length === 0, docs }
              },
            }
          },
        }
      },
    }
  }

  const db = {
    collection,
    async runTransaction<T>(fn: (tx: {
      get: (ref: ReturnType<typeof docRef>) => Promise<{ exists: boolean; id: string; data: () => Record<string, unknown> | undefined }>
      set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>, opts?: { merge?: boolean }) => void
    }) => Promise<T>): Promise<T> {
      const writes: Array<{ ref: ReturnType<typeof docRef>; data: Record<string, unknown>; opts?: { merge?: boolean } }> = []
      const tx = {
        async get(ref: ReturnType<typeof docRef>) {
          const data = col(ref._collectionName).get(ref._id)
          return { exists: data !== undefined, id: ref._id, data: () => data }
        },
        set(ref: ReturnType<typeof docRef>, data: Record<string, unknown>, opts?: { merge?: boolean }) {
          writes.push({ ref, data, opts })
        },
      }
      const result = await fn(tx)
      for (const write of writes) {
        const current = col(write.ref._collectionName).get(write.ref._id)
        col(write.ref._collectionName).set(
          write.ref._id,
          write.opts?.merge && current ? { ...current, ...write.data } : { ...write.data }
        )
      }
      return result
    },
  }

  return { db: db as unknown as Firestore, store }
}

test("hashCandidateHandle normalizes and never places raw PII in the handle id", () => {
  const a = hashCandidateHandle("email", "  ALICE@Example.COM ")
  const b = hashCandidateHandle("email", "alice@example.com")
  assert.equal(a.normalizedValue, "alice@example.com")
  assert.equal(a.handleHash, b.handleHash)
  assert.equal(a.handleId.includes("alice@example.com"), false)
  assert.match(a.handleId, /^email__[0-9a-f]{64}$/)
})

test("same extracted email across browser ids resolves to one candidate", async () => {
  const { db, store } = makeFakeFirestore()
  const first = await resolveCandidateIdentity(db, {
    extractedEmail: "Alice@Example.com",
    browserUid: "browser-a",
    source: "resume",
    now,
  })
  assert.notEqual(first.outcome, "identity_conflict")
  // Identity hardening 2026-05-21 added `not_found` to the union — narrow
  // to the variants that carry `candidateId` so the subsequent assertion
  // (which reads `first.candidateId`) typechecks. The first call uses
  // the default mode so `not_found` is unreachable; the guard exists
  // purely for the type system.
  if (first.outcome !== "resolved_existing" && first.outcome !== "created") return

  const second = await resolveCandidateIdentity(db, {
    extractedEmail: " alice@example.com ",
    browserUid: "browser-b",
    source: "resume",
    now,
  })
  assert.equal(second.outcome, "resolved_existing")
  if (second.outcome !== "resolved_existing") return
  assert.equal(second.candidateId, first.candidateId)
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 1)
})

test("employer email mismatch records identity conflict and creates no candidate", async () => {
  const { db, store } = makeFakeFirestore()
  const result = await resolveCandidateIdentity(db, {
    extractedEmail: "pdf@example.com",
    employerEmailHint: "hint@example.com",
    source: "ats",
    now,
  })
  assert.equal(result.outcome, "identity_conflict")
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityConflicts)!.size, 1)
})

test("same handle cannot silently link to a second candidate", async () => {
  const { db, store } = makeFakeFirestore()
  await linkCandidateHandle(db, {
    candidateId: "cand-a",
    kind: "phone",
    value: "+14155550100",
    source: "resume",
    deliverable: true,
    now,
  })
  await assert.rejects(
    () =>
      linkCandidateHandle(db, {
        candidateId: "cand-b",
        kind: "phone",
        value: "+14155550100",
        source: "resume",
        deliverable: true,
        now,
      }),
    /identity_conflict/
  )
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityConflicts)!.size, 1)
})

test("claimCandidateProfile writes auth mapping, claimed lifecycle, and redacted self profile", async () => {
  const { db, store } = makeFakeFirestore()
  const claimed = await claimCandidateProfile(db, {
    firebaseUid: "firebase-1",
    email: "Alice@Example.com",
    browserUid: "browser-a",
    displayName: "Alice",
    now,
  })
  assert.equal(claimed.authMapping.firebaseUid, "firebase-1")
  assert.equal(claimed.selfProfile.emailMasked, "a***@example.com")
  assert.equal(claimed.selfProfile.displayName, "Alice")

  const user = store.get(PA_COLLECTIONS.users)!.get(claimed.candidateId)!
  assert.equal(user.candidateLifecycleState, "claimed")
  assert.equal(user.email, "alice@example.com")
  assert.equal(user.displayName, "Alice")
  user.phoneE164 = "+14155550100"
  assert.equal(store.get(PA_COLLECTIONS.candidateAuth)!.get("firebase-1")!.candidateId, claimed.candidateId)
  assert.equal(store.get(PA_COLLECTIONS.candidateSelfProfiles)!.get(claimed.candidateId)!.emailMasked, "a***@example.com")
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityEvents)!.size > 0, true)

  const again = await claimCandidateProfile(db, {
    firebaseUid: "firebase-1",
    email: "alice@example.com",
    browserUid: "browser-a",
    displayName: "Alice",
    now: "2026-05-13T12:05:00.000Z",
  })
  assert.equal(again.idempotent, true)
  assert.equal(again.candidateId, claimed.candidateId)
  assert.equal(again.selfProfile.phoneMasked, "+14***00")
  assert.equal(
    store.get(PA_COLLECTIONS.candidateIdentityEvents)!.get(claimed.claimedEventId)!.createdAt,
    now
  )
})

test("claimCandidateProfile succeeds without phoneE164 on self profile write", async () => {
  const { db, store } = makeFakeFirestore()
  const claimed = await claimCandidateProfile(db, {
    firebaseUid: "firebase-no-phone",
    email: "wekruit2024@gmail.com",
    browserUid: "browser-no-phone",
    now,
  })
  const stored = store.get(PA_COLLECTIONS.candidateSelfProfiles)!.get(claimed.candidateId)!
  assert.equal(stored.emailMasked, "w***@gmail.com")
  assert.equal("phoneMasked" in stored, false)
})

test("claimCandidateProfile adopts a prelinked layoff candidate instead of creating a second profile", async () => {
  const { db, store } = makeFakeFirestore()
  store.get(PA_COLLECTIONS.users)!.set("layoff-cand-1", {
    id: "layoff-cand-1",
    source: "WeKruit_Laid_Off",
    phoneE164: "+14155550100",
    displayName: "Layoff Candidate",
    layoffContext: {
      lastCompany: "Rain",
      jobTitle: "Software Engineer",
      location: "New York, NY",
      email: "layoff@example.com",
    },
    createdAt: now,
    updatedAt: now,
  })
  await linkCandidateHandle(db, {
    candidateId: "layoff-cand-1",
    kind: "email",
    value: "layoff@example.com",
    source: "candidate",
    deliverable: true,
    now,
  })

  const claimed = await claimCandidateProfile(db, {
    firebaseUid: "firebase-layoff-1",
    email: "Layoff@Example.com",
    browserUid: "browser-layoff",
    now,
  })

  assert.equal(claimed.candidateId, "layoff-cand-1")
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 1)
  assert.equal(store.get(PA_COLLECTIONS.users)!.get("layoff-cand-1")!.source, "WeKruit_Laid_Off")
  assert.equal(
    (store.get(PA_COLLECTIONS.users)!.get("layoff-cand-1")!.layoffContext as Record<string, unknown>).lastCompany,
    "Rain"
  )
  assert.equal(store.get(PA_COLLECTIONS.candidateAuth)!.get("firebase-layoff-1")!.candidateId, "layoff-cand-1")
  assert.equal(store.get(PA_COLLECTIONS.candidateSelfProfiles)!.get("layoff-cand-1")!.phoneMasked, "+14***00")
})

test("writeCandidateSelfProfile redacts phone and preserves candidate-facing state only", async () => {
  const { db, store } = makeFakeFirestore()
  await writeCandidateSelfProfile(db, {
    candidateId: "cand-1",
    email: "person@example.com",
    phoneE164: "+14155550100",
    marketplaceFields: { candidateLifecycleState: "reachable" },
    now,
  })
  const profile = store.get(PA_COLLECTIONS.candidateSelfProfiles)!.get("cand-1")!
  assert.equal(profile.emailMasked, "p***@example.com")
  assert.equal(profile.phoneMasked, "+14***00")
  assert.equal(profile.lifecycleState, "reachable")
})

// ---------- Identity hardening 2026-05-21 (L1-entry gate) -----------------

test("resolveCandidateIdentity mode=resolve_only returns not_found when handle missing (no pa-users created)", async () => {
  const { db, store } = makeFakeFirestore()
  const result = await resolveCandidateIdentity(db, {
    extractedEmail: "stranger@example.com",
    source: "candidate",
    now,
    mode: "resolve_only",
  })
  assert.equal(result.outcome, "not_found")
  assert.equal(
    store.get(PA_COLLECTIONS.users)!.size,
    0,
    "resolve_only must NOT create a pa-users row when handle is unknown",
  )
  assert.equal(
    store.get(PA_COLLECTIONS.candidateHandles)!.size,
    0,
    "resolve_only must NOT write a candidate handle when handle is unknown",
  )
})

test("resolveCandidateIdentity mode=resolve_only resolves to existing candidate when handle exists", async () => {
  const { db, store } = makeFakeFirestore()
  // First call creates the candidate (default mode).
  const first = await resolveCandidateIdentity(db, {
    extractedEmail: "known@example.com",
    source: "resume",
    now,
  })
  assert.equal(first.outcome, "created")
  if (first.outcome !== "created") return

  // Second call with resolve_only on the same email → resolved_existing.
  const second = await resolveCandidateIdentity(db, {
    extractedEmail: "known@example.com",
    source: "candidate",
    now,
    mode: "resolve_only",
  })
  assert.equal(second.outcome, "resolved_existing")
  if (second.outcome === "resolved_existing") {
    assert.equal(second.candidateId, first.candidateId)
  }
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 1, "no duplicate pa-users")
})

test("claimCandidateProfile allowCreate=false throws requires_l1_signup when email has no existing handle", async () => {
  const { db, store } = makeFakeFirestore()
  await assert.rejects(
    () =>
      claimCandidateProfile(db, {
        firebaseUid: "firebase-stranger",
        email: "stranger@example.com",
        browserUid: "browser-stranger",
        allowCreate: false,
        now,
      }),
    /requires_l1_signup/,
  )
  assert.equal(
    store.get(PA_COLLECTIONS.users)!.size,
    0,
    "no pa-users row created when L1 signup is required",
  )
  assert.equal(
    store.get(PA_COLLECTIONS.candidateAuth)!.size,
    0,
    "no auth mapping created when L1 signup is required",
  )
})

test("claimCandidateProfile allowCreate=false succeeds when email matches an existing handle (return path for existing user)", async () => {
  const { db, store } = makeFakeFirestore()
  // Simulate an OAuth-created user (resume / Google / LinkedIn path) that
  // already has the email linked. Magic-link return visit should claim it.
  await linkCandidateHandle(db, {
    candidateId: "existing-cand",
    kind: "email",
    value: "returning@example.com",
    source: "candidate",
    deliverable: true,
    now,
  })
  store.get(PA_COLLECTIONS.users)!.set("existing-cand", {
    id: "existing-cand",
    email: "returning@example.com",
    createdAt: now,
    updatedAt: now,
  })

  const claimed = await claimCandidateProfile(db, {
    firebaseUid: "firebase-returning",
    email: "returning@example.com",
    browserUid: "browser-returning",
    allowCreate: false,
    now,
  })
  assert.equal(claimed.candidateId, "existing-cand", "claim hit the existing candidate")
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 1, "no duplicate pa-users created")
})

test("claimCandidateProfile defaults allowCreate=true (preserves cv-ingest / OAuth back-compat)", async () => {
  const { db, store } = makeFakeFirestore()
  const claimed = await claimCandidateProfile(db, {
    firebaseUid: "firebase-google",
    email: "fresh@gmail.com",
    browserUid: "browser-google",
    now,
    // Note: allowCreate intentionally omitted — must default to true.
  })
  assert.ok(claimed.candidateId, "default mode creates a fresh candidate")
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 1)
})
