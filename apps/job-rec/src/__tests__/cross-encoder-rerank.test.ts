/**
 * Stream H10 D2 — cross-encoder rerank unit tests.
 *
 * Coverage:
 *   - happy path: SiliconFlow-shaped response is parsed & sorted desc
 *   - fail-open: 503 → returns input order with score=null
 *   - fail-open: missing API key → returns input order with score=null
 *   - fail-open: empty candidates → returns []
 *   - fail-open: missing fetch → returns input order with score=null
 *   - fail-open: malformed payload → returns input order with score=null
 *   - topN truncates input array before API call
 *   - buildRerankQuery composes profile signals into a short string
 *   - buildJobCandidateText composes job signals into a short string
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  rerankWithCrossEncoder,
  buildRerankQuery,
  buildJobCandidateText,
  isStartupJob,
  isFaangCompany,
  userPreferStartup,
  computeStartupBoost,
  applyStartupBoost,
  BOOST_WEIGHTS,
} from "../cross-encoder-rerank.js"

function makeFetchOk(payload: unknown): typeof fetch {
  return (async (_url: unknown, _init?: unknown) => {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

function makeFetchFail(status: number): typeof fetch {
  return (async (_url: unknown, _init?: unknown) => {
    return new Response(JSON.stringify({ error: "boom" }), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

describe("rerankWithCrossEncoder — happy path", () => {
  it("parses SiliconFlow-shaped response, sorted desc by score, original ids preserved", async () => {
    const fakeFetch = makeFetchOk({
      results: [
        { index: 1, relevance_score: 0.802 },
        { index: 0, relevance_score: 0.00005 },
        { index: 2, relevance_score: 0.00002 },
      ],
    })
    const out = await rerankWithCrossEncoder(
      "data analyst with python ml",
      [
        { id: "qc", text: "QC Quality Control Analyst" },
        { id: "ds", text: "Senior Data Scientist Python ML" },
        { id: "mk", text: "Marketing Manager" },
      ],
      { fetch: fakeFetch, apiKey: "test-key" }
    )
    assert.equal(out.length, 3)
    assert.equal(out[0]!.id, "ds", "data scientist must rank first")
    assert.equal(out[0]!.score, 0.802)
    assert.equal(out[1]!.id, "qc")
    assert.equal(out[2]!.id, "mk")
  })
})

describe("rerankWithCrossEncoder — fail-open semantics", () => {
  it("returns input order with score=null when API returns 503", async () => {
    const fakeFetch = makeFetchFail(503)
    const out = await rerankWithCrossEncoder(
      "q",
      [
        { id: "a", text: "alpha" },
        { id: "b", text: "beta" },
      ],
      { fetch: fakeFetch, apiKey: "k" }
    )
    assert.equal(out.length, 2)
    assert.equal(out[0]!.id, "a")
    assert.equal(out[1]!.id, "b")
    assert.equal(out[0]!.score, null)
    assert.equal(out[1]!.score, null)
  })

  it("returns input order with score=null when apiKey is empty", async () => {
    const out = await rerankWithCrossEncoder(
      "q",
      [{ id: "a", text: "alpha" }],
      { apiKey: "" }
    )
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, "a")
    assert.equal(out[0]!.score, null)
  })

  it("returns [] for empty candidates", async () => {
    const out = await rerankWithCrossEncoder("q", [], { apiKey: "k" })
    assert.deepEqual(out, [])
  })

  it("returns input order with score=null when fetch throws (network error)", async () => {
    const throwFetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const out = await rerankWithCrossEncoder(
      "q",
      [
        { id: "a", text: "alpha" },
        { id: "b", text: "beta" },
      ],
      { fetch: throwFetch, apiKey: "k" }
    )
    assert.equal(out.length, 2)
    assert.equal(out[0]!.id, "a")
    assert.equal(out[0]!.score, null)
  })

  it("returns input order with score=null when payload is malformed", async () => {
    const fakeFetch = makeFetchOk({ unexpected: "shape" })
    const out = await rerankWithCrossEncoder(
      "q",
      [{ id: "a", text: "alpha" }],
      { fetch: fakeFetch, apiKey: "k" }
    )
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, "a")
    assert.equal(out[0]!.score, null)
  })

  it("topN truncates input array before sending — only first N candidates considered", async () => {
    let capturedBody: unknown = null
    const fakeFetch = (async (_url: unknown, init?: unknown) => {
      const i = init as { body?: string }
      capturedBody = i?.body ? JSON.parse(i.body) : null
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    const cands = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, text: `text-${i}` }))
    await rerankWithCrossEncoder("q", cands, {
      fetch: fakeFetch,
      apiKey: "k",
      topN: 5,
    })
    const body = capturedBody as { documents: string[] } | null
    assert.ok(body, "body parsed")
    assert.equal(body!.documents.length, 5, "only topN documents sent to API")
  })
})

describe("buildRerankQuery", () => {
  it("composes role + skills + industries into short string", () => {
    const q = buildRerankQuery({
      recentRoleTitle: "Data Analyst",
      topSkills: ["Python", "SQL", "Tableau", "PowerBI", "A/B testing"],
      industryTags: ["tech_software", "ai_ml", "fintech_finance"],
    })
    assert.match(q, /Data Analyst/)
    assert.match(q, /Python/)
    assert.match(q, /tech_software/)
    assert.ok(q.length < 480, "query stays compact")
  })
  it("filters 'other' from industry tags + handles missing inputs", () => {
    const q = buildRerankQuery({
      recentRoleTitle: null,
      topSkills: null,
      industryTags: ["other", "tech_software"],
    })
    assert.match(q, /tech_software/)
    assert.doesNotMatch(q, /other/)
  })
  it("returns empty string when all inputs are missing", () => {
    assert.equal(buildRerankQuery({}), "")
  })
})

describe("buildJobCandidateText", () => {
  it("composes title + company + industry + skills", () => {
    const t = buildJobCandidateText({
      jobTitle: "Senior Data Scientist",
      companyName: "Stripe",
      industryKey: "fintech",
      requiredSkills: ["Python", "PyTorch", "SQL"],
    })
    assert.match(t, /Senior Data Scientist/)
    assert.match(t, /Stripe/)
    assert.match(t, /fintech/)
    assert.match(t, /skills: Python, PyTorch, SQL/)
  })
  it("handles missing fields gracefully", () => {
    const t = buildJobCandidateText({ jobTitle: "Engineer" })
    assert.match(t, /Engineer/)
  })
})


// ===========================================================================
// Stream I (v1.5 / Phase 43.5) — Startup-vs-corp scoring boost tests.
// Eight cases per the task brief.
// ===========================================================================

describe("Stream I — startup-vs-corp boost", () => {
  it("user strong-yes startup × Stripe (FAANG allowlist) → ×1.0", () => {
    const userSignal = userPreferStartup({
      statedPreferences: { prefersStartup: true },
      cvExperiences: [],
    })
    assert.equal(userSignal, 1.0, "stated true → strong-yes")
    const mult = computeStartupBoost(userSignal, {
      companyName: "Stripe",
      jobTitle: "Senior PM",
    })
    // Stripe is in FAANG_ALLOWLIST so isStartupJob → false. Strong-yes × FAANG
    // is NOT a defined boost combo → ×1.0 (Stripe is not a startup, even
    // though it's not "FAANG" by acronym).
    assert.equal(mult, 1.0, "Stripe is allowlisted as not-startup → no boost")
    assert.equal(isFaangCompany("Stripe"), true)
    assert.equal(isFaangCompany("STRIPE"), true, "case-insensitive lookup")
  })

  it("user strong-yes startup × early-stage YC company → ×1.3", () => {
    const userSignal = userPreferStartup({
      statedPreferences: { prefersStartup: true },
    })
    const mult = computeStartupBoost(userSignal, {
      companyName: "Acme Robotics (YC W24)",
      jobTitle: "Founding Engineer",
      companyEmployeeCount: 12,
    })
    assert.equal(mult, BOOST_WEIGHTS.STRONG_YES_STARTUP)
    assert.equal(mult, 1.3)
  })

  it("user lean-yes (CV-detected) startup × early-stage → ×1.15", () => {
    const userSignal = userPreferStartup({
      // No stated prefs — CV alone determines lean-yes.
      cvExperiences: [{ company: "Mercury (Series A)", companyEmployeeCount: 80 }],
    })
    assert.equal(userSignal, 0.5, "CV-only signal → lean-yes")
    const mult = computeStartupBoost(userSignal, {
      companyName: "EarlyCo",
      companyEmployeeCount: 20,
    })
    assert.equal(mult, BOOST_WEIGHTS.LEAN_YES_STARTUP)
    assert.equal(mult, 1.15)
  })

  it("user strong-no × Google (FAANG) → ×1.2 (FAANG-native gets FAANG boost)", () => {
    const userSignal = userPreferStartup({
      statedPreferences: { prefersStartup: false },
      cvExperiences: [{ company: "Google", companyEmployeeCount: 180000 }],
    })
    assert.equal(userSignal, -1.0, "stated false + FAANG CV → strong-no")
    const mult = computeStartupBoost(userSignal, {
      companyName: "Google",
      jobTitle: "Staff SWE",
    })
    assert.equal(mult, BOOST_WEIGHTS.STRONG_NO_FAANG)
    assert.equal(mult, 1.2)
  })

  it("user neutral (no stated, no CV signal) × any → ×1.0", () => {
    const userSignal = userPreferStartup({})
    assert.equal(userSignal, 0.0)
    const mult1 = computeStartupBoost(userSignal, {
      companyName: "Acme",
      companyEmployeeCount: 50,
    })
    const mult2 = computeStartupBoost(userSignal, {
      companyName: "Google",
    })
    assert.equal(mult1, 1.0)
    assert.equal(mult2, 1.0)
  })

  it("unknown company size + no FAANG hit + no keyword → conservative no-boost", () => {
    // User strong-yes for startup, but the job has zero startup signal.
    // isStartupJob → null → boost stays 1.0 (we'd rather miss than mis-fire).
    const userSignal = userPreferStartup({
      statedPreferences: { prefersStartup: true },
    })
    assert.equal(isStartupJob({ companyName: "Mid-Stage Inc", jobTitle: "SWE II" }), null)
    const mult = computeStartupBoost(userSignal, {
      companyName: "Mid-Stage Inc",
      jobTitle: "SWE II",
      // companyEmployeeCount intentionally undefined
    })
    assert.equal(mult, 1.0, "unknown signal stays neutral")
  })

  it("allowlist edge case: 'Amazon' company name matches even on non-Amazon-flavored role", () => {
    // The allowlist is companyName-based, so any role at "Amazon" (Web Services,
    // Retail, Studios, Music...) maps to not-startup. This is by design — the
    // boost is about company size/stage, not role flavor.
    assert.equal(isFaangCompany("Amazon"), true)
    assert.equal(isFaangCompany("amazon"), true)
    const userYes = userPreferStartup({
      statedPreferences: { prefersStartup: true },
    })
    const mult = computeStartupBoost(userYes, {
      companyName: "Amazon",
      jobTitle: "Music Editorial Curator",
      companyEmployeeCount: 1500000,
    })
    assert.equal(mult, 1.0, "Amazon stays not-startup regardless of role")
  })

  it("bilingual startup keyword detection: 创业 / 早期 / 我们刚拿到融资", () => {
    // Each keyword on its own should fire isStartupJob → true.
    assert.equal(isStartupJob({ companyName: "某创业公司" }), true, "创业 (zh)")
    assert.equal(isStartupJob({ companyName: "Foo Labs", jobTitle: "早期工程师" }), true, "早期 (zh)")
    assert.equal(isStartupJob({ companyName: "Bar Inc", jobTitle: "我们刚拿到融资 — Eng #3" }), true, "刚拿到融资 (zh)")
    // English bank too — sanity.
    assert.equal(isStartupJob({ companyName: "Series B Robotics" }), true, "series b (en)")
    assert.equal(isStartupJob({ companyName: "Stealth Mode Co" }), true, "stealth mode (en)")
    assert.equal(isStartupJob({ companyName: "Founding Engineer Inc" }), true, "founding engineer (en)")
  })
})

describe("Stream I — applyStartupBoost integration", () => {
  it("flag-off path: neutral user → returns identity ranking + empty explanations", () => {
    const jobs = [
      { id: "a", companyName: "Acme", companyEmployeeCount: 30 },
      { id: "b", companyName: "Google" },
      { id: "c", companyName: "Random Co" },
    ]
    const out = applyStartupBoost(jobs, 0.0)
    assert.deepEqual(out.jobs.map((j) => j.id), ["a", "b", "c"])
    assert.equal(out.explanations.length, 0)
  })

  it("strong-yes user reorders startup ahead of FAANG when base scores are equal", () => {
    const jobs = [
      { id: "faang", companyName: "Google" },
      { id: "startup", companyName: "Acme YC W24", companyEmployeeCount: 15 },
    ]
    const out = applyStartupBoost(jobs, 1.0)
    assert.equal(out.jobs[0]!.id, "startup", "startup should now lead")
    assert.equal(out.explanations.length, 1)
    assert.equal(out.explanations[0]!.jobId, "startup")
    assert.equal(out.explanations[0]!.boostMult, 1.3)
    assert.equal(out.explanations[0]!.jobSignal, "startup")
  })

  it("respects baseScores when provided (cross-encoder integration)", () => {
    const jobs = [
      { id: "x", companyName: "Tiny Co", companyEmployeeCount: 25 },
      { id: "y", companyName: "Random Mid", companyEmployeeCount: 5000 },
    ]
    const baseScores = new Map<string, number | null>([
      ["x", 0.5],
      ["y", 0.9],
    ])
    // Without boost: y > x. With strong-yes startup boost: x*1.3=0.65, y*1.0=0.9 → y still wins.
    const out = applyStartupBoost(jobs, 1.0, baseScores)
    assert.equal(out.jobs[0]!.id, "y")
    // But if x's base was 0.8: 0.8*1.3=1.04 > 0.9 → x wins.
    const baseScores2 = new Map<string, number | null>([
      ["x", 0.8],
      ["y", 0.9],
    ])
    const out2 = applyStartupBoost(jobs, 1.0, baseScores2)
    assert.equal(out2.jobs[0]!.id, "x", "boosted x should overtake y")
  })

  it("latency budget: < 5ms over 100 jobs", () => {
    const jobs = Array.from({ length: 100 }, (_, i) => ({
      id: `j${i}`,
      companyName: i % 7 === 0 ? "Google" : i % 5 === 0 ? "Series B Co" : `Random ${i}`,
      companyEmployeeCount: i * 50,
      jobTitle: i % 11 === 0 ? "founding engineer" : "senior engineer",
    }))
    const t0 = performance.now()
    for (let k = 0; k < 10; k++) {
      applyStartupBoost(jobs, 1.0)
    }
    const elapsed = (performance.now() - t0) / 10
    assert.ok(elapsed < 5, `boost must be < 5ms over 100 jobs, got ${elapsed.toFixed(2)}ms`)
  })
})
