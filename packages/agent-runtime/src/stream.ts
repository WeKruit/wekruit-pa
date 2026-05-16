import type { AgentTurnContext, AgentTurnStreamChunk } from "./types.js"
import { streamOpenAIChatCompletions } from "./openai-stream-provider.js"
import { assertProviderKey } from "./env.js"

/**
 * Mutable provider table — mirrors the `runners` pattern in `run.ts`. ESM
 * namespace objects are frozen, so we can't mock `streamOpenAIChatCompletions`
 * directly with `node:test`'s `mock.method`. A plain object whose method is
 * looked up at call-time gives us a mutable seam.
 */
const providers: {
  chatCompletionsStream: (
    ctx: AgentTurnContext
  ) => AsyncGenerator<AgentTurnStreamChunk, void, void>
} = {
  chatCompletionsStream: streamOpenAIChatCompletions,
}

/**
 * v2.1 S1A — streaming variant of `runAgentTurn`.
 *
 * Yields `AgentTurnStreamChunk`s token-by-token as the upstream provider
 * emits them. Signature is intentionally minimal so the S1C LLM shim and
 * the S2 LiveKit voice bridge can consume it without coupling to provider
 * internals.
 *
 * SIGNATURE LOCK (S1A commit 1): downstream sprints (S1C, S2) mock against
 * this exact signature. Changing the public shape after lock requires P10
 * sign-off.
 *
 * Feature flag: `PA_AGENT_RUNTIME_STREAM_ENABLED`. When unset or not exactly
 * the literal string `"true"`, the generator throws
 * `Error("PA_AGENT_RUNTIME_STREAM_ENABLED=false")` on first `.next()` so
 * import sites can detect the kill-switch. Default OFF until S1C + S2 are
 * integrated.
 *
 * Provider: OpenAI Chat Completions streaming
 * (`client.chat.completions.create({ stream: true })`). See AGENT_PLAN.md
 * for rationale (provider-neutral chunk shape, simplest stable streaming
 * API in OpenAI SDK v4, matches what S1C must proxy as OpenAI SSE).
 */
export async function* runAgentTurnStream(
  ctx: AgentTurnContext
): AsyncGenerator<AgentTurnStreamChunk, void, void> {
  if (process.env.PA_AGENT_RUNTIME_STREAM_ENABLED !== "true") {
    throw new Error("PA_AGENT_RUNTIME_STREAM_ENABLED=false")
  }

  assertProviderKey(ctx.agent.provider)

  yield* providers.chatCompletionsStream(ctx)
}

/**
 * Test-only seam — DO NOT call from production. Lets `stream.test.ts` swap
 * the provider and restore it, working around frozen ESM namespaces.
 */
export const __forTesting = {
  override(overrides: Partial<typeof providers>) {
    Object.assign(providers, overrides)
  },
  reset() {
    providers.chatCompletionsStream = streamOpenAIChatCompletions
  },
}
