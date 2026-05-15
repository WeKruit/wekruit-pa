/**
 * Phase 56 — `queryMatchingJobsV16` end-to-end tests.
 *
 * Covers MATCH-01..08:
 *   - loadUserTags single-source read (MATCH-01)
 *   - role-function array-contains-any + 10-cap (MATCH-03)
 *   - hard filter chain order + per-gate drop accounting (MATCH-04)
 *   - score weights + per-skill weighted Jaccard (MATCH-05/06)
 *   - top-2 reasoning, lang-aware (MATCH-07)
 *   - firstSeenAt < 20d freshness window (MATCH-08, lastSeenAt unused)
 *   - cache-miss graceful degradation (jdrel default 1.0; llm default 0)
 */

import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../mock-firestore.js"
import {
  loadUserTags,
  loadJdRelCache,
  loadLlmRerankCache,
  applyV16HardFilters,
  computeWeightedSkillJaccard,
  computeOverlap,
  cosineSim,
  computeSalaryFit,
  scoreV16Job,
  composeReason,
  queryMatchingJobsV16,
} from "../../tools/query-matching-jobs-v16.js"
import { V16_SCORE_WEIGHTS, V16_SCORE_WEIGHTS_SUM } from "../../match-weights.js"
import type { MatchingJob } from "../../types.js"

const NOW = Date.parse("2026-05-06T12:00:00Z")
const FRESH_TS = new Date(NOW - 5 * 24 * 3600 * 1000).toISOString()
const STALE_TS = new Date(NOW - 25 * 24 * 3600 * 1000).toISOString()

// ---------------------------------------------------------------------------
// Score weight invariant
// ---------------------------------------------------------------------------

test("V16_SCORE_WEIGHTS sum to 1.0 (within fp tolerance)", () => {
  assert.ok(Math.abs(V16_SCORE_WEIGHTS_SUM - 1.0) < 1e-9, `sum=${V16_SCORE_WEIGHTS_SUM}`)
})

// ---------------------------------------------------------------------------
// loadUserTags
// ---------------------------------------------------------------------------

test("loadUserTags: missing doc returns null + logs user_no_tags", async () => {
  const mfs = new MockFirestore()
  const events: string[] = []
  const got = await loadUserTags(asFirestore(mfs), "u1", (e) => events.push(e))
  assert.equal(got, null)
  assert.ok(events.includes("pa.match.user_no_tags"))
})

test("loadUserTags: empty tags object returns null + logs user_no_tags", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u1").set({ tags: {} })
  const events: string[] = []
  const got = await loadUserTags(asFirestore(mfs), "u1", (e) => events.push(e))
  assert.equal(got, null)
  assert.ok(events.includes("pa.match.user_no_tags"))
})

test("loadUserTags: non-empty tags returns the tags object", async () => {
  const mfs = new MockFirestore()
  const tags = { skills: ["python"], industryEnum: ["tech_software"], schemaVersion: 1 }
  await mfs.collection("pa-users").doc("u1").set({ tags })
  const got = await loadUserTags(asFirestore(mfs), "u1")
  assert.deepEqual(got, tags)
})

test("loadUserTags: invalid userId returns null", async () => {
  const mfs = new MockFirestore()
  // empty / non-string → null
  // @ts-expect-error testing bad input
  const got = await loadUserTags(asFirestore(mfs), 0)
  assert.equal(got, null)
})

// ---------------------------------------------------------------------------
// computeWeightedSkillJaccard
// ---------------------------------------------------------------------------

test("computeWeightedSkillJaccard: full overlap → 1.0", () => {
  const r = computeWeightedSkillJaccard(["python", "typescript"], ["python", "typescript"])
  assert.equal(r.score, 1.0)
  assert.equal(r.matched.length, 2)
})

test("computeWeightedSkillJaccard: no overlap → 0", () => {
  const r = computeWeightedSkillJaccard(["python"], ["go"])
  assert.equal(r.score, 0)
  assert.equal(r.matched.length, 0)
})

test("computeWeightedSkillJaccard: case + space normalize correctly", () => {
  const r = computeWeightedSkillJaccard(["Machine Learning"], ["machine_learning"])
  assert.equal(r.score, 1.0)
})

