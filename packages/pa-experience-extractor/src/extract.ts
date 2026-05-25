/**
 * Phase EX1 PR-A — per-entry skill extraction with cache + LLM + retry.
 *
 * Flow:
 *   1. Compute durationMonths from input dates (offline).
 *   2. Check Firestore cache (`pa-users/{uid}/workEntries/{entryId}`).
 *      Hit → return without LLM call.
 *   3. Miss → call gpt-5.4-nano via OpenAI Responses API.
 *   4. Validate output with zod; throw NonRetryableError on schema miss.
 *   5. Compose full WorkEntryExtractionOutput (entryId + duration + LLM
 *      result + metadata) and write back to cache.
 *
 * Retries (Layer A): OpenAI SDK's own `maxRetries` knob.
 * Retries (Layer C): `withOuterRetry` wrapper, 3 attempts × exp backoff
 *   on 429 / 5xx / network.
 *
 * The Firestore cache lives in {@link ./cache.ts} and is dependency-
 * injected so unit tests can pass an in-memory mock.
 */

import {
  callOpenAIResponses,
  withOuterRetry,
  NonRetryableError,
  type OpenAIResponsesClient,
  type Logger,
} from "@pa/pa-resume-parser"

import { LLM_JSON_SCHEMA, LLM_SCHEMA_NAME, llmExtractionPayload } from "./schema.js"
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js"
import { durationMonths } from "./duration.js"
import type {
  WorkEntryExtractionInput,
  WorkEntryExtractionOutput,
} from "./types.js"
import type { ExtractionCache } from "./cache.js"

/** Default model. Override per call for experiments. */
export const DEFAULT_MODEL = "gpt-5.4-nano"

export interface ExtractWorkEntryArgs {
  uid: string
  input: WorkEntryExtractionInput
  cache: ExtractionCache
  /** OpenAI key. Required unless every call hits cache. */
  openaiApiKey?: string
  baseURL?: string
  /** Model override (e.g. for evals). Defaults to {@link DEFAULT_MODEL}. */
  model?: string
  /**
   * SDK-level retry passed to OpenAI client. Defaults to 2; combined
   * with the outer `withOuterRetry` (3 attempts) we get ~6 effective.
   */
  sdkMaxRetries?: number
  /** Outer-retry attempt count. Defaults to 3. */
  outerAttempts?: number
  /** Override "now" for deterministic tests. */
  now?: Date
  /** Override client (test seam). */
  clientFactory?: (init: {
    apiKey: string
    baseURL?: string
    maxRetries?: number
  }) => OpenAIResponsesClient | Promise<OpenAIResponsesClient>
  /** Test seam: skip real sleep on retries. */
  sleep?: (ms: number) => Promise<void>
  /** Optional structured logger. */
  log?: Logger
}

export interface ExtractWorkEntryResult {
  output: WorkEntryExtractionOutput
  /** Indicates how the result was obtained — useful for telemetry. */
  source: "cache" | "llm"
}

export async function extractWorkEntrySkills(
  args: ExtractWorkEntryArgs
): Promise<ExtractWorkEntryResult> {
  const now = args.now ?? new Date()
  const { input, uid, cache } = args

  // 1. Cache check — short-circuit when we already have an extraction
  //    for this content-stable entryId.
  const cached = await cache.read(uid, input.entryId)
  if (cached) {
    args.log?.("pa.experience.cache_hit", { uid, entryId: input.entryId })
    return { output: cached, source: "cache" }
  }

  // 2. Compute deterministic fields (duration) before the LLM call so
  //    the LLM doesn't waste tokens on date math.
  const months = durationMonths(input.startDate, input.endDate, now)

  if (!args.openaiApiKey) {
    throw new NonRetryableError("missing_openai_api_key")
  }
  const model = args.model ?? DEFAULT_MODEL

  // 3. Outer-retried LLM call.
  const rawJson = await withOuterRetry(
    () =>
      callOpenAIResponses({
        apiKey: args.openaiApiKey!,
        baseURL: args.baseURL,
        model,
        systemPrompt: SYSTEM_PROMPT,
        userText: buildUserPrompt(input),
        schemaName: LLM_SCHEMA_NAME,
        schema: LLM_JSON_SCHEMA,
        maxRetries: args.sdkMaxRetries ?? 2,
        clientFactory: args.clientFactory,
        strict: true,
      }).then((r) => r.rawJson),
    {
      attempts: args.outerAttempts ?? 3,
      sleep: args.sleep,
      log: args.log,
    }
  )

  // 4. Parse / validate. zod failure is non-retryable — the model
  //    rarely recovers from a structured-output schema miss.
  let parsed
  try {
    parsed = llmExtractionPayload.parse(JSON.parse(rawJson))
  } catch (err) {
    throw new NonRetryableError("llm_schema_parse_failed", err)
  }

  // 5. Assemble the cache-shaped output (LLM payload + deterministic fields).
  const output: WorkEntryExtractionOutput = {
    entryId: input.entryId,
    extractedSkills: parsed.extractedSkills.map((s) => s.toLowerCase().trim()),
    durationMonths: months,
    industryGuess: parsed.industryGuess?.toLowerCase().trim() || null,
    responsibilityLevel: parsed.responsibilityLevel,
    confidence: parsed.confidence,
    llmModel: model,
    extractedAt: now.toISOString(),
  }

  await cache.write(uid, output)
  args.log?.("pa.experience.cache_miss_write", {
    uid,
    entryId: input.entryId,
    extractedSkillCount: output.extractedSkills.length,
  })

  return { output, source: "llm" }
}
