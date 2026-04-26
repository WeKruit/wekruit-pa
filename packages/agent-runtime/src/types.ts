import type { AgentDef, ChatMessage } from "@pa/core-types"
import type { Session } from "@openai/agents"

/**
 * Per-turn context handed to `runAgentTurn`.
 *
 * Phase 10.5:
 *  - Default path: orchestrator passes `session` (FirestoreSession) and
 *    `systemInputs` (Mem0 recall + confirmed facts). `history`/`memoryBlock`
 *    are unused and may be undefined.
 *  - SiliconFlow fallback path: still uses the legacy `history` + `memoryBlock`
 *    splice via `runOpenAITurn` (chat.completions). Keep both fields defined
 *    on the context until SF is retired.
 *  - Test injection door: when `openAIClient` is passed to `runAgentTurn`,
 *    the chat.completions path runs and consumes `history` + `memoryBlock`.
 */
export type AgentTurnContext = {
  agent: AgentDef
  systemPrompt: string
  /** Mem0/facts memory block — used by chat.completions fallback only. */
  memoryBlock?: string | null
  /** Recent transcript — used by chat.completions fallback only. */
  history?: ChatMessage[]
  userMessage: string
  signal?: AbortSignal
  /** Phase 10.5 T2/T3 — SDK Session for the default Agents SDK path. */
  session?: Session
  /** Phase 10.5 T3 — pre-built `system` AgentInputItem strings prepended each turn. */
  systemInputs?: string[]
}

export type RunAgentTurnResult = {
  text: string
  usage?: { promptTokens?: number; completionTokens?: number }
}
