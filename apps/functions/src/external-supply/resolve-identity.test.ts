/**
 * Wave B Block C3 — `runResolveBatchIdentity` callable handler tests.
 *
 * Drives the handler against an in-memory Firestore fake (same shape as the
 * one used in `packages/pa-persistence/src/identity.test.ts`). Stubs auth
 * tokens directly because the helper is pure.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  candidateHandleHashMaterial,
  createCandidateHandleId,
  type ExternalCandidateRecord,
  type ExternalSourcingBatch,
} from "@pa/core-types"
import { runResolveBatchIdentity } from "./resolve-identity.js"

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
        const entries = Array.from(col(collectionName).entries()).filter(
          ([, data]) => data[field] === value
        )
        return {
          async get() {
            return {
              empty: entries.length === 0,
              docs: entries.map(([id, data]) => ({ id, data: () => data })),
            }
          },
          limit() {
            return {
              async get() {
                return {
                  empty: entries.length === 0,
                  docs: entries.map(([id, data]) => ({ id, data: () => data })),
                }
              },
            }
          },
        }
      },
    }
  }

  const db = { collection } as unknown as Firestore
  return { db, store }
}

function seedBatch(
  store: Store,
  args: { batchId: string; status: ExternalSourcingBatch["status"] }
) {
  store.get(PA_COLLECTIONS.externalSourcingBatches)!.set(args.batchId, {
    batchId: args.batchId,
    source: "juicebox",
    status: args.status,
    rowCount: 0,
    validLinkedInCount: 0,
    validEmailCount: 0,
    duplicateCount: 0,
    needsReviewCount: 0,
    readyToProfileCount: 0,
    rawFileRef: {
      storageUri: "gs://bucket/test",
      mime: "application/json",
      sha256: "x".repeat(64),
      sizeBytes: 1024,
    },
    normalizerVersion: "ext-norm-2026-05",
    importedBy: "test-operator",
    createdAt: now,
  })
}

function seedRecord(
  store: Store,
  over: Partial<ExternalCandidateRecord> & { recordId: string; batchId: string }
): ExternalCandidateRecord {
  const base: ExternalCandidateRecord = {
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
  store.get(PA_COLLECTIONS.externalCandidateRecords)!.set(over.recordId, base)
  return base
}

function seedHandle(
  store: Store,
  args: { kind: "linkedin" | "email"; hash: string; candidateId: string }
) {
  const handleId = createCandidateHandleId(args.kind, args.hash)
  store.get(PA_COLLECTIONS.candidateHandles)!.set(handleId, {
    handleId,
    candidateId: args.candidateId,
    kind: args.kind,
    handleHash: args.hash,
    source: args.kind === "linkedin" ? "external_sourcing" : "candidate",
    createdAt: now,
  })
}

const ADMIN_AUTH = {
  uid: "operator-1",
  token: { email: "admin@wekruit.com", email_verified: true },
}

test("runResolveBatchIdentity rejects when auth is missing", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () => runResolveBatchIdentity({ batchId: "batch-1" }, undefined, { db }),
    (err) => err instanceof HttpsError && err.code === "unauthenticated"
  )
})

test("runResolveBatchIdentity rejects non-wekruit email", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () =>
      runResolveBatchIdentity(
        { batchId: "batch-1" },
        { uid: "x", token: { email: "outsider@gmail.com", email_verified: true } },
        { db }
      ),
    (err) => err instanceof HttpsError && err.code === "permission-denied"
  )
})

test("runResolveBatchIdentity throws when batchId missing", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () => runResolveBatchIdentity({}, ADMIN_AUTH, { db }),
    (err) => err instanceof HttpsError && err.code === "invalid-argument"
  )
})

test("runResolveBatchIdentity throws when batch not found", async () => {
  const { db } = makeFakeFirestore()
  await assert.rejects(
    () => runResolveBatchIdentity({ batchId: "missing" }, ADMIN_AUTH, { db }),
    (err) => err instanceof HttpsError && err.code === "not-found"
  )
})

test("runResolveBatchIdentity throws when batch is not in normalized state", async () => {
  const { db, store } = makeFakeFirestore()
  seedBatch(store, { batchId: "batch-x", status: "completed" })
  await assert.rejects(
    () => runResolveBatchIdentity({ batchId: "batch-x" }, ADMIN_AUTH, { db }),
    (err) => err instanceof HttpsError && err.code === "failed-precondition"
  )
})

test("end-to-end: mixed batch resolves into create/merge/pending/blocked", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-mix"
  seedBatch(store, { batchId, status: "normalized" })

  // Row 1 — novel LinkedIn → create_new.
  const url1 = "https://www.linkedin.com/in/novel"
  seedRecord(store, {
    recordId: "r1",
    batchId,
    canonicalLinkedInUrl: url1,
    linkedinProfileHash: linkedinHash(url1),
  })

  // Row 2 — LinkedIn hits existing candidate → merge_existing.
  const url2 = "https://www.linkedin.com/in/existing"
  const li2 = linkedinHash(url2)
  seedHandle(store, { kind: "linkedin", hash: li2, candidateId: "cand-existing" })
  store.get(PA_COLLECTIONS.users)!.set("cand-existing", {
    id: "cand-existing",
    candidateLifecycleState: "profile_ready",
    linkedinUrl: url2,
    createdAt: now,
  })
  seedRecord(store, {
    recordId: "r2",
    batchId,
    canonicalLinkedInUrl: url2,
    linkedinProfileHash: li2,
  })

  // Row 3 — email-only → needs_review.
  seedRecord(store, {
    recordId: "r3",
    batchId,
    emails: [{ value: "lonely@example.com", hash: emailHash("lonely@example.com") }],
  })

  // Row 4 — no linkedin / no email → blocked.
  seedRecord(store, {
    recordId: "r4",
    batchId,
    name: "Anonymous",
    currentCompany: "Acme",
  })

  // Row 5 — already resolved → skipped on idempotent re-run.
  seedRecord(store, {
    recordId: "r5",
    batchId,
    identityResolutionStatus: "merge_existing",
    resolvedUserId: "cand-already",
  })

  const result = await runResolveBatchIdentity(
    { batchId },
    ADMIN_AUTH,
    { db, now: () => now }
  )

  assert.equal(result.ok, true)
  assert.equal(result.batchId, batchId)
  assert.equal(result.processed, 4) // r1..r4
  assert.equal(result.created, 1)   // r1
  assert.equal(result.merged, 1)    // r2
  assert.equal(result.pending, 1)   // r3
  assert.equal(result.blocked, 1)   // r4
  assert.equal(result.skipped, 1)   // r5 (already resolved)

  // Batch advanced to ready_for_review with counters.
  const batch = store.get(PA_COLLECTIONS.externalSourcingBatches)!.get(batchId)!
  assert.equal(batch.status, "ready_for_review")
  assert.equal(batch.needsReviewCount, 1)
  assert.equal(batch.readyToProfileCount, 2)

  // Each record updated with its outcome.
  const r1Doc = store.get(PA_COLLECTIONS.externalCandidateRecords)!.get("r1")!
  assert.equal(r1Doc.identityResolutionStatus, "create_new")
  const r2Doc = store.get(PA_COLLECTIONS.externalCandidateRecords)!.get("r2")!
  assert.equal(r2Doc.identityResolutionStatus, "merge_existing")
  assert.equal(r2Doc.resolvedUserId, "cand-existing")
  const r3Doc = store.get(PA_COLLECTIONS.externalCandidateRecords)!.get("r3")!
  assert.equal(r3Doc.identityResolutionStatus, "needs_review")
  const r4Doc = store.get(PA_COLLECTIONS.externalCandidateRecords)!.get("r4")!
  assert.equal(r4Doc.identityResolutionStatus, "blocked")
})

test("runResolveBatchIdentity is idempotent on re-run", async () => {
  const { db, store } = makeFakeFirestore()
  const batchId = "batch-idem"
  seedBatch(store, { batchId, status: "normalized" })
  const url = "https://www.linkedin.com/in/idem"
  const li = linkedinHash(url)
  seedHandle(store, { kind: "linkedin", hash: li, candidateId: "cand-idem" })
  store.get(PA_COLLECTIONS.users)!.set("cand-idem", {
    id: "cand-idem",
    candidateLifecycleState: "profile_ready",
    linkedinUrl: url,
    createdAt: now,
  })
  seedRecord(store, {
    recordId: "r-idem",
    batchId,
    canonicalLinkedInUrl: url,
    linkedinProfileHash: li,
  })

  const first = await runResolveBatchIdentity(
    { batchId },
    ADMIN_AUTH,
    { db, now: () => now }
  )
  assert.equal(first.merged, 1)
  assert.equal(first.skipped, 0)

  // After Wave A's batch reached `ready_for_review`. For idempotency, we
  // restage the batch to `resolving_identity` (which the handler also
  // accepts) and verify the second pass no-ops on the already-resolved
  // record.
  store.get(PA_COLLECTIONS.externalSourcingBatches)!.set(batchId, {
    ...store.get(PA_COLLECTIONS.externalSourcingBatches)!.get(batchId)!,
    status: "resolving_identity",
  })
  const second = await runResolveBatchIdentity(
    { batchId },
    ADMIN_AUTH,
    { db, now: () => now }
  )
  assert.equal(second.processed, 0)
  assert.equal(second.skipped, 1)
  // Source-link still single — no duplicate written.
  assert.equal(store.get(PA_COLLECTIONS.candidateSourceLinks)!.size, 1)
})
