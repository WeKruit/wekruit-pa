/**
 * v2.2 W1 — Direct in-process LLM bridge.
 *
 * Replaces the openai.LLM(base_url=$WEKRUIT_LLM_SHIM_URL) HTTP shim path
 * with a direct wrapper around `runAgentTurnStream`. Same brain, zero HTTP
 * boundary, one fewer process to operate.
 *
 * Principle — 共用大脑 / zero rebuild:
 *   - `runAgentTurnStream` is the brain. This file WRAPS it. Do NOT
 *     re-implement OpenAI streaming, agent selection, or message composition.
 *   - ChatContext → AgentTurnContext mapping mirrors the shim's
 *     orchestrator-backend.ts (systemPrompt + history + userMessage) so the
 *     voice path and the SMS path see identical inputs.
 *
 * The class extends LiveKit's `abstract class LLM` + `abstract class
 * LLMStream`. The base `LLMStream` runs `run()` inside a retry-aware
 * mainTask and forwards `this.queue` → `this.output`; the consumer
 * (AgentSession) iterates `output`. We push `ChatChunk` shapes onto `queue`
 * and let the base class drive lifecycle.
 */

import {
  llm,
  DEFAULT_API_CONNECT_OPTIONS,
  type APIConnectOptions,
} from "@livekit/agents"
import {
  runAgentTurnStream,
  type AgentTurnContext,
  type AgentTurnStreamChunk,
  type RunAgentTurnUsage,
} from "@pa/agent-runtime"
import type { AgentDef, ChatMessage as PaChatMessage } from "@pa/core-types"
import { randomUUID } from "node:crypto"

export interface WekruitLLMOptions {
  /** Override the AgentDef passed to runAgentTurnStream. */
  agent?: AgentDef
  /** Override the model on the default AgentDef. Ignored when `agent` is set. */
  model?: string
  /** Used when LK ChatContext has no leading system message. */
  systemPromptFallback?: string
  /** Test seam — swap the runtime entrypoint. Production should leave unset. */
  __runAgentTurnStream?: typeof runAgentTurnStream
}

const DEFAULT_SYSTEM_PROMPT =
  "You are WeKruit's voice prescreen assistant. Be concise, warm, and stay on the prescreen plan."
const DEFAULT_MODEL = "gpt-4o-mini"
const LABEL = "wekruit"
const PROVIDER = "wekruit-orchestrator"

export function makeDefaultVoiceAgent(model?: string): AgentDef {
  return {
    id: "voice-direct",
    name: "voice-direct",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    provider: "openai",
    model: model ?? DEFAULT_MODEL,
    temperature: 0.7,
    version: "1",
    memoryMode: "firestore_only",
    toolPolicy: "none",
  } as AgentDef
}

export class WekruitLLM extends llm.LLM {
  readonly opts: WekruitLLMOptions
  constructor(opts: WekruitLLMOptions = {}) {
    super()
    this.opts = opts
  }
  label(): string {
    return LABEL
  }
  get model(): string {
    return this.opts.agent?.model ?? this.opts.model ?? DEFAULT_MODEL
  }
  get provider(): string {
    return PROVIDER
  }
  chat(args: {
    chatCtx: llm.ChatContext
    toolCtx?: unknown
    connOptions?: APIConnectOptions
    parallelToolCalls?: boolean
    toolChoice?: unknown
    extraKwargs?: Record<string, unknown>
  }): llm.LLMStream {
    return new WekruitLLMStream(
      this,
      args.chatCtx,
      this.opts,
      args.connOptions,
    )
  }
}

export class WekruitLLMStream extends llm.LLMStream {
  private readonly streamOpts: WekruitLLMOptions
  constructor(
    parent: WekruitLLM,
    chatCtx: llm.ChatContext,
    streamOpts: WekruitLLMOptions,
    connOptions?: APIConnectOptions,
  ) {
    super(parent, {
      chatCtx,
      connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    })
    this.streamOpts = streamOpts
  }

