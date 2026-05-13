import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  BulkResumeBatchSchema,
  BulkResumeItemSchema,
  PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION,
  PA_COLLECTIONS,
  ResumeArtifactSchema,
  createBulkResumeArtifactId,
  createBulkResumeItemId,
  createBulkResumeItemIdempotencyKey,
  reduceBulkResumeItemStatus,
  summarizeBulkResumeItemCounts,
  type BulkResumeBatch,
  type BulkResumeItem,
  type BulkResumeItemStatus,
  type ResumeArtifact,
} from "@pa/core-types"

function nowIso(): string {
  return new Date().toISOString()
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function maskEmail(email: string): string {
  const normalized = normalizeEmail(email)
  const [localRaw, domainRaw] = normalized.split("@")
  const local = localRaw ?? ""
  const domain = domainRaw ?? ""
  if (!local || !domain) return "***"
  return `${local[0]}***@${domain}`
}

export function bulkResumeEmailHash(email: string): string {
  return sha256Hex(`email:${normalizeEmail(email)}`)
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T
}

function batchRef(db: Firestore, batchId: string) {
  return db.collection(PA_COLLECTIONS.bulkUploadBatches).doc(batchId)
}

function itemRef(db: Firestore, batchId: string, itemId: string) {
  return batchRef(db, batchId).collection(PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION).doc(itemId)
}

async function readBulkResumeItem(
  db: Firestore,
  batchId: string,
  itemId: string
): Promise<BulkResumeItem> {
  const snap = await itemRef(db, batchId, itemId).get()
  if (!snap.exists) throw new Error(`bulk_resume_item_missing:${batchId}/${itemId}`)
  return BulkResumeItemSchema.parse(snap.data())
}

async function patchBulkResumeItem(
  db: Firestore,
  batchId: string,
  itemId: string,
  patch: Record<string, unknown>
): Promise<BulkResumeItem> {
  await itemRef(db, batchId, itemId).set(stripUndefined(patch), { merge: true })
  return readBulkResumeItem(db, batchId, itemId)
}

export interface CreateBulkResumeBatchInput {
  batchId?: string
  label: string
  source: string
  jobId?: string | null
  createdBy: string
  now?: string
}

export async function createBulkResumeBatch(
  db: Firestore,
  input: CreateBulkResumeBatchInput
): Promise<BulkResumeBatch> {
  const ts = input.now ?? nowIso()
  const ref = input.batchId
    ? db.collection(PA_COLLECTIONS.bulkUploadBatches).doc(input.batchId)
    : db.collection(PA_COLLECTIONS.bulkUploadBatches).doc()
  const existing = await ref.get()
  if (existing.exists) return BulkResumeBatchSchema.parse(existing.data())

  const batch = BulkResumeBatchSchema.parse({
    batchId: ref.id,
    label: input.label,
    source: input.source,
    jobId: input.jobId || undefined,
    createdBy: input.createdBy,
    status: "draft",
    counts: summarizeBulkResumeItemCounts([]),
    createdAt: ts,
    updatedAt: ts,
  })
  await ref.set(stripUndefined(batch as unknown as Record<string, unknown>))
  return batch
}

export interface UpsertBulkResumeItemInput {
  batchId: string
  fileName: string
  fileSha256: string
  fileSizeBytes?: number
  storageUri?: string
  employerEmailHint?: string | null
  now?: string
}

export async function upsertBulkResumeItem(
  db: Firestore,
  input: UpsertBulkResumeItemInput
): Promise<{ item: BulkResumeItem; created: boolean }> {
  const ts = input.now ?? nowIso()
  const itemId = createBulkResumeItemId(input.batchId, input.fileSha256)
  const ref = itemRef(db, input.batchId, itemId)
  const existing = await ref.get()
  if (existing.exists) {
    return { item: BulkResumeItemSchema.parse(existing.data()), created: false }
  }

  const employerEmailHint = input.employerEmailHint?.trim() || undefined
  const item = BulkResumeItemSchema.parse({
    itemId,
    batchId: input.batchId,
    fileName: input.fileName,
    fileSha256: input.fileSha256,
    fileSizeBytes: input.fileSizeBytes,
    storageUri: input.storageUri,
    employerEmailHint,
    employerEmailHintHash: employerEmailHint ? bulkResumeEmailHash(employerEmailHint) : undefined,
    employerEmailHintMasked: employerEmailHint ? maskEmail(employerEmailHint) : undefined,
    status: "queued",
    retryCount: 0,
    idempotencyKey: createBulkResumeItemIdempotencyKey(input.batchId, input.fileSha256),
    createdAt: ts,
    updatedAt: ts,
  })
  await ref.set(stripUndefined(item as unknown as Record<string, unknown>))
  return { item, created: true }
}

export interface BulkResumeItemPointer {
  batchId: string
  itemId: string
  now?: string
}

export async function markBulkResumeItemParsing(
  db: Firestore,
  input: BulkResumeItemPointer
): Promise<{ item: BulkResumeItem }> {
  const current = await readBulkResumeItem(db, input.batchId, input.itemId)
  const ts = input.now ?? nowIso()
  const reduced = reduceBulkResumeItemStatus(current.status, "start_parsing", ts)
  const item = await patchBulkResumeItem(db, input.batchId, input.itemId, {
    status: reduced.state,
    updatedAt: ts,
    lastProcessedAt: ts,
  })
  return { item }
}

export async function markBulkResumeItemMissingEmailReview(
  db: Firestore,
  input: BulkResumeItemPointer & { errorReason?: string }
): Promise<{ item: BulkResumeItem }> {
  const current = await readBulkResumeItem(db, input.batchId, input.itemId)
  const ts = input.now ?? nowIso()
  const reduced = reduceBulkResumeItemStatus(current.status, "missing_email_review", ts)
  const item = await patchBulkResumeItem(db, input.batchId, input.itemId, {
    status: reduced.state,
    errorReason: input.errorReason ?? reduced.reason,
    updatedAt: ts,
    lastProcessedAt: ts,
  })
  return { item }
}

export async function markBulkResumeItemIdentityConflict(
  db: Firestore,
  input: BulkResumeItemPointer & {
    conflictId: string
    extractedEmail?: string | null
  }
): Promise<{ item: BulkResumeItem }> {
  const current = await readBulkResumeItem(db, input.batchId, input.itemId)
  const ts = input.now ?? nowIso()
  const reduced = reduceBulkResumeItemStatus(current.status, "identity_conflict", ts)
  const extractedEmail = input.extractedEmail?.trim() || undefined
  const item = await patchBulkResumeItem(db, input.batchId, input.itemId, {
    status: reduced.state,
    conflictId: input.conflictId,
    extractedEmailHash: extractedEmail ? bulkResumeEmailHash(extractedEmail) : current.extractedEmailHash,
    extractedEmailMasked: extractedEmail ? maskEmail(extractedEmail) : current.extractedEmailMasked,
    updatedAt: ts,
    lastProcessedAt: ts,
  })
  return { item }
}

export async function markBulkResumeItemParseFailed(
  db: Firestore,
  input: BulkResumeItemPointer & { errorReason: string }
): Promise<{ item: BulkResumeItem }> {
  const current = await readBulkResumeItem(db, input.batchId, input.itemId)
  const ts = input.now ?? nowIso()
  const reduced = reduceBulkResumeItemStatus(current.status, "parse_failed", ts)
  const item = await patchBulkResumeItem(db, input.batchId, input.itemId, {
    status: reduced.state,
    errorReason: input.errorReason,
    updatedAt: ts,
    lastProcessedAt: ts,
  })
  return { item }
}

export async function markBulkResumeItemRetryReady(
  db: Firestore,
  input: BulkResumeItemPointer
): Promise<{ item: BulkResumeItem }> {
  const current = await readBulkResumeItem(db, input.batchId, input.itemId)
  const ts = input.now ?? nowIso()
  const reduced = reduceBulkResumeItemStatus(current.status, "make_retry_ready", ts)
  const item = await patchBulkResumeItem(db, input.batchId, input.itemId, {
    status: reduced.state,
    retryCount: current.retryCount + 1,
    updatedAt: ts,
  })
  return { item }
}

export interface MarkBulkResumeItemParsedInput extends BulkResumeItemPointer {
  candidateId: string
  parsedCandidateResumeId?: string
  extractedEmail?: string | null
  candidateProfileSummary?: string
}

export async function markBulkResumeItemParsed(
  db: Firestore,
  input: MarkBulkResumeItemParsedInput
): Promise<{ item: BulkResumeItem; artifact: ResumeArtifact; createdArtifact: boolean }> {
  const current = await readBulkResumeItem(db, input.batchId, input.itemId)
  const ts = input.now ?? nowIso()
  const extractedEmail = input.extractedEmail?.trim() || undefined
  const extractedEmailHash = extractedEmail
    ? bulkResumeEmailHash(extractedEmail)
    : current.extractedEmailHash
  const resumeArtifactId = createBulkResumeArtifactId(
    input.candidateId,
    current.fileSha256,
    extractedEmailHash
  )
  const artifactRef = db.collection(PA_COLLECTIONS.resumeArtifacts).doc(resumeArtifactId)
  const artifactSnap = await artifactRef.get()
  const createdArtifact = !artifactSnap.exists
  const artifact = createdArtifact
    ? ResumeArtifactSchema.parse({
        resumeId: resumeArtifactId,
        candidateId: input.candidateId,
        status: "parsed",
        source: "employer_bulk",
        storageUri: current.storageUri,
        fileName: current.fileName,
        sha256: current.fileSha256,
        parsedCandidateResumeId: input.parsedCandidateResumeId,
        candidateProfileSummary: input.candidateProfileSummary,
        createdAt: ts,
        updatedAt: ts,
      })
    : ResumeArtifactSchema.parse(artifactSnap.data())
  if (createdArtifact) {
    await artifactRef.set(stripUndefined(artifact as unknown as Record<string, unknown>))
  }

  const reduced = reduceBulkResumeItemStatus(current.status, "parsed", ts)
  const item = await patchBulkResumeItem(db, input.batchId, input.itemId, {
    status: reduced.state,
    candidateId: input.candidateId,
    resumeArtifactId: artifact.resumeId,
    parsedCandidateResumeId: input.parsedCandidateResumeId,
    extractedEmailHash,
    extractedEmailMasked: extractedEmail ? maskEmail(extractedEmail) : current.extractedEmailMasked,
    idempotencyKey: createBulkResumeItemIdempotencyKey(
      input.batchId,
      current.fileSha256,
      extractedEmailHash
    ),
    updatedAt: ts,
    lastProcessedAt: ts,
  })

  await db.collection(PA_COLLECTIONS.users).doc(input.candidateId).set(
    stripUndefined({
      latestResumeArtifactId: artifact.resumeId,
      updatedAt: ts,
    }),
    { merge: true }
  )
  await db.collection(PA_COLLECTIONS.candidateSelfProfiles).doc(input.candidateId).set(
    stripUndefined({
      candidateId: input.candidateId,
      latestResumeArtifactId: artifact.resumeId,
      resumeStatus: "parsed",
      updatedAt: ts,
    }),
    { merge: true }
  )

  return { item, artifact, createdArtifact }
}

export async function recomputeBulkResumeBatchCounts(
  db: Firestore,
  batchId: string,
  now = nowIso()
): Promise<BulkResumeBatch> {
  const itemsSnap = await batchRef(db, batchId).collection(PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION).get()
  const statuses = itemsSnap.docs.map((doc) => {
    const data = BulkResumeItemSchema.parse(doc.data())
    return data.status
  })
  const counts = summarizeBulkResumeItemCounts(statuses as BulkResumeItemStatus[])
  let status: BulkResumeBatch["status"] = "draft"
  if (counts.parsing > 0) status = "processing"
  else if (counts.total === 0) status = "draft"
  else if (counts.queued > 0 || counts.retryReady > 0) status = "queued"
  else if (counts.review > 0 || counts.failed > 0) status = "completed_with_errors"
  else status = "completed"

  await batchRef(db, batchId).set(stripUndefined({ counts, status, updatedAt: now }), { merge: true })
  const snap = await batchRef(db, batchId).get()
  return BulkResumeBatchSchema.parse(snap.data())
}
