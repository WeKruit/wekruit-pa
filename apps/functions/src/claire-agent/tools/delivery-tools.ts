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
import { tool } from "@openai/agents"
import { z } from "zod"
import type { ClaireToolContext } from "../types.js"

export function buildDeliveryTools(ctx: ClaireToolContext) {
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

  return [reactToUser, sendStatusThenContinue, noReply]
}
