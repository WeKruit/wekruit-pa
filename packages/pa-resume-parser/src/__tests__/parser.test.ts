import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseResumeText } from "../parser.js"
import type { OpenAIResponsesClient } from "../providers/openai-responses.js"

const VALID_PARSED = {
  fullName: "Adam Test",
  email: "adam@example.com",
  phone: null,
  location: "Bay Area",
  summary: "Senior eng",
  skills: ["TypeScript", "Python"],
  workHistory: [
    {
      title: "Eng",
      company: "Acme",
      location: null,
      experienceType: "full-time",
      startDate: "2022-01",
      endDate: null,
      currentRole: true,
      description: null,
      bullets: ["Built systems"],
      achievements: [],
    },
  ],
  education: [
    {
      school: "MIT",
      degree: "BSc CS",
      degreeType: "bachelor-of-science",
      fieldOfStudy: "CS",
      major: "CS",
      gpa: null,
      startDate: "2014-09",
      endDate: "2018-05",
      expectedGraduation: null,
      honors: null,
    },
  ],
  projects: [],
  certifications: [],
  languages: ["English"],
  interests: [],
  awards: [],
  volunteerWork: [],
  websites: [],
  totalYearsExperience: 4,
  workAuthorization: "US Citizen",
  parseConfidence: 0.92,
  inferredAnswers: [
    { question: "Years of experience?", answer: "4", confidence: 0.9, category: "experience" },
  ],
  // Phase 53 (PARSE-03..PARSE-05) extensions
  relevantIndustry: ["software_and_saas"],
  relevantSpecialization: ["backend_development"],
  proposedTags: ["b2b_saas", "developer_tools"],
}

function clientWithJson(json: unknown): OpenAIResponsesClient {
  return {
    responses: {
      create: async () => ({ output_text: JSON.stringify(json), usage: {} }),
    },
  }
}

