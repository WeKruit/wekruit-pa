/**
 * v2.0 External Supply V1 — Wave D — Dashboard wrappers for the external-supply
 * backend surface: every admin callable + every Firestore query the admin UI
 * needs to render. Mirrors the `handbook-api.ts` / `flags-api.ts` patterns.
 *
 * Two kinds of helpers live here:
 *
 *  1. **Callables** — typed `httpsCallable` wrappers around each
 *     `paExternalSupply*` function. Throw on error; otherwise return the CF
 *     result body directly.
 *
 *  2. **Firestore readers** — paginated `getDocs(query(...))` against the
 *     external-supply collections (declared in `@pa/core-types` as
 *     `PA_COLLECTIONS`). Defensive `safeParse` is applied to each row so a
 *     stale doc never blanks the UI; mis-shaped rows surface via the
 *     `_unparsed` map so the operator can audit.
 *
 * Auth: every callable runs through the existing admin gate
 * (`@wekruit.com` sign-in + `requireExternalSupplyAdmin` server side). Reads
 * use the same Firestore client as the rest of the dashboard.
 */
import {
  AgentRankingResultSchema,
  AgentResearchTaskSchema,
  CandidateCompanyJobEvaluationSchema,
  CandidateEvaluationRunSchema,
  CandidateSourceLinkSchema,
  ExternalCandidateRecordSchema,
  ExternalSourcingBatchSchema,
  InstantlySyncRecordSchema,
  OutreachEventSchema,
  OutreachPlanSchema,
  PA_AGENT_RANKING_RESULTS,
  PA_COLLECTIONS,
  SourceQualityMetricSchema,
  type AgentRankingAction,
  type AgentRankingResult,
  type AgentResearchTask,
  type CandidateCompanyJobEvaluation,
  type CandidateEvaluationRun,
  type CandidateSourceLink,
  type EvaluationTier,
  type ExternalCandidateRecord,
  type ExternalSource,
  type ExternalSourcingBatch,
  type InstantlySyncRecord,
  type OutreachApprovalStatus,
  type OutreachEvent,
  type OutreachPlan,
  type SourceQualityMetric,
} from "@pa/core-types"
import {
  type DocumentData,
  type QueryConstraint,
  type QueryDocumentSnapshot,
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  startAfter,
  where,
} from "firebase/firestore"
import { httpsCallable } from "firebase/functions"
import { db, functions } from "./firebase.js"

// ===========================================================================
// Types — UI-friendly wrappers around the backend contracts
// ===========================================================================

export interface CreateBatchUploadUrlInput {
  sha256: string
  mime: string
  sizeBytes: number
  source: ExternalSource
}

export interface CreateBatchUploadUrlResult {
  storageUri: string
  signedUrl: string
}

export interface CreateBatchInput {
  source: ExternalSource
  /** Legacy path — pre-uploaded GCS object. Either this or inlineBase64 must be set. */
  storageUri?: string
  /** v2.2: inline upload for tiny xlsx (≤5 MB) — skips signed-URL + CORS. */
  inlineBase64?: string
  /** Required when using inlineBase64 so the adapter can sniff sheet kind. */
  filename?: string
  sha256: string
  mime: string
  sizeBytes: number
  companyId?: string
  jobId?: string
  columnMapping?: ManualCsvColumnMapping
}

export interface ManualCsvColumnMapping {
  linkedinUrl?: string
  email?: string
  phone?: string
  name?: string
  currentTitle?: string
  currentCompany?: string
  location?: string
  skills?: string
}

export interface CreateBatchResult {
  batchId: string
  rowCount: number
  validLinkedInCount: number
  validEmailCount: number
  duplicateCount: number
  needsReviewCount: number
  readyToProfileCount: number
  status: "normalized" | "already_normalized"
}

export interface ResolveBatchIdentityResult {
  ok: true
  batchId: string
  processed: number
  created: number
  merged: number
  pending: number
  blocked: number
  skipped: number
}

export interface RunEvaluationInput {
  batchId?: string
  recordIds?: string[]
  companyId: string
  jobId: string
  rubricVersion?: string
  runId?: string
}

export interface RunEvaluationResult {
  ok: true
  runId: string
  processed: number
  completed: number
  skipped: number
  tierBreakdown: Record<EvaluationTier, number>
}

export interface GenerateAgentResearchPromptInput {
  evaluationRunId?: string
  candidateIds?: string[]
  recordIds?: string[]
  missingInfoOverride?: Record<string, string[]>
  companyId?: string
  jobId?: string
}

export interface GenerateAgentResearchPromptResult {
  ok: true
  taskId: string
  prompt: string
  promptVersion: string
  expectedJsonSchemaVersion: string
}

export interface ImportAgentResearchResultInput {
  taskId: string
  rawResult: string
}

export interface ImportAgentResearchResultResult {
  ok: true
  taskId: string
  parsedCount: number
  parseErrorCount: number
  schemaVersionMismatch: boolean
}

export interface ApproveAgentResearchFindingInput {
  taskId: string
  findingId: string
  approved: boolean
  note?: string
}

