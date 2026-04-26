import type OpenAI from "openai"
import type { ChatMessage } from "@pa/core-types"

/**
 * Build chat completion messages.
 * - **Transcript** = recent `pa_messages` as `history` (Firestore is durable storage; the worker passes them in).
 * - **memoryBlock** = Mem0-derived “Relevant memory” (only when the agent’s `memoryMode` is `mem0` or `both` and Mem0 succeeds).
 * - Mode `firestore_only` never supplies a `memoryBlock`.
 */
/**
 * Strip a leading `[YYYY-MM-DDTHH:MM:SS(.sss)?Z]` timestamp marker that the
 * model may have echoed from prior history formatting. Defensive: cleans up
 * any past contamination already persisted in `pa_messages`.
 */
export function stripLeadingIsoTimestamp(text: string): string {
  return text.replace(/^\s*\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\]\s*/, "")
}

export function toOpenAIMessages(
  systemPrompt: string,
  memoryBlock: string | null,
  history: Pick<ChatMessage, "role" | "body">[] | Pick<ChatMessage, "role" | "body" | "createdAt">[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const memoryGuidance =
    "You may use the visible recent transcript and relevant memory below as your conversation memory. Do not claim you lack conversation history when the needed answer is present there."
  const outputStyle =
    "Reply ONLY with the message body the user should see. Never prefix replies with timestamps, dates, system tags, or bracketed metadata. Never echo formatting from prior turns; the user's chat client renders timing separately."
  const system = memoryBlock
    ? `${systemPrompt}\n\n${memoryGuidance}\n\n${outputStyle}\n\n---\nRelevant memory:\n${memoryBlock}`
    : `${systemPrompt}\n\n${memoryGuidance}\n\n${outputStyle}`
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: system }]
  for (const m of history) {
    // Always pass clean message bodies. Strip any [ISO] prefix that earlier
    // versions of this builder accidentally taught the model to echo and may
    // have persisted into pa_messages.
    const content = stripLeadingIsoTimestamp(m.body)
    if (m.role === "user") out.push({ role: "user", content })
    else if (m.role === "assistant") out.push({ role: "assistant", content })
  }
  return out
}
