/**
 * Phase 53 (PARSE-08, D15) — Industry classification second-pass.
 *
 * When the parser-v2 LLM emits `industries === ["other"]` (or empty) AND
 * `relevantIndustry` is similarly empty, we run a Sonnet-4-6 second pass
 * with an explicit reasoning prompt. The prompt grounds the model in the
 * canonical 42-token `INDUSTRY_SECTOR_VOCAB` (Phase 52) and asks for a
 * 1-3 token list with justification. We only return the canonical tokens
 * (the reasoning is dropped from the return — kept in logs).
 *
 * Goal: REDUCE regex token-match (D15). When the primary parser has no
 * confident industry signal, an LLM second pass (with a longer prompt
 * window) is more reliable than a regex token sniff.
 *
 * Fallthrough: if `ANTHROPIC_API_KEY` is unset OR the Anthropic call
 * 5xx-fails, we fall back to gpt-4.1-mini using the same prompt. If THAT
 * fails too, we return [] and the caller keeps the original `["other"]`
 * value — we never break cv-ingest on a second-pass failure.
 *
 * Cost: <1 second per call, fired only on the ~10-15% of CVs where the
 * primary classification was ambiguous.
 */

import {
  INDUSTRY_SECTOR_VOCAB,
  type IndustrySector,
} from "@wekruit/shared-tags"

export type WorkHistorySummary = {
  title?: string
  company?: string
  description?: string | null
  location?: string | null
}

export interface IndustrySecondPassArgs {
  /** Full CV text used by the primary parser; truncated to 8KB for the prompt. */
  cvText: string
  /** Top 3 work-history entries; passed verbatim to give the model concrete signal. */
  workHistory: ReadonlyArray<WorkHistorySummary>
  /** Anthropic API key (resolved by caller from process.env or Secret). */
  apiKey: string | undefined
  /** OpenAI fallback key (used when Anthropic unavailable). */
  openAiApiKey?: string
  openAiBaseURL?: string
  /** Logger — caller passes the cv-ingest log fn. */
  log: (event: string, payload?: Record<string, unknown>) => void
  /**
   * Test seam — Anthropic client factory. Default: real SDK.
   */
  anthropicClientFactory?: () => Promise<{
    messages: {
      create(params: Record<string, unknown>): Promise<{
        content?: Array<{
          type?: string
          name?: string
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input?: any
        }>
      }>
    }
  }>
  /** Test seam — OpenAI client factory. Default: real SDK. */
  openAiClientFactory?: () => Promise<{
    responses: {
      create(req: Record<string, unknown>): Promise<{
        output_text?: string
        output?: Array<{ content?: Array<{ text?: string }> }>
      }>
    }
  }>
}

const SECOND_PASS_TOOL_NAME = "industry_classifier"

const SECOND_PASS_SYSTEM_PROMPT = `You are an expert recruiter classifying a candidate's industry experience.
The primary parser was unsure — your job is to pick 1-3 BEST-MATCH industry sectors
from the closed enum below, using explicit reasoning grounded in the candidate's
companies and roles.

Industry enum (use these EXACT tokens — no abbreviations, no new tokens):
${INDUSTRY_SECTOR_VOCAB.join(", ")}

Rules:
- Output 1-3 sectors. NEVER more than 3.
- Use \`technology_general\` ONLY when no specific tech sector fits.
- Use lowercase + underscore exactly as shown.
- For each sector, provide a one-sentence justification grounded in a specific
  company or role from the CV.
- If you cannot identify any sector with confidence, return an empty list.`

const SECOND_PASS_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["industries", "reasoning"],
  properties: {
    industries: {
      type: "array",
      maxItems: 3,
      items: {
        type: "string",
        enum: [...INDUSTRY_SECTOR_VOCAB],
      },
    },
    reasoning: {
      type: "string",
      description: "1-3 sentence justification anchored in specific companies / roles.",
    },
  },
} as const

const CV_TEXT_BUDGET = 8192

function buildUserPayload(args: IndustrySecondPassArgs): string {
  const histStr = args.workHistory
    .slice(0, 3)
    .map((w, i) => {
      const title = (w.title ?? "").trim()
      const company = (w.company ?? "").trim()
      const desc = ((w.description ?? "") || "").trim().slice(0, 500)
      return `${i + 1}. ${title} @ ${company}${desc ? ` — ${desc}` : ""}`
    })
    .join("\n")
  const cvSlice = args.cvText.slice(0, CV_TEXT_BUDGET)
  return [
    "Top 3 work history entries:",
    histStr || "(none)",
    "",
    "CV text excerpt:",
    cvSlice,
    "",
    "Pick 1-3 industry sectors (from the enum) that best describe the COMPANIES",
    "this candidate has worked at. Provide reasoning per sector.",
  ].join("\n")
}

function isCanonicalIndustryToken(s: unknown): s is IndustrySector {
  return typeof s === "string" && (INDUSTRY_SECTOR_VOCAB as readonly string[]).includes(s)
}

