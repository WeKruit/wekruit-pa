import OpenAI from "openai"
import { runOpenAITurn, runWithOpenAI } from "./openai-provider.js"
import { assertProviderKey } from "./env.js"
import type { AgentTurnContext, RunAgentTurnResult } from "./types.js"

/**
 * One assistant turn: OpenAI / Azure OpenAI.
 */
export async function runAgentTurn(ctx: AgentTurnContext, openAIClient?: OpenAI): Promise<RunAgentTurnResult> {
  const { agent } = ctx
  assertProviderKey(agent.provider)
  if (agent.provider === "openai" || agent.provider === "other") {
    return runOpenAITurn(ctx, openAIClient)
  }
  if (agent.provider === "azure_openai") {
    const client =
      openAIClient ||
      new OpenAI({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        baseURL: process.env.AZURE_OPENAI_BASE_URL,
        defaultQuery: { "api-version": process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview" },
      })
    return runOpenAITurn(ctx, client)
  }
  if (agent.provider === "anthropic") {
    throw new Error("Anthropic adapter not implemented; use provider openai or azure_openai")
  }
  throw new Error(`Unsupported provider: ${agent.provider}`)
}
