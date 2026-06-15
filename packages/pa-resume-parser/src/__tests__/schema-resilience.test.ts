/**
 * Resilience regression (2026-06-15, Chang Shu incident — cathyshu@andrew.cmu.edu):
 * a model-emitted enrichment value must NEVER fail the whole résumé parse. A
 * proposedTag with disallowed chars (e.g. "c++", "f#", "ci/cd", caps, spaces)
 * previously threw a non-retryable ZodError through ALL tiers → llm_parse_failed
 * → the candidate saw "couldn't read this resume" forever. Enrichment arrays now
 * DROP/TRUNCATE invalid entries instead of rejecting.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseResumeText } from "../parser.js"
import type { OpenAIResponsesClient } from "../providers/openai-responses.js"
import { parsedResumeData } from "../schema.js"

function clientWithJson(json: unknown): OpenAIResponsesClient {
  return { responses: { create: async () => ({ output_text: JSON.stringify(json), usage: {} }) } }
}

const base = {
  fullName: "Chang (Cathy) Shu",
  email: "cathyshu@alumni.cmu.edu",
  phone: null,
  location: "Sunnyvale, CA",
  summary: null,
  skills: ["python", "c++", "f#"],
  workHistory: [],
  education: [],
  projects: [],
  certifications: [],
  languages: [],
  interests: [],
  awards: [],
  volunteerWork: [],
  websites: [],
  totalYearsExperience: 1,
  workAuthorization: null,
  parseConfidence: 0.9,
  inferredAnswers: [],
  relevantIndustry: [],
  relevantSpecialization: [],
  proposedTags: [],
}

async function parse(payload: unknown) {
  return parseResumeText({
    apiKey: "sk-test",
    resumeText: "stub",
    retry: { sleep: async () => {}, attempts: 1 },
    clientFactory: () => clientWithJson(payload),
  })
}

describe("schema resilience — enrichment fields never fail the parse", () => {
  it("invalid proposedTags (c++, f#, ci/cd, caps, space) are DROPPED, not rejected", async () => {
    const res = await parse({
      ...base,
      proposedTags: [
        "valid_tag",
        "c++", // disallowed char
        "f#", // disallowed char
        "ci/cd", // slash
        "Has Space", // space + caps
        "AWS", // caps
        "another_valid_one",
      ],
    })
    assert.deepEqual(res.parsed.proposedTags, ["valid_tag", "another_valid_one"])
  })

  it("the exact Chang Shu failure shape no longer throws", async () => {
    // Pre-fix this threw ZodError on proposedTags[*] regex → llm_parse_failed.
    await assert.doesNotReject(() =>
      parse({ ...base, proposedTags: ["c++", "f#", "secure_authentication"] })
    )
  })

  it("over-cap proposedTags (>12) truncate instead of rejecting", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag_${i}`)
    const res = await parse({ ...base, proposedTags: many })
    assert.equal(res.parsed.proposedTags.length, 12)
  })

  it("over-cap relevantIndustry / relevantSpecialization (>6) truncate, not reject", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => `x${i}`)
    const res = await parse({ ...base, relevantIndustry: seven, relevantSpecialization: seven })
    assert.equal(res.parsed.relevantIndustry.length, 6)
    assert.equal(res.parsed.relevantSpecialization.length, 6)
  })

  it("valid enrichment still round-trips through parsedResumeData.parse", async () => {
    const res = await parse({
      ...base,
      proposedTags: ["graph_positional_encoding", "serverless_rag"],
      relevantIndustry: ["artificial_intelligence_and_machine_learning"],
    })
    assert.doesNotThrow(() => parsedResumeData.parse(res.parsed))
    assert.deepEqual(res.parsed.proposedTags, ["graph_positional_encoding", "serverless_rag"])
  })
})