export interface ApproveAgentResearchFindingResult {
  ok: true
  taskId: string
  findingId: string
  approved: boolean
  reviewStatus: AgentResearchTask["reviewStatus"]
}

export interface OutreachCopyEdits {
  personalizedHook?: string
  whyThisRole?: string
  whyCompany?: string
  candidateSpecificSignal?: string
  emailSubject?: string
  emailBody?: string
  linkedinMessage?: string
}

export interface DraftOutreachPlanInput {
  evaluationId: string
  copyOverrides?: OutreachCopyEdits
}

export interface DraftOutreachPlanResult {
  ok: true
  planId: string
  tier: OutreachPlan["tier"]
  channelDecision: OutreachPlan["channelDecision"]
  suppression: OutreachPlan["suppressionGateResult"]
}

export interface ApproveOutreachPlanInput {
  planId: string
  edits?: OutreachCopyEdits
}

export interface ApproveOutreachPlanResult {
  ok: true
  planId: string
  approvalStatus: OutreachApprovalStatus
  correctionEventId?: string
}

export interface RejectOutreachPlanInput {
  planId: string
  reason: string
}

export interface AssignManualLinkedInTaskInput {
  planId: string
  assignee: string
}

export interface MarkManualLinkedInTaskStatusInput {
  planId: string
  status: "todo" | "sent" | "replied" | "skipped"
}

export interface SyncPlanToInstantlyInput {
  planId: string
  mode: "dry_run" | "live"
  campaignId?: string
  listId?: string
}

export interface SyncPlanToInstantlyResult {
  ok: true
  syncId: string
  syncStatus: InstantlySyncRecord["syncStatus"]
  mode: "dry_run" | "live"
  instantlyLeadId?: string
  downgraded?: boolean
  downgradedReason?: string
}

export interface ExternalSupplyConfig {
  liveOutreachEnabled: boolean
  instantlyConfigured: boolean
}

// ===========================================================================
// Callable wrappers
// ===========================================================================

function callable<TInput, TOutput>(name: string) {
  return async (input: TInput): Promise<TOutput> => {
    const fn = httpsCallable<TInput, TOutput>(functions(), name)
    const res = await fn(input)
    return res.data
  }
}

export const createBatchUploadUrl = callable<
  CreateBatchUploadUrlInput,
  CreateBatchUploadUrlResult
>("paExternalSupplyCreateBatchUploadUrl")

export const createBatch = callable<CreateBatchInput, CreateBatchResult>(
  "paExternalSupplyCreateBatch",
)

export const resolveBatchIdentity = callable<
  { batchId: string },
  ResolveBatchIdentityResult
>("paExternalSupplyResolveBatchIdentity")

// ---------------------------------------------------------------------------
// V2.1 — candidates browser (list + drawer detail)
// ---------------------------------------------------------------------------

export interface BatchCandidateRow {
  recordId: string
  batchId: string
  candidateId?: string
  name?: string
  linkedinUrl?: string
  currentTitle?: string
  currentCompany?: string
  location?: string
  email?: string
  headline?: string
  matchScore?: string
  rubric?: Record<string, { value: string; passed: boolean | null }>
  identityResolutionStatus?: string
  normalizationStatus?: string
  evaluation?: {
    tier?: string
    score?: number
    explanation?: string
  }
}

export interface ListBatchCandidatesResult {
  ok: true
  batchId: string
  rows: BatchCandidateRow[]
  jobId?: string
  companyId?: string
}

export const listBatchCandidates = callable<
  { batchId: string },
  ListBatchCandidatesResult
>("paExternalSupplyListBatchCandidates")

export interface CandidateDetail {
  recordId: string
  batchId: string
  candidateId?: string
  record: Record<string, unknown>
  candidate?: Record<string, unknown>
  resume?: {
    artifactId: string
    candidateProfileSummary?: string
    storagePath?: string
    parsedCandidateResumeId?: string
  }
  evaluation?: {
    evaluationId: string
    proposedTier?: string
    generalRubricScore?: number
    explanation?: string
  }
  handles?: Array<{ kind: string; redactedValue: string }>
}

export const getCandidateDetail = callable<{ recordId: string }, CandidateDetail>(
  "paExternalSupplyGetCandidateDetail",
)

export const runEvaluation = callable<RunEvaluationInput, RunEvaluationResult>(
  "paExternalSupplyRunEvaluation",
)

export const generateAgentResearchPrompt = callable<
  GenerateAgentResearchPromptInput,
  GenerateAgentResearchPromptResult
>("paExternalSupplyGenerateAgentResearchPrompt")

export const importAgentResearchResult = callable<
  ImportAgentResearchResultInput,
  ImportAgentResearchResultResult
>("paExternalSupplyImportAgentResearchResult")

export const approveAgentResearchFinding = callable<
  ApproveAgentResearchFindingInput,
  ApproveAgentResearchFindingResult
>("paExternalSupplyApproveAgentResearchFinding")

export const draftOutreachPlan = callable<
  DraftOutreachPlanInput,
  DraftOutreachPlanResult
>("paExternalSupplyDraftOutreachPlan")

