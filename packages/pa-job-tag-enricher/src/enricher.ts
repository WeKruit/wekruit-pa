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
