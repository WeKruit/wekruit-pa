import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION, PA_COLLECTIONS } from "@pa/core-types"
import {
  authorizeBulkResumeAdmin,
  runBulkResumeAddItems,
  runBulkResumeCreateBatch,
  runBulkResumeProcessBatch,
  runBulkResumeRetryItem,
  type BulkResumeStorage,
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
      async add(data: Record<string, unknown>) {
        autoId += 1
        const ref = docRef(collectionPath, `auto-${autoId}`)
        await ref.set(data)
        return ref
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

  return { db: { collection } as unknown as Firestore, store }
}

function makeFakeStorage() {
  const saved = new Map<string, { bytes: Buffer; opts: Record<string, unknown> | undefined }>()
  const storage: BulkResumeStorage = {
    bucket() {
      return {
        name: "fake-bucket",
        file(path: string) {
          return {
            async save(bytes: Buffer, opts?: Record<string, unknown>) {
              saved.set(path, { bytes, opts })
            },
          }
        },
      }
    },
  }
  return { storage, saved }
}

function pdfBase64(body = "candidate@example.com") {
  return Buffer.from(`%PDF-1.4\n${body}\n%%EOF`).toString("base64")
}

function itemPath(batchId: string): string {
  return `${PA_COLLECTIONS.bulkUploadBatches}/${batchId}/${PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION}`
}

async function seedQueuedItem(args?: { employerEmailHint?: string }) {
  const { db, store } = makeFakeFirestore()
  const { storage, saved } = makeFakeStorage()
  const created = await runBulkResumeCreateBatch(
    { label: "May resumes" },
    { db, nowIso: () => now },
    "operator@wekruit.com",
  )
  const batch = created.batch
  const added = await runBulkResumeAddItems(
    {
      batchId: batch.batchId,
      items: [
        {
          fileName: "resume.pdf",
          resumeBase64: pdfBase64(),
          employerEmailHint: args?.employerEmailHint,
        },
      ],
    },
    { db, storage, nowIso: () => now },
  )
  return { db, store, saved, batch, item: added.items[0]! }
}

test("authorizeBulkResumeAdmin rejects non-admin callable callers", () => {
  const original = process.env.PA_ADMIN_TOKEN
  process.env.PA_ADMIN_TOKEN = "bulk-secret"
  assert.throws(
    () => authorizeBulkResumeAdmin({ auth: { token: { email: "person@example.com" } } }),
    /admin only/,
  )
  assert.equal(
    authorizeBulkResumeAdmin({ auth: { uid: "u1", token: { email: "operator@wekruit.com" } } }),
    "operator@wekruit.com",
  )
  assert.equal(
    authorizeBulkResumeAdmin({ auth: { uid: "u2", token: { admin: true } } }),
    "u2",
  )
  assert.equal(
    authorizeBulkResumeAdmin({ auth: { uid: "u3", token: { email: "ops@wekruit.com" } } }),
    "ops@wekruit.com",
  )
  assert.equal(authorizeBulkResumeAdmin({ data: { adminToken: "bulk-secret" } }), "admin-token")
  if (original !== undefined) process.env.PA_ADMIN_TOKEN = original
  else delete process.env.PA_ADMIN_TOKEN
})

test("add items uploads PDF bytes to default bucket and stores item metadata", async () => {
  const { saved, item, store, batch } = await seedQueuedItem({ employerEmailHint: "candidate@example.com" })
  assert.equal(saved.size, 1)
  const [path, upload] = [...saved.entries()][0]!
  assert.match(path, /^pa-bulk-resumes\/auto-1\/bulk_item_[a-f0-9]{32}\.pdf$/)
  assert.equal(path.includes("candidate@example.com"), false)
  assert.equal(upload.bytes.toString().startsWith("%PDF-1.4"), true)
  assert.equal(item.status, "queued")
  assert.equal(item.storageUri, `gs://fake-bucket/${path}`)
  assert.equal(item.created, true)
  assert.equal("employerEmailHint" in item, false)
  assert.equal(store.get(itemPath(batch.batchId))!.get(item.itemId)!.employerEmailHint, "candidate@example.com")
})

test("add items rejects invalid base64 and non-PDF payloads", async () => {
  const { db } = makeFakeFirestore()
  const { storage } = makeFakeStorage()
  const created = await runBulkResumeCreateBatch(
    { label: "May resumes" },
    { db, nowIso: () => now },
    "operator@wekruit.com",
  )

  await assert.rejects(
    () =>
      runBulkResumeAddItems(
        { batchId: created.batch.batchId, items: [{ fileName: "resume.pdf", resumeBase64: "not base64!!" }] },
        { db, storage, nowIso: () => now },
      ),
    /invalid base64/,
  )

  await assert.rejects(
    () =>
      runBulkResumeAddItems(
        {
          batchId: created.batch.batchId,
          items: [{ fileName: "resume.pdf", resumeBase64: Buffer.from("hello").toString("base64") }],
        },
        { db, storage, nowIso: () => now },
      ),
    /not PDF-like/,
  )
  await assert.rejects(
    () =>
      runBulkResumeAddItems(
        { batchId: "missing-batch", items: [{ fileName: "resume.pdf", resumeBase64: pdfBase64() }] },
        { db, storage, nowIso: () => now },
      ),
    /bulk_resume_batch_missing/,
  )
})

test("process batch marks missing PDF email for review without candidate identity", async () => {
  const { db, store, batch, item } = await seedQueuedItem({ employerEmailHint: "hint@example.com" })
  const result = await runBulkResumeProcessBatch(
    { batchId: batch.batchId },
    {
      db,
      nowIso: () => later,
      fetchPdf: async () => ({ bytes: Buffer.from("pdf") }),
      ingestCv: async () => ({ ok: false, reason: "missing_extracted_email" }),
    },
  )

  assert.equal(result.processed, 1)
  const persisted = store.get(itemPath(batch.batchId))!.get(item.itemId)!
  assert.equal(persisted.status, "missing_email_review")
  assert.equal(persisted.candidateId, undefined)
  assert.equal(store.get(PA_COLLECTIONS.resumeArtifacts)!.size, 0)
  assert.equal(store.get(PA_COLLECTIONS.candidateIdentityConflicts)!.size, 0)
})

test("process batch marks employer/PDF mismatch as identity conflict and keeps conflict id", async () => {
  const { db, store, batch, item } = await seedQueuedItem({ employerEmailHint: "wrong@example.com" })
  const result = await runBulkResumeProcessBatch(
    { batchId: batch.batchId },
    {
      db,
      nowIso: () => later,
      fetchPdf: async () => ({ bytes: Buffer.from("pdf") }),
      ingestCv: async (_input, deps) => {
        await deps.resolveCandidateIdentity!(deps.db!, {
          extractedEmail: "right@example.com",
          employerEmailHint: "wrong@example.com",
          source: "admin",
        })
        return {
          ok: false,
          reason: "identity_conflict",
        }
      },
      resolveCandidateIdentity: async () => ({
        outcome: "identity_conflict",
        conflict: {
          conflictId: "conflict-1",
          kind: "pdf_email_employer_email_mismatch",
          status: "open",
          evidence: [],
          payloadRedacted: {},
          createdAt: later,
        },
      }),
    },
  )

  assert.equal(result.processed, 1)
  const persisted = store.get(itemPath(batch.batchId))!.get(item.itemId)!
  assert.equal(persisted.status, "identity_conflict")
  assert.equal(persisted.conflictId, "conflict-1")
  assert.equal(persisted.candidateId, undefined)
  assert.equal(store.get(PA_COLLECTIONS.resumeArtifacts)!.size, 0)
})

test("process batch marks successful parse and creates employer bulk artifact", async () => {
  const { db, store, batch, item } = await seedQueuedItem({ employerEmailHint: "candidate@example.com" })
  const suppressionCalls: string[] = []
  const result = await runBulkResumeProcessBatch(
    { batchId: batch.batchId },
    {
      db,
      nowIso: () => later,
      fetchPdf: async () => ({ bytes: Buffer.from("pdf") }),
      ingestCv: async (input, deps) => {
        assert.equal(input.requireExtractedEmail, true)
        assert.equal(input.identitySource, "admin")
        assert.equal(input.employerEmailHint, "candidate@example.com")
        assert.equal(input.userId, item.itemId)
        assert.equal(deps.skipLimitEnforcement, true)
        assert.deepEqual(await deps.checkGate!(db, "any", later), {
          open: true,
          reason: "bulk_resume_intake",
        })
        assert.equal(await deps.lookupUserForFollowup!(db, "cand-1"), null)
        assert.equal(await deps.isFlagEnabled!(db, "flag", "cand-1"), false)
        await deps.enqueueCvConfirmFn!(db, { userId: "cand-1", resumeId: "parsed-1", parsed: {} })
        await deps.enqueueOutboundFollowup!(db, "out-1", {})
        suppressionCalls.push("checked")
        return {
          ok: true,
          userId: "cand-1",
          resumeId: "parsed-1",
          extractedEmail: "candidate@example.com",
          candidateProfileSummary: "Frontend engineer",
        }
      },
    },
  )

  assert.equal(result.processed, 1)
  assert.deepEqual(suppressionCalls, ["checked"])
  const persisted = store.get(itemPath(batch.batchId))!.get(item.itemId)!
  assert.equal(persisted.status, "parsed")
  assert.equal(persisted.candidateId, "cand-1")
  assert.equal(persisted.parsedCandidateResumeId, "parsed-1")
  assert.equal(store.get(PA_COLLECTIONS.resumeArtifacts)!.size, 1)
  const artifact = [...store.get(PA_COLLECTIONS.resumeArtifacts)!.values()][0]!
  assert.equal(artifact.source, "employer_bulk")
  assert.equal(artifact.parsedCandidateResumeId, "parsed-1")
})

test("retry item only requeues review or failed statuses and recomputes counts", async () => {
  const { db, store, batch, item } = await seedQueuedItem()
  await runBulkResumeProcessBatch(
    { batchId: batch.batchId },
    {
      db,
      nowIso: () => later,
      fetchPdf: async () => ({ bytes: Buffer.from("pdf") }),
      ingestCv: async () => ({ ok: false, reason: "llm_parse_failed" }),
    },
  )

  const retried = await runBulkResumeRetryItem(
    { batchId: batch.batchId, itemId: item.itemId },
    { db, nowIso: () => later },
  )
  const persisted = store.get(itemPath(batch.batchId))!.get(item.itemId)!

  assert.equal(retried.item.status, "retry_ready")
  assert.equal(persisted.retryCount, 1)
  assert.equal(retried.batch.counts.retryReady, 1)
  await assert.rejects(
    () => runBulkResumeRetryItem({ batchId: batch.batchId, itemId: "missing" }, { db }),
    /bulk_resume_item_missing/,
  )
})
