import {
  SCREENING_EVALUATION_ALGORITHM_VERSION,
  calculateEvidenceConfidence,
  calculateWeightedFitScore,
  confidenceToScore,
  createEvaluationAttemptId,
  deriveProposedOutcome,
  deriveReviewPriority,
  scoreToAnchor,
  type CandidateCompanyJobEvaluation,
  type EvaluationAttempt,
  type EvaluationDimensionScore,
  type EvaluationEvidenceRef,
  type EvaluationGate,
  type EvaluationGateStatus,
  type EvaluationOutcome,
  type PracticeQuestionBankItem,
} from "@pa/core-types"
import type { ScoredJudgeResult } from "./onboarding/question.js"
import type { PrescreenConfig } from "./prescreen/config.js"
import type { PreScreenState, PreScreenTerminal } from "./prescreen/state.js"

export interface PrescreenEvaluationInput {
  state: PreScreenState
  cfgSnapshot?: Pick<PrescreenConfig, "questions" | "threshold" | "confidenceThreshold">
  terminal: Exclude<PreScreenTerminal, null>
  nowIso: string
  evaluator?: EvaluationAttempt["evaluator"]
}

export interface PracticeQuestionEvaluationInput {
  question: PracticeQuestionBankItem
  candidateId?: string
  answerText?: string
  nowIso: string
  evaluator?: EvaluationAttempt["evaluator"]
  dimensionScores?: EvaluationDimensionScore[]
}

export interface ExternalSupplyEvaluationInput {
  evaluation: CandidateCompanyJobEvaluation
  nowIso: string
  evaluator?: EvaluationAttempt["evaluator"]
}

export function prescreenSessionToEvaluationAttempt(input: PrescreenEvaluationInput): EvaluationAttempt {
  const state = input.state
  const evidence: EvaluationEvidenceRef[] = []
  const dimensions: EvaluationDimensionScore[] = []
  const gates: EvaluationGate[] = []
  const questionById = new Map((input.cfgSnapshot?.questions ?? []).map((q) => [q.qId, q]))

  for (const qId of state.qOrder) {
    const qState = state.questions[qId]
    if (!qState) continue
    const cfgQuestion = questionById.get(qId)
    const scored = qState.scored
    const evidenceRefs: string[] = []
    if (scored) {
      for (const cell of scored.perKeyword) {
        const refId = `prescreen:${state.sessionId}:${qId}:${safeId(cell.keyword)}`
        evidenceRefs.push(refId)
        evidence.push({
          refId,
          source: "transcript_turn",
          quote: cell.evidence || undefined,
          summary: `${cell.keyword}: ${cell.reasoning || scored.aggregate.summary}`,
          path: `pa-prescreen-sessions/${state.sessionId}/questions/${qId}`,
        })
      }
    }

    const score = scored ? confidenceToScore(scored.aggregate.s) : 0
    const confidence = scored?.aggregate.c ?? 0
    const missingEvidence = scored?.answered === false || !scored
      ? [`No reliable evidence captured for ${qId}`]
      : []
    const riskFlags = scored?.abortHint ? [`abort_${scored.abortHint.kind}`] : []
    dimensions.push({
      dimensionId: qId,
      label: cfgQuestion?.prompt?.en?.slice(0, 120) || qId,
      criterion: cfgQuestion?.prompt?.en || qId,
      weight: qState.weight,
      score,
      anchor: scoreToAnchor(score),
      confidence,
      evidenceRefs,
      missingEvidence,
      rationale: scored?.aggregate.summary || "No scored prescreen evidence captured.",
      riskFlags,
    })

    const gate = prescreenQuestionGate(qState, scored, input.terminal)
    if (gate) {
      gates.push({
        gateId: qId,
        label: `${qState.type} gate`,
        severity: qState.type === "MUST_HAVE" ? "hard" : "soft",
        status: gate,
        evidenceRefs,
        rationale: scored?.aggregate.summary || qState.terminalCause || "No gate evidence captured.",
      })
    }
  }

  const weightedFitScore = calculateWeightedFitScore(dimensions)
  const evidenceConfidence = calculateEvidenceConfidence(dimensions)
  const missingEvidence = unique(dimensions.flatMap((d) => d.missingEvidence))
  const riskFlags = unique(dimensions.flatMap((d) => d.riskFlags))
  const proposedOutcome = deriveProposedOutcome({
    purpose: "employment_prescreen",
    gates,
    weightedFitScore,
    evidenceConfidence,
    prescreenTerminal: input.terminal,
  })
  const attemptId = createEvaluationAttemptId({
    source: "prescreen",
    candidateId: state.userId,
    jobId: state.jobId,
    prescreenSessionId: state.sessionId,
  })

  return {
    schemaVersion: 1,
    attemptId,
    source: "prescreen",
    purpose: "employment_prescreen",
    candidateId: state.userId,
    jobId: state.jobId,
    prescreenSessionId: state.sessionId,
    rubricVersion: "prescreen-config-v1",
    algorithmVersion: SCREENING_EVALUATION_ALGORITHM_VERSION,
    evaluator: input.evaluator ?? { kind: "hybrid", promptVersion: "prescreen-keyword-set-v2-strict" },
    dimensions,
    gates,
    weightedFitScore,
    evidenceConfidence,
    missingEvidence,
    riskFlags,
    proposedOutcome,
    reviewPriority: deriveReviewPriority({ proposedOutcome, gates, evidenceConfidence, riskFlags }),
    explanation: summarizeEvaluation(proposedOutcome, dimensions, gates),
    evidence,
    humanReview: { status: "pending" },
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  }
}

