import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { callWithFallback, TIER_CHAIN } from "../router.js"
import { NonRetryableError } from "../retry.js"
import type { OpenAIResponsesClient } from "../providers/openai-responses.js"

const FAKE_OK_JSON = JSON.stringify({ ok: true })

function makeClient(handler: (model: string) => Promise<unknown>): OpenAIResponsesClient {
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

describe("router.callWithFallback", () => {
  it("locks Sonnet 4.5 OUT of the chain (Adam-locked)", () => {
    const models = TIER_CHAIN.map((t) => t.model.toLowerCase())
    for (const m of models) {
      assert.equal(/sonnet/i.test(m), false, `Sonnet 4.5 must not appear (got ${m})`)
    }
  })

  it("uses primary tier on success", async () => {
    let calls: string[] = []
    const result = await callWithFallback({
      apiKey: "sk-test",
      systemPrompt: "sys",
      userText: "user",
      schemaName: "s",
      schema: {},
      clientFactory: () =>
        makeClient(async (model) => {
          calls.push(model)
          return { output_text: FAKE_OK_JSON, usage: {} }
        }),
    })
    assert.equal(result.usedTier, "primary")
    assert.equal(result.usedModel, "gpt-5.4-nano")
    assert.equal(calls.length, 1)
  })

  it("falls through to secondary on retryable primary error", async () => {
    let calls: string[] = []
    const result = await callWithFallback({
      apiKey: "sk-test",
      systemPrompt: "sys",
      userText: "user",
      schemaName: "s",
      schema: {},
      clientFactory: () =>
        makeClient(async (model) => {
          calls.push(model)
          if (model === "gpt-5.4-nano") return new Error("HTTP 503 overloaded")
          return { output_text: FAKE_OK_JSON, usage: {} }
        }),
    })
    assert.equal(result.usedTier, "secondary")
    assert.deepEqual(calls, ["gpt-5.4-nano", "gpt-4.1-mini"])
  })

  it("falls through to tertiary when both primary+secondary retryable-fail", async () => {
    let calls: string[] = []
    const result = await callWithFallback({
      apiKey: "sk-test",
      systemPrompt: "sys",
      userText: "user",
      schemaName: "s",
      schema: {},
      clientFactory: () =>
        makeClient(async (model) => {
          calls.push(model)
          if (model === "gpt-5.4-nano" || model === "gpt-4.1-mini") {
            return new Error("HTTP 502 bad gateway")
          }
          return { output_text: FAKE_OK_JSON, usage: {} }
        }),
    })
    assert.equal(result.usedTier, "tertiary")
    assert.deepEqual(calls, ["gpt-5.4-nano", "gpt-4.1-mini", "gpt-4.1-nano"])
  })

  it("throws (not falls through) on NonRetryableError from primary", async () => {
    let calls: string[] = []
    await assert.rejects(
      () =>
        callWithFallback({
          apiKey: "sk-test",
          systemPrompt: "sys",
          userText: "user",
          schemaName: "s",
          schema: {},
          clientFactory: () =>
            makeClient(async (model) => {
              calls.push(model)
              return new NonRetryableError("missing_api_key")
            }),
        }),
      /missing_api_key/
    )
    assert.equal(calls.length, 1, "should not have fallen through past primary")
  })

  it("throws after exhausting all 3 tiers on persistent retryable error", async () => {
    let calls: string[] = []
    await assert.rejects(
      () =>
        callWithFallback({
          apiKey: "sk-test",
          systemPrompt: "sys",
          userText: "user",
          schemaName: "s",
          schema: {},
          clientFactory: () =>
            makeClient(async (model) => {
              calls.push(model)
              return new Error("HTTP 503 transient")
            }),
        }),
      /503/
    )
    assert.equal(calls.length, 3)
  })
})
