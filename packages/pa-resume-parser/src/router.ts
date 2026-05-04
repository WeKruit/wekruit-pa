/**
 * iter30 WS1 — 3-tier model fallback chain (Layer B).
 *
 *   primary   = gpt-5.4-nano  (max 2 SDK retries)
 *   secondary = gpt-4.1-mini  (max 2 SDK retries)
 *   tertiary  = gpt-4.1-nano  (max 1 SDK retry)
 *
 * Sonnet 4.5 is **not** in the chain (Adam-locked: discussion.md §1).
 * On retryable error → next tier. On non-retryable → throw immediately.
 */

import { NonRetryableError, isRetryable, type Logger } from "./retry.js"
import {
  callOpenAIResponses,
  type OpenAIResponsesClient,
} from "./providers/openai-responses.js"

export type Tier = "primary" | "secondary" | "tertiary"

export type ModelConfig = {
  tier: Tier
  provider: "openai"
  model: string
  /** Forwarded to OpenAI SDK constructor `maxRetries`. */
  maxRetries: number
}

/** Adam-locked chain. NEVER include Sonnet 4.5. */
export const TIER_CHAIN: ReadonlyArray<ModelConfig> = [
  { tier: "primary", provider: "openai", model: "gpt-5.4-nano", maxRetries: 2 },
  { tier: "secondary", provider: "openai", model: "gpt-4.1-mini", maxRetries: 2 },
  { tier: "tertiary", provider: "openai", model: "gpt-4.1-nano", maxRetries: 1 },
] as const

export type RouterCallArgs = {
  apiKey: string
  baseURL?: string
  systemPrompt: string
  userText: string
  schemaName: string
  schema: Record<string, unknown>
  log?: Logger
  /** Optional chain override (tests). */
  chain?: ReadonlyArray<ModelConfig>
  /** Test seam — passed through to the OpenAI provider. */
  clientFactory?: (init: {
    apiKey: string
    baseURL?: string
    maxRetries?: number
  }) => OpenAIResponsesClient | Promise<OpenAIResponsesClient>
  /**
   * Per-tier `strict` override. Default true. nano-tier may relax to false
   * via env if MS7.3 schema-eval shows nano struggling under strict.
   */
  strictByTier?: Partial<Record<Tier, boolean>>
}

export type RouterCallResult = {
  rawJson: string
  usedTier: Tier
  usedModel: string
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}

/**
 * Run the 3-tier chain. The first tier that returns successfully wins.
 *
 * Error classification:
 *   - retryable error from a tier → log `tier_fallback` and try next tier.
 *   - NonRetryableError or last-tier exhaustion → throw to caller (Layer C).
 */
export async function callWithFallback(args: RouterCallArgs): Promise<RouterCallResult> {
  const chain = args.chain ?? TIER_CHAIN
  if (chain.length === 0) {
    throw new NonRetryableError("router: empty tier chain")
  }
  let lastErr: unknown
  for (let i = 0; i < chain.length; i++) {
    const tier = chain[i]!
    try {
      const result = await callOpenAIResponses({
        apiKey: args.apiKey,
        baseURL: args.baseURL,
        model: tier.model,
        systemPrompt: args.systemPrompt,
        userText: args.userText,
        schemaName: args.schemaName,
        schema: args.schema,
        maxRetries: tier.maxRetries,
        clientFactory: args.clientFactory,
        strict: args.strictByTier?.[tier.tier] ?? true,
      })
      args.log?.("pa.cv_ingest.tier_ok", {
        tier: tier.tier,
        model: tier.model,
        attempt: i + 1,
      })
      return {
        rawJson: result.rawJson,
        usedTier: tier.tier,
        usedModel: tier.model,
        usage: result.usage,
      }
    } catch (err) {
      lastErr = err
      const retryable = isRetryable(err)
      args.log?.("pa.cv_ingest.tier_fallback", {
        tier: tier.tier,
        model: tier.model,
        retryable,
        error: err instanceof Error ? err.message : String(err),
      })
      if (!retryable) {
        // Non-retryable (4xx auth, bad-request, schema-violation hard) →
        // surface immediately. Do NOT continue down the chain.
        throw err
      }
      // else: try next tier
    }
  }
  // All tiers exhausted with retryable errors — bubble the last one up so
  // Layer C (outer retry) can see it.
  throw lastErr ?? new Error("router_chain_exhausted")
}
