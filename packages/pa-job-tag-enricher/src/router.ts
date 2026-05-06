/**
 * @pa/job-tag-enricher — 3-tier model fallback router.
 *
 *   primary   = gpt-5.4-nano       (OpenAI Responses, max 2 SDK retries)
 *   secondary = claude-sonnet-4-6  (Anthropic Messages, max 2 SDK retries)
 *   tertiary  = gpt-4.1-mini       (OpenAI Responses, max 1 SDK retry)
 *
 * When `ANTHROPIC_API_KEY` is unset, the Anthropic provider throws a
 * retryable 503-shaped error so the router falls through to gpt-4.1-mini.
 *
 * On retryable error → next tier. On NonRetryableError → throw immediately.
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
  maxRetries: number
}

export const TIER_CHAIN: ReadonlyArray<ModelConfig> = [
  { tier: "primary", provider: "openai", model: "gpt-5.4-nano", maxRetries: 2 },
  { tier: "secondary", provider: "anthropic", model: "claude-sonnet-4-6", maxRetries: 2 },
  { tier: "tertiary", provider: "openai", model: "gpt-4.1-mini", maxRetries: 1 },
] as const

export type RouterCallArgs = {
  apiKey: string
  baseURL?: string
  anthropicApiKey?: string
  anthropicBaseURL?: string
  systemPrompt: string
  userText: string
  schemaName: string
  schema: Record<string, unknown>
  log?: Logger
  chain?: ReadonlyArray<ModelConfig>
  clientFactory?: (init: {
    apiKey: string
    baseURL?: string
    maxRetries?: number
  }) => OpenAIResponsesClient | Promise<OpenAIResponsesClient>
  anthropicClientFactory?: (init: {
    apiKey: string
    baseURL?: string
    maxRetries?: number
  }) => AnthropicMessagesClient | Promise<AnthropicMessagesClient>
  strictByTier?: Partial<Record<Tier, boolean>>
}

export type RouterCallResult = {
  rawJson: string
  usedTier: Tier
  usedModel: string
  fallbackChain: string[]
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

export async function callWithFallback(args: RouterCallArgs): Promise<RouterCallResult> {
  const chain = args.chain ?? TIER_CHAIN
  if (chain.length === 0) {
    throw new NonRetryableError("router: empty tier chain")
  }
  const fallbackChain: string[] = []
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
      args.log?.("pa.enrich_job_tags.tier_ok", {
        tier: tier.tier,
        provider: tier.provider,
        model: tier.model,
        attempt: i + 1,
      })
      return {
        rawJson: result.rawJson,
        usedTier: tier.tier,
        usedModel: tier.model,
        fallbackChain,
        usage: result.usage,
      }
    } catch (err) {
      lastErr = err
      const retryable = isRetryable(err)
      fallbackChain.push(`${tier.model}:${err instanceof Error ? err.message : String(err)}`)
      args.log?.("pa.enrich_job_tags.tier_fallback", {
        tier: tier.tier,
        provider: tier.provider,
        model: tier.model,
        retryable,
        error: err instanceof Error ? err.message : String(err),
      })
      if (!retryable) {
        throw err
      }
    }
  }
  throw lastErr ?? new Error("router_chain_exhausted")
}
