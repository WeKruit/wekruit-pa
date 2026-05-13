import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { getFirestore } from "firebase-admin/firestore"
import { getStorage } from "firebase-admin/storage"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { defineSecret } from "firebase-functions/params"
import { z } from "zod"
import {
  BulkResumeItemSchema,
  PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION,
  PA_COLLECTIONS,
  createBulkResumeItemId,
  type BulkResumeBatch,
  type BulkResumeItem,
  type BulkResumeItemStatus,
  type CandidateIdentityResolution,
} from "@pa/core-types"
import {
  createBulkResumeBatch,
  markBulkResumeItemIdentityConflict,
  markBulkResumeItemMissingEmailReview,
  markBulkResumeItemParsed,
  markBulkResumeItemParseFailed,
  markBulkResumeItemParsing,
  markBulkResumeItemRetryReady,
  recomputeBulkResumeBatchCounts,
  resolveCandidateIdentity as defaultResolveCandidateIdentity,
  upsertBulkResumeItem,
  type ResolveCandidateIdentityInput,
} from "@pa/pa-persistence"
import {
  ingestCv as defaultIngestCv,
  type IngestCvDeps,
  type IngestCvInput,
  type IngestCvResult,
} from "./cv-ingest/cv-ingest.js"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")
const MAX_BULK_PDF_BYTES = 6 * 1024 * 1024
const STORAGE_PREFIX = "pa-bulk-resumes"

const CreateBatchInputSchema = z.object({
  label: z.string().trim().min(1).max(200),
  jobId: z.string().trim().min(1).optional(),
  adminToken: z.string().optional(),
})

const AddItemFileSchema = z.object({
  fileName: z.string().trim().min(1).max(500),
  resumeBase64: z.string().min(1),
  employerEmailHint: z.string().email().optional(),
})

const AddItemsInputSchema = z.object({
  batchId: z.string().min(1),
  items: z.array(AddItemFileSchema).min(1).max(100),
  adminToken: z.string().optional(),
})

const ProcessBatchInputSchema = z.object({
  batchId: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(25),
  adminToken: z.string().optional(),
})

const RetryItemInputSchema = z.object({
  batchId: z.string().min(1),
  itemId: z.string().min(1),
  adminToken: z.string().optional(),
})

type CreateBatchInput = z.infer<typeof CreateBatchInputSchema>
type AddItemsInput = z.infer<typeof AddItemsInputSchema>
type ProcessBatchInput = z.infer<typeof ProcessBatchInputSchema>
type RetryItemInput = z.infer<typeof RetryItemInputSchema>

export type BulkResumeItemProjection = Omit<BulkResumeItem, "employerEmailHint">

export type BulkResumeIngestResult = IngestCvResult & {
  conflictId?: string
  extractedEmail?: string | null
  candidateProfileSummary?: string
}

export type BulkResumeIngestFn = (
  input: IngestCvInput,
  deps: IngestCvDeps
) => Promise<BulkResumeIngestResult>

export interface BulkResumeStorage {
  bucket(name?: string): {
    name: string
    file(path: string): {
      save?(bytes: Buffer, opts?: Record<string, unknown>): Promise<void>
      download?(): Promise<[Buffer]>
    }
  }
}

export interface BulkResumeDeps {
  db: Firestore
  storage?: BulkResumeStorage
  ingestCv?: BulkResumeIngestFn
  fetchPdf?: (item: BulkResumeItem) => Promise<{ bytes: Uint8Array; contentType?: string }>
  resolveCandidateIdentity?: (
    db: Firestore,
    input: ResolveCandidateIdentityInput
  ) => Promise<CandidateIdentityResolution>
  nowIso?: () => string
  log?: (event: string, payload?: Record<string, unknown>) => void
}

type CallableAuthLike = {
  auth?: {
    uid?: string
    token?: {
      admin?: unknown
      email?: unknown
    }
  }
  data?: unknown
}

function nowIso(): string {
  return new Date().toISOString()
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function decodeBase64Pdf(fileName: string, resumeBase64: string): Buffer {
  const raw = (resumeBase64.includes(",") ? resumeBase64.split(",").pop()! : resumeBase64).replace(/\s/g, "")
  if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new HttpsError("invalid-argument", `invalid base64 PDF: ${fileName}`)
  }
  const bytes = Buffer.from(raw, "base64")
  if (bytes.length === 0 || bytes.length > MAX_BULK_PDF_BYTES) {
    throw new HttpsError("invalid-argument", `PDF size out of range: ${fileName}`)
  }
  if (bytes.subarray(0, 4).toString("utf8") !== "%PDF") {
    throw new HttpsError("invalid-argument", `file is not PDF-like: ${fileName}`)
  }
  return bytes
}

