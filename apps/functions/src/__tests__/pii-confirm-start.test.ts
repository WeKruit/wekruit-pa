import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildLevel1TagPatch, composePiiSkipExistingText } from "../pii-confirm-start.js"

describe("composePiiSkipExistingText", () => {
  it("uses better-fit copy after FAIL or HARD_STOP", () => {
    const text = composePiiSkipExistingText("fail")
    assert.match(text, /stronger fit/i)
    assert.doesNotMatch(text, /employer will reach out directly/i)
  })
})

describe("buildLevel1TagPatch", () => {
  it("maps Level 1 answers into canonical pa-users.tags fields", () => {
    assert.deepEqual(
      buildLevel1TagPatch({
        yoeRange: [2, 4],
        visaStatus: "permanent_resident",
        targetLocations: ["san_francisco"],
        minSalaryUsd: 140000,
        industrySector: ["software_and_saas"],
        companySize: "early_startup",
      }),
      {
        yoeRange: [2, 4],
        // D4 canonical (2026-05-28): keep `permanent_resident`, not the `gc` alias.
        visaStatus: "permanent_resident",
        targetLocations: ["san_francisco"],
        minSalary: 140000,
        industrySector: ["software_and_saas"],
        companySize: "early_startup",
      },
    )
  })
})
