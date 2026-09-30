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
import { detectResumeUploadKind, extractDocxText, type ResumeUploadKind } from "./resume-upload-parser.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")
const MAX_BULK_RESUME_BYTES = 6 * 1024 * 1024
const STORAGE_PREFIX = "pa-bulk-resumes"
const RECRUITER_SUBMISSIONS_COLLECTION = "pa-recruiter-submissions"
const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"

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

const RecruiterSubmitterSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
})

const SubmitRecruiterBatchInputSchema = z.object({
  batchId: z.string().min(1),
  jobId: z.string().trim().min(1).max(200),
  submitter: RecruiterSubmitterSchema,
  adminToken: z.string().optional(),
})

type CreateBatchInput = z.infer<typeof CreateBatchInputSchema>
type AddItemsInput = z.infer<typeof AddItemsInputSchema>
type ProcessBatchInput = z.infer<typeof ProcessBatchInputSchema>
type RetryItemInput = z.infer<typeof RetryItemInputSchema>
type SubmitRecruiterBatchInput = z.infer<typeof SubmitRecruiterBatchInputSchema>

type RecruiterSubmissionScore = {
  hardChecked: number
  hardTotal: number
  fitChecked: number
  fitTotal: number
  bonusChecked: number
  bonusTotal: number
  antiChecked: number
  antiTotal: number
}

type RecruiterSubmitResult = {
  itemId: string
  status: "created" | "skipped"
  submissionId?: string
  reason?: string
}

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

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function resumeContentType(kind: ResumeUploadKind): string {
  return kind === "docx"
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/pdf"
}

