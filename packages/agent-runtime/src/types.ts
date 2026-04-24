import type { AgentDef, ChatMessage } from "@pa/core-types"

export type AgentTurnContext = {
  agent: AgentDef
  systemPrompt: string
  memoryBlock: string | null
  /** Recent transcript (newest last), excluding the latest user line if you pass it separately */
  history: ChatMessage[]
  userMessage: string
  signal?: AbortSignal
}

export type RunAgentTurnResult = {
  text: string
  usage?: { promptTokens?: number; completionTokens?: number }
}
