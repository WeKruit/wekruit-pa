/**
 * v1.6 Phase 61 — Qwen-7B QA judge for the weekly QA evaluator (REQ QA-04).
 *
 * Wraps SiliconFlow Qwen-7B (free tier) as a per-(user, job) match-quality
 * judge. Two booleans + a reasoning string come back, fully sanitized so any
 * misbehaving model can never crash the run.
 *
 * Two questions the judge answers:
 *   1. hardFilterPass — does the recommended job satisfy basic constraints
 *      (role-function alignment, visa fit, career-stage alignment)?
 *   2. top3Acceptable — would a reasonable recruiter offer this job to this
 *      candidate? Quality match, not just "any job in the role".
 *
 * Failure semantics (NEVER throws, always returns a verdict):
 *   - Missing API key → { false, false, "missing_api_key" }
 *   - LLM throws → { false, false, "judge_error" } (conservative — won't
 *     false-flag a pass)
 *   - Invalid JSON → { false, false, "invalid_json" }
 *   - Empty / null content → { false, false, "empty_response" }
 *
 * Cost / latency:
 *   - Qwen2.5-7B-Instruct on SiliconFlow free tier — $0/call.
 *   - Latency: 1-3s per pair with response_format=json_object.
 *   - 100 pairs × 3s ≈ 300s — well under the 540s function timeout.
 *
 * Model choice: identical to llm-rerank.ts (Qwen2.5-7B-Instruct) so the
 * SiliconFlow free-tier rate-limit budget is shared and predictable. Swap
 * here if Adam pins a different judge model later.
 */

import { logger } from "firebase-functions/v2"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QaJudgeUserSnapshot {
  targetRoleFunction: string[]
  skills: string[]
  relevantIndustry?: string[]
  industrySector?: string[]
  careerStage?: string
  visaStatus?: string
  targetLocations?: string[]
  yoeRange?: string
}

export interface QaJudgeJobSnapshot {
  roleTitle: string
  companyName: string
  industrySector?: string[]
  requiredSkills?: string[]
  seniorityLevel?: string
  sponsorship?: boolean
  locationRaw?: string
  jobDescription?: string
}

export interface QaJudgeInput {
  user: QaJudgeUserSnapshot
  job: QaJudgeJobSnapshot
}

export interface QaJudgeOutput {
  hardFilterPass: boolean
  top3Acceptable: boolean
  /** ≤500 chars — 1-2 sentences explaining the verdict. */
  reasoning: string
}

/** Minimal SDK shape we consume — matches RerankChatClient in llm-rerank.ts. */
export interface QaJudgeChatClient {
  chat: {
    completions: {
      create: (req: {
        model: string
        messages: Array<{ role: "system" | "user"; content: string }>
        response_format?: { type: "json_object" }
        temperature?: number
        max_tokens?: number
      }) => Promise<{
        choices?: Array<{ message?: { content?: string | null } | null } | null>
      }>
    }
  }
}

export interface QaJudgeDeps {
  /** SiliconFlow API key. Empty string → judge returns conservative-fail. */
  siliconflowApiKey: string
  /** Inject for tests; default builds an OpenAI client on first call. */
  client?: QaJudgeChatClient
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const QA_JUDGE_MODEL = "Qwen/Qwen2.5-7B-Instruct"
const QA_JUDGE_TEMPERATURE = 0.2
const QA_JUDGE_MAX_TOKENS = 500
const REASONING_MAX_LEN = 500

const SYSTEM_PROMPT = [
  "You are a recruiter QA evaluator. Given a candidate profile + a job",
  "recommended to them, evaluate two questions:",
  "",
  "1. hardFilterPass: Does the job satisfy basic constraints?",
  "   - Role function alignment (user.targetRoleFunction overlaps with",
  "     job.requiredSkills/title?)",
  "   - Visa fit (if user.visaStatus='sponsor_needed', job.sponsorship",
  "     must be true)",
  "   - Career stage alignment (entry-level user shouldn't get senior roles)",
  "",
  "2. top3Acceptable: Would a reasonable recruiter offer this job to this",
  "   candidate? Considers:",
  "   - Skill match",
  "   - Industry relevance",
  "   - Career trajectory fit",
  "   - NOT just 'any job in the role' — quality match",
  "",
  "Return EXACTLY this JSON, no markdown:",
  '{"hardFilterPass": boolean, "top3Acceptable": boolean, "reasoning": "1-2 sentences explaining decision"}',
].join("\n")

// ---------------------------------------------------------------------------
// Default lazy client factory
// ---------------------------------------------------------------------------

/**
 * Build a SiliconFlow-backed OpenAI SDK client. Returns null when no API
 * key is configured — caller emits the conservative-fail verdict.
 */
async function defaultJudgeClient(apiKey: string): Promise<QaJudgeChatClient | null> {
  if (!apiKey || apiKey.length === 0) return null
  const { default: OpenAI } = (await import("openai")) as unknown as {
    default: new (init: { apiKey: string; baseURL?: string }) => QaJudgeChatClient
  }
  return new OpenAI({ apiKey, baseURL: "https://api.siliconflow.cn/v1" })
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

/**
 * Evaluate one (user, job) pair. NEVER throws — every failure path returns
 * a conservative `{false, false, <reason>}` verdict so the run continues.
 */
export async function evaluateQaPair(
  input: QaJudgeInput,
  deps: QaJudgeDeps
): Promise<QaJudgeOutput> {
  const apiKey = (deps.siliconflowApiKey ?? "").trim()
  let client: QaJudgeChatClient | null
  try {
    client = deps.client ?? (await defaultJudgeClient(apiKey))
  } catch (err) {
    logger.warn("pa.qa_judge.client_init_failed", {
      err: String(err).slice(0, 200),
    })
    return failVerdict("client_init_failed")
  }

  if (!client) {
    return failVerdict("missing_api_key")
  }

  const userText = JSON.stringify({
    candidate: input.user,
    job: input.job,
  })

  let raw: string
  try {
    const res = await client.chat.completions.create({
      model: QA_JUDGE_MODEL,
      response_format: { type: "json_object" },
      temperature: QA_JUDGE_TEMPERATURE,
      max_tokens: QA_JUDGE_MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    })
    raw = res.choices?.[0]?.message?.content ?? ""
  } catch (err) {
    logger.warn("pa.qa_judge.api_call_failed", {
      err: String(err).slice(0, 200),
    })
    return failVerdict("judge_error")
  }

  if (!raw || typeof raw !== "string" || raw.length === 0) {
    return failVerdict("empty_response")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn("pa.qa_judge.invalid_json", { previewLen: raw.length })
    return failVerdict("invalid_json")
  }

  return sanitizeVerdict(parsed)
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

function failVerdict(reason: string): QaJudgeOutput {
  return {
    hardFilterPass: false,
    top3Acceptable: false,
    reasoning: reason.slice(0, REASONING_MAX_LEN),
  }
}

function sanitizeVerdict(parsed: unknown): QaJudgeOutput {
  if (!parsed || typeof parsed !== "object") return failVerdict("malformed_object")
  const obj = parsed as Record<string, unknown>
  const hardFilterPass = obj.hardFilterPass === true
  const top3Acceptable = obj.top3Acceptable === true
  let reasoning = ""
  if (typeof obj.reasoning === "string") {
    reasoning =
      obj.reasoning.length > REASONING_MAX_LEN
        ? obj.reasoning.slice(0, REASONING_MAX_LEN)
        : obj.reasoning
  }
  return { hardFilterPass, top3Acceptable, reasoning }
}
