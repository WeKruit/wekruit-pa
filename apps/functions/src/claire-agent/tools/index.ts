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

/** Prescreen seed the turn forwards into the FSM tools (qId → DIRECTION + qId → judge RUBRIC). */
export interface BuildClaireToolsOptions {
  /** qId → DIRECTION question text (the agent grounds + probes on these, never reads verbatim). */
  prescreenPrompts?: PrescreenPrompts
  /** qId → judge rubric (keyword hints + clarify cue) the score tool grades against. */
  judgeContext?: Record<string, string>
}

/** All tools the thin Claire agent can call, in description-routed order. */
export function buildClaireTools(ctx: ClaireToolContext, opts: BuildClaireToolsOptions = {}) {
  return [
    ...buildMatchingTools(ctx),
    ...buildProcessTools(ctx, opts.prescreenPrompts ?? {}, opts.judgeContext ?? {}),
    ...buildDeliveryTools(ctx),
    ...buildSchedulingTools(ctx),
  ]
}
