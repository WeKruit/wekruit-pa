/**
 * Phase 35 — Barrel export + `runAllDetectors` orchestrator.
 *
 * Wire-in (Adam-owed via WIRE-IN-PATCH.md) imports from this module:
 *
 *   import {
 *     runAllDetectors,
 *     type DetectorResult,
 *   } from "./detectors/index.js"
 *
 * The orchestrator runs all 4 detectors in parallel via `Promise.allSettled`
 * so a single F4 network failure never blocks F1+F2+F3 fast paths.
 *
 * Latency budget per CONTEXT §3 D-35-7:
 * - F1+F2+F3 combined < 50ms p95
 * - F4 < 200ms p95 when network present
 * - `runAllDetectors` total p95 < 250ms
 *
 * Smoke harness (T5) enforces these via `latencyMs` per result.
 */

import type {
  DetectorContext,
  DetectorFn,
  DetectorId,
  DetectorResult,
  RunAllDetectorsOpts,
} from "./types.js"

import { detectVerbMirror } from "./f1-verb-mirror.js"
import { detectLengthCap } from "./f2-length-cap.js"
import { detectLangLock } from "./f3-lang-lock.js"
import { detectAdviceRepeat } from "./f4-advice-repeat.js"

export type {
  DetectorContext,
  DetectorFn,
  DetectorId,
  DetectorResult,
  RunAllDetectorsOpts,
  SuggestedAction,
} from "./types.js"

export { detectVerbMirror } from "./f1-verb-mirror.js"
export { detectLengthCap } from "./f2-length-cap.js"
export { detectLangLock } from "./f3-lang-lock.js"
export { detectAdviceRepeat } from "./f4-advice-repeat.js"

/** Default production detector set. F4 last (longest tail latency). */
export const DEFAULT_DETECTORS: DetectorFn[] = [
  detectVerbMirror,
  detectLengthCap,
  detectLangLock,
  detectAdviceRepeat,
]

/**
 * Run all detectors in parallel. Never throws — rejected detectors become
 * `{ triggered: false, reason: "detector_error: <msg>", ... }` results.
 *
 * @param ctx     Detector context (turn + history)
 * @param opts    Optional overrides
 * @returns       One DetectorResult per detector, in the same order as the
 *                input set (DEFAULT_DETECTORS by default).
 */
export async function runAllDetectors(
  ctx: DetectorContext,
  opts: RunAllDetectorsOpts = {}
): Promise<DetectorResult[]> {
  const detectors = opts.detectors ?? DEFAULT_DETECTORS

  const settled = await Promise.allSettled(
    detectors.map(async (fn) => {
      const start = performance.now()
      try {
        const r = await fn(ctx)
        // Orchestrator timing is authoritative — overwrites whatever the
        // detector reported. Detector-internal latencyMs can miss async
        // overhead (Promise scheduling, microtask queueing), so we measure
        // wall-clock here and trust ourselves.
        return { ...r, latencyMs: performance.now() - start }
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        return _errorResult(fn, msg, performance.now() - start)
      }
    })
  )

  // Flatten allSettled. Rejected promises shouldn't happen (we catch above)
  // but defense-in-depth: synthesize an error result.
  return settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value
    const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
    return _errorResult(detectors[i], msg, 0)
  })
}

/**
 * Build a synthetic error-shaped DetectorResult. Falls back to
 * id="unknown" when the detector function can't be identified by name.
 */
function _errorResult(fn: DetectorFn, msg: string, latencyMs: number): DetectorResult {
  const id = _idFromFn(fn)
  return {
    id,
    triggered: false,
    score: null,
    reason: `detector_error: ${msg}`,
    suggested_action: null,
    latencyMs,
  }
}

/**
 * Best-effort detector-id inference for error results. Falls back to
 * `f1_verb_mirror` (a stable known ID) when the function name is mangled
 * — error consumers should rely on `reason` not `id` in error cases.
 */
function _idFromFn(fn: DetectorFn): DetectorId {
  const name = fn.name || ""
  if (name.includes("VerbMirror")) return "f1_verb_mirror"
  if (name.includes("LengthCap")) return "f2_length_cap"
  if (name.includes("LangLock")) return "f3_lang_lock"
  if (name.includes("AdviceRepeat")) return "f4_advice_repeat"
  // Stable fallback — error consumers gate on `reason` substring.
  return "f1_verb_mirror"
}
