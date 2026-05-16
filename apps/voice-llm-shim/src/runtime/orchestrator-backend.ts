/**
 * v2.1 S2 task #12 — S1A ↔ S1C adapter.
 *
 * S1C declared a narrower contract than what S1A actually ships:
 *
 *   S1C `RunAgentTurnStream` →
 *     (req: { messages: AgentTurnChatMessage[]; model? })
 *       => AsyncIterable<{ delta; finishReason?: "stop"|"length"|null }>
 *
 *   S1A `runAgentTurnStream` →
 *     (ctx: AgentTurnContext) => AsyncGenerator<{ delta; finishReason?:
 *       "stop"|"length"|"error"; usage? }, void, void>
 *
 * This adapter:
 *   1. Maps OpenAI-style `messages[]` → `AgentTurnContext`
 *      (systemPrompt + history + userMessage).
 *   2. Pipes `runAgentTurnStream(ctx)` chunks back through the shim's
 *      contract shape.
 *   3. Collapses `"error"` finishReason → terminal `null` (so the shim
 *      handler emits a graceful SSE close — the `handler.ts` `try/catch`
 *      remains the path for thrown errors).
 *   4. Drops the `usage` field (shim's contract chunk has no usage slot;
 *      S4 telemetry consumes usage separately via session_usage_updated
 *      on the LiveKit side).
 *
 * The adapter never throws — runtime errors are mapped to a terminal
 * `null` chunk and logged via `opts.logger`. This keeps LiveKit's
 * `openai.LLM` plugin from seeing a transport-layer failure when the
 * orchestrator stream errors mid-flight.
 *
 * Flag note: `runAgentTurnStream` itself throws when
 * `PA_AGENT_RUNTIME_STREAM_ENABLED !== "true"`. The adapter does NOT swallow
 * that — it lets the throw propagate out of the for-await so the shim's
 * top-level handler `try/catch` surfaces it as an SSE error event. Callers
 * select between fake / orchestrator at resolver-time (`resolve.ts`); we
 * trust the operator who flips `WEKRUIT_LLM_SHIM_BACKEND=orchestrator` has
 * also set `PA_AGENT_RUNTIME_STREAM_ENABLED=true`.
 */

import { runAgentTurnStream } from "@pa/agent-runtime"
import type { AgentTurnContext } from "@pa/agent-runtime"
import type { AgentDef, ChatMessage } from "@pa/core-types"

import type {
  AgentTurnChatMessage,
  AgentTurnStreamChunk,
  AgentTurnStreamRequest,
  RunAgentTurnStream,
} from "./contract.js"

export type OrchestratorBackendLogger = {
  warn: (msg: string, meta?: Record<string, unknown>) => void
  info: (msg: string, meta?: Record<string, unknown>) => void
}

export interface CreateOrchestratorBackendOpts {
  /**
   * Agent definition passed to `runAgentTurnStream`. The shim is provider-
   * agnostic, but `AgentTurnContext.agent` is required for provider-key
   * assertion inside the runtime. Defaults to a minimal OpenAI agent named
   * `voice-shim` — callers wanting a different system prompt should pass a
   * full `AgentDef` here.
   */
  agent?: AgentDef
  /**
   * Used when the incoming `messages[]` does not contain a system message.
   * Defaults to a neutral string so `runAgentTurnStream` never sees an
   * empty system prompt.
   */
  systemPromptFallback?: string
  logger?: OrchestratorBackendLogger
  /**
   * Test-only seam — override the runtime entrypoint so tests can avoid
   * importing the real `@pa/agent-runtime` providers. Production callers
   * should NEVER set this.
   */
  __runAgentTurnStream?: typeof runAgentTurnStream
}

const defaultLogger: OrchestratorBackendLogger = {
  warn: (m, meta) => console.warn(`[voice-llm-shim:orchestrator] ${m}`, meta ?? ""),
  info: (m, meta) => console.log(`[voice-llm-shim:orchestrator] ${m}`, meta ?? ""),
}

const defaultSystemPrompt =
  "You are WeKruit's voice prescreen assistant. Be concise, warm, and stay on the prescreen plan."

function makeDefaultAgent(model: string | undefined): AgentDef {
  // Minimum-viable AgentDef — `AgentDefSchema` requires id/name/systemPrompt/
  // provider/model. We do NOT call the Zod parser here; `runAgentTurnStream`
  // accepts the struct directly. Defaults match the shim's
  // `WEKRUIT_LLM_SHIM_MODEL` envelope.
  return {
    id: "voice-shim",
    name: "voice-shim",
    systemPrompt: defaultSystemPrompt,
    provider: "openai",
    model: model ?? "gpt-4o-mini",
    temperature: 0.7,
    version: "1",
    memoryMode: "firestore_only",
    toolPolicy: "none",
  } as AgentDef
}

