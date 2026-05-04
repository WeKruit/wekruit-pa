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

  it("falls back primary→secondary→tertiary then succeeds", async () => {
    const calls: string[] = []
    const result = await parseResumeText({
      apiKey: "sk-test",
      resumeText: "stub",
      retry: { sleep: async () => {}, attempts: 1 },
      clientFactory: () => ({
        responses: {
          create: async (req: Record<string, unknown>) => {
            const model = req.model as string
            calls.push(model)
            if (model === "gpt-5.4-nano" || model === "gpt-4.1-mini") {
              throw new Error("HTTP 503 overloaded")
            }
            return { output_text: JSON.stringify(VALID_PARSED), usage: {} }
          },
        },
      }),
    })
    assert.equal(result.usedTier, "tertiary")
    assert.deepEqual(calls, ["gpt-5.4-nano", "gpt-4.1-mini", "gpt-4.1-nano"])
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
