/**
 * GuidedOpenJudge — LLM-first canonicalizer for the "guided_open" answer
 * mode.
 *
 * Adam directive 2026-05-07 (GOAL-onboarding-refactor.md L2):
 *   "regex must be bloom-filter only — a hit skips the LLM to save cost,
 *    a miss never blocks. LLM is primary source of truth."
 *
 * Used by every probe Q whose answer space is open-ended but bounded by
 * canonical hints (q_role, q_yoe, q_visa, q_country, q_location,
 * q_startup_pref, ...). Replaces the old 4-path dispatch
 * (the legacy regex parsers + extractAnswerIntent
 * fallback) with a single resolver:
 *
 *   reply ──▶ noise filter ──▶ bloom regex ──▶ LLM (SF Qwen → gpt-4.1-mini)
 *               │ empty/junk      │ optimistic     │ canonical answer
 *               ▼                 ▼                ▼
 *           irrelevant        accept (skip LLM)   provided / unclear
 *
 * LLM provider chain (per env-aliasing cleanup b4225f3 — NEVER read
 * OPENAI_API_KEY or OPENAI_BASE_URL, those are poisoned legacy aliases):
 *   primary   = SiliconFlow Qwen2.5-7B-Instruct      (SILICONFLOW_API_KEY,
 *                                                     baseURL siliconflow.cn/v1)
 *   fallback  = OpenAI gpt-4.1-mini                  (PA_OPENAI_AGENT_API_KEY,
 *                                                     baseURL api.openai.com/v1)
 *
 * Test seam: `llmCallFactory` overrides the default fetch-based caller so
 * unit tests can inject canned responses without network access.
 */
import type { Judge, JudgeCtx, JudgeResult, Lang } from "../question.js"

/**
 * Canonical SF / OpenAI baseURLs. Hard-coded per Adam directive — caller
 * code MUST NOT read OPENAI_BASE_URL from env.
 */
const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1"
const OPENAI_BASE_URL = "https://api.openai.com/v1"

const SILICONFLOW_MODEL = "Qwen/Qwen2.5-7B-Instruct"
const OPENAI_FALLBACK_MODEL = "gpt-4.1-mini"

const DEFAULT_TIMEOUT_MS = 6000
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6
const DEFAULT_MIN_MEANINGFUL_CHARS = 1

/**
 * Few-shot example consumed by the LLM prompt. `value` is rendered as a
 * JSON literal in the prompt; the `confidence` field is shown so the LLM
 * mirrors realistic confidence scoring.
 */
export interface GuidedOpenExample<TAnswer> {
  reply: string
  value: TAnswer
  confidence?: number
}

/**
 * Optional bloom-filter pattern. When `pattern.test(reply)` is true, the
 * judge prefers `parseValue(value)` and falls back to `parseValue(reply)`;
 * if both are null it falls through to the LLM. **Never blocks**.
 */
export interface GuidedOpenBloom<TAnswer> {
  pattern: RegExp
  value: TAnswer
}

/**
 * Provider configuration handed to the default LLM caller. Helpers below
 * read this from canonical env vars (SILICONFLOW_API_KEY,
 * PA_OPENAI_AGENT_API_KEY); never reads OPENAI_API_KEY / OPENAI_BASE_URL.
 */
interface ProviderConfig {
  apiKey: string
  baseURL: string
  model: string
}

/**
 * Test-seam shape. Returns the raw JSON string the LLM emitted. Throwing
 * is interpreted as "this provider failed → try next tier or give up".
 */
export type LlmCallFn = (args: {
  systemPrompt: string
  userPrompt: string
  timeoutMs: number
}) => Promise<string>

/**
 * Spec for `new GuidedOpenJudge(spec)`. `parseValue` is the only piece
 * that's truly per-question — it converts whatever the LLM returned (a
 * string, an array, a number) into the typed `TAnswer` shape that
 * `Question.onAccepted` expects.
 */
