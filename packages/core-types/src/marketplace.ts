import { z } from "zod"
import {
  CareerStageSchema,
  IndustrySectorSchema,
  JobTypeSchema,
  LocationSchema,
  RelevantTagsListSchema,
  RoleFunctionSchema,
  SkillsListSchema,
  VisaSchema,
} from "@wekruit/shared-tags"

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
])
export type CandidateHandleKind = z.infer<typeof CandidateHandleKindSchema>

export const CandidateHandleSourceSchema = z.enum([
  "candidate",
  "resume",
  "ats",
  "sendblue",
  "admin",
  "system",
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

export const CandidateGlobalTagsSchema = z.object({
  roleFunction: z.array(RoleFunctionSchema).default([]),
  skills: SkillsListSchema.default([]),
  careerStage: CareerStageSchema.optional(),
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
  updatedAt: TimestampSchema.optional(),
})
export type CandidateGlobalTags = z.infer<typeof CandidateGlobalTagsSchema>

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
  linkedinUrl: z.string().url().optional(),
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
  linkedinUrl: z.string().url().optional(),
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
  source: z.enum(["candidate", "resume", "ats", "sendblue", "admin", "system", "auth"]),
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

export const CandidateJobStateDocSchema = z.object({
  id: IdSchema,
  candidateId: IdSchema,
  jobId: IdSchema,
  state: CandidateJobStateSchema,
  previousState: CandidateJobStateSchema.optional(),
  stateUpdatedAt: TimestampSchema,
  reason: z.string().max(1_000).optional(),
  prescreenSessionId: z.string().min(1).optional(),
  outboundInviteId: z.string().min(1).optional(),
  latestMatchId: z.string().min(1).optional(),
  archivedAt: TimestampSchema.optional(),
})
export type CandidateJobStateDoc = z.infer<typeof CandidateJobStateDocSchema>

export const CandidateJobMatchSchema = z.object({
  matchId: IdSchema,
  candidateId: IdSchema,
  jobId: IdSchema,
  hardFilterResult: z.enum(["pass", "soft_block", "hard_block", "unknown"]).default("unknown"),
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
export type CandidateJobMatch = z.infer<typeof CandidateJobMatchSchema>

export const OutboundInviteSchema = z.object({
  inviteId: IdSchema,
  candidateId: IdSchema,
  jobId: IdSchema,
  candidateJobStateId: IdSchema,
  status: z.enum([
    "draft",
    "queued",
    "sent",
    "delivered",
    "failed",
    "declined",
    "expired",
    "cancelled",
  ]),
  policyDecision: z.enum(["auto_outbound", "hitl_review", "do_not_contact", "manual_approved", "blocked"]),
  outboundId: z.string().min(1).optional(),
  stickyAccountGroupId: z.string().min(1).optional(),
  cooldownUntil: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type OutboundInvite = z.infer<typeof OutboundInviteSchema>

export const EmployerVisibleProfileSchema = z.object({
  snapshotId: IdSchema,
  candidateId: IdSchema,
  jobId: IdSchema,
  candidateJobStateId: IdSchema,
  createdFromState: z.literal("passed"),
  displayName: z.string().min(1).optional(),
  resumeSummary: z.string().max(4_000).optional(),
  tagsSnapshot: CandidateGlobalTagsSchema.optional(),
  passReason: z.string().max(2_000).optional(),
  matchReason: z.string().max(2_000).optional(),
  consentAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  createdBy: MarketplaceActorSchema.default("system"),
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
    "user_tags",
    "employer_visible_profile",
    "feedback_event",
  ]),
  targetId: IdSchema,
  actor: z.enum(["operator", "system"]),
  candidateId: IdSchema.optional(),
  jobId: IdSchema.optional(),
  reason: z.string().min(1).max(2_000),
  beforeRedacted: z.record(z.unknown()).default({}),
  afterRedacted: z.record(z.unknown()).default({}),
  evidence: z.array(MarketplaceEvidenceSchema).default([]),
  createdAt: TimestampSchema,
})
export type CorrectionEvent = z.infer<typeof CorrectionEventSchema>

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

export const CandidateJobEventSchema = z.discriminatedUnion("type", [
  CandidateJobEventBaseSchema.extend({ type: z.literal("match_recorded") }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("outbound_queued") }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("outbound_sent") }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("candidate_interested") }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("prescreen_started") }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("prescreen_passed") }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("prescreen_not_passed") }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("manual_pause") }),
  CandidateJobEventBaseSchema.extend({ type: z.literal("employer_snapshot_created") }),
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
        current === "paused"
      ) {
        return reduction(current, "prescreen_started", event.type, event.occurredAt, "first_interview_started")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_prescreen_start_transition")
    case "prescreen_passed":
      if (current === "prescreen_started") {
        return reduction(current, "passed", event.type, event.occurredAt, "prescreen_pass")
      }
      return reduction(current, current, event.type, event.occurredAt, "invalid_pass_transition")
    case "prescreen_not_passed":
      if (current === "prescreen_started") {
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

export function createEmployerVisibleProfileId(jobId: string, candidateId: string): string {
  return `${jobId}__${candidateId}`
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
      return trimmed.toLowerCase()
  }
}

export function candidateHandleHashMaterial(
  kind: CandidateHandleKind,
  normalizedValue: string
): string {
  return `${kind}:${normalizedValue}`
}
