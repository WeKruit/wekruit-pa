import { z } from "zod"
import {
  CareerStageSchema,
  CompanyStageSchema,
  IndustrySectorSchema,
  JobTypeSchema,
  LocationSchema,
  RelevantTagsListSchema,
  RoleFunctionSchema,
  SkillsListSchema,
  VisaSchema,
} from "@wekruit/shared-tags"
export {
  PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION,
  PA_JOB_ENRICHMENT_SUBCOLLECTION,
} from "./collections.js"

const TimestampSchema = z.string().min(1)
const IdSchema = z.string().min(1)
const ConfidenceSchema = z.number().min(0).max(1)

export const CandidateLifecycleStateSchema = z.enum([
  "prospect",
  "profile_created",
  "reachable",
  "claimed",
  "profile_ready",
  "active_job_seeker",
  "retained",
  "opted_out",
  "deleted",
])
export type CandidateLifecycleState = z.infer<typeof CandidateLifecycleStateSchema>

export const CandidateJobStateSchema = z.enum([
  "candidate_matched",
  "outbound_queued",
  "outbound_sent",
  "candidate_interested",
  "prescreen_started",
  "prescreen_review_pending",
  "passed",
  "not_passed",
  "paused",
  "employer_visible",
  "archived",
])
export type CandidateJobState = z.infer<typeof CandidateJobStateSchema>

export const MarketplaceActorSchema = z.enum([
  "system",
  "orchestrator",
  "operator",
  "candidate",
  "employer",
  "worker",
  "llm",
])
export type MarketplaceActor = z.infer<typeof MarketplaceActorSchema>

export const MarketplaceEvidenceSchema = z.object({
  source: z.enum([
    "resume_parse",
    "conversation",
    "job_match",
    "outbound_delivery",
    "prescreen",
    "admin",
    "ats",
    "system",
    "llm_infer",
    "external_sourcing",
    "agent_research",
    "instantly_delivery",
  ]),
  summary: z.string().min(1).max(2_000),
  confidence: ConfidenceSchema.optional(),
  refId: z.string().min(1).optional(),
  meta: z.record(z.unknown()).optional(),
})
export type MarketplaceEvidence = z.infer<typeof MarketplaceEvidenceSchema>

export const CandidateHandleKindSchema = z.enum([
  "email",
  "phone",
  "browser_uid",
  "ats_applicant",
  "sendblue_thread",
  "imessage",
  "linkedin",
  "github",
  "calcom",
])
export type CandidateHandleKind = z.infer<typeof CandidateHandleKindSchema>

export const CandidateHandleSourceSchema = z.enum([
  "candidate",
  "resume",
  "ats",
  "sendblue",
  "admin",
  "system",
  "external_sourcing",
])
export type CandidateHandleSource = z.infer<typeof CandidateHandleSourceSchema>

export const ResumeArtifactStatusSchema = z.enum([
  "uploaded",
  "parsing",
  "parsed",
  "failed",
  "archived",
])
export type ResumeArtifactStatus = z.infer<typeof ResumeArtifactStatusSchema>

export const OptionalHttpUrlSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
}, z.string().url().optional())

export const CandidateGlobalTagsSchema = z.object({
  roleFunction: z.array(RoleFunctionSchema).default([]),
  skills: SkillsListSchema.default([]),
  careerStage: CareerStageSchema.optional(),
  // Seniority RANGE for /me — [anchor, anchor+bufferSteps] in CAREER_STAGE_VOCAB order. Derived
  // by the projector from careerStage + preferenceHardness.careerStage.bufferSteps so the portal can
  // render "junior–senior" instead of a single stage. Optional: absent when no buffer was stated.
  careerStageRange: z.tuple([CareerStageSchema, CareerStageSchema]).optional(),
  yoeRange: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional(),
  industrySector: z.array(IndustrySectorSchema).default([]),
  targetLocations: z.array(LocationSchema).default([]),
  visaStatus: VisaSchema.optional(),
  targetJobType: z.array(JobTypeSchema).default([]),
  relevantTags: RelevantTagsListSchema.default([]),
  minSalaryUsd: z.number().int().nonnegative().optional(),
  maxSalaryUsd: z.number().int().nonnegative().optional(),
  companySizePreference: z
    .array(
      z.enum([
        "seed",
        "early_startup",
        "scale_up",
        "mid_market",
        "enterprise",
        "no_preference",
        "unknown",
      ])
    )
    .default([]),
  // Company-STAGE preference (funding stage) — ORTHOGONAL to companySizePreference (headcount).
  // Projected from tags.companyStage. Multi-pick. Informational/display axis (matching weight 0).
  companyStage: z.array(CompanyStageSchema).default([]),
  updatedAt: TimestampSchema.optional(),
})
export type CandidateGlobalTags = z.infer<typeof CandidateGlobalTagsSchema>

export const CandidateLinkedinOAuthProfileSchema = z.object({
  connectedAt: TimestampSchema.optional(),
  name: z.string().min(1).max(200).optional(),
  emailMasked: z.string().min(3).max(320).optional(),
  pictureUrl: OptionalHttpUrlSchema,
})
export type CandidateLinkedinOAuthProfile = z.infer<
  typeof CandidateLinkedinOAuthProfileSchema
>

export const CandidateGithubOAuthProfileSchema = z.object({
  connectedAt: TimestampSchema.optional(),
  login: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  url: OptionalHttpUrlSchema,
  avatarUrl: OptionalHttpUrlSchema,
  emailMasked: z.string().min(3).max(320).optional(),
})
export type CandidateGithubOAuthProfile = z.infer<typeof CandidateGithubOAuthProfileSchema>

export const CandidateGithubPublicRepoSchema = z.object({
  name: z.string().min(1).max(200),
  fullName: z.string().min(1).max(300).optional(),
  url: OptionalHttpUrlSchema,
  description: z.string().min(1).max(500).optional(),
  language: z.string().min(1).max(100).optional(),
  stars: z.number().int().nonnegative().optional(),
  forks: z.number().int().nonnegative().optional(),
  updatedAt: TimestampSchema.optional(),
})
export type CandidateGithubPublicRepo = z.infer<typeof CandidateGithubPublicRepoSchema>

export const CandidateExperienceHighlightSchema = z.object({
  title: z.string().min(1).max(200),
  company: z.string().min(1).max(200),
  location: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(4_000).optional(),
  startDate: z.string().min(1).max(64).optional(),
  endDate: z.string().min(1).max(64).nullable().optional(),
  durationMonths: z.number().nonnegative().optional(),
  currentRole: z.boolean().optional(),
  department: z.string().min(1).max(120).optional(),
  managementLevel: z.string().min(1).max(120).optional(),
  companyId: z.number().int().positive().optional(),
  companyIndustry: z.string().min(1).max(200).optional(),
  companySizeRange: z.string().min(1).max(120).optional(),
  companyWebsite: OptionalHttpUrlSchema,
  companyLinkedinUrl: OptionalHttpUrlSchema,
  companyHqCity: z.string().min(1).max(120).optional(),
  companyHqCountry: z.string().min(1).max(120).optional(),
  companyLogoUrl: OptionalHttpUrlSchema,
  source: z.string().min(1).max(80).optional(),
  sourceLabel: z.string().min(1).max(120).optional(),
})
export type CandidateExperienceHighlight = z.infer<typeof CandidateExperienceHighlightSchema>

export const CandidateProfileMarketplaceFieldsSchema = z.object({
  candidateLifecycleState: CandidateLifecycleStateSchema.default("prospect"),
  lifecycleUpdatedAt: TimestampSchema.optional(),
  lifecycleReason: z.string().max(1_000).optional(),
  profileCompleteness: z.number().min(0).max(1).optional(),
  globalTags: CandidateGlobalTagsSchema.optional(),
  piiConsentAt: TimestampSchema.optional(),
  level1CollectedAt: TimestampSchema.optional(),
  mem0UserId: z.string().min(1).optional(),
  latestResumeArtifactId: z.string().min(1).optional(),
  linkedinUrl: OptionalHttpUrlSchema,
  linkedinOauthProfile: CandidateLinkedinOAuthProfileSchema.optional(),
  githubUrl: OptionalHttpUrlSchema,
  githubOauthProfile: CandidateGithubOAuthProfileSchema.optional(),
  githubPublicRepos: z.array(CandidateGithubPublicRepoSchema).max(12).optional(),
  calcomUrl: OptionalHttpUrlSchema,
  experienceHighlights: z.array(CandidateExperienceHighlightSchema).max(12).optional(),
  outreach: z
    .object({
      status: z.enum(["allowed", "cooldown", "paused", "opted_out"]).default("allowed"),
      stickyAccountGroupId: z.string().min(1).optional(),
      lastOutboundAt: TimestampSchema.optional(),
      cooldownUntil: TimestampSchema.optional(),
      optedOutAt: TimestampSchema.optional(),
    })
    .optional(),
  conversationDerivedPreferences: z.record(z.unknown()).optional(),
})
export type CandidateProfileMarketplaceFields = z.infer<
  typeof CandidateProfileMarketplaceFieldsSchema
>

