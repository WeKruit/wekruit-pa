/**
 * Smoke tests for the migration script's helpers.
 *
 * The script itself is a thin orchestrator over the extractor primitive
 * (already unit-tested at the package level). What we pin here:
 *   - `computeEntryId` is content-stable across "rerun" of same workHistory
 *   - `deriveExperienceModel` round-trips through a realistic pa-user doc
 *
 * Run via `npm test --workspace=@pa/functions` (auto-discovered by glob).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  computeEntryId,
  deriveExperienceModel,
  type DeriveEntryInput,
} from "@pa/pa-experience-extractor"

test("entryId stable across reruns on same input", () => {
  const args = { uid: "u1", index: 0, title: "Software Engineer", startDate: "2022-01" }
  assert.equal(computeEntryId(args), computeEntryId(args))
})

test("entryId changes when title or startDate change (cache invalidation)", () => {
  const base = { uid: "u1", index: 0, title: "SWE", startDate: "2022-01" }
  assert.notEqual(
    computeEntryId(base),
    computeEntryId({ ...base, title: "Senior SWE" })
  )
  assert.notEqual(
    computeEntryId(base),
    computeEntryId({ ...base, startDate: "2023-01" })
  )
})

test("derive aggregates a realistic 2-entry pa-user", () => {
  const entries: DeriveEntryInput[] = [
    {
      title: "Software Engineer",
      startDate: "2020-06",
      endDate: "2022-06",
      output: {
        entryId: "e1",
        extractedSkills: ["python", "react"],
        durationMonths: 24,
        industryGuess: "fintech",
        responsibilityLevel: "individual_contributor",
        confidence: 0.9,
        llmModel: "gpt-5.4-nano",
        extractedAt: "2026-05-22T00:00:00.000Z",
      },
    },
    {
      title: "Senior Software Engineer",
      startDate: "2022-06",
      endDate: null,
      output: {
        entryId: "e2",
        extractedSkills: ["python", "go", "kubernetes"],
        durationMonths: 36,
        industryGuess: "fintech",
        responsibilityLevel: "tech_lead",
        confidence: 0.92,
        llmModel: "gpt-5.4-nano",
        extractedAt: "2026-05-22T00:00:00.000Z",
      },
    },
  ]

  const derived = deriveExperienceModel({
    entries,
    claimedSkills: ["python", "react", "go", "rust"],
    now: "2026-05-22T00:00:00.000Z",
  })

  assert.equal(derived.version, "v1")
  assert.equal(derived.yearsTotal, 5)
  assert.equal(derived.yearsPerSkill["python"], 5)
  assert.equal(derived.yearsPerSkill["react"], 2)
  assert.equal(derived.yearsPerSkill["go"], 3)
  assert.equal(derived.skillRecency["python"], "present")
  assert.equal(derived.skillRecency["react"], "2022-06")
  assert.equal(derived.seniorityCurrent, "senior")
  assert.equal(derived.responsibilityCurrent, "tech_lead")
  assert.deepEqual(derived.unverifiedSkills, ["rust"])
  assert.equal(derived.industryHistory["fintech"], 5)
  assert.deepEqual(derived.titleTrajectory, [
    "Software Engineer",
    "Senior Software Engineer",
  ])
})
