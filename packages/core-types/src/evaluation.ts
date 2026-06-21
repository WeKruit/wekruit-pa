import { createHash } from "node:crypto"
import { z } from "zod"
import { EvaluationTierSchema } from "./external-supply.js"

const TimestampSchema = z.string().min(1)
const IdSchema = z.string().min(1)
const ConfidenceSchema = z.number().min(0).max(1)

export const EvaluationSourceSchema = z.enum([
  "prescreen",
  "practice_question",
  "external_supply",
  "recruiter_submission",
])
export type EvaluationSource = z.infer<typeof EvaluationSourceSchema>

export const EvaluationPurposeSchema = z.enum([
  "employment_prescreen",
  "interview_practice",
  "candidate_job_fit",
])
export type EvaluationPurpose = z.infer<typeof EvaluationPurposeSchema>

export const EvaluationGateStatusSchema = z.enum(["pass", "soft_block", "hard_block"])
export type EvaluationGateStatus = z.infer<typeof EvaluationGateStatusSchema>

export const EvaluationOutcomeKindSchema = z.enum([
  "pass",
  "hold",
  "reject",
  "needs_more_info",
  "practice_feedback",
])
export type EvaluationOutcomeKind = z.infer<typeof EvaluationOutcomeKindSchema>

export const HumanReviewStatusSchema = z.enum([
  "pending",
  "approved",
  "overridden",
  "rejected",
  "needs_more_info",
])
export type HumanReviewStatus = z.infer<typeof HumanReviewStatusSchema>

export const EvaluationReviewPrioritySchema = z.enum(["low", "normal", "high", "urgent"])
export type EvaluationReviewPriority = z.infer<typeof EvaluationReviewPrioritySchema>

export const EvaluationAnchorSchema = z.enum([
  "no_evidence",
  "weak",
  "partial",
  "meets_bar",
  "strong",
])
export type EvaluationAnchor = z.infer<typeof EvaluationAnchorSchema>

export const EvaluationEvidenceSourceSchema = z.enum([
  "transcript_turn",
  "resume",
  "job",
  "practice_question",
  "external_record",
  "evaluator",
])
export type EvaluationEvidenceSource = z.infer<typeof EvaluationEvidenceSourceSchema>

export const EvaluationEvidenceRefSchema = z.object({
  refId: IdSchema,
  source: EvaluationEvidenceSourceSchema,
  quote: z.string().max(2_000).optional(),
  summary: z.string().min(1).max(2_000),
  path: z.string().max(1_000).optional(),
})
export type EvaluationEvidenceRef = z.infer<typeof EvaluationEvidenceRefSchema>

export const EvaluationDimensionScoreSchema = z.object({
  dimensionId: IdSchema,
  label: z.string().min(1).max(200),
  criterion: z.string().min(1).max(2_000),
  weight: z.number().min(0).max(100),
  score: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  anchor: EvaluationAnchorSchema,
  confidence: ConfidenceSchema,
  evidenceRefs: z.array(IdSchema).default([]),
  missingEvidence: z.array(z.string().min(1).max(1_000)).default([]),
  rationale: z.string().min(1).max(2_000),
  riskFlags: z.array(z.string().min(1).max(160)).default([]),
})
export type EvaluationDimensionScore = z.infer<typeof EvaluationDimensionScoreSchema>

export const EvaluationGateSchema = z.object({
  gateId: IdSchema,
  label: z.string().min(1).max(200),
  severity: z.enum(["hard", "soft", "info"]),
  status: EvaluationGateStatusSchema,
  evidenceRefs: z.array(IdSchema).default([]),
  rationale: z.string().min(1).max(2_000),
})
export type EvaluationGate = z.infer<typeof EvaluationGateSchema>

export const EvaluationOutcomeSchema = z.object({
  kind: EvaluationOutcomeKindSchema,
  supplyTier: EvaluationTierSchema.optional(),
  prescreenTerminal: z.enum(["PASS", "FAIL", "HARD_STOP", "PAUSE"]).optional(),
})
export type EvaluationOutcome = z.infer<typeof EvaluationOutcomeSchema>

export const EvaluationEvaluatorSchema = z.object({
  kind: z.enum(["deterministic", "llm_judge", "hybrid"]),
  model: z.string().min(1).max(200).optional(),
  promptVersion: z.string().min(1).max(200).optional(),
})
export type EvaluationEvaluator = z.infer<typeof EvaluationEvaluatorSchema>

/**
 * Data-labeling layer (2026-06-15, Adam directive). A human reviewer grades the
 * AI evaluation itself so we can later review the quality of the evaluation
 * process and build regression/gold datasets. This is ADDITIVE — it never
 * overwrites the AI's {@link EvaluationAttempt.proposedOutcome} or `dimensions`;
 * the AI verdict and the human label coexist, exactly as a modern annotation
 * tool keeps the model prediction next to the gold label.
 */
