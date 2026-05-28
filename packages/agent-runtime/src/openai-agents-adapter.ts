import { createRequire } from "node:module"
import type { AgentInputItem } from "@openai/agents"
import OpenAI from "openai"
import type { ChatMessage } from "@pa/core-types"
import { resolveOpenAICompatConfig } from "./openai-provider.js"
import type {
  AgentInputGuardrailSpec,
  AgentTurnContext,
  AgentTurnTool,
  RunAgentTurnResult,
  RunAgentTurnUsage,
} from "./types.js"

type AgentsSdk = typeof import("@openai/agents")
type AgentsTool = ReturnType<AgentsSdk["tool"]>
type HostedTool = ReturnType<AgentsSdk["webSearchTool"]>
const require = createRequire(import.meta.url)

function loadAgentsSdk(): AgentsSdk {
  return require("@openai/agents") as AgentsSdk
}

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
 *
 * Exported under `__forTesting` ONLY for the T10 regression test; production
 * callers should use `runOpenAIAgentsTurn`.
 */
function configureDefaultOpenAIClient(): void {
  const { setDefaultOpenAIClient, setDefaultOpenAIKey, setOpenAIAPI } = loadAgentsSdk()
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
 *
 * KNOWN GAP — SF fallback is current-info-degraded by design.
 * `webSearchTool` is a Responses-API-only hosted tool; it CANNOT be
 * attached on this chat_completions path against a non-OpenAI baseURL
 * (defense-in-depth in `buildHostedToolsForDefault`). Pre-T5 the
 * orchestrator routed current-info-shaped queries through a regex
 * pre-router into `runCurrentInfoConnector`; T5 deleted that path AND
 * the Phase 10.5 cleanup pass removed `runCurrentInfoConnector` +
 * `current-info` connector entirely. As a result, SF fallback users
 * asking "最近 X" receive raw model-knowledge replies — accepted by
 * P10 as reduced functionality on the kill-switch path. See
 * `.planning/phases/10.5-agents-sdk-runtime-cutover/10.5-VERIFICATION.md`
 * carry-over #2 ("accepted; SF fallback is degraded by design").
 */
async function withSiliconFlowFallback<T>(ctx: AgentTurnContext, fn: () => Promise<T>): Promise<T> {
  const { setDefaultOpenAIKey, setOpenAIAPI } = loadAgentsSdk()
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

/**
 * Phase 10.5 T3 — build the per-turn AgentInputItem[] that the SDK sees on
 * the default path:
 *
 *   [ ...systemInputs as SystemMessageItem, { role: "user", content: ... } ]
 *
 * Prior conversation history is injected by the Session adapter, NOT by us.
 * Mem0 recall + confirmed Firestore facts ride `systemInputs` so they’re
 * fresh every turn (Mem0 is recall, not transcript — A5/A7 separation).
 */
export function buildAgentsInputItems(ctx: AgentTurnContext): AgentInputItem[] {
  const items: AgentInputItem[] = []
  for (const raw of ctx.systemInputs ?? []) {
    const text = (raw ?? "").trim()
    if (!text) continue
    items.push({ type: "message", role: "system", content: text } as AgentInputItem)
  }
  items.push({ type: "message", role: "user", content: ctx.userMessage } as AgentInputItem)
  return items
}

/**
 * Phase 10.5 T7 — bridge `AgentTurnTool[]` → SDK `Tool[]`.
 *
 * The orchestrator constructs `AgentTurnTool` descriptors that already
 * route through `runConnector` (audit + safety policy live there). The
 * adapter's job is the SDK side only: wrap each descriptor in `tool()`
 * with a forced-string return shape so the LLM gets a stable JSON-stringified
 * payload back.
 */
function buildSdkTools(ctx: AgentTurnContext): AgentsTool[] {
  const { tool } = loadAgentsSdk()
  const turnTools = ctx.tools ?? []
  return turnTools.map((t: AgentTurnTool) =>
    tool({
      name: t.name,
      description: t.description,
      // The SDK accepts a Zod object schema directly under the strict
      // tool path. Cast through `any` to avoid the SDK's deeply
      // generic `ToolInputParametersStrict` discrimination — runtime
      // shape is what matters here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: t.parameters as any,
      execute: async (args: unknown) => {
        const result = await t.execute(args)
        return result
      },
    })
  )
}

/**
 * Phase 10.5 T9 — extract per-turn token usage and SDK-hosted tool counts
 * from a completed `RunResult`. Best-effort: if the SDK shape changes or a
 * field is missing we return zero/empty rather than throwing.
 */
function extractUsage(
  result: { rawResponses?: ReadonlyArray<unknown> },
  provider: "openai" | "siliconflow",
  model: string
): RunAgentTurnUsage {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  const hostedCounts = new Map<string, number>()

  for (const raw of result.rawResponses ?? []) {
    const r = raw as
      | {
          usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
          output?: ReadonlyArray<{
            type?: string
            name?: string
            providerData?: { type?: string }
          }>
        }
      | undefined
    if (!r) continue
    const u = r.usage
    if (u) {
      if (typeof u.inputTokens === "number") inputTokens += u.inputTokens
      if (typeof u.outputTokens === "number") outputTokens += u.outputTokens
      if (typeof u.totalTokens === "number") totalTokens += u.totalTokens
    }
    for (const item of r.output ?? []) {
      const t = item?.type
      if (typeof t !== "string") continue
      // Phase 10.5 cleanup C1 — the live SDK shape is the normalized
      // `hosted_tool_call` with `name: "web_search"`. The OpenAI Responses
      // adapter converts the wire-level `web_search_call` items into
      // `{ type: "hosted_tool_call", name: "web_search", providerData: {
      // type: "web_search_call", ... } }` (see
      // @openai/agents-openai/dist/openaiResponsesModel `web_search_call`
      // → `hosted_tool_call` translation). The previous code only matched
      // the wire-level `web_search_call` literal; production rawResponses
      // never carry that, so `hostedToolCalls` was never populated and
      // `recordHostedToolCalls` never fired (10.5-VERIFICATION carry-over #3).
      //
      // Match all three observable shapes to be defensive:
      //   - normalized hosted_tool_call with name === "web_search"
      //   - the wire-level web_search_call literal (older SDK or stripped
      //     responses surfacing through providerData passthrough)
      //   - the bare "web_search" literal (defensive — observed in some
      //     non-Responses transports)
      // SDK inverse-transform sets `name = item.type` from the API output
      // (see @openai/agents-openai/dist/openaiResponsesModel `type:
      // 'hosted_tool_call'` branches). For web_search the wire `item.type`
      // is `web_search_call`, so the normalized SDK item carries
      // `name: "web_search_call"` — NOT `"web_search"`. Earlier C1 attempt
      // matched the registration name, never the call-time name.
      if (
        (t === "hosted_tool_call" &&
          (item?.name === "web_search_call" || item?.name === "web_search")) ||
        t === "web_search_call" ||
        t === "web_search"
      ) {
        hostedCounts.set("web_search", (hostedCounts.get("web_search") ?? 0) + 1)
      }
    }
  }

  const usage: RunAgentTurnUsage = {
    provider,
    model,
  }
  if (inputTokens > 0) usage.inputTokens = inputTokens
  if (outputTokens > 0) usage.outputTokens = outputTokens
  if (totalTokens > 0) usage.totalTokens = totalTokens
  if (hostedCounts.size > 0) {
    usage.hostedToolCalls = [...hostedCounts.entries()].map(([name, count]) => ({ name, count }))
  }
  return usage
}


/**
 * Phase 10.5 T4 — attach SDK hosted `webSearchTool` to the default Agent.
 *
 * Three-way gate (all must be true to attach):
 *   1. provider === "openai" — the SDK-hosted `web_search` tool only works
 *      against `api.openai.com` Responses API. Under the SiliconFlow
 *      fallback path the SDK is in `chat_completions` mode against a
 *      non-OpenAI base URL; attaching `webSearchTool` there yields a 404
 *      or unsupported-tool error. Defense in depth — the env-isolated
 *      `current-info` connector still serves the boundary on fallback.
 *   2. agent.toolPolicy === "allowlist" — pa-safety + the agent record
 *      jointly govern tool access. `none` means "no tools, period".
 *   3. agent.allowedConnectors includes "current-info" — the WeKruit-side
 *      identity for live-web access. The SDK tool name is `web_search`
 *      (mandated by the SDK). The bridge in T7/T9 logs hosted invocations
 *      against `connectorName: "current-info"` to preserve audit
 *      continuity.
 *
 * Returns an empty array when any gate fails; the caller treats that as
 * "no hosted tools this turn".
 */
function buildHostedToolsForDefault(
  ctx: AgentTurnContext,
  provider: "openai" | "siliconflow"
): HostedTool[] {
  const { webSearchTool } = loadAgentsSdk()
  if (provider !== "openai") return []
  if (ctx.agent.toolPolicy !== "allowlist") return []
  const connectors = ctx.agent.allowedConnectors ?? []
  if (!connectors.includes("current-info")) return []
  // Phase 10.5 cleanup C4 — pin searchContextSize: "low" for input-token
  // cost ceiling on the default-Agent path. Default is "medium" per SDK;
  // P10 wants "low" because the 8633-input-token signature on live
  // current-info turns is dominated by web_search context injection.
  return [webSearchTool({ searchContextSize: "low" })]
}

function buildModelSettings(ctx: AgentTurnContext, hasTools: boolean) {
  return {
    temperature: ctx.agent.temperature,
    maxTokens: ctx.agent.maxTokens,
    // Default agent's toolPolicy still drives whether tools are wired here.
    // When no tools are passed in, force the model away from tool-choice.
    // Constrained routers can override to "required" per turn.
    toolChoice: hasTools ? ctx.toolChoice ?? "auto" : "none",
    ...(ctx.parallelToolCalls !== undefined
      ? { parallelToolCalls: ctx.parallelToolCalls }
      : {}),
  }
}

/**
 * P8 — adapt the orchestrator's input safety guardrail specs to the SDK
 * `inputGuardrail` shape. `runInParallel: false` is REQUIRED for safety: the
 * guardrail must complete (and can halt the turn) BEFORE the model is invoked —
 * it must never race the LLM. A tripwire makes the SDK throw
 * `InputGuardrailTripwireTriggered`, which `runDefaultAgent` catches and
 * surfaces as `result.tripwire`. Returns `[]` when the caller passes none —
 * which the SDK treats as a no-op (byte-identical to omitting the field), so
 * every existing caller is unaffected.
 */
function buildInputGuardrails(ctx: AgentTurnContext): unknown[] {
  const specs = ctx.inputGuardrails ?? []
  return specs.map((spec: AgentInputGuardrailSpec) => ({
    name: spec.name,
    runInParallel: false,
    execute: async (args: { input?: unknown }) => {
      const raw = args?.input
      const input = typeof raw === "string" ? raw : ctx.userMessage
      const out = await spec.execute(input)
      return {
        tripwireTriggered: Boolean(out?.tripwireTriggered),
        outputInfo: out?.outputInfo ?? null,
      }
    },
  }))
}

/**
 * P8 — detect the SDK's input-guardrail tripwire on a thrown error and map it to
 * our `tripwire` shape. Returns null for any other error (caller rethrows).
 * Robust to the SDK class not being `instanceof`-comparable across the
 * dual-package boundary — matches by constructor name too.
 */
function mapTripwire(err: unknown): { name: string; outputInfo?: unknown } | null {
  const e = err as {
    name?: string
    constructor?: { name?: string }
    result?: { guardrail?: { name?: string }; output?: { outputInfo?: unknown } }
  }
  const isTripwire =
    e?.constructor?.name === "InputGuardrailTripwireTriggered" ||
    e?.name === "InputGuardrailTripwireTriggered"
  if (!isTripwire) return null
  return {
    name: e?.result?.guardrail?.name ?? "input_guardrail",
    outputInfo: e?.result?.output?.outputInfo ?? null,
  }
}

async function runDefaultAgent(
  ctx: AgentTurnContext,
  provider: "openai" | "siliconflow"
): Promise<RunAgentTurnResult> {
  const { Agent, run } = loadAgentsSdk()
  const hostedTools = buildHostedToolsForDefault(ctx, provider)
  const customSdkTools = buildSdkTools(ctx)
  // Hosted tools (e.g. webSearchTool) come first — the SDK accepts the
  // mixed array as `tools`. Custom (T7-bridged) tools follow.
  const sdkTools = [...hostedTools, ...customSdkTools]
  const hasTools = sdkTools.length > 0
  const model = resolveModel(ctx)
  const inputGuardrails = buildInputGuardrails(ctx)
  const agent = new Agent({
    name: ctx.agent.name || ctx.agent.id,
    instructions: ctx.systemPrompt,
    model,
    modelSettings: buildModelSettings(ctx, hasTools),
    tools: sdkTools,
    // P8 — SDK-native safety tripwires (crisis / prompt-injection /
    // privacy-stop). Empty array is a no-op, so callers that pass no
    // guardrails see byte-identical behavior. Cast mirrors the tool-params
    // cast above (the SDK's deeply-generic guardrail type vs our plain shape).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputGuardrails: inputGuardrails as any,
  })
  try {
    const sdkResult = ctx.session
      ? await run(agent, buildAgentsInputItems(ctx), { session: ctx.session })
      : await run(agent, buildAgentsInput(ctx))
    const text = String((sdkResult as { finalOutput?: unknown }).finalOutput ?? "").trim()
    const usage = extractUsage(
      sdkResult as { rawResponses?: ReadonlyArray<unknown> },
      provider,
      model
    )
    return { text, usage }
  } catch (err) {
    const tripwire = mapTripwire(err)
    if (tripwire) {
      // A safety guardrail halted the turn BEFORE the model produced output.
      // Surface the tripwire so the caller emits the safe canned reply.
      return { text: "", usage: { provider, model }, tripwire }
    }
    throw err
  }
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
    return withSiliconFlowFallback(ctx, () => runDefaultAgent(ctx, "siliconflow"))
  }
  configureDefaultOpenAIClient()
  return runDefaultAgent(ctx, "openai")
}

/**
 * Phase 10.5 T10 test-only seam. Exported so the baseURL pollution
 * regression test can directly observe the default-client and fallback
 * behaviours without needing a live `run()` invocation. NOT for
 * production callers.
 */
export const __forTesting = {
  configureDefaultOpenAIClient,
  withSiliconFlowFallback,
  extractUsage,
  buildHostedToolsForDefault,
  buildModelSettings,
  buildInputGuardrails,
  mapTripwire,
}