export const approveOutreachPlan = callable<
  ApproveOutreachPlanInput,
  ApproveOutreachPlanResult
>("paExternalSupplyApproveOutreachPlan")

export const rejectOutreachPlan = callable<
  RejectOutreachPlanInput,
  { ok: true; planId: string }
>("paExternalSupplyRejectOutreachPlan")

export const assignManualLinkedInTask = callable<
  AssignManualLinkedInTaskInput,
  { ok: true; planId: string }
>("paExternalSupplyAssignManualLinkedInTask")

export const markManualLinkedInTaskStatus = callable<
  MarkManualLinkedInTaskStatusInput,
  { ok: true; planId: string; status: string }
>("paExternalSupplyMarkManualLinkedInTaskStatus")

export const syncPlanToInstantly = callable<
  SyncPlanToInstantlyInput,
  SyncPlanToInstantlyResult
>("paExternalSupplySyncPlanToInstantly")

export const getExternalSupplyConfig = callable<
  Record<string, never>,
  ExternalSupplyConfig
>("paExternalSupplyGetConfig")

// ===========================================================================
// V2 — Preview batch + Agent ranking callables (Wave D dashboard surface)
// ===========================================================================

/**
 * Local mirror of the adapter detection shape exposed by
 * `@pa/external-supply` (`AdapterDetection`). The dashboard package does NOT
 * depend on `@pa/external-supply` (server-side package), so we keep a small
 * structural copy here. Align if the package becomes a UI dep.
 */
export interface AdapterDetectionCandidateUI {
  source: string
  confidence: number
  requiredMatched: number
  requiredCount: number
  bonusMatched: number
  reasons: string[]
}

export interface AdapterDetectionUI {
  top: AdapterDetectionCandidateUI
  candidates: AdapterDetectionCandidateUI[]
  shapeHint: "json" | "csv" | "tsv" | "xlsx" | "unknown"
  warnings: string[]
}

/**
 * Tier forecast: enum-keyed projected counts (L-C5). Optional — only present
 * when (companyId, jobId) supplied to `previewBatch`.
 */
export interface PreviewBatchTierForecast {
  tier_1_personal_linkedin_and_email?: number
  tier_2_personal_email?: number
  tier_3_general_email?: number
  retain_only?: number
  blocked?: number
}

export interface PreviewBatchIdentityForecast {
  expectedCreateNew: number
  expectedMergeExisting: number
  expectedNeedsReview: number
  expectedBlocked: number
}

export interface PreviewBatchTagEnrichmentForecast {
  /** Number of rows where each canonical-tag axis was extractable. */
  perAxisCoverage: Record<string, number>
  /** Approximate average # of canonical skills tokens per row. */
  avgSkillsPerRow: number
  /** Rows missing the candidate's `roleFunction` axis after enrichment. */
  missingRoleFunctionRows: number
}

export interface PreviewBatchInput {
  /** Server signature: { filename, mime, base64Bytes, overrideSource?, forecastEvaluationFor?, columnMapping? } */
  filename: string
  mime: string
  base64Bytes: string
  overrideSource?: ExternalSource
  forecastEvaluationFor?: { companyId: string; jobId: string }
  columnMapping?: ManualCsvColumnMapping
  /** Unused by server (kept for backwards-compat with callers that pass them). */
  source?: ExternalSource
  storageUri?: string
  sha256?: string
  sizeBytes?: number
  companyId?: string
  jobId?: string
  /** Optional operator-pinned adapter (forces override of auto-detect). */
  adapterOverride?: ExternalSource
}

export interface PreviewInferredMapping {
  mapping: ManualCsvColumnMapping
  rubricColumns: string[]
  ambiguous: { field: string; candidates: string[] }[]
  matchScoreColumn?: string
  locationParts?: { country?: string; state?: string; city?: string }
}

export interface PreviewBatchResult {
  ok: true
  detection: AdapterDetectionUI
  identityForecast: PreviewBatchIdentityForecast
  tagEnrichmentForecast: PreviewBatchTagEnrichmentForecast
  /** Only present when (companyId, jobId) provided. */
  tierForecast?: PreviewBatchTierForecast
  rowCountPreview: number
  /** v2 — header-driven auto-mapping the operator can override pre-commit. */
  inferredMapping?: PreviewInferredMapping
  /** v2 — first N rows verbatim so operator can sanity-check before commit. */
  sampleRows?: Record<string, string>[]
  warnings: string[]
}

/**
 * NOTE: `paExternalSupplyPreviewBatch` is owned by Executor C (still running
 * at the time this file was authored). The shape above mirrors PLAN §3.5 +
 * lead resolution L-C5. If C lands with a stricter contract, align here.
 */
export const previewBatch = callable<PreviewBatchInput, PreviewBatchResult>(
  "paExternalSupplyPreviewBatch",
)

export interface RunAgentRankingInput {
  evaluationRunId: string
  candidateRecordIds?: string[]
  model?: string
  ensembleSize?: number
  dryRun?: boolean
  budgetUsd?: number
}

