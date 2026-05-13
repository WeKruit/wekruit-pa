import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { deriveJobOpportunityDraft } from "./job-opportunity.js"

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "job-opportunity")

type Fixture = {
  name: string
  rawJob: Record<string, unknown>
  enrichedJobTags: Record<string, unknown>
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8")) as Fixture
}

describe("deriveJobOpportunityDraft", () => {
  it("derives approval-ready draft pieces for a strong enriched job", () => {
    const fixture = loadFixture("strong")

    const draft = deriveJobOpportunityDraft(fixture)

    assert.equal(draft.approvalReady, true)
    assert.equal(draft.prescreenConfigDraft.status, "draft")
    assert.equal(draft.prescreenConfigDraft.approved, false)
    assert.equal(draft.coverage.criticalPass, true)
    assert.equal(draft.confidence.overall, 0.91)
    assert.deepEqual(draft.hitlFlags, [])
    assert.deepEqual(draft.hardFilters.roleFunction, ["software_engineering"])
    assert.deepEqual(draft.softScoringWeights.industrySector, [
      { token: "financial_technology", weight: 0.85 },
      { token: "software_and_saas", weight: 0.75 },
    ])
    assert.ok(draft.scoringRubric.dimensions.some((dimension) => dimension.id === "technical_depth"))
    assert.ok(draft.prescreenConfigDraft.questions.some((question) => question.rubricDimensionId === "technical_depth"))
    assert.ok(draft.candidateBrief.body.includes("Claire"))
    assert.ok(!draft.candidateBrief.body.includes("0.91"))
  })

  it("does not become approval-ready below the confidence threshold", () => {
    const draft = deriveJobOpportunityDraft(loadFixture("weak"))

    assert.equal(draft.approvalReady, false)
    assert.equal(draft.coverage.criticalPass, false)
    assert.ok(draft.hitlFlags.includes("LOW_OVERALL_CONFIDENCE"))
    assert.ok(draft.hitlFlags.includes("MISSING_SKILLS_COVERAGE"))
  })

  it("routes ambiguous critical coverage to HITL even when overall confidence is high", () => {
    const draft = deriveJobOpportunityDraft(loadFixture("ambiguous"))

    assert.equal(draft.approvalReady, false)
    assert.equal(draft.coverage.criticalPass, false)
    assert.ok(draft.hitlFlags.includes("AMBIGUOUS_ROLE_FUNCTION"))
    assert.ok(draft.hitlFlags.includes("WEAK_SENIORITY_COVERAGE"))
  })

  it("keeps sponsorship silence as null plus a HITL flag, never false", () => {
    const draft = deriveJobOpportunityDraft(loadFixture("sponsorship_silent_sparse_jd"))

    assert.equal(draft.hardFilters.sponsorship, null)
    assert.equal(draft.coverage.fields.sponsorship.state, "hitl")
    assert.ok(draft.hitlFlags.includes("SPONSORSHIP_SILENT"))
    assert.equal(draft.approvalReady, false)
  })

  it("creates eval fixture summaries for visa, location, and salary mismatch cases", () => {
    for (const name of ["visa_mismatch", "location_mismatch", "salary_mismatch"]) {
      const draft = deriveJobOpportunityDraft(loadFixture(name))

      assert.equal(draft.evalFixtures.summary.total, 1)
      assert.equal(draft.evalFixtures.fixtures[0]?.caseName, name)
      assert.equal(draft.evalFixtures.fixtures[0]?.expectedOutcome, "not_pass")
      assert.ok(draft.evalFixtures.fixtures[0]?.expectedSignals.length)
    }
  })

  it("keeps roleFunction hard filters orthogonal to industrySector scoring", () => {
    const draft = deriveJobOpportunityDraft(loadFixture("role_industry_orthogonality"))

    assert.deepEqual(draft.hardFilters.roleFunction, ["sales"])
    assert.deepEqual(draft.softScoringWeights.industrySector, [
      { token: "financial_technology", weight: 0.85 },
    ])
    assert.ok(!draft.hardFilters.roleFunction.includes("financial_technology" as never))
    assert.ok(!draft.softScoringWeights.industrySector.some((signal) => signal.token === "sales"))
  })
})
