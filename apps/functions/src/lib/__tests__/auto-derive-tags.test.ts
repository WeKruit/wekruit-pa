/**
 * Phase 71 — auto-derive-tags unit tests. [QADATA-01]
 *
 * Coverage (15 cases):
 *   - autoDeriveTargetRoleFunction:
 *     * SE skill-bucket vote (4 SE skills → software_engineering)
 *     * DA skill-bucket vote (2 data_and_ml skills → data_analysis)
 *     * Design skill-bucket vote (2 design_and_ux skills → creatives_and_design)
 *     * Multi-pick (SE + DA simultaneously)
 *     * Title regex SE fallback
 *     * Title regex data analyst fallback
 *     * Title regex PM fallback
 *     * Title regex designer fallback
 *     * Empty input → fallback / no roles
 *     * Skills as raw strings (no bucket) → falls back to title regex
 *     * Confidence cap at 1.0 with many bucket hits
 *   - autoDeriveCareerStage:
 *     * 12+ years → principal
 *     * 8 years → staff
 *     * 5 years → senior
 *     * 2 years → mid_level
 *     * 1 year → junior
 *     * 0.5 years → entry_level
 *     * 0 / null → null
 *     * Tuple uses max
 *     * String parse "3-5 years" → mid_level (3 yrs)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  autoDeriveTargetRoleFunction,
  autoDeriveCareerStage,
} from "../auto-derive-tags.js"

// ─── autoDeriveTargetRoleFunction ────────────────────────────────────────────

describe("autoDeriveTargetRoleFunction", () => {
  it("4 SE skills → software_engineering with skill-bucket source", () => {
    const out = autoDeriveTargetRoleFunction({
      skills: [
        { name: "python", bucket: "programming_languages" },
        { name: "typescript", bucket: "programming_languages" },
        { name: "react", bucket: "frameworks_and_libraries" },
        { name: "kubernetes", bucket: "devops_and_tooling" },
      ],
    })
    assert.deepEqual(out.targetRoleFunction, ["software_engineering"])
    assert.equal(out.source, "auto-derive-skill-bucket")
    assert.ok(out.confidence > 0)
    assert.match(out.reasoning, /seScore=4/)
  })

  it("2 data_and_ml skills → data_analysis", () => {
    const out = autoDeriveTargetRoleFunction({
      skills: [
        { name: "pandas", bucket: "data_and_ml" },
        { name: "tensorflow", bucket: "data_and_ml" },
      ],
    })
    assert.deepEqual(out.targetRoleFunction, ["data_analysis"])
    assert.equal(out.source, "auto-derive-skill-bucket")
  })

  it("2 design_and_ux skills → creatives_and_design", () => {
    const out = autoDeriveTargetRoleFunction({
      skills: [
        { name: "figma", bucket: "design_and_ux" },
        { name: "sketch", bucket: "design_and_ux" },
      ],
    })
    assert.deepEqual(out.targetRoleFunction, ["creatives_and_design"])
    assert.equal(out.source, "auto-derive-skill-bucket")
  })

  it("multi-pick: 3 SE + 2 DA → both software_engineering AND data_analysis", () => {
    const out = autoDeriveTargetRoleFunction({
      skills: [
        { name: "python", bucket: "programming_languages" },
        { name: "go", bucket: "programming_languages" },
        { name: "kubernetes", bucket: "devops_and_tooling" },
        { name: "pandas", bucket: "data_and_ml" },
        { name: "scikit-learn", bucket: "data_and_ml" },
      ],
    })
    assert.ok(out.targetRoleFunction.includes("software_engineering"))
    assert.ok(out.targetRoleFunction.includes("data_analysis"))
    assert.equal(out.source, "auto-derive-skill-bucket")
  })

  it("title regex SE fallback when no skill buckets", () => {
    const out = autoDeriveTargetRoleFunction({
      skills: [],
      workHistory: [{ title: "Backend Software Engineer" }],
    })
    assert.deepEqual(out.targetRoleFunction, ["software_engineering"])
    assert.equal(out.source, "auto-derive-title-regex")
  })

  it("title regex data analyst fallback", () => {
    const out = autoDeriveTargetRoleFunction({
      skills: [],
      workHistory: [{ title: "Senior Data Analyst" }],
    })
    assert.deepEqual(out.targetRoleFunction, ["data_analysis"])
    assert.equal(out.source, "auto-derive-title-regex")
  })

  it("title regex PM fallback", () => {
    const out = autoDeriveTargetRoleFunction({
      skills: [],
      workHistory: [{ title: "Senior Product Manager" }],
    })
    assert.deepEqual(out.targetRoleFunction, ["product_management"])
    assert.equal(out.source, "auto-derive-title-regex")
  })

  it("title regex designer fallback", () => {
    const out = autoDeriveTargetRoleFunction({
      skills: [],
      workHistory: [{ title: "Senior UX Designer" }],
    })
    assert.deepEqual(out.targetRoleFunction, ["creatives_and_design"])
    assert.equal(out.source, "auto-derive-title-regex")
  })

  it("empty input → no roles, fallback source, confidence 0", () => {
    const out = autoDeriveTargetRoleFunction({})
    assert.deepEqual(out.targetRoleFunction, [])
    assert.equal(out.source, "fallback")
    assert.equal(out.confidence, 0)
  })

  it("skills as raw strings (no bucket) → falls through to title regex", () => {
    const out = autoDeriveTargetRoleFunction({
      // legacy shape — strings without bucket
      skills: ["python", "typescript", "react"],
      workHistory: [{ title: "Software Engineer" }],
    })
    // bucket vote is 0 because strings have no bucket; title regex fires.
    assert.deepEqual(out.targetRoleFunction, ["software_engineering"])
    assert.equal(out.source, "auto-derive-title-regex")
  })

  it("confidence caps at 1.0 with many bucket hits", () => {
    const skills = Array(20)
      .fill(null)
      .map((_, i) => ({
        name: `skill_${i}`,
        bucket: "programming_languages" as const,
      }))
    const out = autoDeriveTargetRoleFunction({ skills })
    assert.equal(out.confidence, 1)
  })

  it("title regex priority — data analyst beats SE pattern when both ambiguous", () => {
    // 'Senior Data Analyst' contains 'data analyst' — must match DA first
    const out = autoDeriveTargetRoleFunction({
      skills: [],
      workHistory: [{ title: "Senior Data Analyst, Engineering" }],
    })
    assert.deepEqual(out.targetRoleFunction, ["data_analysis"])
  })

  it("only 2 SE skills → does NOT cross threshold (need 3+)", () => {
    const out = autoDeriveTargetRoleFunction({
      skills: [
        { name: "python", bucket: "programming_languages" },
        { name: "typescript", bucket: "programming_languages" },
      ],
    })
    assert.deepEqual(out.targetRoleFunction, [])
    assert.equal(out.source, "fallback")
  })

  it("workHistory with empty/null title → still fallback", () => {
    const out = autoDeriveTargetRoleFunction({
      skills: [],
      workHistory: [{ title: null }, { title: "" }],
    })
    assert.deepEqual(out.targetRoleFunction, [])
    assert.equal(out.source, "fallback")
  })
})

// ─── autoDeriveCareerStage ───────────────────────────────────────────────────

describe("autoDeriveCareerStage", () => {
  it("12+ years → principal", () => {
    assert.equal(autoDeriveCareerStage(12), "principal")
    assert.equal(autoDeriveCareerStage(20), "principal")
  })

  it("8 years → staff", () => {
    assert.equal(autoDeriveCareerStage(8), "staff")
    assert.equal(autoDeriveCareerStage(10), "staff")
  })

  it("5 years → senior", () => {
    assert.equal(autoDeriveCareerStage(5), "senior")
    assert.equal(autoDeriveCareerStage(7), "senior")
  })

  it("2 years → mid_level", () => {
    assert.equal(autoDeriveCareerStage(2), "mid_level")
    assert.equal(autoDeriveCareerStage(4), "mid_level")
  })

  it("1 year → junior", () => {
    assert.equal(autoDeriveCareerStage(1), "junior")
    assert.equal(autoDeriveCareerStage(1.5), "junior")
  })

  it("0.5 years → entry_level", () => {
    assert.equal(autoDeriveCareerStage(0.5), "entry_level")
    assert.equal(autoDeriveCareerStage(0.1), "entry_level")
  })

  it("0 / null / undefined → null", () => {
    assert.equal(autoDeriveCareerStage(0), null)
    assert.equal(autoDeriveCareerStage(null), null)
    assert.equal(autoDeriveCareerStage(undefined), null)
  })

  it("tuple uses max", () => {
    // [3, 5] → max 5 → senior (NOT mid_level which would be 3)
    assert.equal(autoDeriveCareerStage([3, 5]), "senior")
    assert.equal(autoDeriveCareerStage([0, 12]), "principal")
  })

  it("string parse — '3-5 years' → mid_level (first int 3)", () => {
    assert.equal(autoDeriveCareerStage("3-5 years"), "mid_level")
    assert.equal(autoDeriveCareerStage("10+"), "staff")
    assert.equal(autoDeriveCareerStage("12 years"), "principal")
  })

  it("string with no number → null", () => {
    assert.equal(autoDeriveCareerStage("unknown"), null)
    assert.equal(autoDeriveCareerStage(""), null)
  })

  it("tuple with min only (no max) falls back to min", () => {
    // length must be 2, but if max is non-finite, fallback to min
    assert.equal(autoDeriveCareerStage([3, Infinity]), "mid_level")
  })
})
