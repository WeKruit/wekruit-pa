/**
 * tools/delivery-tools.ts — WS-delivery owns this file.
 *
 * LLM-DECIDED delivery tools (replace the regex conversation-action-arbiter).
 * Mirrors poc-v2 / poc-v3 A:
 *   react_to_user            → ctx.transport.tapback (low-info ack while processing)
 *   send_status_then_continue→ ctx.transport.sendStatus (quick "one sec" before a slow tool)
 *   no_reply                 → ctx.transport.noReply (deliberately send nothing)
 *
 * (mark-read + typing are deterministic REFLEXES in delivery.ts, not tools.)
 *
 * WS-delivery: replace the body — return an array of `tool({...})` (let TS infer).
 */
import { tool } from "@openai/agents"
import type { ClaireToolContext } from "../types.js"

void tool

export function buildDeliveryTools(_ctx: ClaireToolContext) {
  // TODO(WS-delivery): react_to_user, send_status_then_continue, no_reply.
  return [] as ReturnType<typeof tool>[]
}
