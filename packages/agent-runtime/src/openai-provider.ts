import type { AgentDef } from "@pa/core-types"
import OpenAI from "openai"
import { toOpenAIMessages } from "./messages.js"
import type { AgentTurnContext, RunAgentTurnResult } from "./types.js"

export type OpenAICompatConfig = {
  apiKey: string
  baseURL?: string
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}

export function resolveOpenAICompatConfig(agent: Pick<AgentDef, "provider">): OpenAICompatConfig {
  if (agent.provider === "deepseek") {
    return {
      apiKey: process.env.DEEPSEEK_API_KEY || "",
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
    }
  }
  if (agent.provider === "siliconflow") {
    return {
      apiKey: process.env.SILICONFLOW_API_KEY || "",
      baseURL: process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1",
    }
  }
  if (process.env.LITELLM_BASE_URL) {
    return {
      apiKey: process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || "",
      baseURL: process.env.LITELLM_BASE_URL,
    }
  }
  if (process.env.OPENROUTER_BASE_URL) {
    return {
      apiKey: process.env.OPENROUTER_API_KEY || "",
      baseURL: process.env.OPENROUTER_BASE_URL,
    }
  }
  return {
    apiKey: process.env.OPENAI_API_KEY || "",
    baseURL: nonEmpty(process.env.OPENAI_BASE_URL),
  }
}

const defaultClient = (agent: Pick<AgentDef, "provider">) => {
  const config = resolveOpenAICompatConfig(agent)
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  })
}

export async function runWithOpenAI(
  agent: AgentDef,
  params: { messages: OpenAI.Chat.ChatCompletionMessageParam[]; signal?: AbortSignal },
  client: OpenAI = defaultClient(agent)
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
    .map((m) => ({ role: m.role, body: m.body, createdAt: m.createdAt }))
  const messages = toOpenAIMessages(ctx.systemPrompt, ctx.memoryBlock, [
    ...history,
    { role: "user" as const, body: ctx.userMessage },
  ])
  return runWithOpenAI(ctx.agent, { messages, signal: ctx.signal }, client)
}
