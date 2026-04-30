/**
 * Phase 37 T2 — TransESC-style transition table.
 *
 * Mirrors Phase 33 `tests/scenarios/lib/voice-axes.mjs:ESCONV_STAGE_ALLOWED`
 * + `stageForTurn` exactly (parity asserted in `transitions.test.ts`).
 *
 * Layers per-uxState preferred-strategy sets on top per CONTEXT D-37-2.
 * Final allowed-set per turn = STAGE_SET ∩ UX_PREF_SET (with stage-only
 * fallback when intersection is empty).
 *
 * Hard constraint: 0 net new LLM calls (pure lookup tables + Map ops).
 * Latency: < 1ms per call (Map lookups).
 */

import type {
  Stage,
  StageIndex,
  Strategy,
  UxState,
} from "./types.js"

// ---------------------------------------------------------------------------
// 8 ESConv strategies — Phase 33 parity oracle.
// Source: voice-axes.mjs:432 ESCONV_STRATEGIES (line numbers may drift).
// Parity asserted in transitions.test.ts via dynamic-import of the .mjs.
// ---------------------------------------------------------------------------
export const ESCONV_STRATEGIES: readonly Strategy[] = [
  "Question",
  "Restatement",
  "Reflection",
  "SelfDisclosure",
  "Affirmation",
  "Suggestion",
  "Information",
  "Other",
] as const

// ---------------------------------------------------------------------------
// 3-stage allowed-set — Phase 33 parity oracle.
// Source: voice-axes.mjs:469 ESCONV_STAGE_ALLOWED.
// ---------------------------------------------------------------------------
export const STAGE_ALLOWED_STRATEGIES: ReadonlyArray<ReadonlySet<Strategy>> = [
  // 0 = Exploration (turns 1-3)
  new Set<Strategy>(["Question", "Restatement", "Reflection"]),
  // 1 = Comforting (turns 4-7)
  new Set<Strategy>(["Reflection", "Affirmation", "SelfDisclosure"]),
  // 2 = Action (turns 8+)
  new Set<Strategy>(["Suggestion", "Information", "Affirmation"]),
] as const

// ---------------------------------------------------------------------------
// Per-uxState preferred strategies — CONTEXT D-37-2.
// These are CROSS-stage preferences; intersected with stage allowed-set
// to produce final allowed-set per turn.
// ---------------------------------------------------------------------------
export const UX_STATE_PREFERRED_STRATEGIES: Readonly<Record<UxState, ReadonlySet<Strategy>>> = {
  WarmCurious: new Set<Strategy>([
    "Question",
    "Restatement",
    "Reflection",
    "Affirmation",
    "SelfDisclosure",
  ]),
  PlayfulTease: new Set<Strategy>(["Affirmation", "SelfDisclosure", "Other"]),
  SoftConcerned: new Set<Strategy>([
    "Reflection",
    "Affirmation",
    "SelfDisclosure",
    "Question",
  ]),
  FirmDirect: new Set<Strategy>([
    "Suggestion",
    "Information",
    "Affirmation",
    "Question",
  ]),
  QuietWitness: new Set<Strategy>(["Reflection", "Affirmation", "SelfDisclosure"]),
} as const

// ---------------------------------------------------------------------------
// Stage <-> index helpers
// ---------------------------------------------------------------------------

const STAGES_INDEXED: ReadonlyArray<Stage> = ["Exploration", "Comforting", "Action"]

/**
 * 1-indexed turn → stage index. Mirrors Phase 33 `stageForTurn` exactly:
 *   turns 1-3 → 0 (Exploration)
 *   turns 4-7 → 1 (Comforting)
 *   turns 8+  → 2 (Action)
 */
export function stageForTurn(turnNumber: number): StageIndex {
  if (!Number.isFinite(turnNumber) || turnNumber <= 3) return 0
  if (turnNumber <= 7) return 1
  return 2
}

export function stageNameForIndex(idx: StageIndex): Stage {
  return STAGES_INDEXED[idx] ?? "Exploration"
}

// ---------------------------------------------------------------------------
// Allowed-set composition — CONTEXT D-37-2 final.
// ---------------------------------------------------------------------------

/**
 * Compute the per-turn allowed strategy set as the intersection of
 *   STAGE_ALLOWED_STRATEGIES[stageIdx] ∩ UX_STATE_PREFERRED_STRATEGIES[uxState]
 *
 * Fallback: if the intersection is empty (paint-into-corner avoidance), return
 * the stage allowed-set unchanged. Don't ship an empty whitelist — the LLM
 * needs SOMETHING to choose from.
 */
