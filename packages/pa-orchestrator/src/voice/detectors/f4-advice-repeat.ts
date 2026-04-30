/**
 * Phase 35 — F4 advice-repeat detector (T4 stub; full impl in next commit).
 *
 * Real impl: BGE-M3 SiliconFlow embeddings POST + cos-sim vs last 3 Claire
 * turns. Threshold 0.85. Graceful degrade on missing API key.
 */
import type { DetectorContext, DetectorResult } from "./types.js"

export async function detectAdviceRepeat(_ctx: DetectorContext): Promise<DetectorResult> {
  return {
    id: "f4_advice_repeat",
    triggered: false,
    score: null,
    reason: "stub: T4 not yet implemented",
    suggested_action: null,
    latencyMs: 0,
  }
}
