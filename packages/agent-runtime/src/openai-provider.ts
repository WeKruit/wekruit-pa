import type { AgentDef } from "@pa/core-types"
import OpenAI from "openai"
import { toOpenAIMessages } from "./messages.js"
import type { AgentTurnContext, RunAgentTurnResult } from "./types.js"

function openAICompatKey(): string {
  return (
    process.env.OPENAI_API_KEY ||
    process.env.LITELLM_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    ""
  )
}

function openAICompatBaseURL(): string | undefined {
  const b =
    process.env.OPENAI_BASE_URL ||
    process.env.LITELLM_BASE_URL ||
    process.env.OPENROUTER_BASE_URL
  return b && b.length > 0 ? b : undefined
}

const defaultClient = () =>
  new OpenAI({
    apiKey: openAICompatKey(),
    baseURL: openAICompatBaseURL(),
  })

export async function runWithOpenAI(
  agent: AgentDef,
  params: { messages: OpenAI.Chat.ChatCompletionMessageParam[]; signal?: AbortSignal },
  client: OpenAI = defaultClient()
): Promise<RunAgentTurnResult> {
  const r = await client.chat.completions.create(
    {
      model: agent.model,
      temperature: agent.temperature,
      max_tokens: agent.maxTokens,
      messages: params.messages,
    },
    { signal: params.signal }
  )
  const text = r.choices[0]?.message?.content?.trim() || ""
  return {
    text,
    usage: {
      promptTokens: r.usage?.prompt_tokens,
      completionTokens: r.usage?.completion_tokens,
    },
  }
}

export async function runOpenAITurn(ctx: AgentTurnContext, client?: OpenAI): Promise<RunAgentTurnResult> {
  const history = ctx.history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, body: m.body }))
  const messages = toOpenAIMessages(ctx.systemPrompt, ctx.memoryBlock, [
    ...history,
    { role: "user" as const, body: ctx.userMessage },
  ])
  return runWithOpenAI(ctx.agent, { messages, signal: ctx.signal }, client)
}