export interface RunAgentRankingResult {
  ok: true
  evaluationRunId: string
  processedCount: number
  rankedCount: number
  skippedCount: number
  totalCostUsd: number
  projectedCostUsd: number
  abortedReason?: "budget_exceeded" | "dry_run"
  promptVersion: string
  costTableVersion: string
  prompts?: Array<{
    candidateRecordId: string
    promptCharCount: number
    estimatedInputTokens: number
  }>
}

export const runAgentRanking = callable<RunAgentRankingInput, RunAgentRankingResult>(
  "paExternalSupplyRunAgentRanking",
)

export interface ApproveAgentTierInput {
  resultId: string
  reason?: string
}

export interface ApproveAgentTierResult {
  ok: true
  resultId: string
  approvedTier: EvaluationTier
}

export const approveAgentTier = callable<ApproveAgentTierInput, ApproveAgentTierResult>(
  "paExternalSupplyApproveAgentTier",
)

export interface OverrideAgentTierInput {
  resultId: string
  newTier: EvaluationTier
  reason: string
}

export interface OverrideAgentTierResult {
  ok: true
  resultId: string
  approvedTier: EvaluationTier
  correctionEventId: string
}

export const overrideAgentTier = callable<OverrideAgentTierInput, OverrideAgentTierResult>(
  "paExternalSupplyOverrideAgentTier",
)

// Re-export the agent-ranking action / result types so pages don't have to
// re-import from `@pa/core-types` separately.
export type { AgentRankingAction, AgentRankingResult }

// ===========================================================================
// Firestore reads — defensive parsing
// ===========================================================================

export interface PagedResult<T> {
  rows: T[]
  /** opaque cursor for next page; undefined means no more rows */
  cursor?: QueryDocumentSnapshot<DocumentData>
  unparsedCount: number
}

interface ParseResult<T> {
  parsed: T[]
  unparsedCount: number
}

function parseRows<T>(
  docs: QueryDocumentSnapshot<DocumentData>[],
  parser: (raw: unknown) => { success: true; data: T } | { success: false; error: unknown },
  label: string,
): ParseResult<T> {
  const parsed: T[] = []
  let unparsedCount = 0
  for (const d of docs) {
    const result = parser(d.data())
    if (result.success) {
      parsed.push(result.data)
    } else {
      unparsedCount += 1
      // Log so a stale doc surfaces in the operator console without
      // blanking the UI.

      console.warn(`[external-supply] failed to parse ${label}/${d.id}`, result.error)
    }
  }
  return { parsed, unparsedCount }
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export interface ListBatchesOptions {
  limit?: number
  cursor?: QueryDocumentSnapshot<DocumentData>
}

export async function listBatches(
  opts: ListBatchesOptions = {},
): Promise<PagedResult<ExternalSourcingBatch>> {
  const limit = opts.limit ?? 50
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc"), fsLimit(limit)]
  if (opts.cursor) constraints.splice(1, 0, startAfter(opts.cursor))
  const q = query(collection(db(), PA_COLLECTIONS.externalSourcingBatches), ...constraints)
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => ExternalSourcingBatchSchema.safeParse(raw),
    "external-sourcing-batches",
  )
  return {
    rows: parsed,
    cursor: snap.docs[snap.docs.length - 1],
    unparsedCount,
  }
}

