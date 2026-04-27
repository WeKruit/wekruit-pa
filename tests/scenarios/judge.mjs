/**
 * Phase 14.2 — LLM-as-judge harness module.
 *
 * Calls gpt-5.4-nano via the OpenAI Responses API with a forced tool-output
 * schema so a structured `{ verdict, confidence, rationale }` payload comes
 * back instead of free-form text.
 *
 * This module is HARNESS-ONLY. It must never be imported from
 * `apps/onPaInbound`, the orchestrator, or any production runtime path —
 * judge calls cost money and Phase 14 explicitly forbids on-path billing
 * regressions (architecture lock L2 in 14-CONTEXT.md).
 *
 * Cost is tracked per call; the runner enforces `PA_EVAL_MAX_RUN_USD`
 * across the whole run and aborts before issuing a call that would push
 * the cumulative spend past the ceiling.
 *
 * See `tests/scenarios/README.md#llm-as-judge` for the YAML wiring.
 */
import OpenAI from "openai"
import { mkdir, appendFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  checkFillerBlacklist,
  checkIMessageRenderUnsafe,
  VOICE_AXES,
  passThreshold as VOICE_PASS_THRESHOLD,
} from "./lib/voice-axes.mjs"

// gpt-5.4-nano illustrative pricing per 14-CONTEXT.md §"Per-eval-run cost
// estimate". Kept as a constant here so a single price update touches one
// line rather than hunting through the runner.
export const JUDGE_MODEL = "gpt-5.4-nano"
export const JUDGE_PRICE_PER_M_INPUT_USD = 0.05
export const JUDGE_PRICE_PER_M_OUTPUT_USD = 0.4

/** Tool schema fed to the Responses API. The model is forced to call this
 *  tool, which gives us deterministic structured output without leaning on
 *  free-form JSON parsing. */
const JUDGE_TOOL = {
  type: "function",
  name: "submit_verdict",
  description:
    "Submit a structured verdict for the harness. Must be called exactly once.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "fail"],
        description: "Did the reply satisfy the criterion?",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Calibrated confidence in the verdict, 0-1.",
      },
      rationale: {
        type: "string",
        description: "1-3 sentence justification for the human auditor.",
      },
    },
    required: ["verdict", "confidence", "rationale"],
  },
}

const SYSTEM_PROMPT = [
  "You are an evaluation judge for a personal-assistant chatbot.",
  "You will be given (a) a criterion describing what a good reply looks like,",
  "(b) the user's transcript leading up to the assistant's reply, and",
  "(c) the assistant's final reply.",
  "Output ONLY by calling the `submit_verdict` tool exactly once.",
  "Set verdict=pass when the reply clearly satisfies the criterion;",
  "verdict=fail when it clearly does not.",
  "Confidence reflects how clearly the criterion is met; do not split close calls — say fail if uncertain.",
  "Keep rationale to 1-3 sentences.",
].join(" ")

let cachedClient = null
function getClient() {
  if (cachedClient) return cachedClient
  const apiKey = process.env.PA_OPENAI_AGENT_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      "PA_OPENAI_AGENT_API_KEY is required for judge calls (set it or unset PA_RUN_EVAL=1 to skip)"
    )
  }
  // Match the production base URL convention used by
  // packages/agent-runtime/src/openai-agents-adapter.ts so the judge
  // hits the same OpenAI endpoint as the system under test.
  const baseURL =
    process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
  cachedClient = new OpenAI({ apiKey, baseURL })
  return cachedClient
}

/** Best-effort cost estimate for ONE judge call. Uses the same illustrative
 *  pricing as 14-CONTEXT. We treat any missing token count as zero so a
 *  partial response cannot mask a runaway. */
export function estimateJudgeCostUsd(usage) {
  if (!usage) return 0
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0)
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
  return (
    (input / 1_000_000) * JUDGE_PRICE_PER_M_INPUT_USD +
    (output / 1_000_000) * JUDGE_PRICE_PER_M_OUTPUT_USD
  )
}

/** Pre-call upper bound, used by the cost-ceiling pre-flight. We assume
 *  the worst-case: 4k input tokens + the schema's max-realistic 200
 *  output tokens. Real usage is usually much smaller. */
export function projectJudgeCostUsd() {
  return (
    (4000 / 1_000_000) * JUDGE_PRICE_PER_M_INPUT_USD +
    (200 / 1_000_000) * JUDGE_PRICE_PER_M_OUTPUT_USD
  )
}

