/**
 * P4 — scoped onboarding agent (flag-gated behind `paAgenticOnboardingEnabled`).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mirrors the P3 prescreen-agentic-turn migration AND the already-green
 * `apps/eval/conversation-experience/agent-onboarding-canary.mjs`. When the flag
 * is ON, the shared-onboarding reply handler delegates the current slot turn to
 * a SCOPED agent that:
 *
 *   - composes the natural ask for the CURRENT slot, and
 *   - exposes `record_onboarding_answer({reply})` — the ONLY slot-write path. It
 *     delegates to the caller's `recordAnswer` callback, which routes through the
 *     EXISTING write path (projectSharedOnboardingAnswer + resolveNext +
 *     writeSharedOnboardingAnswer). The deterministic reducer advances the slot
 *     and projects durable tags — the LLM never sets currentQuestionId / skips /
 *     completes.
 *   - exposes a global `explain_context({topic})` for tangents — NO slot advance.
 *
 * HARD CONTRACT: any agent error (SDK load, missing key, run throw) →
 * `{ handled: false }`, so the caller FAILS OPEN to the current deterministic
 * onboarding path byte-for-byte. The reducer stays the controller.
 *
 * The SDK is loaded the repo-canonical way (createRequire("@openai/agents") from
 * a module that has it as a transitive dep + setDefaultOpenAIClient/responses),
 * matching packages/agent-runtime/src/openai-agents-adapter.ts.
 */
import { createRequire } from "node:module"
import type {
  SharedOnboardingQuestionId,
  SharedOnboardingPromptContext,
} from "./shared-onboarding.js"
import { getSharedOnboardingQuestion, buildSharedOnboardingPrompt } from "./shared-onboarding.js"

const require = createRequire(import.meta.url)

/**
 * Structural shape of the bits of `@openai/agents` we touch. We deliberately do
 * NOT `import("@openai/agents")` for types — that module is a transitive RUNTIME
 * dep via @pa/agent-runtime (resolvable at `require` time) but is not a direct
 * type dependency of this package, so a static type import would not typecheck.
 * The agent-runtime adapter owns the fully-typed binding.
 */
type AgentsTool = unknown
type AgentsSdk = {
  tool: (def: {
    name: string
    description: string
    parameters: Record<string, unknown>
    strict?: boolean
    execute: (args: unknown) => Promise<string>
  }) => AgentsTool
  Agent: new (cfg: {
    name: string
    instructions: string
    model?: string
    modelSettings?: Record<string, unknown>
    tools: AgentsTool[]
  }) => unknown
  run: (agent: unknown, input: string) => Promise<unknown>
  setDefaultOpenAIClient: (client: unknown) => void
  setOpenAIAPI: (mode: "responses" | "chat_completions") => void
  setDefaultOpenAIKey: (key: string) => void
}

function loadAgentsSdk(): AgentsSdk {
  // @openai/agents is a transitive dep via @pa/agent-runtime; resolves from the
  // orchestrator node_modules tree at runtime.
  return require("@openai/agents") as AgentsSdk
}

/**
 * Pin the SDK default client to OpenAI Responses, env-pollution-free — same
 * shape as agent-runtime's configureDefaultOpenAIClient. No-op-safe: if the key
 * is absent the agent run throws and we fail open.
 */
function configureDefaultOpenAIClient(sdk: AgentsSdk): boolean {
  const apiKey =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ""
  if (!apiKey) return false
  // openai is loaded from the same transitive tree.
  const OpenAICtor = (require("openai") as { default?: unknown }).default ?? require("openai")
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
  const client = new (OpenAICtor as new (cfg: { apiKey: string; baseURL: string }) => unknown)({
    apiKey,
    baseURL,
  }) as Parameters<AgentsSdk["setDefaultOpenAIClient"]>[0]
  sdk.setDefaultOpenAIClient(client)
  sdk.setOpenAIAPI("responses")
  sdk.setDefaultOpenAIKey(apiKey)
  return true
}

