/**
 * v2.0 External Supply V1 — Wave B Block C1 — Identity resolver tests.
 *
 * Covers the LinkedIn-first, email-secondary policy and the three
 * needs-review / blocked paths.
 *
 * The in-memory Firestore fake mirrors the shape used in `identity.test.ts`
 * so we can exercise the real `recordIdentityConflict` helper (the
 * resolver re-uses the conflict writer from identity.ts).
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
import {
  EXTERNAL_SUPPLY_EVIDENCE_CONFIDENCE,
  resolveExternalSupplyIdentity,
} from "./external-supply-identity.js"

type Store = Map<string, Map<string, Record<string, unknown>>>

const now = "2026-05-13T12:00:00.000Z"

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function linkedinHash(canonicalUrl: string): string {
  return sha256Hex(candidateHandleHashMaterial("linkedin", canonicalUrl))
}

function emailHash(normalized: string): string {
  return sha256Hex(candidateHandleHashMaterial("email", normalized))
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

function seedHandle(
  store: Store,
  args: { kind: "linkedin" | "email"; hash: string; candidateId: string }
) {
  const handleId = createCandidateHandleId(args.kind, args.hash)
  const handles = store.get(PA_COLLECTIONS.candidateHandles)!
  handles.set(handleId, {
    handleId,
    candidateId: args.candidateId,
    kind: args.kind,
    handleHash: args.hash,
    source: args.kind === "linkedin" ? "external_sourcing" : "candidate",
    createdAt: now,
  })
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

test("LinkedIn handle hit returns merge_existing with the linked candidateId", async () => {
  const { db, store } = makeFakeFirestore()
  const url = "https://www.linkedin.com/in/alice"
  const hash = linkedinHash(url)
  seedHandle(store, { kind: "linkedin", hash, candidateId: "cand-existing" })

  const result = await resolveExternalSupplyIdentity(
    db,
    makeRecord({
      canonicalLinkedInUrl: url,
      linkedinProfileHash: hash,
    }),
    { now: () => now }
  )

  assert.equal(result.status, "merge_existing")
  assert.equal(result.candidateId, "cand-existing")
  assert.deepEqual(result.reviewReasons, [])
  assert.equal(result.evidence.length, 1)
  assert.equal(result.evidence[0]!.source, "external_sourcing")
  assert.equal(result.evidence[0]!.confidence, EXTERNAL_SUPPLY_EVIDENCE_CONFIDENCE)
})

test("LinkedIn handle miss returns create_new without writing anything", async () => {
  const { db, store } = makeFakeFirestore()
  const url = "https://www.linkedin.com/in/bob"
  const result = await resolveExternalSupplyIdentity(
    db,
    makeRecord({
      canonicalLinkedInUrl: url,
      linkedinProfileHash: linkedinHash(url),
    }),
    { now: () => now }
  )
  assert.equal(result.status, "create_new")
  assert.equal(result.candidateId, undefined)
  assert.equal(result.evidence.length, 1)
  // No conflicts, no handle writes.
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityConflicts)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.candidateHandles)!.size, 0)
})

test("LinkedIn hits one candidate while email hits another -> needs_review + conflict doc", async () => {
  const { db, store } = makeFakeFirestore()
  const url = "https://www.linkedin.com/in/alice"
  const liHash = linkedinHash(url)
  const eHash = emailHash("alice@startup.com")
  seedHandle(store, { kind: "linkedin", hash: liHash, candidateId: "cand-linkedin" })
  seedHandle(store, { kind: "email", hash: eHash, candidateId: "cand-email" })

  const result = await resolveExternalSupplyIdentity(
    db,
    makeRecord({
      canonicalLinkedInUrl: url,
      linkedinProfileHash: liHash,
      emails: [{ value: "alice@startup.com", hash: eHash }],
    }),
    { now: () => now }
  )

  assert.equal(result.status, "needs_review")
  assert.deepEqual(result.reviewReasons, ["linkedin_email_candidate_mismatch"])
  assert.equal(typeof result.conflictId, "string")
  const conflicts = store.get(PA_COLLECTIONS.candidateIdentityConflicts)!
  assert.equal(conflicts.size, 1)
  const conflict = Array.from(conflicts.values())[0]!
  assert.equal(conflict.kind, "linkedin_email_candidate_mismatch")
  assert.equal(conflict.primaryCandidateId, "cand-linkedin")
  assert.equal(conflict.competingCandidateId, "cand-email")
})

test("Email-only row always routes to needs_review with email_only_external_row", async () => {
  const { db, store } = makeFakeFirestore()
  const result = await resolveExternalSupplyIdentity(
    db,
    makeRecord({
      emails: [
        { value: "carol@example.com", hash: emailHash("carol@example.com") },
      ],
    }),
    { now: () => now }
  )
  assert.equal(result.status, "needs_review")
  assert.deepEqual(result.reviewReasons, ["email_only_external_row"])
  assert.equal(result.candidateId, undefined)
  // No conflicts written for the V1 email-only policy — operator just sees
  // the row in the review queue with its reason code.
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityConflicts)!.size, 0)
})

test("No LinkedIn and no email returns blocked with no_identity_signal", async () => {
  const { db, store } = makeFakeFirestore()
  const result = await resolveExternalSupplyIdentity(
    db,
    makeRecord({
      name: "Dana Doe",
      currentCompany: "Acme",
    }),
    { now: () => now }
  )
  assert.equal(result.status, "blocked")
  assert.ok(result.reviewReasons.includes("no_identity_signal"))
  assert.ok(result.reviewReasons.includes("fuzzy_match_unavailable_v1"))
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityConflicts)!.size, 0)
})

test("Evidence on every path carries external_sourcing source + 0.4 confidence", async () => {
  const { db } = makeFakeFirestore()
  const url = "https://www.linkedin.com/in/eve"
  const r = await resolveExternalSupplyIdentity(
    db,
    makeRecord({
      canonicalLinkedInUrl: url,
      linkedinProfileHash: linkedinHash(url),
    }),
    { now: () => now }
  )
  assert.equal(r.evidence[0]!.source, "external_sourcing")
  assert.equal(r.evidence[0]!.confidence, 0.4)
  assert.match(r.evidence[0]!.summary, /source=juicebox/)
  assert.match(r.evidence[0]!.summary, /batchId=batch-1/)
  assert.match(r.evidence[0]!.summary, /recordId=record-1/)
})
