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
 * Each execute is a thin pass-through to the injected ClaireTransport — the same
 * seam the POC's fake channel records. The transport itself is fail-open, so an
 * execute here never throws into the agent run loop.
 */
import { tool, z } from "../sdk.js"
import type { ClaireToolContext } from "../types.js"

export interface BuildDeliveryToolsOptions {
  /**
   * BLOCKER 3 (Adam 2026-06-03 — the live "👍 tapback no response"): on the post-parse pitch turn the
   * agent MUST send the pitch as text bubbles. A tapback (react_to_user) or a no_reply marks the turn
   * deliveredViaTool → delivery.ts returns 0 → the pitch bubbles are NEVER SENT (candidate gets a 'like'
   * then silence). When this is true we DROP the turn-suppressing delivery tools (react_to_user /
   * no_reply / send_status_then_continue) entirely, so the only way to end the turn is to emit the text.
   */
  forbidSuppressingDelivery?: boolean
}

export function buildDeliveryTools(ctx: ClaireToolContext, opts: BuildDeliveryToolsOptions = {}) {
  const reactToUser = tool({
    name: "react_to_user",
    description:
      "Tapback a low-info ack ('sure','ok','yes') INSTEAD of text, esp while processing; " +
      "never for substantive questions.",
    parameters: z.object({
      reaction: z.enum(["love", "like", "laugh", "emphasize"]),
    }),
    async execute({ reaction }) {
      await ctx.transport.tapback(reaction)
      return { ok: true, delivered: `tapback:${reaction}` }
    },
  })

  const sendStatusThenContinue = tool({
    name: "send_status_then_continue",
    description:
      "Send a quick 'one sec' bubble NOW before a slow tool, then call the slow tool, then reply.",
    parameters: z.object({ status: z.string() }),
    async execute({ status }) {
      await ctx.transport.sendStatus(status)
      return { ok: true }
    },
  })

  const noReply = tool({
    name: "no_reply",
    description:
      "Send nothing at all; only when truly no acknowledgement is needed.",
    parameters: z.object({ reason: z.string() }),
    async execute({ reason }) {
      await ctx.transport.noReply(reason)
      return { ok: true, reason }
    },
  })

  // BLOCKER 3: on a mandated-pitch turn, withhold the turn-completing delivery tools so a tapback-only
  // (or a deliberate no-send) can never suppress the text pitch. The pitch is then the only valid output.
  if (opts.forbidSuppressingDelivery) return []
  return [reactToUser, sendStatusThenContinue, noReply]
}
