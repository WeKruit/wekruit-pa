/**
 * Pure unit tests for `deriveExperienceModel` — no I/O, deterministic.
 *
 * Covers acceptance criteria from AGENT_PLAN §9 PR-A:
 *   - aggregation across multiple entries
 *   - skillRecency picks the latest endDate (or "present")
 *   - titleTrajectory sorts by startDate
 *   - unverifiedSkills = claimed − union(extracted)
 *   - same input → same output (idempotency)
 *   - seniority inference from latest title
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { deriveExperienceModel } from "../derive.js"
import type { WorkEntryExtractionOutput } from "../types.js"

function makeEntry(opts: {
  title: string
  startDate: string | null
  endDate: string | null
  durationMonths: number
  skills: string[]
  industry?: string | null
  responsibility?: WorkEntryExtractionOutput["responsibilityLevel"]
}): {
  output: WorkEntryExtractionOutput
  startDate: string | null
  endDate: string | null
  title: string
} {
  return {
    title: opts.title,
    startDate: opts.startDate,
    endDate: opts.endDate,
    output: {
      entryId: `entry-${opts.title.replace(/\s+/g, "-").toLowerCase()}`,
      extractedSkills: opts.skills,
      durationMonths: opts.durationMonths,
      industryGuess: opts.industry ?? null,
      responsibilityLevel: opts.responsibility ?? "individual_contributor",
      confidence: 0.9,
      llmModel: "gpt-5.4-nano",
      extractedAt: "2026-01-01T00:00:00.000Z",
    },
  }
}

const FIXED_NOW = "2026-05-22T00:00:00.000Z"

test("deriveExperienceModel: yearsTotal sums durations", () => {
  const result = deriveExperienceModel({
    entries: [
      makeEntry({
        title: "SWE",
        startDate: "2020-01",
        endDate: "2022-01",
        durationMonths: 24,
        skills: ["python"],
      }),
      makeEntry({
        title: "Senior SWE",
        startDate: "2022-01",
        endDate: "2025-01",
        durationMonths: 36,
        skills: ["python", "go"],
      }),
    ],
    claimedSkills: ["python", "go"],
    now: FIXED_NOW,
  })
  assert.equal(result.yearsTotal, 5)
})

test("deriveExperienceModel: yearsPerSkill credits each entry mentioning skill", () => {
  const result = deriveExperienceModel({
    entries: [
      makeEntry({
        title: "SWE",
        startDate: "2020-01",
        endDate: "2022-01",
        durationMonths: 24,
        skills: ["python"],
      }),
      makeEntry({
        title: "Senior SWE",
        startDate: "2022-01",
        endDate: "2025-01",
        durationMonths: 36,
        skills: ["python", "go"],
      }),
    ],
    claimedSkills: ["python", "go"],
    now: FIXED_NOW,
  })
  // Python in BOTH entries (24m + 36m = 60m = 5y)
  assert.equal(result.yearsPerSkill["python"], 5)
  // Go in only the second entry (36m = 3y)
  assert.equal(result.yearsPerSkill["go"], 3)
})

test("deriveExperienceModel: skillRecency picks latest endDate or 'present'", () => {
  const result = deriveExperienceModel({
    entries: [
      makeEntry({
        title: "SWE",
        startDate: "2020-01",
        endDate: "2022-01",
        durationMonths: 24,
        skills: ["python", "java"],
      }),
      makeEntry({
        title: "Current Role",
        startDate: "2024-01",
        endDate: null, // current
        durationMonths: 16,
        skills: ["python"],
      }),
    ],
    claimedSkills: ["python", "java"],
    now: FIXED_NOW,
  })
  // Python: latest is the current role → "present"
  assert.equal(result.skillRecency["python"], "present")
  // Java: only in 2020-2022 entry → "2022-01"
  assert.equal(result.skillRecency["java"], "2022-01")
})

test("deriveExperienceModel: titleTrajectory sorts by startDate ascending", () => {
  const result = deriveExperienceModel({
    entries: [
      makeEntry({
        title: "Senior",
        startDate: "2022-01",
        endDate: null,
        durationMonths: 40,
        skills: [],
      }),
      makeEntry({
        title: "Junior",
        startDate: "2018-01",
        endDate: "2020-01",
        durationMonths: 24,
        skills: [],
      }),
      makeEntry({
        title: "Mid",
        startDate: "2020-01",
        endDate: "2022-01",
        durationMonths: 24,
        skills: [],
      }),
    ],
    claimedSkills: [],
    now: FIXED_NOW,
  })
  assert.deepEqual(result.titleTrajectory, ["Junior", "Mid", "Senior"])
})

test("deriveExperienceModel: unverifiedSkills are claimed − extracted", () => {
  const result = deriveExperienceModel({
    entries: [
      makeEntry({
        title: "SWE",
        startDate: "2022-01",
        endDate: "2024-01",
        durationMonths: 24,
        skills: ["python", "react"],
      }),
    ],
    claimedSkills: ["python", "react", "kubernetes", "rust"],
    now: FIXED_NOW,
  })
  assert.deepEqual(result.unverifiedSkills.sort(), ["kubernetes", "rust"])
})

test("deriveExperienceModel: seniorityCurrent inferred from latest title", () => {
  const result = deriveExperienceModel({
    entries: [
      makeEntry({
        title: "SWE Intern",
        startDate: "2020-06",
        endDate: "2020-09",
        durationMonths: 3,
        skills: [],
      }),
      makeEntry({
        title: "Senior Software Engineer",
        startDate: "2023-01",
        endDate: null,
        durationMonths: 28,
        skills: [],
      }),
    ],
    claimedSkills: [],
    now: FIXED_NOW,
  })
  assert.equal(result.seniorityCurrent, "senior")
})

test("deriveExperienceModel: idempotent — same input yields same output", () => {
  const args = {
    entries: [
      makeEntry({
        title: "SWE",
        startDate: "2022-01",
        endDate: "2024-01",
        durationMonths: 24,
        skills: ["python", "go"],
        industry: "fintech",
      }),
    ],
    claimedSkills: ["python", "go", "rust"],
    now: FIXED_NOW,
  }
  const a = deriveExperienceModel(args)
  const b = deriveExperienceModel(args)
  assert.deepEqual(a, b)
})

test("deriveExperienceModel: industryHistory aggregates years per industry", () => {
  const result = deriveExperienceModel({
    entries: [
      makeEntry({
        title: "SWE",
        startDate: "2020-01",
        endDate: "2022-01",
        durationMonths: 24,
        skills: [],
        industry: "fintech",
      }),
      makeEntry({
        title: "SWE",
        startDate: "2022-01",
        endDate: "2024-01",
        durationMonths: 24,
        skills: [],
        industry: "fintech",
      }),
      makeEntry({
        title: "SWE",
        startDate: "2024-01",
        endDate: "2025-01",
        durationMonths: 12,
        skills: [],
        industry: "healthcare",
      }),
    ],
    claimedSkills: [],
    now: FIXED_NOW,
  })
  assert.equal(result.industryHistory["fintech"], 4)
  assert.equal(result.industryHistory["healthcare"], 1)
})

test("deriveExperienceModel: empty entries yields empty model", () => {
  const result = deriveExperienceModel({
    entries: [],
    claimedSkills: [],
    now: FIXED_NOW,
  })
  assert.equal(result.yearsTotal, 0)
  assert.deepEqual(result.yearsPerSkill, {})
  assert.deepEqual(result.titleTrajectory, [])
  assert.equal(result.seniorityCurrent, "unknown")
  assert.equal(result.responsibilityCurrent, "unknown")
})

test("deriveExperienceModel: version stamp is 'v1'", () => {
  const result = deriveExperienceModel({
    entries: [],
    claimedSkills: [],
    now: FIXED_NOW,
  })
  assert.equal(result.version, "v1")
})

test("deriveExperienceModel: null startDate sorts to end (trajectory)", () => {
  const result = deriveExperienceModel({
    entries: [
      makeEntry({
        title: "Unknown Date Role",
        startDate: null,
        endDate: null,
        durationMonths: 0,
        skills: [],
      }),
      makeEntry({
        title: "Dated Role",
        startDate: "2020-01",
        endDate: "2022-01",
        durationMonths: 24,
        skills: [],
      }),
    ],
    claimedSkills: [],
    now: FIXED_NOW,
  })
  assert.deepEqual(result.titleTrajectory, ["Dated Role", "Unknown Date Role"])
})