export interface GuidedOpenJudgeSpec<TAnswer> {
  /** Human-readable label used in the LLM prompt (e.g. "target work location"). */
  questionLabel: string
  /** Canonical tokens / examples shown to the LLM as the answer space. */
  hints: readonly string[]
  /** Few-shot examples — at least 2 recommended for stable parsing. */
  examples: readonly GuidedOpenExample<TAnswer>[]
  /** OPTIMISTIC bloom-filter — never blocks; only used to skip a clear LLM hit. */
  bloomRegex?: readonly GuidedOpenBloom<TAnswer>[]
  /**
   * Convert LLM-returned raw value → typed TAnswer. Returning null means
   * "the LLM said something I can't validate as a real answer", and the
   * judge will degrade to `{reason: "unclear"}`.
   */
  parseValue: (raw: unknown) => TAnswer | null
  /**
   * Optional deterministic parse of the user's raw reply before the LLM.
   * Use only for narrow scalar questions where a local parser is safer than
   * model canonicalization, such as years of experience.
   */
  parseReply?: (reply: string) => TAnswer | null
  /** Override the default 0.6 acceptance threshold. */
  confidenceThreshold?: number
  /** Skip LLM when reply has fewer than N alphanumeric/CJK chars. */
  minMeaningfulChars?: number
  /**
   * When true, provider errors or malformed LLM JSON can accept a substantive
   * raw reply through parseValue. Keep opt-in so strict onboarding questions
   * do not silently advance on infrastructure failures.
   */
  failOpenOnLlmError?: boolean
  /** Test-seam: inject a custom LLM caller. Default uses fetch chain. */
  llmCallFactory?: () => LlmCallFn
  /**
   * Override timeout per provider call. Useful for tests; production
   * default is 6s per call.
   */
  timeoutMs?: number
}

/**
 * Shape we expect the LLM to emit (mirrors the existing
 * `makeExtractAnswerIntent` contract in apps/functions/orchestrator-deps.ts).
 */
type LlmIntentShape =
  | {
      intent: "provided"
      value: unknown
      confidence?: number
    }
  | {
      intent: "unclear"
      clarifyingQuestion?: string
    }
  | {
      intent: "declined"
    }

/** Reads SF + OpenAI configs from env. NEVER touches OPENAI_API_KEY. */
function readSiliconFlowConfig(): ProviderConfig | null {
  const apiKey = (process.env.SILICONFLOW_API_KEY ?? "").trim()
  if (!apiKey) return null
  return { apiKey, baseURL: SILICONFLOW_BASE_URL, model: SILICONFLOW_MODEL }
}

function readOpenAIConfig(): ProviderConfig | null {
  const apiKey = (process.env.PA_OPENAI_AGENT_API_KEY ?? "").trim()
  if (!apiKey || !apiKey.startsWith("sk-")) return null
  return { apiKey, baseURL: OPENAI_BASE_URL, model: OPENAI_FALLBACK_MODEL }
}

/**
 * Default fetch-based LLM caller. Tries SF Qwen first, falls back to
 * OpenAI gpt-4.1-mini. Throws when both providers fail or are unbound,
 * letting the judge translate to `{reason: "irrelevant"}`.
 */
