/**
 * Phase 37 — FSM barrel export + `runFsm` orchestrator.
 *
 * Wire-in (Adam-owed via WIRE-IN-PATCH.md) imports from this module:
 *
 *   import {
 *     runFsm,
 *     validateStrategyFit,
 *     type FsmResult,
 *   } from "./fsm/index.js"
 *
 * Pipeline:
 *
 *   user message + history + turnNumber
 *     → classifyUxState (rule-based 5-class)
 *     → stageForTurn (1-indexed turn → 0/1/2)
 *     → allowedStrategies(stage, uxState) — D-37-2 intersection
 *     → preferredNextStrategy(prevStrategy, allowed) — D-37-4 TransESC
 *     → buildFsmDirective(...) — Phase 3 prompt addendum
 *     → FsmResult { uxState, stage, allowedStrategies, preferredNext,
 *                   directive, latencyMs, signals }
 *
 * Latency budget per CONTEXT D-37-7: < 10ms p95 end-to-end.
 *
 * Hard constraint: 0 net new LLM calls (rule-based only per D6).
 */

import type { FsmContext, FsmResult, Strategy } from "./types.js"

import { classifyUxState } from "./ux-state-classifier.js"
import {
  allowedStrategies,
  preferredNextStrategy,
  stageForTurn,
  stageNameForIndex,
} from "./transitions.js"
import { inferPrevStrategyFromHistory } from "./validators.js"
import { buildFsmDirective } from "./prompt-directive.js"

// Re-exports — single import surface for wire-in caller.
export type {
  FsmContext,
  FsmResult,
  Stage,
  StageIndex,
  Strategy,
  StrategyFitResult,
  Transition,
  UxState,
  UxStateClassifierResult,
} from "./types.js"

export { UX_STATES, UX_STATE_GRAVITY_ORDER, STRATEGIES, STAGES } from "./types.js"

export { classifyUxState } from "./ux-state-classifier.js"
export {
  ESCONV_STRATEGIES,
  STAGE_ALLOWED_STRATEGIES,
  UX_STATE_PREFERRED_STRATEGIES,
  allowedStrategies,
  isAllowedForTurn,
  nextStrategyWeights,
  preferredNextStrategy,
  stageForTurn,
  stageNameForIndex,
} from "./transitions.js"
export {
  inferPrevStrategyFromHistory,
  inferStrategy,
  runFsmGate,
  validateStrategyFit,
} from "./validators.js"
export {
  STAGE_GLOSS_EN,
  STAGE_GLOSS_ZH,
  buildFsmDirective,
} from "./prompt-directive.js"

// ---------------------------------------------------------------------------
// runFsm — single-entry orchestrator
// ---------------------------------------------------------------------------

export interface RunFsmOpts {
  /** "zh" | "en" | "mixed" — controls directive `note:` gloss language. */
  userLang?: "zh" | "en" | "mixed"
}

/**
 * Run the full FSM pipeline for a single turn.
 *
 * @param ctx     `FsmContext` — current turn + history + turnNumber + optional prev strategy
 * @param opts    `RunFsmOpts` — directive language hint
 * @returns       `FsmResult` — full state + directive ready to inject into Phase 3 prompt
 */
export function runFsm(ctx: FsmContext, opts: RunFsmOpts = {}): FsmResult {
  const start = performance.now()

  // 1. Classify ux state from current user turn.
  const classifier = classifyUxState(
    { user: ctx.turn?.user ?? "" },
    { userTurns: ctx.history?.userTurns ?? [] }
  )

  // 2. Map turn → stage.
  const stageIdx = stageForTurn(ctx.turnNumber)
  const stage = stageNameForIndex(stageIdx)

  // 3. Compose allowed-set (uxState ∩ stage; stage-only fallback).
  const allowedSet = allowedStrategies(stageIdx, classifier.uxState)
  const allowedArr: Strategy[] = Array.from(allowedSet)

  // 4. TransESC continuity weighting.
  const prevStrategy =
    ctx.prevStrategy ?? inferPrevStrategyFromHistory(ctx.history?.claireReplies ?? [])
  const preferredNext = preferredNextStrategy(prevStrategy, allowedSet)

  // 5. Build prompt directive.
  const directive = buildFsmDirective(
    {
      uxState: classifier.uxState,
      stage,
      allowedStrategies: allowedArr,
      preferredNext,
    },
    { userLang: opts.userLang }
  )

  return {
    uxState: classifier.uxState,
    uxStateConfidence: classifier.confidence,
    stage,
    stageIndex: stageIdx,
    allowedStrategies: allowedArr,
    preferredNext,
    directive,
    latencyMs: performance.now() - start,
    signals: classifier.signals,
  }
}