export const CandidateProfileSchema = CandidateProfileMarketplaceFieldsSchema.extend({
  candidateId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type CandidateProfile = z.infer<typeof CandidateProfileSchema>

export const CandidateHandleSchema = z.object({
  handleId: IdSchema,
  candidateId: IdSchema,
  kind: CandidateHandleKindSchema,
  handleHash: z.string().min(16),
  normalizedValue: z.string().min(1).optional(),
  source: CandidateHandleSourceSchema,
  verifiedAt: TimestampSchema.nullable().optional(),
  deliverable: z.boolean().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type CandidateHandle = z.infer<typeof CandidateHandleSchema>

export const CandidateAuthMappingSchema = z.object({
  firebaseUid: IdSchema,
  candidateId: IdSchema,
  emailHandleId: IdSchema.optional(),
  emailHandleHash: z.string().min(16).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  lastClaimedAt: TimestampSchema.optional(),
})
export type CandidateAuthMapping = z.infer<typeof CandidateAuthMappingSchema>

export const CandidateSelfProfileHandleSchema = z.object({
  kind: CandidateHandleKindSchema,
  verifiedAt: TimestampSchema.nullable().optional(),
  source: CandidateHandleSourceSchema.optional(),
})
export type CandidateSelfProfileHandle = z.infer<typeof CandidateSelfProfileHandleSchema>

export const CandidateSelfProfileSchema = z.object({
  candidateId: IdSchema,
  lifecycleState: CandidateLifecycleStateSchema.default("prospect"),
  displayName: z.string().min(1).max(200).optional(),
  emailMasked: z.string().min(3).max(320).optional(),
  phoneMasked: z.string().min(3).max(64).optional(),
  handles: z.array(CandidateSelfProfileHandleSchema).default([]),
  latestResumeArtifactId: z.string().min(1).optional(),
  resumeStatus: ResumeArtifactStatusSchema.optional(),
  profileSummary: z.string().max(4_000).optional(),
  globalTags: CandidateGlobalTagsSchema.optional(),
  linkedinUrl: OptionalHttpUrlSchema,
  linkedinOauthProfile: CandidateLinkedinOAuthProfileSchema.optional(),
  githubUrl: OptionalHttpUrlSchema,
  githubOauthProfile: CandidateGithubOAuthProfileSchema.optional(),
  githubPublicRepos: z.array(CandidateGithubPublicRepoSchema).max(12).optional(),
  calcomUrl: OptionalHttpUrlSchema,
  experienceHighlights: z.array(CandidateExperienceHighlightSchema).max(12).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type CandidateSelfProfile = z.infer<typeof CandidateSelfProfileSchema>

export const IdentityEventTypeSchema = z.enum([
  "canonical_candidate_selected",
  "handle_linked",
  "candidate_claimed",
  "identity_conflict_recorded",
  "duplicate_suspected",
  "merge_decision_recorded",
  "external_source_linked",
  "external_candidate_imported",
])
export type IdentityEventType = z.infer<typeof IdentityEventTypeSchema>

export const CandidateIdentityEventSchema = z.object({
  eventId: IdSchema,
  type: IdentityEventTypeSchema,
  actor: MarketplaceActorSchema,
  candidateId: IdSchema.optional(),
  relatedCandidateId: IdSchema.optional(),
  firebaseUid: IdSchema.optional(),
  handleId: IdSchema.optional(),
  handleKind: CandidateHandleKindSchema.optional(),
  handleHash: z.string().min(16).optional(),
  conflictId: IdSchema.optional(),
  source: z.enum(["candidate", "resume", "ats", "sendblue", "admin", "system", "auth", "external_sourcing"]),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  payloadRedacted: z.record(z.unknown()).default({}),
  createdAt: TimestampSchema,
})
export type CandidateIdentityEvent = z.infer<typeof CandidateIdentityEventSchema>

export const IdentityConflictKindSchema = z.enum([
  "pdf_email_employer_email_mismatch",
  "handle_candidate_mismatch",
  "auth_candidate_mismatch",
  "duplicate_suspicion",
  "linkedin_email_candidate_mismatch",
  "external_fuzzy_match",
])
export type IdentityConflictKind = z.infer<typeof IdentityConflictKindSchema>

export const CandidateIdentityConflictSchema = z.object({
  conflictId: IdSchema,
  kind: IdentityConflictKindSchema,
  status: z.enum(["open", "resolved", "dismissed"]).default("open"),
  primaryCandidateId: IdSchema.optional(),
  competingCandidateId: IdSchema.optional(),
  firebaseUid: IdSchema.optional(),
  handleKind: CandidateHandleKindSchema.optional(),
  handleId: IdSchema.optional(),
  handleHash: z.string().min(16).optional(),
  pdfEmailHash: z.string().min(16).optional(),
  employerEmailHash: z.string().min(16).optional(),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  payloadRedacted: z.record(z.unknown()).default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  resolvedAt: TimestampSchema.optional(),
  resolvedBy: z.string().min(1).optional(),
  resolution: z.string().max(2_000).optional(),
})
export type CandidateIdentityConflict = z.infer<typeof CandidateIdentityConflictSchema>

export const CandidateIdentityResolutionSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("resolved_existing"),
    candidateId: IdSchema,
    handle: CandidateHandleSchema,
  }),
  z.object({
    outcome: z.literal("created"),
    candidateId: IdSchema,
    handle: CandidateHandleSchema,
  }),
  z.object({
    outcome: z.literal("identity_conflict"),
    conflict: CandidateIdentityConflictSchema,
  }),
  // Identity hardening 2026-05-21 — returned only when the resolver is
  // called with `mode: "resolve_only"` and no existing handle matches.
  // Used by the magic-link claim path so email-only sign-ins can never
  // create a fresh pa-users row (L1 entry points are resume + OAuth).
  z.object({
    outcome: z.literal("not_found"),
  }),
])
export type CandidateIdentityResolution = z.infer<typeof CandidateIdentityResolutionSchema>

export const CandidateClaimResultSchema = z.object({
  candidateId: IdSchema,
  authMapping: CandidateAuthMappingSchema,
  selfProfile: CandidateSelfProfileSchema,
  emailHandle: CandidateHandleSchema,
  claimedEventId: IdSchema,
  idempotent: z.boolean(),
})
export type CandidateClaimResult = z.infer<typeof CandidateClaimResultSchema>

export const ResumeArtifactSchema = z.object({
  resumeId: IdSchema,
  candidateId: IdSchema,
  status: ResumeArtifactStatusSchema,
  source: z.enum(["candidate_upload", "employer_bulk", "ats", "admin", "system"]),
  storageUri: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  sha256: z.string().min(32).optional(),
  parsedCandidateResumeId: z.string().min(1).optional(),
  candidateProfileSummary: z.string().max(4_000).optional(),
  error: z.string().max(2_000).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type ResumeArtifact = z.infer<typeof ResumeArtifactSchema>

export const BulkResumeBatchStatusSchema = z.enum([
  "draft",
  "queued",
  "processing",
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
])
export type BulkResumeBatchStatus = z.infer<typeof BulkResumeBatchStatusSchema>

export const BulkResumeItemStatusSchema = z.enum([
  "queued",
  "parsing",
  "parsed",
  "missing_email_review",
  "identity_conflict",
  "parse_failed",
  "failed",
  "retry_ready",
])
export type BulkResumeItemStatus = z.infer<typeof BulkResumeItemStatusSchema>

export const BulkResumeBatchCountsSchema = z.object({
  total: z.number().int().nonnegative().default(0),
  queued: z.number().int().nonnegative().default(0),
  parsing: z.number().int().nonnegative().default(0),
  parsed: z.number().int().nonnegative().default(0),
  review: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  retryReady: z.number().int().nonnegative().default(0),
})
export type BulkResumeBatchCounts = z.infer<typeof BulkResumeBatchCountsSchema>

export const BulkResumeBatchSchema = z.object({
  batchId: IdSchema,
  label: z.string().min(1).max(200),
  source: z.string().min(1).max(100),
  jobId: IdSchema.optional(),
  createdBy: z.string().min(1),
  status: BulkResumeBatchStatusSchema,
  counts: BulkResumeBatchCountsSchema.default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  errorReason: z.string().max(2_000).optional(),
})
export type BulkResumeBatch = z.infer<typeof BulkResumeBatchSchema>

export const BulkResumeItemSchema = z.object({
  itemId: IdSchema,
  batchId: IdSchema,
  fileName: z.string().min(1).max(500),
  fileSha256: z.string().min(32),
  fileSizeBytes: z.number().int().nonnegative().optional(),
  storageUri: z.string().min(1).optional(),
  employerEmailHint: z.string().email().optional(),
  employerEmailHintHash: z.string().min(16).optional(),
  employerEmailHintMasked: z.string().min(3).max(320).optional(),
  extractedEmailHash: z.string().min(16).optional(),
  extractedEmailMasked: z.string().min(3).max(320).optional(),
  status: BulkResumeItemStatusSchema,
  candidateId: IdSchema.optional(),
  resumeArtifactId: IdSchema.optional(),
  parsedCandidateResumeId: IdSchema.optional(),
  conflictId: IdSchema.optional(),
  retryCount: z.number().int().nonnegative().default(0),
  errorReason: z.string().max(2_000).optional(),
  idempotencyKey: z.string().min(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  lastProcessedAt: TimestampSchema.optional(),
})
export type BulkResumeItem = z.infer<typeof BulkResumeItemSchema>

export const CandidateJobStateDocSchema = z.object({
  id: IdSchema,
  candidateId: IdSchema,
  jobId: IdSchema,
  state: CandidateJobStateSchema,
  previousState: CandidateJobStateSchema.optional(),
  stateUpdatedAt: TimestampSchema,
  reason: z.string().max(1_000).optional(),
  prescreenSessionId: z.string().min(1).optional(),
  employerVisibleProfileId: z.string().min(1).optional(),
  outboundInviteId: z.string().min(1).optional(),
  outboundId: z.string().min(1).optional(),
  latestMatchId: z.string().min(1).optional(),
  archivedAt: TimestampSchema.optional(),
})
export type CandidateJobStateDoc = z.infer<typeof CandidateJobStateDocSchema>

export const CandidateJobMatchDirectionSchema = z.enum(["candidate_to_job", "job_to_candidate"])
export type CandidateJobMatchDirection = z.infer<typeof CandidateJobMatchDirectionSchema>

export const CandidateJobMatchScoreComponentSchema = z.object({
  score: ConfidenceSchema,
  weight: z.number().min(0).max(1).optional(),
  summary: z.string().min(1).max(1_000).optional(),
})
export type CandidateJobMatchScoreComponent = z.infer<
  typeof CandidateJobMatchScoreComponentSchema
>

export const CandidateJobMatchScoreBreakdownSchema = z
  .record(CandidateJobMatchScoreComponentSchema)
  .refine((value) => Object.keys(value).length > 0, {
    message: "scoreBreakdown must include at least one score component",
  })
export type CandidateJobMatchScoreBreakdown = z.infer<
  typeof CandidateJobMatchScoreBreakdownSchema
>

export const CandidateJobMatchSchema = z
  .object({
    matchId: IdSchema,
    candidateId: IdSchema,
    jobId: IdSchema,
    direction: CandidateJobMatchDirectionSchema,
    matchVersion: IdSchema,
    jobEnrichmentVersion: IdSchema,
    computedAt: TimestampSchema,
    scoreBreakdown: CandidateJobMatchScoreBreakdownSchema,
    matchedSignals: z.array(z.string().min(1)).default([]),
    blockedSignals: z.array(z.string().min(1)).default([]),
    candidateLifecycleStateAtMatch: CandidateLifecycleStateSchema,
    candidateTagsUpdatedAt: TimestampSchema,
    staleAt: TimestampSchema.optional(),
    hardFilterResult: z.enum(["pass", "soft_block", "hard_block", "unknown"]),
    softScore: ConfidenceSchema.optional(),
    llmScore: ConfidenceSchema.optional(),
    finalScore: ConfidenceSchema.optional(),
    finalRank: z.number().int().positive().optional(),
    reasons: z.array(z.string().min(1)).default([]),
    risks: z.array(z.string().min(1)).default([]),
    missingInfo: z.array(z.string().min(1)).default([]),
    recommendedAction: z.enum(["auto_outbound", "hitl_review", "do_not_contact"]),
    evidence: z.array(MarketplaceEvidenceSchema).default([]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema.optional(),
  })
  .refine((value) => value.matchId === createCandidateJobMatchId(value.candidateId, value.jobId), {
    message: "matchId must equal createCandidateJobMatchId(candidateId, jobId)",
    path: ["matchId"],
  })
export type CandidateJobMatch = z.infer<typeof CandidateJobMatchSchema>

export const OutboundInviteApprovalStateSchema = z.enum([
  "not_required",
  "pending",
  "approved",
  "rejected",
])
export type OutboundInviteApprovalState = z.infer<typeof OutboundInviteApprovalStateSchema>

export const OutreachPolicyDecisionSchema = z.enum([
  "auto_outbound",
  "hitl_review",
  "do_not_contact",
  "blocked",
])
export type OutreachPolicyDecision = z.infer<typeof OutreachPolicyDecisionSchema>

export const OutreachCapacitySnapshotSchema = z.object({
  groupId: IdSchema,
  fromNumber: z.string().min(1).optional(),
  status: z.enum(["active", "warmup", "paused", "throttled", "degraded", "missing", "unknown"]),
  dailyCap: z.number().int().nonnegative(),
  usedToday: z.number().int().nonnegative(),
  remainingToday: z.number().int().nonnegative(),
  rolling24hUsed: z.number().int().nonnegative().optional(),
  checkedAt: TimestampSchema,
  reason: z.string().max(500).optional(),
})
export type OutreachCapacitySnapshot = z.infer<typeof OutreachCapacitySnapshotSchema>

export const OutboundInviteCapacitySnapshotSchema = OutreachCapacitySnapshotSchema
export type OutboundInviteCapacitySnapshot = OutreachCapacitySnapshot

export const OutboundInviteCandidateResponseSchema = z.object({
  status: z.enum(["interested", "declined", "do_not_contact", "needs_follow_up", "unknown"]),
  respondedAt: TimestampSchema,
  summary: z.string().min(1).max(1_000).optional(),
  feedbackEventId: z.string().min(1).optional(),
})
export type OutboundInviteCandidateResponse = z.infer<
  typeof OutboundInviteCandidateResponseSchema
>

export const OutreachDecisionSchema = z.object({
  inviteId: IdSchema,
  candidateId: IdSchema,
  jobId: IdSchema,
  matchId: z.string().min(1).optional(),
  policyVersion: IdSchema,
  policyDecision: OutreachPolicyDecisionSchema,
  decisionReason: z.string().min(1).max(1_000),
  blockedSignals: z.array(z.string().min(1)).default([]),
  missingInfo: z.array(z.string().min(1)).default([]),
  cooldownUntil: TimestampSchema.optional(),
  stickyAccountGroupId: z.string().min(1).optional(),
  capacitySnapshot: OutreachCapacitySnapshotSchema.optional(),
  approvalState: OutboundInviteApprovalStateSchema.default("not_required"),
  dryRun: z.boolean().default(true),
  idempotencyKey: IdSchema,
  duplicateSuppressionKey: IdSchema,
  outboundId: z.string().min(1).optional(),
  decidedAt: TimestampSchema,
})
export type OutreachDecision = z.infer<typeof OutreachDecisionSchema>

export const OutboundInviteSchema = z.object({
  inviteId: IdSchema,
  candidateId: IdSchema,
  jobId: IdSchema,
  candidateJobStateId: IdSchema,
  matchId: z.string().min(1).optional(),
  status: z.enum([
    "draft",
    "blocked",
    "approved",
    "queued",
    "sent",
    "delivered",
    "failed",
    "dead_letter",
    "declined",
    "expired",
    "cancelled",
  ]),
  policyDecision: OutreachPolicyDecisionSchema,
  approvalState: OutboundInviteApprovalStateSchema.default("not_required"),
  dryRun: z.boolean().default(true),
  policyVersion: IdSchema,
  decisionReason: z.string().min(1).max(1_000),
  blockedSignals: z.array(z.string().min(1)).default([]),
  missingInfo: z.array(z.string().min(1)).default([]),
  outboundId: z.string().min(1).optional(),
  stickyAccountGroupId: z.string().min(1).optional(),
  capacitySnapshot: OutreachCapacitySnapshotSchema.optional(),
  cooldownUntil: TimestampSchema.optional(),
  duplicateSuppressionKey: z.string().min(1).optional(),
  approvedAt: TimestampSchema.optional(),
  approvedBy: z.string().min(1).optional(),
  rejectedAt: TimestampSchema.optional(),
  rejectedBy: z.string().min(1).optional(),
  rejectionReason: z.string().min(1).max(1_000).optional(),
  queuedAt: TimestampSchema.optional(),
  sentAt: TimestampSchema.optional(),
  deliveredAt: TimestampSchema.optional(),
  failedAt: TimestampSchema.optional(),
  providerStatus: z.string().min(1).optional(),
  lastError: z.string().max(2_000).optional(),
  candidateResponse: OutboundInviteCandidateResponseSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type OutboundInvite = z.infer<typeof OutboundInviteSchema>

const EMPLOYER_VISIBLE_BLOCKED_HOSTS = [
  "linkedin.com",
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
]
const EVAL_ARTIFACT_FORBIDDEN_KEYS = new Set([
  "correctiontext",
  "freeform",
  "messagebody",
  "prompt",
  "prompttext",
  "rawcorrectiontext",
  "rawmessage",
  "rawprompt",
  "rawtext",
  "rawtranscript",
  "resumestorageuri",
  "storageuri",
  "systemprompt",
  "transcript",
  "transcripttext",
  "userprompt",
])

function isBlockedEmployerVisibleHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "")
  return EMPLOYER_VISIBLE_BLOCKED_HOSTS.some(
    (blocked) => normalized === blocked || normalized.endsWith(`.${blocked}`)
  )
}

function containsEmployerVisibleRawLocator(value: string): boolean {
  if (/\bgs:\/\//i.test(value)) return true

  for (const match of value.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    const rawUrl = match[0].replace(/[),.;]+$/g, "")
    try {
      if (isBlockedEmployerVisibleHost(new URL(rawUrl).hostname)) return true
    } catch {
      // Ignore malformed URL-like text; other raw contact checks still apply.
    }
  }

  return false
}

function containsEmployerVisibleRawContact(value: unknown): boolean {
  if (typeof value === "string") {
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) return true
    if (/(?:\+?\d[\s().-]*){9,}/.test(value)) return true
    if (containsEmployerVisibleRawLocator(value)) return true
  }
  if (Array.isArray(value)) return value.some(containsEmployerVisibleRawContact)
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsEmployerVisibleRawContact)
  }
  return false
}

function containsEvalArtifactUnsafeValue(value: unknown): boolean {
  if (typeof value === "string") {
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) return true
    if (/(?:\+?\d[\s().-]*){9,}/.test(value)) return true
    if (containsEmployerVisibleRawLocator(value)) return true
  }
  if (Array.isArray(value)) return value.some(containsEvalArtifactUnsafeValue)
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
      if (EVAL_ARTIFACT_FORBIDDEN_KEYS.has(key.toLowerCase())) return true
      return containsEvalArtifactUnsafeValue(nested)
    })
  }
  return false
}

