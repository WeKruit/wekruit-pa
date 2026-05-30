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
import { normalizeReply } from "./guardrails.js"

/** Slow tools that should trigger the typing reflex. */
export const SLOW_TOOLS = ["find_match", "match_collab", "cv_parse"] as const

/**
 * Hard cap on bubbles per turn — a runaway `messages` array can never flood the thread. Overflow
 * is MERGED into the last bubble (never dropped), so content is preserved, just compacted.
 */
const MAX_BUBBLES = 4

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

/**
 * Deliver the agent's structured reply as N iMessage bubbles — ONE Sendblue send per element, in
 * order. This is the SDK-native multi-bubble path (the agent's `outputType.messages` array): the
 * agent emits ALL bubbles in ONE response, and we POST each. It REPLACES the old "send each bubble
 * via a tool" approach, whose `send_status_then_continue` loop spammed "one sec" and timed out (the
 * 2026-05-30 kickoff bug): a status/filler tool is NOT a message-sender, and calling it never ends
 * the turn, so the model looped until claire_run_timeout → "hiccupped" fallback.
 *
 * Each bubble is normalized (markdown strip + length cap) independently. Bubbles beyond MAX_BUBBLES
 * are merged into the last. Returns the count actually sent (0 when a delivery TOOL already handled
 * the turn — tapback/no_reply — or the array is empty).
 */
export async function deliverBubbles(
  ctx: ClaireToolContext,
  messages: readonly string[],
  deliveredViaTool = false,
): Promise<number> {
  if (deliveredViaTool) return 0
  const clean = (Array.isArray(messages) ? messages : [])
    .map((m) => normalizeReply(String(m ?? "")).trim())
    .filter(Boolean)
  if (clean.length === 0) return 0
  const bubbles =
    clean.length > MAX_BUBBLES
      ? [...clean.slice(0, MAX_BUBBLES - 1), clean.slice(MAX_BUBBLES - 1).join(" ")]
      : clean
  for (const b of bubbles) {
    await ctx.transport.sendText(b)
  }
  return bubbles.length
}
