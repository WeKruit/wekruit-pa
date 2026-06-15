/**
 * v1.8 Phase 76 — PreScreen state-machine pure transitions.
 *
 * Each transition is a pure function over (state, input) → (state, action).
 * Pipeline orchestration in pipeline.ts calls these in sequence. Keeping
 * them pure makes the state machine exhaustively testable without LLM,
 * Firestore, or any I/O.
 *
 * The four gates (v1.8 spec):
 *
 *   ┌─────────────────────┐
 *   │  Confidence Gate    │  → clarify (k < 2) OR proceed
 *   ├─────────────────────┤
 *   │  Type Gate          │  → HARD_STOP after probe rounds are exhausted
 *   │                     │    (MUST_HAVE/PROBING fail) OR proceed
 *   ├─────────────────────┤
 *   │  Update score S     │
 *   ├─────────────────────┤
 *   │  Viability Check    │  → PAUSE (S + R_max < T·S_max) OR proceed
 *   │  (hysteresis: only  │
 *   │   after ⌈N/3⌉ done)  │
 *   ├─────────────────────┤
 *   │  Final Decision     │  → PASS / FAIL when no more Qs
 *   └─────────────────────┘
 */

import type { QuestionType, ScoredJudgeResult } from "../onboarding/question.js"
import type { PreScreenState, PreScreenTerminal } from "./state.js"

// ────────────────────────────────────────────────────────────────────────────
// Confidence Gate (PS6 — k≤2 clarification rounds)
// ────────────────────────────────────────────────────────────────────────────

export type ConfidenceGateOutcome =
  | { action: "clarify"; kAfter: number }
  | { action: "proceed" }
  | { action: "max_clarify_exhausted" }

/**
 * Confidence gate. If c_i < τ_c AND k < maxClarifyRounds → clarify (and
 * bump k). If c_i < τ_c AND k == maxClarifyRounds → max_clarify_exhausted
 * (caller routes to Type Gate using whatever score was captured). Else →
 * proceed normally.
 */
export function evalConfidenceGate(args: {
  c: number
  threshold: number
  clarifyRoundsSoFar: number
  maxClarifyRounds: number
}): ConfidenceGateOutcome {
  if (args.c >= args.threshold) return { action: "proceed" }
  if (args.clarifyRoundsSoFar < args.maxClarifyRounds) {
    return { action: "clarify", kAfter: args.clarifyRoundsSoFar + 1 }
  }
  return { action: "max_clarify_exhausted" }
}

// ────────────────────────────────────────────────────────────────────────────
// Type Gate (PS6 — MUST_HAVE / PROBING hard-stop after probing)
// ────────────────────────────────────────────────────────────────────────────

/** Per-type τ_m match-threshold defaults. */
export const DEFAULT_TYPE_THRESHOLDS: Record<QuestionType, number> = {
  MUST_HAVE: 1.0, // failing score blocks only after caller exhausts probe rounds
  PROBING: 0.7,
  GOOD_TO_HAVE: 0, // never blocks
  ALWAYS_ASK: 0, // never blocks (non-gating, like GOOD_TO_HAVE) — Adam 2026-06-14
}

export type TypeGateOutcome =
  | { action: "hard_stop"; cause: "type_gate_fail"; type: QuestionType }
  | { action: "proceed" }

/**
 * Type gate. MUST_HAVE: s < 1.0 → hard stop. PROBING: s < τ_m OR c < τ_c
 * → hard stop. GOOD_TO_HAVE: never blocks (low scores still accumulate).
 *
 * Note: the caller is responsible for exhausting clarification/probe rounds
 * before invoking this as a terminal blocker. The product behavior is to
 * probe for nearest-overlap evidence before concluding a required area is
 * missing.
 */
export function evalTypeGate(args: {
  type: QuestionType
  s: number
  c: number
  matchThreshold?: number
  confidenceThreshold: number
}): TypeGateOutcome {
  const tau_m = args.matchThreshold ?? DEFAULT_TYPE_THRESHOLDS[args.type]
  // GOOD_TO_HAVE + ALWAYS_ASK are non-gating: a low score NEVER hard-stops.
  if (args.type === "GOOD_TO_HAVE" || args.type === "ALWAYS_ASK") return { action: "proceed" }
  if (args.type === "MUST_HAVE") {
    if (args.s < tau_m) return { action: "hard_stop", cause: "type_gate_fail", type: args.type }
    return { action: "proceed" }
  }
  // PROBING
  if (args.s < tau_m || args.c < args.confidenceThreshold) {
    return { action: "hard_stop", cause: "type_gate_fail", type: args.type }
  }
  return { action: "proceed" }
}

// ────────────────────────────────────────────────────────────────────────────
// Viability Check (PS6 — hysteresis + early PAUSE)
// ────────────────────────────────────────────────────────────────────────────

export type ViabilityOutcome =
  | { action: "pause"; reason: string }
  | { action: "proceed" }