const EmployerVisibleProfileShape = z.object({
  snapshotId: IdSchema,
  candidateId: IdSchema,
  jobId: IdSchema,
  candidateJobStateId: IdSchema,
  createdFromState: z.literal("passed"),
  sourcePrescreenSessionId: IdSchema.optional(),
  sourceMatchId: IdSchema.optional(),
  sourceResumeArtifactId: IdSchema.optional(),
  displayName: z.string().min(1).max(200).optional(),
  profileSummary: z.string().max(4_000).optional(),
  resumeSummary: z.string().max(4_000).optional(),
  tagsSnapshot: CandidateGlobalTagsSchema.optional(),
  level1Snapshot: z.record(z.unknown()).optional(),
  transcriptSummary: z.string().max(4_000).optional(),
  passReason: z.string().max(2_000).optional(),
  matchReason: z.string().max(2_000).optional(),
  consentAt: TimestampSchema.optional(),
  piiConsentAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  createdBy: MarketplaceActorSchema.default("system"),
})

type EmployerVisibleProfileInput = z.input<typeof EmployerVisibleProfileShape>

function employerVisibleRedactionSurface(snapshot: EmployerVisibleProfileInput): unknown {
  return {
    sourceResumeArtifactId: snapshot.sourceResumeArtifactId,
    displayName: snapshot.displayName,
    profileSummary: snapshot.profileSummary,
    resumeSummary: snapshot.resumeSummary,
    level1Snapshot: snapshot.level1Snapshot,
    transcriptSummary: snapshot.transcriptSummary,
    passReason: snapshot.passReason,
    matchReason: snapshot.matchReason,
  }
}