function decodeBase64Resume(fileName: string, resumeBase64: string): { bytes: Buffer; kind: ResumeUploadKind } {
  const raw = (resumeBase64.includes(",") ? resumeBase64.split(",").pop()! : resumeBase64).replace(/\s/g, "")
  if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new HttpsError("invalid-argument", `invalid base64 resume: ${fileName}`)
  }
  const bytes = Buffer.from(raw, "base64")
  if (bytes.length === 0 || bytes.length > MAX_BULK_RESUME_BYTES) {
    throw new HttpsError("invalid-argument", `resume size out of range: ${fileName}`)
  }
  const kind = detectResumeUploadKind(bytes, fileName)
  if (!kind) {
    throw new HttpsError("invalid-argument", `unsupported resume format: ${fileName}`)
  }
  return { bytes, kind }
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
    const { bytes, kind } = decodeBase64Resume(file.fileName, file.resumeBase64)
    const sha = sha256Hex(bytes)
    const itemId = createBulkResumeItemId(input.batchId, sha)
    const objectPath = `${STORAGE_PREFIX}/${input.batchId}/${itemId}.${kind}`
    const storageFile = bucket.file(objectPath)
    if (!storageFile.save) throw new Error("bulk_resume_storage_save_unavailable")
    await storageFile.save(bytes, {
      contentType: resumeContentType(kind),
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

async function readStorageResume(
  storage: BulkResumeStorage,
  item: BulkResumeItem
): Promise<{ bytes: Uint8Array; contentType?: string }> {
  if (!item.storageUri) throw new Error(`missing_storage_uri:${item.itemId}`)
  const { bucketName, path } = parseGsUri(item.storageUri)
  const file = storage.bucket(bucketName).file(path)
  if (!file.download) throw new Error("bulk_resume_storage_download_unavailable")
  const [bytes] = await file.download()
  return {
    bytes,
    contentType: item.fileName.toLowerCase().endsWith(".docx")
      ? resumeContentType("docx")
      : resumeContentType("pdf"),
  }
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

function cleanString(value: unknown, max = 4_000): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function normalizeRecruiterCandidateLink(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  try {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase().replace(/^www\./, "")
    const path = url.pathname.replace(/\/+$/, "").toLowerCase()
    return `${host}${path}`
  } catch {
    return trimmed.toLowerCase().replace(/\s+/g, "")
  }
}

function hashRecruiterCandidateLink(raw: string): string {
  return sha256Text(normalizeRecruiterCandidateLink(raw))
}

function normalizeRecruiterCandidateEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

function hashRecruiterCandidateEmail(raw: string): string {
  return sha256Text(normalizeRecruiterCandidateEmail(raw))
}

function canonicalizeRecruiterLinkedInProfileUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return undefined
  let candidate = trimmed
  if (/^\/\//.test(candidate)) {
    candidate = `https:${candidate}`
  } else if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`
  }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  const host = parsed.hostname.toLowerCase()
  if (!/(^|\.)linkedin\.com$/.test(host)) return undefined
  let path = parsed.pathname
  const localeMatch = /^\/[a-z]{2,3}\/in\//i.exec(path)
  if (localeMatch) path = path.slice(localeMatch[0].length - "/in/".length)
  const match = /^\/in\/([A-Za-z0-9\-_%]+)\/?$/.exec(path)
  return match ? `https://linkedin.com/in/${match[1]!.toLowerCase()}` : undefined
}

function extractLinkedInFromParsedResume(parsed: Record<string, unknown>): string | undefined {
  const candidateProfile = parsed.candidateProfile && typeof parsed.candidateProfile === "object"
    ? parsed.candidateProfile as Record<string, unknown>
    : {}
  const direct = canonicalizeRecruiterLinkedInProfileUrl(candidateProfile.linkedIn)
  if (direct) return direct
  const websites = Array.isArray(parsed.websites) ? parsed.websites : []
  for (const site of websites) {
    const linkedIn = canonicalizeRecruiterLinkedInProfileUrl(site)
    if (linkedIn) return linkedIn
  }
  return undefined
}

function firstExperienceValue(parsed: Record<string, unknown>, key: "title" | "company"): string | undefined {
  const workHistory = Array.isArray(parsed.workHistory) ? parsed.workHistory : []
  const experiences = Array.isArray(parsed.experiences) ? parsed.experiences : []
  for (const source of [workHistory, experiences]) {
    const first = source[0]
    if (first && typeof first === "object") {
      const value = cleanString((first as Record<string, unknown>)[key], 500)
      if (value) return value
    }
  }
  return undefined
}

function fallbackNameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  const withoutExt = base.replace(/\.(pdf|docx)$/i, "")
  const cleaned = withoutExt
    .replace(/[_-]+/g, " ")
    .replace(/\bresume\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned || "Resume candidate"
}

function checklistCellChecked(value: unknown): boolean {
  return value === true || value === "strong" || value === "yes"
}

function computeSubmissionScore(rawGroups: unknown, checklist: Record<string, unknown>): RecruiterSubmissionScore {
  const score: RecruiterSubmissionScore = {
    hardChecked: 0,
    hardTotal: 0,
    fitChecked: 0,
    fitTotal: 0,
    bonusChecked: 0,
    bonusTotal: 0,
    antiChecked: 0,
    antiTotal: 0,
  }
  const groups = Array.isArray(rawGroups) ? rawGroups : []
  for (const rawGroup of groups) {
    if (!rawGroup || typeof rawGroup !== "object") continue
    const group = rawGroup as Record<string, unknown>
    const kind = group.kind
    if (kind !== "hard" && kind !== "fit" && kind !== "bonus" && kind !== "anti") continue
    const items = Array.isArray(group.items) ? group.items : []
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object") continue
      const id = cleanString((rawItem as Record<string, unknown>).id, 120)
      if (!id) continue
      const checked = checklistCellChecked(checklist[id])
      if (kind === "hard") {
        score.hardTotal += 1
        if (checked) score.hardChecked += 1
      } else if (kind === "fit") {
        score.fitTotal += 1
        if (checked) score.fitChecked += 1
      } else if (kind === "bonus") {
        score.bonusTotal += 1
        if (checked) score.bonusChecked += 1
      } else {
        score.antiTotal += 1
        if (checked) score.antiChecked += 1
      }
    }
  }
  return score
}

async function resolveRecruiterJob(
  db: Firestore,
  inputJobId: string
): Promise<{ jobId: string; job: Record<string, unknown>; recruiterBoard: Record<string, unknown> }> {
  const direct = await db.collection(PA_COLLECTIONS.jobs).doc(inputJobId).get()
  let jobId = inputJobId
  let job = direct.exists ? direct.data() as Record<string, unknown> : null
  if (!job) {
    const query = await db
      .collection(PA_COLLECTIONS.jobs)
      .where("publicId", "==", inputJobId)
      .limit(1)
      .get()
    const match = query.docs[0]
    if (match) {
      jobId = match.id
      job = match.data() as Record<string, unknown>
    }
  }
  if (!job) throw new HttpsError("not-found", `job_missing:${inputJobId}`)
  const recruiterBoard = job.recruiterBoard && typeof job.recruiterBoard === "object"
    ? job.recruiterBoard as Record<string, unknown>
    : null
  if (job.wekruitCollaborationStatus !== "collaborated" || !recruiterBoard || recruiterBoard.active !== true) {
    throw new HttpsError("failed-precondition", `job_not_active_on_recruiter_board:${inputJobId}`)
  }
  return { jobId, job, recruiterBoard }
}

async function readParsedResume(db: Firestore, resumeId: string): Promise<Record<string, unknown> | null> {
  const snap = await db.collection(PARSED_RESUMES_COLLECTION).doc(resumeId).get()
  return snap.exists ? snap.data() as Record<string, unknown> : null
}

async function readResumeArtifactSummary(db: Firestore, resumeArtifactId: string | undefined): Promise<string | undefined> {
  if (!resumeArtifactId) return undefined
  const snap = await db.collection(PA_COLLECTIONS.resumeArtifacts).doc(resumeArtifactId).get()
  if (!snap.exists) return undefined
  return cleanString(snap.data()?.candidateProfileSummary, 1_500)
}

async function listRecruiterSubmissionsForJob(
  db: Firestore,
  jobId: string
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const ref = db.collection(RECRUITER_SUBMISSIONS_COLLECTION)
  const queryable = ref as unknown as {
    where?: (field: string, op: string, value: string) => {
      limit?: (n: number) => { get: () => Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }> }
      get: () => Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }>
    }
    get: () => Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }>
  }
  let snap: { docs: Array<{ id: string; data: () => Record<string, unknown> }> }
  if (typeof queryable.where === "function") {
    const jobQuery = queryable.where("jobId", "==", jobId)
    snap = typeof jobQuery.limit === "function" ? await jobQuery.limit(1000).get() : await jobQuery.get()
  } else {
    snap = await queryable.get()
  }
  return snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() }))
    .filter((doc) => doc.data.jobId === jobId)
}

