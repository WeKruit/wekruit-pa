import { Agent, run, setDefaultOpenAIKey, setOpenAIAPI } from "@openai/agents"
import type { ChatMessage } from "@pa/core-types"
import { resolveOpenAICompatConfig } from "./openai-provider.js"
import type { AgentTurnContext, RunAgentTurnResult } from "./types.js"

function configureOpenAICompatEnv(ctx: AgentTurnContext) {
  const config = resolveOpenAICompatConfig(ctx.agent)
  if (config.apiKey) setDefaultOpenAIKey(config.apiKey)
  if (config.baseURL) process.env.OPENAI_BASE_URL = config.baseURL
  setOpenAIAPI("chat_completions")
}

function transcriptLine(message: Pick<ChatMessage, "role" | "body" | "createdAt">) {
  return `[${message.createdAt}] ${message.role}: ${message.body}`
}

export function buildAgentsInput(ctx: AgentTurnContext): string {
  const history = ctx.history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map(transcriptLine)
  const parts = [
    ctx.memoryBlock ? `Memory context:\n${ctx.memoryBlock}` : "",
    history.length ? `Recent transcript:\n${history.join("\n")}` : "",
    `Latest user message:\n${ctx.userMessage}`,
  ].filter(Boolean)
  return parts.join("\n\n")
}

export async function runOpenAIAgentsTurn(ctx: AgentTurnContext): Promise<RunAgentTurnResult> {
  configureOpenAICompatEnv(ctx)
  const agent = new Agent({
    name: ctx.agent.name || ctx.agent.id,
    instructions: ctx.systemPrompt,
    model: ctx.agent.model,
    modelSettings: {
      temperature: ctx.agent.temperature,
      maxTokens: ctx.agent.maxTokens,
      toolChoice: "none",
    },
  })
  const result = await run(agent, buildAgentsInput(ctx))
  return { text: String(result.finalOutput ?? "").trim() }
}