/**
 * Continue-viability threshold T_continue (live failure fix 2026-05-28).
 *
 * The viability "should we keep asking" check MUST be decoupled from the
 * PASS-proposal threshold. Production forces the PASS bar to
 * PRESCREEN_REVIEW_PASS_THRESHOLD = 0.95 so the review queue only ever sees
 * Claire propose PASS for ~top-5 evidence — that is a WeKruit-team review policy,
 * NOT a signal the automated FSM should use to early-terminate.
 *
 * If viability used the 0.95 bar, a single competent-but-not-top-5 answer
 * makes 95% mathematically unreachable and the screen PAUSEs after one
 * question (the GTM live failure: a STRONG answer → PAUSE after Q1). The
 * continue bar is intentionally low: PAUSE should mean "even a mediocre PASS
 * is now impossible" (a true hard-fail), not "a perfect score is impossible".
 */
export const PRESCREEN_CONTINUE_THRESHOLD = 0.5

/**
 * Minimum answered questions before viability can ever PAUSE. A single Q's
 * score is too volatile to early-terminate on, and ⌈N/3⌉ collapses to 1 for
 * any N ≤ 3 (the GTM job had a small question set, so it PAUSEd after Q1).
 */
export const VIABILITY_MIN_ANSWERED = 2

/**
 * Viability check. PAUSE iff S + R_max < T_continue·S_max — i.e. PASS is
 * unreachable even at the LOWER continue bar (a genuine hard-fail), NOT when
 * the top-heavy 0.95 PASS-proposal bar is unreachable.
 *
 * Hysteresis: only fire after max(VIABILITY_MIN_ANSWERED, ⌈N/3⌉) Qs answered
 * to avoid false PAUSE during early-Q score volatility and to guarantee a
 * single answered question can never trigger PAUSE.
 *
 *   R_max = sum of remaining-Q weights (NOT remaining-Q max scores;
 *           equivalent because each Q can return s_max = 1.0 with weight 1).
 *   continueThreshold — the LOWER continue bar (defaults to
 *           PRESCREEN_CONTINUE_THRESHOLD; the caller may pass the job's
 *           configured threshold WITHOUT the 0.95 floor, clamped ≤ it).
 */
export function evalViability(args: {
  score: number
  scoreMax: number
  remainingMaxScore: number
  threshold: number
  /** Lower "keep going" bar. Falls back to PRESCREEN_CONTINUE_THRESHOLD. */
  continueThreshold?: number
  questionsAnswered: number
  totalQuestions: number
}): ViabilityOutcome {
  const hysteresis = Math.max(VIABILITY_MIN_ANSWERED, Math.ceil(args.totalQuestions / 3))
  if (args.questionsAnswered < hysteresis) return { action: "proceed" }
  // The continue bar is ONLY the lower viability threshold — never the 0.95
  // PASS-proposal bar. Clamp so it can never exceed the PASS threshold.
  const continueBar = Math.min(
    args.continueThreshold ?? PRESCREEN_CONTINUE_THRESHOLD,
    args.threshold
  )
  const upperBound = args.score + args.remainingMaxScore
  const required = continueBar * args.scoreMax
  if (upperBound < required) {
    return {
      action: "pause",
      reason: `S+R_max=${upperBound.toFixed(2)} < T_continue*S_max=${required.toFixed(2)}`,
    }
  }
  return { action: "proceed" }
}

// ────────────────────────────────────────────────────────────────────────────
// Final Decision (PS6 — PASS/FAIL on queue empty)
// ────────────────────────────────────────────────────────────────────────────

export type FinalOutcome =
  | { action: "pass"; ratio: number }
  | { action: "fail"; ratio: number }

export function evalFinal(args: {
  score: number
  scoreMax: number
  threshold: number
}): FinalOutcome {
  const ratio = args.scoreMax === 0 ? 0 : args.score / args.scoreMax
  if (ratio >= args.threshold) return { action: "pass", ratio }
  return { action: "fail", ratio }
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: apply a scored result to per-Q state (used by pipeline)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Merge a new scored result into per-Q state, taking the higher s_i across
 * clarification rounds (PS6 — score is monotonic across clarifies; lower
 * scores are dropped to defend against LLM noise).
 */
export function mergeScored(
  prior: ScoredJudgeResult | undefined,
  next: ScoredJudgeResult
): ScoredJudgeResult {
  if (!prior) return next
  if (next.aggregate.s >= prior.aggregate.s) return next
  return prior
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: compute remaining max score from PreScreenState
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sum of weights for Qs not yet answered. Equivalent to remaining-Q-max
 * weighted score because s_i ∈ [0,1].
 */
export function remainingMaxScore(state: PreScreenState): number {
  let r = 0
  for (const qId of state.qOrder) {
    const q = state.questions[qId]
    if (q.finalS === undefined) r += q.weight
  }
  return r
}

/** Convenience: count Qs that have a finalS captured. */
export function questionsAnswered(state: PreScreenState): number {
  let n = 0
  for (const qId of state.qOrder) {
    if (state.questions[qId].finalS !== undefined) n++
  }
  return n
}

/** Convenience: terminal-state setter (pure copy). */
export function setTerminal(
  state: PreScreenState,
  terminal: Exclude<PreScreenTerminal, null>,
  reason: string,
  nowIso: string
): PreScreenState {
  return {
    ...state,
    terminal,
    terminalReason: reason,
    currentQId: null,
    updatedAt: nowIso,
  }
}
