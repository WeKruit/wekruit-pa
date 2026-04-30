/**
 * Phase 37 — FSM types.
 *
 * Single source-of-truth for the 5 UX states + 8 ESConv strategies (re-shaped
 * from Phase 33 `tests/scenarios/lib/voice-axes.mjs:ESCONV_STRATEGIES`) +
 * 3 ESConv stages (re-shaped from Phase 33 `ESCONV_STAGE_ALLOWED`).
 *
 * Hard constraints (per .planning/phases/37-fsm/CONTEXT.md):
 * - 0 net new LLM calls in production (rule-based classifier per D6)
 * - < 10ms per turn end-to-end (`runFsm` p95)
 * - Algorithm parity with Phase 33 `inferStrategy` + `stageForTurn` +
 *   `ESCONV_STAGE_ALLOWED` audited via dynamic-import in `transitions.test.ts`
 *   and `validators.test.ts` (NOT direct import — cross-rootDir blocked)
 *
 * Bilingual zh + en + mixed code-switch supported throughout.
 */

/**
 * 5 UX states. Tie-break order (gravity — heavy states win):
 *   QuietWitness > SoftConcerned > FirmDirect > PlayfulTease > WarmCurious
 *
 * `WarmCurious` is the default fallback when no signals fire.
 *
 * - `WarmCurious`     — neutral / mildly positive; greeting / info-seek / curious tone
 * - `PlayfulTease`    — banter / sarcasm / joke; positive sentiment + emoji tells
 * - `SoftConcerned`   — soft distress / vulnerability / self-doubt; negative-soft
 * - `FirmDirect`      — wants action / hard advice; imperative-verb density
 * - `QuietWitness`    — deep grief / crisis; low question density + heavy negative lexicon
 *
 * See CONTEXT D-37-1 for primary signal definitions per state.
 */
export type UxState =
  | "WarmCurious"
  | "PlayfulTease"
  | "SoftConcerned"
  | "FirmDirect"
  | "QuietWitness"

export const UX_STATES: readonly UxState[] = [
  "WarmCurious",
  "PlayfulTease",
  "SoftConcerned",
  "FirmDirect",
  "QuietWitness",
] as const

/**
 * Tie-break order — heavier states first. When two states tie on score,
 * the one earlier in this array wins.
 */
export const UX_STATE_GRAVITY_ORDER: readonly UxState[] = [
  "QuietWitness",
  "SoftConcerned",
  "FirmDirect",
  "PlayfulTease",
  "WarmCurious",
] as const

/**
 * 8 ESConv strategies. Source-of-truth = Phase 33
 * `tests/scenarios/lib/voice-axes.mjs:ESCONV_STRATEGIES` (line 432).
 * Parity asserted in `transitions.test.ts`.
 */
export type Strategy =
  | "Question"
  | "Restatement"
  | "Reflection"
  | "SelfDisclosure"
  | "Affirmation"
  | "Suggestion"
  | "Information"
  | "Other"

export const STRATEGIES: readonly Strategy[] = [
  "Question",
  "Restatement",
  "Reflection",
  "SelfDisclosure",
  "Affirmation",
  "Suggestion",
  "Information",
  "Other",
] as const

/**
 * 3 ESConv stages. Index in this array matches Phase 33 `stageForTurn`
 * return value (0=Exploration, 1=Comforting, 2=Action).
 */
export type Stage = "Exploration" | "Comforting" | "Action"

export const STAGES: readonly Stage[] = ["Exploration", "Comforting", "Action"] as const

/**
 * 1-indexed turn number → stage index. Mirrors Phase 33
 * `stageForTurn(turnNumber)` exactly:
 *   turns 1-3 → 0 (Exploration)
 *   turns 4-7 → 1 (Comforting)
 *   turns 8+  → 2 (Action)
 */
export type StageIndex = 0 | 1 | 2

/**
 * Classifier result. `signals.matched` lists the trigger phrases / tells
 * that contributed; `signals.scores` is a per-state raw score table for
 * debugging + telemetry.
 */
export interface UxStateClassifierResult {
  uxState: UxState
  /** 0..1 normalized score for the winning state. */
  confidence: number
  signals: {
    matched: string[]
    scores: Record<UxState, number>
  }
}

/**
 * Transition table entry — Phase 37 D-37-2.
 * Per-uxState preferred-strategy set, intersected with stage allowed-set.
 */
export interface Transition {
  uxState: UxState
  preferredStrategies: ReadonlySet<Strategy>
}

/**
 * Input shape for `runFsm`.
 *
 * - `turn.user`    — current user message (zh/en/mixed)
 * - `turn.assistant` — Claire's draft reply (post-rewriter, OPTIONAL — only
 *                     used by post-gen `validateStrategyFit`; pre-gen pass
 *                     ignores it)
 * - `history.userTurns`     — last N user messages (oldest-first)
 * - `history.claireReplies` — last N Claire replies (oldest-first)
 * - `turnNumber` — 1-indexed turn count for stage mapping
 * - `prevStrategy` — Claire's previous-turn ESConv strategy (for TransESC
 *                    continuity weighting); inferred from
 *                    `history.claireReplies` if absent
 */
export interface FsmContext {
  turn: {
    user: string
    assistant?: string
  }
  history: {
    userTurns: string[]
    claireReplies: string[]
  }
  turnNumber: number
  prevStrategy?: Strategy
}

/**
 * `runFsm` output. Wire-in caller (Adam-owed via WIRE-IN-PATCH.md) consumes:
 *
 * - `directive` — the `[FSM-DIRECTIVE]...[/FSM-DIRECTIVE]` block to append
 *                 to the Phase 3 system prompt
 * - `allowedStrategies` — the LLM's permitted strategy set for this turn
 * - `preferredNext` — argmax of TransESC continuity-weighted set; suggestion
 *                     for the LLM, not enforced
 * - `latencyMs` — wall-clock budget instrumentation (asserted < 10ms p95)
 */
export interface FsmResult {
  uxState: UxState
  uxStateConfidence: number
  stage: Stage
  stageIndex: StageIndex
  allowedStrategies: Strategy[]
  preferredNext: Strategy
  directive: string
  latencyMs: number
  /** Debug aid — per-state classifier scores; logged in telemetry. */
  signals: {
    matched: string[]
    scores: Record<UxState, number>
  }
}

/**
 * Strategy-fit gate result — post-gen validator output.
 * Wire-in caller may reject + retry on `allowed === false`; v1.4 default
 * is log-only (Phase 40 ship-gate decides retry policy).
 */
export interface StrategyFitResult {
  strategy: Strategy
  allowed: boolean
  confidence: number
  matchedKeyword: string | null
}
