/**
 * P3 — Scoped prescreen agent (flag `paAgenticPrescreenEnabled`, default OFF).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * When the flag is ON, `runPrescreenTurnIfActive` delegates the per-turn ASK +
 * reply-routing to this scoped agent INSTEAD of the deterministic templated
 * question-ask. The hard architectural invariant (proven by the real-LLM canary
 * apps/eval/conversation-experience/agent-prescreen-canary.mjs) is preserved:
 *
 *   - the REDUCER stays the controller. The agent's ONLY FSM-write path is the
 *     `record_prescreen_answer` tool, which delegates to the caller-supplied
 *     `runTurn` (the real PreScreenPipeline.runTurn — it scores, advances qOrder,
 *     and owns the terminal). The LLM has NO tool to set currentQId / terminal /
 *     skip qOrder, so by construction it cannot skip a question or end the
 *     interview;
 *   - a TANGENT is routed to the GLOBAL `explain_prescreen_context` tool, which
 *     performs NO FSM mutation — the pending question is HELD and re-asked.
 *
 * The TERMINAL commit stays OUTSIDE this toolset: this module never finalizes a
 * session or sends the terminal SMS — it only returns the captured reducer
 * `RunTurnResult` (when the reply was recorded) back to the handler, which keeps
 * the existing terminal-commit + idempotency-key path byte-for-byte.
 *
 * On ANY agent error → the caller FAILS OPEN to the deterministic path.
 */
import { createRequire } from "node:module"
import OpenAI from "openai"
import type { PreScreenState } from "@pa/pa-orchestrator"
import { getFlag } from "@pa/pa-persistence"
import type { Firestore } from "firebase-admin/firestore"

// Mirror of the slice of PreScreenPipeline.runTurn's result the handler needs.
export type AgenticRunTurnResult = {
  text: string
  action: { kind: string; terminal?: string; reason?: string } & Record<string, unknown>
  state: PreScreenState
}

export type AgenticPrescreenTurnInput = {
  /** Latest candidate message. */
  replyText: string
  lang: "en" | "zh"
  /** The active question's natural-language prompt (already resolved per lang). */
  questionPrompt: string
  /**
   * Delegate to the real PreScreenPipeline.runTurn. The reducer scores +
   * advances + may terminate. The agent calls this via record_prescreen_answer.
   */
  runTurn: (reply: string) => Promise<AgenticRunTurnResult>
  log?: (event: string, payload: Record<string, unknown>) => void
  /** Test-only: inject a fake SDK to drive the tool loop deterministically. */
  __loadSdk?: () => AgentsSdk
}

export type AgenticPrescreenTurnOutput =
  | {
      /** The reply was an on-question answer → reducer ran. */
      routed: "answered"
      result: AgenticRunTurnResult
    }
  | {
      /** The reply was a tangent → pending question HELD; send this + re-ask. */
      routed: "tangent"
      tangentText: string
    }

