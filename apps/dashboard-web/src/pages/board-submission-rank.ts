/**
 * Pure, testable triage-ranking for recruiter submissions.
 *
 * Extracted from RecruiterBoardOps.tsx so the comparator can be unit-tested
 * (a TSX page component can't be imported in node tests, which is why the rest
 * of that file is only covered by brittle source-string assertions).
 *
 * Design (research-backed — see candidate-ranking research): candidate ordering
 * is NON-COMPENSATORY, so we sort LEXICOGRAPHICALLY rather than with a weighted
 * sum. A `reject` must never outrank an `advance` however confident; verdict and
 * a COARSE confidence band are strict gates (raw LLM confidence is overconfident
 * + ceiling-compressed, so fine-grained ordering on it is false precision). A
 * small bounded sub-score blend only tie-breaks WITHIN one (verdict, band)
 * cohort, where items are commensurable — so its chosen coefficients can never
 * reorder across verdicts or bands. Hard gates run upstream; this only orders
 * what is already in the reviewer's queue.
 */

export interface RankChecklistTally {
  met?: number
  total?: number
}

export interface RankAntiTally {
  flagged?: number
  total?: number
}

export interface RankScore {
  hardChecked: number
  hardTotal: number
  fitChecked: number
  fitTotal: number
  bonusChecked: number
  bonusTotal: number
  antiChecked: number
  antiTotal: number
}

export interface RankEvaluation {
  verdict?: "advance" | "borderline" | "reject"
  confidence?: number
  error?: unknown
  checklist?: {
    hard?: RankChecklistTally
    fit?: RankChecklistTally
    bonus?: RankChecklistTally
    anti?: RankAntiTally
  }
}

export interface RankableSubmission {
  aiEvaluation?: RankEvaluation
  score?: RankScore
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function checklistMetRatio(tally: RankChecklistTally | undefined): number {
  const total = Number(tally?.total ?? 0)
  if (!Number.isFinite(total) || total <= 0) return 0
  return clamp01(Number(tally?.met ?? 0) / total)
}

export function antiFlagRatio(tally: RankAntiTally | undefined): number {
  const total = Number(tally?.total ?? 0)
  if (!Number.isFinite(total) || total <= 0) return 0
  return clamp01(Number(tally?.flagged ?? 0) / total)
}

export function selfScoreRatio(score: RankScore | undefined): number {
  if (!score) return 0
  const positiveTotal = score.hardTotal + score.fitTotal + score.bonusTotal
  const antiTotal = score.antiTotal
  const positive = positiveTotal > 0
    ? (score.hardChecked + score.fitChecked + score.bonusChecked) / positiveTotal
    : 0
  const antiPenalty = antiTotal > 0 ? score.antiChecked / antiTotal : 0
  return clamp01(positive - antiPenalty)
}

// Verdict tier (the primary, non-compensatory key): advance > borderline >
// reject > unscored/errored.
export function aiVerdictRank(evaluation: RankEvaluation | undefined): number {
  if (!evaluation || evaluation.error) return 0
  if (evaluation.verdict === "advance") return 3
  if (evaluation.verdict === "borderline") return 2
  if (evaluation.verdict === "reject") return 1
  return 0
}

// Coarse confidence band — calibration-safe. Raw LLM confidence piles at
// 0.9–1.0 with large calibration error, so 0.901-beating-0.900 is noise.
export function confidenceBand(confidence: number): number {
  if (confidence >= 0.8) return 2
  if (confidence >= 0.5) return 1
  return 0
}

// Lexicographic rank key (compared left→right; higher surfaces first).
export function boardSubmissionRankKey(submission: RankableSubmission): readonly number[] {
  const ev = submission.aiEvaluation
  const fit = checklistMetRatio(ev?.checklist?.fit)
  const bonus = checklistMetRatio(ev?.checklist?.bonus)
  const anti = antiFlagRatio(ev?.checklist?.anti)
  return [
    aiVerdictRank(ev), // 1. verdict tier (gate)
    confidenceBand(clamp01(Number(ev?.confidence ?? 0))), // 2. confidence band (not raw)
    Math.round(checklistMetRatio(ev?.checklist?.hard) * 100), // 3a. must-haves met (closest to a gate)
    Math.round((0.5 * fit + 0.3 * bonus - 0.4 * anti) * 100), // 3b. bounded fit/bonus/anti tie-break
    Math.round(selfScoreRatio(submission.score) * 100), // 3c. recruiter self-score (weakest), last
  ]
}

// Lexicographic compare of two rank keys; positive ⇒ `b` should sort before `a`.
export function compareRankKeys(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const delta = (b[i] ?? 0) - (a[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}
