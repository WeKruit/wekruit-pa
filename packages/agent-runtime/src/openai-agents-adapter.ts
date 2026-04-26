import {
  Agent,
  run,
  setDefaultOpenAIClient,
  setDefaultOpenAIKey,
  setOpenAIAPI,
} from "@openai/agents"
import OpenAI from "openai"
import type { ChatMessage } from "@pa/core-types"
import { resolveOpenAICompatConfig } from "./openai-provider.js"
import type { AgentTurnContext, RunAgentTurnResult } from "./types.js"

/**
 * Phase 10.5 T1 — Default runtime: OpenAI Responses API + gpt-5.4-nano.
 *
 * Build an explicit `OpenAI` client pinned to `api.openai.com` (or the
 * `PA_OPENAI_AGENT_BASE_URL` override) and pass it via
 * `setDefaultOpenAIClient`. Switch the SDK to `responses` mode.
 *
 * Critically, this MUST NOT mutate `process.env.OPENAI_BASE_URL`. Phase 10
 * bug #3 was caused by env-level baseURL pollution leaking across calls
 * (SiliconFlow set `OPENAI_BASE_URL`, the Agents SDK then POSTed `/responses`
 * to SiliconFlow → 404). The default path is now env-pollution-free.
 */
function configureDefaultOpenAIClient(): void {
  const apiKey =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ""
  const baseURL =
    process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
  // Pin the SDK's default client to the official OpenAI endpoint. The
  // top-level `openai` dep is v4 while @openai/agents-openai bundles v6
  // internally; the runtime shape is compatible — cast through unknown to
  // avoid a v6 bump that would ripple through the rest of the runtime.
  const client = new OpenAI({ apiKey, baseURL }) as unknown as Parameters<
    typeof setDefaultOpenAIClient
  >[0]
  setDefaultOpenAIClient(client)
  setOpenAIAPI("responses")
  if (apiKey) setDefaultOpenAIKey(apiKey)
}

/**
 * Phase 10.5 T1 — SiliconFlow fallback path. Env-gated only via
 * `PA_AGENT_LLM_PROVIDER=siliconflow` or `agent.provider === "siliconflow"`.
 *
 * Snapshot+restore pattern: any process.env mutation MUST be reverted in
 * `finally`, plus the SDK's API mode and default key are restored to the
 * default-OpenAI shape so a subsequent default turn behaves as if the
 * fallback never ran.
 */
async function withSiliconFlowFallback<T>(ctx: AgentTurnContext, fn: () => Promise<T>): Promise<T> {
  const config = resolveOpenAICompatConfig({ ...ctx.agent, provider: "siliconflow" })
  const prevBaseURL = process.env.OPENAI_BASE_URL
  try {
    if (config.apiKey) setDefaultOpenAIKey(config.apiKey)
    if (config.baseURL) process.env.OPENAI_BASE_URL = config.baseURL
    setOpenAIAPI("chat_completions")
    return await fn()
  } finally {
    if (prevBaseURL === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseURL
    // Reset to default-OpenAI shape so next default turn isn't poisoned.
    configureDefaultOpenAIClient()
  }
}

function transcriptLine(message: Pick<ChatMessage, "role" | "body" | "createdAt">) {
  return `[${message.createdAt}] ${message.role}: ${message.body}`
}

/**
 * Transitional safety net: when no `Session` is wired (older callers, unit
 * tests) we still build a single string input. T3 wires `Session` + per-turn
 * `system` AgentInputItems for the production path.
 */
export function buildAgentsInput(ctx: AgentTurnContext): string {
  const history = (ctx.history ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map(transcriptLine)
  const memoryBlock = ctx.memoryBlock ?? null
  const systemInputs = ctx.systemInputs ?? []
  const parts = [
    ...systemInputs.map((s) => s.trim()).filter(Boolean),
    memoryBlock ? `Memory context:\n${memoryBlock}` : "",
    history.length ? `Recent transcript:\n${history.join("\n")}` : "",
    `Latest user message:\n${ctx.userMessage}`,
  ].filter(Boolean)
  return parts.join("\n\n")
}

function resolveModel(ctx: AgentTurnContext): string {
  return (
    ctx.agent.model ||
    process.env.PA_AGENT_MODEL?.trim() ||
    "gpt-5.4-nano"
  )
}

async function runDefaultAgent(ctx: AgentTurnContext): Promise<RunAgentTurnResult> {
  const agent = new Agent({
    name: ctx.agent.name || ctx.agent.id,
    instructions: ctx.systemPrompt,
    model: resolveModel(ctx),
    modelSettings: {
      temperature: ctx.agent.temperature,
      maxTokens: ctx.agent.maxTokens,
      toolChoice: "none",
    },
  })
  const result = await run(agent, buildAgentsInput(ctx))
  return { text: String(result.finalOutput ?? "").trim() }
}

/**
 * Public entry. Routes to the SiliconFlow fallback when explicitly opted in
 * (env or per-agent provider) and otherwise runs the default OpenAI path.
 *
 * T3 will replace `runDefaultAgent` with a Session-aware version. T1 leaves
 * the function signature stable so callers don't change.
 */
export async function runOpenAIAgentsTurn(ctx: AgentTurnContext): Promise<RunAgentTurnResult> {
  const fallbackEnv = process.env.PA_AGENT_LLM_PROVIDER?.trim().toLowerCase() === "siliconflow"
  if (fallbackEnv || ctx.agent.provider === "siliconflow") {
    return withSiliconFlowFallback(ctx, () => runDefaultAgent(ctx))
  }
  configureDefaultOpenAIClient()
  return runDefaultAgent(ctx)
}
