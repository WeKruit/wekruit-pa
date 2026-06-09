import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  claimCandidateProfile,
  hashCandidateHandle,
  linkCandidateHandle,
  mergeCandidatesByPhone,
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

  function applySet(
    collectionName: string,
    docId: string,
    data: Record<string, unknown>,
    opts?: { merge?: boolean },
  ) {
    const current = opts?.merge ? { ...(col(collectionName).get(docId) ?? {}) } : {}
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && value.constructor?.name === "DeleteTransform") {
        delete current[key]
      } else {
        current[key] = value
      }
    }
    col(collectionName).set(docId, current)
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
        applySet(collectionName, docId, data, opts)
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
        applySet(write.ref._collectionName, write.ref._id, write.data, write.opts)
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

test("linkCandidateHandle omits undefined deliverable for connector handles", async () => {
  const { db, store } = makeFakeFirestore()
  const result = await linkCandidateHandle(db, {
    candidateId: "cand-linkedin",
    kind: "linkedin",
    value: "https://www.linkedin.com/in/cand-linkedin",
    source: "candidate",
    verified: true,
    now,
  })
  assert.equal(result.created, true)
  const stored = store.get(PA_COLLECTIONS.candidateHandles)!.get(result.handle.handleId)!
  assert.equal("deliverable" in stored, false)
})

test("linkCandidateHandle validates identity event before writing the handle", async () => {
  const { db, store } = makeFakeFirestore()
  await assert.rejects(
    () =>
      linkCandidateHandle(db, {
        candidateId: "cand-invalid-evidence",
        kind: "linkedin",
        value: "https://www.linkedin.com/in/cand-invalid-evidence",
        source: "candidate",
        verified: true,
        evidence: [{ source: "coresignal", summary: "invalid source" }] as never,
        now,
      }),
    /Invalid enum value/,
  )
  assert.equal(store.get(PA_COLLECTIONS.candidateHandles)!.size, 0)
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

test("handle_candidate_mismatch conflictId is commutative (A→B and B→A map to the same doc)", async () => {
  const { db, store } = makeFakeFirestore()
  const phone = "+14155550100"
  await linkCandidateHandle(db, {
    candidateId: "cand-a",
    kind: "phone",
    value: phone,
    source: "resume",
    deliverable: true,
    now,
  })
  let firstConflictId = ""
  await assert.rejects(
    () =>
      linkCandidateHandle(db, {
        candidateId: "cand-b",
        kind: "phone",
        value: phone,
        source: "resume",
        deliverable: true,
        now,
      }),
    (err: Error) => {
      firstConflictId = err.message.replace("identity_conflict:", "")
      return err.message.startsWith("identity_conflict:")
    },
  )
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityConflicts)!.size, 1)

  // Flip handle ownership (e.g. post-merge reassignment) and detect the SAME
  // pair from the opposite direction: cand-a now attempts cand-b's handle.
  const handleId = hashCandidateHandle("phone", phone).handleId
  await db
    .collection(PA_COLLECTIONS.candidateHandles)
    .doc(handleId)
    .set({ candidateId: "cand-b" }, { merge: true })
  let secondConflictId = ""
  await assert.rejects(
    () =>
      linkCandidateHandle(db, {
        candidateId: "cand-a",
        kind: "phone",
        value: phone,
        source: "resume",
        deliverable: true,
        now,
      }),
    (err: Error) => {
      secondConflictId = err.message.replace("identity_conflict:", "")
      return err.message.startsWith("identity_conflict:")
    },
  )
  assert.equal(secondConflictId, firstConflictId, "B→A detection must produce the SAME conflictId as A→B")
  assert.equal(
    store.get(PA_COLLECTIONS.candidateIdentityConflicts)!.size,
    1,
    "opposite-direction detection must NOT create a second conflict doc",
  )
})

