import type { AgentDef, ChatMessage } from "@pa/core-types"
import type { Session } from "@openai/agents"
import type { z } from "zod"

/**
 * Phase 10.5 T7 — connector→SDK tool bridge contract.
 *
 * The orchestrator owns the binding between WeKruit-side connectors (which
 * go through `runConnector` for audit + safety policy) and the SDK's
 * `tool()` factory. The runtime adapter receives a list of `AgentTurnTool`
 * descriptors and constructs SDK `Tool` instances, keeping firebase-admin
 * out of @pa/agent-runtime.
 *
 * `execute(args)` is invoked by the SDK with parsed JSON args. The bridge
 * implementation MUST go through `runConnector` so audit + policy still
 * fire; this type does not enforce that — the orchestrator helper does.
 *
 * Returned strings are forwarded to the LLM as tool output. Keep them
 * compact (≤ 1 KB).
 */
export type AgentTurnTool = {
  name: string
  description: string
  parameters: z.ZodTypeAny
  execute: (args: unknown) => Promise<string>
}

/**
 * Per-turn context handed to `runAgentTurn`.
 *
 * Phase 10.5:
 *  - Default path: orchestrator passes `session` (FirestoreSession),
 *    `systemInputs` (Mem0 recall + confirmed facts), and `tools` (T7
 *    bridged custom tools). `history`/`memoryBlock` are unused and may
 *    be undefined.
 *  - SiliconFlow fallback path: still uses the legacy `history` +
 *    `memoryBlock` splice via `runOpenAITurn` (chat.completions). Keep
 *    both fields defined on the context until SF is retired.
 *  - Test injection door: when `openAIClient` is passed to `runAgentTurn`,
 *    the chat.completions path runs and consumes `history` + `memoryBlock`.
 */
export type AgentTurnContext = {
  agent: AgentDef
  systemPrompt: string
  /** Mem0/facts memory block — used by chat.completions fallback only. */
  memoryBlock?: string | null
  /** Recent transcript — used by chat.completions fallback only. */
  history?: ChatMessage[]
  userMessage: string
  signal?: AbortSignal
  /** Phase 10.5 T2/T3 — SDK Session for the default Agents SDK path. */
  session?: Session
  /** Phase 10.5 T3 — pre-built `system` AgentInputItem strings prepended each turn. */
  systemInputs?: string[]
  /** Phase 10.5 T7 — custom (non-hosted) tools bridged from runConnector. */
  tools?: AgentTurnTool[]
  /**
   * Optional per-turn tool choice override for constrained routers. Default
   * agent turns leave this unset; specialized routers can force a tool
   * decision without changing the persisted AgentDef schema.
   */
  toolChoice?: "auto" | "required" | "none"
  /**
   * Optional per-turn SDK parallel tool execution override. Matching routers
   * set this false so preference mutation can complete before a dependent
   * find-match call.
   */
  parallelToolCalls?: boolean
}

/**
 * Phase 10.5 T9 — extended `usage` shape so per-turn token + cost logs
 * make it back to `pa_turns.usage`. `provider` and `model` are required
 * on every successful default path; tokens are best-effort (the SDK may
 * not surface them on streaming or partial errors). `hostedToolCalls`
 * is the per-turn breakdown of SDK-hosted tool invocations (e.g.
 * `web_search`) so we can emit the deferred audit row T7 promised.
 *
 * `promptTokens` / `completionTokens` are kept for chat.completions
 * (legacy) callers; the new fields are additive.
 */
export type RunAgentTurnUsage = {
  promptTokens?: number
  completionTokens?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  provider?: "openai" | "siliconflow"
  model?: string
  hostedToolCalls?: { name: string; count: number }[]
}

export type RunAgentTurnResult = {
  text: string
  usage?: RunAgentTurnUsage
}

/**
 * v2.1 S1A — streaming chunk shape for `runAgentTurnStream`.
 *
 * This type is ADDITIVE. `runAgentTurn` and its existing types are frozen
 * (Lock L1 in V21-VOICE-PRESCREEN-GOAL-PROMPT.md). The voice path consumes
 * an async iterator of these chunks via the S1C LLM shim, which forwards
 * them as OpenAI-compatible SSE to the LiveKit `openai.LLM` plugin.
 *
 * Contract:
 *  - `delta` is the incremental token text. Concatenating all `delta`s in
 *    order reproduces the full assistant text byte-identical to what the
 *    non-stream path would have returned in `text`.
 *  - `delta` MAY be the empty string on heartbeat / role-only chunks.
 *  - `finishReason` is present ONLY on the terminal chunk. Intermediate
 *    chunks omit it. `"stop"` = clean finish, `"length"` = max_tokens
 *    truncation, `"error"` = upstream error mid-stream (the generator will
 *    also throw after yielding this terminal error chunk so callers using
 *    `for await` see the error).
 *  - `usage` is best-effort, present only on the terminal chunk when the
 *    provider surfaces stream usage statistics.
 */
export type AgentTurnStreamChunk = {
  delta: string
  finishReason?: "stop" | "length" | "error"
  usage?: RunAgentTurnUsage
}
