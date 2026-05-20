import assert from "node:assert/strict"
import test from "node:test"
import {
  CorrectionEventSchema,
  EvaluationAttemptSchema,
  calculateEvidenceConfidence,
  calculateWeightedFitScore,
  confidenceToScore,
  createEvaluationAttemptId,
  deriveProposedOutcome,
  deriveReviewPriority,
  scoreToAnchor,
  type EvaluationDimensionScore,
  type EvaluationGate,
} from "./index.js"

function dimension(overrides: Partial<EvaluationDimensionScore> = {}): EvaluationDimensionScore {
  const score = overrides.score ?? 3
  return {
    dimensionId: overrides.dimensionId ?? "role_fit",
    label: overrides.label ?? "Role fit",
    criterion: overrides.criterion ?? "Candidate provides concrete evidence for the required capability.",
    weight: overrides.weight ?? 2,
    score,
    anchor: overrides.anchor ?? scoreToAnchor(score),
    confidence: overrides.confidence ?? 0.8,
    evidenceRefs: overrides.evidenceRefs ?? ["ev-1"],
    missingEvidence: overrides.missingEvidence ?? [],
    rationale: overrides.rationale ?? "Evidence supports the dimension.",
    riskFlags: overrides.riskFlags ?? [],
  }
}

function gate(overrides: Partial<EvaluationGate> = {}): EvaluationGate {
  return {
    gateId: overrides.gateId ?? "visa",
    label: overrides.label ?? "Visa requirement",
    severity: overrides.severity ?? "hard",
    status: overrides.status ?? "pass",
    evidenceRefs: overrides.evidenceRefs ?? ["ev-1"],
    rationale: overrides.rationale ?? "Gate is satisfied.",
  }
}

test("evaluation attempt schema parses canonical pending review artifact", () => {
  const parsed = EvaluationAttemptSchema.parse({
    schemaVersion: 1,
    attemptId: createEvaluationAttemptId({ source: "prescreen", candidateId: "cand-1", jobId: "job-1", prescreenSessionId: "ps-1" }),
    source: "prescreen",
    purpose: "employment_prescreen",
    candidateId: "cand-1",
    jobId: "job-1",
    prescreenSessionId: "ps-1",
    rubricVersion: "prescreen-v1",
    algorithmVersion: "screening-eval-v1",
    evaluator: { kind: "hybrid", model: "gpt-5.4-nano" },
    dimensions: [dimension()],
    gates: [gate()],
    weightedFitScore: 0.75,
    evidenceConfidence: 0.8,
    missingEvidence: [],
    riskFlags: [],
    proposedOutcome: { kind: "pass", prescreenTerminal: "PASS" },
    reviewPriority: "low",
    explanation: "Candidate meets the initial bar.",
    evidence: [{ refId: "ev-1", source: "transcript_turn", quote: "I built the React UI.", summary: "Frontend evidence" }],
    humanReview: { status: "pending" },
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  })
  assert.equal(parsed.humanReview.status, "pending")
})

test("weighted score and confidence keep score quality separate from evidence quality", () => {
  const dims = [
    dimension({ dimensionId: "strong", score: 4, weight: 3, confidence: 0.9 }),
    dimension({ dimensionId: "thin", score: 1, weight: 1, confidence: 0.4, missingEvidence: ["No example depth"] }),
  ]
  assert.equal(calculateWeightedFitScore(dims), 0.813)
  assert.equal(calculateEvidenceConfidence(dims), 0.695)
})

test("gate policy can route to reject or needs_more_info independently of weighted score", () => {
  const hardBlock = deriveProposedOutcome({
    purpose: "employment_prescreen",
    gates: [gate({ status: "hard_block" })],
    weightedFitScore: 0.95,
    evidenceConfidence: 0.95,
  })
  assert.equal(hardBlock.kind, "reject")

  const missingHardGate = deriveProposedOutcome({
    purpose: "employment_prescreen",
    gates: [gate({ status: "soft_block" })],
    weightedFitScore: 0.95,
    evidenceConfidence: 0.95,
  })
  assert.equal(missingHardGate.kind, "needs_more_info")
})

test("routing thresholds are review hints, not human review state", () => {
  const outcome = deriveProposedOutcome({
    purpose: "candidate_job_fit",
    gates: [],
    weightedFitScore: 0.78,
    evidenceConfidence: 0.72,
    supplyTier: "tier_2_personal_email",
  })
  assert.equal(outcome.kind, "pass")
  assert.equal(outcome.supplyTier, "tier_2_personal_email")
  assert.equal(deriveReviewPriority({ proposedOutcome: outcome, gates: [], evidenceConfidence: 0.72 }), "low")
})

test("practice attempts never propose employment outcome", () => {
  const outcome = deriveProposedOutcome({
    purpose: "interview_practice",
    gates: [gate({ status: "hard_block" })],
    weightedFitScore: 0,
    evidenceConfidence: 0,
  })
  assert.equal(outcome.kind, "practice_feedback")
})

test("score anchors and evaluation_attempt correction target are stable", () => {
  assert.equal(scoreToAnchor(confidenceToScore(0.88)), "strong")
  assert.equal(scoreToAnchor(confidenceToScore(0.63)), "meets_bar")
  assert.equal(scoreToAnchor(confidenceToScore(0.4)), "partial")
  assert.equal(scoreToAnchor(confidenceToScore(0.2)), "weak")
  assert.equal(scoreToAnchor(confidenceToScore(0)), "no_evidence")

  const correction = CorrectionEventSchema.parse({
    eventId: "corr-1",
    targetType: "evaluation_attempt",
    targetId: "eval-1",
    actor: "operator",
    reason: "operator corrected eval outcome",
    beforeRedacted: { proposedOutcome: { kind: "reject" } },
    afterRedacted: { finalOutcome: { kind: "hold" } },
    evidence: [],
    createdAt: "2026-05-20T00:00:00.000Z",
  })
  assert.equal(correction.targetType, "evaluation_attempt")
})