function buildUserMessage({ criterion, reply, transcript }) {
  const transcriptLines = Array.isArray(transcript)
    ? transcript
        .map((t) => `${t.role === "assistant" ? "ASSISTANT" : "USER"}: ${t.content}`)
        .join("\n")
    : "(no transcript)"
  return [
    `CRITERION:\n${criterion}`,
    `TRANSCRIPT (most recent last):\n${transcriptLines}`,
    `ASSISTANT FINAL REPLY:\n${reply}`,
  ].join("\n\n")
}

/** Extract the structured verdict from a Responses API response.
 *  Tolerates both the SDK's documented "function_call" item shape and
 *  the legacy "tool_use" wrapper some adapters emit. */
function extractVerdict(response) {
  const items = Array.isArray(response.output) ? response.output : []
  for (const item of items) {
    if (item.type === "function_call" && item.name === "submit_verdict") {
      try {
        return JSON.parse(item.arguments)
      } catch {
        return null
      }
    }
    // Some SDK builds wrap the call inside `content[]`.
    if (Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "tool_use" && c.name === "submit_verdict") {
          return c.input ?? null
        }
      }
    }
  }
  return null
}

async function appendJudgeLog(logPath, record) {
  if (!logPath) return
  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(logPath, JSON.stringify(record) + "\n", "utf8")
}

/**
 * Run a single judge call.
 *
 * @param {object} args
 * @param {string} args.criterion - YAML-supplied criterion text.
 * @param {number} args.threshold - Confidence threshold (default 0.7).
 * @param {string} args.reply - The assistant reply under judgment.
 * @param {Array<{role:"user"|"assistant",content:string}>} [args.transcript]
 * @param {string} [args.logPath] - Append-only JSONL log destination.
 * @param {object} [args.metadata] - Extra fields to merge into the log row.
 * @returns {Promise<{verdict:"pass"|"fail", confidence:number, rationale:string, costUsd:number, retryCount:number}>}
 */
export async function runJudge({
  criterion,
  threshold = 0.7,
  reply,
  transcript,
  logPath,
  metadata,
  skipFillerAutofail = false,
  skipImessageAutofail = false,
}) {
  if (!criterion || typeof criterion !== "string") {
    throw new Error("runJudge: criterion is required")
  }
  if (!reply || typeof reply !== "string") {
    throw new Error("runJudge: reply is required")
  }
  if (!skipFillerAutofail) {
    const fb = checkFillerBlacklist(reply)
    if (fb.hit) {
      return {
        verdict: "fail",
        confidence: 0,
        rationale: `Auto-fail: disallowed helper phrase “${fb.phrase}” (Phase 18 filler blacklist)`,
        costUsd: 0,
        retryCount: 0,
        autoFail: "filler_blacklist",
      }
    }
  }
  if (!skipImessageAutofail) {
    const ir = checkIMessageRenderUnsafe(reply)
    if (ir.hit) {
      return {
        verdict: "fail",
        confidence: 0,
        rationale: `Auto-fail: iMessage-unsafe text (${ir.reason})`,
        costUsd: 0,
        retryCount: 0,
        autoFail: "imessage_render",
      }
    }
  }
  const client = getClient()
  const userMessage = buildUserMessage({ criterion, reply, transcript })

  let lastErr = null
  let retryCount = 0
  // Per P9: at most one retry on transient error.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.responses.create({
        model: JUDGE_MODEL,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        tools: [JUDGE_TOOL],
        tool_choice: { type: "function", name: "submit_verdict" },
      })
      const verdict = extractVerdict(response)
      const costUsd = estimateJudgeCostUsd(response.usage)
      if (!verdict) {
        const record = {
          ts: new Date().toISOString(),
          ok: false,
          reason: "no_verdict_emitted",
          criterion,
          reply,
          response_id: response.id ?? null,
          usage: response.usage ?? null,
          costUsd,
          retryCount: attempt,
          ...(metadata ?? {}),
        }
        await appendJudgeLog(logPath, record)
        throw new Error("Judge did not emit a structured verdict")
      }
      const normalized = {
        verdict: verdict.verdict === "pass" ? "pass" : "fail",
        confidence: Number.isFinite(verdict.confidence)
          ? Math.max(0, Math.min(1, verdict.confidence))
          : 0,
        rationale: typeof verdict.rationale === "string" ? verdict.rationale : "",
      }
      const record = {
        ts: new Date().toISOString(),
        ok: true,
        criterion,
        threshold,
        reply,
        verdict: normalized,
        usage: response.usage ?? null,
        costUsd,
        retryCount: attempt,
        ...(metadata ?? {}),
      }
      await appendJudgeLog(logPath, record)
      return { ...normalized, costUsd, retryCount: attempt }
    } catch (err) {
      lastErr = err
      retryCount = attempt + 1
      if (attempt >= 1) break
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  await appendJudgeLog(logPath, {
    ts: new Date().toISOString(),
    ok: false,
    reason: "exception",
    error: msg,
    criterion,
    reply,
    retryCount,
    ...(metadata ?? {}),
  })
  throw new Error(`Judge call failed after ${retryCount} attempt(s): ${msg}`)
}