function defaultLlmCall(): LlmCallFn {
  return async ({ systemPrompt, userPrompt, timeoutMs }) => {
    const sf = readSiliconFlowConfig()
    const oa = readOpenAIConfig()

    const tryProvider = async (cfg: ProviderConfig): Promise<string> => {
      const res = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 200,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        throw new Error(`provider non-200 status=${res.status}`)
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      const raw = data.choices?.[0]?.message?.content?.trim() ?? ""
      if (!raw) throw new Error("provider empty content")
      return raw
    }

    const errors: string[] = []
    if (sf) {
      try {
        return await tryProvider(sf)
      } catch (e) {
        errors.push(`siliconflow: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      errors.push("siliconflow: SILICONFLOW_API_KEY unbound")
    }
    if (oa) {
      try {
        return await tryProvider(oa)
      } catch (e) {
        errors.push(`openai-fallback: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      errors.push("openai-fallback: PA_OPENAI_AGENT_API_KEY unbound")
    }
    throw new Error(`all providers failed: ${errors.join("; ")}`)
  }
}

/**
 * Compose system prompt for the LLM. Hints are surfaced as the canonical
 * answer space; examples drive few-shot behavior; lang directive ensures
 * clarifying questions match the user's preferred language.
 */
function buildSystemPrompt<TAnswer>(
  spec: GuidedOpenJudgeSpec<TAnswer>,
  _lang: Lang
): string {
  const langDirective = "If the question warrants a clarifying question, ask in English."
  const hintsLine = spec.hints.length
    ? `Canonical answer space (free-form OK, but normalize to these tokens when possible): ${spec.hints
        .map((h) => `"${h}"`)
        .join(", ")}.`
    : ""
  const examples = spec.examples
    .map((ex) => {
      const base: Record<string, unknown> = {
        intent: "provided",
        value: ex.value,
        confidence: ex.confidence ?? 0.9,
      }
      return `  "${ex.reply.replace(/"/g, '\\"')}" → ${JSON.stringify(base)}`
    })
    .join("\n")

  return `You extract structured intent from a user's reply during onboarding.

Question topic: ${spec.questionLabel}.

${hintsLine}

Output JSON ONLY (no prose, no markdown). Three possible intents:
  • {"intent":"provided","value":<canonical token, array of tokens, or free-form>,"confidence":0.0-1.0}
  • {"intent":"unclear","clarifyingQuestion":"<friendly short follow-up>"}
  • {"intent":"declined"}

Rules:
- Confidence reflects how sure you are. Below 0.6 → "unclear" with clarifying question.
- Clarifying question must be SHORT (≤1 sentence), friend-tone, no marketing-speak.
- ${langDirective}
- DO NOT invent specifics the user didn't say.
- Multi-value answers (e.g. "sf or nyc") → return value as array when natural.

Examples:
${examples || "  (no examples)"}`
}

/**
 * Pure-punctuation / empty / __PA_RESET__ noise check. Saves cost on
 * trivial replies and avoids feeding the LLM an obvious-junk prompt.
 */
function isNoiseReply(reply: string, minChars: number): boolean {
  const trimmed = reply.trim()
  if (!trimmed) return true
  if (trimmed === "__PA_RESET__") return true
  // Need at least N letter/digit/CJK chars.
  const meaningful = trimmed.match(/[A-Za-z0-9]/g) ?? []
  return meaningful.length < minChars
}

function tryFailOpenAccept<TAnswer>(
  spec: GuidedOpenJudgeSpec<TAnswer>,
  reply: string,
  minChars: number,
): JudgeResult<TAnswer> | null {
  if (spec.failOpenOnLlmError !== true) return null
  if (isNoiseReply(reply, minChars)) return null
  const parsed = spec.parseValue(reply.trim())
  if (parsed === null) return null
  return { accept: true, value: parsed, confidence: 0.55 }
}

function safeParseJson(raw: string): LlmIntentShape | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (obj.intent === "provided") {
    const conf = typeof obj.confidence === "number" ? obj.confidence : 0.5
    return { intent: "provided", value: obj.value, confidence: conf }
  }
  if (obj.intent === "unclear") {
    const cq = typeof obj.clarifyingQuestion === "string" ? obj.clarifyingQuestion : undefined
    return { intent: "unclear", clarifyingQuestion: cq }
  }
  if (obj.intent === "declined") {
    return { intent: "declined" }
  }
  return null
}

/**
 * GuidedOpenJudge<TAnswer> — the primary judge for open-ended onboarding
 * Qs. See module docstring for execution order.
 */
export class GuidedOpenJudge<TAnswer> implements Judge<TAnswer> {
  readonly kind = "guided-open"

  private readonly llmCall: LlmCallFn
  private readonly threshold: number
  private readonly minChars: number
  private readonly timeoutMs: number

  constructor(private readonly spec: GuidedOpenJudgeSpec<TAnswer>) {
    this.llmCall = (spec.llmCallFactory ?? defaultLlmCall)()
    this.threshold = spec.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD
    this.minChars = spec.minMeaningfulChars ?? DEFAULT_MIN_MEANINGFUL_CHARS
    this.timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async judge(
    reply: string,
    lang: Lang,
    ctx: JudgeCtx
  ): Promise<JudgeResult<TAnswer>> {
    // ── Step 1: noise filter ──────────────────────────────────────────
    if (isNoiseReply(reply, this.minChars)) {
      return { accept: false, reason: "irrelevant" }
    }

    // ── Step 2: direct deterministic parse (question opt-in only) ─────
    const directParsed = this.spec.parseReply?.(reply)
    if (directParsed !== null && directParsed !== undefined) {
      ctx.log?.("pa.onboarding.judge.guided_open.direct_parse", {
        userId: ctx.userId,
        turnId: ctx.turnId,
        questionLabel: this.spec.questionLabel,
      })
      return { accept: true, value: directParsed, confidence: 1.0 }
    }

    // ── Step 3: bloom regex (optimistic only) ─────────────────────────
    if (this.spec.bloomRegex && this.spec.bloomRegex.length > 0) {
      for (const bloom of this.spec.bloomRegex) {
        if (bloom.pattern.test(reply)) {
          const parsed = this.spec.parseValue(bloom.value) ?? this.spec.parseValue(reply)
          if (parsed !== null) {
            ctx.log?.("pa.onboarding.judge.guided_open.bloom_hit", {
              userId: ctx.userId,
              turnId: ctx.turnId,
              questionLabel: this.spec.questionLabel,
            })
            return { accept: true, value: parsed, confidence: 1.0 }
          }
          // bloom matched but parseValue rejected → fall through to LLM.
          // (bloom config bug surface — log it.)
          ctx.log?.("pa.onboarding.judge.guided_open.bloom_unparsed", {
            questionLabel: this.spec.questionLabel,
          })
        }
      }
    }

    // ── Step 4: LLM call ──────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(this.spec, lang)
    const userPrompt = `User reply: "${reply}"\n\nOutput JSON:`
    let raw: string
    try {
      ctx.log?.("pa.onboarding.judge.guided_open.invoke", {
        userId: ctx.userId,
        turnId: ctx.turnId,
        questionLabel: this.spec.questionLabel,
        replyLen: reply.length,
      })
      raw = await this.llmCall({ systemPrompt, userPrompt, timeoutMs: this.timeoutMs })
    } catch (err) {
      ctx.log?.("pa.onboarding.judge.guided_open.error", {
        userId: ctx.userId,
        turnId: ctx.turnId,
        questionLabel: this.spec.questionLabel,
        error: err instanceof Error ? err.message : String(err),
      })
      const failOpen = tryFailOpenAccept(this.spec, reply, this.minChars)
      if (failOpen) {
        ctx.log?.("pa.onboarding.judge.guided_open.fail_open", {
          userId: ctx.userId,
          turnId: ctx.turnId,
          questionLabel: this.spec.questionLabel,
          source: "llm_error",
        })
        return failOpen
      }
      return { accept: false, reason: "irrelevant" }
    }

    const intent = safeParseJson(raw)
    if (!intent) {
      ctx.log?.("pa.onboarding.judge.guided_open.bad_json", {
        questionLabel: this.spec.questionLabel,
        raw: raw.slice(0, 200),
      })
      const failOpen = tryFailOpenAccept(this.spec, reply, this.minChars)
      if (failOpen) {
        ctx.log?.("pa.onboarding.judge.guided_open.fail_open", {
          userId: ctx.userId,
          turnId: ctx.turnId,
          questionLabel: this.spec.questionLabel,
          source: "bad_json",
        })
        return failOpen
      }
      return { accept: false, reason: "irrelevant" }
    }

    if (intent.intent === "declined") {
      return { accept: false, reason: "declined" }
    }

    if (intent.intent === "unclear") {
      return {
        accept: false,
        reason: "unclear",
        clarifyingQuestion: intent.clarifyingQuestion?.slice(0, 200),
      }
    }

    // intent === "provided"
    const conf = intent.confidence ?? 0.5
    if (conf < this.threshold) {
      // Provided-but-low-confidence — treat as unclear so pipeline re-asks.
      return { accept: false, reason: "unclear" }
    }

    const parsed = this.spec.parseValue(intent.value)
    if (parsed === null) {
      ctx.log?.("pa.onboarding.judge.guided_open.parse_value_null", {
        questionLabel: this.spec.questionLabel,
      })
      return { accept: false, reason: "unclear" }
    }

    ctx.log?.("pa.onboarding.judge.guided_open.accept", {
      userId: ctx.userId,
      turnId: ctx.turnId,
      questionLabel: this.spec.questionLabel,
      confidence: conf,
    })
    return { accept: true, value: parsed, confidence: conf }
  }
}
