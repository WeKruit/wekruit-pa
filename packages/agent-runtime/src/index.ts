import type { AgentDef } from "@pa/core-types"
import OpenAI from "openai"
import { runWithOpenAI } from "./openai-provider.js"
import { toOpenAIMessages } from "./messages.js"
import { assertProviderKey } from "./env.js"
import type { ChatMessage } from "@pa/core-types"

export { runWithOpenAI, runOpenAITurn } from "./openai-provider.js"
export { toOpenAIMessages, stripLeadingIsoTimestamp } from "./messages.js"
export { assertProviderKey, hasOpenAICompatKey } from "./env.js"
export type { AgentTurnContext, RunAgentTurnResult } from "./types.js"
export { runAgentTurn } from "./run.js"
export { buildAgentsInput, runOpenAIAgentsTurn } from "./openai-agents-adapter.js"
export { runOpenAIAgentsCurrentInfo } from "./current-info.js"
export type { CurrentInfoCitation, CurrentInfoSearchInput, CurrentInfoSearchResult } from "./current-info.js"
export { hydrateOpenAiFromAtm, getAtmBearerToken } from "./atm-llm-runtime.js"
export { FirestoreSession } from "./firestore-session.js"
export type { FirestoreSessionDeps } from "./firestore-session.js"

export function toOpenAIMessageList(
  systemPrompt: string,
  memoryBlock: string | null,
  history: Pick<ChatMessage, "role" | "body">[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return toOpenAIMessages(systemPrompt, memoryBlock, history)
}

/**
 * @deprecated use runAgentTurn
 */
export async function runWithProvider(
  agent: AgentDef,
  params: { messages: OpenAI.Chat.ChatCompletionMessageParam[]; signal?: AbortSignal }
) {
  if (agent.provider === "openai" || agent.provider === "other") {
    return runWithOpenAI(agent, params)
  }
  if (agent.provider === "azure_openai") {
    return runWithOpenAI(
      agent,
      params,
      new OpenAI({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        baseURL: process.env.AZURE_OPENAI_BASE_URL,
        defaultQuery: { "api-version": process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview" },
      })
    )
  }
  if (agent.provider === "anthropic") {
    throw new Error("Anthropic provider: not implemented")
  }
  return runWithOpenAI(agent, params)
}