export const EmployerVisibleProfileSchema = z
  .object(EmployerVisibleProfileShape.shape)
  .superRefine((snapshot, ctx) => {
    if (snapshot.snapshotId !== createEmployerVisibleProfileId(snapshot.jobId, snapshot.candidateId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshotId"],
        message: "snapshotId must equal createEmployerVisibleProfileId(jobId, candidateId)",
      })
    }
    if (containsEmployerVisibleRawContact(employerVisibleRedactionSurface(snapshot))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "EmployerVisibleProfile must not contain raw contact or storage locator values",
      })
    }
  })
export type EmployerVisibleProfile = z.infer<typeof EmployerVisibleProfileSchema>

export const FeedbackEventSchema = z.object({
  eventId: IdSchema,
  kind: z.enum([
    "candidate_reply",
    "candidate_decline",
    "prescreen_outcome",
    "employer_action",
    "match_feedback",
    "outreach_delivery",
    "manual_note",
    "candidate_behavior",
  ]),
  actor: MarketplaceActorSchema,
  candidateId: IdSchema.optional(),
  jobId: IdSchema.optional(),
  candidateJobStateId: IdSchema.optional(),
  outcome: z.string().max(200).optional(),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  payloadRedacted: z.record(z.unknown()).default({}),
  createdAt: TimestampSchema,
})
export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>

export const CorrectionEventSchema = z.object({
  eventId: IdSchema,
  targetType: z.enum([
    "candidate_profile",
    "candidate_job_state",
    "candidate_job_match",
    "job_tags",
    "job_enrichment_draft",
    "job_prescreen_config",
    "job_candidate_brief",
    "job_eval_fixture",
    "user_tags",
    "employer_visible_profile",
    "feedback_event",
    "outbound_copy",
    "evaluation_attempt",
    // V2 external-supply Wave A — agent-ranking HITL override correction event.
    "agent_ranking_result",
  ]),
  targetId: IdSchema,
  actor: z.enum(["operator", "system", "candidate"]),
  candidateId: IdSchema.optional(),
  jobId: IdSchema.optional(),
  reason: z.string().min(1).max(2_000),
  beforeRedacted: z.record(z.unknown()).default({}),
  afterRedacted: z.record(z.unknown()).default({}),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  createdAt: TimestampSchema,
})
export type CorrectionEvent = z.infer<typeof CorrectionEventSchema>

export const EvalArtifactKindSchema = z.enum([
  "correction_regression_fixture",
  "marketplace_simulation",
  "ranking_eval",
  "job_intake_eval",
  "safety_eval",
  "live_smoke",
  "candidate_profile_correction",
])
export type EvalArtifactKind = z.infer<typeof EvalArtifactKindSchema>

export const EvalArtifactStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "passed",
  "failed",
  "needs_review",
  "archived",
])
export type EvalArtifactStatus = z.infer<typeof EvalArtifactStatusSchema>

export const EvalArtifactRunResultSchema = z.object({
  status: z.enum(["not_run", "pass", "fail", "error"]).default("not_run"),
  runId: IdSchema.optional(),
  runAt: TimestampSchema.optional(),
  command: z.string().min(1).max(1_000).optional(),
  summary: z.string().max(2_000).optional(),
  metrics: z.record(z.unknown()).default({}),
  artifactPath: z.string().min(1).max(1_000).optional(),
})
export type EvalArtifactRunResult = z.infer<typeof EvalArtifactRunResultSchema>

const EvalArtifactShape = z.object({
  artifactId: IdSchema,
  kind: EvalArtifactKindSchema,
  status: EvalArtifactStatusSchema.default("draft"),
  sourceCorrectionEventIds: z.array(IdSchema).default([]),
  sourceFeedbackEventIds: z.array(IdSchema).default([]),
  scenarioRef: z.string().min(1).max(300).optional(),
  runRef: z.string().min(1).max(300).optional(),
  candidateId: IdSchema.optional(),
  jobId: IdSchema.optional(),
  candidateJobStateId: IdSchema.optional(),
  payloadRedacted: z.record(z.unknown()).default({}),
  latestRunResult: EvalArtifactRunResultSchema.optional(),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  createdBy: MarketplaceActorSchema.default("system"),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})

export const EvalArtifactSchema = z.object(EvalArtifactShape.shape).superRefine((artifact, ctx) => {
  const hasSource =
    artifact.sourceCorrectionEventIds.length > 0 ||
    artifact.sourceFeedbackEventIds.length > 0 ||
    Boolean(artifact.scenarioRef) ||
    Boolean(artifact.runRef)
  if (!hasSource) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceCorrectionEventIds"],
      message: "EvalArtifact must reference a correction event, feedback event, scenario, or run",
    })
  }
  if (containsEvalArtifactUnsafeValue({
    payloadRedacted: artifact.payloadRedacted,
    latestRunResult: artifact.latestRunResult,
    evidence: artifact.evidence,
  })) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "EvalArtifact must not contain raw PII, storage locators, prompts, or transcripts",
    })
  }
})
export type EvalArtifact = z.infer<typeof EvalArtifactSchema>

export const PrivacyRequestKindSchema = z.enum([
  "export",
  "delete",
  "stop_outreach",
  "privacy_question",
])
export type PrivacyRequestKind = z.infer<typeof PrivacyRequestKindSchema>

export const PrivacyRequestStatusSchema = z.enum([
  "submitted",
  "in_review",
  "resolved",
  "rejected",
  "cancelled",
])
export type PrivacyRequestStatus = z.infer<typeof PrivacyRequestStatusSchema>

export const PrivacyRequestSourceSurfaceSchema = z.enum([
  "me_profile",
  "imessage",
  "admin",
  "system",
])
export type PrivacyRequestSourceSurface = z.infer<typeof PrivacyRequestSourceSurfaceSchema>

const PrivacyRequestShape = z.object({
  requestId: IdSchema,
  kind: PrivacyRequestKindSchema,
  status: PrivacyRequestStatusSchema.default("submitted"),
  candidateId: IdSchema,
  sourceSurface: PrivacyRequestSourceSurfaceSchema.default("me_profile"),
  requestedBy: MarketplaceActorSchema.default("candidate"),
  detailRedacted: z.record(z.unknown()).default({}),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  resolvedAt: TimestampSchema.optional(),
  resolvedBy: z.string().min(1).optional(),
  resolutionSummary: z.string().max(2_000).optional(),
})

