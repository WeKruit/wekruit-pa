/**
 * Phase 38 — Memory Policy barrel + `runMemoryPolicy` orchestrator.
 *
 * Wire-in (Adam-owed via WIRE-IN-PATCH.md) imports from this module:
 *
 *   import {
 *     runMemoryPolicy,
 *     trackAdvice,
 *     type MemoryPolicyResult,
 *   } from "./memory-policy/index.js"
 *
 * Pipeline:
 *
 *   { userId, turnId, claireReply, userLang, factsCache?, currentStrategy?, currentUxState? }
 *     → recentAdvice(userId, 3, deps)            // Firestore read
 *     → repeatScore(reply, recent, deps)          // BGE-M3 cos-sim
 *     → detectContradiction(ctx, deps)            // Mem0 read + persona (S3 sync)
 *     → buildAdviceInjection(recent, opts)        // Phase 3 prompt addendum
 *     → MemoryPolicyResult { advice, contradiction, latencyMs }
 *
 * Latency budget per CONTEXT D-38-7: < 200ms p95 (warm path).
 *
 * Hard constraints:
 * - 0 net new LLM calls (BGE-M3 = embedding tier; Mem0 fact extract uses
 *   EXISTING Qwen call from `stacked.ts:applyAfterTurn`)
 * - Bilingual zh + en + mixed
 * - S3 sync via `deps.getPersona` (Phase 32 W3 Firestore source)
 * - Graceful degrade on missing API key / Mem0 / Firestore
 *
 * The orchestrator is a single async function. The two read steps
 * (recentAdvice + Mem0 search via contradiction detector) execute
 * concurrently via `Promise.allSettled` to keep wall-clock low.
 *
 * Note: `trackAdvice` is NOT called here — it's called by the wire-in
 * caller AFTER the rewriter emits the final cleaned text (post-strip,
 * post-detector-action). Phase 38 surface = "what would the policy do
 * given this draft" + "persist this final text after emit".
 */

import type {
  AdviceTrackerDeps,
  AdviceTrackerEntry,
  ContradictionResult,
  MemoryPolicyContext,
  MemoryPolicyResult,
  RepeatScoreResult,
} from "./types.js"
import {
  ADVICE_TRACKER_COLLECTION,
  _defaultEmbedFn,
  _resetEmbedCache,
  _setEmbedFetchImpl,
  cosineSim,
  detectReplyLang,
  recentAdvice,
  repeatScore,
  trackAdvice,
} from "./advice-tracker.js"
import {
  CONTRADICTION_TYPE_PRIORITY,
  detectContradiction,
} from "./contradiction-detector.js"
import {
  MEMORY_POLICY_NOTE_EN,
  MEMORY_POLICY_NOTE_ZH,
  buildAdviceInjection,
} from "./prompt-injector.js"
import {
  MEMORY_POLICY_DEFAULT_EXTRACTOR,
  MEMORY_POLICY_REJECTED_SUBSTRINGS,
  assertExtractorPinnedOrThrow,
  pinnedExtractorModel,
  verifyExtractorPinned,
} from "./extractor-config.js"

// Re-exports — single import surface for wire-in caller + tests.
export type {
  AdviceTrackerDeps,
  AdviceTrackerEntry,
  ContradictionResult,
  ContradictionType,
  MemoryPolicyContext,
  MemoryPolicyResult,
  PersonaSnapshot,
  RepeatScoreResult,
} from "./types.js"
export {
  ADVICE_TRACKER_COLLECTION,
  _defaultEmbedFn,
  _resetEmbedCache,
  _setEmbedFetchImpl,
  cosineSim,
  detectReplyLang,
  recentAdvice,
  repeatScore,
  trackAdvice,
} from "./advice-tracker.js"
export {
  CONTRADICTION_TYPE_PRIORITY,
  detectContradiction,
} from "./contradiction-detector.js"
export type { TrackAdviceOpts } from "./advice-tracker.js"
export {
  MEMORY_POLICY_NOTE_EN,
  MEMORY_POLICY_NOTE_ZH,
  buildAdviceInjection,
} from "./prompt-injector.js"
export type { BuildAdviceInjectionOpts } from "./prompt-injector.js"
export {
  MEMORY_POLICY_DEFAULT_EXTRACTOR,
  MEMORY_POLICY_REJECTED_SUBSTRINGS,
  assertExtractorPinnedOrThrow,
  pinnedExtractorModel,
  verifyExtractorPinned,
} from "./extractor-config.js"
export type { ExtractorPinResult } from "./extractor-config.js"

