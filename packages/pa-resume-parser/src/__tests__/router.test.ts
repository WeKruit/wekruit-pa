import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { callWithFallback, TIER_CHAIN } from "../router.js"
import { NonRetryableError } from "../retry.js"
import type { OpenAIResponsesClient } from "../providers/openai-responses.js"
import type { AnthropicMessagesClient } from "../providers/anthropic-messages.js"

const FAKE_OK_JSON = JSON.stringify({ ok: true })

function makeOpenAIClient(handler: (model: string) => Promise<unknown>): OpenAIResponsesClient {
  return {
    responses: {
      create: async (req: Record<string, unknown>) => {
        const r = await handler(req.model as string)
        if (r instanceof Error) throw r
        return r as never
      },
    },
  }
}

function makeAnthropicClient(
  handler: (model: string) => Promise<unknown>
): AnthropicMessagesClient {
  return {
    messages: {
      create: async (req: Record<string, unknown>) => {
        const r = await handler(req.model as string)
        if (r instanceof Error) throw r
        return r as never
      },
    },
  }
}

describe("router.callWithFallback (Phase 53)", () => {
  it("Phase 53 chain: gpt-5.4-nano → claude-sonnet-4-6 → gpt-4.1-mini", () => {
    assert.equal(TIER_CHAIN.length, 3)
    assert.equal(TIER_CHAIN[0]!.provider, "openai")
    assert.equal(TIER_CHAIN[0]!.model, "gpt-5.4-nano")
    assert.equal(TIER_CHAIN[1]!.provider, "anthropic")
    assert.equal(TIER_CHAIN[1]!.model, "claude-sonnet-4-6")
    assert.equal(TIER_CHAIN[2]!.provider, "openai")
    assert.equal(TIER_CHAIN[2]!.model, "gpt-4.1-mini")
  })

  it("uses primary tier (OpenAI) on success", async () => {
    const calls: string[] = []
    const result = await callWithFallback({
      apiKey: "sk-test",
      anthropicApiKey: "sk-ant-test",
      systemPrompt: "sys",
      userText: "user",
      schemaName: "s",
      schema: {},
      clientFactory: () =>
        makeOpenAIClient(async (model) => {
          calls.push(model)
          return { output_text: FAKE_OK_JSON, usage: {} }
        }),
    })
    assert.equal(result.usedTier, "primary")
    assert.equal(result.usedModel, "gpt-5.4-nano")
    assert.equal(calls.length, 1)
  })

  it("falls through to secondary (Anthropic) on retryable primary error", async () => {
    const openaiCalls: string[] = []
    const anthropicCalls: string[] = []
    const result = await callWithFallback({
      apiKey: "sk-test",
      anthropicApiKey: "sk-ant-test",
      systemPrompt: "sys",
      userText: "user",
      schemaName: "parsed_resume_data",
      schema: {},
      clientFactory: () =>
        makeOpenAIClient(async (model) => {
          openaiCalls.push(model)
          return new Error("HTTP 503 overloaded")
        }),
      anthropicClientFactory: () =>
        makeAnthropicClient(async (model) => {
          anthropicCalls.push(model)
          return {
            content: [
              { type: "tool_use", name: "parsed_resume_data", input: { ok: true } },
            ],
            usage: { input_tokens: 100, output_tokens: 50 },
          }
        }),
    })
    assert.equal(result.usedTier, "secondary")
    assert.equal(result.usedModel, "claude-sonnet-4-6")
    assert.deepEqual(openaiCalls, ["gpt-5.4-nano"])
    assert.deepEqual(anthropicCalls, ["claude-sonnet-4-6"])
  })

  it("falls through to tertiary (gpt-4.1-mini) when ANTHROPIC_API_KEY is missing", async () => {
    // Simulate: primary fails, anthropic key absent, tertiary succeeds.
    const openaiCalls: string[] = []
    const result = await callWithFallback({
      apiKey: "sk-test",
      anthropicApiKey: undefined, // missing key — Anthropic tier falls through
      systemPrompt: "sys",
      userText: "user",
      schemaName: "s",
      schema: {},
      clientFactory: () =>
        makeOpenAIClient(async (model) => {
          openaiCalls.push(model)
          if (model === "gpt-5.4-nano") return new Error("HTTP 502 bad gateway")
          return { output_text: FAKE_OK_JSON, usage: {} }
        }),
      // No anthropicClientFactory — provider sees undefined apiKey first
      // and throws retryable before reaching the SDK.
    })
    assert.equal(result.usedTier, "tertiary")
    assert.equal(result.usedModel, "gpt-4.1-mini")
    assert.deepEqual(openaiCalls, ["gpt-5.4-nano", "gpt-4.1-mini"])
  })

  it("falls through to tertiary when both primary and Anthropic 5xx", async () => {
    const openaiCalls: string[] = []
    const anthropicCalls: string[] = []
    const result = await callWithFallback({
      apiKey: "sk-test",
      anthropicApiKey: "sk-ant-test",
      systemPrompt: "sys",
      userText: "user",
      schemaName: "s",
      schema: {},
      clientFactory: () =>
        makeOpenAIClient(async (model) => {
          openaiCalls.push(model)
          if (model === "gpt-5.4-nano") return new Error("HTTP 503")
          return { output_text: FAKE_OK_JSON, usage: {} }
        }),
      anthropicClientFactory: () =>
        makeAnthropicClient(async (model) => {
          anthropicCalls.push(model)
          return new Error("HTTP 529 overloaded")
        }),
    })
    assert.equal(result.usedTier, "tertiary")
    assert.deepEqual(openaiCalls, ["gpt-5.4-nano", "gpt-4.1-mini"])
    assert.deepEqual(anthropicCalls, ["claude-sonnet-4-6"])
  })

  it("throws (not falls through) on NonRetryableError from primary", async () => {
    const calls: string[] = []
    await assert.rejects(
      () =>
        callWithFallback({
          apiKey: "sk-test",
          anthropicApiKey: "sk-ant-test",
          systemPrompt: "sys",
          userText: "user",
          schemaName: "s",
          schema: {},
          clientFactory: () =>
            makeOpenAIClient(async (model) => {
              calls.push(model)
              return new NonRetryableError("missing_api_key")
            }),
        }),
      /missing_api_key/
    )
    assert.equal(calls.length, 1, "should not have fallen through past primary")
  })

  it("throws after exhausting all 3 tiers on persistent retryable errors", async () => {
    const openaiCalls: string[] = []
    const anthropicCalls: string[] = []
    await assert.rejects(
      () =>
        callWithFallback({
          apiKey: "sk-test",
          anthropicApiKey: "sk-ant-test",
          systemPrompt: "sys",
          userText: "user",
          schemaName: "s",
          schema: {},
          clientFactory: () =>
            makeOpenAIClient(async (model) => {
              openaiCalls.push(model)
              return new Error("HTTP 503 transient")
            }),
          anthropicClientFactory: () =>
            makeAnthropicClient(async (model) => {
              anthropicCalls.push(model)
              return new Error("HTTP 529 overloaded")
            }),
        }),
      /503|529/
    )
    assert.deepEqual(openaiCalls, ["gpt-5.4-nano", "gpt-4.1-mini"])
    assert.deepEqual(anthropicCalls, ["claude-sonnet-4-6"])
  })
})