export const PrivacyRequestSchema = z.object(PrivacyRequestShape.shape).superRefine((request, ctx) => {
  if (containsEvalArtifactUnsafeValue({
    detailRedacted: request.detailRedacted,
    evidence: request.evidence,
    resolutionSummary: request.resolutionSummary,
  })) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "PrivacyRequest must contain redacted request details only",
    })
  }
})
export type PrivacyRequest = z.infer<typeof PrivacyRequestSchema>

export const LaunchReadinessStatusSchema = z.enum(["green", "yellow", "red", "unknown"])
export type LaunchReadinessStatus = z.infer<typeof LaunchReadinessStatusSchema>

export const LaunchReadinessSectionSchema = z.object({
  key: z.string().min(1).max(120),
  label: z.string().min(1).max(200),
  status: LaunchReadinessStatusSchema,
  count: z.number().int().nonnegative().optional(),
  summary: z.string().min(1).max(2_000).optional(),
  sourceRoute: z.string().min(1).max(300).optional(),
  updatedAt: TimestampSchema.optional(),
})
export type LaunchReadinessSection = z.infer<typeof LaunchReadinessSectionSchema>

export const LaunchReadinessPrivacyRequestRowSchema = z.object({
  requestId: IdSchema,
  kind: PrivacyRequestKindSchema,
  status: PrivacyRequestStatusSchema,
  candidateId: IdSchema.optional(),
  sourceSurface: PrivacyRequestSourceSurfaceSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type LaunchReadinessPrivacyRequestRow = z.infer<
  typeof LaunchReadinessPrivacyRequestRowSchema
>

export const LaunchReadinessStopControlRowSchema = z.object({
  controlId: IdSchema,
  scope: z.enum(["global", "outreach_batch"]),
  scopeId: IdSchema.optional(),
  paused: z.boolean(),
  reason: z.string().max(1_000).optional(),
  updatedAt: TimestampSchema.optional(),
})
export type LaunchReadinessStopControlRow = z.infer<
  typeof LaunchReadinessStopControlRowSchema
>

const LaunchReadinessSnapshotShape = z.object({
  snapshotId: IdSchema,
  generatedAt: TimestampSchema,
  status: LaunchReadinessStatusSchema,
  counts: z.record(z.number().int().nonnegative()).default({}),
  sections: z.array(LaunchReadinessSectionSchema).default([]),
  privacyRequests: z.array(LaunchReadinessPrivacyRequestRowSchema).default([]),
  stopControls: z.array(LaunchReadinessStopControlRowSchema).default([]),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
})

export const LaunchReadinessSnapshotSchema = z
  .object(LaunchReadinessSnapshotShape.shape)
  .superRefine((snapshot, ctx) => {
    if (containsEvalArtifactUnsafeValue(snapshot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "LaunchReadinessSnapshot must contain redacted summaries only",
      })
    }
  })
export type LaunchReadinessSnapshot = z.infer<typeof LaunchReadinessSnapshotSchema>

export const OutreachStopControlScopeSchema = z.enum(["global", "outreach_batch"])
export type OutreachStopControlScope = z.infer<typeof OutreachStopControlScopeSchema>

const OutreachStopControlShape = z.object({
  controlId: IdSchema,
  scope: OutreachStopControlScopeSchema,
  scopeId: IdSchema.optional(),
  paused: z.boolean().default(false),
  reason: z.string().min(1).max(1_000).optional(),
  actor: MarketplaceActorSchema.default("operator"),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  expiresAt: TimestampSchema.optional(),
})

export const OutreachStopControlSchema = z
  .object(OutreachStopControlShape.shape)
  .superRefine((control, ctx) => {
    if (control.scope === "global" && control.scopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "global outreach stop control must not include scopeId",
      })
    }
    if (control.scope === "outreach_batch" && !control.scopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "outreach_batch stop control requires scopeId",
      })
    }
    if (control.paused && !control.reason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "paused outreach stop control requires a reason",
      })
    }
    if (containsEvalArtifactUnsafeValue({
      reason: control.reason,
      scopeId: control.scopeId,
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "OutreachStopControl must not contain raw PII or storage locators",
      })
    }
  })
export type OutreachStopControl = z.infer<typeof OutreachStopControlSchema>

export const RawJobSnapshotSchema = z.object({
  source: z.enum(["ats", "admin", "crawler", "employer", "system"]),
  capturedAt: TimestampSchema,
  title: z.string().min(1).max(300),
  companyName: z.string().min(1).max(300).optional(),
  description: z.string().min(1).max(50_000).optional(),
  applyUrl: z.string().url().optional(),
  locationText: z.string().max(1_000).optional(),
  compensationText: z.string().max(1_000).optional(),
  metadata: z.record(z.unknown()).default({}),
})
export type RawJobSnapshot = z.infer<typeof RawJobSnapshotSchema>

export const JobEnrichedTagsSchema = z.object({
  roleFunction: z.array(RoleFunctionSchema).default([]),
  industrySector: z.array(IndustrySectorSchema).default([]),
  skills: SkillsListSchema.default([]),
  careerStage: CareerStageSchema.optional(),
  relevantTags: RelevantTagsListSchema.default([]),
})
export type JobEnrichedTags = z.infer<typeof JobEnrichedTagsSchema>

export const JobHardFiltersSchema = z.object({
  sponsorshipAvailable: z.boolean().nullable(),
  locations: z.array(LocationSchema).default([]),
  jobTypes: z.array(JobTypeSchema).default([]),
  minYears: z.number().nonnegative().optional(),
  maxYears: z.number().nonnegative().optional(),
  salaryMinUsd: z.number().int().nonnegative().optional(),
  salaryMaxUsd: z.number().int().nonnegative().optional(),
})
export type JobHardFilters = z.infer<typeof JobHardFiltersSchema>

export const JobSoftScoringWeightsSchema = z
  .object({
    skills: z.number().min(0).max(1).default(0),
    roleFunction: z.number().min(0).max(1).default(0),
    industrySector: z.number().min(0).max(1).default(0),
    location: z.number().min(0).max(1).default(0),
    compensation: z.number().min(0).max(1).default(0),
    visa: z.number().min(0).max(1).default(0),
    companyPreference: z.number().min(0).max(1).default(0),
  })
  .refine((weights) => Object.values(weights).reduce((sum, value) => sum + value, 0) <= 1.000001, {
    message: "soft scoring weights must sum to 1 or less",
  })
export type JobSoftScoringWeights = z.infer<typeof JobSoftScoringWeightsSchema>

const JobPrescreenQuestionDraftSchema = z.object({
  questionId: IdSchema,
  prompt: z.string().min(1).max(1_000),
  signal: z.string().min(1).max(300),
  required: z.boolean().default(true),
})

export const JobPrescreenConfigDraftSchema = z.object({
  questions: z.array(JobPrescreenQuestionDraftSchema).default([]),
  introPrompt: z.string().max(1_000).optional(),
  passSignals: z.array(z.string().min(1).max(300)).default([]),
})
export type JobPrescreenConfigDraft = z.infer<typeof JobPrescreenConfigDraftSchema>

export const JobScoringRubricSchema = z.object({
  mustHave: z.array(z.string().min(1).max(500)).default([]),
  niceToHave: z.array(z.string().min(1).max(500)).default([]),
  disqualifiers: z.array(z.string().min(1).max(500)).default([]),
})
export type JobScoringRubric = z.infer<typeof JobScoringRubricSchema>

export const JobCandidateBriefSchema = z.object({
  headline: z.string().min(1).max(500),
  sellingPoints: z.array(z.string().min(1).max(500)).default([]),
  risksToClarify: z.array(z.string().min(1).max(500)).default([]),
})
export type JobCandidateBrief = z.infer<typeof JobCandidateBriefSchema>

export const JobEnrichmentCoverageSchema = z.object({
  overall: z.enum(["low", "medium", "high"]),
  missingSignals: z.array(z.string().min(1).max(200)).default([]),
  seniorityEvidence: z.enum(["none", "title_only", "explicit_years", "rubric", "operator_confirmed"]),
  sponsorshipSignal: z.enum(["silent", "explicit_yes", "explicit_no"]),
})
export type JobEnrichmentCoverage = z.infer<typeof JobEnrichmentCoverageSchema>

export const JobEnrichmentHitlFlagSchema = z.object({
  flagId: IdSchema,
  kind: z.enum([
    "low_coverage",
    "conflicting_evidence",
    "sensitive_filter",
    "seniority_title_only",
    "operator_review",
  ]),
  severity: z.enum(["info", "review", "blocking"]),
  reason: z.string().min(1).max(1_000),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
})
export type JobEnrichmentHitlFlag = z.infer<typeof JobEnrichmentHitlFlagSchema>

