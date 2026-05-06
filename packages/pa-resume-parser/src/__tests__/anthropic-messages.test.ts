import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  callAnthropicMessages,
  type AnthropicMessagesClient,
} from "../providers/anthropic-messages.js"
import { isRetryable, NonRetryableError } from "../retry.js"

const VALID_INPUT = { fullName: "Adam", skills: ["TypeScript"] }

function makeClient(
  handler: (params: Record<string, unknown>) => Promise<unknown>
): AnthropicMessagesClient {
  return {
    messages: {
      create: async (params: Record<string, unknown>) => {
        const r = await handler(params)
        if (r instanceof Error) throw r
        return r as never
      },
    },
  }
}

describe("callAnthropicMessages", () => {
  it("throws retryable error when apiKey is undefined (graceful fallthrough)", async () => {
    let err: unknown = null
    try {
      await callAnthropicMessages({
        apiKey: undefined,
        model: "claude-sonnet-4-6",
        systemPrompt: "sys",
        userText: "user",
        schemaName: "parsed_resume_data",
        schema: {},
        maxRetries: 2,
      })
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof Error, "must throw an Error")
    assert.equal(isRetryable(err), true, "missing-key error must be retryable for fallthrough")
    assert.match(
      (err as Error).message,
      /ANTHROPIC_API_KEY|not configured|falling through/i
    )
  })

  it("throws retryable error when apiKey is empty string", async () => {
    let err: unknown = null
    try {
      await callAnthropicMessages({
        apiKey: "",
        model: "claude-sonnet-4-6",
        systemPrompt: "sys",
        userText: "user",
        schemaName: "parsed_resume_data",
        schema: {},
        maxRetries: 2,
      })
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof Error)
    assert.equal(isRetryable(err), true)
  })

  it("returns rawJson + usage on successful tool_use response", async () => {
    const result = await callAnthropicMessages({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
      systemPrompt: "sys",
      userText: "user",
      schemaName: "parsed_resume_data",
      schema: { type: "object" },
      maxRetries: 2,
      clientFactory: () =>
        makeClient(async (params) => {
          // Verify params shape
          assert.equal(params.model, "claude-sonnet-4-6")
          assert.equal((params.system as string), "sys")
          assert.deepEqual(
            (params.tool_choice as Record<string, unknown>),
            { type: "tool", name: "parsed_resume_data" }
          )
          return {
            content: [
              { type: "tool_use", name: "parsed_resume_data", input: VALID_INPUT },
            ],
            usage: { input_tokens: 100, output_tokens: 50 },
          }
        }),
    })
    assert.equal(result.rawJson, JSON.stringify(VALID_INPUT))
    assert.equal(result.usage?.input_tokens, 100)
    assert.equal(result.usage?.output_tokens, 50)
    assert.equal(result.usage?.total_tokens, 150)
  })

  it("throws NonRetryableError when response missing tool_use block", async () => {
    let err: unknown = null
    try {
      await callAnthropicMessages({
        apiKey: "sk-ant-test",
        model: "claude-sonnet-4-6",
        systemPrompt: "sys",
        userText: "user",
        schemaName: "parsed_resume_data",
        schema: {},
        maxRetries: 2,
        clientFactory: () =>
          makeClient(async () => ({
            content: [{ type: "text", text: "I cannot answer." }],
            usage: { input_tokens: 10, output_tokens: 5 },
          })),
      })
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof NonRetryableError)
    assert.match((err as Error).message, /missing_tool_use/)
    assert.equal(isRetryable(err), false)
  })

  it("throws NonRetryableError when tool_use input is missing", async () => {
    let err: unknown = null
    try {
      await callAnthropicMessages({
        apiKey: "sk-ant-test",
        model: "claude-sonnet-4-6",
        systemPrompt: "sys",
        userText: "user",
        schemaName: "parsed_resume_data",
        schema: {},
        maxRetries: 2,
        clientFactory: () =>
          makeClient(async () => ({
            content: [
              { type: "tool_use", name: "parsed_resume_data", input: null },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          })),
      })
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof NonRetryableError)
    assert.match((err as Error).message, /input_missing/)
  })

  it("throws when response is malformed (no content array)", async () => {
    let err: unknown = null
    try {
      await callAnthropicMessages({
        apiKey: "sk-ant-test",
        model: "claude-sonnet-4-6",
        systemPrompt: "sys",
        userText: "user",
        schemaName: "parsed_resume_data",
        schema: {},
        maxRetries: 2,
        clientFactory: () =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          makeClient(async () => ({} as any)),
      })
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof Error)
    assert.match((err as Error).message, /malformed/)
  })

  it("propagates SDK errors (e.g. 5xx) to caller", async () => {
    let err: unknown = null
    try {
      await callAnthropicMessages({
        apiKey: "sk-ant-test",
        model: "claude-sonnet-4-6",
        systemPrompt: "sys",
        userText: "user",
        schemaName: "parsed_resume_data",
        schema: {},
        maxRetries: 2,
        clientFactory: () =>
          makeClient(async () => new Error("HTTP 503 overloaded")),
      })
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof Error)
    assert.match((err as Error).message, /503/)
    assert.equal(isRetryable(err), true, "5xx must be retryable")
  })
})