function hydrateBulkResumeSecrets(): void {
  try {
    const openAiKey = PA_OPENAI_AGENT_API_KEY.value().trim()
    if (openAiKey) process.env.PA_OPENAI_AGENT_API_KEY = openAiKey
    else delete process.env.PA_OPENAI_AGENT_API_KEY
  } catch {
    delete process.env.PA_OPENAI_AGENT_API_KEY
  }
  try {
    const anthropicKey = ANTHROPIC_API_KEY.value().trim()
    if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey
    else delete process.env.ANTHROPIC_API_KEY
  } catch {
    delete process.env.ANTHROPIC_API_KEY
  }
}

function itemCollection(db: Firestore, batchId: string) {
  return db
    .collection(PA_COLLECTIONS.bulkUploadBatches)
    .doc(batchId)
    .collection(PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION)
}

async function readBulkResumeItem(
  db: Firestore,
  batchId: string,
  itemId: string
): Promise<BulkResumeItem> {
  const snap = await itemCollection(db, batchId).doc(itemId).get()
  if (!snap.exists) throw new HttpsError("not-found", `bulk_resume_item_missing:${batchId}/${itemId}`)
  return BulkResumeItemSchema.parse(snap.data())
}

async function listProcessableItems(
  db: Firestore,
  input: ProcessBatchInput
): Promise<BulkResumeItem[]> {
  const snap = await itemCollection(db, input.batchId).get()
  const items = snap.docs.map((doc) => BulkResumeItemSchema.parse(doc.data()))
  return items
    .filter((item) => item.status === "queued" || item.status === "retry_ready")
    .slice(0, input.limit)
}

function getDepsNow(deps: BulkResumeDeps): string {
  return (deps.nowIso ?? nowIso)()
}

function projectItem(item: BulkResumeItem): BulkResumeItemProjection {
  const { employerEmailHint: _raw, ...projection } = item
  return projection
}

async function assertBatchExists(db: Firestore, batchId: string): Promise<void> {
  const snap = await db.collection(PA_COLLECTIONS.bulkUploadBatches).doc(batchId).get()
  if (!snap.exists) throw new HttpsError("not-found", `bulk_resume_batch_missing:${batchId}`)
}

export function authorizeBulkResumeAdmin(req: CallableAuthLike): string {
  const email = typeof req.auth?.token?.email === "string" ? req.auth.token.email.trim().toLowerCase() : ""
  if (email.endsWith("@wekruit.com") || email === "indolencorlol@gmail.com") {
    return email
  }
  const { uid } = authorizeAdminCallable(req)
  return email || uid
}

export async function runBulkResumeCreateBatch(
  rawInput: unknown,
  deps: Pick<BulkResumeDeps, "db" | "nowIso">,
  actor: string
): Promise<{ ok: true; batch: BulkResumeBatch }> {
  const parsed = CreateBatchInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const input: CreateBatchInput = parsed.data
  const batch = await createBulkResumeBatch(deps.db, {
    label: input.label,
    source: "admin_upload",
    jobId: input.jobId,
    createdBy: actor,
    now: deps.nowIso?.(),
  })
  return { ok: true, batch }
}

export async function runBulkResumeAddItems(
  rawInput: unknown,
  deps: Pick<BulkResumeDeps, "db" | "storage" | "nowIso">
): Promise<{ ok: true; batch: BulkResumeBatch; items: Array<BulkResumeItemProjection & { created: boolean }> }> {
  const parsed = AddItemsInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const input: AddItemsInput = parsed.data
  await assertBatchExists(deps.db, input.batchId)
  const storage = deps.storage ?? (getStorage() as unknown as BulkResumeStorage)
  const bucket = storage.bucket()
  const items: Array<BulkResumeItemProjection & { created: boolean }> = []
  const ts = deps.nowIso?.()

  for (const file of input.items) {
    const bytes = decodeBase64Pdf(file.fileName, file.resumeBase64)
    const sha = sha256Hex(bytes)
    const itemId = createBulkResumeItemId(input.batchId, sha)
    const objectPath = `${STORAGE_PREFIX}/${input.batchId}/${itemId}.pdf`
    const storageFile = bucket.file(objectPath)
    if (!storageFile.save) throw new Error("bulk_resume_storage_save_unavailable")
    await storageFile.save(bytes, {
      contentType: "application/pdf",
      resumable: false,
      metadata: {
        metadata: stripUndefined({
          batchId: input.batchId,
          fileName: file.fileName,
          sha256: sha,
        }),
      },
    })
    const { item, created } = await upsertBulkResumeItem(deps.db, {
      batchId: input.batchId,
      fileName: file.fileName,
      fileSha256: sha,
      fileSizeBytes: bytes.length,
      storageUri: `gs://${bucket.name}/${objectPath}`,
      employerEmailHint: file.employerEmailHint,
      now: ts,
    })
    items.push({ ...projectItem(item), created })
  }

  const batch = await recomputeBulkResumeBatchCounts(deps.db, input.batchId, ts)
  return { ok: true, batch, items }
}