export type AgenticOnboardingTurnArgs = {
  slot: SharedOnboardingQuestionId
  userMessage: string
  promptContext?: SharedOnboardingPromptContext | null
  /**
   * Routes an on-slot answer through the EXISTING deterministic write path
   * (projection + resolveNext + writeSharedOnboardingAnswer). The reducer owns
   * the advance; this callback returns the slot it advanced to (or completion).
   */
  recordAnswer: (reply: string) => Promise<{ advancedTo: SharedOnboardingQuestionId | "__complete__" }>
  /** Global tangent handler — does NOT advance the slot. */
  explainContext?: (topic: string) => Promise<void>
  model?: string
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export type AgenticOnboardingTurnResult =
  | { handled: false; reason: string }
  | {
      handled: true
      recorded: boolean
      explained: boolean
      advancedTo: SharedOnboardingQuestionId | "__complete__" | null
    }

/**
 * Run the scoped onboarding agent for one user reply. Returns `{ handled: false }`
 * on ANY failure so the caller falls open to the deterministic path. When the
 * agent records an answer, the reducer (inside `recordAnswer`) has already
 * advanced the slot + projected tags before this resolves.
 */
export async function runAgenticOnboardingTurn(
  args: AgenticOnboardingTurnArgs,
): Promise<AgenticOnboardingTurnResult> {
  let sdk: AgentsSdk
  try {
    sdk = loadAgentsSdk()
  } catch (err) {
    return { handled: false, reason: `sdk_load_failed:${errText(err)}` }
  }
  if (!configureDefaultOpenAIClient(sdk)) {
    return { handled: false, reason: "no_openai_key" }
  }

  const question = getSharedOnboardingQuestion(args.slot)
  const ask = buildSharedOnboardingPrompt(args.slot, args.promptContext)

  let recorded = false
  let explained = false
  let advancedTo: SharedOnboardingQuestionId | "__complete__" | null = null

  const tools = [
    sdk.tool({
      name: "record_onboarding_answer",
      description:
        "Submit the candidate's reply AS THE ANSWER to the current onboarding question. The deterministic reducer projects it into durable profile tags and advances to the next slot. Call ONLY when the candidate actually answered the current question.",
      parameters: {
        type: "object",
        properties: { reply: { type: "string" } },
        required: ["reply"],
        additionalProperties: false,
      },
      strict: false,
      execute: async (a: unknown) => {
        const reply = String((a as { reply?: unknown })?.reply ?? args.userMessage)
        const res = await args.recordAnswer(reply)
        recorded = true
        advancedTo = res.advancedTo
        return JSON.stringify({ advancedTo: res.advancedTo })
      },
    }),
    sdk.tool({
      name: "explain_context",
      description:
        "Answer an OFF-TOPIC / tangent question from the candidate (NOT an answer to the current onboarding question). Does NOT advance onboarding.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
        additionalProperties: false,
      },
      strict: false,
      execute: async (a: unknown) => {
        const topic = String((a as { topic?: unknown })?.topic ?? "")
        await args.explainContext?.(topic)
        explained = true
        return JSON.stringify({ answered: true, note: "tangent; slot unchanged" })
      },
    }),
  ]

  const instructions = [
    "You are Claire onboarding a new candidate over iMessage.",
    `The current onboarding question (slot "${args.slot}" — ${question.label}) is: "${ask}"`,
    "If the user's message ANSWERS that question, call record_onboarding_answer with their reply verbatim.",
    "If the message is off-topic (a tangent / a question for you), call explain_context with the topic — do NOT record an answer.",
    "Never skip the question. You have no tool to advance, skip, or complete slots; only the reducer does that.",
  ].join(" ")

  try {
    const agent = new sdk.Agent({
      name: "Claire-onboarding",
      instructions,
      ...(args.model ? { model: args.model } : {}),
      modelSettings: { toolChoice: "auto" },
      tools,
    })
    await sdk.run(agent, args.userMessage)
  } catch (err) {
    args.log?.("pa.shared_onboarding.agentic_turn_error", { slot: args.slot, error: errText(err) })
    // If the reducer already advanced (record fired before the throw), the write
    // is durable and the slot moved — treat as handled. Otherwise fail open.
    if (recorded) return { handled: true, recorded, explained, advancedTo }
    return { handled: false, reason: `agent_run_failed:${errText(err)}` }
  }

  if (!recorded && !explained) {
    // Agent declined to act — fall open so the deterministic path runs.
    return { handled: false, reason: "agent_no_tool_call" }
  }
  return { handled: true, recorded, explained, advancedTo }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
