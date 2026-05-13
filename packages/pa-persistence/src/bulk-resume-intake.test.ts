import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION, PA_COLLECTIONS } from "@pa/core-types"
import {
  bulkResumeEmailHash,
  createBulkResumeBatch,
  markBulkResumeItemIdentityConflict,
  markBulkResumeItemMissingEmailReview,
  markBulkResumeItemParsed,
  markBulkResumeItemParseFailed,
  markBulkResumeItemParsing,
  markBulkResumeItemRetryReady,
  recomputeBulkResumeBatchCounts,
  upsertBulkResumeItem,
} from "./bulk-resume-intake.js"

type Store = Map<string, Map<string, Record<string, unknown>>>

const now = "2026-05-13T12:00:00.000Z"
const later = "2026-05-13T12:05:00.000Z"

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  let autoId = 0
  function col(path: string): Map<string, Record<string, unknown>> {
    if (!store.has(path)) store.set(path, new Map())
    return store.get(path)!
  }

  function docRef(collectionPath: string, id: string) {
    return {
      id,
      _collectionPath: collectionPath,
      _id: id,
      collection(subcollection: string) {
        return collection(`${collectionPath}/${id}/${subcollection}`)
      },
      async get() {
        const data = col(collectionPath).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const current = col(collectionPath).get(id)
        col(collectionPath).set(id, opts?.merge && current ? { ...current, ...data } : { ...data })
      },
    }
  }

  function collection(collectionPath: string) {
    return {
      doc(id?: string) {
        autoId += 1
        return docRef(collectionPath, id ?? `auto-${autoId}`)
      },
      async get() {
        return {
          docs: [...col(collectionPath).entries()].map(([id, data]) => ({
            id,
            data: () => data,
          })),
        }
      },
    }
  }

  const db = { collection }
  return { db: db as unknown as Firestore, store }
}

function itemsPath(batchId: string): string {
  return `${PA_COLLECTIONS.bulkUploadBatches}/${batchId}/${PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION}`
}

test("upsertBulkResumeItem stores retry hint in operator item doc without raw PII ids", async () => {
  const { db, store } = makeFakeFirestore()
  await createBulkResumeBatch(db, {
    batchId: "batch-1",
    label: "May resumes",
    source: "admin_upload",
    createdBy: "operator@wekruit.com",
    now,
  })

  const first = await upsertBulkResumeItem(db, {
    batchId: "batch-1",
    fileName: "resume.pdf",
    fileSha256: "a".repeat(64),
    storageUri: "gs://bucket/resume.pdf",
    employerEmailHint: "Candidate@Example.com",
    now,
  })
  const second = await upsertBulkResumeItem(db, {
    batchId: "batch-1",
    fileName: "resume.pdf",
    fileSha256: "a".repeat(64),
    storageUri: "gs://bucket/resume.pdf",
    employerEmailHint: "Candidate@Example.com",
    now,
  })

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(first.item.itemId.includes("Candidate@Example.com"), false)
  assert.equal(first.item.employerEmailHint, "Candidate@Example.com")
  assert.equal(first.item.employerEmailHintHash, bulkResumeEmailHash("Candidate@Example.com"))
  assert.equal(store.get(itemsPath("batch-1"))!.size, 1)
})

test("missing email review and identity conflict do not create candidate or artifact docs", async () => {
  const { db, store } = makeFakeFirestore()
  await createBulkResumeBatch(db, {
    batchId: "batch-1",
    label: "May resumes",
    source: "admin_upload",
    createdBy: "operator@wekruit.com",
    now,
  })
  const missingItem = await upsertBulkResumeItem(db, {
    batchId: "batch-1",
    fileName: "missing-email.pdf",
    fileSha256: "b".repeat(64),
    now,
  })
  await markBulkResumeItemParsing(db, { batchId: "batch-1", itemId: missingItem.item.itemId, now })

  const missing = await markBulkResumeItemMissingEmailReview(db, {
    batchId: "batch-1",
    itemId: missingItem.item.itemId,
    errorReason: "PDF parser found no email",
    now: later,
  })
  assert.equal(missing.item.status, "missing_email_review")
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.resumeArtifacts)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityConflicts)!.size, 0)

  const conflictItem = await upsertBulkResumeItem(db, {
    batchId: "batch-1",
    fileName: "mismatch.pdf",
    fileSha256: "c".repeat(64),
    employerEmailHint: "wrong@example.com",
    now,
  })
  await markBulkResumeItemParsing(db, { batchId: "batch-1", itemId: conflictItem.item.itemId, now })
  const conflict = await markBulkResumeItemIdentityConflict(db, {
    batchId: "batch-1",
    itemId: conflictItem.item.itemId,
    conflictId: "conflict-1",
    extractedEmail: "right@example.com",
    now: later,
  })
  assert.equal(conflict.item.status, "identity_conflict")
  assert.equal(conflict.item.conflictId, "conflict-1")
  assert.equal(store.get(PA_COLLECTIONS.users)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.resumeArtifacts)!.size, 0)
})