function submissionAlreadyExists(
  existing: Array<{ id: string; data: Record<string, unknown> }>,
  candidateEmailKey: string,
  candidateLinkKey: string
): { id: string; reason: string } | null {
  for (const doc of existing) {
    if (doc.data.candidateEmailKey === candidateEmailKey) {
      return { id: doc.id, reason: "candidate_already_submitted_for_role_email" }
    }
    if (doc.data.candidateLinkKey === candidateLinkKey) {
      return { id: doc.id, reason: "candidate_already_submitted_for_role_link" }
    }
  }
  return null
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
    const ingestDeps: IngestCvDeps = {
      db: deps.db,
      fetchPdf: () =>
        deps.fetchPdf
          ? deps.fetchPdf(item)
          : readStorageResume(deps.storage ?? (getStorage() as unknown as BulkResumeStorage), item),
      nowIso: deps.nowIso,
      log: deps.log,
      checkGate: async () => ({ open: true, reason: "bulk_resume_intake" }),
      followupDeliveryMode: "none",
      skipLimitEnforcement: true,
      isFlagEnabled: async () => false,
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
    if (item.fileName.toLowerCase().endsWith(".docx")) {
      ingestDeps.parsePdf = async (bytes: Uint8Array) => ({ text: extractDocxText(bytes) })
    }

    const result = await ingestCv(
      {
        userId: item.itemId,
        mediaUrl: item.storageUri ?? "",
        employerEmailHint: item.employerEmailHint,
        identitySource: "admin",
        requireExtractedEmail: true,
      },
      ingestDeps
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

export async function runBulkResumeSubmitRecruiterBatch(
  rawInput: unknown,
  deps: Pick<BulkResumeDeps, "db" | "nowIso">
): Promise<{
  ok: true
  jobId: string
  created: number
  skipped: number
  results: RecruiterSubmitResult[]
}> {
  const parsed = SubmitRecruiterBatchInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const input: SubmitRecruiterBatchInput = parsed.data
  await assertBatchExists(deps.db, input.batchId)
  const { jobId, job, recruiterBoard } = await resolveRecruiterJob(deps.db, input.jobId)
  const itemSnap = await itemCollection(deps.db, input.batchId).get()
  const items = itemSnap.docs
    .map((doc) => BulkResumeItemSchema.parse(doc.data()))
    .filter((item) => item.status === "parsed")

  const existing = await listRecruiterSubmissionsForJob(deps.db, jobId)
  const seenEmailKeys = new Set(existing.map((doc) => cleanString(doc.data.candidateEmailKey)).filter(Boolean) as string[])
  const seenLinkKeys = new Set(existing.map((doc) => cleanString(doc.data.candidateLinkKey)).filter(Boolean) as string[])
  const results: RecruiterSubmitResult[] = []
  const now = deps.nowIso?.() ?? nowIso()
  const label = recruiterBoard.label && typeof recruiterBoard.label === "object"
    ? recruiterBoard.label as Record<string, unknown>
    : {}
  const checklistSource = recruiterBoard.checklist && typeof recruiterBoard.checklist === "object"
    ? recruiterBoard.checklist as Record<string, unknown>
    : {}
  const checklist: Record<string, unknown> = {}
  const score = computeSubmissionScore(checklistSource.groups, checklist)

  for (const item of items) {
    const parsedResumeId = item.parsedCandidateResumeId
    if (!parsedResumeId) {
      results.push({ itemId: item.itemId, status: "skipped", reason: "missing_parsed_resume_id" })
      continue
    }
    const resume = await readParsedResume(deps.db, parsedResumeId)
    if (!resume) {
      results.push({ itemId: item.itemId, status: "skipped", reason: "parsed_resume_missing" })
      continue
    }
    const profile = resume.candidateProfile && typeof resume.candidateProfile === "object"
      ? resume.candidateProfile as Record<string, unknown>
      : {}
    const email = normalizeRecruiterCandidateEmail(cleanString(profile.email, 320) ?? "")
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.push({ itemId: item.itemId, status: "skipped", reason: "missing_candidate_email" })
      continue
    }
    const linkedIn = extractLinkedInFromParsedResume(resume)
    const resumeUrl = cleanString(item.storageUri, 2_000)
    const link = linkedIn ?? resumeUrl
    if (!link) {
      results.push({ itemId: item.itemId, status: "skipped", reason: "missing_candidate_link_or_resume" })
      continue
    }
    const candidateEmailKey = hashRecruiterCandidateEmail(email)
    const candidateLinkKey = hashRecruiterCandidateLink(link)
    const duplicate = seenEmailKeys.has(candidateEmailKey) || seenLinkKeys.has(candidateLinkKey)
      ? submissionAlreadyExists(existing, candidateEmailKey, candidateLinkKey)
        ?? { id: "current_batch", reason: "candidate_already_submitted_for_role" }
      : null
    if (duplicate) {
      results.push({ itemId: item.itemId, status: "skipped", submissionId: duplicate.id, reason: duplicate.reason })
      continue
    }

    const candidate = stripUndefined({
      name: cleanString(profile.name, 200) ?? fallbackNameFromFile(item.fileName),
      email,
      link,
      ...(linkedIn ? { linkedinUrl: linkedIn } : {}),
      ...(resumeUrl ? { resumeUrl } : {}),
      currentRole: firstExperienceValue(resume, "title"),
      currentCompany: firstExperienceValue(resume, "company"),
      notes: await readResumeArtifactSummary(deps.db, item.resumeArtifactId),
    }) as Record<string, string>
    const submissionId = `bulk_${sha256Text(`${jobId}|${item.itemId}`).slice(0, 32)}`
    await deps.db.collection(RECRUITER_SUBMISSIONS_COLLECTION).doc(submissionId).set(stripUndefined({
      submissionId,
      jobId,
      inboundJobId: input.jobId,
      jobTitleSnapshot: cleanString(job.title, 300) ?? cleanString(job.roleTitle, 300) ?? "",
      companyLabelSnapshot: cleanString(label.company, 300) ?? cleanString(job.company, 300) ?? cleanString(job.companyName, 300) ?? "",
      submitter: input.submitter,
      recruiterId: null,
      recruiterEmail: input.submitter.email.trim().toLowerCase(),
      candidateId: item.candidateId,
      resumeArtifactId: item.resumeArtifactId,
      parsedCandidateResumeId: parsedResumeId,
      candidate,
      candidateLinkKey,
      candidateEmailKey,
      candidateConsent: true,
      candidateConsentStatus: "recruiter_asserted",
      checklist,
      score,
      submissionMode: "primary_role",
      callerSource: "bulk_resume",
      source: { userAgent: "bulk_resume_admin", referrer: "", ipHash: "" },
      idempotencyKey: null,
      status: "submitted",
      statusHistory: [{ status: "submitted", at: now, by: input.submitter.email.trim().toLowerCase() }],
      createdAt: now,
      updatedAt: now,
    }))
    existing.push({
      id: submissionId,
      data: { jobId, candidateEmailKey, candidateLinkKey },
    })
    seenEmailKeys.add(candidateEmailKey)
    seenLinkKeys.add(candidateLinkKey)
    results.push({ itemId: item.itemId, status: "created", submissionId })
  }

  return {
    ok: true,
    jobId,
    created: results.filter((result) => result.status === "created").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    results,
  }
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
export const runPaBulkResumeSubmitRecruiterBatch = runBulkResumeSubmitRecruiterBatch
export const runPaBulkResumeRetryItem = runBulkResumeRetryItem

function callableDeps(): BulkResumeDeps {
  return {
    db: getFirestore(),
    storage: getStorage() as unknown as BulkResumeStorage,
    log: (event, payload) => logger.info(event, payload ?? {}),
  }
}

export const paBulkResumeCreateBatch = onCall({ region: "us-central1", memory: "512MiB", secrets: [PA_ADMIN_TOKEN] }, async (req) => {
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

export const paBulkResumeSubmitRecruiterBatch = onCall({
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 120,
  secrets: [PA_ADMIN_TOKEN],
}, async (req) => {
  authorizeBulkResumeAdmin(req as CallableAuthLike)
  return runBulkResumeSubmitRecruiterBatch(req.data, callableDeps())
})

export const paBulkResumeRetryItem = onCall({ region: "us-central1", memory: "512MiB", maxInstances: 1, secrets: [PA_ADMIN_TOKEN] }, async (req) => {
  authorizeBulkResumeAdmin(req as CallableAuthLike)
  return runBulkResumeRetryItem(req.data, callableDeps())
})
