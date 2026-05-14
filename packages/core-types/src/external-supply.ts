/**
 * v2.0 External Supply V1 — Zod schemas, status enums, and deterministic doc-id
 * helpers for the external candidate sourcing intake initiative.
 *
 * Contract-binding surface owned by Executor A per
 * `.planning/external-supply-v1/PLAN.md` §5 (Data Model + Ownership).
 *
 * Locked invariants reflected here:
 *  - Candidate is the durable global asset; pa-users is the single source of
 *    truth. External-supply records reference pa-users.uid through
 *    `CandidateSourceLink`.
 *  - Raw LinkedIn URL / email / phone never used as doc ids. All hash-derived
 *    handles or uuid doc ids (see `createExternalEvaluationId`,
 *    `createOutreachEventId`, `createSourceQualityMetricId`).
 *  - Status transitions go through deterministic reducers downstream; the
 *    schemas here merely express the canonical shape of every persisted
 *    record.
 *
 * Lead resolutions (PLAN §9.1 + EXECUTOR-PLANS.md):
 *  - `ExternalSourcingBatchSchema` exposes `meta?: Record<string, unknown>`
 *    so B can audit adapter version + columnMapping + raw header sample.
 *  - `CandidateSourceLinkSchema` relaxes `candidateId` to optional and adds
 *    `status` + `pendingRecordId` so C can persist pending-review rows
 *    without a resolved candidate.
 *  - `SuppressionBlockReasonSchema` is a named export so F can switch on it
 *    without redeclaring.
 *  - `AgentResearchFindingSchema` keeps `evidenceUrls: string[]` only;
 *    `evidence: MarketplaceEvidence[]` lives one level up on the parent
 *    `AgentResearchTaskSchema`.
 *  - `createOutreachEventId` branches internally on optional providerEventId
 *    and falls back to `crypto.randomUUID()`.
 */

import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { MarketplaceEvidenceSchema } from "./marketplace.js"

// Local primitive aliases mirroring marketplace.ts (kept private there).
// Re-declared with identical constraints so external-supply.ts can ship as a
// self-contained module surface and stay decoupled from marketplace internals.
const TimestampSchema = z.string().min(1)
const IdSchema = z.string().min(1)
const ConfidenceSchema = z.number().min(0).max(1)

// ---------------------------------------------------------------------------
// §5.1 Status enums
// ---------------------------------------------------------------------------

export const ExternalSourceSchema = z.enum([
  "juicebox",
  "lessie",
  "coresignal",
  "manual_csv",
])
export type ExternalSource = z.infer<typeof ExternalSourceSchema>

export const ExternalBatchStatusSchema = z.enum([
  "uploading",
  "normalizing",
  "normalized",
  "resolving_identity",
  "ready_for_review",
  "ready_to_evaluate",
  "completed",
  "failed",
])
export type ExternalBatchStatus = z.infer<typeof ExternalBatchStatusSchema>

export const IdentityResolutionStatusSchema = z.enum([
  "pending",
  "create_new",
  "merge_existing",
  "needs_review",
  "blocked",
])
export type IdentityResolutionStatus = z.infer<typeof IdentityResolutionStatusSchema>

export const EvaluationTierSchema = z.enum([
  "tier_1_personal_linkedin_and_email",
  "tier_2_personal_email",
  "tier_3_general_email",
  "retain_only",
  "blocked",
])
export type EvaluationTier = z.infer<typeof EvaluationTierSchema>

export const OutreachChannelSchema = z.enum([
  "personal_linkedin",
  "personal_email",
  "general_email",
  "no_outreach",
])
export type OutreachChannel = z.infer<typeof OutreachChannelSchema>

export const OutreachApprovalStatusSchema = z.enum([
  "draft",
  "awaiting_approval",
  "approved",
  "rejected",
  "sent",
  "failed",
])
export type OutreachApprovalStatus = z.infer<typeof OutreachApprovalStatusSchema>

export const InstantlySyncStatusSchema = z.enum([
  "not_synced",
  "dry_run_planned",
  "queued",
  "synced",
  "sync_failed",
  "suppressed",
])
export type InstantlySyncStatus = z.infer<typeof InstantlySyncStatusSchema>

export const OutreachEventKindSchema = z.enum([
  "email_sent",
  "email_opened",
  "email_clicked",
  "email_replied",
  "email_bounced",
  "email_unsubscribed",
  "email_marked_spam",
  "manual_linkedin_sent",
  "manual_linkedin_replied",
  "candidate_interested",
  "candidate_declined",
])
export type OutreachEventKind = z.infer<typeof OutreachEventKindSchema>

