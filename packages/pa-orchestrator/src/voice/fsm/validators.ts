/**
 * Phase 37 T2 — strategy_fit validator.
 *
 * TS port of Phase 33 `inferStrategy` keyword-priority classifier
 * (canonical: tests/scenarios/lib/voice-axes.mjs:495). Parity asserted in
 * `validators.test.ts` via 12-input dynamic-import comparison.
 *
 * Hard constraint: 0 net new LLM calls (regex + lexicon scan only).
 * Latency: < 3ms per call.
 */

import type {
  FsmContext,
  Strategy,
  StrategyFitResult,
} from "./types.js"
import { ESCONV_STRATEGIES, allowedStrategies, stageForTurn } from "./transitions.js"

// ---------------------------------------------------------------------------
// Keyword banks — EN port of Phase 33 STRATEGY_KEYWORDS_EN
// (voice-axes.mjs:454). Parity asserted in validators.test.ts.
//
// The legacy zh bank is retained as an empty map (product is English-only) so
// the zh-priority walk below is a no-op and the en bank decides everything.
// ---------------------------------------------------------------------------

const STRATEGY_KEYWORDS_ZH: Record<Strategy, readonly string[]> = {
  Question: [],
  Restatement: [],
  Reflection: [],
  SelfDisclosure: [],
  Affirmation: [],
  Suggestion: [],
  Information: [],
  Other: [],
}

const STRATEGY_KEYWORDS_EN: Record<Strategy, readonly string[]> = {
  Question: ["?", "how ", "what ", "why ", "where ", "when "],
  Restatement: ["so you", "you said", "you mean", "you're saying"],
  Reflection: ["sounds like", "feels like", "must be", "that's hard"],
  SelfDisclosure: ["i once", "i had", "when i", "i remember", "i've been"],
  Affirmation: ["you got", "that's valid", "makes sense", "totally fair"],
  Suggestion: ["try ", "could ", "maybe try", "what if you"],
  Information: [],
  Other: [],
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Infer the ESConv strategy from a Claire reply. Mirrors Phase 33
 * `inferStrategy` — keyword-priority walk (legacy zh bank is empty), first
 * hit wins.
 *
 * @param reply Claire's draft / final text
 * @returns `{ strategy, confidence, matchedKeyword }`
 */
export function inferStrategy(reply: string): {
  strategy: Strategy
  confidence: number
  matchedKeyword: string | null
} {
  if (typeof reply !== "string" || reply.trim().length === 0) {
    return { strategy: "Other", confidence: 0, matchedKeyword: null }
  }
  const text = reply.trim()
  const lower = text.toLowerCase()

  // zh first (per Phase 33 priority) — legacy zh bank is empty (English-only).
  for (const strat of ESCONV_STRATEGIES) {
    const kws = STRATEGY_KEYWORDS_ZH[strat] ?? []
    for (const kw of kws) {
      if (text.includes(kw)) {
        return { strategy: strat, confidence: 0.7, matchedKeyword: kw }
      }
    }
  }
  // en
  for (const strat of ESCONV_STRATEGIES) {
    const kws = STRATEGY_KEYWORDS_EN[strat] ?? []
    for (const kw of kws) {
      if (lower.includes(kw)) {
        return { strategy: strat, confidence: 0.6, matchedKeyword: kw }
      }
    }
  }
  // Fallback: short = Other; longer = Information.
  if (text.length < 8) {
    return { strategy: "Other", confidence: 0.3, matchedKeyword: null }
  }
  return { strategy: "Information", confidence: 0.4, matchedKeyword: null }
}

/**
 * Validate that a Claire reply's inferred strategy is in the allowed-set.
 *
 * @param reply       Claire's draft / final text
 * @param allowedSet  Allowed strategies for this turn (from `allowedStrategies`)
 * @returns           `{ strategy, allowed, confidence, matchedKeyword }`
 */
export function validateStrategyFit(
  reply: string,
  allowedSet: ReadonlySet<Strategy>
): StrategyFitResult {
  const r = inferStrategy(reply)
  return {
    strategy: r.strategy,
    allowed: allowedSet.has(r.strategy),
    confidence: r.confidence,
    matchedKeyword: r.matchedKeyword,
  }
}

/**
 * End-to-end gate for the eval harness — given a reply + FsmContext,
 * resolve the allowed-set and return validator pass/fail with details.
 *
 * Useful for the accuracy_gate test in T3 + Phase 40 ship-gate.
 */
export function runFsmGate(
  reply: string,
  ctx: { uxState: Parameters<typeof allowedStrategies>[1]; turnNumber: number }
): {
  pass: boolean
  reason: string
  strategy: Strategy
  allowed: boolean
  confidence: number
  matchedKeyword: string | null
  allowedStrategies: Strategy[]
} {
  const stageIdx = stageForTurn(ctx.turnNumber)
  const allowed = allowedStrategies(stageIdx, ctx.uxState)
  const fit = validateStrategyFit(reply, allowed)
  return {
    pass: fit.allowed,
    reason: fit.allowed
      ? `strategy ${fit.strategy} ∈ allowed-set`
      : `strategy ${fit.strategy} NOT in allowed-set ${[...allowed].join(",")}`,
    strategy: fit.strategy,
    allowed: fit.allowed,
    confidence: fit.confidence,
    matchedKeyword: fit.matchedKeyword,
    allowedStrategies: Array.from(allowed),
  }
}

/**
 * Convenience: infer the previous-turn strategy from history. Used by
 * `runFsm` orchestrator to compute TransESC continuity weights when the
 * caller doesn't pass `prevStrategy` explicitly.
 */
export function inferPrevStrategyFromHistory(
  claireReplies: readonly string[]
): Strategy | undefined {
  if (!Array.isArray(claireReplies) || claireReplies.length === 0) return undefined
  // Most-recent first per FsmContext convention (oldest-first array → last is most recent)
  const last = claireReplies[claireReplies.length - 1]
  if (typeof last !== "string" || last.trim().length === 0) return undefined
  return inferStrategy(last).strategy
}

// Re-export for convenience callers.
export { allowedStrategies, stageForTurn } from "./transitions.js"
export type { FsmContext, Strategy, StrategyFitResult } from "./types.js"