function parseGsUri(storageUri: string): { bucketName: string; path: string } {
  const match = storageUri.match(/^gs:\/\/([^/]+)\/(.+)$/)
  if (!match) throw new Error(`invalid_storage_uri:${storageUri}`)
  return { bucketName: match[1]!, path: match[2]! }
}

async function readStoragePdf(
  storage: BulkResumeStorage,
  item: BulkResumeItem
): Promise<{ bytes: Uint8Array; contentType?: string }> {
  if (!item.storageUri) throw new Error(`missing_storage_uri:${item.itemId}`)
  const { bucketName, path } = parseGsUri(item.storageUri)
  const file = storage.bucket(bucketName).file(path)
  if (!file.download) throw new Error("bulk_resume_storage_download_unavailable")
  const [bytes] = await file.download()
  return { bytes, contentType: "application/pdf" }
}

function conflictIdFromResult(result: BulkResumeIngestResult): string | undefined {
  const value = result.conflictId
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function optionalStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" && field.trim() ? field.trim() : undefined
}

async function processOneItem(
  item: BulkResumeItem,
  deps: BulkResumeDeps
): Promise<{ itemId: string; status: BulkResumeItemStatus }> {
  const ts = getDepsNow(deps)
  await markBulkResumeItemParsing(deps.db, { batchId: item.batchId, itemId: item.itemId, now: ts })
  const ingestCv = deps.ingestCv ?? defaultIngestCv

  try {
    let extractedEmail: string | null = null
    let conflictId: string | null = null
    const resolveCandidateIdentity = deps.resolveCandidateIdentity ?? defaultResolveCandidateIdentity
    const result = await ingestCv(
      {
        userId: item.itemId,
        mediaUrl: item.storageUri ?? "",
        employerEmailHint: item.employerEmailHint,
        identitySource: "admin",
        requireExtractedEmail: true,
      },
      {
        db: deps.db,
        fetchPdf: () =>
          deps.fetchPdf
            ? deps.fetchPdf(item)
            : readStoragePdf(deps.storage ?? (getStorage() as unknown as BulkResumeStorage), item),
        nowIso: deps.nowIso,
        log: deps.log,
        checkGate: async () => ({ open: true, reason: "bulk_resume_intake" }),
        skipLimitEnforcement: true,
        isFlagEnabled: async () => false,
        enqueueCvConfirmFn: async () => undefined,
        enqueueOutboundFollowup: async () => undefined,
        lookupUserForFollowup: async () => null,
        resolveCandidateIdentity: async (db, input) => {
          extractedEmail = typeof input.extractedEmail === "string" ? input.extractedEmail.trim() : null
          const resolution = await resolveCandidateIdentity(db, input)
          if (resolution.outcome === "identity_conflict") {
            conflictId = resolution.conflict.conflictId
          }
          return resolution
        },
      }
    )

    if (result.ok) {
      const parsed = await markBulkResumeItemParsed(deps.db, {
        batchId: item.batchId,
        itemId: item.itemId,
        candidateId: result.userId,
        parsedCandidateResumeId: result.resumeId,
        extractedEmail: optionalStringField(result, "extractedEmail") ?? extractedEmail,
        candidateProfileSummary: optionalStringField(result, "candidateProfileSummary"),
        now: getDepsNow(deps),
      })
      return { itemId: item.itemId, status: parsed.item.status }
    }

    if (result.reason === "missing_extracted_email") {
      const missing = await markBulkResumeItemMissingEmailReview(deps.db, {
        batchId: item.batchId,
        itemId: item.itemId,
        errorReason: result.reason,
        now: getDepsNow(deps),
      })
      return { itemId: item.itemId, status: missing.item.status }
    }

    if (result.reason === "identity_conflict") {
      const conflict = await markBulkResumeItemIdentityConflict(deps.db, {
        batchId: item.batchId,
        itemId: item.itemId,
        conflictId: conflictIdFromResult(result) ?? conflictId ?? `identity_conflict_unavailable_${item.itemId}`,
        extractedEmail: optionalStringField(result, "extractedEmail") ?? extractedEmail,
        now: getDepsNow(deps),
      })
      return { itemId: item.itemId, status: conflict.item.status }
    }

    const failed = await markBulkResumeItemParseFailed(deps.db, {
      batchId: item.batchId,
      itemId: item.itemId,
      errorReason: result.reason,
      now: getDepsNow(deps),
    })
    return { itemId: item.itemId, status: failed.item.status }
  } catch (err) {
    const failed = await markBulkResumeItemParseFailed(deps.db, {
      batchId: item.batchId,
      itemId: item.itemId,
      errorReason: err instanceof Error ? err.message : String(err),
      now: getDepsNow(deps),
    })
    return { itemId: item.itemId, status: failed.item.status }
  }
}