export const EvaluationLabelDecisionSchema = z.enum(["agree", "disagree", "partial"])
export type EvaluationLabelDecision = z.infer<typeof EvaluationLabelDecisionSchema>

/**
 * Closed vocabulary for WHY the AI evaluation was wrong, when a labeler diverges.
 * This is the single most valuable flywheel signal — the delta between the AI
 * verdict and the human label, categorized. Keep it a closed enum (Adam D5/D15):
 * an open free-text field for nuance lives in `rationale`.
 */
export const EvaluationErrorCategorySchema = z.enum([
  "missed_evidence", // evidence was present; the AI did not use it
  "hallucinated_evidence", // the AI cited evidence that is not in the record
  "wrong_weight", // a dimension was over- or under-weighted
  "over_strict", // too harsh — would reject a candidate who should advance
  "over_lenient", // too soft — would advance a candidate who should not
  "misread_transcript", // misunderstood what the candidate actually said
  "profile_ignored", // ignored LinkedIn/resume profile evidence
  "rubric_mismatch", // applied the wrong or an outdated rubric
  "other",
])
export type EvaluationErrorCategory = z.infer<typeof EvaluationErrorCategorySchema>

export const EvaluationQualityRatingSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
])
export type EvaluationQualityRating = z.infer<typeof EvaluationQualityRatingSchema>

export const HumanEvalLabelSchema = z.object({
  /** Did the human agree with the AI's proposed outcome? */
  decision: EvaluationLabelDecisionSchema,
  /** The human's corrected verdict — present when the labeler diverges. */
  correctedOutcome: EvaluationOutcomeSchema.optional(),
  /** Categorized reasons the AI was wrong (closed vocab). Empty on agreement. */
  errorCategories: z.array(EvaluationErrorCategorySchema).max(8).default([]),
  /** Overall AI-evaluation quality, 1 (bad) .. 5 (excellent). */
  qualityRating: EvaluationQualityRatingSchema.optional(),
  /** Evidence the human highlighted to justify the label (transcript turn, resume, etc.). */
  evidenceRefs: z.array(EvaluationEvidenceRefSchema).max(20).default([]),
  /** Free-text "why" — required by the callable when `decision !== "agree"`. */
  rationale: z.string().max(4_000).optional(),
  /** Rubric version the label was made against (so a later rubric change cannot silently invalidate it). */
  rubricVersion: z.string().min(1).max(200).optional(),
  labeledBy: z.string().min(1).max(200).optional(),
  labeledAt: TimestampSchema.optional(),
  /**
   * Light gold-sampling marker (2026-06-15). When true, the labeler flagged this
   * attempt as a high-quality "gold" example worth keeping in a curated
   * regression/eval set. Additive + optional: a normal label leaves it unset.
   * The export surfaces it so a gold-only dataset can be filtered out cheaply,
   * and the queue can deliberately mix gold records back in.
   */
  isGoldSample: z.boolean().optional(),
})
export type HumanEvalLabel = z.infer<typeof HumanEvalLabelSchema>

export const HumanReviewSchema = z.object({
  status: HumanReviewStatusSchema,
  reviewer: z.string().min(1).max(200).optional(),
  reviewedAt: TimestampSchema.optional(),
  finalOutcome: EvaluationOutcomeSchema.optional(),
  correctedDimensions: z.array(EvaluationDimensionScoreSchema).optional(),
  note: z.string().max(2_000).optional(),
  correctionEventId: IdSchema.optional(),
  /**
   * Rich data-labeling annotation of the AI evaluation. Optional and additive —
   * absent on every legacy review, present once a reviewer labels eval quality.
   */
  label: HumanEvalLabelSchema.optional(),
})
export type HumanReview = z.infer<typeof HumanReviewSchema>

export const EvaluationAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: IdSchema,
  source: EvaluationSourceSchema,
  purpose: EvaluationPurposeSchema,
  candidateId: IdSchema.optional(),
  jobId: IdSchema.optional(),
  companyId: IdSchema.optional(),
  questionBankId: IdSchema.optional(),
  prescreenSessionId: IdSchema.optional(),
  externalEvaluationId: IdSchema.optional(),
  rubricVersion: z.string().min(1).max(200),
  algorithmVersion: z.string().min(1).max(200),
  evaluator: EvaluationEvaluatorSchema,
  dimensions: z.array(EvaluationDimensionScoreSchema).default([]),
  gates: z.array(EvaluationGateSchema).default([]),
  weightedFitScore: ConfidenceSchema,
  evidenceConfidence: ConfidenceSchema,
  missingEvidence: z.array(z.string().min(1).max(1_000)).default([]),
  riskFlags: z.array(z.string().min(1).max(160)).default([]),
  proposedOutcome: EvaluationOutcomeSchema,
  reviewPriority: EvaluationReviewPrioritySchema,
  explanation: z.string().min(1).max(4_000),
  evidence: z.array(EvaluationEvidenceRefSchema).default([]),
  humanReview: HumanReviewSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type EvaluationAttempt = z.infer<typeof EvaluationAttemptSchema>