export function practiceQuestionToEvaluationAttempt(input: PracticeQuestionEvaluationInput): EvaluationAttempt {
  const question = input.question
  const evidence: EvaluationEvidenceRef[] = [
    {
      refId: `practice_question:${question.id}`,
      source: "practice_question",
      summary: question.prompt.slice(0, 1_000),
      path: `pa-practice-question-bank/${question.id}`,
    },
  ]
  if (input.answerText?.trim()) {
    evidence.push({
      refId: `practice_answer:${question.id}`,
      source: "transcript_turn",
      quote: input.answerText.trim().slice(0, 2_000),
      summary: "Candidate practice answer.",
    })
  }

  const dimensions = input.dimensionScores ?? question.evaluation.rubric.map((item, index) => {
    const score: 0 | 1 | 2 | 3 | 4 = 0
    return {
      dimensionId: safeId(item.criterion) || `rubric_${index + 1}`,
      label: item.criterion,
      criterion: item.guidance || item.criterion,
      weight: item.weight ?? 1,
      score,
      anchor: scoreToAnchor(score),
      confidence: 0,
      evidenceRefs: [],
      missingEvidence: [item.criterion],
      rationale: "Practice answer has not been scored yet.",
      riskFlags: [],
    } satisfies EvaluationDimensionScore
  })

  const weightedFitScore = calculateWeightedFitScore(dimensions)
  const evidenceConfidence = calculateEvidenceConfidence(dimensions)
  const proposedOutcome: EvaluationOutcome = { kind: "practice_feedback" }

  return {
    schemaVersion: 1,
    attemptId: createEvaluationAttemptId({
      source: "practice_question",
      candidateId: input.candidateId,
      questionBankId: question.id,
      salt: input.nowIso,
    }),
    source: "practice_question",
    purpose: "interview_practice",
    candidateId: input.candidateId,
    questionBankId: question.id,
    rubricVersion: `practice-question-bank:${question.schemaVersion}`,
    algorithmVersion: SCREENING_EVALUATION_ALGORITHM_VERSION,
    evaluator: input.evaluator ?? { kind: "hybrid", promptVersion: "practice-rubric-v1" },
    dimensions,
    gates: [],
    weightedFitScore,
    evidenceConfidence,
    missingEvidence: unique([
      ...question.evaluation.expectedSignals,
      ...dimensions.flatMap((d) => d.missingEvidence),
    ]),
    riskFlags: question.evaluation.redFlags,
    proposedOutcome,
    reviewPriority: "low",
    explanation: "Practice evaluation artifact only; no employment effect.",
    evidence,
    humanReview: { status: "pending" },
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  }
}