describe("parseResumeText", () => {
  it("parses valid JSON into ParsedResumeData", async () => {
    const result = await parseResumeText({
      apiKey: "sk-test",
      resumeText: "stub resume text",
      clientFactory: () => clientWithJson(VALID_PARSED),
    })
    assert.equal(result.parsed.fullName, "Adam Test")
    assert.equal(result.usedTier, "primary")
    assert.equal(result.parsed.workHistory[0]!.bullets[0], "Built systems")
    assert.equal(result.parsed.inferredAnswers[0]!.category, "experience")
    // Phase 53 — extended fields parse correctly
    assert.deepEqual(result.parsed.relevantIndustry, ["software_and_saas"])
    assert.deepEqual(result.parsed.relevantSpecialization, ["backend_development"])
    assert.deepEqual(result.parsed.proposedTags, ["b2b_saas", "developer_tools"])
  })

  it("Phase 53 extended fields default to [] when LLM omits them", async () => {
    // Simulate older/laxer model output that doesn't include the new fields.
    // Zod `.default([])` should fill them in.
    const minimalParsed = { ...VALID_PARSED } as Record<string, unknown>
    delete minimalParsed.relevantIndustry
    delete minimalParsed.relevantSpecialization
    delete minimalParsed.proposedTags
    const result = await parseResumeText({
      apiKey: "sk-test",
      resumeText: "stub",
      clientFactory: () => clientWithJson(minimalParsed),
    })
    assert.deepEqual(result.parsed.relevantIndustry, [])
    assert.deepEqual(result.parsed.relevantSpecialization, [])
    assert.deepEqual(result.parsed.proposedTags, [])
  })

  it("DROPS invalid proposedTags instead of failing the parse (Chang Shu resilience 2026-06-15)", async () => {
    const badParsed = {
      ...VALID_PARSED,
      // Mix of invalid (empty, disallowed chars, caps) and valid tokens. The
      // invalid ones must be filtered out — NOT throw and block the candidate.
      proposedTags: ["", "c++", "f#", "Caps", "valid_tag"],
    }
    const result = await parseResumeText({
      apiKey: "sk-test",
      resumeText: "stub",
      retry: { attempts: 1, sleep: async () => {} },
      clientFactory: () => clientWithJson(badParsed),
    })
    assert.deepEqual(result.parsed.proposedTags, ["valid_tag"])
  })

  it("Phase 53 — falls through to Anthropic secondary when primary 5xx", async () => {
    const calls: string[] = []
    const result = await parseResumeText({
      apiKey: "sk-test",
      anthropicApiKey: "sk-ant-test",
      resumeText: "stub",
      retry: { sleep: async () => {}, attempts: 1 },
      clientFactory: () => ({
        responses: {
          create: async (req: Record<string, unknown>) => {
            calls.push(`openai:${req.model}`)
            throw new Error("HTTP 503 overloaded")
          },
        },
      }),
      anthropicClientFactory: () => ({
        messages: {
          create: async (params: Record<string, unknown>) => {
            calls.push(`anthropic:${params.model}`)
            return {
              content: [
                { type: "tool_use", name: "parsed_resume_data", input: VALID_PARSED },
              ],
              usage: { input_tokens: 100, output_tokens: 50 },
            } as never
          },
        },
      }),
    })
    assert.equal(result.usedTier, "secondary")
    assert.equal(result.usedModel, "claude-sonnet-4-6")
    assert.equal(result.parsed.fullName, "Adam Test")
    assert.deepEqual(calls, ["openai:gpt-5.4-nano", "anthropic:claude-sonnet-4-6"])
  })

  it("Phase 53 — Anthropic missing key falls through to gpt-4.1-mini final tier", async () => {
    const calls: string[] = []
    const result = await parseResumeText({
      apiKey: "sk-test",
      // Anthropic key NOT provided — provider throws retryable, router moves on
      resumeText: "stub",
      retry: { sleep: async () => {}, attempts: 1 },
      clientFactory: () => ({
        responses: {
          create: async (req: Record<string, unknown>) => {
            const model = req.model as string
            calls.push(`openai:${model}`)
            if (model === "gpt-5.4-nano") {
              throw new Error("HTTP 503 overloaded")
            }
            return { output_text: JSON.stringify(VALID_PARSED), usage: {} } as never
          },
        },
      }),
    })
    assert.equal(result.usedTier, "tertiary")
    assert.equal(result.usedModel, "gpt-4.1-mini")
    assert.deepEqual(calls, ["openai:gpt-5.4-nano", "openai:gpt-4.1-mini"])
  })

  it("retries via outer retry on transient 5xx then succeeds", async () => {
    let calls = 0
    const result = await parseResumeText({
      apiKey: "sk-test",
      resumeText: "stub",
      retry: { sleep: async () => {} },
      clientFactory: () => ({
        responses: {
          create: async () => {
            calls++
            if (calls < 2) throw new Error("HTTP 503 overloaded")
            return { output_text: JSON.stringify(VALID_PARSED), usage: {} }
          },
        },
      }),
    })
    assert.equal(result.parsed.fullName, "Adam Test")
    // calls = 1 (primary fails) + 1 retry-attempt outer (primary success) = ≥2
    assert.ok(calls >= 2)
  })

  it("falls back primary→secondary(Anthropic)→tertiary then succeeds", async () => {
    const openaiCalls: string[] = []
    const anthropicCalls: string[] = []
    const result = await parseResumeText({
      apiKey: "sk-test",
      anthropicApiKey: "sk-ant-test",
      resumeText: "stub",
      retry: { sleep: async () => {}, attempts: 1 },
      clientFactory: () => ({
        responses: {
          create: async (req: Record<string, unknown>) => {
            const model = req.model as string
            openaiCalls.push(model)
            if (model === "gpt-5.4-nano") {
              throw new Error("HTTP 503 overloaded")
            }
            return { output_text: JSON.stringify(VALID_PARSED), usage: {} }
          },
        },
      }),
      anthropicClientFactory: () => ({
        messages: {
          create: async (params: Record<string, unknown>) => {
            anthropicCalls.push(params.model as string)
            throw new Error("HTTP 529 overloaded")
          },
        },
      }),
    })
    assert.equal(result.usedTier, "tertiary")
    assert.equal(result.usedModel, "gpt-4.1-mini")
    assert.deepEqual(openaiCalls, ["gpt-5.4-nano", "gpt-4.1-mini"])
    assert.deepEqual(anthropicCalls, ["claude-sonnet-4-6"])
  })

  it("truncates over-generated skills to SKILLS_MAX (does NOT reject)", async () => {
    // Model ignores the breadth instruction and returns 45 skills (the
    // Jyesht-Diwani platform-atomization failure mode). Parser must keep the
    // first 25 (prompt orders most-relevant-first) and still succeed.
    const overGenerated = {
      ...VALID_PARSED,
      skills: Array.from({ length: 45 }, (_, i) => `skill_${i}`),
    }
    const result = await parseResumeText({
      apiKey: "sk-test",
      resumeText: "stub",
      clientFactory: () => clientWithJson(overGenerated),
    })
    assert.equal(result.parsed.skills.length, 25)
    assert.equal(result.parsed.skills[0], "skill_0")
    assert.equal(result.parsed.skills[24], "skill_24")
  })

  it("leaves a normal-length skills list unchanged", async () => {
    const result = await parseResumeText({
      apiKey: "sk-test",
      resumeText: "stub",
      clientFactory: () => clientWithJson(VALID_PARSED),
    })
    assert.deepEqual(result.parsed.skills, ["TypeScript", "Python"])
  })

  it("rejects on Zod schema-violation (parser throws)", async () => {
    const bad = { fullName: 42 } // wrong types — Zod will reject
    await assert.rejects(
      () =>
        parseResumeText({
          apiKey: "sk-test",
          resumeText: "stub",
          retry: { attempts: 1, sleep: async () => {} },
          clientFactory: () => clientWithJson(bad),
        })
    )
  })
})
