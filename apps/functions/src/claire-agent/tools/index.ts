/**
 * tools/index.ts — composes the per-workstream tool builders into the single
 * array the Agent receives. Wave 0 owns this composer; each workstream owns ONE
 * builder file (disjoint write scope), so this file never needs cross-workstream edits.
 */
import type { ClaireToolContext } from "../types.js"
import { buildMatchingTools } from "./matching-tools.js"
import { buildDeliveryTools } from "./delivery-tools.js"
import { buildProcessTools } from "./process-tools.js"

/** All tools the thin Claire agent can call, in description-routed order. */
export function buildClaireTools(ctx: ClaireToolContext) {
  return [
    ...buildMatchingTools(ctx),
    ...buildProcessTools(ctx),
    ...buildDeliveryTools(ctx),
  ]
}