test("computeWeightedSkillJaccard: jdRel weights amplify matched skill", () => {
  // user has 2 skills, both in job; jdRel is 5x for python, 1x for git
  // total = 0.5*5 + 0.5*1 = 3.0; matched = same → 1.0 still
  const full = computeWeightedSkillJaccard(["python", "git"], ["python", "git"], { python: 5, git: 1 })
  assert.equal(full.score, 1.0)
  // user has python+git; job has python only → matched=0.5*5=2.5; total=3.0 → 0.833
  const partial = computeWeightedSkillJaccard(["python", "git"], ["python"], { python: 5, git: 1 })
  assert.ok(Math.abs(partial.score - 2.5 / 3.0) < 1e-9)
  // matched contains python with weight 2.5
  assert.equal(partial.matched.length, 1)
  assert.equal(partial.matched[0]!.name, "python")
  assert.ok(Math.abs(partial.matched[0]!.weight - 2.5) < 1e-9)
})

test("computeWeightedSkillJaccard: missing jdRel cache → defaults to 1.0", () => {
  const r = computeWeightedSkillJaccard(["python"], ["python"])
  assert.equal(r.score, 1.0)
  // weight = 0.5 base × 1.0 default = 0.5
  assert.ok(Math.abs(r.matched[0]!.weight - 0.5) < 1e-9)
})

test("computeWeightedSkillJaccard: matched sorted desc by weight", () => {
  const r = computeWeightedSkillJaccard(
    ["python", "typescript", "kubernetes"],
    ["python", "typescript", "kubernetes"],
    { python: 1, typescript: 5, kubernetes: 2 }
  )
  assert.equal(r.matched[0]!.name, "typescript")
  assert.equal(r.matched[1]!.name, "kubernetes")
  assert.equal(r.matched[2]!.name, "python")
})

// ---------------------------------------------------------------------------
// computeOverlap
// ---------------------------------------------------------------------------

test("computeOverlap: max-denominator semantics", () => {
  // |a|=2 |b|=3 hits=2 → 2/3
  assert.ok(Math.abs(computeOverlap(["a", "b"], ["a", "b", "c"]) - 2 / 3) < 1e-9)
})

test("computeOverlap: empty sides → 0", () => {
  assert.equal(computeOverlap([], ["a"]), 0)
  assert.equal(computeOverlap(["a"], []), 0)
  assert.equal(computeOverlap(undefined, ["a"]), 0)
})

// ---------------------------------------------------------------------------
// cosineSim
// ---------------------------------------------------------------------------

test("cosineSim: parallel vectors → 1.0", () => {
  assert.ok(Math.abs(cosineSim([1, 2, 3], [1, 2, 3]) - 1.0) < 1e-9)
})

test("cosineSim: orthogonal → 0", () => {
  assert.equal(cosineSim([1, 0], [0, 1]), 0)
})

test("cosineSim: dimension mismatch → 0", () => {
  assert.equal(cosineSim([1, 2], [1, 2, 3]), 0)
})

// ---------------------------------------------------------------------------
// computeSalaryFit
// ---------------------------------------------------------------------------

test("computeSalaryFit: job >= user → 1.0", () => {
  assert.equal(computeSalaryFit(100_000, 150_000), 1.0)
})

test("computeSalaryFit: job below by $50K → 0", () => {
  assert.equal(computeSalaryFit(150_000, 100_000), 0)
})

test("computeSalaryFit: missing either side → 0.5 neutral", () => {
  assert.equal(computeSalaryFit(undefined, 100_000), 0.5)
  assert.equal(computeSalaryFit(100_000, null), 0.5)
})

// ---------------------------------------------------------------------------
// applyV16HardFilters — gate-by-gate
// ---------------------------------------------------------------------------

function mkJob(over: Partial<MatchingJob>): MatchingJob {
  return {
    id: over.id ?? "j1",
    companyName: "Acme",
    jobTitle: "SWE",
    salaryMin: null,
    salaryMax: null,
    locationRaw: "San Francisco, CA",
    primaryUrl: "https://example.com/p",
    atsApplyUrl: "https://greenhouse.io/co/jobs/123",
    industry: "tech",
    sponsorship: null,
    firstSeenAt: FRESH_TS,
    ...over,
  }
}

test("applyV16HardFilters: visa gate drops sponsor_needed × sponsorship=false", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "y", sponsorship: true }),
    mkJob({ id: "n", sponsorship: false }),
    mkJob({ id: "u", sponsorship: null }),
  ]
  const tags = { skills: [], industryEnum: [], schemaVersion: 1, visaStatus: "sponsor_needed" } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.equal(r.kept.length, 2)
  assert.deepEqual(
    r.kept.map((j) => j.id).sort(),
    ["u", "y"].sort()
  )
  assert.equal(r.counters.visa, 1)
})