export async function runBulkResumeProcessBatch(
  rawInput: unknown,
  deps: BulkResumeDeps
): Promise<{
  ok: true
  processed: number
  results: Array<{ itemId: string; status: BulkResumeItemStatus }>
  batch: BulkResumeBatch
}> {
  const parsed = ProcessBatchInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const input: ProcessBatchInput = parsed.data
  await assertBatchExists(deps.db, input.batchId)
  const items = await listProcessableItems(deps.db, input)
  const results: Array<{ itemId: string; status: BulkResumeItemStatus }> = []

  for (const item of items) {
    results.push(await processOneItem(item, deps))
  }

  const batch = await recomputeBulkResumeBatchCounts(deps.db, input.batchId, getDepsNow(deps))
  return { ok: true, processed: results.length, results, batch }
}

export async function runBulkResumeRetryItem(
  rawInput: unknown,
  deps: Pick<BulkResumeDeps, "db" | "nowIso">
): Promise<{ ok: true; item: BulkResumeItemProjection; batch: BulkResumeBatch }> {
  const parsed = RetryItemInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const input: RetryItemInput = parsed.data
  await assertBatchExists(deps.db, input.batchId)
  const item = await readBulkResumeItem(deps.db, input.batchId, input.itemId)
  if (!["missing_email_review", "identity_conflict", "parse_failed", "failed"].includes(item.status)) {
    throw new HttpsError("failed-precondition", `item is not retryable:${item.status}`)
  }
  const retry = await markBulkResumeItemRetryReady(deps.db, {
    batchId: input.batchId,
    itemId: input.itemId,
    now: deps.nowIso?.(),
  })
  const batch = await recomputeBulkResumeBatchCounts(deps.db, input.batchId, deps.nowIso?.())
  return { ok: true, item: projectItem(retry.item), batch }
}

export const runPaBulkResumeCreateBatch = runBulkResumeCreateBatch
export const runPaBulkResumeAddItems = runBulkResumeAddItems
export const runPaBulkResumeProcessBatch = runBulkResumeProcessBatch
export const runPaBulkResumeRetryItem = runBulkResumeRetryItem

function callableDeps(): BulkResumeDeps {
  return {
    db: getFirestore(),
    storage: getStorage() as unknown as BulkResumeStorage,
    log: (event, payload) => logger.info(event, payload ?? {}),
  }
}

export const paBulkResumeCreateBatch = onCall({ region: "us-central1", memory: "256MiB", secrets: [PA_ADMIN_TOKEN] }, async (req) => {
  const actor = authorizeBulkResumeAdmin(req as CallableAuthLike)
  return runBulkResumeCreateBatch(req.data, callableDeps(), actor)
})

export const paBulkResumeAddItems = onCall({ region: "us-central1", memory: "512MiB", timeoutSeconds: 120, secrets: [PA_ADMIN_TOKEN] }, async (req) => {
  authorizeBulkResumeAdmin(req as CallableAuthLike)
  return runBulkResumeAddItems(req.data, callableDeps())
})

export const paBulkResumeProcessBatch = onCall({
  region: "us-central1",
  memory: "1GiB",
  timeoutSeconds: 540,
  secrets: [PA_ADMIN_TOKEN, PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
}, async (req) => {
  authorizeBulkResumeAdmin(req as CallableAuthLike)
  hydrateBulkResumeSecrets()
  return runBulkResumeProcessBatch(req.data, callableDeps())
})

export const paBulkResumeRetryItem = onCall({ region: "us-central1", memory: "256MiB", secrets: [PA_ADMIN_TOKEN] }, async (req) => {
  authorizeBulkResumeAdmin(req as CallableAuthLike)
  return runBulkResumeRetryItem(req.data, callableDeps())
})
