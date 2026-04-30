import { test } from "node:test"
import assert from "node:assert/strict"

import {
  chatCompletion,
  embed,
  resolveApiKey,
  resolveBaseUrl,
} from "./sf-client.mjs"

test("resolveApiKey: explicit override wins", () => {
  assert.equal(resolveApiKey("explicit-key"), "explicit-key")
})

test("resolveApiKey: env chain order SILICONFLOW > PA_OPENAI_AGENT > PA_SILICONFLOW", () => {
  const orig = {
    SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY,
    PA_OPENAI_AGENT_API_KEY: process.env.PA_OPENAI_AGENT_API_KEY,
    PA_SILICONFLOW_API_KEY: process.env.PA_SILICONFLOW_API_KEY,
  }
  try {
    delete process.env.SILICONFLOW_API_KEY
    delete process.env.PA_OPENAI_AGENT_API_KEY
    delete process.env.PA_SILICONFLOW_API_KEY

    process.env.PA_SILICONFLOW_API_KEY = "fallback-key"
    assert.equal(resolveApiKey(), "fallback-key")

    process.env.PA_OPENAI_AGENT_API_KEY = "agent-key"
    assert.equal(resolveApiKey(), "agent-key")

    process.env.SILICONFLOW_API_KEY = "primary-key"
    assert.equal(resolveApiKey(), "primary-key")
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("resolveApiKey: returns null when nothing set", () => {
  const orig = {
    SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY,
    PA_OPENAI_AGENT_API_KEY: process.env.PA_OPENAI_AGENT_API_KEY,
    PA_SILICONFLOW_API_KEY: process.env.PA_SILICONFLOW_API_KEY,
  }
  try {
    delete process.env.SILICONFLOW_API_KEY
    delete process.env.PA_OPENAI_AGENT_API_KEY
    delete process.env.PA_SILICONFLOW_API_KEY
    assert.equal(resolveApiKey(), null)
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("resolveBaseUrl: defaults to siliconflow.cn/v1", () => {
  const prev = process.env.SILICONFLOW_BASE_URL
  delete process.env.SILICONFLOW_BASE_URL
  try {
    assert.equal(resolveBaseUrl(), "https://api.siliconflow.cn/v1")
  } finally {
    if (prev !== undefined) process.env.SILICONFLOW_BASE_URL = prev
  }
})

test("resolveBaseUrl: env override", () => {
  const prev = process.env.SILICONFLOW_BASE_URL
  process.env.SILICONFLOW_BASE_URL = "https://example.test/api"
  try {
    assert.equal(resolveBaseUrl(), "https://example.test/api")
  } finally {
    if (prev === undefined) delete process.env.SILICONFLOW_BASE_URL
    else process.env.SILICONFLOW_BASE_URL = prev
  }
})

test("chatCompletion: throws on missing API key", async () => {
  const orig = {
    SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY,
    PA_OPENAI_AGENT_API_KEY: process.env.PA_OPENAI_AGENT_API_KEY,
    PA_SILICONFLOW_API_KEY: process.env.PA_SILICONFLOW_API_KEY,
  }
  try {
    delete process.env.SILICONFLOW_API_KEY
    delete process.env.PA_OPENAI_AGENT_API_KEY
    delete process.env.PA_SILICONFLOW_API_KEY
    await assert.rejects(
      () => chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
      /no API key/i
    )
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("chatCompletion: throws on empty messages", async () => {
  await assert.rejects(
    () => chatCompletion({ messages: [], opts: { api_key: "x" } }),
    /messages required/i
  )
})

test("chatCompletion: success path with mock fetch", async () => {
  const calls = []
  /** @type {any} */
  const mockFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "mock reply" } }],
        usage: { prompt_tokens: 42, completion_tokens: 13 },
      }),
    }
  }
  const result = await chatCompletion({
    messages: [{ role: "user", content: "hi" }],
    opts: {
      model: "Qwen/Qwen2.5-7B-Instruct",
      api_key: "test-key",
      fetchImpl: mockFetch,
    },
  })
  assert.equal(result.text, "mock reply")
  assert.equal(result.usage.inputTokens, 42)
  assert.equal(result.usage.outputTokens, 13)
  assert.equal(result.model, "Qwen/Qwen2.5-7B-Instruct")
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/chat\/completions$/)
  assert.equal(calls[0].body.model, "Qwen/Qwen2.5-7B-Instruct")
})

test("chatCompletion: HTTP error throws", async () => {
  /** @type {any} */
  const mockFetch = async () => ({
    ok: false,
    status: 500,
    text: async () => "internal error",
  })
  await assert.rejects(
    () =>
      chatCompletion({
        messages: [{ role: "user", content: "hi" }],
        opts: { api_key: "x", fetchImpl: mockFetch },
      }),
    /HTTP 500/
  )
})

test("embed: success path with mock fetch", async () => {
  /** @type {any} */
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      usage: { prompt_tokens: 10 },
    }),
  })
  const result = await embed({
    input: ["a", "b"],
    opts: { api_key: "x", fetchImpl: mockFetch },
  })
  assert.equal(result.embeddings.length, 2)
  assert.deepEqual(result.embeddings[0], [0.1, 0.2])
  assert.equal(result.usage.inputTokens, 10)
})

test("embed: throws on empty input", async () => {
  await assert.rejects(
    () => embed({ input: [], opts: { api_key: "x" } }),
    /input required/i
  )
})

test("chatCompletion: passes temperature/max_tokens/top_p", async () => {
  /** @type {any} */
  let captured = null
  /** @type {any} */
  const mockFetch = async (url, init) => {
    captured = JSON.parse(init.body)
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "" } }], usage: {} }),
    }
  }
  await chatCompletion({
    messages: [{ role: "user", content: "hi" }],
    opts: {
      api_key: "x",
      fetchImpl: mockFetch,
      temperature: 0.7,
      max_tokens: 100,
      top_p: 0.95,
    },
  })
  assert.equal(captured.temperature, 0.7)
  assert.equal(captured.max_tokens, 100)
  assert.equal(captured.top_p, 0.95)
})
