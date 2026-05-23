/**
 * Schema / JSON-schema sanity tests.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  workEntryExtractionOutput,
  llmExtractionPayload,
  LLM_JSON_SCHEMA,
} from "../schema.js"

test("llmExtractionPayload parses valid output", () => {
  const data = {
    extractedSkills: ["python", "react"],
    industryGuess: "fintech",
    responsibilityLevel: "individual_contributor",
    confidence: 0.9,
  }
  const out = llmExtractionPayload.parse(data)
  assert.deepEqual(out, data)
})

test("llmExtractionPayload rejects unknown responsibility", () => {
  assert.throws(() =>
    llmExtractionPayload.parse({
      extractedSkills: [],
      industryGuess: null,
      responsibilityLevel: "lobbyist",
      confidence: 0.5,
    })
  )
})

test("llmExtractionPayload rejects confidence out of range", () => {
  assert.throws(() =>
    llmExtractionPayload.parse({
      extractedSkills: [],
      industryGuess: null,
      responsibilityLevel: "unknown",
      confidence: 1.5,
    })
  )
})

test("workEntryExtractionOutput parses full output", () => {
  const data = {
    entryId: "abc123",
    extractedSkills: ["python"],
    durationMonths: 24,
    industryGuess: null,
    responsibilityLevel: "individual_contributor" as const,
    confidence: 0.7,
    llmModel: "gpt-5.4-nano",
    extractedAt: "2026-05-22T00:00:00.000Z",
  }
  const parsed = workEntryExtractionOutput.parse(data)
  assert.deepEqual(parsed, data)
})

test("LLM_JSON_SCHEMA matches required fields", () => {
  assert.equal(LLM_JSON_SCHEMA["type"], "object")
  assert.deepEqual(LLM_JSON_SCHEMA["required"], [
    "extractedSkills",
    "industryGuess",
    "responsibilityLevel",
    "confidence",
  ])
  assert.equal(LLM_JSON_SCHEMA["additionalProperties"], false)
})
