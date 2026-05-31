/**
 * v1.9 Phase 84 — Level 1 reveal template tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { composeLevel1Reveal, composeFailJobRecsPreamble } from "../level1-template.js"

describe("composeLevel1Reveal", () => {
  it("emits all fields when present (en)", () => {
    const text = composeLevel1Reveal(
      {
        jobTitle: "Senior Frontend Engineer",
        company: "Acme Robotics",
        applyUrl: "https://wekruit.com/j/abc123",
        salaryRange: "$140k-$180k",
        nextStepEta: "within 5 business days",
      },
      "en"
    )
    assert.match(text, /Senior Frontend Engineer/)
    assert.match(text, /Acme Robotics/)
    assert.match(text, /wekruit\.com\/j\/abc123/)
    assert.match(text, /\$140k-\$180k/)
    assert.match(text, /5 business days/)
  })

  it("emits English fields regardless of lang argument", () => {
    const text = composeLevel1Reveal(
      {
        jobTitle: "Senior Frontend Engineer",
        company: "Acme Robotics",
        salaryRange: "$100k-$160k",
      },
      "zh"
    )
    assert.match(text, /Senior Frontend Engineer/)
    assert.match(text, /Employer: Acme Robotics/)
    assert.match(text, /Salary range: \$100k-\$160k/)
    assert.match(text, /within 2-3 business days/)
  })

  it("falls back gracefully when optional fields missing (en)", () => {
    const text = composeLevel1Reveal({ jobTitle: "SDE" }, "en")
    assert.match(text, /Congrats/)
    assert.match(text, /SDE/)
    assert.match(text, /within 2-3 business days/)
    assert.doesNotMatch(text, /Employer:/)
    assert.doesNotMatch(text, /Salary range:/)
    assert.doesNotMatch(text, /Job details:/)
  })

  it("does not expose open-ended salary sentinels to candidates", () => {
    const text = composeLevel1Reveal(
      {
        jobTitle: "Software Engineer - Fullstack",
        company: "Rain",
        salaryRange: "$50000-999000/yr",
      },
      "en"
    )

    assert.match(text, /Software Engineer - Fullstack/)
    assert.match(text, /Employer: Rain/)
    assert.doesNotMatch(text, /Salary range:/)
    assert.doesNotMatch(text, /999000/)
  })

  it("never returns empty string", () => {
    const text = composeLevel1Reveal({ jobTitle: "X" }, "en")
    assert.ok(text.length > 0)
  })
})

describe("composeFailJobRecsPreamble", () => {
  it("emits bridging line in English regardless of lang", () => {
    assert.match(composeFailJobRecsPreamble("en"), /what you shared in this screen/i)
    assert.match(composeFailJobRecsPreamble("en"), /job link and clear requirements/i)
    assert.match(composeFailJobRecsPreamble("zh"), /what you shared in this screen/i)
    assert.match(composeFailJobRecsPreamble("zh"), /job link and clear requirements/i)
  })
})
