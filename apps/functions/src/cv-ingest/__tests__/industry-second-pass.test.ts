/**
 * Phase 53 (PARSE-08, D15) — industry-second-pass tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runIndustrySecondPass } from "../industry-second-pass.js"

function captureLog() {
  const events: Array<{ event: string; payload?: Record<string, unknown> }> = []
  return {
    events,
    log: (event: string, payload?: Record<string, unknown>) => {
      events.push({ event, payload })
    },
  }
}

describe("runIndustrySecondPass", () => {
  it("Anthropic key missing + no OpenAI key → returns []", async () => {
    const { events, log } = captureLog()
    // Save and clear env
    const oldOpenAi = process.env.OPENAI_API_KEY
    const oldAgent = process.env.PA_OPENAI_AGENT_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.PA_OPENAI_AGENT_API_KEY
    try {
      const result = await runIndustrySecondPass({
        cvText: "Software engineer at Stripe",
        workHistory: [{ title: "SWE", company: "Stripe" }],
        apiKey: undefined,
        log,
      })
      assert.deepEqual(result, [])
      const skipped = events.find(
        (e) =>
          e.event === "pa.cv_ingest.industry_second_pass.all_failed" ||
          (e.event === "pa.cv_ingest.industry_second_pass.skipped" &&
            (e.payload as Record<string, unknown>).reason === "no_anthropic_key")
      )
      assert.ok(skipped, "expected skipped or all_failed log")
    } finally {
      if (oldOpenAi) process.env.OPENAI_API_KEY = oldOpenAi
      if (oldAgent) process.env.PA_OPENAI_AGENT_API_KEY = oldAgent
    }
  })

  it("Anthropic returns canonical industries → result", async () => {
    const { log } = captureLog()
    const result = await runIndustrySecondPass({
      cvText: "Senior Software Engineer at Stripe and Block.",
      workHistory: [
        { title: "SWE", company: "Stripe" },
        { title: "Tech Lead", company: "Block" },
      ],
      apiKey: "sk-ant-test",
      log,
      anthropicClientFactory: async () => ({
        messages: {
          async create(params) {
            // Verify request shape
            assert.equal(params.model, "claude-sonnet-4-6")
            const tools = params.tools as Array<Record<string, unknown>>
            assert.equal(tools[0]!.name, "industry_classifier")
            return {
              content: [
                {
                  type: "tool_use",
                  name: "industry_classifier",
                  input: {
                    industries: ["financial_technology", "software_and_saas"],
                    reasoning: "Stripe and Block are payment / fintech companies.",
                  },
                },
              ],
            }
          },
        },
      }),
    })
    assert.deepEqual(result, ["financial_technology", "software_and_saas"])
  })

  it("Anthropic returns non-canonical token → filtered out", async () => {
    const { log } = captureLog()
    const result = await runIndustrySecondPass({
      cvText: "SWE",
      workHistory: [{ title: "SWE", company: "X" }],
      apiKey: "sk-ant-test",
      log,
      anthropicClientFactory: async () => ({
        messages: {
          async create() {
            return {
              content: [
                {
                  type: "tool_use",
                  name: "industry_classifier",
                  input: {
                    industries: ["bogus_industry", "software_and_saas"],
                    reasoning: "...",
                  },
                },
              ],
            }
          },
        },
      }),
    })
    assert.deepEqual(result, ["software_and_saas"])
  })

  it("Anthropic throws → falls back to OpenAI", async () => {
    const { events, log } = captureLog()
    const result = await runIndustrySecondPass({
      cvText: "SWE",
      workHistory: [{ title: "SWE", company: "X" }],
      apiKey: "sk-ant-test",
      openAiApiKey: "sk-test",
      log,
      anthropicClientFactory: async () => ({
        messages: {
          async create() {
            throw new Error("HTTP 503 overloaded")
          },
        },
      }),
      openAiClientFactory: async () => ({
        responses: {
          async create() {
            return {
              output_text: JSON.stringify({
                industries: ["software_and_saas"],
                reasoning: "fallback",
              }),
            }
          },
        },
      }),
    })
    assert.deepEqual(result, ["software_and_saas"])
    const ok = events.find(
      (e) => e.event === "pa.cv_ingest.industry_second_pass.openai_ok"
    )
    assert.ok(ok, "expected openai_ok log after fallback")
  })

  it("both Anthropic and OpenAI fail → returns []", async () => {
    const { events, log } = captureLog()
    const result = await runIndustrySecondPass({
      cvText: "SWE",
      workHistory: [{ title: "SWE", company: "X" }],
      apiKey: "sk-ant-test",
      openAiApiKey: "sk-test",
      log,
      anthropicClientFactory: async () => ({
        messages: {
          async create() {
            throw new Error("HTTP 503")
          },
        },
      }),
      openAiClientFactory: async () => ({
        responses: {
          async create() {
            throw new Error("HTTP 502")
          },
        },
      }),
    })
    assert.deepEqual(result, [])
    const failed = events.find(
      (e) => e.event === "pa.cv_ingest.industry_second_pass.all_failed"
    )
    assert.ok(failed, "expected all_failed log")
  })

  it("Anthropic empty tool_use → falls back to OpenAI", async () => {
    const { log } = captureLog()
    const result = await runIndustrySecondPass({
      cvText: "SWE",
      workHistory: [{ title: "SWE", company: "X" }],
      apiKey: "sk-ant-test",
      openAiApiKey: "sk-test",
      log,
      anthropicClientFactory: async () => ({
        messages: {
          async create() {
            return { content: [{ type: "text", text: "I cannot answer." }] }
          },
        },
      }),
      openAiClientFactory: async () => ({
        responses: {
          async create() {
            return {
              output_text: JSON.stringify({
                industries: ["financial_technology"],
                reasoning: "fallback",
              }),
            }
          },
        },
      }),
    })
    assert.deepEqual(result, ["financial_technology"])
  })
})