export const AgentResearchReviewStatusSchema = z.enum([
  "draft_prompt",
  "prompt_copied",
  "result_imported",
  "approved",
  "rejected",
])
export type AgentResearchReviewStatus = z.infer<typeof AgentResearchReviewStatusSchema>

/**
 * Per lead resolution (PLAN §9.1) — named export so F can switch on the union
 * without re-declaring the literal set.
 */
export const SuppressionBlockReasonSchema = z.enum([
  "opted_out",
  "previously_bounced",
  "invalid_email",
  "cooldown",
  "duplicate_company_role_recent",
  "low_confidence_personalization",
])
export type SuppressionBlockReason = z.infer<typeof SuppressionBlockReasonSchema>

// ---------------------------------------------------------------------------
// §5.2 Core record schemas
// ---------------------------------------------------------------------------

const RawFileRefSchema = z.object({
  storageUri: z.string().min(1),
  mime: z.string().min(1),
  sha256: z.string().min(32),
  sizeBytes: z.number().int().nonnegative(),
})
export type RawFileRef = z.infer<typeof RawFileRefSchema>

export const ExternalSourcingBatchSchema = z.object({
  batchId: IdSchema,
  source: ExternalSourceSchema,
  companyId: IdSchema.optional(),
  jobId: IdSchema.optional(),
  status: ExternalBatchStatusSchema,
  rowCount: z.number().int().nonnegative(),
  validLinkedInCount: z.number().int().nonnegative(),
  validEmailCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  needsReviewCount: z.number().int().nonnegative(),
  readyToProfileCount: z.number().int().nonnegative(),
  rawFileRef: RawFileRefSchema,
  normalizerVersion: z.string().min(1),
  importedBy: IdSchema,
  /** Lead resolution (B Q2) — adapterVersion / columnMapping / rawHeaderSample audit. */
  meta: z.record(z.unknown()).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  notes: z.string().max(4_000).optional(),
})
export type ExternalSourcingBatch = z.infer<typeof ExternalSourcingBatchSchema>

const ExternalCandidateEmailSchema = z.object({
  value: z.string().min(1),
  hash: z.string().min(16),
})
export type ExternalCandidateEmail = z.infer<typeof ExternalCandidateEmailSchema>

const ExternalCandidateExperienceSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  startDate: z.string().min(1).optional(),
  endDate: z.string().min(1).optional(),
  durationMonths: z.number().nonnegative().optional(),
})
export type ExternalCandidateExperience = z.infer<typeof ExternalCandidateExperienceSchema>

const ExternalCandidateEducationSchema = z.object({
  school: z.string().min(1),
  degree: z.string().min(1).optional(),
  field: z.string().min(1).optional(),
  endYear: z.number().int().optional(),
})
export type ExternalCandidateEducation = z.infer<typeof ExternalCandidateEducationSchema>

