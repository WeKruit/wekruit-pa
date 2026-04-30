/**
 * Phase 35 — F3 lang-lock detector (T3 stub; full impl in next commit).
 */
import type { DetectorContext, DetectorResult } from "./types.js"

export function detectLangLock(_ctx: DetectorContext): DetectorResult {
  return {
    id: "f3_lang_lock",
    triggered: false,
    score: 0,
    reason: "stub: T3 not yet implemented",
    suggested_action: null,
    latencyMs: 0,
  }
}
