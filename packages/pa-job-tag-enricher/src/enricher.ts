/**
 * @pa/job-tag-enricher — public `enrichJobTags()` entry.
 *
 * Layers (mirror pa-resume-parser):
 *   - withOuterRetry (3 attempts × [1s, 4s, 16s]) — Layer C
 *   - callWithFallback (3 tiers) — Layer B
 *   - OpenAI/Anthropic SDK retry (per-tier maxRetries) — Layer A
 *
 * Output is Zod-validated against `enrichedJobTags`. Schema violations
 * (out-of-vocab tokens, missing required fields) are non-retryable at
 * the outer layer, but the router-level fallback may still try a different
 * tier — different model occasionally produces conformant output.
 */

import { enrichedJobTags, type EnrichedJobTags, type EnrichJobTagsResult } from "./schema.js"
import {
  ENRICHED_JOB_TAGS_JSON_SCHEMA,
  ENRICHED_JOB_TAGS_SCHEMA_NAME,
} from "./json-schema.js"
import {
  buildSystemPrompt,
  buildUserPrompt,
  type JobTagPromptInput,
} from "./prompts/job-tag-prompt.js"
import { callWithFallback, type RouterCallArgs } from "./router.js"
import {
  withOuterRetry,
  DEFAULT_OUTER_RETRY_OPTS,
  type Logger,
  type WithOuterRetryOpts,
} from "./retry.js"

export interface EnrichJobTagsInput {
  title: string
  companyName?: string | null
  jobDescription?: string | null
  locationRaw?: string | null
  sourceRepo?: string | null
}

export interface EnrichJobTagsOptions {
  /** OpenAI key — primary + tertiary tiers. Default: process.env.PA_OPENAI_AGENT_API_KEY ?? OPENAI_API_KEY. */
  openaiApiKey?: string
  openaiBaseURL?: string
  /** Anthropic key — secondary tier. Optional; missing key falls through gracefully. */
  anthropicApiKey?: string
  anthropicBaseURL?: string
  /**
   * Optional alternate OpenAI key for tertiary tier (e.g., separate account
   * for the gpt-4.1-mini fallback). Not commonly used; omit to share the
   * primary openaiApiKey.
   */
  fallbackOpenaiKey?: string
  log?: Logger
  retry?: Partial<WithOuterRetryOpts>
  /** Test seam — chain override. */
  chain?: RouterCallArgs["chain"]
  clientFactory?: RouterCallArgs["clientFactory"]
  anthropicClientFactory?: RouterCallArgs["anthropicClientFactory"]
}

/**
 * Normalize LLM-emitted skill / relevantTags names so they pass strict Zod
 * regex (`SKILL_NAME_PATTERN` = `[a-z][a-z0-9_+#.\-]{1,63}`,
 * `RELEVANT_TAG_PATTERN` = `[a-z][a-z0-9_]{1,79}`).
 *
 * LLM is prompted to emit canonical form, but occasionally slips with:
 *   - "C++" → "c++"  (lowercase + keep)
 *   - "RESTful APIs" → "restful_apis" (space→_)
 *   - "CI/CD" → "ci_cd" (slash→_)
 *   - ".NET" → "dotnet" (drop leading dot)
 *   - "机器学习" → drop (not salvageable in pure ASCII regex)
 *
 * Strategy: lowercase, replace `/` `\` ` ` `,` `-` boundaries with `_`,
 * strip chars outside `[a-z0-9_+#.\-]`, drop empty / non-ASCII-start.
 *
 * Failed normalizations are dropped (don't fail whole doc — better partial
 * data than 307 docs unable to enter corpus).
 */
