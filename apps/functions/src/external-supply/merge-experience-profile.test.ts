/**
 * Unit tests for the unified merge+determine extractor. The LLM is MOCKED (no live call) by injecting
 * a fake `llmCall` (deps-injection — the codebase-standard stub, since the test runner has no
 * `--experimental-test-module-mocks`). We assert:
 *   (a) the merged set keeps a LinkedIn-only role AND a résumé-only role (no source dropped);
 *   (b) a same-employer role is deduped to one;
 *   (c) careerStage validation rejects a bogus enum value the mock returns;
 *   (d) fail-open returns null with no API key (default path, no mock).
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  mergeAndDetermineProfile,
  toSourceFromLinkedin,
  toSourceFromResume,
  type MergeAndDetermineResult,
  type MergeLlmCall,
} from "./merge-experience-profile.js"

const ORIGINAL_KEY = process.env.PA_OPENAI_AGENT_API_KEY

/** Build a fake llmCall that returns the given object as JSON. */
function fakeLlm(payload: unknown): MergeLlmCall {
  return async () => JSON.stringify(payload)
}

test("merged set keeps a LinkedIn-only role AND a résumé-only role (no source dropped)", async () => {
  const payload: MergeAndDetermineResult = {
    mergedExperiences: [
      { title: "Senior Software Engineer", company: "Acme", isCurrent: true, startDate: "2024-02" },
      { title: "Software Engineer", company: "Startup Inc", isCurrent: false, startDate: "2021-06", endDate: "2024-01" },
    ],
    recentRoleTitle: "Senior Software Engineer",
    recentCompany: "Acme",
    careerStage: "senior",
    yoeRange: [3, 5],
  }
  const result = await mergeAndDetermineProfile(
    {
      linkedinExperiences: [{ title: "Senior Software Engineer", company: "Acme", isCurrent: true, startDate: "2024-02" }],
      resumeExperiences: [
        { title: "Software Engineer", company: "Startup Inc", startDate: "2021-06", endDate: "2024-01", description: "Built X" },
      ],
    },
    { llmCall: fakeLlm(payload) },
  )
  assert.ok(result, "result should not be null")
  assert.equal(result!.mergedExperiences.length, 2)
  const companies = result!.mergedExperiences.map((e) => e.company)
  assert.ok(companies.includes("Acme"), "LinkedIn-only role kept")
  assert.ok(companies.includes("Startup Inc"), "résumé-only role kept")
  assert.equal(result!.recentRoleTitle, "Senior Software Engineer")
  assert.equal(result!.careerStage, "senior")
  assert.deepEqual(result!.yoeRange, [3, 5])
})

test("same-employer role is deduped to one entry (the bug case: senior beats stale intern title)", async () => {
  // The model returns ONE merged Acme entry (deduped) carrying the fresher Senior title + résumé detail.
  const payload: MergeAndDetermineResult = {
    mergedExperiences: [
      {
        title: "Senior Software Engineer",
        company: "Acme",
        isCurrent: true,
        startDate: "2024-02",
        description: "Shipped infra handling 10k calls/day",
      },
    ],
    recentRoleTitle: "Senior Software Engineer",
    recentCompany: "Acme",
    careerStage: "senior",
    yoeRange: [3, 4],
  }
  const result = await mergeAndDetermineProfile(
    {
      // SAME employer, disagreeing titles across sources — LinkedIn fresh senior vs résumé stale intern.
      linkedinExperiences: [{ title: "Senior Software Engineer", company: "Acme", isCurrent: true, startDate: "2024-02" }],
      resumeExperiences: [{ title: "Software Engineer Intern", company: "Acme", startDate: "2021-06", description: "Shipped infra handling 10k calls/day" }],
    },
    { llmCall: fakeLlm(payload) },
  )
  assert.ok(result)
  assert.equal(result!.mergedExperiences.length, 1, "same-employer role deduped to one")
  assert.equal(result!.mergedExperiences[0]!.title, "Senior Software Engineer", "fresher title wins, not stale intern")
  assert.equal(result!.recentRoleTitle, "Senior Software Engineer")
  assert.notEqual(result!.careerStage, "intern")
})