/** Apply judge-style verdict semantics. verdict==="fail" → fail.
 *  verdict==="pass" but confidence < threshold → fail.
 *  verdict==="pass" and confidence >= threshold → pass. */
export function judgeVerdictPasses({ verdict, confidence }, threshold) {
  if (verdict !== "pass") return false
  return confidence >= threshold
}

// ---------------------------------------------------------------------------
// Phase 18 — voice-axis judge (4 axes, scored 0-3 each, ≥2.4 average passes).
//
// Used by scenarios that opt in via `assert.voice_axes: true`. Additive to
// the existing single-verdict judge — does NOT replace it. Filler-blacklist
// + iMessage-render auto-fail short-circuits BEFORE issuing a judge call.
// ---------------------------------------------------------------------------

const VOICE_JUDGE_TOOL = {
  type: "function",
  name: "submit_voice_axes",
  description:
    "Score the assistant reply on 4 voice axes (each 0-3). Call exactly once.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      VOICE_AXES.map((a) => [
        a.id,
        {
          type: "integer",
          minimum: 0,
          maximum: 3,
          description: `${a.name}. Rubric: 0=${a.rubric[0]}; 1=${a.rubric[1]}; 2=${a.rubric[2]}; 3=${a.rubric[3]}.`,
        },
      ])
    ),
    required: VOICE_AXES.map((a) => a.id),
  },
}

const VOICE_JUDGE_SYSTEM_PROMPT = [
  "You are a voice-evaluation judge for an iMessage personal assistant whose persona is Claire (柯莱儿 / 小柯) — a Bay Area engineering manager texting a friend.",
  "Score the assistant reply on the 4 axes below. Each axis is integer 0-3.",
  "Be strict: if it reads as a generic LLM helper rather than Claire, mark in_character_voice ≤1.",
  "Code-switching zh/en is in-character; English-only or Chinese-only is fine if the user wrote that way.",
  "Output ONLY by calling the `submit_voice_axes` tool exactly once.",
].join(" ")

