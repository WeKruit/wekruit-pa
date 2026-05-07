/**
 * 2026-05-07 Adam directive — single canonical source for LLM provider
 * configs. Replaces the env-aliasing scheme that overloaded
 * `OPENAI_API_KEY` and `OPENAI_BASE_URL` to mean either real OpenAI OR
 * SiliconFlow depending on context (which caused Bug D — real OpenAI
 * keys getting sent to SF endpoint → 401).
 *
 * Each helper returns BOTH apiKey AND baseURL explicitly. Callers MUST
 * pass both into their LLM SDK constructor. NEVER read
 * `process.env.OPENAI_API_KEY` or `process.env.OPENAI_BASE_URL` directly
 * from caller code — those env names are poisoned legacy and will be
 * removed in a follow-up sweep.
 *
 * Three providers, three env keys:
 *   - OpenAI proper:  PA_OPENAI_AGENT_API_KEY  + https://api.openai.com/v1
 *   - SiliconFlow:    SILICONFLOW_API_KEY      + https://api.siliconflow.cn/v1
 *   - Anthropic:      ANTHROPIC_API_KEY        + (default)
 */

export const OPENAI_BASE_URL = "https://api.openai.com/v1"
export const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1"

export interface ProviderConfig {
  apiKey: string
  baseURL: string
}

export interface OptionalProviderConfig {
  apiKey: string | null
  baseURL: string
}

/**
 * Real OpenAI provider — for CV parse, embeddings, nuanced match reason,
 * sponsorship inference, industry second-pass, and any other call that
 * MUST hit api.openai.com.
 *
 * Returns null apiKey if not configured. Caller decides fallback (skip
 * call vs throw).
 */
export function getOpenAIConfig(): OptionalProviderConfig {
  const apiKey = (process.env.PA_OPENAI_AGENT_API_KEY ?? "").trim()
  return {
    apiKey: apiKey.length > 0 && apiKey.startsWith("sk-") ? apiKey : null,
    baseURL: OPENAI_BASE_URL,
  }
}

/**
 * SiliconFlow provider — for Qwen-7B rerank, mem0 LLM (Qwen-72B), tag
 * normalization, cross-encoder rerank, match-explainer.
 *
 * SF keys also start with `sk-` so we cannot prefix-discriminate against
 * a misconfiguration. Returns null only when env var is empty.
 */
export function getSiliconFlowConfig(): OptionalProviderConfig {
  const apiKey = (process.env.SILICONFLOW_API_KEY ?? "").trim()
  return {
    apiKey: apiKey.length > 0 ? apiKey : null,
    baseURL: SILICONFLOW_BASE_URL,
  }
}

/**
 * Anthropic — for sonnet-4-6 middle tier in callWithFallback.
 *
 * Returns null when secret unbound or sentinel `__UNSET__`.
 */
export function getAnthropicConfig(): { apiKey: string | null } {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim()
  return {
    apiKey: apiKey.length > 0 && apiKey !== "__UNSET__" ? apiKey : null,
  }
}
