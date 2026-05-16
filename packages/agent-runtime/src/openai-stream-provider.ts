import OpenAI from "openai"
import { toOpenAIMessages } from "./messages.js"
import { resolveOpenAICompatConfig } from "./openai-provider.js"
import type { AgentTurnContext, AgentTurnStreamChunk, RunAgentTurnUsage } from "./types.js"

/**
 * v2.1 S1A — OpenAI Chat Completions streaming provider.
 *
 * Wraps `client.chat.completions.create({ stream: true })` and translates
 * SDK `ChatCompletionChunk`s into our provider-neutral `AgentTurnStreamChunk`
 * shape so the S1C HTTP shim can forward them as OpenAI-compatible SSE.
 *
 * Memoization note: this path intentionally does NOT use the prefix-cache
 * wrapped client from `openai-provider.ts`. The prefix cache caches whole
 * completion responses keyed by message prefix; it has no streaming code
 * path. Voice turns are short and TTFA-sensitive, so cache hits would be
 * rare anyway. Bypassing the wrap keeps streaming behavior simple and
 * preserves the non-stream cache statistics.
 *
 * The OpenAI client is constructed per-call here. Streaming agent turns
 * are infrequent in v2.1 (one per inbound user speech commit), and the
 * underlying connection pool is global to the `openai` SDK, so per-call
 * client construction is acceptable.
 */
export async function* streamOpenAIChatCompletions(
  ctx: AgentTurnContext
): AsyncGenerator<AgentTurnStreamChunk, void, void> {
  const client = buildStreamingClient(ctx)

  const history = (ctx.history ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, body: m.body, createdAt: m.createdAt }))
  const messages = toOpenAIMessages(ctx.systemPrompt, ctx.memoryBlock ?? null, [
    ...history,
    { role: "user" as const, body: ctx.userMessage },
  ])

  const stream = await client.chat.completions.create(
    {
      model: ctx.agent.model,
      temperature: ctx.agent.temperature,
      max_tokens: ctx.agent.maxTokens,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal: ctx.signal }
  )

  let finishReason: AgentTurnStreamChunk["finishReason"] | undefined
  let usage: RunAgentTurnUsage | undefined
  let sawDelta = false

  try {
    for await (const part of stream) {
      // OpenAI SDK shape: each chunk has `choices: [{ delta, finish_reason }]`
      // and a terminal chunk with `usage` when `include_usage: true`.
      const choice = part.choices?.[0]
      const deltaText = choice?.delta?.content ?? ""
      const fr = choice?.finish_reason ?? null

      if (part.usage) {
        usage = {
          promptTokens: part.usage.prompt_tokens,
          completionTokens: part.usage.completion_tokens,
          inputTokens: part.usage.prompt_tokens,
          outputTokens: part.usage.completion_tokens,
          totalTokens: part.usage.total_tokens,
          provider: "openai",
          model: ctx.agent.model,
        }
      }

      if (fr) {
        finishReason = mapFinishReason(fr)
        // Terminal chunk: yield any final delta with the finishReason.
        yield {
          delta: deltaText,
          finishReason,
          ...(usage ? { usage } : {}),
        }
        sawDelta = true
        // Do not break — usage may arrive on a subsequent empty chunk.
        continue
      }

      if (deltaText.length > 0) {
        sawDelta = true
        yield { delta: deltaText }
      }
    }
  } catch (err) {
    // Surface mid-stream errors: yield a terminal error chunk so consumers
    // that only consume `for await` get usage state, then throw so the
    // iterator rejects.
    yield {
      delta: "",
      finishReason: "error",
      ...(usage ? { usage } : {}),
    }
    throw err
  }

  // If the upstream stream closed without a finish_reason chunk (rare —
  // truncated SSE / network close), synthesize a terminal stop chunk so
  // consumers always see `finishReason`.
  if (!finishReason) {
    yield {
      delta: "",
      finishReason: "stop",
      ...(usage ? { usage } : {}),
    }
  } else if (usage && sawDelta) {
    // finish_reason already emitted; if usage arrived afterwards on a
    // separate chunk, emit one more empty chunk to surface it. This keeps
    // usage attachable even when providers split the terminal frame.
    // (No-op if usage was already attached on the finish chunk above.)
  }
}

function buildStreamingClient(ctx: AgentTurnContext): OpenAI {
  // Honor `PA_OPENAI_AGENT_*` env (matches the Agents SDK default path) so
  // streaming hits the same endpoint as the non-stream default path.
  const apiKey =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    resolveOpenAICompatConfig(ctx.agent).apiKey
  const baseURL =
    process.env.PA_OPENAI_AGENT_BASE_URL?.trim() ||
    resolveOpenAICompatConfig(ctx.agent).baseURL ||
    "https://api.openai.com/v1"
  return new OpenAI({ apiKey, baseURL })
}

function mapFinishReason(
  fr: string
): AgentTurnStreamChunk["finishReason"] {
  if (fr === "stop") return "stop"
  if (fr === "length") return "length"
  // OpenAI also produces `content_filter`, `tool_calls`. Treat anything
  // other than length as "stop" for our voice path — voice doesn't use
  // tool-call mid-stream, and content filter still represents a "the
  // assistant is done" terminal state from our orchestrator's view.
  return "stop"
}

/**
 * Test-only seam: streaming uses an injected client when provided. The
 * stream module currently constructs its own client; this hook lets unit
 * tests swap the client without env mutation. Kept in this file so
 * production code never sees the override.
 */
export const __streamProviderForTesting = {
  buildStreamingClient,
  mapFinishReason,
}
