/**
 * iter30/WS8 — BoostCalculator parity + cache TTL + applyBoost shape.
 *
 * Three suites:
 *   1) Parity vs `AI_AGENT_SKILL_WEIGHTS` const — 50 synthetic fixtures
 *   2) 30s TTL cache (mirrors playbook-cache contract)
 *   3) applyBoost reorder + BoostExplainerInput shape
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  AI_AGENT_SKILL_WEIGHTS,
  WEIGHTED_MATCH_BOOSTS,
  applyWeightedMatchBoost,
  computeWeightedMatchScore,
} from "../match-weights.js"
import {
  BoostCalculator,
  WEIGHT_CACHE_TTL_MS,
  WEIGHT_ITEMS_SUBCOLLECTION,
  WEIGHT_TABLES_COLLECTION,
  _clearWeightCache,
  computeWeightedMatchScoreFromRows,
  rowFromConst,
  type WeightRow,
} from "../boost-calculator.js"
import { MockFirestore, asFirestore } from "./mock-firestore.js"

const TABLE_KEY = "ai-agent-2026"

function seedTable(): MockFirestore {
  const mfs = new MockFirestore()
  // Seed table doc
  void mfs
    .collection(WEIGHT_TABLES_COLLECTION)
    .doc(TABLE_KEY)
    .set({
      tableKey: TABLE_KEY,
      name: "AI Agent / LLM Engineer 2026",
      description: "Synthetic seed for parity test.",
      active: true,
      defaultForRoles: ["ai engineer"],
      rowCount: AI_AGENT_SKILL_WEIGHTS.length,
      version: 1,
    })
  // Seed item docs
  for (const w of AI_AGENT_SKILL_WEIGHTS) {
    const skillKey = w.skill.toLowerCase().trim().replace(/\s+/g, "-")
    void mfs
      .collection(`${WEIGHT_TABLES_COLLECTION}/${TABLE_KEY}/${WEIGHT_ITEMS_SUBCOLLECTION}`)
      .doc(skillKey)
      .set({
        skill: w.skill,
        skillCanonical: null,
        weight: w.weight,
        category: w.category,
        market: TABLE_KEY,
      })
  }
  return mfs
}

// 50 synthetic fixtures spanning every weight category + edge cases
function generateFixtures(): Array<{ id: string; user: string[]; job: string[] }> {
  const fx: Array<{ id: string; user: string[]; job: string[] }> = []
  const cores = AI_AGENT_SKILL_WEIGHTS.filter((w) => w.category === "core").map((w) => w.skill)
  const supps = AI_AGENT_SKILL_WEIGHTS.filter((w) => w.category === "supporting").map((w) => w.skill)
  const gens = AI_AGENT_SKILL_WEIGHTS.filter((w) => w.category === "generic").map((w) => w.skill)

  // Single-skill matches (one per row)
  for (const w of AI_AGENT_SKILL_WEIGHTS) {
    fx.push({ id: `single_${w.skill}`, user: [w.skill], job: [w.skill] })
  }
  // Pairs across categories
  fx.push({ id: "core+gen", user: ["RAG", "Python"], job: ["RAG", "Python"] })
  fx.push({ id: "supp+gen", user: ["prompt engineering", "SQL"], job: ["prompt engineering", "SQL"] })
  fx.push({ id: "all3", user: cores.slice(0, 1).concat(supps.slice(0, 1)).concat(gens.slice(0, 1)), job: cores.slice(0, 1).concat(supps.slice(0, 1)).concat(gens.slice(0, 1)) })
  // User missing core (Adam's Python-only complaint)
  fx.push({ id: "py_only_vs_ai", user: ["Python"], job: ["RAG", "tool calling", "Python"] })
  // User over-qualified (CV has more than JD asks)
  fx.push({ id: "user_super", user: cores.concat(supps).concat(gens), job: ["RAG"] })
  // Empty / out-of-scope
  fx.push({ id: "empty_user", user: [], job: ["RAG"] })
  fx.push({ id: "empty_job", user: ["RAG"], job: [] })
  fx.push({ id: "no_overlap", user: ["Excel", "PowerPoint"], job: ["Marketing", "Sales"] })
  fx.push({ id: "case_mix", user: ["RAG pipeline experience"], job: ["rag"] })
  fx.push({ id: "substring", user: ["LangChain 0.1.x"], job: ["langchain"] })
  // Generate enough to reach 50
  while (fx.length < 50) {
    const i = fx.length
    const skill = AI_AGENT_SKILL_WEIGHTS[i % AI_AGENT_SKILL_WEIGHTS.length]!.skill
    fx.push({ id: `gen_${i}`, user: [skill, "Python"], job: [skill, "RAG"] })
  }
  return fx.slice(0, 50)
}

describe("BoostCalculator — Firestore↔TS-const parity", () => {
  beforeEach(() => _clearWeightCache())

  const fixtures = generateFixtures()
  for (const fx of fixtures) {
    it(`parity: ${fx.id}`, async () => {
      const mfs = seedTable()
      const bc = new BoostCalculator({ db: asFirestore(mfs) })
      const { rows } = await bc.loadTable(TABLE_KEY)

      const tsRes = computeWeightedMatchScore(fx.user, fx.job, AI_AGENT_SKILL_WEIGHTS)
      const fsRes = computeWeightedMatchScoreFromRows(fx.user, fx.job, rows)

      assert.equal(fsRes.score, tsRes.score, `score: ts=${tsRes.score} fs=${fsRes.score}`)
      assert.deepEqual(
        fsRes.matched.map((m) => m.skill).sort(),
        tsRes.matched.map((m) => m.skill).sort()
      )
      assert.deepEqual(
        fsRes.coreMissing.map((m) => m.skill).sort(),
        tsRes.coreMissing.map((m) => m.skill).sort()
      )
    })
  }
})

describe("BoostCalculator — 30s cache TTL", () => {
  beforeEach(() => _clearWeightCache())

  it("respects 30s TTL — second call within TTL is cached, third call after TTL refreshes", async () => {
    let nowMs = 1_000_000
    const mfs = seedTable()
    const bc = new BoostCalculator({
      db: asFirestore(mfs),
      now: () => nowMs,
    })

    let collCallCount = 0
    const orig = mfs.collection.bind(mfs)
    ;(mfs as unknown as { collection: typeof mfs.collection }).collection = ((path: string) => {
      collCallCount++
      return orig(path)
    }) as typeof mfs.collection

    await bc.loadTable(TABLE_KEY)
    const after1 = collCallCount
    assert.ok(after1 > 0, "first load reads Firestore")

    await bc.loadTable(TABLE_KEY)
    assert.equal(collCallCount, after1, "second load within TTL hits cache, no Firestore reads")

    nowMs += WEIGHT_CACHE_TTL_MS + 1
    await bc.loadTable(TABLE_KEY)
    assert.ok(collCallCount > after1, "third load after TTL refreshes from Firestore")
  })

  it("ttlMs=0 disables cache (per-call refresh)", async () => {
    const mfs = seedTable()
    const bc = new BoostCalculator({ db: asFirestore(mfs), ttlMs: 0 })
    let collCallCount = 0
    const orig = mfs.collection.bind(mfs)
    ;(mfs as unknown as { collection: typeof mfs.collection }).collection = ((path: string) => {
      collCallCount++
      return orig(path)
    }) as typeof mfs.collection

    await bc.loadTable(TABLE_KEY)
    const after1 = collCallCount
    await bc.loadTable(TABLE_KEY)
    assert.ok(collCallCount > after1, "ttlMs=0 forces refresh on every call")
  })
})

describe("BoostCalculator.applyBoost — reorder + explainer inputs", () => {
  beforeEach(() => _clearWeightCache())

  it("matches applyWeightedMatchBoost reorder shape on identical input", async () => {
    const mfs = seedTable()
    const bc = new BoostCalculator({ db: asFirestore(mfs) })
    const { table, rows } = await bc.loadTable(TABLE_KEY)

    const jobs = [
      { id: "j-rag", requiredSkills: ["rag", "tool calling"] },
      { id: "j-py", requiredSkills: ["python"] },
      { id: "j-mix", requiredSkills: ["langchain", "python"] },
    ]
    const user = ["RAG", "LangChain"]

    const tsBoost = applyWeightedMatchBoost(jobs, user, AI_AGENT_SKILL_WEIGHTS)
    const fsBoost = bc.applyBoost(jobs, user, table, rows)

    assert.deepEqual(
      fsBoost.jobs.map((j) => j.id),
      tsBoost.jobs.map((j) => j.id),
      "reorder identical"
    )
    assert.equal(fsBoost.explainerInputs.length, fsBoost.explanations.length)
  })

  it("emits BoostExplainerInput with tableKey + tableVersion for explainer cache key", async () => {
    const mfs = seedTable()
    const bc = new BoostCalculator({ db: asFirestore(mfs) })
    const { table, rows } = await bc.loadTable(TABLE_KEY)

    const jobs = [{ id: "j-rag", requiredSkills: ["rag", "tool calling"] }]
    const user = ["RAG", "tool calling"]
    const out = bc.applyBoost(jobs, user, table, rows)

    assert.equal(out.explainerInputs.length, 1)
    const ei = out.explainerInputs[0]!
    assert.equal(ei.jobId, "j-rag")
    assert.equal(ei.tableKey, TABLE_KEY)
    assert.equal(ei.tableVersion, 1)
    assert.equal(ei.totalBoostMult, WEIGHTED_MATCH_BOOSTS.STRONG)
    assert.ok(ei.hits.length >= 2)
    for (const h of ei.hits) {
      assert.equal(h.matchedAgainst, "cv-skill")
      assert.equal(h.skillCanonical, null, "WS2 backfill not yet — null is correct")
    }
  })

  it("returns empty explainerInputs when no jobs are applicable (out-of-scope)", async () => {
    const mfs = seedTable()
    const bc = new BoostCalculator({ db: asFirestore(mfs) })
    const { table, rows } = await bc.loadTable(TABLE_KEY)

    const jobs = [{ id: "j-marketing", requiredSkills: ["Excel", "Marketing"] }]
    const out = bc.applyBoost(jobs, ["Python"], table, rows)
    assert.deepEqual(
      out.jobs.map((j) => j.id),
      ["j-marketing"]
    )
    assert.equal(out.explainerInputs.length, 0)
  })
})

describe("BoostCalculator.loadTable — error handling", () => {
  beforeEach(() => _clearWeightCache())

  it("throws when table doc missing — caller catches + falls through to TS const", async () => {
    const mfs = new MockFirestore()
    const bc = new BoostCalculator({ db: asFirestore(mfs) })
    await assert.rejects(bc.loadTable("does-not-exist"), /not found/)
  })
})

describe("rowFromConst — TS const → WeightRow shape", () => {
  it("synthesizes WeightRow with null skillCanonical (WS2 will backfill)", () => {
    const w = AI_AGENT_SKILL_WEIGHTS.find((x) => x.skill === "rag")!
    const row: WeightRow = rowFromConst(w)
    assert.equal(row.skill, "rag")
    assert.equal(row.skillKey, "rag")
    assert.equal(row.weight, 3.0)
    assert.equal(row.category, "core")
    assert.equal(row.skillCanonical, null)
    assert.equal(row.market, "ai-agent-2026")
  })
  it("collapses whitespace in skillKey (e.g. 'tool calling' → 'tool-calling')", () => {
    const w = AI_AGENT_SKILL_WEIGHTS.find((x) => x.skill === "tool calling")!
    assert.equal(rowFromConst(w).skillKey, "tool-calling")
  })
})
