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
  history: Pick<ChatMessage, "role" | "body">[] | Pick<ChatMessage, "role" | "body" | "createdAt">[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const memoryGuidance =
    "You may use the visible recent transcript and relevant memory below as your conversation memory. Do not claim you lack conversation history when the needed answer is present there."
  const system = memoryBlock
    ? `${systemPrompt}\n\n${memoryGuidance}\n\n---\nRelevant memory:\n${memoryBlock}`
    : `${systemPrompt}\n\n${memoryGuidance}`
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: system }]
  for (const m of history) {
    const createdAt = "createdAt" in m ? m.createdAt : undefined
    const content = createdAt ? `[${createdAt}] ${m.body}` : m.body
    if (m.role === "user") out.push({ role: "user", content })
    else if (m.role === "assistant") out.push({ role: "assistant", content })
  }
  return out
}