test("parsed success writes idempotent employer_bulk artifact and redacted candidate projection", async () => {
  const { db, store } = makeFakeFirestore()
  await createBulkResumeBatch(db, {
    batchId: "batch-1",
    label: "May resumes",
    source: "admin_upload",
    createdBy: "operator@wekruit.com",
    now,
  })
  const { item } = await upsertBulkResumeItem(db, {
    batchId: "batch-1",
    fileName: "resume.pdf",
    fileSha256: "d".repeat(64),
    storageUri: "gs://bucket/resume.pdf",
    employerEmailHint: "Candidate@Example.com",
    now,
  })
  await markBulkResumeItemParsing(db, { batchId: "batch-1", itemId: item.itemId, now })

  const first = await markBulkResumeItemParsed(db, {
    batchId: "batch-1",
    itemId: item.itemId,
    candidateId: "cand-1",
    parsedCandidateResumeId: "parsed-1",
    extractedEmail: "candidate@example.com",
    candidateProfileSummary: "Frontend engineer",
    now: later,
  })
  const second = await markBulkResumeItemParsed(db, {
    batchId: "batch-1",
    itemId: item.itemId,
    candidateId: "cand-1",
    parsedCandidateResumeId: "parsed-1",
    extractedEmail: "candidate@example.com",
    candidateProfileSummary: "Frontend engineer",
    now: later,
  })

  assert.equal(first.createdArtifact, true)
  assert.equal(second.createdArtifact, false)
  assert.equal(first.item.status, "parsed")
  assert.equal(first.item.candidateId, "cand-1")
  assert.equal(first.item.resumeArtifactId, first.artifact.resumeId)
  assert.equal(store.get(PA_COLLECTIONS.resumeArtifacts)!.size, 1)

  const artifact = store.get(PA_COLLECTIONS.resumeArtifacts)!.get(first.artifact.resumeId)!
  assert.equal(artifact.source, "employer_bulk")
  assert.equal(artifact.status, "parsed")
  assert.equal(artifact.parsedCandidateResumeId, "parsed-1")

  const user = store.get(PA_COLLECTIONS.users)!.get("cand-1")!
  assert.equal(user.latestResumeArtifactId, first.artifact.resumeId)
  const self = store.get(PA_COLLECTIONS.candidateSelfProfiles)!.get("cand-1")!
  assert.equal(self.latestResumeArtifactId, first.artifact.resumeId)
  assert.equal(self.resumeStatus, "parsed")
  assert.equal(JSON.stringify(self).includes("candidate@example.com"), false)
})

test("parse failure is retryable and batch count recomputation uses item statuses", async () => {
  const { db, store } = makeFakeFirestore()
  await createBulkResumeBatch(db, {
    batchId: "batch-1",
    label: "May resumes",
    source: "admin_upload",
    createdBy: "operator@wekruit.com",
    now,
  })
  const { item } = await upsertBulkResumeItem(db, {
    batchId: "batch-1",
    fileName: "broken.pdf",
    fileSha256: "e".repeat(64),
    now,
  })
  await markBulkResumeItemParsing(db, { batchId: "batch-1", itemId: item.itemId, now })
  await markBulkResumeItemParseFailed(db, {
    batchId: "batch-1",
    itemId: item.itemId,
    errorReason: "parser_timeout",
    now: later,
  })
  const retry = await markBulkResumeItemRetryReady(db, {
    batchId: "batch-1",
    itemId: item.itemId,
    now: later,
  })
  const batch = await recomputeBulkResumeBatchCounts(db, "batch-1", later)

  assert.equal(retry.item.status, "retry_ready")
  assert.equal(retry.item.retryCount, 1)
  assert.deepEqual(batch.counts, {
    total: 1,
    queued: 0,
    parsing: 0,
    parsed: 0,
    review: 0,
    failed: 0,
    retryReady: 1,
  })
  assert.equal(store.get(PA_COLLECTIONS.resumeArtifacts)!.size, 0)
})
