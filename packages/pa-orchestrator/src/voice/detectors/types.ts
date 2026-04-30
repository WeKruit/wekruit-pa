/**
 * Phase 35 — Detector framework types.
 *
 * 4 deterministic detectors operate on a single Claire turn (with prior
 * Claire-reply history) and emit a `DetectorResult`. The wire-in caller
 * (Adam-owed via WIRE-IN-PATCH.md) consumes `suggested_action` to decide
 * post-process strip / regenerate / reject_resample.
 *
 * Hard constraints (per .planning/phases/35-detectors/CONTEXT.md):
 * - 0 net new LLM calls in production (BGE-M3 = embedding tier, free)
 * - F1+F2+F3 combined < 50ms p95; F4 < 200ms p95
 * - Graceful degrade: F4 returns triggered=false + reason="skipped:..."
 *   when env key missing or network fails. NEVER throws.
 *
 * Reused from Phase 33 helpers (algorithm parity audited in T2):
 * - F1 mirrors `tests/scenarios/lib/voice-axes.mjs:computeMirrorRatio`
 * - F2 mirrors `tests/scenarios/lib/sentence-split.mjs:countSentences`
 * - F4 mirrors `tests/scenarios/lib/embed-sim.mjs:maxSimilarityVsHistory`
 */

/** Stable detector identifiers. Logged on every turn for telemetry. */
export type DetectorId =
  | "f1_verb_mirror"
  | "f2_length_cap"
  | "f3_lang_lock"
  | "f4_advice_repeat"

/**
 * Action the wire-in caller should take when `triggered=true`.
 *
 * - `strip`: deterministic post-process (F1 echoed-n-gram strip, F2
 *   sentence truncate). Cheap, no model call.
 * - `regenerate`: re-call rewriter with explicit directive (F3 lang-lock).
 *   1 retry max; fail-open on 2nd attempt.
 * - `reject_resample`: re-call rewriter with diversity nudge listing
 *   prior advice to avoid (F4 advice-repeat). 1 retry max; fail-open.
 */
export type SuggestedAction = "strip" | "regenerate" | "reject_resample"

/**
 * Single-detector result. `score` semantics depend on detector:
 * - F1: mirror ratio 0..1 (Jaccard overlap)
 * - F2: sentence count (integer)
 * - F3: off-language token ratio 0..1
 * - F4: max cos-sim 0..1 vs history; `null` when skipped
 */
export interface DetectorResult {
  id: DetectorId
  triggered: boolean
  score: number | null
  reason: string
  suggested_action: SuggestedAction | null
  /** Wall-clock for the detector call. Asserted in smoke harness. */
  latencyMs: number
}

/**
 * Input shape for a single detector invocation.
 *
 * `turn.user` and `turn.assistant` are the current pair under inspection
 * (assistant = Claire's draft reply post-rewriter).
 *
 * `history.claireReplies` = last N (typically 3) Claire turns, oldest
 * first. F4 uses this for cos-sim history; F1/F2/F3 ignore it.
 *
 * `env` is an optional override hook for tests.
 */
export interface DetectorContext {
  turn: {
    user: string
    assistant: string
  }
  history: {
    claireReplies: string[]
  }
  env?: {
    /** Override `process.env.PA_F1_MIRROR_THRESHOLD` etc. for tests. */
    f1MirrorThreshold?: number
    f2SentenceCap?: number
    f3OffLangThreshold?: number
    f4RepeatThreshold?: number
  }
}

/** Detector function signature. Sync OR async (F4 is async). */
export type DetectorFn = (
  ctx: DetectorContext
) => DetectorResult | Promise<DetectorResult>

/** Options for the orchestrator. */
export interface RunAllDetectorsOpts {
  /**
   * Override the default detector set. Useful for tests (stub detectors)
   * and Phase 36 (arm-aware policy may skip a subset).
   */
  detectors?: DetectorFn[]
}