test("applyV16HardFilters: visa gate is no-op when user is citizen", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "y", sponsorship: true }),
    mkJob({ id: "n", sponsorship: false }),
  ]
  const tags = { skills: [], industryEnum: [], schemaVersion: 1, visaStatus: "citizen" } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.equal(r.kept.length, 2)
  assert.equal(r.counters.visa, 0)
})

test("applyV16HardFilters: location intersect bypasses for remote_anywhere", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "x", locationBuckets: ["new_york_city"] }),
    mkJob({ id: "y", locationBuckets: ["los_angeles"] }),
  ]
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    targetLocations: ["remote_anywhere"],
  } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.equal(r.kept.length, 2)
})

test("applyV16HardFilters: location intersect drops non-overlap", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "x", locationBuckets: ["new_york_city"] }),
    mkJob({ id: "y", locationBuckets: ["los_angeles"] }),
  ]
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    targetLocations: ["new_york_city"],
  } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]!.id, "x")
  assert.equal(r.counters.location, 1)
})

test("applyV16HardFilters: location falls back to locationRaw substring when locationBuckets missing", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "remote", locationRaw: "Remote, USA" }),
    mkJob({ id: "ny", locationRaw: "New York, NY" }),
  ]
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    targetLocations: ["remote_anywhere"],
  } as never
  // anywhere bypass — both kept
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.equal(r.kept.length, 2)
})

test("applyV16HardFilters: careerStage window enforces (entry → entry/junior, drops senior)", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "e", seniorityLevel: "entry_level" }),
    mkJob({ id: "j", seniorityLevel: "junior" }),
    mkJob({ id: "s", seniorityLevel: "senior" }),
    mkJob({ id: "m", seniorityLevel: "mid_level" }),
  ]
  const tags = { skills: [], industryEnum: [], schemaVersion: 1, careerStage: "entry_level" } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  // entry_level adjacency: intern, entry_level, junior — keep e/j; drop s/m
  assert.deepEqual(r.kept.map((j) => j.id).sort(), ["e", "j"])
  assert.equal(r.counters.careerStage, 2)
})

test("applyV16HardFilters: jobType exact intersect", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "ft", jobType: "full_time" }),
    mkJob({ id: "ct", jobType: "contract" }),
    mkJob({ id: "in", jobType: "internship" }),
  ]
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    targetJobType: ["full_time", "internship"],
  } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.deepEqual(r.kept.map((j) => j.id).sort(), ["ft", "in"])
  assert.equal(r.counters.jobType, 1)
})

test("applyV16HardFilters: firstSeenAt > 20d drops, < 20d keeps (MATCH-08, lastSeenAt unused)", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "fresh", firstSeenAt: FRESH_TS, lastSeenAt: STALE_TS }), // lastSeenAt stale should NOT matter
    mkJob({ id: "stale", firstSeenAt: STALE_TS, lastSeenAt: FRESH_TS }),
    mkJob({ id: "noTs", firstSeenAt: undefined }),
  ]
  const tags = { skills: [], industryEnum: [], schemaVersion: 1 } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]!.id, "fresh")
  assert.equal(r.counters.freshness, 2)
})

test("applyV16HardFilters: atsApplyUrl missing or jobright.ai drops", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "ok", atsApplyUrl: "https://greenhouse.io/co/jobs/1" }),
    mkJob({ id: "miss", atsApplyUrl: undefined }),
    mkJob({ id: "jr", atsApplyUrl: "https://jobright.ai/jobs/1" }),
  ]
  const tags = { skills: [], industryEnum: [], schemaVersion: 1 } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]!.id, "ok")
  assert.equal(r.counters.atsApplyUrl, 2)
})

test("applyV16HardFilters: dead=true drops; dead=false/undefined kept", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "alive", dead: false }),
    mkJob({ id: "dead", dead: true }),
    mkJob({ id: "unknown", dead: undefined }),
  ]
  const tags = { skills: [], industryEnum: [], schemaVersion: 1 } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.deepEqual(r.kept.map((j) => j.id).sort(), ["alive", "unknown"])
  assert.equal(r.counters.dead, 1)
})

// ---------------------------------------------------------------------------
// composeReason
// ---------------------------------------------------------------------------

