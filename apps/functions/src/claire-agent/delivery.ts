/**
 * delivery.ts — WS-delivery owns this file.
 *
 * The two deterministic delivery REFLEXES (no LLM round-trip), mirrors poc-v2:
 *   - mark-read reflex: fire ctx.transport.markRead() on EVERY inbound, before run().
 *   - typing reflex: agent.on("agent_tool_start", …) fires ctx.transport.typing()
 *     before slow tools (find_match etc). NOTE: in @openai/agents 0.8.5 this is the
 *     event-emitter API `agent.on(...)`, NOT an AgentHooks override (which silently
 *     never fires in 0.8.5 — see poc README). Verified firing order:
 *     agent_tool_start → execute.
 *
 * Also the post-run delivery decision: if run() produced prose AND no delivery tool
 * (tapback/no_reply) already handled it, send it as text.
 */
import type { ClaireToolContext } from "./types.js"

/** Slow tools that should trigger the typing reflex. */
export const SLOW_TOOLS = ["find_match", "match_collab", "cv_parse"] as const

/** Fire the mark-read reflex (immediate, every inbound, pre-run). */
export async function markReadReflex(ctx: ClaireToolContext): Promise<void> {
  await ctx.transport.markRead()
}

/**
 * Wire the typing-before-slow-tool reflex onto the agent's event emitter.
 *
 * `agent` is typed `unknown` because Wave B owns the concrete Agent type; we only
 * need the `.on` event-emitter surface. In `agent.on("agent_tool_start", cb)` the
 * 0.8.5 AgentHooks signature is `(context, tool, details)` — so the SECOND arg is
 * the Tool (with `.name`). We still read `t?.name ?? a?.name` defensively to match
 * the proven POC and survive either argument shape.
 */
export function wireTypingReflex(agent: unknown, ctx: ClaireToolContext): void {
  const emitter = agent as {
    on?: (
      event: "agent_tool_start",
      cb: (
        _c: unknown,
        a: { name?: string } | undefined,
        t: { name?: string } | undefined,
      ) => void,
    ) => void
  }
  if (typeof emitter?.on !== "function") return
  emitter.on("agent_tool_start", (_c, a, t) => {
    const name = t?.name ?? a?.name
    if (name && (SLOW_TOOLS as readonly string[]).includes(name)) {
      // fire-and-forget: typing is a UX reflex, never blocks the tool execute.
      void ctx.transport.typing()
    }
  })
}

/**
 * Post-run delivery decision (Wave B's run loop calls this).
 *
 * If the agent produced prose AND no delivery tool already handled this turn
 * (tapback / no_reply marks `deliveredViaTool`), send the prose as a text bubble.
 * `deliveredViaTool` is tracked by the run loop from the tool calls observed.
 */
export async function deliverFinalText(
  ctx: ClaireToolContext,
  finalText: string,
  deliveredViaTool = false,
): Promise<boolean> {
  const out = String(finalText ?? "").trim()
  if (!out || deliveredViaTool) return false
  await ctx.transport.sendText(out)
  return true
}