/**
 * Convert OpenAI Chat Completions `messages[]` into the {systemPrompt,
 * history, userMessage} triple `AgentTurnContext` expects.
 *
 *   - Leading system messages → joined with `\n\n` → `systemPrompt`.
 *     Missing system message → `systemPromptFallback`.
 *   - Last `role === "user"` message → `userMessage`.
 *   - Everything between (after first user-or-assistant turn, excluding the
 *     final user) → `history` as ChatMessage[].
 *   - `role === "tool"` is mapped to ChatMessage role `"assistant"` so the
 *     fallback chat.completions path can still see the content (the SDK
 *     path won't replay tool messages, but the shim's voice path doesn't
 *     emit them anyway).
 */
export function mapMessagesToAgentTurnContext(
  messages: AgentTurnChatMessage[],
  agent: AgentDef,
  systemPromptFallback: string
): AgentTurnContext {
  if (messages.length === 0) {
    return {
      agent,
      systemPrompt: systemPromptFallback,
      userMessage: "",
      history: [],
    }
  }

  // 1. Pull all leading system messages.
  const systemTexts: string[] = []
  let i = 0
  while (i < messages.length && messages[i].role === "system") {
    systemTexts.push(messages[i].content ?? "")
    i++
  }
  const systemPrompt =
    systemTexts.length > 0 ? systemTexts.join("\n\n") : systemPromptFallback

  // 2. Find the last user message — this is `userMessage`.
  let lastUserIdx = -1
  for (let k = messages.length - 1; k >= 0; k--) {
    if (messages[k].role === "user") {
      lastUserIdx = k
      break
    }
  }
  const userMessage =
    lastUserIdx >= 0 ? messages[lastUserIdx].content ?? "" : ""

  // 3. Anything between (inclusive of i, exclusive of lastUserIdx) becomes
  // history. If `lastUserIdx === -1`, the entire post-system slice is history.
  const historyEnd = lastUserIdx === -1 ? messages.length : lastUserIdx
  const history: ChatMessage[] = []
  for (let k = i; k < historyEnd; k++) {
    const m = messages[k]
    if (m.role === "system") continue // stray inline system → skip
    const role: ChatMessage["role"] =
      m.role === "assistant"
        ? "assistant"
        : m.role === "user"
          ? "user"
          : // tool / function / other → treat as assistant text so it stays in
            // the transcript context but doesn't claim the user slot.
            "assistant"
    history.push({
      // `ChatMessage` requires `id`, `sessionId`, `userId`, `role`, `body`,
      // `createdAt`. The shim has no real session/user identity (room
      // metadata-driven identity lives in the voice-agent worker, not here),
      // so we use stable synthetic placeholders. Downstream `runAgentTurn`
      // never persists these; they only feed the OpenAI messages array.
      id: `shim-history-${k}`,
      sessionId: "voice-shim",
      userId: "voice-shim",
      role,
      body: m.content ?? "",
      createdAt: new Date(0).toISOString(),
    })
  }

  return {
    agent,
    systemPrompt,
    userMessage,
    history,
  }
}

export function createOrchestratorBackend(
  opts?: CreateOrchestratorBackendOpts
): RunAgentTurnStream {
  const logger = opts?.logger ?? defaultLogger
  const systemPromptFallback = opts?.systemPromptFallback ?? defaultSystemPrompt
  const streamFn = opts?.__runAgentTurnStream ?? runAgentTurnStream

  return async function* orchestratorStream(
    req: AgentTurnStreamRequest
  ): AsyncIterable<AgentTurnStreamChunk> {
    const agent = opts?.agent ?? makeDefaultAgent(req.model)
    const ctx = mapMessagesToAgentTurnContext(
      req.messages ?? [],
      agent,
      systemPromptFallback
    )

    let sawTerminal = false
    try {
      for await (const chunk of streamFn(ctx)) {
        const fr = chunk.finishReason
        if (fr === "error") {
          // Map to terminal-null and warn. We intentionally do NOT yield
          // additional chunks after the terminal — the shim handler treats
          // a missing terminal as `"stop"` and writes a graceful SSE close.
          sawTerminal = true
          logger.warn("upstream finishReason=error; emitting graceful close", {
            delta: chunk.delta ?? "",
          })
          if (chunk.delta) {
            yield { delta: chunk.delta, finishReason: null }
          }
          yield { delta: "", finishReason: null }
          return
        }

        // "stop" | "length" | undefined → forward as-is (with `null` →
        // `undefined` collapsed where appropriate).
        if (fr === "stop" || fr === "length") {
          sawTerminal = true
          yield { delta: chunk.delta ?? "", finishReason: fr }
          return
        }

        // Mid-stream chunk.
        yield { delta: chunk.delta ?? "", finishReason: null }
      }
    } catch (err) {
      // Stream threw (e.g. flag disabled). Let it propagate so the shim's
      // top-level handler `try/catch` records the OpenAI-shaped error event.
      logger.warn("upstream runAgentTurnStream threw; rethrowing for shim handler", {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    // Provider closed the generator without an explicit terminal. Emit a
    // synthetic "stop" so the shim handler doesn't have to guess.
    if (!sawTerminal) {
      yield { delta: "", finishReason: "stop" }
    }
  }
}