export async function getBatch(batchId: string): Promise<ExternalSourcingBatch | null> {
  const snap = await getDoc(doc(db(), PA_COLLECTIONS.externalSourcingBatches, batchId))
  if (!snap.exists()) return null
  const parsed = ExternalSourcingBatchSchema.safeParse(snap.data())
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// Companies + Jobs — loose readers (no strict Zod schema; pa-jobs is a
// public + matching-side polyglot). Used by the per-company / per-job upload
// entry surface added 2026-05-14.
// ---------------------------------------------------------------------------

export interface CompanyRow {
  companyId: string
  name?: string
  domain?: string
  industrySector?: string[]
  size?: string
  websiteUrl?: string
  careersUrl?: string
  description?: string
}

export interface JobRow {
  jobId: string
  companyId?: string
  title?: string
  department?: string
  roleFunction?: string[]
  seniorityLevel?: string
  locationBuckets?: string[]
  rawLocation?: string
  jobType?: string
  industrySector?: string[]
  atsApplyUrl?: string
  salaryMin?: number | null
  salaryMax?: number | null
  sponsorship?: boolean | null
  status?: string
  source?: string
  firstSeenAt?: string
}

function coerceCompanyRow(id: string, raw: unknown): CompanyRow {
  const o = (raw ?? {}) as Record<string, unknown>
  const strArr = (v: unknown) =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined
  return {
    companyId: id,
    name: typeof o.name === "string" ? o.name : undefined,
    domain: typeof o.domain === "string" ? o.domain : undefined,
    industrySector: strArr(o.industrySector),
    size: typeof o.size === "string" ? o.size : undefined,
    websiteUrl: typeof o.websiteUrl === "string" ? o.websiteUrl : undefined,
    careersUrl: typeof o.careersUrl === "string" ? o.careersUrl : undefined,
    description: typeof o.description === "string" ? o.description : undefined,
  }
}

function coerceJobRow(id: string, raw: unknown): JobRow {
  const o = (raw ?? {}) as Record<string, unknown>
  const strArr = (v: unknown) =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : undefined
  const numOrNull = (v: unknown): number | null | undefined => {
    if (v === null) return null
    if (typeof v === "number") return v
    return undefined
  }
  const boolOrNull = (v: unknown): boolean | null | undefined => {
    if (v === null) return null
    if (typeof v === "boolean") return v
    return undefined
  }
  return {
    jobId: id,
    companyId: typeof o.companyId === "string" ? o.companyId : undefined,
    title: typeof o.title === "string" ? o.title : undefined,
    department: typeof o.department === "string" ? o.department : undefined,
    roleFunction: strArr(o.roleFunction),
    seniorityLevel: typeof o.seniorityLevel === "string" ? o.seniorityLevel : undefined,
    locationBuckets: strArr(o.locationBuckets),
    rawLocation: typeof o.rawLocation === "string" ? o.rawLocation : undefined,
    jobType: typeof o.jobType === "string" ? o.jobType : undefined,
    industrySector: strArr(o.industrySector),
    atsApplyUrl: typeof o.atsApplyUrl === "string" ? o.atsApplyUrl : undefined,
    salaryMin: numOrNull(o.salaryMin),
    salaryMax: numOrNull(o.salaryMax),
    sponsorship: boolOrNull(o.sponsorship),
    status: typeof o.status === "string" ? o.status : undefined,
    source: typeof o.source === "string" ? o.source : undefined,
    firstSeenAt: typeof o.firstSeenAt === "string" ? o.firstSeenAt : undefined,
  }
}

export async function listCompanies(limit = 100): Promise<CompanyRow[]> {
  const snap = await getDocs(
    query(collection(db(), "pa-companies"), fsLimit(limit)),
  )
  return snap.docs.map((d) => coerceCompanyRow(d.id, d.data()))
}

export async function getCompany(companyId: string): Promise<CompanyRow | null> {
  const snap = await getDoc(doc(db(), "pa-companies", companyId))
  if (!snap.exists()) return null
  return coerceCompanyRow(snap.id, snap.data())
}

export async function listJobsByCompany(
  companyId: string,
  limit = 200,
): Promise<JobRow[]> {
  const snap = await getDocs(
    query(
      collection(db(), PA_COLLECTIONS.jobs),
      where("companyId", "==", companyId),
      fsLimit(limit),
    ),
  )
  return snap.docs.map((d) => coerceJobRow(d.id, d.data()))
}

export async function listJobs(limit = 200): Promise<JobRow[]> {
  // Best-effort: order by `firstSeenAt` desc when present; the loose schema
  // means some docs may lack it — getDocs without orderBy returns
  // doc-id order which is still useful.
  const snap = await getDocs(
    query(collection(db(), PA_COLLECTIONS.jobs), fsLimit(limit)),
  )
  return snap.docs.map((d) => coerceJobRow(d.id, d.data()))
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface ListBatchRecordsOptions {
  batchId: string
  status?: ExternalCandidateRecord["identityResolutionStatus"]
  limit?: number
  cursor?: QueryDocumentSnapshot<DocumentData>
}

export async function listBatchRecords(
  opts: ListBatchRecordsOptions,
): Promise<PagedResult<ExternalCandidateRecord>> {
  const limit = opts.limit ?? 200
  const constraints: QueryConstraint[] = [
    where("batchId", "==", opts.batchId),
    fsLimit(limit),
  ]
  if (opts.status) {
    constraints.unshift(where("identityResolutionStatus", "==", opts.status))
  }
  if (opts.cursor) constraints.push(startAfter(opts.cursor))
  const q = query(collection(db(), PA_COLLECTIONS.externalCandidateRecords), ...constraints)
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => ExternalCandidateRecordSchema.safeParse(raw),
    "external-candidate-records",
  )
  return {
    rows: parsed,
    cursor: snap.docs[snap.docs.length - 1],
    unparsedCount,
  }
}

export interface ListNeedsReviewRecordsOptions {
  limit?: number
}

export async function listNeedsReviewRecords(
  opts: ListNeedsReviewRecordsOptions = {},
): Promise<PagedResult<ExternalCandidateRecord>> {
  const limit = opts.limit ?? 200
  const q = query(
    collection(db(), PA_COLLECTIONS.externalCandidateRecords),
    where("identityResolutionStatus", "==", "needs_review"),
    fsLimit(limit),
  )
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => ExternalCandidateRecordSchema.safeParse(raw),
    "external-candidate-records",
  )
  return { rows: parsed, unparsedCount }
}

// ---------------------------------------------------------------------------
// Source links
// ---------------------------------------------------------------------------

export interface ListSourceLinksOptions {
  recordId?: string
  candidateId?: string
  limit?: number
}