test("composeReason: top-2 weighted matched skills surface zh by default", () => {
  const tags = { skills: [], industryEnum: [], schemaVersion: 1 } as never
  const job = mkJob({})
  const matched = [
    { name: "python", proficiency: "advanced", weight: 5 },
    { name: "typescript", proficiency: "expert", weight: 3 },
    { name: "git", proficiency: "intermediate", weight: 1 },
  ]
  const reason = composeReason(tags, job, matched, {
    llmMatch: 0,
    skillJaccard: 0.5,
    relevantTags: 0,
    industrySector: 0,
    cvEmbCosine: 0,
    salaryFit: 0,
    tagOverlap: 0,
    positiveHit: 0,
    urgencyBoost: 0,
    total: 0.1,
  })
  // top-2: python + typescript only
  assert.match(reason, /python\(advanced\)/)
  assert.match(reason, /typescript\(expert\)/)
  // no third skill
  assert.ok(!reason.includes("git"))
  assert.match(reason, /为啥推/)
})

test("composeReason: en lang switch when preferredLang='en'", () => {
  const tags = { skills: [], industryEnum: [], schemaVersion: 1, preferredLang: "en" } as never
  const job = mkJob({})
  const reason = composeReason(
    tags,
    job,
    [{ name: "python", proficiency: "advanced", weight: 1 }],
    { llmMatch: 0, skillJaccard: 0.5, relevantTags: 0, industrySector: 0, cvEmbCosine: 0, salaryFit: 0, tagOverlap: 0, positiveHit: 0, urgencyBoost: 0, total: 0.1 }
  )
  assert.match(reason, /Why match/)
  assert.match(reason, /python/)
})

test("composeReason: empty matched falls back to industry-only message when industry score >= 0.4", () => {
  const tags = { skills: [], industryEnum: [], schemaVersion: 1 } as never
  const job = mkJob({})
  const reason = composeReason(tags, job, [], {
    llmMatch: 0,
    skillJaccard: 0,
    relevantTags: 0,
    industrySector: 0.5,
    cvEmbCosine: 0,
    salaryFit: 0,
    tagOverlap: 0,
    positiveHit: 0,
    urgencyBoost: 0,
    total: 0.05,
  })
  assert.match(reason, /行业方向/)
})

// ---------------------------------------------------------------------------
// Cache readers
// ---------------------------------------------------------------------------

test("loadJdRelCache: empty returns empty Map", async () => {
  const mfs = new MockFirestore()
  const m = await loadJdRelCache(asFirestore(mfs), "u1")
  assert.equal(m.size, 0)
})

test("loadJdRelCache: reads valid jdRelativeWeights into map keyed by jobId", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-user-skill-jdrel-cache")
    .doc("u1")
    .collection("jobs")
    .doc("jobA")
    .set({ jdRelativeWeights: { python: 5, typescript: 1 } })
  await mfs
    .collection("pa-user-skill-jdrel-cache")
    .doc("u1")
    .collection("jobs")
    .doc("jobB")
    .set({ jdRelativeWeights: { python: 1 } })
  const m = await loadJdRelCache(asFirestore(mfs), "u1")
  assert.equal(m.size, 2)
  assert.deepEqual(m.get("jobA"), { python: 5, typescript: 1 })
  assert.deepEqual(m.get("jobB"), { python: 1 })
})

test("loadLlmRerankCache: missing → empty map, not stale", async () => {
  const mfs = new MockFirestore()
  const r = await loadLlmRerankCache(asFirestore(mfs), "u1")
  assert.equal(r.map.size, 0)
  assert.equal(r.stale, false)
})

test("loadLlmRerankCache: fresh cache returns map", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-user-rerank-cache").doc("u1").set({
    computedAt: new Date().toISOString(),
    ranked: [
      { jobId: "j1", llmScore: 0.8 },
      { jobId: "j2", llmScore: 0.4 },
      { jobId: "j3", llmScore: "bad" }, // dropped silently
    ],
  })
  const r = await loadLlmRerankCache(asFirestore(mfs), "u1")
  assert.equal(r.stale, false)
  assert.equal(r.map.size, 2)
  assert.equal(r.map.get("j1"), 0.8)
})

test("loadLlmRerankCache: > 36h stale → returns empty map + stale=true", async () => {
  const mfs = new MockFirestore()
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  await mfs.collection("pa-user-rerank-cache").doc("u1").set({
    computedAt: old,
    ranked: [{ jobId: "j1", llmScore: 0.8 }],
  })
  const events: string[] = []
  const r = await loadLlmRerankCache(asFirestore(mfs), "u1", (e) => events.push(e))
  assert.equal(r.stale, true)
  assert.equal(r.map.size, 0)
  assert.ok(events.includes("pa.match.llm_cache_stale"))
})

// ---------------------------------------------------------------------------
// scoreV16Job — end-to-end weighted blend
// ---------------------------------------------------------------------------

