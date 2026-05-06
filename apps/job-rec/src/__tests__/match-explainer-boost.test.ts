/**
 * iter30/WS8 — match-explainer boost-aware prompt + version-keyed cache.
 *
 * Three suites:
 *   1) classifyExplainerMode — mode-routing decision table
 *   2) buildExplainerMessages — boost data flows into prompt for A/B/C, falls back to D
 *   3) cacheDocId — version-keyed (any weight-table edit invalidates downstream cache)
 *   4) sanitizeReason 2-sentence cap
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildExplainerMessages,
  cacheDocId,
  capToTwoSentences,
  classifyExplainerMode,
  sanitizeReason,
  type ExplainMatchInput,
} from "../match-explainer.js"
import type { BoostExplainerInput } from "../boost-calculator.js"
import type { MatchingJob } from "../types.js"

const baseJob: MatchingJob & { jdSnippet?: string } = {
  id: "j1",
  jobTitle: "Senior LLM Eng",
  companyName: "Anthropic",
  requiredSkills: ["rag", "tool calling"],
  jdSnippet: "Build agentic workflows with retrieval pipelines.",
  primaryUrl: "https://example.com/j1",
  locationRaw: "remote",
  industry: "tech",
  salaryMax: null,
  salaryMin: null,
  sponsorship: null,
}

const baseCv = {
  recentRoleTitle: "AI Engineer",
  recentCompany: "Stripe",
  topSkills: ["RAG", "Python"],
  recentBullet: "Built RAG pipeline serving 1M queries/day",
}

function makeBoost(
  hits: BoostExplainerInput["hits"],
  coreMissing: BoostExplainerInput["coreMissing"] = [],
  totalBoostMult = 1.2,
  tableVersion = 5
): BoostExplainerInput {
  return {
    jobId: "j1",
    hits,
    coreMissing,
    totalBoostMult,
    tableKey: "ai-agent-2026",
    tableVersion,
  }
}

function makeInput(boost?: BoostExplainerInput, language: "zh" | "en" = "zh"): ExplainMatchInput {
  return {
    userId: "u1",
    userCv: baseCv,
    job: baseJob,
    matchScore: 0.92,
    language,
    boostInput: boost,
  }
}

describe("classifyExplainerMode — mode routing", () => {
  it("undefined boost → D_fallback", () => {
    assert.equal(classifyExplainerMode(undefined), "D_fallback")
  })
  it("boost with empty hits + empty coreMissing → D_fallback", () => {
    assert.equal(classifyExplainerMode(makeBoost([], [])), "D_fallback")
  })
  it("≥1 core hit (weight ≥ 2.0) → A_core", () => {
    const b = makeBoost([
      { skill: "rag", skillCanonical: null, category: "core", weight: 3.0, matchedAgainst: "cv-skill" },
    ])
    assert.equal(classifyExplainerMode(b), "A_core")
  })
  it("no core, ≥1 supporting hit → B_supp", () => {
    const b = makeBoost(
      [
        { skill: "prompt engineering", skillCanonical: null, category: "supporting", weight: 1.5, matchedAgainst: "cv-skill" },
      ],
      [{ skill: "rag", weight: 3.0 }]
    )
    assert.equal(classifyExplainerMode(b), "B_supp")
  })
  it("only generic hits → C_gen", () => {
    const b = makeBoost(
      [{ skill: "python", skillCanonical: null, category: "generic", weight: 0.5, matchedAgainst: "cv-skill" }],
      [{ skill: "rag", weight: 3.0 }]
    )
    assert.equal(classifyExplainerMode(b), "C_gen")
  })
})

describe("buildExplainerMessages — boost-aware prompt", () => {
  it("mode A (core hit): zh prompt mentions core + boost data", () => {
    const b = makeBoost([
      { skill: "rag", skillCanonical: null, category: "core", weight: 3.0, matchedAgainst: "cv-skill" },
      { skill: "tool calling", skillCanonical: null, category: "core", weight: 3.0, matchedAgainst: "cv-skill" },
    ])
    const msgs = buildExplainerMessages(makeInput(b, "zh"))
    const sys = msgs[0]!.content
    const user = msgs[1]!.content
    assert.ok(sys.includes("CORE vs GENERIC 区分"), "zh sys mentions CORE区分")
    assert.ok(sys.includes("A) 当 hits 里有 ≥ 1 个 core"), "zh sys has mode-A branch")
    assert.ok(user.includes("rag (core/3.0/cv-skill)"), "user content has boost hits")
    assert.ok(user.includes("mode: A_core"), "user content carries computed mode")
  })

  it("mode A en: prompt mentions Don't promote generic to match", () => {
    const b = makeBoost([
      { skill: "rag", skillCanonical: null, category: "core", weight: 3.0, matchedAgainst: "cv-skill" },
    ])
    const msgs = buildExplainerMessages(makeInput(b, "en"))
    const sys = msgs[0]!.content
    assert.ok(sys.includes("CORE vs GENERIC distinction"))
    assert.ok(sys.includes("Python is foundation, not match"))
  })

  it("mode C (only generic): user content emits coreMissing for actionable advice", () => {
    const b = makeBoost(
      [{ skill: "python", skillCanonical: null, category: "generic", weight: 0.5, matchedAgainst: "cv-skill" }],
      [{ skill: "rag", weight: 3.0 }, { skill: "tool calling", weight: 3.0 }]
    )
    const msgs = buildExplainerMessages(makeInput(b, "zh"))
    const user = msgs[1]!.content
    assert.ok(user.includes("rag (3.0)"))
    assert.ok(user.includes("mode: C_gen"))
    assert.ok(user.includes("python (generic/0.5/cv-skill)"))
  })

  it("mode D (no boost): falls back to legacy single-sentence prompt", () => {
    const msgs = buildExplainerMessages(makeInput(undefined, "zh"))
    const sys = msgs[0]!.content
    assert.ok(sys.includes("ONE 中文句子"), "legacy prompt cap retained")
    assert.ok(!sys.includes("CORE vs GENERIC 区分"), "no boost-mode branches in fallback")
  })
})

describe("cacheDocId — version-keyed cache invalidation", () => {
  it("legacy callers (no version) keep the old key shape (back-compat)", () => {
    assert.equal(cacheDocId("u1", "j1", "zh"), "u1__j1__zh")
  })
  it("version supplied → key suffixes __v{N}", () => {
    assert.equal(cacheDocId("u1", "j1", "zh", 5), "u1__j1__zh__v5")
  })
  it("version 0 falls back to legacy shape (treat as unversioned)", () => {
    assert.equal(cacheDocId("u1", "j1", "zh", 0), "u1__j1__zh")
  })
  it("any version bump produces a new doc id (cache miss → fresh LLM call)", () => {
    const v1 = cacheDocId("u1", "j1", "zh", 1)
    const v2 = cacheDocId("u1", "j1", "zh", 2)
    assert.notEqual(v1, v2)
  })
})

describe("sanitizeReason — 2-sentence cap", () => {
  it("caps to 2 zh sentences and drops the third", () => {
    const r = sanitizeReason("第一句话。第二句话。这句应该被丢掉。")
    assert.equal(r, "第一句话。第二句话。")
  })
  it("caps to 2 en sentences and drops the third", () => {
    const r = sanitizeReason("First sentence. Second sentence. Third should drop.")
    assert.equal(r, "First sentence. Second sentence.")
  })
  it("single sentence passes through unchanged", () => {
    const r = sanitizeReason("Just one sentence.")
    assert.equal(r, "Just one sentence.")
  })
  it("no terminal punctuation → leaves string alone (after other sanitization)", () => {
    const r = sanitizeReason("no punctuation at all")
    assert.equal(r, "no punctuation at all")
  })
  it("capToTwoSentences pure helper handles mixed terminals", () => {
    assert.equal(capToTwoSentences("一. 二! 三?"), "一. 二!")
  })
})