export const JobOpportunitySchema = z.object({
  title: z.string().min(1).max(300),
  companyName: z.string().min(1).max(300).optional(),
  roleFunction: z.array(RoleFunctionSchema).default([]),
  industrySector: z.array(IndustrySectorSchema).default([]),
  skills: SkillsListSchema.default([]),
  relevantTags: RelevantTagsListSchema.default([]),
  seniority: z.object({
    label: z.string().min(1).max(100).optional(),
    minYears: z.number().nonnegative().optional(),
    maxYears: z.number().nonnegative().optional(),
    evidence: z.array(MarketplaceEvidenceSchema).default([]),
  }).default({}),
  hardFilters: JobHardFiltersSchema,
  softScoringWeights: JobSoftScoringWeightsSchema.default({}),
  prescreen: JobPrescreenConfigDraftSchema.default({}),
  scoringRubric: JobScoringRubricSchema.default({}),
  candidateBrief: JobCandidateBriefSchema.optional(),
})
export type JobOpportunity = z.infer<typeof JobOpportunitySchema>

export const JobOpportunityPublicSchema = z.object({
  title: z.string().min(1).max(300),
  companyName: z.string().min(1).max(300).optional(),
  roleFunction: z.array(RoleFunctionSchema).default([]),
  industrySector: z.array(IndustrySectorSchema).default([]),
  skills: SkillsListSchema.default([]),
  relevantTags: RelevantTagsListSchema.default([]),
  seniority: z
    .object({
      label: z.string().min(1).max(100).optional(),
      minYears: z.number().nonnegative().optional(),
      maxYears: z.number().nonnegative().optional(),
    })
    .default({}),
  hardFilters: JobHardFiltersSchema,
})
export type JobOpportunityPublic = z.infer<typeof JobOpportunityPublicSchema>

export function toPublicJobOpportunity(rawOpportunity: JobOpportunity): JobOpportunityPublic {
  const opportunity = JobOpportunitySchema.parse(rawOpportunity)
  return JobOpportunityPublicSchema.parse({
    title: opportunity.title,
    companyName: opportunity.companyName,
    roleFunction: opportunity.roleFunction,
    industrySector: opportunity.industrySector,
    skills: opportunity.skills,
    relevantTags: opportunity.relevantTags,
    seniority: {
      label: opportunity.seniority.label,
      minYears: opportunity.seniority.minYears,
      maxYears: opportunity.seniority.maxYears,
    },
    hardFilters: opportunity.hardFilters,
  })
}

export const JobOpportunityDraftStatusSchema = z.enum(["draft", "needs_review", "approved", "rejected"])
export type JobOpportunityDraftStatus = z.infer<typeof JobOpportunityDraftStatusSchema>
export const JobEnrichmentDraftStatusSchema = JobOpportunityDraftStatusSchema
export type JobEnrichmentDraftStatus = JobOpportunityDraftStatus

export const JobOpportunityDraftSchema = z
  .object({
    draftId: IdSchema,
    jobId: IdSchema,
    status: JobOpportunityDraftStatusSchema,
    approvalReady: z.boolean(),
    rawSnapshot: RawJobSnapshotSchema,
    opportunity: JobOpportunitySchema,
    coverage: JobEnrichmentCoverageSchema,
    hitlFlags: z.array(JobEnrichmentHitlFlagSchema).default([]),
    enrichmentVersion: z.string().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema.optional(),
    approvedAt: TimestampSchema.optional(),
    approvedBy: z.string().min(1).optional(),
    rejectedAt: TimestampSchema.optional(),
    rejectedBy: z.string().min(1).optional(),
    rejectionReason: z.string().max(2_000).optional(),
  })
  .superRefine((draft, ctx) => {
    if (draft.coverage.sponsorshipSignal === "silent" && draft.opportunity.hardFilters.sponsorshipAvailable !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["opportunity", "hardFilters", "sponsorshipAvailable"],
        message: "sponsorship silence must be null",
      })
    }
    if (draft.coverage.seniorityEvidence === "title_only") {
      const hasReviewFlag = draft.hitlFlags.some(
        (flag) =>
          (flag.kind === "low_coverage" || flag.kind === "seniority_title_only") &&
          (flag.severity === "review" || flag.severity === "blocking")
      )
      if (draft.coverage.overall !== "low" || draft.approvalReady || !hasReviewFlag) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["coverage", "seniorityEvidence"],
          message: "title-only seniority evidence requires low coverage and HITL review",
        })
      }
    }
  })
export type JobOpportunityDraft = z.infer<typeof JobOpportunityDraftSchema>
export const JobEnrichmentDraftSchema = JobOpportunityDraftSchema
export type JobEnrichmentDraft = JobOpportunityDraft

export const JobEnrichmentDraftCountsSchema = z.object({
  total: z.number().int().nonnegative().default(0),
  draft: z.number().int().nonnegative().default(0),
  needsReview: z.number().int().nonnegative().default(0),
  approved: z.number().int().nonnegative().default(0),
  rejected: z.number().int().nonnegative().default(0),
})
export type JobEnrichmentDraftCounts = z.infer<typeof JobEnrichmentDraftCountsSchema>

export const JobEnrichmentEvalFixtureSchema = z.object({
  fixtureId: IdSchema,
  jobId: IdSchema,
  rawSnapshot: RawJobSnapshotSchema,
  expectedOpportunity: JobOpportunitySchema.optional(),
  expectedCoverage: z.enum(["low", "medium", "high"]),
  expectedHitlFlags: z.array(JobEnrichmentHitlFlagSchema.shape.kind).default([]),
  notes: z.string().max(2_000).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type JobEnrichmentEvalFixture = z.infer<typeof JobEnrichmentEvalFixtureSchema>

const LifecycleEventBaseSchema = z.object({
  eventId: IdSchema,
  candidateId: IdSchema,
  actor: MarketplaceActorSchema,
  occurredAt: TimestampSchema,
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
})

export const CandidateLifecycleEventSchema = z.discriminatedUnion("type", [
  LifecycleEventBaseSchema.extend({ type: z.literal("profile_created") }),
  LifecycleEventBaseSchema.extend({
    type: z.literal("handle_linked"),
    handleKind: CandidateHandleKindSchema,
    verified: z.boolean().default(false),
    deliverable: z.boolean().default(false),
  }),
  LifecycleEventBaseSchema.extend({ type: z.literal("candidate_claimed") }),
  LifecycleEventBaseSchema.extend({ type: z.literal("profile_ready") }),
  LifecycleEventBaseSchema.extend({
    type: z.literal("open_to_opportunities"),
    confidence: ConfidenceSchema,
  }),
  LifecycleEventBaseSchema.extend({ type: z.literal("retention_allowed") }),
  LifecycleEventBaseSchema.extend({ type: z.literal("opt_out_requested") }),
  LifecycleEventBaseSchema.extend({ type: z.literal("explicit_opt_in") }),
  LifecycleEventBaseSchema.extend({ type: z.literal("delete_fulfilled") }),
])
export type CandidateLifecycleEvent = z.infer<typeof CandidateLifecycleEventSchema>

const CandidateJobEventBaseSchema = z.object({
  eventId: IdSchema,
  candidateId: IdSchema,
  jobId: IdSchema,
  actor: MarketplaceActorSchema,
  occurredAt: TimestampSchema,
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  matchScore: ConfidenceSchema.optional(),
})

const OutboundDeliveryEvidenceSchema = z
  .array(MarketplaceEvidenceSchema)
  .min(1)
  .refine((items) => items.some((item) => item.source === "outbound_delivery"), {
    message: "outbound events require outbound_delivery evidence",
  })

export const CandidateJobEventSchema = z.discriminatedUnion("type", [
  CandidateJobEventBaseSchema.extend({ type: z.literal("match_recorded") }),
  CandidateJobEventBaseSchema.extend({
    type: z.literal("outbound_queued"),
    evidence: OutboundDeliveryEvidenceSchema,
    outboundInviteId: IdSchema,
    outboundId: IdSchema,
    matchId: IdSchema.optional(),
  }),
  CandidateJobEventBaseSchema.extend({
    type: z.literal("outbound_sent"),
    evidence: OutboundDeliveryEvidenceSchema,
    outboundInviteId: IdSchema,
    outboundId: IdSchema,
    providerStatus: z.string().min(1),
  }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("candidate_interested") }),
  CandidateJobEventBaseSchema.extend({
    type: z.literal("prescreen_started"),
    prescreenSessionId: IdSchema,
  }),
  CandidateJobEventBaseSchema.extend({
    type: z.literal("prescreen_review_pending"),
    prescreenSessionId: IdSchema,
  }),
  CandidateJobEventBaseSchema.extend({
    type: z.literal("prescreen_passed"),
    prescreenSessionId: IdSchema,
  }),
  CandidateJobEventBaseSchema.extend({
    type: z.literal("prescreen_not_passed"),
    prescreenSessionId: IdSchema,
  }),
  CandidateJobEventBaseSchema.extend({
    type: z.literal("manual_pause"),
    prescreenSessionId: IdSchema.optional(),
  }),
  CandidateJobEventBaseSchema.extend({
    type: z.literal("employer_snapshot_created"),
    prescreenSessionId: IdSchema.optional(),
    employerVisibleProfileId: IdSchema,
  }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("candidate_declined") }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("archive") }),
])
export type CandidateJobEvent = z.infer<typeof CandidateJobEventSchema>