test("scoreV16Job: missing jdrel + missing llm → score = sum of skillJaccard + emb + salary only", () => {
  const tags = {
    skills: ["python"],
    industryEnum: ["tech_software"],
    schemaVersion: 1,
  } as never
  const job = mkJob({ requiredSkills: ["python"] })
  const r = scoreV16Job(tags, job)
  // skillJaccard = 1.0 → 0.20 weight
  // salary fit = 0.5 (both missing) → 0.05 * 0.5 = 0.025
  // others = 0
  const expected = 0.20 + 0.05 * 0.5
  assert.ok(Math.abs(r.breakdown.total - expected) < 1e-6, `total=${r.breakdown.total}`)
})

test("scoreV16Job: llm cache present applies 0.40 weight", () => {
  const tags = { skills: [], industryEnum: [], schemaVersion: 1 } as never
  const job = mkJob({})
  const r = scoreV16Job(tags, job, undefined, 0.7)
  // llmMatch=0.7*0.40 + salary=0.5*0.05 = 0.305
  const expected = 0.7 * V16_SCORE_WEIGHTS.llmMatch + 0.5 * V16_SCORE_WEIGHTS.salaryFit
  assert.ok(Math.abs(r.breakdown.total - expected) < 1e-6)
})

// ---------------------------------------------------------------------------
// Phase 70 — scoreV16Job weight overrides
// ---------------------------------------------------------------------------

test("scoreV16Job: undefined overrides → byte-identical to canonical V16", () => {
  const tags = {
    skills: ["python"],
    industryEnum: ["tech_software"],
    schemaVersion: 1,
  } as never
  const job = mkJob({ requiredSkills: ["python"] })
  const a = scoreV16Job(tags, job, undefined, 0.5)
  const b = scoreV16Job(tags, job, undefined, 0.5, undefined)
  assert.equal(a.breakdown.total, b.breakdown.total)
  assert.equal(a.breakdown.skillJaccard, b.breakdown.skillJaccard)
})

test("scoreV16Job: weightOverrides replaces only the supplied keys", () => {
  const tags = {
    skills: ["python"],
    industryEnum: [],
    schemaVersion: 1,
  } as never
  const job = mkJob({ requiredSkills: ["python"] })
  // Override skillJaccard from 0.20 → 0.50; leave salaryFit canonical at 0.05.
  const r = scoreV16Job(tags, job, undefined, 0, { skillJaccard: 0.5 })
  // skillJaccard=1.0 * 0.5 + salary=0.5 * 0.05 = 0.525
  const expected = 1.0 * 0.5 + 0.5 * V16_SCORE_WEIGHTS.salaryFit
  assert.ok(Math.abs(r.breakdown.total - expected) < 1e-6, `total=${r.breakdown.total}`)
})

test("scoreV16Job: weightOverrides clamps NaN/non-numeric → fallback to canonical", () => {
  const tags = {
    skills: ["python"],
    industryEnum: [],
    schemaVersion: 1,
  } as never
  const job = mkJob({ requiredSkills: ["python"] })
  const r = scoreV16Job(tags, job, undefined, 0, {
    skillJaccard: NaN as never,
  })
  // NaN falls back to canonical 0.20.
  const expected = 1.0 * V16_SCORE_WEIGHTS.skillJaccard + 0.5 * V16_SCORE_WEIGHTS.salaryFit
  assert.ok(Math.abs(r.breakdown.total - expected) < 1e-6, `total=${r.breakdown.total}`)
})

test("scoreV16Job: weightOverrides zeroing component drops its contribution", () => {
  const tags = { skills: [], industryEnum: [], schemaVersion: 1 } as never
  const job = mkJob({})
  // Zero salaryFit so the only fallback (=0.5 neutral) doesn't contribute.
  const r = scoreV16Job(tags, job, undefined, 0.7, { salaryFit: 0 })
  const expected = 0.7 * V16_SCORE_WEIGHTS.llmMatch
  assert.ok(Math.abs(r.breakdown.total - expected) < 1e-6, `total=${r.breakdown.total}`)
})

// ---------------------------------------------------------------------------
// queryMatchingJobsV16 — end-to-end happy path
// ---------------------------------------------------------------------------

async function seedJob(mfs: MockFirestore, id: string, over: Record<string, unknown>): Promise<void> {
  await mfs
    .collection("matching-jobs")
    .doc(id)
    .set({
      id,
      status: "active",
      companyName: "Acme",
      roleTitle: "SWE",
      jobTitle: "SWE",
      atsApplyUrl: `https://greenhouse.io/co/${id}`,
      primaryUrl: `https://example.com/${id}`,
      industry: "tech",
      industryKey: "tech",
      sponsorship: null,
      locationRaw: "San Francisco, CA",
      firstSeenAt: FRESH_TS,
      ...over,
    })
}

