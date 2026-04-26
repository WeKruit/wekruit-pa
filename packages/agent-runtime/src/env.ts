import type { LlmProvider } from "@pa/core-types"

/** OpenAI-compatible API key: OpenAI, LiteLLM proxy, OpenRouter, etc. */
export function hasOpenAICompatKey(): boolean {
  return Boolean(
    process.env.PA_OPENAI_AGENT_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.LITELLM_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.SILICONFLOW_API_KEY
  )
}

/**
 * Phase 10.5 T1 — provider-key assertion.
 *
 * The default OpenAI path uses `PA_OPENAI_AGENT_API_KEY` (Phase 10 secret).
 * We accept either that key OR a legacy gateway key (LITELLM/OPENROUTER) so
 * test/dev environments don't have to bind the new secret. The SiliconFlow
 * fallback still asserts `SILICONFLOW_API_KEY` independently.
 */
export function assertProviderKey(provider: LlmProvider): void {
  if (provider === "openai" || provider === "other") {
    // Default path now expects PA_OPENAI_AGENT_API_KEY. Accept any compatible
    // key so tests / fallbacks still pass.
    if (!hasOpenAICompatKey()) {
      throw new Error(
        "Set PA_OPENAI_AGENT_API_KEY for the default Agents SDK path, or OPENAI_API_KEY / LITELLM_API_KEY / OPENROUTER_API_KEY for compatible gateways"
      )
    }
  } else if (provider === "deepseek") {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required")
  } else if (provider === "siliconflow") {
    if (!process.env.SILICONFLOW_API_KEY) throw new Error("SILICONFLOW_API_KEY is required")
  } else if (provider === "azure_openai") {
    if (!process.env.AZURE_OPENAI_API_KEY) throw new Error("AZURE_OPENAI_API_KEY is required")
  }
}
