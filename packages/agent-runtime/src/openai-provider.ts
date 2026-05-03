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

// Adam iter 19 — memoize+wrap with prefix-cache. Previously each agent turn
// constructed a fresh OpenAI client (line 47 of pre-fix). With the prefix
// cache wrap, the client must persist across turns so the LRU keeps warm
// entries — a fresh client every turn = fresh cache every turn = 0% hit rate.
//
// Memoize per (apiKey, baseURL) pair; production has 1-2 distinct providers
// (OpenAI default, occasional SiliconFlow). Cache wrapping is opt-out via
// PA_PREFIX_CACHE_DISABLED=true so we can rollback without redeploying.
import { wrapWithPrefixCache } from "./prefix-cache/index.js"
import type { CachedChatClient, ChatClient } from "./prefix-cache/types.js"

const memoizedClients = new Map<string, OpenAI | CachedChatClient>()

const defaultClient = (agent: Pick<AgentDef, "provider">) => {
  const config = resolveOpenAICompatConfig(agent)
  const key = `${config.apiKey}|${config.baseURL ?? ""}`
  const cached = memoizedClients.get(key)
  if (cached) return cached as OpenAI
  const raw = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  })
  if (process.env.PA_PREFIX_CACHE_DISABLED === "true") {
    memoizedClients.set(key, raw)
    return raw
  }
  // Wrap. Cast at boundary: OpenAI's ChatCompletionMessageParam is a stricter
  // discriminated union than prefix-cache's lighter ChatMessage shape; the
  // wrapper only forwards the request body unchanged so casting is safe.
  const wrapped = wrapWithPrefixCache(raw as unknown as ChatClient, {
    capacity: 50,
  }) as unknown as OpenAI
  memoizedClients.set(key, wrapped)
  return wrapped
}

/**
 * Test-only — reset memoized clients between tests so each test gets a
 * fresh prefix-cache. Production code must not call this.
 */
export function _resetMemoizedClientsForTesting(): void {
  memoizedClients.clear()
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
  const history = (ctx.history ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, body: m.body, createdAt: m.createdAt }))
  const messages = toOpenAIMessages(ctx.systemPrompt, ctx.memoryBlock ?? null, [
    ...history,
    { role: "user" as const, body: ctx.userMessage },
  ])
  return runWithOpenAI(ctx.agent, { messages, signal: ctx.signal }, client)
}
