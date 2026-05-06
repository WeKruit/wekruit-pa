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
  handler: (model: string) => Promise<unknown>,
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

describe("router.callWithFallback (job-tag-enricher)", () => {
  it("locked chain order: gpt-5.4-nano → claude-sonnet-4-6 → gpt-4.1-mini", () => {
    assert.equal(TIER_CHAIN.length, 3)
    assert.equal(TIER_CHAIN[0]!.model, "gpt-5.4-nano")
    assert.equal(TIER_CHAIN[1]!.model, "claude-sonnet-4-6")
    assert.equal(TIER_CHAIN[2]!.model, "gpt-4.1-mini")
  })

  it("uses primary tier on success", async () => {
    const result = await callWithFallback({
      apiKey: "sk-test",
      systemPrompt: "sys",
      userText: "user",
      schemaName: "enriched_job_tags",
      schema: {},
      clientFactory: () =>
        makeOpenAIClient(async () => ({ output_text: FAKE_OK_JSON, usage: {} })),
    })
    assert.equal(result.usedTier, "primary")
    assert.equal(result.usedModel, "gpt-5.4-nano")
    assert.deepEqual(result.fallbackChain, [])
  })

  it("falls through primary→secondary→tertiary on 5xx, records fallbackChain", async () => {
    const openaiCalls: string[] = []
    const anthropicCalls: string[] = []
    const result = await callWithFallback({
      apiKey: "sk-test",
      anthropicApiKey: "sk-ant-test",
      systemPrompt: "sys",
      userText: "user",
      schemaName: "enriched_job_tags",
      schema: {},
      clientFactory: () =>
        makeOpenAIClient(async (model) => {
          openaiCalls.push(model)
          if (model === "gpt-5.4-nano") return new Error("HTTP 503 overloaded")
          return { output_text: FAKE_OK_JSON, usage: {} }
        }),
      anthropicClientFactory: () =>
        makeAnthropicClient(async (model) => {
          anthropicCalls.push(model)
          return new Error("HTTP 529 overloaded")
        }),
    })
    assert.equal(result.usedTier, "tertiary")
    assert.equal(result.fallbackChain.length, 2)
    assert.match(result.fallbackChain[0]!, /gpt-5\.4-nano/)
    assert.match(result.fallbackChain[1]!, /claude-sonnet-4-6/)
    assert.deepEqual(openaiCalls, ["gpt-5.4-nano", "gpt-4.1-mini"])
    assert.deepEqual(anthropicCalls, ["claude-sonnet-4-6"])
  })

  it("anthropic key missing → primary 5xx → tertiary recovers", async () => {
    const openaiCalls: string[] = []
    const result = await callWithFallback({
      apiKey: "sk-test",
      anthropicApiKey: undefined,
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
    })
    assert.equal(result.usedTier, "tertiary")
    assert.deepEqual(openaiCalls, ["gpt-5.4-nano", "gpt-4.1-mini"])
  })

  it("NonRetryableError on primary → throws immediately, no fallthrough", async () => {
    let calls = 0
    await assert.rejects(
      () =>
        callWithFallback({
          apiKey: "sk-test",
          systemPrompt: "sys",
          userText: "user",
          schemaName: "s",
          schema: {},
          clientFactory: () =>
            makeOpenAIClient(async () => {
              calls++
              return new NonRetryableError("missing_api_key")
            }),
        }),
      /missing_api_key/,
    )
    assert.equal(calls, 1, "should not fall through past primary on non-retryable")
  })
})
