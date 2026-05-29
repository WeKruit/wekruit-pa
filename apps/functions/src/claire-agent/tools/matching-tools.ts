/**
 * tools/matching-tools.ts — WS-tools owns this file.
 *
 * Each tool's `execute` = a deterministic reducer wrapping an EXISTING backend
 * module (no rebuild). Mirrors poc-v1/poc-v3 B tools:
 *   set_matching_preferences → reduceMatchingPreferences (poc-v1) + applyPartialUserTags (sole writer)
 *   find_match               → ctx.findMatch (queryMatchingJobsV16); reads post-reducer tags; never hangs
 *   remember_fact            → mem0 add (@pa/memory), crisis-scrubbed
 *   schedule_interview       → SCHEDULE_INTERVIEW connector (dedup verdict)
 *   save_job_profile / set_daily_subscription / cv_parse / match_collab → existing connectors
 *   privacy (export/delete/stop) → runCandidatePrivacyRequest (+ PII-website-lock: no chat PII write)
 *
 * WS-tools: replace the body — return an array of `tool({...})` (let TS infer the type).
 */
import { tool } from "@openai/agents"
import type { ClaireToolContext } from "../types.js"

void tool // keep the SDK import referenced until WS-tools fills the body

export function buildMatchingTools(_ctx: ClaireToolContext) {
  // TODO(WS-tools): set_matching_preferences, find_match, remember_fact,
  // schedule_interview, save_job_profile, set_daily_subscription, cv_parse,
  // match_collab, privacy. Each execute = reducer wrapping the KEEP backend.
  return [] as ReturnType<typeof tool>[]
}
