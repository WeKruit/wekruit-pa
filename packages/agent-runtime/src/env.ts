import type { LlmProvider } from "@pa/core-types"

/** OpenAI-compatible API key: OpenAI, LiteLLM proxy, OpenRouter, etc. */
export function hasOpenAICompatKey(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.LITELLM_API_KEY ||
      process.env.OPENROUTER_API_KEY
  )
}

export function assertProviderKey(provider: LlmProvider): void {
  if (provider === "openai" || provider === "other") {
    if (!hasOpenAICompatKey()) {
      throw new Error(
        "Set OPENAI_API_KEY, or LITELLM_API_KEY / OPENROUTER_API_KEY when using a gateway (with OPENAI_BASE_URL / LITELLM_BASE_URL)"
      )
    }
  } else if (provider === "azure_openai") {
    if (!process.env.AZURE_OPENAI_API_KEY) throw new Error("AZURE_OPENAI_API_KEY is required")
  }
}