function extractVoiceAxes(response) {
  const items = Array.isArray(response.output) ? response.output : []
  for (const item of items) {
    if (item.type === "function_call" && item.name === "submit_voice_axes") {
      try {
        return JSON.parse(item.arguments)
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Run a 4-axis voice judge call.
 *
 * @returns {Promise<{ axes: Record<string,number>, average: number, pass: boolean, costUsd: number, autoFail?: string, rationale?: string }>}
 */
export async function runVoiceJudge({
  reply,
  transcript,
  threshold = VOICE_PASS_THRESHOLD,
  logPath,
  metadata,
  skipAutofail = false,
}) {
  if (!reply || typeof reply !== "string") {
    throw new Error("runVoiceJudge: reply is required")
  }
  if (!skipAutofail) {
    const fb = checkFillerBlacklist(reply)
    if (fb.hit) {
      const result = {
        axes: { no_robot_filler: 0 },
        average: 0,
        pass: false,
        costUsd: 0,
        autoFail: `filler_blacklist:${fb.lang}:${fb.phrase}`,
      }
      await appendJudgeLog(logPath, {
        ts: new Date().toISOString(),
        ok: true,
        kind: "voice_axes",
        autoFail: result.autoFail,
        reply,
        ...(metadata ?? {}),
      })
      return result
    }
    const ir = checkIMessageRenderUnsafe(reply)
    if (ir.hit) {
      const result = {
        axes: { no_robot_filler: 0 },
        average: 0,
        pass: false,
        costUsd: 0,
        autoFail: `imessage_render:${ir.reason}`,
      }
      await appendJudgeLog(logPath, {
        ts: new Date().toISOString(),
        ok: true,
        kind: "voice_axes",
        autoFail: result.autoFail,
        reply,
        ...(metadata ?? {}),
      })
      return result
    }
  }

  const client = getClient()
  const transcriptLines = Array.isArray(transcript)
    ? transcript
        .map((t) => `${t.role === "assistant" ? "ASSISTANT" : "USER"}: ${t.content}`)
        .join("\n")
    : "(no transcript)"
  const userMessage = [
    `TRANSCRIPT (most recent last):\n${transcriptLines}`,
    `ASSISTANT REPLY:\n${reply}`,
  ].join("\n\n")

  const response = await client.responses.create({
    model: JUDGE_MODEL,
    input: [
      { role: "system", content: VOICE_JUDGE_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    tools: [VOICE_JUDGE_TOOL],
    tool_choice: { type: "function", name: "submit_voice_axes" },
  })
  const axes = extractVoiceAxes(response)
  const costUsd = estimateJudgeCostUsd(response.usage)
  if (!axes) {
    throw new Error("Voice judge did not emit structured axes")
  }
  const values = VOICE_AXES.map((a) => Number(axes[a.id]) || 0)
  const average = values.reduce((s, v) => s + v, 0) / values.length
  const pass = average >= threshold
  await appendJudgeLog(logPath, {
    ts: new Date().toISOString(),
    ok: true,
    kind: "voice_axes",
    axes,
    average,
    pass,
    threshold,
    reply,
    costUsd,
    ...(metadata ?? {}),
  })
  return { axes, average, pass, costUsd }
}

// ---------------------------------------------------------------------------
// Phase 18 — pairwise voice judge (baseline vs candidate, anonymized A/B).
// Used by `runPairwise()` in lib/pairwise.mjs.
// ---------------------------------------------------------------------------

const PAIRWISE_TOOL = {
  type: "function",
  name: "submit_pairwise_winner",
  description: "Pick which reply is more in-character per Voice v1 axes. Call exactly once.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      winner: {
        type: "string",
        enum: ["A", "B", "tie"],
        description: "Which reply is more in-character (Claire / 小柯, Voice v1).",
      },
      rationale: {
        type: "string",
        description: "1-2 sentence justification.",
      },
    },
    required: ["winner", "rationale"],
  },
}

const PAIRWISE_SYSTEM_PROMPT = [
  "You are a voice-comparison judge for an iMessage personal assistant.",
  "The target persona is Claire (柯莱儿 / 小柯) — a Bay Area engineering manager texting a friend.",
  "You will see one user transcript and TWO candidate replies (A and B).",
  "Pick the one that is more in-character on these axes: warmth without sycophancy, in-character voice (Claire register, code-switch, sparse signature emoji 🍋/☕), no robot filler (no 我记住了/收到/As an AI/It's important to/Got it), and length appropriateness for iMessage (default 1-2 sentences).",
  "Code-switching zh/en is in-character; clinical multiple-choice 'X 还是 Y' default questions are NOT in-character.",
  "Output ONLY by calling the `submit_pairwise_winner` tool exactly once. Use 'tie' only when the two replies are genuinely indistinguishable on voice.",
].join(" ")

function extractPairwise(response) {
  const items = Array.isArray(response.output) ? response.output : []
  for (const item of items) {
    if (item.type === "function_call" && item.name === "submit_pairwise_winner") {
      try {
        return JSON.parse(item.arguments)
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Run a single pairwise judge call. Caller is responsible for label-swap
 * (call once with A=baseline,B=candidate, once with A=candidate,B=baseline)
 * to neutralize position bias.
 *
 * @returns {Promise<{ winner: 'A'|'B'|'tie', rationale: string, costUsd: number }>}
 */
export async function judgePairwise({
  promptA,
  promptB,
  transcript,
  logPath,
  metadata,
}) {
  if (typeof promptA !== "string" || typeof promptB !== "string") {
    throw new Error("judgePairwise: promptA + promptB required")
  }
  const client = getClient()
  const transcriptLines = Array.isArray(transcript)
    ? transcript
        .map((t) => `${t.role === "assistant" ? "ASSISTANT" : "USER"}: ${t.content}`)
        .join("\n")
    : "(no transcript)"
  const userMessage = [
    `USER TRANSCRIPT:\n${transcriptLines}`,
    `REPLY A:\n${promptA}`,
    `REPLY B:\n${promptB}`,
  ].join("\n\n")

  const response = await client.responses.create({
    model: JUDGE_MODEL,
    input: [
      { role: "system", content: PAIRWISE_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    tools: [PAIRWISE_TOOL],
    tool_choice: { type: "function", name: "submit_pairwise_winner" },
  })
  const out = extractPairwise(response)
  const costUsd = estimateJudgeCostUsd(response.usage)
  if (!out) throw new Error("Pairwise judge did not emit structured winner")
  const winner = out.winner === "A" || out.winner === "B" ? out.winner : "tie"
  const rationale = typeof out.rationale === "string" ? out.rationale : ""
  await appendJudgeLog(logPath, {
    ts: new Date().toISOString(),
    ok: true,
    kind: "pairwise",
    winner,
    rationale,
    costUsd,
    ...(metadata ?? {}),
  })
  return { winner, rationale, costUsd }
}
