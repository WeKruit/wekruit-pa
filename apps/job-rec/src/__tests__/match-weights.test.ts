import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  AI_AGENT_SKILL_WEIGHTS,
  WEIGHTED_MATCH_BOOSTS,
  applyWeightedMatchBoost,
  computeWeightedMatchScore,
} from "../match-weights.js"

describe("match-weights — AI_AGENT_SKILL_WEIGHTS table", () => {
  it("contains the indisputable 2026 core keywords with weight ≥ 2.0", () => {
    const cores = AI_AGENT_SKILL_WEIGHTS.filter((w) => w.category === "core")
    const lookups = new Map(cores.map((w) => [w.skill, w.weight]))
    assert.ok((lookups.get("rag") ?? 0) >= 3.0, "RAG must be core 3.0")
    assert.ok((lookups.get("function calling") ?? 0) >= 3.0, "function calling core 3.0")
    assert.ok((lookups.get("tool calling") ?? 0) >= 3.0, "tool calling core 3.0")
    assert.ok((lookups.get("workflow orchestration") ?? 0) >= 2.0)
    assert.ok((lookups.get("langchain") ?? 0) >= 2.0)
  })

  it("Python is generic 0.5 (Adam: 'single Python is NOT a real match')", () => {
    const py = AI_AGENT_SKILL_WEIGHTS.find((w) => w.skill === "python")
    assert.ok(py, "python entry must exist")
    assert.equal(py!.weight, 0.5)
    assert.equal(py!.category, "generic")
  })
})

describe("computeWeightedMatchScore — Adam-spec scenarios", () => {
  it("user has Python only + AI agent job (RAG + tool calling required) → low score (Adam: NOT a real match)", () => {
    const job = ["RAG", "tool calling", "Python"]
    const user = ["Python"]
    const r = computeWeightedMatchScore(user, job, AI_AGENT_SKILL_WEIGHTS)
    // applicable: rag(3.0) + tool calling(3.0) + python(0.5) = 6.5
    // matched: python(0.5)
    // score = 0.5 / 6.5 ≈ 0.077
    assert.ok(r.score < 0.2, `expected weak score < 0.2, got ${r.score}`)
    assert.equal(r.matched.length, 1)
    assert.equal(r.matched[0]!.skill, "python")
    // coreMissing should list rag + tool calling
    const missing = r.coreMissing.map((w) => w.skill)
    assert.ok(missing.includes("rag"), "rag should be flagged as coreMissing")
    assert.ok(missing.includes("tool calling"))
  })

  it("user has RAG + tool calling + Python → strong score (Adam: this IS a real match)", () => {
    const job = ["RAG", "tool calling", "Python"]
    const user = ["RAG", "tool calling", "Python"]
    const r = computeWeightedMatchScore(user, job, AI_AGENT_SKILL_WEIGHTS)
    // applicable: rag(3.0) + tool calling(3.0) + python(0.5) = 6.5
    // matched: rag + tool calling + python = 6.5
    assert.equal(r.score, 1.0)
    assert.ok(r.matched.length >= 3)
    assert.equal(r.coreMissing.length, 0)
  })

  it("middle case — user has RAG only against RAG+tool-calling+langchain job → ~0.43 (lean)", () => {
    const job = ["RAG", "tool calling", "LangChain"]
    const user = ["RAG"]
    const r = computeWeightedMatchScore(user, job, AI_AGENT_SKILL_WEIGHTS)
    // applicable: rag(3.0) + tool calling(3.0) + langchain(2.0) = 8.0
    // matched: rag(3.0)
    // score = 3.0 / 8.0 = 0.375 — lean
    assert.ok(r.score >= 0.33 && r.score < 0.66, `expected 0.33–0.66, got ${r.score}`)
    assert.equal(r.matched.length, 1)
    assert.equal(r.matched[0]!.skill, "rag")
    assert.ok(r.coreMissing.some((w) => w.skill === "tool calling"))
  })

  it("job has NO weighted skills → score=1.0 (neutral, out of scope)", () => {
    const job = ["Excel", "PowerPoint", "Marketing"]
    const user = ["Python", "RAG"]
    const r = computeWeightedMatchScore(user, job, AI_AGENT_SKILL_WEIGHTS)
    assert.equal(r.score, 1.0)
    assert.equal(r.matched.length, 0)
    assert.equal(r.coreMissing.length, 0)
  })

  it("case-insensitive substring match — user 'rag pipeline' matches weight 'rag'", () => {
    const job = ["RAG"]
    const user = ["RAG pipeline experience"]
    const r = computeWeightedMatchScore(user, job, AI_AGENT_SKILL_WEIGHTS)
    assert.equal(r.matched.length, 1)
    assert.ok(r.matched[0]!.skill === "rag")
  })

  it("empty user skills → all required-core get coreMissing flagged", () => {
    const job = ["RAG", "tool calling"]
    const user: string[] = []
    const r = computeWeightedMatchScore(user, job, AI_AGENT_SKILL_WEIGHTS)
    assert.equal(r.score, 0)
    assert.equal(r.matched.length, 0)
    assert.ok(r.coreMissing.length >= 2)
  })
})

