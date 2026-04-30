/**
 * Phase 35 — F2 length cap detector (T3 stub; full impl in next commit).
 */
import type { DetectorContext, DetectorResult } from "./types.js"

export function detectLengthCap(_ctx: DetectorContext): DetectorResult {
  return {
    id: "f2_length_cap",
    triggered: false,
    score: 0,
    reason: "stub: T3 not yet implemented",
    suggested_action: null,
    latencyMs: 0,
  }
}