export async function listSourceLinks(
  opts: ListSourceLinksOptions = {},
): Promise<PagedResult<CandidateSourceLink>> {
  const limit = opts.limit ?? 100
  const constraints: QueryConstraint[] = [fsLimit(limit)]
  if (opts.recordId) constraints.unshift(where("recordId", "==", opts.recordId))
  if (opts.candidateId) constraints.unshift(where("candidateId", "==", opts.candidateId))
  const q = query(collection(db(), PA_COLLECTIONS.candidateSourceLinks), ...constraints)
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => CandidateSourceLinkSchema.safeParse(raw),
    "candidate-source-links",
  )
  return { rows: parsed, unparsedCount }
}

// ---------------------------------------------------------------------------
// Evaluation runs + per-candidate eval rows
// ---------------------------------------------------------------------------

export async function listEvaluationRuns(
  limit = 50,
): Promise<PagedResult<CandidateEvaluationRun>> {
  const q = query(
    collection(db(), PA_COLLECTIONS.candidateEvaluationRuns),
    orderBy("createdAt", "desc"),
    fsLimit(limit),
  )
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => CandidateEvaluationRunSchema.safeParse(raw),
    "candidate-evaluation-runs",
  )
  return { rows: parsed, unparsedCount }
}

export async function getEvaluationRun(runId: string): Promise<CandidateEvaluationRun | null> {
  const snap = await getDoc(doc(db(), PA_COLLECTIONS.candidateEvaluationRuns, runId))
  if (!snap.exists()) return null
  const parsed = CandidateEvaluationRunSchema.safeParse(snap.data())
  return parsed.success ? parsed.data : null
}

export async function listEvaluations(
  runId: string,
  limit = 500,
): Promise<PagedResult<CandidateCompanyJobEvaluation>> {
  const q = query(
    collection(db(), PA_COLLECTIONS.candidateCompanyJobEvaluations),
    where("evaluationRunId", "==", runId),
    fsLimit(limit),
  )
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => CandidateCompanyJobEvaluationSchema.safeParse(raw),
    "candidate-company-job-evaluations",
  )
  return { rows: parsed, unparsedCount }
}

export async function findEvaluationByCandidateAndJob(
  candidateId: string,
  jobId: string,
): Promise<CandidateCompanyJobEvaluation[]> {
  const q = query(
    collection(db(), PA_COLLECTIONS.candidateCompanyJobEvaluations),
    where("candidateId", "==", candidateId),
    where("jobId", "==", jobId),
    fsLimit(50),
  )
  const snap = await getDocs(q)
  const { parsed } = parseRows(
    snap.docs,
    (raw) => CandidateCompanyJobEvaluationSchema.safeParse(raw),
    "candidate-company-job-evaluations",
  )
  return parsed
}

// ---------------------------------------------------------------------------
// Agent research tasks
// ---------------------------------------------------------------------------

export interface ListAgentResearchTasksOptions {
  evaluationRunId?: string
  reviewStatus?: AgentResearchTask["reviewStatus"]
  limit?: number
}

export async function listAgentResearchTasks(
  opts: ListAgentResearchTasksOptions = {},
): Promise<PagedResult<AgentResearchTask>> {
  const limit = opts.limit ?? 100
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc"), fsLimit(limit)]
  if (opts.evaluationRunId) {
    constraints.unshift(where("evaluationRunId", "==", opts.evaluationRunId))
  }
  if (opts.reviewStatus) {
    constraints.unshift(where("reviewStatus", "==", opts.reviewStatus))
  }
  const q = query(collection(db(), PA_COLLECTIONS.agentResearchTasks), ...constraints)
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => AgentResearchTaskSchema.safeParse(raw),
    "agent-research-tasks",
  )
  return { rows: parsed, unparsedCount }
}

export async function getAgentResearchTask(taskId: string): Promise<AgentResearchTask | null> {
  const snap = await getDoc(doc(db(), PA_COLLECTIONS.agentResearchTasks, taskId))
  if (!snap.exists()) return null
  const parsed = AgentResearchTaskSchema.safeParse(snap.data())
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// Outreach plans
// ---------------------------------------------------------------------------

export interface ListOutreachPlansOptions {
  approvalStatus?: OutreachApprovalStatus
  candidateId?: string
  limit?: number
}

export async function listOutreachPlans(
  opts: ListOutreachPlansOptions = {},
): Promise<PagedResult<OutreachPlan>> {
  const limit = opts.limit ?? 100
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc"), fsLimit(limit)]
  if (opts.approvalStatus) {
    constraints.unshift(where("approvalStatus", "==", opts.approvalStatus))
  }
  if (opts.candidateId) {
    constraints.unshift(where("candidateId", "==", opts.candidateId))
  }
  const q = query(collection(db(), PA_COLLECTIONS.outreachPlans), ...constraints)
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => OutreachPlanSchema.safeParse(raw),
    "outreach-plans",
  )
  return { rows: parsed, unparsedCount }
}