export type StateReductionResult<TState extends string> = {
  state: TState
  changed: boolean
  reason: string
  transition: {
    from: TState
    to: TState
    eventType: string
    occurredAt: string
  }
}

export type BulkResumeItemStatusEvent =
  | "queue"
  | "start_parsing"
  | "parsed"
  | "missing_email_review"
  | "identity_conflict"
  | "parse_failed"
  | "failed"
  | "make_retry_ready"

export type JobEnrichmentDraftStatusEvent =
  | "needs_review"
  | "approve"
  | "reject"

const BULK_RESUME_ITEM_TRANSITIONS: Record<
  BulkResumeItemStatus,
  Partial<Record<BulkResumeItemStatusEvent, BulkResumeItemStatus>>
> = {
  queued: {
    start_parsing: "parsing",
    failed: "failed",
  },
  parsing: {
    parsed: "parsed",
    missing_email_review: "missing_email_review",
    identity_conflict: "identity_conflict",
    parse_failed: "parse_failed",
    failed: "failed",
  },
  parsed: {},
  missing_email_review: {
    make_retry_ready: "retry_ready",
  },
  identity_conflict: {
    make_retry_ready: "retry_ready",
  },
  parse_failed: {
    make_retry_ready: "retry_ready",
  },
  failed: {
    make_retry_ready: "retry_ready",
  },
  retry_ready: {
    start_parsing: "parsing",
  },
}

const JOB_ENRICHMENT_DRAFT_TRANSITIONS: Record<
  JobEnrichmentDraftStatus,
  Partial<Record<JobEnrichmentDraftStatusEvent, JobEnrichmentDraftStatus>>
> = {
  draft: {
    needs_review: "needs_review",
    approve: "approved",
    reject: "rejected",
  },
  needs_review: {
    approve: "approved",
    reject: "rejected",
  },
  approved: {},
  rejected: {},
}

function reduction<TState extends string>(
  from: TState,
  to: TState,
  eventType: string,
  occurredAt: string,
  reason: string
): StateReductionResult<TState> {
  return {
    state: to,
    changed: from !== to,
    reason,
    transition: { from, to, eventType, occurredAt },
  }
}

export function canTransitionBulkResumeItemStatus(
  from: BulkResumeItemStatus,
  to: BulkResumeItemStatus
): boolean {
  return Object.values(BULK_RESUME_ITEM_TRANSITIONS[from]).includes(to)
}

export function reduceBulkResumeItemStatus(
  current: BulkResumeItemStatus,
  eventType: BulkResumeItemStatusEvent,
  occurredAt = ""
): StateReductionResult<BulkResumeItemStatus> {
  const next = BULK_RESUME_ITEM_TRANSITIONS[current][eventType]
  if (!next) {
    return reduction(current, current, eventType, occurredAt, "invalid_bulk_resume_item_transition")
  }
  const reasonByEvent: Record<BulkResumeItemStatusEvent, string> = {
    queue: "bulk_resume_item_queued",
    start_parsing: "bulk_resume_item_parse_started",
    parsed: "bulk_resume_item_parsed",
    missing_email_review: "pdf_email_missing_requires_operator_review",
    identity_conflict: "bulk_resume_identity_conflict_requires_operator_review",
    parse_failed: "bulk_resume_parse_failed_retryable",
    failed: "bulk_resume_item_failed",
    make_retry_ready: "bulk_resume_item_retry_ready",
  }
  return reduction(current, next, eventType, occurredAt, reasonByEvent[eventType])
}

export function canTransitionJobEnrichmentDraftStatus(
  from: JobEnrichmentDraftStatus,
  to: JobEnrichmentDraftStatus
): boolean {
  return Object.values(JOB_ENRICHMENT_DRAFT_TRANSITIONS[from]).includes(to)
}

export function reduceJobEnrichmentDraftStatus(
  current: JobEnrichmentDraftStatus,
  eventType: JobEnrichmentDraftStatusEvent,
  occurredAt = ""
): StateReductionResult<JobEnrichmentDraftStatus> {
  const next = JOB_ENRICHMENT_DRAFT_TRANSITIONS[current][eventType]
  if (!next) {
    return reduction(current, current, eventType, occurredAt, "invalid_job_enrichment_transition")
  }
  const reasonByEvent: Record<JobEnrichmentDraftStatusEvent, string> = {
    needs_review: "job_enrichment_requires_operator_review",
    approve: "job_enrichment_approved_for_matching_and_prescreen",
    reject: "job_enrichment_rejected_by_operator",
  }
  return reduction(current, next, eventType, occurredAt, reasonByEvent[eventType])
}