export const SCREENING_EVALUATION_ALGORITHM_VERSION = "screening-eval-v1"

export function createEvaluationAttemptId(input: {
  source: EvaluationSource
  candidateId?: string
  jobId?: string
  questionBankId?: string
  prescreenSessionId?: string
  externalEvaluationId?: string
  salt?: string
}): string {
  const material = [
    input.source,
    input.candidateId ?? "",
    input.jobId ?? "",
    input.questionBankId ?? "",
    input.prescreenSessionId ?? "",
    input.externalEvaluationId ?? "",
    input.salt ?? "",
  ].join("|")
  return `eval_attempt_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`
}

export function scoreToAnchor(score: 0 | 1 | 2 | 3 | 4): EvaluationAnchor {
  if (score === 0) return "no_evidence"
  if (score === 1) return "weak"
  if (score === 2) return "partial"
  if (score === 3) return "meets_bar"
  return "strong"
}

export function confidenceToScore(confidence: number): 0 | 1 | 2 | 3 | 4 {
  const bounded = Math.max(0, Math.min(1, confidence))
  if (bounded >= 0.875) return 4
  if (bounded >= 0.625) return 3
  if (bounded >= 0.375) return 2
  if (bounded > 0) return 1
  return 0
}

export function calculateWeightedFitScore(dimensions: EvaluationDimensionScore[]): number {
  const weighted = dimensions.filter((d) => d.weight > 0)
  if (weighted.length === 0) return 0
  const max = weighted.reduce((sum, d) => sum + d.weight, 0)
  if (max <= 0) return 0
  const score = weighted.reduce((sum, d) => sum + (d.score / 4) * d.weight, 0) / max
  return roundConfidence(score)
}

export function calculateEvidenceConfidence(dimensions: EvaluationDimensionScore[]): number {
  const weighted = dimensions.filter((d) => d.weight > 0)
  if (weighted.length === 0) return 0
  const max = weighted.reduce((sum, d) => sum + d.weight, 0)
  const mean = weighted.reduce((sum, d) => sum + d.confidence * d.weight, 0) / max
  const missingCritical = weighted.filter((d) => d.missingEvidence.length > 0 && d.score <= 1).length
  return roundConfidence(Math.max(0, mean - missingCritical * 0.08))
}

export function deriveProposedOutcome(input: {
  purpose: EvaluationPurpose
  gates: EvaluationGate[]
  weightedFitScore: number
  evidenceConfidence: number
  prescreenTerminal?: EvaluationOutcome["prescreenTerminal"]
  supplyTier?: EvaluationOutcome["supplyTier"]
}): EvaluationOutcome {
  if (input.purpose === "interview_practice") return { kind: "practice_feedback" }

  const hasHardBlock = input.gates.some((g) => g.severity === "hard" && g.status === "hard_block")
  const hasHardSoftBlock = input.gates.some((g) => g.severity === "hard" && g.status === "soft_block")
  const hasSoftBlock = input.gates.some((g) => g.status === "soft_block")

  let kind: EvaluationOutcomeKind
  if (hasHardBlock) kind = "reject"
  else if (hasHardSoftBlock || input.evidenceConfidence < 0.55) kind = "needs_more_info"
  else if (input.weightedFitScore >= 0.75 && input.evidenceConfidence >= 0.7) kind = "pass"
  else if (input.weightedFitScore >= 0.55 || hasSoftBlock) kind = "hold"
  else kind = "reject"

  return {
    kind,
    ...(input.supplyTier ? { supplyTier: input.supplyTier } : {}),
    ...(input.prescreenTerminal ? { prescreenTerminal: input.prescreenTerminal } : {}),
  }
}

export function deriveReviewPriority(input: {
  proposedOutcome: EvaluationOutcome
  gates: EvaluationGate[]
  evidenceConfidence: number
  riskFlags?: string[]
}): EvaluationReviewPriority {
  if (input.gates.some((g) => g.status === "hard_block")) return "urgent"
  if (input.proposedOutcome.kind === "reject") return "high"
  if (input.evidenceConfidence < 0.55) return "high"
  if (input.gates.some((g) => g.status === "soft_block")) return "normal"
  if ((input.riskFlags ?? []).length > 0) return "normal"
  return "low"
}

function roundConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1_000) / 1_000))
}
