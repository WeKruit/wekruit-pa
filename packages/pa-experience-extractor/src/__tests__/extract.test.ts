/**
 * extract.ts tests — mock OpenAI client + in-memory cache.
 *
 * Pinned behavior:
 *   - cache hit short-circuits LLM
 *   - LLM miss path writes the full output back to cache
 *   - durationMonths is computed offline (no LLM math)
 *   - zod parse failure surfaces as NonRetryableError
 *   - missing API key fails fast
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { extractWorkEntrySkills } from "../extract.js"
import { inMemoryExtractionCache } from "../cache.js"
import type { WorkEntryExtractionInput, WorkEntryExtractionOutput } from "../types.js"

const VALID_LLM_OUTPUT = JSON.stringify({
  extractedSkills: ["python", "react"],
  industryGuess: "fintech",
  responsibilityLevel: "individual_contributor",
  confidence: 0.85,
})

function makeMockClient(payload: string) {
  const calls: Array<{ model: string; input: unknown }> = []
  const client = {
    responses: {
      create: async (req: Record<string, unknown>) => {
        calls.push({ model: req["model"] as string, input: req["input"] })
        return { output_text: payload, usage: { input_tokens: 100, output_tokens: 50 } }
      },
    },
  }
  return { client, calls }
}

function makeInput(overrides: Partial<WorkEntryExtractionInput> = {}): WorkEntryExtractionInput {
  return {
    entryId: "abc-entry-1",
    title: "Software Engineer",
    company: "Acme",
    startDate: "2022-01",
    endDate: "2024-01",
    description: "Built distributed systems.",
    bullets: ["Shipped Python services", "Owned React UI"],
    achievements: [],
    candidateSkills: ["python", "react"],
    ...overrides,
  }
}

test("extractWorkEntrySkills: returns cache hit without calling LLM", async () => {
  const cached: WorkEntryExtractionOutput = {
    entryId: "abc-entry-1",
    extractedSkills: ["python"],
    durationMonths: 24,
    industryGuess: "fintech",
    responsibilityLevel: "individual_contributor",
    confidence: 0.8,
    llmModel: "gpt-5.4-nano",
    extractedAt: "2026-01-01T00:00:00.000Z",
  }
  const cache = inMemoryExtractionCache({ "u1::abc-entry-1": cached })
  const { client, calls } = makeMockClient(VALID_LLM_OUTPUT)

  const result = await extractWorkEntrySkills({
    uid: "u1",
    input: makeInput(),
    cache,
    openaiApiKey: "fake",
    clientFactory: () => client,
  })

  assert.equal(result.source, "cache")
  assert.deepEqual(result.output, cached)
  assert.equal(calls.length, 0, "LLM must not be invoked on cache hit")
})

test("extractWorkEntrySkills: cache miss calls LLM and writes result", async () => {
  const cache = inMemoryExtractionCache()
  const { client, calls } = makeMockClient(VALID_LLM_OUTPUT)

  const result = await extractWorkEntrySkills({
    uid: "u1",
    input: makeInput(),
    cache,
    openaiApiKey: "fake",
    clientFactory: () => client,
    now: new Date("2026-05-22T00:00:00.000Z"),
  })

  assert.equal(result.source, "llm")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.model, "gpt-5.4-nano")
  assert.deepEqual(result.output.extractedSkills, ["python", "react"])
  // durationMonths: 2022-01 → 2024-01 = 24
  assert.equal(result.output.durationMonths, 24)
  assert.equal(result.output.industryGuess, "fintech")
  assert.equal(result.output.confidence, 0.85)
  // Cache must contain the result for next call.
  const fromCache = await cache.read("u1", "abc-entry-1")
  assert.deepEqual(fromCache, result.output)
})

test("extractWorkEntrySkills: durationMonths computed offline (LLM doesn't dictate)", async () => {
  const cache = inMemoryExtractionCache()
  // LLM returns no duration field at all — we ignore it.
  const { client } = makeMockClient(VALID_LLM_OUTPUT)

  const result = await extractWorkEntrySkills({
    uid: "u1",
    input: makeInput({
      entryId: "spike-1",
      startDate: "2023-06",
      endDate: "2024-06",
    }),
    cache,
    openaiApiKey: "fake",
    clientFactory: () => client,
  })
  assert.equal(result.output.durationMonths, 12)
})

test("extractWorkEntrySkills: null endDate treats as current role", async () => {
  const cache = inMemoryExtractionCache()
  const { client } = makeMockClient(VALID_LLM_OUTPUT)
  const result = await extractWorkEntrySkills({
    uid: "u1",
    input: makeInput({
      entryId: "current-role",
      startDate: "2025-01",
      endDate: null,
    }),
    cache,
    openaiApiKey: "fake",
    clientFactory: () => client,
    now: new Date("2025-07-15T00:00:00.000Z"),
  })
  // 2025-01 → 2025-07 = 6 months
  assert.equal(result.output.durationMonths, 6)
})

test("extractWorkEntrySkills: schema-invalid LLM output throws NonRetryableError", async () => {
  const cache = inMemoryExtractionCache()
  const { client } = makeMockClient(JSON.stringify({ wrong: "shape" }))
  await assert.rejects(
    () =>
      extractWorkEntrySkills({
        uid: "u1",
        input: makeInput(),
        cache,
        openaiApiKey: "fake",
        clientFactory: () => client,
        outerAttempts: 1,
      }),
    /llm_schema_parse_failed/
  )
})

test("extractWorkEntrySkills: missing API key throws", async () => {
  const cache = inMemoryExtractionCache()
  const { client } = makeMockClient(VALID_LLM_OUTPUT)
  await assert.rejects(
    () =>
      extractWorkEntrySkills({
        uid: "u1",
        input: makeInput(),
        cache,
        clientFactory: () => client,
      }),
    /missing_openai_api_key/
  )
})

test("extractWorkEntrySkills: skills are lowercased + trimmed before write", async () => {
  const cache = inMemoryExtractionCache()
  const { client } = makeMockClient(
    JSON.stringify({
      extractedSkills: ["  Python  ", "REACT", "node_js"],
      industryGuess: "  FinTech  ",
      responsibilityLevel: "individual_contributor",
      confidence: 0.9,
    })
  )
  const result = await extractWorkEntrySkills({
    uid: "u1",
    input: makeInput(),
    cache,
    openaiApiKey: "fake",
    clientFactory: () => client,
  })
  assert.deepEqual(result.output.extractedSkills, ["python", "react", "node_js"])
  assert.equal(result.output.industryGuess, "fintech")
})