export const ExternalCandidateRecordSchema = z.object({
  recordId: IdSchema,
  batchId: IdSchema,
  source: ExternalSourceSchema,
  rawPayload: z.record(z.unknown()).default({}),
  canonicalLinkedInUrl: z.string().min(1).optional(),
  linkedinProfileHash: z.string().min(16).optional(),
  emails: z.array(ExternalCandidateEmailSchema).default([]),
  phoneHash: z.string().min(16).optional(),
  name: z.string().min(1).optional(),
  currentTitle: z.string().min(1).optional(),
  currentCompany: z.string().min(1).optional(),
  experience: z.array(ExternalCandidateExperienceSchema).default([]),
  education: z.array(ExternalCandidateEducationSchema).default([]),
  location: z.string().min(1).optional(),
  sourceTags: z.array(z.string().min(1)).default([]),
  enrichment: z.record(z.unknown()).optional(),
  normalizationStatus: z.enum(["ok", "partial", "failed"]),
  normalizationErrors: z.array(z.string().min(1)).optional(),
  identityResolutionStatus: IdentityResolutionStatusSchema,
  resolvedUserId: IdSchema.optional(),
  resolutionConflictId: IdSchema.optional(),
  reviewReasons: z.array(z.string().min(1)).optional(),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type ExternalCandidateRecord = z.infer<typeof ExternalCandidateRecordSchema>

/**
 * Lead resolution (C Q4 + PLAN §9.1) — `candidateId` is optional so pending or
 * blocked source links can land without a resolved pa-users uid. `status`
 * + `pendingRecordId` keep the row addressable from the review queue.
 */
export const CandidateSourceLinkSchema = z.object({
  sourceLinkId: IdSchema,
  candidateId: IdSchema.optional(),
  status: z.enum(["linked", "pending_review", "blocked"]).default("linked"),
  pendingRecordId: IdSchema.optional(),
  source: ExternalSourceSchema,
  batchId: IdSchema,
  recordId: IdSchema,
  canonicalLinkedInUrl: z.string().min(1).optional(),
  linkedinProfileHash: z.string().min(16).optional(),
  emailHashes: z.array(z.string().min(16)).default([]),
  confidence: ConfidenceSchema.default(0.4),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  createdAt: TimestampSchema,
  createdBy: z.string().min(1),
})
export type CandidateSourceLink = z.infer<typeof CandidateSourceLinkSchema>

export const CandidateEvaluationRunSchema = z.object({
  runId: IdSchema,
  companyId: IdSchema,
  jobId: IdSchema,
  rubricVersion: z.string().min(1),
  triggeredBy: IdSchema,
  scopeRecordIds: z.array(IdSchema).optional(),
  scopeBatchId: IdSchema.optional(),
  candidateCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  status: z.enum(["queued", "running", "completed", "failed"]),
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type CandidateEvaluationRun = z.infer<typeof CandidateEvaluationRunSchema>

const CompetitorAdjacencySchema = z.object({
  matched: z.boolean(),
  confidence: ConfidenceSchema,
  evidence: z.string().min(1).optional(),
})
export type CompetitorAdjacency = z.infer<typeof CompetitorAdjacencySchema>

const IndustryAdjacencySchema = z.object({
  sector: z.string().min(1),
  confidence: ConfidenceSchema,
})
export type IndustryAdjacency = z.infer<typeof IndustryAdjacencySchema>

const ReviewerDecisionSchema = z.object({
  finalTier: EvaluationTierSchema,
  reviewer: IdSchema,
  reviewedAt: TimestampSchema,
  note: z.string().max(2_000).optional(),
})
export type ReviewerDecision = z.infer<typeof ReviewerDecisionSchema>

export const CandidateCompanyJobEvaluationSchema = z.object({
  evaluationId: IdSchema,
  candidateId: IdSchema,
  companyId: IdSchema,
  jobId: IdSchema,
  evaluationRunId: IdSchema,
  rubricVersion: z.string().min(1),
  generalRubricScore: ConfidenceSchema,
  companyRubricScore: ConfidenceSchema,
  jobRubricScore: ConfidenceSchema,
  hardGateResult: z.enum(["pass", "soft_block", "hard_block"]),
  hardGateReasons: z.array(z.string().min(1)).default([]),
  softScore: ConfidenceSchema,
  competitorAdjacency: CompetitorAdjacencySchema.optional(),
  industryAdjacency: IndustryAdjacencySchema.optional(),
  missingInfo: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  explanation: z.string().min(1).max(4_000),
  proposedTier: EvaluationTierSchema,
  reviewerDecision: ReviewerDecisionSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type CandidateCompanyJobEvaluation = z.infer<typeof CandidateCompanyJobEvaluationSchema>

/**
 * Lead resolution (A Q2 + PLAN §9.1) — keep `evidenceUrls: string[]` only;
 * the parent `AgentResearchTaskSchema.evidence` carries any
 * `MarketplaceEvidence[]` audit.
 */
export const AgentResearchFindingSchema = z.object({
  findingId: IdSchema,
  candidateId: IdSchema,
  recordId: IdSchema.optional(),
  field: z.string().min(1),
  value: z.unknown(),
  confidence: ConfidenceSchema,
  uncertainty: z.string().max(2_000).optional(),
  evidenceUrls: z.array(z.string().url()).default([]),
  approved: z.boolean().default(false),
  approvedBy: IdSchema.optional(),
  approvedAt: TimestampSchema.optional(),
})
export type AgentResearchFinding = z.infer<typeof AgentResearchFindingSchema>

export const AgentResearchTaskSchema = z.object({
  taskId: IdSchema,
  evaluationRunId: IdSchema,
  candidateIds: z.array(IdSchema).default([]),
  promptVersion: z.string().min(1),
  prompt: z.string().min(1),
  expectedJsonSchemaVersion: z.string().min(1),
  reviewStatus: AgentResearchReviewStatusSchema,
  rawResult: z.string().optional(),
  parsedFindings: z.array(AgentResearchFindingSchema).optional(),
  parseErrors: z.array(z.string().min(1)).optional(),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  reviewedBy: IdSchema.optional(),
  reviewedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type AgentResearchTask = z.infer<typeof AgentResearchTaskSchema>

export const SuppressionGateResultSchema = z.object({
  allow: z.boolean(),
  blockedReasons: z.array(SuppressionBlockReasonSchema).default([]),
  cooldownUntil: TimestampSchema.optional(),
})
export type SuppressionGateResult = z.infer<typeof SuppressionGateResultSchema>

export const OutreachPlanSchema = z.object({
  planId: IdSchema,
  candidateId: IdSchema,
  companyId: IdSchema,
  jobId: IdSchema,
  evaluationId: IdSchema,
  tier: EvaluationTierSchema,
  channelDecision: OutreachChannelSchema,
  personalizedHook: z.string().max(4_000).optional(),
  whyThisRole: z.string().max(4_000).optional(),
  whyCompany: z.string().max(4_000).optional(),
  candidateSpecificSignal: z.string().max(4_000).optional(),
  emailSubject: z.string().max(998).optional(),
  emailBody: z.string().max(20_000).optional(),
  linkedinMessage: z.string().max(20_000).optional(),
  manualLinkedInTaskStatus: z.enum(["todo", "sent", "replied", "skipped"]).optional(),
  manualLinkedInTaskAssignee: IdSchema.optional(),
  approvalStatus: OutreachApprovalStatusSchema,
  approvedBy: IdSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  rejectionReason: z.string().max(2_000).optional(),
  suppressionGateResult: SuppressionGateResultSchema,
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type OutreachPlan = z.infer<typeof OutreachPlanSchema>

export const InstantlySyncRecordSchema = z.object({
  syncId: IdSchema,
  planId: IdSchema,
  candidateId: IdSchema,
  jobId: IdSchema,
  companyId: IdSchema,
  campaignId: z.string().min(1).optional(),
  listId: z.string().min(1).optional(),
  instantlyLeadId: z.string().min(1).optional(),
  syncStatus: InstantlySyncStatusSchema,
  mode: z.enum(["dry_run", "live"]),
  dryRunPayload: z.record(z.unknown()).optional(),
  liveSyncedAt: TimestampSchema.optional(),
  lastEventAt: TimestampSchema.optional(),
  error: z.string().max(4_000).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type InstantlySyncRecord = z.infer<typeof InstantlySyncRecordSchema>

export const OutreachEventSchema = z.object({
  eventId: IdSchema,
  provider: z.enum(["instantly", "manual_linkedin", "system"]),
  providerEventId: z.string().min(1).optional(),
  candidateId: IdSchema,
  planId: IdSchema,
  jobId: IdSchema,
  companyId: IdSchema,
  kind: OutreachEventKindSchema,
  payloadRedacted: z.record(z.unknown()).default({}),
  occurredAt: TimestampSchema,
  recordedAt: TimestampSchema,
})
export type OutreachEvent = z.infer<typeof OutreachEventSchema>

export const SourceQualityMetricSchema = z.object({
  metricId: IdSchema,
  source: ExternalSourceSchema,
  windowStart: TimestampSchema,
  windowEnd: TimestampSchema,
  rowsIngested: z.number().int().nonnegative(),
  validRate: ConfidenceSchema,
  duplicateRate: ConfidenceSchema,
  identityConflictRate: ConfidenceSchema,
  replyRate: ConfidenceSchema,
  bounceRate: ConfidenceSchema,
  conversionToFirstInterview: ConfidenceSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type SourceQualityMetric = z.infer<typeof SourceQualityMetricSchema>

// ---------------------------------------------------------------------------
// §5.5 Deterministic doc-id helpers
// ---------------------------------------------------------------------------

/**
 * `pa-candidate-company-job-evaluations` doc id is composite so re-running
 * an evaluation overwrites cleanly (PLAN §15).
 */
export function createExternalEvaluationId(
  candidateId: string,
  jobId: string,
  runId: string
): string {
  return `${candidateId}__${jobId}__${runId}`
}

/**
 * `pa-outreach-events` is idempotent on `(provider, providerEventId)` when
 * the provider supplies one (Instantly webhook redelivery, manual LinkedIn
 * external id, etc.). When the caller has no stable id, fall back to a v4
 * UUID so the row still lands. PLAN §5.5 + §15.
 *
 * Treats both `undefined` and the empty string as "no provider event id".
 */
export function createOutreachEventId(provider: string, providerEventId?: string): string {
  if (providerEventId && providerEventId.length > 0) {
    // Hash providerEventId rather than embedding it raw in the doc id.
    // Provider event ids are typically opaque (Instantly `evt_*` uuids) but
    // we make zero PII assumptions — sha256 keeps the doc-id-hygiene claim
    // crisp ("all hashes or uuids") and preserves idempotency: same
    // (provider, providerEventId) -> same hash -> same id. Raw
    // providerEventId is still persisted on the doc body for audit.
    const hash = createHash("sha256").update(`${provider}:${providerEventId}`).digest("hex")
    return `${provider}__${hash}`
  }
  return randomUUID()
}

/**
 * `pa-source-quality-metrics` doc id is `${source}__${yyyyMm}` so monthly
 * rollups overwrite the same row without needing a separate lookup index
 * (PLAN §5.5).
 */
export function createSourceQualityMetricId(source: string, yyyyMm: string): string {
  return `${source}__${yyyyMm}`
}