// ---------------------------------------------------------------------------
// Suppress unused-import warnings for re-exports
// ---------------------------------------------------------------------------

void cosineSim
void detectReplyLang
void _resetEmbedCache
void _setEmbedFetchImpl
void _defaultEmbedFn
void buildAdviceInjection
void verifyExtractorPinned
void pinnedExtractorModel
void assertExtractorPinnedOrThrow
void MEMORY_POLICY_REJECTED_SUBSTRINGS
void MEMORY_POLICY_DEFAULT_EXTRACTOR
void MEMORY_POLICY_NOTE_EN
void MEMORY_POLICY_NOTE_ZH
void ADVICE_TRACKER_COLLECTION
void detectContradiction
void CONTRADICTION_TYPE_PRIORITY

// ---------------------------------------------------------------------------
// runMemoryPolicy — single-entry orchestrator
// ---------------------------------------------------------------------------

const EMPTY_CONTRADICTION: ContradictionResult = {
  violated: false,
  type: null,
  violatedTerm: null,
  factSnippet: null,
  replySnippet: null,
  confidence: 0,
  latencyMs: 0,
}

const EMPTY_REPEAT: RepeatScoreResult = {
  triggered: false,
  maxSim: 0,
  mostSimilarIdx: -1,
  sims: [],
  threshold: 0.85,
  reason: "no_input",
  latencyMs: 0,
}

/**
 * Run the memory policy pipeline for a single Claire reply.
 *
 * Concurrency: `recentAdvice` (Firestore) + `detectContradiction` (Mem0
 * read + persona) run in parallel. `repeatScore` depends on `recentAdvice`
 * so it runs after.
 *
 * NEVER throws — all errors swallowed + logged. Returns a result object
 * with `advice.repeatScore.maxSim === null` or `contradiction.violated === false`
 * + a reason string when degraded.
 */
export async function runMemoryPolicy(
  ctx: MemoryPolicyContext,
  deps: AdviceTrackerDeps = {}
): Promise<MemoryPolicyResult> {
  const start = performance.now()

  if (!ctx.userId || !ctx.turnId || !ctx.claireReply) {
    return {
      advice: {
        recent: [],
        repeatScore: { ...EMPTY_REPEAT, reason: "no_input" },
        injection: "",
      },
      contradiction: { ...EMPTY_CONTRADICTION },
      latencyMs: performance.now() - start,
    }
  }

  // Concurrent reads: Firestore (recentAdvice) + Mem0 (contradiction).
  // We need recent[] before repeatScore, so do contradiction in parallel.
  const recentP = recentAdvice(ctx.userId, 3, deps).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.log("[memory-policy/run] recentAdvice failed (degrade)", { msg })
    return [] as AdviceTrackerEntry[]
  })
  const contraP = detectContradiction(ctx, deps).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.log("[memory-policy/run] detectContradiction failed (degrade)", { msg })
    return { ...EMPTY_CONTRADICTION }
  })

  const [recent, contradiction] = await Promise.all([recentP, contraP])

  const repeat = await repeatScore(ctx.claireReply, recent, deps).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.log("[memory-policy/run] repeatScore failed (degrade)", { msg })
    return {
      ...EMPTY_REPEAT,
      reason: `skipped: repeatScore error: ${msg}`,
    }
  })

  const injection = buildAdviceInjection(recent, { userLang: ctx.userLang })

  return {
    advice: {
      recent,
      repeatScore: repeat,
      injection,
    },
    contradiction,
    latencyMs: performance.now() - start,
  }
}