test("pdf/employer email mismatch conflictId is commutative across swapped roles", async () => {
  const { db, store } = makeFakeFirestore()
  const first = await resolveCandidateIdentity(db, {
    extractedEmail: "pdf@example.com",
    employerEmailHint: "hint@example.com",
    source: "ats",
    now,
  })
  assert.equal(first.outcome, "identity_conflict")
  if (first.outcome !== "identity_conflict") return

  const second = await resolveCandidateIdentity(db, {
    extractedEmail: "hint@example.com",
    employerEmailHint: "pdf@example.com",
    source: "ats",
    now,
  })
  assert.equal(second.outcome, "identity_conflict")
  if (second.outcome !== "identity_conflict") return
  assert.equal(second.conflict.conflictId, first.conflict.conflictId)
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

test("claimCandidateProfile normalizes bare LinkedIn URL before self profile validation", async () => {
  const { db, store } = makeFakeFirestore()
  const resolved = await resolveCandidateIdentity(db, {
    extractedEmail: "sreya@example.com",
    source: "resume",
    now,
  })
  assert.equal(resolved.outcome, "created")
  if (resolved.outcome !== "created") return
  await db.collection(PA_COLLECTIONS.users).doc(resolved.candidateId).set(
    {
      linkedinUrl: "www.linkedin.com/in/sreya-gopaladasu-b77540211",
    },
    { merge: true },
  )

  const claimed = await claimCandidateProfile(db, {
    firebaseUid: "firebase-linkedin-bare",
    email: "sreya@example.com",
    browserUid: "browser-linkedin-bare",
    now,
  })

  assert.equal(claimed.candidateId, resolved.candidateId)
  assert.equal(
    store.get(PA_COLLECTIONS.candidateSelfProfiles)!.get(resolved.candidateId)!.linkedinUrl,
    "https://www.linkedin.com/in/sreya-gopaladasu-b77540211",
  )
})

test("claimCandidateProfile preserves rich LinkedIn experience details on self profile refresh", async () => {
  const { db, store } = makeFakeFirestore()
  const resolved = await resolveCandidateIdentity(db, {
    extractedEmail: "linkedin-rich@example.com",
    source: "resume",
    now,
  })
  assert.equal(resolved.outcome, "created")
  if (resolved.outcome !== "created") return

  await db.collection(PA_COLLECTIONS.users).doc(resolved.candidateId).set(
    {
      experienceHighlights: [
        {
          title: "Software Engineer",
          company: "Tesla",
          location: "Austin, Texas, US",
          description: "Built CI/CD pipelines and migrated portfolio services onto Azure.",
          startDate: "May 2024",
          endDate: "August 2024",
          department: "Engineering and Technical",
          companyIndustry: "Motor Vehicle Manufacturing",
          companySizeRange: "10,001+ employees",
          companyWebsite: "https://www.tesla.com",
          companyLinkedinUrl: "https://www.linkedin.com/company/tesla-motors",
          companyHqCity: "Austin",
          companyHqCountry: "United States",
          companyLogoUrl: "https://media.licdn.com/tesla.png",
          source: "coresignal_collect_v2",
          sourceLabel: "LinkedIn",
        },
      ],
    },
    { merge: true },
  )

  const claimed = await claimCandidateProfile(db, {
    firebaseUid: "firebase-linkedin-rich",
    email: "linkedin-rich@example.com",
    browserUid: "browser-linkedin-rich",
    now,
  })

  assert.equal(claimed.candidateId, resolved.candidateId)
  const stored = store.get(PA_COLLECTIONS.candidateSelfProfiles)!.get(resolved.candidateId)!
  const experience = (stored.experienceHighlights as Array<Record<string, unknown>>)[0]
  assert.equal(experience.description, "Built CI/CD pipelines and migrated portfolio services onto Azure.")
  assert.equal(experience.department, "Engineering and Technical")
  assert.equal(experience.companyIndustry, "Motor Vehicle Manufacturing")
  assert.equal(experience.companyLogoUrl, "https://media.licdn.com/tesla.png")
})

test("claimCandidateProfile preserves already connected OAuth handles on self profile refresh", async () => {
  const { db, store } = makeFakeFirestore()
  const resolved = await resolveCandidateIdentity(db, {
    extractedEmail: "connected@example.com",
    source: "resume",
    now,
  })
  assert.equal(resolved.outcome, "created")
  if (resolved.outcome !== "created") return

  await linkCandidateHandle(db, {
    candidateId: resolved.candidateId,
    kind: "linkedin",
    value: "https://www.linkedin.com/oauth-linked/sub-1",
    source: "candidate",
    verified: true,
    now,
  })
  await linkCandidateHandle(db, {
    candidateId: resolved.candidateId,
    kind: "github",
    value: "https://github.com/connected-dev",
    source: "candidate",
    verified: true,
    now,
  })
  await db.collection(PA_COLLECTIONS.users).doc(resolved.candidateId).set(
    {
      linkedinUrl: "https://www.linkedin.com/oauth-linked/sub-1",
      linkedinOauthLinked: true,
      linkedinOauthConnectedAt: now,
      linkedinOauthName: "Connected Dev",
      linkedinOauthPicture: "https://media.licdn.com/profile.jpg",
      githubUrl: "https://github.com/connected-dev",
      githubHandle: "connected-dev",
      githubOauthLinked: true,
      githubOauthConnectedAt: now,
      githubOauthName: "Connected Dev",
      githubOauthAvatar: "https://avatars.githubusercontent.com/u/1",
      githubOauthEmail: "connected@example.com",
      githubPublicRepos: [
        {
          name: "portfolio",
          fullName: "connected-dev/portfolio",
          url: "https://github.com/connected-dev/portfolio",
          language: "TypeScript",
          stars: 7,
          updatedAt: now,
        },
      ],
    },
    { merge: true },
  )
  await db.collection(PA_COLLECTIONS.candidateSelfProfiles).doc(resolved.candidateId).set(
    {
      candidateId: resolved.candidateId,
      lifecycleState: "claimed",
      linkedinUrl: "https://www.linkedin.com/oauth-linked/sub-1",
      createdAt: now,
      updatedAt: now,
    },
    { merge: true },
  )

  const claimed = await claimCandidateProfile(db, {
    firebaseUid: "firebase-connected",
    email: "connected@example.com",
    browserUid: "browser-connected",
    now,
  })

  const handleKinds = new Set(claimed.selfProfile.handles.map((handle) => handle.kind))
  assert.equal(handleKinds.has("email"), true)
  assert.equal(handleKinds.has("linkedin"), true)
  assert.equal(handleKinds.has("github"), true)
  assert.equal(claimed.selfProfile.linkedinUrl, undefined)
  assert.equal(claimed.selfProfile.linkedinOauthProfile?.name, "Connected Dev")
  assert.equal(claimed.selfProfile.githubOauthProfile?.login, "connected-dev")
  assert.equal(claimed.selfProfile.githubPublicRepos?.[0]?.fullName, "connected-dev/portfolio")

  const stored = store.get(PA_COLLECTIONS.candidateSelfProfiles)!.get(resolved.candidateId)!
  assert.deepEqual(
    (stored.handles as Array<{ kind: string }>).map((handle) => handle.kind).sort(),
    ["email", "github", "linkedin"].sort(),
  )
  assert.equal("linkedinUrl" in stored, false)
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
    marketplaceFields: {
      candidateLifecycleState: "reachable",
      experienceHighlights: [
        {
          title: "Software Engineer",
          company: "Tesla",
          location: "Fremont, California, United States",
          description: "Built vehicle telemetry tools and improved release diagnostics.",
          startDate: "May 2024",
          endDate: "August 2024",
          durationMonths: 4,
          department: "Engineering",
          managementLevel: "Individual Contributor",
          companyIndustry: "Automotive",
          companySizeRange: "10,001+ employees",
          companyWebsite: "tesla.com",
          companyLinkedinUrl: "linkedin.com/company/tesla-motors",
          companyHqCity: "Austin",
          companyHqCountry: "United States",
          companyLogoUrl: "https://static.licdn.com/tesla.png",
          source: "coresignal_collect_v2",
          sourceLabel: "LinkedIn",
        },
      ],
    },
    now,
  })
  const profile = store.get(PA_COLLECTIONS.candidateSelfProfiles)!.get("cand-1")!
  assert.equal(profile.emailMasked, "p***@example.com")
  assert.equal(profile.phoneMasked, "+14***00")
  assert.equal(profile.lifecycleState, "reachable")
  assert.equal((profile.experienceHighlights as Array<{ company: string }>)[0]?.company, "Tesla")
  const experience = (profile.experienceHighlights as Array<Record<string, unknown>>)[0]
  assert.equal(experience.description, "Built vehicle telemetry tools and improved release diagnostics.")
  assert.equal(experience.companyWebsite, "https://tesla.com/")
  assert.equal(experience.companyLinkedinUrl, "https://linkedin.com/company/tesla-motors")
  assert.equal(experience.companyLogoUrl, "https://static.licdn.com/tesla.png")
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

test("claimCandidateProfile exposes the assigned Claire sender number on the self profile", async () => {
  const { db, store } = makeFakeFirestore()
  await linkCandidateHandle(db, {
    candidateId: "existing-claire-cand",
    kind: "email",
    value: "claire-line@example.com",
    source: "candidate",
    deliverable: true,
    now,
  })
  store.get(PA_COLLECTIONS.users)!.set("existing-claire-cand", {
    id: "existing-claire-cand",
    email: "claire-line@example.com",
    senderNumber: "+17174919939",
    phoneE164: "+14155550100",
    createdAt: now,
    updatedAt: now,
  })

  const claimed = await claimCandidateProfile(db, {
    firebaseUid: "firebase-claire-line",
    email: "claire-line@example.com",
    browserUid: "browser-claire-line",
    allowCreate: false,
    now,
  })

  assert.equal(claimed.candidateId, "existing-claire-cand")
  assert.equal(claimed.selfProfile.senderNumber, "+17174919939")
  const stored = store.get(PA_COLLECTIONS.candidateSelfProfiles)!.get("existing-claire-cand")!
  assert.equal(stored.senderNumber, "+17174919939")
  assert.equal("phoneE164" in stored, false)
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

// ---------------------------------------------------------------------------
// mergeCandidatesByPhone — same-phone duplicate fold (Adam policy 2026-05-29)
// ---------------------------------------------------------------------------

test("mergeCandidatesByPhone is a no-op when only one pa-users holds the phone", async () => {
  const { db } = makeFakeFirestore()
  const phone = "+18303265553"
  db.collection(PA_COLLECTIONS.users).doc("solo").set({ id: "solo", phoneE164: phone, createdAt: now })
  const result = await mergeCandidatesByPhone(db, { phoneE164: phone, now })
  assert.equal(result.merged, false)
  assert.equal(result.canonicalCandidateId, "solo")
  assert.deepEqual(result.duplicateCandidateIds, [])
})

test("mergeCandidatesByPhone folds the younger duplicate into the oldest-createdAt canonical", async () => {
  const { db, store } = makeFakeFirestore()
  const phone = "+18303265553"
  // Older = canonical (KEEP); younger = duplicate (FOLD).
  db.collection(PA_COLLECTIONS.users).doc("Uu3Ze").set({
    id: "Uu3Ze",
    phoneE164: phone,
    email: "yogeshsavirigana@gmail.com",
    displayName: "Yogesh Savirigana",
    createdAt: "2026-05-29T17:44:22.000Z",
    tags: { skills: ["python"], targetRoleFunction: ["software_engineering"] },
  })
  db.collection(PA_COLLECTIONS.users).doc("ECyf").set({
    id: "ECyf",
    phoneE164: phone,
    email: "yogi.savirigana1996@gmail.com",
    createdAt: "2026-05-29T17:46:11.000Z",
    tags: { skills: ["react", "python"], industrySector: ["financial_technology"] },
  })
  // duplicate-owned data to fold
  db.collection("parsedCandidateResumes").doc("ECyf").set({ userId: "ECyf", topSkills: ["react"] })
  db.collection("pa-prescreen-sessions").doc("ps_1").set({ userId: "ECyf", terminal: null })
  await linkCandidateHandle(db, { candidateId: "ECyf", kind: "email", value: "yogi.savirigana1996@gmail.com", source: "candidate", now })

  const result = await mergeCandidatesByPhone(db, { phoneE164: phone, now })
  assert.equal(result.merged, true)
  assert.equal(result.canonicalCandidateId, "Uu3Ze", "oldest createdAt wins")
  assert.deepEqual(result.duplicateCandidateIds, ["ECyf"])

  const canonical = store.get(PA_COLLECTIONS.users)!.get("Uu3Ze")!
  // tags union (additive)
  assert.deepEqual((canonical.tags as Record<string, unknown>).skills, ["python", "react"])
  assert.deepEqual((canonical.tags as Record<string, unknown>).industrySector, ["financial_technology"])
  assert.deepEqual((canonical.tags as Record<string, unknown>).targetRoleFunction, ["software_engineering"])
  // duplicate email preserved as alt-email
  assert.deepEqual(canonical.altEmails, ["yogi.savirigana1996@gmail.com"])
  assert.deepEqual(canonical.dedupMergedFrom, ["ECyf"])

  // duplicate tombstoned
  const dup = store.get(PA_COLLECTIONS.users)!.get("ECyf")!
  assert.equal(dup.mergedInto, "Uu3Ze")
  assert.equal(dup.runtimeMode, "paused")
  assert.equal(dup.phoneE164, `${phone}__merged_ECyf`, "phone tombstoned so resolver never finds it")

  // prescreen session re-pointed to canonical
  assert.equal(store.get("pa-prescreen-sessions")!.get("ps_1")!.userId, "Uu3Ze")
  // parsedCandidateResumes (doc-id-is-userId) copied to canonical, dup tombstoned
  assert.equal(store.get("parsedCandidateResumes")!.get("Uu3Ze")!.userId, "Uu3Ze")
  assert.equal(store.get("parsedCandidateResumes")!.get("ECyf")!.mergedInto, "Uu3Ze")

  // handle re-pointed to canonical
  const handle = hashCandidateHandle("email", "yogi.savirigana1996@gmail.com")
  assert.equal(store.get(PA_COLLECTIONS.candidateHandles)!.get(handle.handleId)!.candidateId, "Uu3Ze")

  // audit: identity merge event + correction event written
  const idEvents = Array.from(store.get(PA_COLLECTIONS.candidateIdentityEvents)!.values())
  assert.ok(idEvents.some((e) => e.type === "merge_decision_recorded"), "merge identity event written")
  assert.equal(store.get(PA_COLLECTIONS.correctionEvents)!.size, 1, "flywheel correction event written")
})

test("mergeCandidatesByPhone is idempotent (re-run does not double-fold)", async () => {
  const { db, store } = makeFakeFirestore()
  const phone = "+18303265553"
  db.collection(PA_COLLECTIONS.users).doc("keep").set({ id: "keep", phoneE164: phone, createdAt: "2026-05-01T00:00:00.000Z", tags: { skills: ["a"] } })
  db.collection(PA_COLLECTIONS.users).doc("dup").set({ id: "dup", phoneE164: phone, createdAt: "2026-05-02T00:00:00.000Z", tags: { skills: ["b"] } })

  const first = await mergeCandidatesByPhone(db, { phoneE164: phone, now })
  assert.equal(first.merged, true)
  assert.deepEqual((store.get(PA_COLLECTIONS.users)!.get("keep")!.tags as Record<string, unknown>).skills, ["a", "b"])

  // Second run: the dup phone is now tombstoned, so a phone query finds only canonical → no-op.
  const second = await mergeCandidatesByPhone(db, { phoneE164: phone, now })
  assert.equal(second.merged, false, "tombstoned dup no longer holds the phone → nothing to merge")
  // tags unchanged (no double union)
  assert.deepEqual((store.get(PA_COLLECTIONS.users)!.get("keep")!.tags as Record<string, unknown>).skills, ["a", "b"])
})

test("mergeCandidatesByPhone dry-run computes the plan with zero writes", async () => {
  const { db, store } = makeFakeFirestore()
  const phone = "+18303265553"
  db.collection(PA_COLLECTIONS.users).doc("keep").set({ id: "keep", phoneE164: phone, createdAt: "2026-05-01T00:00:00.000Z", email: "a@x.com", tags: { skills: ["a"] } })
  db.collection(PA_COLLECTIONS.users).doc("dup").set({ id: "dup", phoneE164: phone, createdAt: "2026-05-02T00:00:00.000Z", email: "b@x.com", tags: { skills: ["b"] } })

  const plan = await mergeCandidatesByPhone(db, { phoneE164: phone, now, dryRun: true })
  assert.equal(plan.merged, true)
  assert.equal(plan.dryRun, true)
  assert.equal(plan.canonicalCandidateId, "keep")
  assert.deepEqual(plan.folded[0]!.tagFieldsUnioned, ["skills"])
  assert.deepEqual(plan.folded[0]!.emailsFolded, ["b@x.com"])
  // No mutations performed.
  assert.equal(store.get(PA_COLLECTIONS.users)!.get("dup")!.mergedInto, undefined, "dry-run wrote nothing")
  assert.deepEqual((store.get(PA_COLLECTIONS.users)!.get("keep")!.tags as Record<string, unknown>).skills, ["a"])
  assert.equal(store.get(PA_COLLECTIONS.correctionEvents)!.size, 0)
})

test("mergeCandidatesByPhone honors an explicit canonical pin", async () => {
  const { db, store } = makeFakeFirestore()
  const phone = "+18303265553"
  // Younger doc pinned as canonical despite older sibling.
  db.collection(PA_COLLECTIONS.users).doc("older").set({ id: "older", phoneE164: phone, createdAt: "2026-05-01T00:00:00.000Z" })
  db.collection(PA_COLLECTIONS.users).doc("pinned").set({ id: "pinned", phoneE164: phone, createdAt: "2026-05-02T00:00:00.000Z" })
  const result = await mergeCandidatesByPhone(db, { phoneE164: phone, canonicalCandidateIdHint: "pinned", now })
  assert.equal(result.canonicalCandidateId, "pinned")
  assert.equal(store.get(PA_COLLECTIONS.users)!.get("older")!.mergedInto, "pinned")
})
