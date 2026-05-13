/**
 * v2.0 External Supply V1 — Wave B Block C2 — Upsert path tests.
 *
 * Covers all four resolution branches plus idempotency + LinkedIn-url
 * mismatch on existing candidates + weak-only tag merge semantics.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  candidateHandleHashMaterial,
  createCandidateHandleId,
  type ExternalCandidateRecord,
} from "@pa/core-types"
import { upsertCandidateFromExternalRecord } from "./external-supply-upsert.js"
import type { ResolveExternalSupplyIdentityResult } from "./external-supply-identity.js"

type Store = Map<string, Map<string, Record<string, unknown>>>

const now = "2026-05-13T12:00:00.000Z"

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function linkedinHash(url: string): string {
  return sha256Hex(candidateHandleHashMaterial("linkedin", url))
}

function emailHash(value: string): string {
  return sha256Hex(candidateHandleHashMaterial("email", value))
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
                  .map(([docId, data]) => ({ id: docId, data: () => data }))
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
  } as unknown as Firestore
  return { db, store }
}

function makeRecord(over: Partial<ExternalCandidateRecord>): ExternalCandidateRecord {
  return {
    recordId: "record-1",
    batchId: "batch-1",
    source: "juicebox",
    rawPayload: {},
    emails: [],
    experience: [],
    education: [],
    sourceTags: [],
    normalizationStatus: "ok",
    identityResolutionStatus: "pending",
    evidence: [],
    createdAt: now,
    ...over,
  }
}

function evidence(text: string) {
  return {
    source: "external_sourcing" as const,
    summary: text,
    confidence: 0.4,
  }
}

test("create_new path mints pa-users + linkedin handle + source-link + identity event", async () => {
  const { db, store } = makeFakeFirestore()
  const url = "https://www.linkedin.com/in/alice"
  const liHash = linkedinHash(url)
  const record = makeRecord({
    canonicalLinkedInUrl: url,
    linkedinProfileHash: liHash,
    name: "Alice A",
    currentCompany: "Acme",
  })
  const resolution: ResolveExternalSupplyIdentityResult = {
    status: "create_new",
    reviewReasons: [],
    evidence: [evidence("Novel LinkedIn")],
  }

  const result = await upsertCandidateFromExternalRecord(db, {
    record,
    resolution,
    operatorUid: "operator-1",
    now: () => now,
  })

  assert.equal(result.status, "created")
  assert.ok(result.candidateId)
  assert.ok(result.sourceLinkId)
  assert.ok(result.identityEventId)

  // pa-users row created with prospect lifecycle + linkedinUrl seeded.
  const user = store.get(PA_COLLECTIONS.users)!.get(result.candidateId!)!
  assert.equal(user.candidateLifecycleState, "prospect")
  assert.equal(user.linkedinUrl, url)

  // LinkedIn handle attached under canonical hash id.
  const handleId = createCandidateHandleId("linkedin", liHash)
  const handle = store.get(PA_COLLECTIONS.candidateHandles)!.get(handleId)!
  assert.equal(handle.candidateId, result.candidateId)
  assert.equal(handle.source, "external_sourcing")

  // Source-link landed with status=linked.
  const link = store.get(PA_COLLECTIONS.candidateSourceLinks)!.get(result.sourceLinkId)!
  assert.equal(link.status, "linked")
  assert.equal(link.candidateId, result.candidateId)
  assert.equal(link.canonicalLinkedInUrl, url)

  // Identity event is `external_candidate_imported`.
  const event = store.get(PA_COLLECTIONS.candidateIdentityEvents)!.get(result.identityEventId!)!
  assert.equal(event.type, "external_candidate_imported")
  assert.equal(event.candidateId, result.candidateId)
})

test("merge_existing path skips pa-users overwrite and emits external_source_linked", async () => {
  const { db, store } = makeFakeFirestore()
  const url = "https://www.linkedin.com/in/bob"
  const liHash = linkedinHash(url)
  // Seed an existing candidate.
  store.get(PA_COLLECTIONS.users)!.set("cand-bob", {
    id: "cand-bob",
    candidateLifecycleState: "profile_ready",
    linkedinUrl: url,
    createdAt: now,
  })
  // Seed the linkedin handle so the path doesn't try to write it again.
  const handleId = createCandidateHandleId("linkedin", liHash)
  store.get(PA_COLLECTIONS.candidateHandles)!.set(handleId, {
    handleId,
    candidateId: "cand-bob",
    kind: "linkedin",
    handleHash: liHash,
    source: "external_sourcing",
    createdAt: now,
  })

  const record = makeRecord({
    canonicalLinkedInUrl: url,
    linkedinProfileHash: liHash,
  })
  const resolution: ResolveExternalSupplyIdentityResult = {
    status: "merge_existing",
    candidateId: "cand-bob",
    reviewReasons: [],
    evidence: [evidence("Existing LinkedIn match")],
  }

  const result = await upsertCandidateFromExternalRecord(db, {
    record,
    resolution,
    operatorUid: "operator-1",
    now: () => now,
  })

  assert.equal(result.status, "merged")
  assert.equal(result.candidateId, "cand-bob")

  // Existing pa-users row was not overwritten — lifecycleState stays as
  // profile_ready (NOT downgraded to prospect).
  const user = store.get(PA_COLLECTIONS.users)!.get("cand-bob")!
  assert.equal(user.candidateLifecycleState, "profile_ready")

  // Identity event type is `external_source_linked` (not _imported).
  const event = store.get(PA_COLLECTIONS.candidateIdentityEvents)!.get(result.identityEventId!)!
  assert.equal(event.type, "external_source_linked")
})

test("merge_existing with conflicting linkedinUrl records the mismatch in payloadRedacted", async () => {
  const { db, store } = makeFakeFirestore()
  const recordUrl = "https://www.linkedin.com/in/charlie"
  const liHash = linkedinHash(recordUrl)
  // Existing user has a DIFFERENT linkedinUrl already on the profile.
  store.get(PA_COLLECTIONS.users)!.set("cand-c", {
    id: "cand-c",
    candidateLifecycleState: "profile_ready",
    linkedinUrl: "https://www.linkedin.com/in/charlie-old",
    createdAt: now,
  })

  const record = makeRecord({
    canonicalLinkedInUrl: recordUrl,
    linkedinProfileHash: liHash,
  })
  const resolution: ResolveExternalSupplyIdentityResult = {
    status: "merge_existing",
    candidateId: "cand-c",
    reviewReasons: [],
    evidence: [evidence("LinkedIn match")],
  }

  const result = await upsertCandidateFromExternalRecord(db, {
    record,
    resolution,
    operatorUid: "operator-1",
    now: () => now,
  })

  assert.equal(result.status, "merged")
  const user = store.get(PA_COLLECTIONS.users)!.get("cand-c")!
  // pa-users.linkedinUrl preserved — the external record did NOT overwrite.
  assert.equal(user.linkedinUrl, "https://www.linkedin.com/in/charlie-old")
  const event = store.get(PA_COLLECTIONS.candidateIdentityEvents)!.get(result.identityEventId!)!
  const payload = event.payloadRedacted as Record<string, unknown>
  assert.equal(payload.linkedinUrlMismatchWithProfile, true)
})

test("needs_review path writes a pending source-link with no pa-users mutation", async () => {
  const { db, store } = makeFakeFirestore()
  const record = makeRecord({
    emails: [{ value: "dana@example.com", hash: emailHash("dana@example.com") }],
  })
  const resolution: ResolveExternalSupplyIdentityResult = {
    status: "needs_review",
    reviewReasons: ["email_only_external_row"],
    evidence: [evidence("Email-only")],
  }

  const result = await upsertCandidateFromExternalRecord(db, {
    record,
    resolution,
    operatorUid: "operator-1",
    now: () => now,
  })

  assert.equal(result.status, "pending_review")
  assert.equal(result.candidateId, undefined)
  // No user row, no handles.
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.candidateHandles)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityEvents)!.size, 0)
  // Source-link landed with status=pending_review + candidateId absent.
  const link = store.get(PA_COLLECTIONS.candidateSourceLinks)!.get(result.sourceLinkId)!
  assert.equal(link.status, "pending_review")
  assert.equal(link.candidateId, undefined)
  assert.equal(link.pendingRecordId, "record-1")
})

test("blocked path writes source-link with status=blocked and no profile mutation", async () => {
  const { db, store } = makeFakeFirestore()
  const record = makeRecord({})
  const resolution: ResolveExternalSupplyIdentityResult = {
    status: "blocked",
    reviewReasons: ["no_identity_signal"],
    evidence: [evidence("No signal")],
  }

  const result = await upsertCandidateFromExternalRecord(db, {
    record,
    resolution,
    operatorUid: "operator-1",
    now: () => now,
  })

  assert.equal(result.status, "blocked")
  assert.equal(result.candidateId, undefined)
  const link = store.get(PA_COLLECTIONS.candidateSourceLinks)!.get(result.sourceLinkId)!
  assert.equal(link.status, "blocked")
})

test("idempotent re-run does not duplicate source-link or identity event", async () => {
  const { db, store } = makeFakeFirestore()
  const url = "https://www.linkedin.com/in/eve"
  const liHash = linkedinHash(url)
  const record = makeRecord({
    canonicalLinkedInUrl: url,
    linkedinProfileHash: liHash,
  })
  // Use merge_existing so the candidateId is stable across the two calls
  // (create_new would mint a fresh UUID each time).
  store.get(PA_COLLECTIONS.users)!.set("cand-eve", {
    id: "cand-eve",
    candidateLifecycleState: "profile_ready",
    linkedinUrl: url,
    createdAt: now,
  })
  const resolution: ResolveExternalSupplyIdentityResult = {
    status: "merge_existing",
    candidateId: "cand-eve",
    reviewReasons: [],
    evidence: [evidence("Existing LinkedIn match")],
  }

  const first = await upsertCandidateFromExternalRecord(db, {
    record,
    resolution,
    operatorUid: "operator-1",
    now: () => now,
  })
  const second = await upsertCandidateFromExternalRecord(db, {
    record,
    resolution,
    operatorUid: "operator-1",
    now: () => now,
  })

  assert.equal(first.sourceLinkId, second.sourceLinkId)
  assert.equal(first.identityEventId, second.identityEventId)
  assert.equal(store.get(PA_COLLECTIONS.candidateSourceLinks)!.size, 1)
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityEvents)!.size, 1)
})

test("weak-only tag merge does not clobber existing populated relevantTags slot", async () => {
  const { db, store } = makeFakeFirestore()
  const url = "https://www.linkedin.com/in/frank"
  const liHash = linkedinHash(url)
  // Seed an existing user with a populated relevantTags array — the
  // external sourcing tags must UNION onto it, not replace it.
  // (Canonical relevantTags token shape: [a-z][a-z0-9_]{1,79}.)
  store.get(PA_COLLECTIONS.users)!.set("cand-frank", {
    id: "cand-frank",
    candidateLifecycleState: "profile_ready",
    linkedinUrl: url,
    globalTags: {
      roleFunction: ["software_engineering"],
      skills: [],
      industrySector: [],
      targetLocations: [],
      targetJobType: [],
      relevantTags: ["resume_derived_tag"],
      companySizePreference: [],
      updatedAt: "2026-05-12T00:00:00.000Z",
    },
    createdAt: now,
  })

  const record = makeRecord({
    canonicalLinkedInUrl: url,
    linkedinProfileHash: liHash,
    // Canonical tokens that pass `RelevantTagSchema` — three chars plus,
    // underscore-separated, no abbreviation. `ml` would be filtered by
    // our pre-filter (abbreviation) and not propagated.
    sourceTags: ["ai_infrastructure", "machine_learning"],
  })
  const resolution: ResolveExternalSupplyIdentityResult = {
    status: "merge_existing",
    candidateId: "cand-frank",
    reviewReasons: [],
    evidence: [evidence("Match")],
  }

  const result = await upsertCandidateFromExternalRecord(db, {
    record,
    resolution,
    operatorUid: "operator-1",
    now: () => now,
  })
  assert.equal(result.status, "merged")
  const user = store.get(PA_COLLECTIONS.users)!.get("cand-frank")!
  const tags = user.globalTags as Record<string, unknown>
  // roleFunction preserved (stronger source — resume parse).
  assert.deepEqual(tags.roleFunction, ["software_engineering"])
  // relevantTags is the UNION of the original tag plus the new weak tags.
  const relevant = tags.relevantTags as string[]
  assert.ok(relevant.includes("resume_derived_tag"))
  assert.ok(relevant.includes("ai_infrastructure"))
  assert.ok(relevant.includes("machine_learning"))
})

test("create_new attaches email handles when emails are present", async () => {
  const { db, store } = makeFakeFirestore()
  const url = "https://www.linkedin.com/in/grace"
  const liHash = linkedinHash(url)
  const eHash = emailHash("grace@example.com")
  const record = makeRecord({
    canonicalLinkedInUrl: url,
    linkedinProfileHash: liHash,
    emails: [{ value: "grace@example.com", hash: eHash }],
  })
  const resolution: ResolveExternalSupplyIdentityResult = {
    status: "create_new",
    reviewReasons: [],
    evidence: [evidence("Novel LinkedIn + email")],
  }

  const result = await upsertCandidateFromExternalRecord(db, {
    record,
    resolution,
    operatorUid: "operator-1",
    now: () => now,
  })
  assert.equal(result.status, "created")
  const handles = store.get(PA_COLLECTIONS.candidateHandles)!
  const emailHandle = handles.get(createCandidateHandleId("email", eHash))
  assert.ok(emailHandle, "email handle must be attached on create_new")
  assert.equal(emailHandle.candidateId, result.candidateId)
  assert.equal(emailHandle.deliverable, false)
})
