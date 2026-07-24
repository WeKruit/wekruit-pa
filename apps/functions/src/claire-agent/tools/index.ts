/**
 * tools/index.ts — composes the per-workstream tool builders into the single
 * array the Agent receives. Wave 0 owns this composer; each workstream owns ONE
 * builder file (disjoint write scope), so this file never needs cross-workstream edits.
 */
import type { ClaireToolContext } from "../types.js"
import { buildMatchingTools } from "./matching-tools.js"
import { buildDeliveryTools } from "./delivery-tools.js"
import { buildProcessTools, type PrescreenPrompts } from "./process-tools.js"
import { buildSchedulingTools } from "./scheduling-tools.js"
import { buildVoiceCallTools } from "./voice-call-tools.js"

/** Prescreen seed the turn forwards into the FSM tools (qId → DIRECTION + qId → judge RUBRIC). */
export interface BuildClaireToolsOptions {
  /** qId → DIRECTION question text (the agent grounds + probes on these, never reads verbatim). */
  prescreenPrompts?: PrescreenPrompts
  /** qId → judge rubric (keyword hints + clarify cue) the score tool grades against. */
  judgeContext?: Record<string, string>
  /** BLOCKER 3: post-parse pitch turn → withhold react_to_user / no_reply / send_status_then_continue
   *  so a tapback-only can't suppress the mandated text pitch (the live "👍 tapback no response"). */
  forbidSuppressingDelivery?: boolean
  /** DEDICATED YC LANE (Adam-LOCKED 2026-07-23): YC Startup School is PEOPLE matching — investors
   *  sign up too, not just candidates. When set, ALL job-recommendation tools are OMITTED from the
   *  agent (find_match, match_collab, save_job_profile, set_daily_subscription, find_my_role,
   *  begin_collab_prescreen, get_public_role_start, set_matching_preferences, capture_match_feedback,
   *  check_prescreen_progress). The model physically cannot deliver job content — leak-proof by
   *  construction, no scattered per-tool guards. Only the non-job matching tools survive. */
  ycPeopleMode?: boolean
}

/** From buildMatchingTools, the tools that are NOT job-recommendation — safe for the YC lane. */
const YC_ALLOWED_MATCHING_TOOLS = new Set(["remember_fact", "privacy", "cv_parse"])

/** All tools the thin Claire agent can call, in description-routed order. */
export function buildClaireTools(ctx: ClaireToolContext, opts: BuildClaireToolsOptions = {}) {
  const matching = buildMatchingTools(ctx)
  return [
    // YC lane: keep only the non-job matching tools (memory, STOP/privacy, cv_parse). Every job
    // tool is dropped so it is never even in the model's tool set.
    ...(opts.ycPeopleMode
      ? matching.filter((t) => YC_ALLOWED_MATCHING_TOOLS.has((t as { name?: string }).name ?? ""))
      : matching),
    ...buildProcessTools(ctx, opts.prescreenPrompts ?? {}, opts.judgeContext ?? {}),
    ...buildDeliveryTools(ctx, { forbidSuppressingDelivery: opts.forbidSuppressingDelivery }),
    ...buildSchedulingTools(ctx),
    ...buildVoiceCallTools(ctx),
  ]
}