/** Flag read — mirrors isConnectorNarrationEnabled. Default OFF; fail-closed. */
export async function isAgenticPrescreenEnabled(
  db: Firestore | undefined,
  userId: string
): Promise<boolean> {
  if (process.env.PA_AGENTIC_PRESCREEN_DISABLED === "true") return false
  if (!db) return false
  try {
    return (await getFlag(db, "paAgenticPrescreenEnabled", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

// `@openai/agents` is NOT a direct dep of @pa/functions; it is resolved at
// runtime from @pa/agent-runtime (the same createRequire trick the repo uses).
// Typed loosely here so functions needs no static @openai/agents type dep.
type AgentTool = unknown
interface AgentsSdk {
  setDefaultOpenAIClient(client: unknown): void
  setOpenAIAPI(api: string): void
  setDefaultOpenAIKey(key: string): void
  tool(spec: {
    name: string
    description: string
    parameters: unknown
    strict?: boolean
    execute: (args: unknown) => Promise<string>
  }): AgentTool
  Agent: new (opts: {
    name: string
    instructions: string
    model: string
    modelSettings?: Record<string, unknown>
    tools: AgentTool[]
  }) => unknown
  run(agent: unknown, input: string): Promise<unknown>
}

/**
 * Build the SDK the way the repo does (createRequire("@openai/agents") resolved
 * from packages/agent-runtime; configure the default OpenAI client + responses
 * mode). Kept local so this module has no hard dep on agent-runtime internals.
 */
function loadConfiguredSdk(): AgentsSdk {
  const req = createRequire(require.resolve("@pa/agent-runtime/package.json"))
  const sdk = req("@openai/agents") as AgentsSdk
  const apiKey =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ""
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
  const client = new OpenAI({ apiKey, baseURL })
  sdk.setDefaultOpenAIClient(client)
  sdk.setOpenAIAPI("responses")
  if (apiKey) sdk.setDefaultOpenAIKey(apiKey)
  return sdk
}

/**
 * Run one scoped prescreen turn through the agent. Reuses the exact tool
 * contract from the canary. THROWS on any SDK/LLM failure so the caller can
 * fail open to the deterministic path.
 */
export async function runAgenticPrescreenTurn(
  input: AgenticPrescreenTurnInput
): Promise<AgenticPrescreenTurnOutput> {
  const log = input.log ?? (() => {})
  const sdk = input.__loadSdk ? input.__loadSdk() : loadConfiguredSdk()
  const model = process.env.PA_AGENT_MODEL?.trim() || "gpt-5.4-nano"

  // Boxed so the tool closures' mutations are visible to TS after the run()
  // (a bare `let` would be control-flow-narrowed to `null`).
  const box: { recorded: AgenticRunTurnResult | null; tangentTopic: string | null } = {
    recorded: null,
    tangentTopic: null,
  }

  const tools = [
    sdk.tool({
      name: "record_prescreen_answer",
      description:
        "Submit the candidate's reply AS THE ANSWER to the current pre-screen question. The pre-screen reducer scores it and advances to the next question (or ends). Call this ONLY when the candidate actually answered the current question.",
      parameters: {
        type: "object",
        properties: { reply: { type: "string" } },
        required: ["reply"],
        additionalProperties: false,
      },
      strict: false,
      execute: async (a: unknown) => {
        // Record-once per human turn (keystone integrity). The SDK loop
        // (toolChoice:"auto") can emit this tool call more than once, but
        // `runTurn` is the real PreScreenPipeline reducer — it SCORES and
        // ADVANCES qOrder each call. A 2nd call would advance past the next
        // question and score it against text the candidate never sent
        // (skip/fabricate). The FSM must advance at most once per turn, so
        // ignore any extra calls and echo the already-recorded action.
        if (box.recorded) {
          return JSON.stringify({
            action: box.recorded.action.kind,
            note: "already_recorded_this_turn",
          })
        }
        const reply = String((a as { reply?: unknown })?.reply ?? input.replyText)
        box.recorded = await input.runTurn(reply)
        return JSON.stringify({ action: box.recorded.action.kind })
      },
    }),
    sdk.tool({
      name: "explain_prescreen_context",
      description:
        "Answer an OFF-TOPIC / tangent question from the candidate (e.g. about a past interview, the company, or anything that is NOT an answer to the current pre-screen question). This does NOT advance the interview.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
        additionalProperties: false,
      },
      strict: false,
      execute: async (a: unknown) => {
        box.tangentTopic = String((a as { topic?: unknown })?.topic ?? "your question")
        return JSON.stringify({ answered: true, note: "tangent answered; pending question unchanged" })
      },
    }),
  ]

  const langLine =
    input.lang === "zh"
      ? "Reply in natural Mandarin (Claire's voice)."
      : "Reply in natural English (Claire's voice)."
  const instructions = [
    "You are Claire conducting a job pre-screen over iMessage.",
    `The current pre-screen question is: "${input.questionPrompt}".`,
    "If the candidate's latest message ANSWERS that question, call record_prescreen_answer with their reply verbatim.",
    "If it is off-topic (a tangent), call explain_prescreen_context with a short topic label; then briefly answer it and re-ask the current question. Never skip the question and never declare the interview done.",
    langLine,
  ].join(" ")

  const agent = new sdk.Agent({
    name: "Claire-prescreen",
    instructions,
    model,
    modelSettings: { toolChoice: "auto" },
    tools,
  })

  const sdkResult = await sdk.run(agent, input.replyText)
  const finalText = String((sdkResult as { finalOutput?: unknown }).finalOutput ?? "").trim()

  if (box.recorded) {
    log("prescreen.turn.agentic_routed", { routed: "answered", action: box.recorded.action.kind })
    return { routed: "answered", result: box.recorded }
  }

  // No record call → treat as a tangent. Prefer the LLM's composed reply; if it
  // emitted nothing usable, the caller will re-ask the pending question.
  log("prescreen.turn.agentic_routed", { routed: "tangent", topic: box.tangentTopic })
  return { routed: "tangent", tangentText: finalText }
}