export function reduceCandidateLifecycleState(
  current: CandidateLifecycleState,
  rawEvent: CandidateLifecycleEvent
): StateReductionResult<CandidateLifecycleState> {
  const event = CandidateLifecycleEventSchema.parse(rawEvent)
  if (current === "deleted") {
    return reduction(current, current, event.type, event.occurredAt, "deleted_terminal")
  }
  if (event.type === "delete_fulfilled") {
    return reduction(current, "deleted", event.type, event.occurredAt, "delete_request_fulfilled")
  }
  if (event.type === "opt_out_requested") {
    return reduction(current, "opted_out", event.type, event.occurredAt, "explicit_no_outreach")
  }
  if (current === "opted_out") {
    if (event.type === "explicit_opt_in") {
      return reduction(current, "retained", event.type, event.occurredAt, "explicit_reactivation")
    }
    return reduction(current, current, event.type, event.occurredAt, "opted_out_requires_explicit_opt_in")
  }

  switch (event.type) {
    case "profile_created":
      if (current === "prospect") {
        return reduction(current, "profile_created", event.type, event.occurredAt, "global_profile_exists")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_profile_created_transition")
    case "handle_linked":
      if ((event.verified || event.deliverable) && current === "profile_created") {
        return reduction(current, "reachable", event.type, event.occurredAt, "reachable_handle_linked")
      }
      if (event.verified || event.deliverable) {
        return reduction(current, current, event.type, event.occurredAt, "invalid_reachable_transition")
      }
      return reduction(current, current, event.type, event.occurredAt, "handle_not_reachable")
    case "candidate_claimed":
      if (current === "reachable") {
        return reduction(current, "claimed", event.type, event.occurredAt, "candidate_claimed_profile")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_claim_transition")
    case "profile_ready":
      if (current === "claimed" || current === "reachable") {
        return reduction(current, "profile_ready", event.type, event.occurredAt, "profile_ready_threshold_met")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_profile_ready_transition")
    case "open_to_opportunities":
      if (event.confidence >= 0.6 && (current === "profile_ready" || current === "retained")) {
        return reduction(current, "active_job_seeker", event.type, event.occurredAt, "positive_search_signal")
      }
      if (event.confidence >= 0.6) {
        return reduction(current, current, event.type, event.occurredAt, "invalid_active_job_seeker_transition")
      }
      return reduction(current, current, event.type, event.occurredAt, "open_signal_low_confidence")
    case "retention_allowed":
      if (current === "active_job_seeker" || current === "profile_ready") {
        return reduction(current, "retained", event.type, event.occurredAt, "candidate_retained_for_future_outreach")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_retention_transition")
    case "explicit_opt_in":
      return reduction(current, current, event.type, event.occurredAt, "explicit_opt_in_requires_opted_out")
  }
}

export function reduceCandidateJobState(
  current: CandidateJobState,
  rawEvent: CandidateJobEvent
): StateReductionResult<CandidateJobState> {
  const event = CandidateJobEventSchema.parse(rawEvent)
  if (current === "archived") {
    return reduction(current, current, event.type, event.occurredAt, "archived_terminal")
  }
  switch (event.type) {
    case "match_recorded":
      if (current === "candidate_matched") {
        return reduction(current, "candidate_matched", event.type, event.occurredAt, "match_recorded")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_match_transition")
    case "outbound_queued":
      if (current === "candidate_matched") {
        return reduction(current, "outbound_queued", event.type, event.occurredAt, "outreach_policy_allowed")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_outbound_queue_transition")
    case "outbound_sent":
      if (current === "outbound_queued") {
        return reduction(current, "outbound_sent", event.type, event.occurredAt, "delivery_provider_accepted")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_outbound_sent_transition")
    case "candidate_interested":
      if (current === "outbound_sent") {
        return reduction(current, "candidate_interested", event.type, event.occurredAt, "candidate_interest_signal")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_interest_transition")
    case "prescreen_started":
      if (
        current === "candidate_matched" ||
        current === "outbound_queued" ||
        current === "outbound_sent" ||
        current === "candidate_interested" ||
        current === "paused" ||
        current === "not_passed"
      ) {
        return reduction(current, "prescreen_started", event.type, event.occurredAt, "first_interview_started")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_prescreen_start_transition")
    case "prescreen_review_pending":
      if (current === "prescreen_started") {
        return reduction(current, "prescreen_review_pending", event.type, event.occurredAt, "prescreen_waiting_for_human_review")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_prescreen_review_pending_transition")
    case "prescreen_passed":
      if (current === "prescreen_started") {
        return reduction(current, current, event.type, event.occurredAt, "prescreen_final_requires_human_review")
      }
      if (current === "prescreen_review_pending") {
        return reduction(current, "passed", event.type, event.occurredAt, "prescreen_pass")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_pass_transition")
    case "prescreen_not_passed":
      if (current === "prescreen_started") {
        return reduction(current, current, event.type, event.occurredAt, "prescreen_final_requires_human_review")
      }
      if (current === "prescreen_review_pending") {
        return reduction(current, "not_passed", event.type, event.occurredAt, "candidate_retained_for_other_jobs")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_not_passed_transition")
    case "manual_pause":
      if (current === "candidate_interested" || current === "prescreen_started") {
        return reduction(current, "paused", event.type, event.occurredAt, "manual_review_required")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_pause_transition")
    case "employer_snapshot_created":
      if (current !== "passed") {
        return reduction(current, current, event.type, event.occurredAt, "employer_visible_requires_passed_state")
      }
      return reduction(current, "employer_visible", event.type, event.occurredAt, "passed_snapshot_created")
    case "candidate_declined":
    case "archive":
      return reduction(current, "archived", event.type, event.occurredAt, "opportunity_archived")
  }
}

export function createCandidateJobStateId(candidateId: string, jobId: string): string {
  return `${candidateId}__${jobId}`
}

export function createCandidateJobMatchId(candidateId: string, jobId: string): string {
  return `${candidateId}__${jobId}`
}

function safeInternalIdPart(value: string, fieldName: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${fieldName}_required`)
  if (/[+@\s]/.test(trimmed)) throw new Error(`${fieldName}_must_be_internal_id`)
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, "-")
}

type OutboundInviteIdInput = {
  candidateId: string
  jobId: string
  matchId?: string
}

export function createOutboundInviteId(candidateId: string, jobId: string, matchId?: string): string
export function createOutboundInviteId(input: OutboundInviteIdInput): string
export function createOutboundInviteId(
  inputOrCandidateId: string | OutboundInviteIdInput,
  jobId?: string,
  matchId?: string
): string {
  const input =
    typeof inputOrCandidateId === "string"
      ? { candidateId: inputOrCandidateId, jobId: jobId ?? "", matchId }
      : inputOrCandidateId
  const candidatePart = safeInternalIdPart(input.candidateId, "candidateId")
  const jobPart = safeInternalIdPart(input.jobId, "jobId")
  const matchPart = input.matchId ? `__${stableIdHash(input.matchId)}` : ""
  return `outinvite_${candidatePart}__${jobPart}${matchPart}`
}

export function createOutreachIdempotencyKey(inviteId: string): string {
  return `outreach_idempotency_${safeInternalIdPart(inviteId, "inviteId")}`
}

export function createEvalArtifactId(kind: EvalArtifactKind, sourceId: string): string {
  const kindPart = safeInternalIdPart(kind, "kind")
  const sourcePart = safeInternalIdPart(sourceId, "sourceId")
  return `eval_artifact_${kindPart}__${stableIdHash(sourcePart)}`
}

export function createPrivacyRequestId(input: {
  candidateId: string
  kind: PrivacyRequestKind
  createdAt: string
}): string {
  const candidatePart = safeInternalIdPart(input.candidateId, "candidateId")
  const kindPart = safeInternalIdPart(input.kind, "kind")
  return `privacy_request_${kindPart}__${stableIdHash(`${candidatePart}:${input.createdAt}`)}`
}

export function createLaunchReadinessSnapshotId(generatedAt: string, runRef = "manual"): string {
  const runPart = safeInternalIdPart(runRef, "runRef")
  return `launch_readiness_${stableIdHash(`${runPart}:${generatedAt}`)}`
}

export function createOutreachStopControlId(input: {
  scope: OutreachStopControlScope
  scopeId?: string
}): string {
  if (input.scope === "global") return "outreach_stop_global"
  const scopePart = safeInternalIdPart(input.scopeId ?? "", "scopeId")
  return `outreach_stop_batch__${stableIdHash(scopePart)}`
}

function normalizeOutreachKeyPart(value: string, fieldName: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
  if (!normalized) throw new Error(`${fieldName}_required`)
  return normalized
}

export function createOutreachDuplicateSuppressionKey(
  candidateId: string,
  companyName: string,
  roleFamilyOrTitle: string
): string {
  const candidatePart = safeInternalIdPart(candidateId, "candidateId")
  const companyPart = normalizeOutreachKeyPart(companyName, "companyName")
  const rolePart = normalizeOutreachKeyPart(roleFamilyOrTitle, "roleFamilyOrTitle")
  return `outreach_dupe_${candidatePart}__${companyPart}__${rolePart}`
}

export function createEmployerVisibleProfileId(jobId: string, candidateId: string): string {
  return `${jobId}__${candidateId}`
}

export function createJobOpportunityDraftId(jobId: string, createdAt: string): string {
  return `jobopp_${jobId}_${safeIdTimestampPart(createdAt)}`
}

export function createJobEnrichmentEvalFixtureId(jobId: string, fixtureKey: string): string {
  return `jobopp_eval_${jobId}_${fixtureKey}`
}

export function createBulkResumeItemId(_batchId: string, fileSha256: string): string {
  return `bulk_item_${fileSha256.slice(0, 32)}`
}

function stableIdHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function safeIdTimestampPart(value: string): string {
  let output = ""
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const isDigit = code >= 48 && code <= 57
    const isUpper = code >= 65 && code <= 90
    const isLower = code >= 97 && code <= 122
    output += isDigit || isUpper || isLower ? value[index] : "-"
  }
  while (output.endsWith("-")) output = output.slice(0, -1)
  return output
}

export function createJobEnrichmentDraftId(jobId: string, contentHash?: string | null): string {
  const material = `${jobId.trim().toLowerCase()}:${contentHash?.trim() || "current"}`
  const hash = contentHash?.trim().replace(/[^a-fA-F0-9]/g, "").slice(0, 32)
  return `job_enrich_${hash && hash.length >= 8 ? hash.toLowerCase() : stableIdHash(material)}`
}

export function createBulkResumeArtifactId(
  candidateId: string,
  fileSha256: string,
  extractedEmailHash?: string
): string {
  const emailPart = extractedEmailHash ? `__${extractedEmailHash.slice(0, 16)}` : ""
  return `resume_bulk_${candidateId}__${fileSha256.slice(0, 16)}${emailPart}`
}

export function createBulkResumeItemIdempotencyKey(
  batchId: string,
  fileSha256: string,
  extractedEmailHash?: string
): string {
  const emailPart = extractedEmailHash ? `:${extractedEmailHash}` : ""
  return `bulk_resume:${batchId}:${fileSha256}${emailPart}`
}

export function summarizeBulkResumeItemCounts(
  statuses: BulkResumeItemStatus[]
): BulkResumeBatchCounts {
  const counts: BulkResumeBatchCounts = {
    total: statuses.length,
    queued: 0,
    parsing: 0,
    parsed: 0,
    review: 0,
    failed: 0,
    retryReady: 0,
  }
  for (const status of statuses) {
    if (status === "queued") counts.queued += 1
    else if (status === "parsing") counts.parsing += 1
    else if (status === "parsed") counts.parsed += 1
    else if (status === "missing_email_review" || status === "identity_conflict") counts.review += 1
    else if (status === "parse_failed" || status === "failed") counts.failed += 1
    else if (status === "retry_ready") counts.retryReady += 1
  }
  return counts
}

export function summarizeJobEnrichmentDraftCounts(
  statuses: JobEnrichmentDraftStatus[]
): JobEnrichmentDraftCounts {
  const counts: JobEnrichmentDraftCounts = {
    total: statuses.length,
    draft: 0,
    needsReview: 0,
    approved: 0,
    rejected: 0,
  }
  for (const status of statuses) {
    if (status === "draft") counts.draft += 1
    else if (status === "needs_review") counts.needsReview += 1
    else if (status === "approved") counts.approved += 1
    else if (status === "rejected") counts.rejected += 1
  }
  return counts
}

export function createCandidateHandleId(kind: CandidateHandleKind, handleHash: string): string {
  return `${kind}__${handleHash}`
}

export function normalizeCandidateHandleValue(
  kind: CandidateHandleKind,
  value: string
): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error("empty_candidate_handle")
  switch (kind) {
    case "email":
      return trimmed.toLowerCase()
    case "phone":
      if (!/^\+[1-9]\d{1,14}$/.test(trimmed)) {
        throw new Error("phone_handle_requires_e164")
      }
      return trimmed
    case "browser_uid":
      return trimmed.toLowerCase()
    case "ats_applicant":
    case "sendblue_thread":
    case "imessage":
    case "linkedin":
    case "github":
    case "calcom":
      return trimmed.toLowerCase()
  }
}

export function candidateHandleHashMaterial(
  kind: CandidateHandleKind,
  normalizedValue: string
): string {
  return `${kind}:${normalizedValue}`
}
