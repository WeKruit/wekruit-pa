import OpenAI from "openai"
import { runOpenAITurn } from "./openai-provider.js"
import { runOpenAIAgentsTurn } from "./openai-agents-adapter.js"
import { assertProviderKey } from "./env.js"
import type { AgentTurnContext, RunAgentTurnResult } from "./types.js"

/**
 * Mutable runner table. Tests swap entries via `__forTesting` below.
 * ESM namespace objects are frozen by the spec, so we cannot stub
 * `runOpenAITurn` / `runOpenAIAgentsTurn` directly with `node:test`'s
 * `mock.method`. A plain object whose methods are looked up at call-time
 * gives us a mutable seam without leaking test-only behaviour into
 * production callers.
 */
const runners: {
  chatCompletions: typeof runOpenAITurn
  agentsSdk: typeof runOpenAIAgentsTurn
} = {
  chatCompletions: runOpenAITurn,
  agentsSdk: runOpenAIAgentsTurn,
}

/**
 * One assistant turn. Phase 10.5 T1: the default path now runs through the
 * OpenAI Agents SDK against `api.openai.com` with the Responses API
 * (`gpt-5.4-nano`). The legacy `chat.completions` path stays accessible:
 *
 * - test injection: callers passing an explicit `openAIClient` keep using
 *   `runOpenAITurn` so unit tests can stub the OpenAI v4 client directly.
 * - emergency rollback: `PA_AGENT_RUNTIME=chat_completions` forces the
 *   pre-Agents-SDK path back on without redeploying code.
 *
 * SiliconFlow becomes an env-gated fallback owned by the Agents SDK adapter
 * (see `withSiliconFlowFallback`); we no longer route it through
 * `runOpenAITurn` by default.
 */
export async function runAgentTurn(ctx: AgentTurnContext, openAIClient?: OpenAI): Promise<RunAgentTurnResult> {
  const { agent } = ctx
  assertProviderKey(agent.provider)

  // Test injection door: explicit client → original chat.completions path.
  if (openAIClient) {
    return runners.chatCompletions(ctx, openAIClient)
  }

  // Emergency rollback flag.
  if (process.env.PA_AGENT_RUNTIME?.trim() === "chat_completions") {
    return runners.chatCompletions(ctx)
  }

  if (agent.provider === "azure_openai") {
    const client = new OpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      baseURL: process.env.AZURE_OPENAI_BASE_URL,
      defaultQuery: { "api-version": process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview" },
    })
    return runners.chatCompletions(ctx, client)
  }
  if (agent.provider === "anthropic") {
    throw new Error("Anthropic adapter not implemented; use provider openai or azure_openai")
  }

  // Default path for openai / siliconflow / deepseek / other → Agents SDK.
  // The adapter chooses between OpenAI (default) and SiliconFlow (fallback)
  // based on `PA_AGENT_LLM_PROVIDER` and `agent.provider`.
  return runners.agentsSdk(ctx)
}

/**
 * Test-only seam — DO NOT call from production. Lets `run.test.ts` swap the
 * dispatch targets and restore them, working around frozen ESM namespaces.
 */
export const __forTesting = {
  override(overrides: Partial<typeof runners>) {
    Object.assign(runners, overrides)
  },
  reset() {
    runners.chatCompletions = runOpenAITurn
    runners.agentsSdk = runOpenAIAgentsTurn
  },
}