test("careerStage validation rejects a bogus enum value (drops careerStage, keeps the rest)", async () => {
  const payload = {
    mergedExperiences: [{ title: "Engineer", company: "Acme", isCurrent: true, startDate: "2024-02", endDate: null, description: null }],
    recentRoleTitle: "Engineer",
    recentCompany: "Acme",
    careerStage: "super_senior_wizard", // NOT in CAREER_STAGE_VOCAB
    yoeRange: [4, 6],
  }
  const result = await mergeAndDetermineProfile(
    {
      linkedinExperiences: [{ title: "Engineer", company: "Acme", isCurrent: true, startDate: "2024-02" }],
      resumeExperiences: [],
    },
    { llmCall: fakeLlm(payload) },
  )
  assert.ok(result, "merge still returns (fail-open is per-field for careerStage)")
  assert.equal(result!.careerStage, undefined, "bogus careerStage dropped")
  assert.equal(result!.recentRoleTitle, "Engineer", "other fields preserved")
  assert.deepEqual(result!.yoeRange, [4, 6])
})

test("fail-open returns null with no API key (default LLM path, existing data left untouched)", async () => {
  delete process.env.PA_OPENAI_AGENT_API_KEY
  // Use the DEFAULT llmCall (no mock) so the no-key guard inside defaultMergeLlmCall returns "" → null.
  const result = await mergeAndDetermineProfile({
    linkedinExperiences: [{ title: "Engineer", company: "Acme" }],
    resumeExperiences: [{ title: "Engineer", company: "Acme" }],
  })
  assert.equal(result, null, "no key → null → caller leaves existing tags/highlights")
})

test("nothing to merge (both sources empty) returns null (no-op fail-open, no LLM call)", async () => {
  let called = false
  const result = await mergeAndDetermineProfile(
    { linkedinExperiences: [], resumeExperiences: [] },
    {
      llmCall: async () => {
        called = true
        return "{}"
      },
    },
  )
  assert.equal(result, null)
  assert.equal(called, false, "empty input short-circuits before any LLM call")
})

test("LLM error fails open → null (existing data untouched)", async () => {
  const result = await mergeAndDetermineProfile(
    { linkedinExperiences: [{ title: "Engineer", company: "Acme" }], resumeExperiences: [] },
    {
      llmCall: async () => {
        throw new Error("boom")
      },
    },
  )
  assert.equal(result, null, "thrown LLM error caught → null")
})

test("unparseable LLM output fails open → null", async () => {
  const result = await mergeAndDetermineProfile(
    { linkedinExperiences: [{ title: "Engineer", company: "Acme" }], resumeExperiences: [] },
    { llmCall: async () => "not json {{{" },
  )
  assert.equal(result, null)
})

test("toSourceFromResume surfaces bullets as the merged description; toSourceFromLinkedin maps currentRole→isCurrent", () => {
  const fromResume = toSourceFromResume({
    title: "Software Engineer",
    company: "Acme",
    bullets: ["Built infra handling 10k calls/day", "Cut p95 latency 40%"],
  })
  assert.equal(fromResume.description, "Built infra handling 10k calls/day • Cut p95 latency 40%")
  assert.equal(fromResume.title, "Software Engineer")

  const fromLi = toSourceFromLinkedin({ title: "Senior Software Engineer", company: "Acme", currentRole: true, startDate: "2024-02" })
  assert.equal(fromLi.isCurrent, true)
  assert.equal(fromLi.startDate, "2024-02")
})

test.after(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.PA_OPENAI_AGENT_API_KEY
  else process.env.PA_OPENAI_AGENT_API_KEY = ORIGINAL_KEY
})