export async function getOutreachPlan(planId: string): Promise<OutreachPlan | null> {
  const snap = await getDoc(doc(db(), PA_COLLECTIONS.outreachPlans, planId))
  if (!snap.exists()) return null
  const parsed = OutreachPlanSchema.safeParse(snap.data())
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// Instantly sync records
// ---------------------------------------------------------------------------

export interface ListInstantlySyncRecordsOptions {
  planId?: string
  status?: InstantlySyncRecord["syncStatus"]
  limit?: number
}

export async function listInstantlySyncRecords(
  opts: ListInstantlySyncRecordsOptions = {},
): Promise<PagedResult<InstantlySyncRecord>> {
  const limit = opts.limit ?? 100
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc"), fsLimit(limit)]
  if (opts.planId) constraints.unshift(where("planId", "==", opts.planId))
  if (opts.status) constraints.unshift(where("syncStatus", "==", opts.status))
  const q = query(collection(db(), PA_COLLECTIONS.instantlySyncRecords), ...constraints)
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => InstantlySyncRecordSchema.safeParse(raw),
    "instantly-sync-records",
  )
  return { rows: parsed, unparsedCount }
}

// ---------------------------------------------------------------------------
// Outreach events
// ---------------------------------------------------------------------------

export interface ListOutreachEventsOptions {
  planId?: string
  candidateId?: string
  limit?: number
}

export async function listOutreachEvents(
  opts: ListOutreachEventsOptions = {},
): Promise<PagedResult<OutreachEvent>> {
  const limit = opts.limit ?? 200
  const constraints: QueryConstraint[] = [orderBy("occurredAt", "desc"), fsLimit(limit)]
  if (opts.planId) constraints.unshift(where("planId", "==", opts.planId))
  if (opts.candidateId) constraints.unshift(where("candidateId", "==", opts.candidateId))
  const q = query(collection(db(), PA_COLLECTIONS.outreachEvents), ...constraints)
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => OutreachEventSchema.safeParse(raw),
    "outreach-events",
  )
  return { rows: parsed, unparsedCount }
}

// ---------------------------------------------------------------------------
// Source quality metrics
// ---------------------------------------------------------------------------

export async function listSourceQualityMetrics(limit = 50): Promise<PagedResult<SourceQualityMetric>> {
  const q = query(
    collection(db(), PA_COLLECTIONS.sourceQualityMetrics),
    orderBy("windowStart", "desc"),
    fsLimit(limit),
  )
  const snap = await getDocs(q)
  const { parsed, unparsedCount } = parseRows(
    snap.docs,
    (raw) => SourceQualityMetricSchema.safeParse(raw),
    "source-quality-metrics",
  )
  return { rows: parsed, unparsedCount }
}

// ---------------------------------------------------------------------------
// Correction events (existing collection; we filter to external-supply targets)
// ---------------------------------------------------------------------------

export interface CorrectionEventRow {
  id: string
  targetType?: string
  targetId?: string
  actor?: string
  reason?: string
  beforeRedacted?: unknown
  afterRedacted?: unknown
  candidateId?: string
  jobId?: string
  createdAt?: string
}

export async function listCorrectionEvents(opts: { limit?: number } = {}): Promise<{
  rows: CorrectionEventRow[]
}> {
  const limit = opts.limit ?? 100
  // Fetch a larger window because the collection is global; filter client-side
  // by target/payload for external-supply rows. V1 — small data volumes.
  const q = query(
    collection(db(), PA_COLLECTIONS.correctionEvents),
    orderBy("createdAt", "desc"),
    fsLimit(limit * 4),
  )
  const snap = await getDocs(q)
  const rows: CorrectionEventRow[] = []
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>
    const targetType = typeof data.targetType === "string" ? data.targetType : undefined
    const targetId = typeof data.targetId === "string" ? data.targetId : undefined
    rows.push({
      id: d.id,
      targetType,
      targetId,
      actor: typeof data.actor === "string" ? data.actor : undefined,
      reason: typeof data.reason === "string" ? data.reason : undefined,
      beforeRedacted: data.beforeRedacted,
      afterRedacted: data.afterRedacted,
      candidateId: typeof data.candidateId === "string" ? data.candidateId : undefined,
      jobId: typeof data.jobId === "string" ? data.jobId : undefined,
      createdAt: typeof data.createdAt === "string" ? data.createdAt : undefined,
    })
    if (rows.length >= limit) break
  }
  return { rows }
}

// ---------------------------------------------------------------------------
// Identity conflicts — existing collection, filtered to external-supply kinds
// ---------------------------------------------------------------------------

export type IdentityConflictKind =
  | "pdf_email_employer_email_mismatch"
  | "handle_candidate_mismatch"
  | "auth_candidate_mismatch"
  | "duplicate_suspicion"
  | "linkedin_email_candidate_mismatch"
  | "external_fuzzy_match"

export interface IdentityConflictRow {
  id: string
  kind: IdentityConflictKind | string
  status?: "open" | "resolved" | "dismissed" | string
  primaryCandidateId?: string
  competingCandidateId?: string
  evidence?: unknown
  payloadRedacted?: unknown
  createdAt?: string
  updatedAt?: string
  resolvedAt?: string
}