export function allowedStrategies(
  stageIdx: StageIndex,
  uxState: UxState
): Set<Strategy> {
  const stageSet = STAGE_ALLOWED_STRATEGIES[stageIdx]
  const uxSet = UX_STATE_PREFERRED_STRATEGIES[uxState]

  const out = new Set<Strategy>()
  for (const s of stageSet) {
    if (uxSet.has(s)) out.add(s)
  }
  if (out.size === 0) {
    // Fallback: stage-only.
    for (const s of stageSet) out.add(s)
  }
  return out
}

/**
 * Membership check — convenience wrapper for callers that just want a
 * boolean. Mirrors Phase 33 `isAllowedStrategy` semantics but uxState-aware.
 */
export function isAllowedForTurn(
  strategy: Strategy,
  stageIdx: StageIndex,
  uxState: UxState
): boolean {
  return allowedStrategies(stageIdx, uxState).has(strategy)
}

// ---------------------------------------------------------------------------
// TransESC continuity weighting — CONTEXT D-37-4.
// Given previous-turn strategy + current allowed-set, weight the next-turn
// preference distribution. Argmax = `preferred_next` in the prompt directive.
// ---------------------------------------------------------------------------

/**
 * Adjacency chain — TransESC-style continuity.
 * Each entry: prev strategy → preferred next strategy (gets adjacency bonus).
 */
const ADJACENCY: ReadonlyMap<Strategy, Strategy> = new Map<Strategy, Strategy>([
  ["Question", "Restatement"],
  ["Restatement", "Reflection"],
  ["Reflection", "Affirmation"],
  ["Affirmation", "SelfDisclosure"],
  ["SelfDisclosure", "Reflection"],
  ["Suggestion", "Information"],
  ["Information", "Suggestion"],
  ["Other", "Question"],
])

/**
 * Compute continuity-weighted preference over the allowed-set.
 *
 * Algorithm:
 * - If `prevStrategy` ∈ allowed-set → it gets weight 0.5 (continuity bias)
 * - The adjacency chain successor (if in allowed-set) gets +0.2 bonus
 * - Remaining allowed-set members split the residual mass uniformly
 * - When `prevStrategy` is null/undefined or not in allowed-set → uniform
 *
 * Returns a Map<Strategy, number> with weights summing to 1.0.
 */
export function nextStrategyWeights(
  prevStrategy: Strategy | undefined | null,
  allowedSet: ReadonlySet<Strategy>
): Map<Strategy, number> {
  const out = new Map<Strategy, number>()
  if (allowedSet.size === 0) return out

  const allowedArr = Array.from(allowedSet)
  const uniform = 1 / allowedArr.length

  if (!prevStrategy || !allowedSet.has(prevStrategy)) {
    for (const s of allowedArr) out.set(s, uniform)
    return out
  }

  // prevStrategy is in allowed-set.
  // Continuity weight: prev = 0.5
  // Adjacency bonus: chainNext gets +0.2 (if in allowed-set)
  // Remaining mass = 0.5 - bonus, split across (allowed - {prev, chainNext})
  const continuityWeight = 0.5
  const adjacencyBonus = 0.2
  const chainNext = ADJACENCY.get(prevStrategy)
  const hasChainNext = chainNext !== undefined && allowedSet.has(chainNext) && chainNext !== prevStrategy

  let mass = 1.0
  out.set(prevStrategy, continuityWeight)
  mass -= continuityWeight
  if (hasChainNext) {
    out.set(chainNext!, adjacencyBonus)
    mass -= adjacencyBonus
  }
  const remaining = allowedArr.filter(
    (s) => s !== prevStrategy && (!hasChainNext || s !== chainNext)
  )
  if (remaining.length > 0) {
    const each = mass / remaining.length
    for (const s of remaining) out.set(s, each)
  } else if (mass > 0) {
    // No remaining slots — give residual mass back to prev for normalization.
    out.set(prevStrategy, continuityWeight + mass)
  }

  return out
}

/**
 * Pick the argmax strategy from continuity-weighted set.
 * Tie-break: ESCONV_STRATEGIES order (first wins).
 */
export function preferredNextStrategy(
  prevStrategy: Strategy | undefined | null,
  allowedSet: ReadonlySet<Strategy>
): Strategy {
  const weights = nextStrategyWeights(prevStrategy, allowedSet)
  if (weights.size === 0) {
    // Empty allowed-set should have been prevented by allowedStrategies fallback.
    return "Other"
  }
  let bestStrat: Strategy = ESCONV_STRATEGIES[0]
  let bestW = -Infinity
  for (const s of ESCONV_STRATEGIES) {
    const w = weights.get(s)
    if (w !== undefined && w > bestW) {
      bestW = w
      bestStrat = s
    }
  }
  return bestStrat
}
