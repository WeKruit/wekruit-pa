import type OpenAI from "openai"
import type { ChatMessage } from "@pa/core-types"

/**
 * Build chat completion messages.
 * - **Transcript** = recent `pa_messages` as `history` (Firestore is durable storage; the worker passes them in).
 * - **memoryBlock** = Mem0-derived “Relevant memory” (only when the agent’s `memoryMode` is `mem0` or `both` and Mem0 succeeds).
 * - Mode `firestore_only` never supplies a `memoryBlock`.
 */
export function toOpenAIMessages(
  systemPrompt: string,
  memoryBlock: string | null,
  history: Pick<ChatMessage, "role" | "body">[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const system = memoryBlock
    ? `${systemPrompt}\n\n---\nRelevant memory:\n${memoryBlock}`
    : systemPrompt
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: system }]
  for (const m of history) {
    if (m.role === "user") out.push({ role: "user", content: m.body })
    else if (m.role === "assistant") out.push({ role: "assistant", content: m.body })
  }
  return out
}
