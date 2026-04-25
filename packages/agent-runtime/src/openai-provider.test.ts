import assert from "node:assert/strict"
import test from "node:test"
import type { AgentDef } from "@pa/core-types"
import { resolveOpenAICompatConfig } from "./openai-provider.js"

function agent(provider: AgentDef["provider"], model = "test-model"): AgentDef {
  return {
    id: "a1",
    name: "Test agent",
    status: "published",
    provider,
    model,
    temperature: 0.7,
    systemPrompt: "Test.",
    version: "1",
    memoryMode: "firestore_only",
    toolPolicy: "none",
  }
}

test("resolves DeepSeek OpenAI-compatible config from provider-specific env", () => {
  process.env.DEEPSEEK_API_KEY = "deepseek-key"
  const config = resolveOpenAICompatConfig(agent("deepseek", "deepseek-chat"))
  assert.equal(config.apiKey, "deepseek-key")
  assert.equal(config.baseURL, "https://api.deepseek.com/v1")
})

test("resolves SiliconFlow OpenAI-compatible config from provider-specific env", () => {
  process.env.SILICONFLOW_API_KEY = "siliconflow-key"
  const config = resolveOpenAICompatConfig(agent("siliconflow", "Qwen/Qwen2.5-7B-Instruct"))
  assert.equal(config.apiKey, "siliconflow-key")
  assert.equal(config.baseURL, "https://api.siliconflow.cn/v1")
})

test("prefers LiteLLM credentials when LiteLLM base URL is configured", () => {
  process.env.OPENAI_API_KEY = "openai-key"
  process.env.LITELLM_API_KEY = "litellm-key"
  process.env.LITELLM_BASE_URL = "http://127.0.0.1:4000/v1"
  const config = resolveOpenAICompatConfig(agent("openai", "pa-deepseek"))
  assert.equal(config.apiKey, "litellm-key")
  assert.equal(config.baseURL, "http://127.0.0.1:4000/v1")
  delete process.env.LITELLM_BASE_URL
})