  protected async run(): Promise<void> {
    const agent =
      this.streamOpts.agent ?? makeDefaultVoiceAgent(this.streamOpts.model)
    const fallback =
      this.streamOpts.systemPromptFallback ?? DEFAULT_SYSTEM_PROMPT
    const ctx = mapChatCtxToAgentTurnContext(this.chatCtx, agent, fallback)
    const streamFn =
      this.streamOpts.__runAgentTurnStream ?? runAgentTurnStream

    const streamId = randomUUID()
    let finalUsage: RunAgentTurnUsage | undefined

    for await (const chunk of streamFn(
      ctx,
    ) as AsyncIterable<AgentTurnStreamChunk>) {
      if (this.abortController.signal.aborted) return
      if (chunk.usage) finalUsage = chunk.usage
      if (chunk.delta) {
        this.queue.put({
          id: streamId,
          delta: { role: "assistant", content: chunk.delta },
        })
      }
      if (
        chunk.finishReason === "stop" ||
        chunk.finishReason === "length" ||
        chunk.finishReason === "error"
      ) {
        emitFinalUsageChunk(this.queue, streamId, finalUsage)
        return
      }
    }
    emitFinalUsageChunk(this.queue, streamId, finalUsage)
  }
}

function emitFinalUsageChunk(
  queue: WekruitLLMStream["queue"],
  streamId: string,
  finalUsage: RunAgentTurnUsage | undefined,
): void {
  if (!finalUsage) return
  queue.put({
    id: streamId,
    delta: { role: "assistant", content: "" },
    usage: {
      promptTokens:
        finalUsage.promptTokens ?? finalUsage.inputTokens ?? 0,
      completionTokens:
        finalUsage.completionTokens ?? finalUsage.outputTokens ?? 0,
      promptCachedTokens: 0,
      totalTokens: finalUsage.totalTokens ?? 0,
    },
  })
}

/**
 * Convert LK ChatContext.items into the AgentTurnContext triple
 * (systemPrompt + history + userMessage).
 *
 * Rules — mirrors apps/voice-llm-shim/src/runtime/orchestrator-backend.ts:
 *   - Leading system/developer messages → joined with "\n\n" → systemPrompt.
 *     None present → systemPromptFallback.
 *   - LAST user message → userMessage.
 *   - Everything between the leading system block and the final user message
 *     → history (user + assistant only). Function calls / tool outputs /
 *     handoffs / config updates are dropped — agent-runtime owns its own
 *     tooling and the voice path doesn't emit them.
 */
export function mapChatCtxToAgentTurnContext(
  chatCtx: llm.ChatContext,
  agent: AgentDef,
  systemPromptFallback: string,
): AgentTurnContext {
  const items = chatCtx.items ?? []

  let i = 0
  const systemTexts: string[] = []
  while (i < items.length) {
    const msg = asChatMessage(items[i])
    if (msg && (msg.role === "system" || msg.role === "developer")) {
      const t = msg.textContent ?? ""
      if (t) systemTexts.push(t)
      i++
      continue
    }
    break
  }
  const systemPrompt =
    systemTexts.length > 0 ? systemTexts.join("\n\n") : systemPromptFallback

  let lastUserIdx = -1
  for (let k = items.length - 1; k >= i; k--) {
    const msg = asChatMessage(items[k])
    if (msg && msg.role === "user") {
      lastUserIdx = k
      break
    }
  }
  const userMessage =
    lastUserIdx >= 0
      ? (asChatMessage(items[lastUserIdx])?.textContent ?? "")
      : ""

  const historyEnd = lastUserIdx === -1 ? items.length : lastUserIdx
  const history: PaChatMessage[] = []
  for (let k = i; k < historyEnd; k++) {
    const msg = asChatMessage(items[k])
    if (!msg) continue
    if (msg.role === "system" || msg.role === "developer") continue
    const role: PaChatMessage["role"] =
      msg.role === "assistant" ? "assistant" : "user"
    const body = msg.textContent ?? ""
    if (!body) continue
    history.push({
      id: `voice-history-${k}`,
      sessionId: "voice-direct",
      userId: "voice-direct",
      role,
      body,
      createdAt: new Date(0).toISOString(),
    })
  }

  return { agent, systemPrompt, userMessage, history }
}

function asChatMessage(item: unknown): llm.ChatMessage | undefined {
  if (
    typeof item === "object" &&
    item !== null &&
    (item as { type?: unknown }).type === "message"
  ) {
    return item as llm.ChatMessage
  }
  return undefined
}