test("queryMatchingJobsV16: empty user tags → noUserTags=true + empty result", async () => {
  const mfs = new MockFirestore()
  const r = await queryMatchingJobsV16(
    { userId: "u_missing" },
    { db: asFirestore(mfs) }
  )
  assert.equal(r.noUserTags, true)
  assert.equal(r.jobs.length, 0)
  assert.equal(r.total, 0)
})

test("queryMatchingJobsV16: with role-fn filter returns matching jobs", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u1")
    .set({
      tags: {
        skills: ["python", "typescript"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
      },
    })
  // 2026-05-07 — differentiate (companyName, jobTitle) so Bug E dedup
  // (commit e266f92) doesn't collapse two distinct SWE jobs.
  await seedJob(mfs, "swe1", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python", "typescript"],
    companyName: "AcmeOne",
    jobTitle: "SWE-1",
  })
  await seedJob(mfs, "swe2", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "AcmeTwo",
    jobTitle: "SWE-2",
  })
  await seedJob(mfs, "sales1", {
    roleFunction: ["sales"],
    requiredSkills: ["salesforce"],
  })
  const r = await queryMatchingJobsV16(
    { userId: "u1", nowMs: NOW },
    { db: asFirestore(mfs) }
  )
  assert.equal(r.noUserTags, undefined)
  // Only the 2 SWE jobs returned (sales1 filtered by array-contains-any)
  assert.equal(r.jobs.length, 2)
  // swe1 should outrank swe2 (more skill match)
  assert.equal(r.jobs[0]!.id, "swe1")
  assert.ok(r.jobs[0]!.v16Score.total >= r.jobs[1]!.v16Score.total)
  // Reason mentions a matched skill
  assert.match(r.jobs[0]!.reason, /python|typescript/)
  // Phase 70 — userTags surfaced for admin debug surface
  assert.ok(r.userTags && typeof r.userTags === "object")
  assert.deepEqual(
    (r.userTags as Record<string, unknown>).targetRoleFunction,
    ["software_engineering"],
  )
})

test("queryMatchingJobsV16: S4 enriched approved job survives V16 filters and outranks weaker same-role job", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u1")
    .set({
      tags: {
        skills: ["python", "typescript"],
        relevantTags: ["backend_platforms", "developer_tools"],
        industrySector: ["enterprise_software"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
        targetJobType: ["full_time"],
        targetLocations: ["new_york_city"],
        careerStage: "entry_level",
        visaStatus: "sponsor_needed",
      },
    })

  await seedJob(mfs, "s4-enriched", {
    roleFunction: ["software_engineering"],
    industrySector: ["enterprise_software"],
    relevantTags: ["backend_platforms", "developer_tools"],
    requiredSkills: ["python", "typescript"],
    jobType: "full_time",
    locationBuckets: ["new_york_city"],
    seniorityLevel: "junior",
    sponsorship: null,
    companyName: "S4Co",
    jobTitle: "Backend Engineer",
  })
  await seedJob(mfs, "same-role-weaker", {
    roleFunction: ["software_engineering"],
    industrySector: ["consumer_internet"],
    relevantTags: ["growth_marketing"],
    requiredSkills: ["go"],
    jobType: "full_time",
    locationBuckets: ["new_york_city"],
    seniorityLevel: "junior",
    sponsorship: true,
    companyName: "WeakCo",
    jobTitle: "Backend Engineer",
  })
  await seedJob(mfs, "wrong-role", {
    roleFunction: ["sales"],
    industrySector: ["enterprise_software"],
    relevantTags: ["backend_platforms", "developer_tools"],
    requiredSkills: ["python", "typescript"],
    jobType: "full_time",
    locationBuckets: ["new_york_city"],
    seniorityLevel: "junior",
    sponsorship: true,
    companyName: "SalesCo",
    jobTitle: "Account Executive",
  })

  const r = await queryMatchingJobsV16({ userId: "u1", nowMs: NOW }, { db: asFirestore(mfs) })

  assert.equal(r.jobs.length, 2)
  assert.deepEqual(r.jobs.map((j) => j.id), ["s4-enriched", "same-role-weaker"])
  assert.ok(!r.jobs.some((j) => j.id === "wrong-role"))
  assert.equal(r.hardFilter.visa, 0)
  assert.equal(r.hardFilter.location, 0)
  assert.equal(r.hardFilter.careerStage, 0)
  assert.equal(r.hardFilter.jobType, 0)
  assert.equal(r.jobs[0]!.v16Score.skillJaccard, 1)
  assert.equal(r.jobs[0]!.v16Score.relevantTags, 1)
  assert.equal(r.jobs[0]!.v16Score.industrySector, 1)
  assert.ok(r.jobs[0]!.v16Score.total > r.jobs[1]!.v16Score.total)
})