function normalizeSkillName(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  let s = raw.trim().toLowerCase()
  // Replace common separator chars with underscore
  s = s.replace(/[\s/\\,]+/g, "_")
  // Strip anything not in canonical [a-z0-9_+#.-]
  s = s.replace(/[^a-z0-9_+#.\-]/g, "")
  // Collapse repeated underscores / hyphens
  s = s.replace(/__+/g, "_").replace(/--+/g, "-")
  // Trim leading/trailing separators + dots (must start with [a-z])
  s = s.replace(/^[^a-z]+/, "").replace(/[._\-]+$/, "")
  if (s.length < 2 || s.length > 64) return null
  return s
}

function normalizeRelevantTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  let s = raw.trim().toLowerCase()
  s = s.replace(/[\s/\\,+#.\-]+/g, "_")
  s = s.replace(/[^a-z0-9_]/g, "")
  s = s.replace(/__+/g, "_").replace(/^_+/, "").replace(/_+$/, "")
  if (s.length < 2 || s.length > 80) return null
  if (!/^[a-z]/.test(s)) return null
  return s
}

function normalizeLLMTags(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw
  const obj = raw as Record<string, unknown>
  // skills[].name
  if (Array.isArray(obj.skills)) {
    obj.skills = (obj.skills as Array<Record<string, unknown>>)
      .map((s) => {
        const norm = normalizeSkillName(s?.name)
        return norm ? { ...s, name: norm } : null
      })
      .filter((s) => s !== null)
  }
  // relevantTags[]
  if (Array.isArray(obj.relevantTags)) {
    const seen = new Set<string>()
    obj.relevantTags = (obj.relevantTags as unknown[])
      .map(normalizeRelevantTag)
      .filter((t): t is string => {
        if (!t || seen.has(t)) return false
        seen.add(t)
        return true
      })
  }
  return obj
}

function resolveOpenAiKey(override?: string): string {
  if (override && override.length > 0) return override
  const k =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  return k
}

function resolveOpenAiBaseURL(override?: string): string | undefined {
  if (override && override.length > 0) return override
  const b = process.env.PA_OPENAI_AGENT_BASE_URL?.trim()
  return b && b.length > 0 ? b : undefined
}

export async function enrichJobTags(
  input: EnrichJobTagsInput,
  opts: EnrichJobTagsOptions = {},
): Promise<EnrichJobTagsResult> {
  if (!input?.title || input.title.trim().length === 0) {
    throw new Error("enrichJobTags: title is required")
  }

  const apiKey = resolveOpenAiKey(opts.openaiApiKey)
  const baseURL = resolveOpenAiBaseURL(opts.openaiBaseURL)

  const systemPrompt = buildSystemPrompt()
  const userText = buildUserPrompt(input as JobTagPromptInput)
  const log = opts.log

  const retryOpts: WithOuterRetryOpts = {
    attempts: opts.retry?.attempts ?? DEFAULT_OUTER_RETRY_OPTS.attempts,
    baseMs: opts.retry?.baseMs ?? DEFAULT_OUTER_RETRY_OPTS.baseMs,
    maxMs: opts.retry?.maxMs ?? DEFAULT_OUTER_RETRY_OPTS.maxMs,
    sleep: opts.retry?.sleep,
    log,
  }

  return withOuterRetry(async () => {
    const result = await callWithFallback({
      apiKey,
      baseURL,
      anthropicApiKey: opts.anthropicApiKey,
      anthropicBaseURL: opts.anthropicBaseURL,
      systemPrompt,
      userText,
      schemaName: ENRICHED_JOB_TAGS_SCHEMA_NAME,
      schema: ENRICHED_JOB_TAGS_JSON_SCHEMA as unknown as Record<string, unknown>,
      log,
      clientFactory: opts.clientFactory,
      anthropicClientFactory: opts.anthropicClientFactory,
      chain: opts.chain,
    })
    let raw: unknown
    try {
      raw = JSON.parse(result.rawJson)
    } catch (err) {
      throw new Error(
        `llm_json_parse_failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // Normalize LLM slips before strict Zod validation. LLM is prompted to
    // emit lowercase + ASCII per shared-tags vocab, but occasionally returns
    // "C++", "RESTful APIs", "CI/CD", "机器学习". Normalize → drop unsalvageable.
    raw = normalizeLLMTags(raw)
    const tags: EnrichedJobTags = enrichedJobTags.parse(raw)
    log?.("pa.enrich_job_tags.parser_ok", {
      tier: result.usedTier,
      model: result.usedModel,
      title: input.title,
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
    })
    return {
      tags,
      modelUsed: result.usedModel,
      usedTier: result.usedTier,
      fallbackChain: result.fallbackChain,
      usage: result.usage,
    }
  }, retryOpts)
}
