/**
 * compaction.ts — long-context handling (reuse existing mem0 compaction).
 *
 * Not covered by the POCs but required for production long conversations. Reuses the
 * existing mem0 compaction path rather than a new summarizer. The @openai/agents
 * Session supports compaction-aware items; this hooks the existing compaction into the
 * Claire session so long threads don't blow the context window or drift.
 *
 * WS-proactive (or Wave B) wires this; left a no-op-safe stub for the skeleton.
 */
import type { ClaireToolContext } from "./types.js"

/**
 * Decide + apply compaction for a long session. Returns whether compaction ran.
 * Stub: no-op (returns false). Wiring the real mem0 compaction is a TODO.
 */
export async function maybeCompactSession(_ctx: ClaireToolContext): Promise<boolean> {
  // TODO(WS-proactive/Wave B): reuse mem0 compaction for long-context.
  return false
}