test("queryMatchingJobsV16: weightOverrides propagate to scoreV16Job (Phase 70)", async () => {
  // Same fixture as the prior test — flipping skillJaccard to 0 should
  // collapse swe1's lead over swe2 (their llm/relTags/etc components are
  // identical because both lack caches; the diff was 100% skill Jaccard).
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u1")
    .set({
      tags: {
        skills: ["python", "typescript"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
      },
    })
  // 2026-05-07 — differentiate (companyName, jobTitle) so Bug E dedup
  // (commit e266f92) doesn't collapse two distinct SWE jobs.
  await seedJob(mfs, "swe1", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python", "typescript"],
    companyName: "AcmeOne",
    jobTitle: "SWE-1",
  })
  await seedJob(mfs, "swe2", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "AcmeTwo",
    jobTitle: "SWE-2",
  })

  // With canonical weights swe1 has higher skillJaccard contribution.
  const baseline = await queryMatchingJobsV16(
    { userId: "u1", nowMs: NOW },
    { db: asFirestore(mfs) }
  )
  assert.ok(baseline.jobs[0]!.v16Score.skillJaccard > 0)

  // Zeroing skillJaccard via overrides → both jobs should get skill weight 0
  // contribution (other components dominate).
  const override = await queryMatchingJobsV16(
    {
      userId: "u1",
      nowMs: NOW,
      weightOverrides: { skillJaccard: 0 },
    },
    { db: asFirestore(mfs) }
  )
  // Component values still echoed unchanged (clamping happens on weights only).
  assert.equal(
    override.jobs[0]!.v16Score.skillJaccard,
    baseline.jobs[0]!.v16Score.skillJaccard,
  )
  // But total must be lower than baseline because skillJaccard contribution
  // gone (everything else equal).
  assert.ok(
    override.jobs[0]!.v16Score.total < baseline.jobs[0]!.v16Score.total,
    `override total ${override.jobs[0]!.v16Score.total} should be < baseline ${baseline.jobs[0]!.v16Score.total}`,
  )
})

test("queryMatchingJobsV16: caps targetRoleFunction at 10", async () => {
  const mfs = new MockFirestore()
  const elevenRoles = [
    "software_engineering",
    "engineering_and_development",
    "data_analysis",
    "product_management",
    "business_analyst",
    "creatives_and_design",
    "consultant",
    "accounting_and_finance",
    "marketing",
    "management_and_executive",
    "sales", // 11th — should be sliced off
  ]
  await mfs
    .collection("pa-users")
    .doc("u1")
    .set({
      tags: {
        skills: ["x"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: elevenRoles,
      },
    })
  // Sales job should NOT be returned because sales is the 11th token, sliced off.
  await seedJob(mfs, "sales1", { roleFunction: ["sales"], requiredSkills: ["x"] })
  await seedJob(mfs, "swe1", { roleFunction: ["software_engineering"], requiredSkills: ["x"] })
  const r = await queryMatchingJobsV16({ userId: "u1", nowMs: NOW }, { db: asFirestore(mfs) })
  // only swe1 reachable
  assert.equal(r.jobs.length, 1)
  assert.equal(r.jobs[0]!.id, "swe1")
})

test("queryMatchingJobsV16: hard-filter chain runs in correct order; counters surfaced", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u1")
    .set({
      tags: {
        skills: ["python"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
        visaStatus: "sponsor_needed",
      },
    })
  await seedJob(mfs, "ok", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    sponsorship: true,
    atsApplyUrl: "https://greenhouse.io/co/ok",
  })
  await seedJob(mfs, "noVisa", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    sponsorship: false,
  })
  await seedJob(mfs, "jrLeak", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    sponsorship: true,
    atsApplyUrl: "https://jobright.ai/jobs/1",
  })
  await seedJob(mfs, "stale", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    sponsorship: true,
    firstSeenAt: STALE_TS,
  })
  const r = await queryMatchingJobsV16({ userId: "u1", nowMs: NOW }, { db: asFirestore(mfs) })
  assert.equal(r.jobs.length, 1)
  assert.equal(r.jobs[0]!.id, "ok")
  assert.equal(r.dropped, 3)
  assert.equal(r.hardFilter.visa, 1)
  assert.equal(r.hardFilter.atsApplyUrl, 1)
  assert.equal(r.hardFilter.freshness, 1)
})