async function callAnthropic(args: IndustrySecondPassArgs): Promise<IndustrySector[] | null> {
  if (!args.apiKey || args.apiKey.length === 0) {
    args.log("pa.cv_ingest.industry_second_pass.skipped", {
      reason: "no_anthropic_key",
    })
    return null
  }
  const factory = args.anthropicClientFactory
  let client: Awaited<ReturnType<NonNullable<IndustrySecondPassArgs["anthropicClientFactory"]>>>
  try {
    if (factory) {
      client = await factory()
    } else {
      const mod = (await import("@anthropic-ai/sdk")) as unknown as {
        default: new (init: { apiKey: string }) => typeof client
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client = new mod.default({ apiKey: args.apiKey }) as any
    }
  } catch (err) {
    args.log("pa.cv_ingest.industry_second_pass.anthropic_init_error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  const userPayload = buildUserPayload(args)
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SECOND_PASS_SYSTEM_PROMPT,
      tools: [
        {
          name: SECOND_PASS_TOOL_NAME,
          description: "Return classified industries with reasoning.",
          input_schema: SECOND_PASS_TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: SECOND_PASS_TOOL_NAME },
      messages: [{ role: "user", content: userPayload }],
    })
    const block = resp.content?.find(
      (c) => c?.type === "tool_use" && c?.name === SECOND_PASS_TOOL_NAME
    )
    if (!block || block.input == null) {
      args.log("pa.cv_ingest.industry_second_pass.anthropic_empty", {})
      return null
    }
    const raw = block.input as { industries?: unknown; reasoning?: unknown }
    const list = Array.isArray(raw.industries)
      ? raw.industries.filter(isCanonicalIndustryToken)
      : []
    args.log("pa.cv_ingest.industry_second_pass.anthropic_ok", {
      industries: list,
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning.slice(0, 500) : "",
    })
    return list
  } catch (err) {
    args.log("pa.cv_ingest.industry_second_pass.anthropic_error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function callOpenAiFallback(args: IndustrySecondPassArgs): Promise<IndustrySector[] | null> {
  // 2026-05-07 Adam directive — industry second-pass is real OpenAI.
  // Drop all OPENAI_API_KEY / OPENAI_BASE_URL fallthroughs (poisoned).
  const { getOpenAIConfig } = await import("../lib/llm-providers.js")
  const cfg = getOpenAIConfig()
  const apiKey = args.openAiApiKey ?? cfg.apiKey
  if (!apiKey || apiKey.length === 0) {
    args.log("pa.cv_ingest.industry_second_pass.openai_skipped", {
      reason: "no_openai_key",
    })
    return null
  }
  const baseURL = args.openAiBaseURL ?? cfg.baseURL

  const factory = args.openAiClientFactory
  let client: Awaited<ReturnType<NonNullable<IndustrySecondPassArgs["openAiClientFactory"]>>>
  try {
    if (factory) {
      client = await factory()
    } else {
      const mod = (await import("openai")) as unknown as {
        default: new (init: { apiKey: string; baseURL?: string }) => typeof client
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client = new mod.default({ apiKey, baseURL }) as any
    }
  } catch (err) {
    args.log("pa.cv_ingest.industry_second_pass.openai_init_error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  const userPayload = buildUserPayload(args)
  try {
    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: SECOND_PASS_SYSTEM_PROMPT },
        { role: "user", content: userPayload },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "industry_classifier",
          schema: SECOND_PASS_TOOL_SCHEMA,
          strict: true,
        },
      },
    })
    const outputText =
      typeof resp.output_text === "string" && resp.output_text.length > 0
        ? resp.output_text
        : Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text
          ? resp.output[0]!.content![0]!.text!
          : ""
    if (!outputText) {
      args.log("pa.cv_ingest.industry_second_pass.openai_empty", {})
      return null
    }
    const parsed = JSON.parse(outputText) as { industries?: unknown; reasoning?: unknown }
    const list = Array.isArray(parsed.industries)
      ? parsed.industries.filter(isCanonicalIndustryToken)
      : []
    args.log("pa.cv_ingest.industry_second_pass.openai_ok", {
      industries: list,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 500) : "",
    })
    return list
  } catch (err) {
    args.log("pa.cv_ingest.industry_second_pass.openai_error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Run an LLM second pass classifying the CV's industries against the
 * canonical `INDUSTRY_SECTOR_VOCAB`. Tries Anthropic Sonnet-4-6 first,
 * then falls back to OpenAI gpt-4.1-mini, then returns [] if both fail.
 *
 * NEVER throws. Returns canonical tokens (already filtered to vocab).
 */
export async function runIndustrySecondPass(
  args: IndustrySecondPassArgs
): Promise<IndustrySector[]> {
  const anthropic = await callAnthropic(args)
  if (anthropic && anthropic.length > 0) return anthropic

  const openai = await callOpenAiFallback(args)
  if (openai && openai.length > 0) return openai

  args.log("pa.cv_ingest.industry_second_pass.all_failed", {})
  return []
}
