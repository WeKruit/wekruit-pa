/**
 * iter30 WS1 / Phase 53 — 3-tier model fallback chain (Layer B).
 *
 *   primary   = gpt-5.4-nano       (OpenAI Responses, max 2 SDK retries)
 *   secondary = claude-sonnet-4-6  (Anthropic Messages, max 2 SDK retries)
 *   tertiary  = gpt-4.1-mini       (OpenAI Responses, max 1 SDK retry)
 *
 * Phase 53 (PARSE-02) reintroduces Sonnet-4-6 as the middle tier. When
 * `ANTHROPIC_API_KEY` is unset (early rollout / dev sandboxes), the
 * Anthropic provider throws a retryable 503-shaped error so the router
 * falls through to gpt-4.1-mini final tier. Once the secret is set, the
 * Anthropic tier becomes load-bearing without any code change.
 *
 * On retryable error → next tier. On non-retryable → throw immediately.
 */

import { NonRetryableError, isRetryable, type Logger } from "./retry.js"
import {
  callOpenAIResponses,
  type OpenAIResponsesClient,
} from "./providers/openai-responses.js"
import {
  callAnthropicMessages,
  type AnthropicMessagesClient,
} from "./providers/anthropic-messages.js"

export type Tier = "primary" | "secondary" | "tertiary"

export type ProviderName = "openai" | "anthropic"

export type ModelConfig = {
  tier: Tier
  provider: ProviderName
  model: string
  /** Forwarded to the SDK constructor `maxRetries`. */
  maxRetries: number
}

/**
 * Adam-locked chain (Phase 53 / D11). Sonnet 4.6 (NOT 4.5 — 4.5 was
 * explicitly excluded in iter30; 4.6 reintroduced 2026-05-05 as the
 * middle tier with a graceful fallthrough when the key is absent).
 */
export const TIER_CHAIN: ReadonlyArray<ModelConfig> = [
  { tier: "primary", provider: "openai", model: "gpt-5.4-nano", maxRetries: 2 },
  { tier: "secondary", provider: "anthropic", model: "claude-sonnet-4-6", maxRetries: 2 },
  { tier: "tertiary", provider: "openai", model: "gpt-4.1-mini", maxRetries: 1 },
] as const

export type RouterCallArgs = {
  apiKey: string
  baseURL?: string
  /** Optional Anthropic API key override (default reads env). */
  anthropicApiKey?: string
  anthropicBaseURL?: string
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
  /** Test seam — passed through to the Anthropic provider. */
  anthropicClientFactory?: (init: {
    apiKey: string
    baseURL?: string
    maxRetries?: number
  }) => AnthropicMessagesClient | Promise<AnthropicMessagesClient>
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

function resolveAnthropicKey(override?: string): string | undefined {
  if (override && override.length > 0) return override
  const k = process.env.ANTHROPIC_API_KEY?.trim()
  return k && k.length > 0 ? k : undefined
}

function resolveAnthropicBaseURL(override?: string): string | undefined {
  if (override && override.length > 0) return override
  const b = process.env.ANTHROPIC_BASE_URL?.trim()
  return b && b.length > 0 ? b : undefined
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
      let result: { rawJson: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }
      if (tier.provider === "anthropic") {
        result = await callAnthropicMessages({
          apiKey: resolveAnthropicKey(args.anthropicApiKey),
          baseURL: resolveAnthropicBaseURL(args.anthropicBaseURL),
          model: tier.model,
          systemPrompt: args.systemPrompt,
          userText: args.userText,
          schemaName: args.schemaName,
          schema: args.schema,
          maxRetries: tier.maxRetries,
          clientFactory: args.anthropicClientFactory,
          strict: args.strictByTier?.[tier.tier] ?? true,
        })
      } else {
        result = await callOpenAIResponses({
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
      }
      args.log?.("pa.cv_ingest.tier_ok", {
        tier: tier.tier,
        provider: tier.provider,
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
        provider: tier.provider,
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
