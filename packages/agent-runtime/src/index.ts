import type { AgentDef } from "@pa/core-types"
import OpenAI from "openai"
import { runWithOpenAI } from "./openai-provider.js"
import { toOpenAIMessages } from "./messages.js"
import { assertProviderKey } from "./env.js"
import type { ChatMessage } from "@pa/core-types"

export { runWithOpenAI, runOpenAITurn } from "./openai-provider.js"
export { toOpenAIMessages, stripLeadingIsoTimestamp } from "./messages.js"
export { assertProviderKey, hasOpenAICompatKey } from "./env.js"
export type {
  AgentInputGuardrailSpec,
  AgentTurnContext,
  AgentTurnTool,
  RunAgentTurnResult,
  RunAgentTurnUsage,
  AgentTurnStreamChunk,
} from "./types.js"
export { runAgentTurn } from "./run.js"
// v2.1 S1A — additive streaming export. Behind PA_AGENT_RUNTIME_STREAM_ENABLED.
export { runAgentTurnStream } from "./stream.js"
export { buildAgentsInput, runOpenAIAgentsTurn } from "./openai-agents-adapter.js"
export { hydrateOpenAiFromAtm, getAtmBearerToken } from "./atm-llm-runtime.js"
export { FirestoreSession, deriveSessionMessageIdempotencyKey } from "./firestore-session.js"
export type { FirestoreSessionDeps } from "./firestore-session.js"
export type {
  AgentInputItem,
  InputGuardrail as AgentsSdkInputGuardrail,
  OutputGuardrail as AgentsSdkOutputGuardrail,
  Session as AgentsSdkSession,
} from "@openai/agents"
export type AgentsSdkModule = typeof import("@openai/agents")
export type AgentsSdkAgent = AgentsSdkModule["Agent"]
export type AgentsSdkInputGuardrailTripwireTriggered =
  AgentsSdkModule["InputGuardrailTripwireTriggered"]
export type AgentsSdkMemorySession = AgentsSdkModule["MemorySession"]
export type AgentsSdkRun = AgentsSdkModule["run"]
export type AgentsSdkTool = AgentsSdkModule["tool"]
export type AgentsSdkZod = typeof import("zod").z
// Adam iter 19 — prefix-cache moved here from pa-orchestrator/voice/prefix-cache
// so the main LLM call path (`runWithOpenAI` in openai-provider.ts) can wrap
// its OpenAI client with the cache. Previously only the small rewriter LLM
// benefited; main agent turns hit raw OpenAI. Single source of truth.
export {
  wrapWithPrefixCache,
  getPrefixCacheStats,
  defaultIsPrefixMessage,
  _resetPrefixCache,
} from "./prefix-cache/index.js"
export type {
  CachedChatClient,
  CachedChatCompletion,
  ChatClient,
  ChatCompletionRequest,
  ChatMessage as PrefixCacheChatMessage,
  PrefixCacheGlobalStats,
  PrefixCacheOpts,
  PrefixCacheStats,
} from "./prefix-cache/types.js"

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
