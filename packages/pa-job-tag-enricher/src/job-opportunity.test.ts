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
    assert.equal(
      draft.prescreenConfigDraft.questions[0]?.prompt,
      "What recent work best matches this software engineering role?",
    )
    assert.ok(draft.candidateBrief.body.includes("senior software engineering opportunity"))
    assert.ok(!draft.candidateBrief.body.includes("mid_level"))
    assert.ok(!draft.candidateBrief.body.includes("software_engineering"))
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

  it("keeps sparse sponsorship-silent jobs in review for their critical gaps", () => {
    const draft = deriveJobOpportunityDraft(loadFixture("sponsorship_silent_sparse_jd"))

    assert.equal(draft.hardFilters.sponsorship, null)
    assert.equal(draft.coverage.fields.sponsorship.state, "hitl")
    assert.ok(draft.hitlFlags.includes("SPONSORSHIP_SILENT"))
    assert.equal(draft.approvalReady, false)
  })

  it("does not let sponsorship silence alone block approval-ready jobs", () => {
    const fixture = loadFixture("strong")
    const draft = deriveJobOpportunityDraft({
      ...fixture,
      enrichedJobTags: {
        ...fixture.enrichedJobTags,
        sponsorshipHint: null,
      },
    })

    assert.equal(draft.hardFilters.sponsorship, null)
    assert.equal(draft.coverage.fields.sponsorship.state, "hitl")
    assert.ok(draft.hitlFlags.includes("SPONSORSHIP_SILENT"))
    assert.equal(draft.coverage.criticalPass, true)
    assert.equal(draft.approvalReady, true)
  })

  it("does not block first-screen approval only because skills need review", () => {
    const fixture = loadFixture("strong")
    const draft = deriveJobOpportunityDraft({
      ...fixture,
      enrichedJobTags: {
        ...fixture.enrichedJobTags,
        skills: [],
        confidence: {
          ...fixture.enrichedJobTags.confidence,
          fields: {
            ...fixture.enrichedJobTags.confidence.fields,
            skills: 0.2,
          },
        },
      },
    })

    assert.ok(draft.hitlFlags.includes("MISSING_SKILLS_COVERAGE"))
    assert.equal(draft.coverage.criticalPass, true)
    assert.equal(draft.approvalReady, true)
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

  it("uses the job title to keep technical account prescreens out of generic SWE wording", () => {
    const fixture = loadFixture("strong")
    const draft = deriveJobOpportunityDraft({
      ...fixture,
      rawJob: {
        ...fixture.rawJob,
        title: "Technical Account Manager",
      },
    })

    assert.equal(
      draft.prescreenConfigDraft.questions[0]?.prompt,
      "What recent work best matches this technical account management role?",
    )
  })
})