export function externalSupplyEvalToEvaluationAttempt(input: ExternalSupplyEvaluationInput): EvaluationAttempt {
  const row = input.evaluation
  const dimensions: EvaluationDimensionScore[] = [
    scoreDimension("general", "General hireability", row.generalRubricScore, 1),
    scoreDimension("company", "Company fit", row.companyRubricScore, 1),
    scoreDimension("job", "Job fit", row.jobRubricScore, 2),
  ]
  const gates: EvaluationGate[] = [
    {
      gateId: "external_supply_hard_gate",
      label: "External supply hard gate",
      severity: row.hardGateResult === "hard_block" ? "hard" : "soft",
      status: row.hardGateResult,
      evidenceRefs: [],
      rationale: row.hardGateReasons.join("; ") || row.hardGateResult,
    },
  ]
  const weightedFitScore = calculateWeightedFitScore(dimensions)
  const evidenceConfidence = calculateEvidenceConfidence(dimensions)
  const proposedOutcome = deriveProposedOutcome({
    purpose: "candidate_job_fit",
    gates,
    weightedFitScore,
    evidenceConfidence,
    supplyTier: row.proposedTier,
  })

  return {
    schemaVersion: 1,
    attemptId: createEvaluationAttemptId({
      source: "external_supply",
      candidateId: row.candidateId,
      jobId: row.jobId,
      externalEvaluationId: row.evaluationId,
    }),
    source: "external_supply",
    purpose: "candidate_job_fit",
    candidateId: row.candidateId,
    jobId: row.jobId,
    companyId: row.companyId,
    externalEvaluationId: row.evaluationId,
    rubricVersion: row.rubricVersion,
    algorithmVersion: SCREENING_EVALUATION_ALGORITHM_VERSION,
    evaluator: input.evaluator ?? { kind: "deterministic", promptVersion: row.rubricVersion },
    dimensions,
    gates,
    weightedFitScore,
    evidenceConfidence,
    missingEvidence: row.missingInfo,
    riskFlags: row.risks,
    proposedOutcome,
    reviewPriority: deriveReviewPriority({ proposedOutcome, gates, evidenceConfidence, riskFlags: row.risks }),
    explanation: row.explanation,
    evidence: row.evidence.map((ev, index) => ({
      refId: `external:${row.evaluationId}:${index + 1}`,
      source: "external_record",
      summary: ev.summary,
      path: ev.refId,
    })),
    humanReview: row.reviewerDecision
      ? {
          status: "approved",
          reviewer: row.reviewerDecision.reviewer,
          reviewedAt: row.reviewerDecision.reviewedAt,
          finalOutcome: { ...proposedOutcome, supplyTier: row.reviewerDecision.finalTier },
          note: row.reviewerDecision.note,
        }
      : { status: "pending" },
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  }
}

function prescreenQuestionGate(
  qState: { type: string; matchThreshold?: number; terminalCause?: string },
  scored: ScoredJudgeResult | undefined,
  terminal: Exclude<PreScreenTerminal, null>,
): EvaluationGateStatus | null {
  if (qState.type === "GOOD_TO_HAVE") return null
  if (!scored) return "soft_block"
  if (scored.abortHint?.kind === "decline" || scored.abortHint?.kind === "off_topic") return "soft_block"
  const threshold = qState.matchThreshold ?? (qState.type === "MUST_HAVE" ? 0.85 : 0.7)
  if (scored.aggregate.s >= threshold && scored.aggregate.c >= 0.55) return "pass"
  if (terminal === "HARD_STOP" && qState.terminalCause === "type_gate_fail") return "hard_block"
  return "soft_block"
}

function scoreDimension(id: string, label: string, value: number, weight: number): EvaluationDimensionScore {
  const score = confidenceToScore(value)
  return {
    dimensionId: id,
    label,
    criterion: label,
    weight,
    score,
    anchor: scoreToAnchor(score),
    confidence: value,
    evidenceRefs: [],
    missingEvidence: value <= 0.25 ? [`${label} evidence is weak or absent`] : [],
    rationale: `${label} score ${value.toFixed(2)}`,
    riskFlags: [],
  }
}

function summarizeEvaluation(
  outcome: EvaluationOutcome,
  dimensions: EvaluationDimensionScore[],
  gates: EvaluationGate[],
): string {
  const strongest = [...dimensions].sort((a, b) => b.score - a.score)[0]
  const blocked = gates.find((g) => g.status !== "pass")
  if (blocked) return `${outcome.kind}: ${blocked.label} is ${blocked.status}.`
  if (strongest) return `${outcome.kind}: strongest evidence is ${strongest.label}.`
  return `${outcome.kind}: evaluation artifact created for operator review.`
}

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)))
}
