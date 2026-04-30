/**
 * Phase 35 — F1 verb-mirror detector (T2 stub; full impl in next commit).
 *
 * This is a placeholder so the orchestrator + types compile in T1. The
 * real n-gram Jaccard impl + parity test lands in T2.
 */
import type { DetectorContext, DetectorResult } from "./types.js"

export function detectVerbMirror(_ctx: DetectorContext): DetectorResult {
  return {
    id: "f1_verb_mirror",
    triggered: false,
    score: 0,
    reason: "stub: T2 not yet implemented",
    suggested_action: null,
    latencyMs: 0,
  }
}