export async function listIdentityConflicts(opts: {
  kinds?: IdentityConflictKind[]
  status?: "open" | "resolved" | "dismissed"
  limit?: number
} = {}): Promise<{ rows: IdentityConflictRow[] }> {
  const limit = opts.limit ?? 100
  const constraints: QueryConstraint[] = [
    orderBy("createdAt", "desc"),
    fsLimit(limit),
  ]
  if (opts.status) constraints.unshift(where("status", "==", opts.status))
  const q = query(collection(db(), "pa-candidate-identity-conflicts"), ...constraints)
  const snap = await getDocs(q)
  const rows: IdentityConflictRow[] = []
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>
    const row: IdentityConflictRow = {
      id: d.id,
      kind: typeof data.kind === "string" ? data.kind : "unknown",
      status: typeof data.status === "string" ? data.status : undefined,
      primaryCandidateId: typeof data.primaryCandidateId === "string" ? data.primaryCandidateId : undefined,
      competingCandidateId: typeof data.competingCandidateId === "string" ? data.competingCandidateId : undefined,
      evidence: data.evidence,
      payloadRedacted: data.payloadRedacted,
      createdAt: typeof data.createdAt === "string" ? data.createdAt : undefined,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : undefined,
      resolvedAt: typeof data.resolvedAt === "string" ? data.resolvedAt : undefined,
    }
    if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes(row.kind as IdentityConflictKind)) {
      continue
    }
    rows.push(row)
  }
  return { rows }
}

// ---------------------------------------------------------------------------
// Direct upload helper for the BatchNew page
// ---------------------------------------------------------------------------

/**
 * SHA-256 in the browser via Web Crypto. Returns hex digest.
 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  const bytes = new Uint8Array(digest)
  let out = ""
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0")
  }
  return out
}

/**
 * Upload the raw export file to the signed PUT URL returned by the
 * `createBatchUploadUrl` callable. Throws on non-2xx.
 */
export async function putToSignedUrl(
  signedUrl: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const res = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  })
  if (!res.ok) {
    throw new Error(`signed_upload_failed: HTTP ${res.status} ${res.statusText}`)
  }
}

// ---------------------------------------------------------------------------
// V2 — Agent ranking results (Wave D reader; collection `pa-agent-ranking-results`)
// ---------------------------------------------------------------------------

export interface ListAgentRankingResultsOptions {
  evaluationRunId?: string
  evaluationRunIds?: string[]
  candidateRecordId?: string
  status?: AgentRankingResult["status"]
  limit?: number
}

/**
 * Paginated reader over `pa-agent-ranking-results`. Supports filtering by
 * (a) a single `evaluationRunId`, (b) a list `evaluationRunIds` (fanned out
 * client-side so the Firestore query stays single-axis), (c)
 * `candidateRecordId` for the Audit trace sub-panel, and (d) `status` for
 * the review queue. `safeParse` drops mis-shaped rows so a schema drift
 * never blanks the UI.
 */
export async function listAgentRankingResults(
  opts: ListAgentRankingResultsOptions = {},
): Promise<PagedResult<AgentRankingResult>> {
  const limit = opts.limit ?? 200

  // Helper: run one query (Firestore can't OR-filter across a single field).
  async function runQuery(
    constraints: QueryConstraint[],
  ): Promise<{ rows: AgentRankingResult[]; unparsedCount: number }> {
    const q = query(collection(db(), PA_AGENT_RANKING_RESULTS), ...constraints)
    const snap = await getDocs(q)
    const { parsed, unparsedCount } = parseRows(
      snap.docs,
      (raw) => AgentRankingResultSchema.safeParse(raw),
      "agent-ranking-results",
    )
    return { rows: parsed, unparsedCount }
  }

  if (opts.evaluationRunIds && opts.evaluationRunIds.length > 0) {
    // Fan out: one query per runId; concat + dedupe by resultId.
    const seen = new Set<string>()
    const rows: AgentRankingResult[] = []
    let unparsedCount = 0
    for (const runId of opts.evaluationRunIds) {
      const constraints: QueryConstraint[] = [
        where("evaluationRunId", "==", runId),
        fsLimit(limit),
      ]
      if (opts.status) constraints.unshift(where("status", "==", opts.status))
      const partial = await runQuery(constraints)
      unparsedCount += partial.unparsedCount
      for (const r of partial.rows) {
        if (seen.has(r.resultId)) continue
        seen.add(r.resultId)
        rows.push(r)
      }
    }
    return { rows, unparsedCount }
  }

  const constraints: QueryConstraint[] = [fsLimit(limit)]
  if (opts.evaluationRunId) {
    constraints.unshift(where("evaluationRunId", "==", opts.evaluationRunId))
  }
  if (opts.candidateRecordId) {
    constraints.unshift(where("candidateRecordId", "==", opts.candidateRecordId))
  }
  if (opts.status) {
    constraints.unshift(where("status", "==", opts.status))
  }
  return runQuery(constraints)
}

export async function getAgentRankingResult(resultId: string): Promise<AgentRankingResult | null> {
  const snap = await getDoc(doc(db(), PA_AGENT_RANKING_RESULTS, resultId))
  if (!snap.exists()) return null
  const parsed = AgentRankingResultSchema.safeParse(snap.data())
  return parsed.success ? parsed.data : null
}
