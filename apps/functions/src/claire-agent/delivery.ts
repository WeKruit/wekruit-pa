/**
 * delivery.ts — WS-delivery owns this file.
 *
 * The two deterministic delivery REFLEXES (no LLM round-trip), mirrors poc-v2:
 *   - mark-read reflex: fire ctx.transport.markRead() on EVERY inbound, before run().
 *   - typing reflex: agent.on("agent_tool_start", …) fires ctx.transport.typing()
 *     before slow tools (find_match etc). NOTE: in @openai/agents 0.8.5 this is the
 *     event-emitter API `agent.on(...)`, NOT an AgentHooks override (which silently
 *     never fires in 0.8.5 — see poc README).
 *
 * Also the post-run delivery decision: if run() produced prose AND no delivery tool
 * (tapback/no_reply) already handled it, send it as text.
 *
 * WS-delivery: implement wireDeliveryReflexes + the post-run send rule.
 */
import type { ClaireToolContext } from "./types.js"
import { notImplemented } from "./types.js"

/** Fire the mark-read reflex (immediate, every inbound, pre-run). */
export async function markReadReflex(ctx: ClaireToolContext): Promise<void> {
  return notImplemented("WS-delivery", "delivery.markReadReflex")
}

/** Wire the typing-before-slow-tool reflex onto the agent's event emitter. */
export function wireTypingReflex(agent: unknown, ctx: ClaireToolContext): void {
  return notImplemented("WS-delivery", "delivery.wireTypingReflex")
}

/** Slow tools that should trigger the typing reflex. */
export const SLOW_TOOLS = ["find_match", "match_collab", "cv_parse"] as const