test("queryMatchingJobsV16: lastSeenAt is NOT consulted (MATCH-08, D10)", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u1")
    .set({
      tags: {
        skills: ["python"],
        industryEnum: [],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
      },
    })
  // job is FRESH on firstSeenAt but STALE on lastSeenAt — must still pass.
  await seedJob(mfs, "fresh-by-first", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    firstSeenAt: FRESH_TS,
    lastSeenAt: STALE_TS,
    sponsorship: true,
  })
  const r = await queryMatchingJobsV16({ userId: "u1", nowMs: NOW }, { db: asFirestore(mfs) })
  assert.equal(r.jobs.length, 1)
  assert.equal(r.jobs[0]!.id, "fresh-by-first")
  assert.equal(r.hardFilter.freshness, 0)
})

test("queryMatchingJobsV16: stale llm cache surfaces flag, score still produced", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u1")
    .set({
      tags: {
        skills: ["python"],
        industryEnum: [],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
      },
    })
  // stale rerank cache
  await mfs
    .collection("pa-user-rerank-cache")
    .doc("u1")
    .set({
      computedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      ranked: [{ jobId: "swe1", llmScore: 0.99 }],
    })
  await seedJob(mfs, "swe1", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    sponsorship: true,
  })
  const r = await queryMatchingJobsV16({ userId: "u1", nowMs: NOW }, { db: asFirestore(mfs) })
  assert.equal(r.llmCacheStale, true)
  assert.equal(r.jobs.length, 1)
  // llmMatch component should be 0 (stale → ignored)
  assert.equal(r.jobs[0]!.v16Score.llmMatch, 0)
})

// ---------------------------------------------------------------------------
// Phase B4 — company-pref hard filter + soft boosts
// ---------------------------------------------------------------------------

test("B4 hard filter: companyNegativeList drops matching company", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "ok", companyName: "Anthropic" }),
    mkJob({ id: "no", companyName: "Walgreens" }),
    mkJob({ id: "no2", companyName: "WALGREENS  " }),
  ]
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    companyNegativeList: ["walgreens"],
  } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.equal(r.counters.negativeListDrop, 2)
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]!.id, "ok")
})

test("B4 soft: targetCompanyTags ∩ companyInfo.tags adds tagOverlap*0.15", () => {
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    targetCompanyTags: ["ai_native", "big_tech"],
  } as never
  const job = mkJob({ id: "j", companyName: "Anthropic" })
  const baseline = scoreV16Job(tags, job)
  const boosted = scoreV16Job(tags, job, undefined, undefined, undefined, {
    stage: "series_c",
    tags: ["ai_native"],
  })
  // Jaccard({ai_native,big_tech} ∩ {ai_native}) = 1/2 = 0.5; × 0.15 = 0.075
  assert.ok(Math.abs(boosted.breakdown.tagOverlap - 0.075) < 1e-9)
  assert.ok(Math.abs(boosted.breakdown.total - (baseline.breakdown.total + 0.075)) < 1e-9)
})

test("B4 soft: companyPositiveList hit adds +0.15 positiveHit", () => {
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    companyPositiveList: ["anthropic"],
  } as never
  const job = mkJob({ id: "j", companyName: "Anthropic" })
  const r = scoreV16Job(tags, job)
  assert.equal(r.breakdown.positiveHit, 0.15)
})

test("B4 soft: urgentlySeeking boosts fresh full_time +0.20, penalizes intern -0.10", () => {
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    urgentlySeeking: true,
  } as never
  const freshFt = mkJob({
    id: "ft",
    companyName: "Acme",
    jobType: "full_time",
    firstSeenAt: new Date(NOW - 3 * 24 * 3600 * 1000).toISOString(),
  } as never)
  const intern = mkJob({
    id: "intern",
    companyName: "Acme",
    jobType: "internship",
  } as never)
  const ftScore = scoreV16Job(tags, freshFt, undefined, undefined, undefined, undefined, NOW)
  const internScore = scoreV16Job(tags, intern, undefined, undefined, undefined, undefined, NOW)
  assert.equal(ftScore.breakdown.urgencyBoost, 0.20)
  assert.equal(internScore.breakdown.urgencyBoost, -0.10)
})
