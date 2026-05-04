/**
 * iter30 WS1 — parseResume v2 orchestrator.
 *
 * Layered:
 *   - withOuterRetry (3 attempts × [1s, 4s, 16s]) — Layer C
 *   - callWithFallback (3 tiers) — Layer B
 *   - OpenAI SDK retry (per-tier maxRetries) — Layer A
 *
 * Output is Zod-validated against `parsedResumeData`. Schema violations
 * are non-retryable at the outer layer (router-level fallback may still
 * try a different tier — different model occasionally produces conformant
 * output even when the previous one didn't).
 */

import { parsedResumeData, type ParsedResumeData } from "./schema.js"
import { PARSED_RESUME_JSON_SCHEMA, PARSED_RESUME_SCHEMA_NAME } from "./json-schema.js"
import { buildSystemPrompt, buildUserPrompt, type LangHint } from "./prompt.js"
import { callWithFallback, type Tier, type RouterCallArgs } from "./router.js"
import {
  withOuterRetry,
  DEFAULT_OUTER_RETRY_OPTS,
  type Logger,
  type WithOuterRetryOpts,
} from "./retry.js"

export type ParseResumeArgs = {
  resumeText: string
  langHint?: LangHint
  /** Optional override for OpenAI key (default reads env). */
  apiKey?: string
  /** Optional override for OpenAI base URL (default reads env). */
  baseURL?: string
  log?: Logger
  /** Outer retry config (default attempts=3, baseMs=1000, maxMs=16000). */
  retry?: Partial<WithOuterRetryOpts>
  /** Test seam — clientFactory propagated through router → provider. */
  clientFactory?: RouterCallArgs["clientFactory"]
  /** Test seam — chain override. */
  chain?: RouterCallArgs["chain"]
}

export type ParseResumeResult = {
  parsed: ParsedResumeData
  usedTier: Tier
  usedModel: string
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}

function resolveApiKey(override?: string): string {
  if (override && override.length > 0) return override
  const k =
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  return k
}

function resolveBaseURL(override?: string): string | undefined {
  if (override && override.length > 0) return override
  const b = process.env.PA_OPENAI_AGENT_BASE_URL?.trim()
  return b && b.length > 0 ? b : undefined
}

export async function parseResumeText(args: ParseResumeArgs): Promise<ParseResumeResult> {
  const apiKey = resolveApiKey(args.apiKey)
  const baseURL = resolveBaseURL(args.baseURL)
  const systemPrompt = buildSystemPrompt(args.langHint)
  const userText = buildUserPrompt(args.resumeText)
  const log = args.log

  const retryOpts: WithOuterRetryOpts = {
    attempts: args.retry?.attempts ?? DEFAULT_OUTER_RETRY_OPTS.attempts,
    baseMs: args.retry?.baseMs ?? DEFAULT_OUTER_RETRY_OPTS.baseMs,
    maxMs: args.retry?.maxMs ?? DEFAULT_OUTER_RETRY_OPTS.maxMs,
    sleep: args.retry?.sleep,
    log,
  }

  return withOuterRetry(async () => {
    const result = await callWithFallback({
      apiKey,
      baseURL,
      systemPrompt,
      userText,
      schemaName: PARSED_RESUME_SCHEMA_NAME,
      schema: PARSED_RESUME_JSON_SCHEMA as unknown as Record<string, unknown>,
      log,
      clientFactory: args.clientFactory,
      chain: args.chain,
    })
    let raw: unknown
    try {
      raw = JSON.parse(result.rawJson)
    } catch (err) {
      // Bad JSON from a tier is unusual under strict-output, but possible.
      // Treat as retryable at the outer layer (next outer attempt may hit
      // a transient that produced conformant JSON).
      const e = new Error(
        `llm_json_parse_failed: ${err instanceof Error ? err.message : String(err)}`
      )
      throw e
    }
    const parsed = parsedResumeData.parse(raw)
    log?.("pa.cv_ingest.parser_ok", {
      tier: result.usedTier,
      model: result.usedModel,
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
    })
    return {
      parsed,
      usedTier: result.usedTier,
      usedModel: result.usedModel,
      usage: result.usage,
    }
  }, retryOpts)
}
