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

  it("emits all fields when present (zh)", () => {
    const text = composeLevel1Reveal(
      {
        jobTitle: "高级前端工程师",
        company: "Acme Robotics",
        salaryRange: "100-160万",
      },
      "zh"
    )
    assert.match(text, /高级前端工程师/)
    assert.match(text, /招聘方: Acme Robotics/)
    assert.match(text, /薪资范围: 100-160万/)
    assert.match(text, /2-3 个工作日内/)
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

  it("never returns empty string", () => {
    const text = composeLevel1Reveal({ jobTitle: "X" }, "en")
    assert.ok(text.length > 0)
  })
})

describe("composeFailJobRecsPreamble", () => {
  it("emits bridging line in both langs", () => {
    assert.match(composeFailJobRecsPreamble("en"), /better-aligned/i)
    assert.match(composeFailJobRecsPreamble("zh"), /其他更合适/)
  })
})