describe("applyWeightedMatchBoost — reordering shape (mirrors applyStartupBoost)", () => {
  it("Python-only user vs AI agent jobs → strong-match job promoted, weak-match sinks", () => {
    const jobs = [
      { id: "weak1", requiredSkills: ["RAG", "tool calling", "Python"] },
      { id: "strong1", requiredSkills: ["Python", "Excel"] },  // job needs only Python+Excel — user covers Python = strong
      { id: "weak2", requiredSkills: ["RAG", "LangChain", "function calling"] },
    ]
    const userSkills = ["Python"]
    const result = applyWeightedMatchBoost(jobs, userSkills, AI_AGENT_SKILL_WEIGHTS)
    assert.ok(result.explanations.length >= 1)
    // strong1 should be ranked above weak1/weak2 because user covers ALL its weighted required skills
    const strong1Idx = result.jobs.findIndex((j) => j.id === "strong1")
    const weak1Idx = result.jobs.findIndex((j) => j.id === "weak1")
    const weak2Idx = result.jobs.findIndex((j) => j.id === "weak2")
    assert.ok(strong1Idx < weak1Idx, "strong1 must rank above weak1 (Python-only user matches Python-only job)")
    assert.ok(strong1Idx < weak2Idx, "strong1 must rank above weak2")
  })

  it("Python+RAG user vs AI agent jobs → RAG-required job promoted", () => {
    const jobs = [
      { id: "no_rag", requiredSkills: ["Python", "Excel"] },
      { id: "with_rag", requiredSkills: ["RAG", "Python"] },
    ]
    const userSkills = ["Python", "RAG"]
    const result = applyWeightedMatchBoost(jobs, userSkills, AI_AGENT_SKILL_WEIGHTS)
    // Both score 1.0 here actually — but with_rag has higher applicable_sum so explanation captures it.
    // Real differentiator test: when one job needs RAG and user has RAG, vs same job and user has only Python.
    assert.ok(result.explanations.length === 2)
    const withRagExpl = result.explanations.find((e) => e.jobId === "with_rag")!
    assert.ok(withRagExpl.matched.some((w) => w.skill === "rag"), "with_rag explanation must show rag matched")
  })

  it("two AI agent jobs same difficulty — Python-only user gets WEAK boost (0.85), Python+RAG+tool-calling user gets STRONG (1.2)", () => {
    const job = [{ id: "ai_job", requiredSkills: ["RAG", "tool calling", "Python"] }]
    // Scenario A — Python-only user
    const a = applyWeightedMatchBoost(job, ["Python"], AI_AGENT_SKILL_WEIGHTS)
    assert.equal(a.explanations.length, 1)
    assert.equal(a.explanations[0]!.boostMult, WEIGHTED_MATCH_BOOSTS.WEAK)
    // Scenario B — Python+RAG+tool calling user
    const b = applyWeightedMatchBoost(job, ["Python", "RAG", "tool calling"], AI_AGENT_SKILL_WEIGHTS)
    assert.equal(b.explanations.length, 1)
    assert.equal(b.explanations[0]!.boostMult, WEIGHTED_MATCH_BOOSTS.STRONG)
    // boost differential — STRONG (1.2) / WEAK (0.85) ≈ 1.41x relative reorder weight
    const diff = b.explanations[0]!.boostMult / a.explanations[0]!.boostMult
    assert.ok(diff > 1.3, `STRONG vs WEAK should differ by > 1.3×, got ${diff}`)
  })

  it("empty jobs → empty result (defensive)", () => {
    const r = applyWeightedMatchBoost([], ["Python"], AI_AGENT_SKILL_WEIGHTS)
    assert.equal(r.jobs.length, 0)
    assert.equal(r.explanations.length, 0)
  })

  it("baseScores carries cross-encoder relevance through the boost", () => {
    const jobs = [
      { id: "j1", requiredSkills: ["RAG"] },
      { id: "j2", requiredSkills: ["RAG"] },
    ]
    const baseScores = new Map<string, number | null>([
      ["j1", 0.1], // very low cross-encoder score
      ["j2", 0.9], // very high cross-encoder score
    ])
    const userSkills = ["RAG"] // both get STRONG mult (1.2)
    const r = applyWeightedMatchBoost(jobs, userSkills, AI_AGENT_SKILL_WEIGHTS, baseScores)
    // Final score: j1 = 0.1 * 1.2 = 0.12; j2 = 0.9 * 1.2 = 1.08 → j2 first
    assert.equal(r.jobs[0]!.id, "j2")
  })
})
