import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { connectorRegistry } from "./index.js"

const originalFetch = globalThis.fetch
const originalOpenAiApiKey = process.env.OPENAI_API_KEY
const originalCurrentInfoOpenAiApiKey = process.env.PA_CURRENT_INFO_OPENAI_API_KEY
const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL
const currentInfo = connectorRegistry["current-info"]

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of [
    ["OPENAI_API_KEY", originalOpenAiApiKey],
    ["PA_CURRENT_INFO_OPENAI_API_KEY", originalCurrentInfoOpenAiApiKey],
    ["OPENAI_BASE_URL", originalOpenAiBaseUrl],
  ] as const) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  delete process.env.PA_CURRENT_INFO_MODEL
})

test("current-info returns ok false without PA_CURRENT_INFO_OPENAI_API_KEY and does not call fetch", async () => {
  delete process.env.PA_CURRENT_INFO_OPENAI_API_KEY
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error("should not call fetch")
  }) as typeof fetch

  const result = await currentInfo.execute(
    { query: "latest movie news", nowIso: "2026-04-26T12:00:00.000Z" }
  )

  assert.equal(fetchCalls, 0)
  assert.equal(result.ok, false)
  assert.equal(result.source, "openai-web-search")
  assert.equal(result.asOf, "2026-04-26T12:00:00.000Z")
  assert.match(result.summary, /PA_CURRENT_INFO_OPENAI_API_KEY is not configured/)
  assert.deepEqual(result.sources, [])
})

test("current-info ignores global OPENAI_API_KEY when it is a SiliconFlow alias", async () => {
  process.env.OPENAI_API_KEY = "siliconflow-key"
  process.env.OPENAI_BASE_URL = "https://api.siliconflow.cn/v1"
  delete process.env.PA_CURRENT_INFO_OPENAI_API_KEY
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error("should not call fetch")
  }) as typeof fetch

  const result = await currentInfo.execute(
    { query: "latest movie news", nowIso: "2026-04-26T12:00:00.000Z" }
  )

  assert.equal(fetchCalls, 0)
  assert.equal(result.ok, false)
  assert.match(result.summary, /PA_CURRENT_INFO_OPENAI_API_KEY is not configured/)
})

test("current-info calls Responses API web_search and extracts citations", async () => {
  process.env.OPENAI_API_KEY = "siliconflow-key"
  process.env.OPENAI_BASE_URL = "https://api.siliconflow.cn/v1"
  process.env.PA_CURRENT_INFO_OPENAI_API_KEY = "test-key"
  process.env.PA_CURRENT_INFO_MODEL = "test-model"
  let requestBody: Record<string, unknown> | null = null
  let authorization = ""
  globalThis.fetch = (async (_url, init) => {
    authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "")
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        output_text: "Fresh sourced answer.",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Fresh sourced answer.",
                annotations: [
                  { type: "url_citation", title: "Example A", url: "https://example.com/a" },
                ],
              },
            ],
          },
          {
            type: "web_search_call",
            action: {
              sources: [{ title: "Example B", url: "https://example.com/b" }],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  }) as typeof fetch

  const result = await currentInfo.execute(
    {
      query: "what is current",
      nowIso: "2026-04-26T12:00:00.000Z",
      locale: "en-US",
      location: "Chicago, IL",
    }
  )

  assert.equal(authorization, "Bearer test-key")
  assert.ok(requestBody)
  const body = requestBody as Record<string, unknown>
  assert.equal(body.model, "test-model")
  assert.deepEqual(body.tools, [{ type: "web_search" }])
  assert.deepEqual(body.include, ["web_search_call.action.sources"])
  assert.equal(body.max_tool_calls, 1)
  assert.equal(result.ok, true)
  assert.equal(result.summary, "Fresh sourced answer.")
  assert.deepEqual(result.sources, [
    { title: "Example A", url: "https://example.com/a" },
    { title: "Example B", url: "https://example.com/b" },
  ])
})
