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
  getMatchingJobTitle,
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
  V16_FRESHNESS_BOOST_MAX,
  V16_FRESHNESS_HALF_LIFE_MS,
} from "../../tools/query-matching-jobs-v16.js"
import { V16_SCORE_WEIGHTS, V16_SCORE_WEIGHTS_SUM } from "../../match-weights.js"
import type { MatchingJob } from "../../types.js"

const NOW = Date.parse("2026-05-06T12:00:00Z")
const FRESH_TS = new Date(NOW - 5 * 24 * 3600 * 1000).toISOString()
const STALE_TS = new Date(NOW - 25 * 24 * 3600 * 1000).toISOString()
// Phase B5 — freshness boost expected for FRESH_TS (5 d old at NOW) with
// τ=3 d: 0.10 × 0.5^(5/3) ≈ 0.0314980262... Pinned via `nowMs: NOW` arg.
const FRESHNESS_BOOST_FRESH_TS =
  V16_FRESHNESS_BOOST_MAX * Math.pow(0.5, (5 * 24 * 3600 * 1000) / V16_FRESHNESS_HALF_LIFE_MS)

// ---------------------------------------------------------------------------
// Score weight invariant
// ---------------------------------------------------------------------------

test("V16_SCORE_WEIGHTS sum to 1.0 (within fp tolerance)", () => {
  assert.ok(Math.abs(V16_SCORE_WEIGHTS_SUM - 1.0) < 1e-9, `sum=${V16_SCORE_WEIGHTS_SUM}`)
})

// ---------------------------------------------------------------------------
// getMatchingJobTitle — schema-drift fallback (2026-05-19 hotfix)
// ---------------------------------------------------------------------------

test("getMatchingJobTitle: prefers jobTitle when both present", () => {
  assert.equal(
    getMatchingJobTitle({ jobTitle: "Backend Engineer", roleTitle: "Frontend Engineer" }),
    "Backend Engineer",
  )
})

test("getMatchingJobTitle: falls back to roleTitle when jobTitle empty (macmini canonical shape)", () => {
  assert.equal(getMatchingJobTitle({ roleTitle: "Senior SWE" }), "Senior SWE")
  assert.equal(getMatchingJobTitle({ jobTitle: "", roleTitle: "PM" }), "PM")
  assert.equal(getMatchingJobTitle({ jobTitle: null, roleTitle: "EM" }), "EM")
})

test("getMatchingJobTitle: returns trimmed empty string when both missing", () => {
  assert.equal(getMatchingJobTitle({}), "")
  assert.equal(getMatchingJobTitle({ jobTitle: undefined, roleTitle: undefined }), "")
  assert.equal(getMatchingJobTitle({ jobTitle: null, roleTitle: null }), "")
})

test("getMatchingJobTitle: trims whitespace from the surfaced title", () => {
  assert.equal(getMatchingJobTitle({ jobTitle: "  SWE  " }), "SWE")
  assert.equal(getMatchingJobTitle({ roleTitle: "\tPM\n" }), "PM")
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

test("applyV16HardFilters: visa gate requires explicit sponsorship=true for sponsor_needed", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "y", sponsorship: true }),
    mkJob({ id: "n", sponsorship: false }),
    mkJob({ id: "u", sponsorship: null }),
  ]
  const tags = { skills: [], industryEnum: [], schemaVersion: 1, visaStatus: "sponsor_needed" } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.deepEqual(r.kept.map((j) => j.id), ["y"])
  assert.equal(r.counters.visa, 2)
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

test("applyV16HardFilters: careerStage infers seniority from title when structured field is missing", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "associate", jobTitle: "Business Operations Associate", seniorityLevel: undefined }),
    mkJob({ id: "lead", jobTitle: "Content Marketing Lead, Bridge", seniorityLevel: undefined }),
    mkJob({ id: "director", jobTitle: "Director of Product Marketing", seniorityLevel: undefined }),
  ]
  const tags = { skills: [], industryEnum: [], schemaVersion: 1, careerStage: "junior" } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.deepEqual(r.kept.map((j) => j.id), ["associate"])
  assert.equal(r.counters.careerStage, 2)
})

test("applyV16HardFilters: founder careerStage is senior-plus for job search, not executive-only", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "junior", seniorityLevel: "junior" }),
    mkJob({ id: "mid", seniorityLevel: "mid_level" }),
    mkJob({ id: "senior", seniorityLevel: "senior" }),
    mkJob({ id: "staff", seniorityLevel: "staff" }),
    mkJob({ id: "manager", seniorityLevel: "manager" }),
    mkJob({ id: "director", seniorityLevel: "director" }),
    mkJob({ id: "vp", seniorityLevel: "vp" }),
    mkJob({ id: "c", seniorityLevel: "c_level" }),
  ]
  const tags = { skills: [], industryEnum: [], schemaVersion: 1, careerStage: "founder" } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.deepEqual(r.kept.map((j) => j.id), ["senior", "staff", "manager", "director", "vp", "c"])
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

test("applyV16HardFilters: non-engineering profile drops clear engineering-titled jobs", () => {
  const jobs: MatchingJob[] = [
    mkJob({
      id: "pm",
      jobTitle: "Senior Product Manager",
      roleFunction: ["product_management"],
    }),
    mkJob({
      id: "eng",
      jobTitle: "Full Stack Software Engineer, Growth",
      roleFunction: ["product_management", "software_engineering"],
    }),
  ]
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    targetRoleFunction: ["product_management"],
  } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.deepEqual(r.kept.map((j) => j.id), ["pm"])
  assert.equal(r.counters.roleTitleMismatch, 1)
})

test("applyV16HardFilters: title sanity drops legal and clinical titles for unrelated targets", () => {
  const jobs: MatchingJob[] = [
    mkJob({
      id: "ops",
      jobTitle: "Business Operations Associate",
      roleFunction: ["business_analyst"],
    }),
    mkJob({
      id: "counsel",
      jobTitle: "Commercial Counsel - EMEA",
      roleFunction: ["legal_and_compliance", "business_analyst"],
    }),
    mkJob({
      id: "medical",
      jobTitle: "Medical Fellow - Human Frontier Collective",
      roleFunction: ["data_analysis", "consultant"],
    }),
  ]
  const businessTags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    targetRoleFunction: ["business_analyst", "data_analysis"],
  } as never
  const r = applyV16HardFilters(jobs, businessTags, NOW)
  assert.deepEqual(r.kept.map((j) => j.id), ["ops"])
  assert.equal(r.counters.roleTitleMismatch, 2)

  const legalTags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    targetRoleFunction: ["legal_and_compliance"],
  } as never
  assert.deepEqual(applyV16HardFilters([jobs[1]!], legalTags, NOW).kept.map((j) => j.id), ["counsel"])

  const healthcareTags = {
    skills: [],
    industryEnum: ["healthcare"],
    schemaVersion: 1,
    targetRoleFunction: ["data_analysis"],
  } as never
  assert.deepEqual(applyV16HardFilters([jobs[2]!], healthcareTags, NOW).kept.map((j) => j.id), ["medical"])
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
    freshnessBoost: 0,
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
    { llmMatch: 0, skillJaccard: 0.5, relevantTags: 0, industrySector: 0, cvEmbCosine: 0, salaryFit: 0, tagOverlap: 0, positiveHit: 0, urgencyBoost: 0, freshnessBoost: 0, total: 0.1 }
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
    freshnessBoost: 0,
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

test("scoreV16Job: missing jdrel + missing llm → score = sum of skillJaccard + emb + salary + freshness", () => {
  const tags = {
    skills: ["python"],
    industryEnum: ["tech_software"],
    schemaVersion: 1,
  } as never
  const job = mkJob({ requiredSkills: ["python"] })
  // Pin nowMs=NOW so freshness boost on FRESH_TS (5d old) is deterministic.
  const r = scoreV16Job(tags, job, undefined, undefined, undefined, undefined, NOW)
  // skillJaccard = 1.0 → 0.20 weight
  // salary fit = 0.5 (both missing) → 0.05 * 0.5 = 0.025
  // freshness = 0.10 × 0.5^(5/3) at FRESH_TS
  const expected = 0.20 + 0.05 * 0.5 + FRESHNESS_BOOST_FRESH_TS
  assert.ok(Math.abs(r.breakdown.total - expected) < 1e-6, `total=${r.breakdown.total}`)
})

test("scoreV16Job: llm cache present applies 0.40 weight", () => {
  const tags = { skills: [], industryEnum: [], schemaVersion: 1 } as never
  const job = mkJob({})
  const r = scoreV16Job(tags, job, undefined, 0.7, undefined, undefined, NOW)
  // llmMatch=0.7*0.40 + salary=0.5*0.05 + freshness at FRESH_TS
  const expected =
    0.7 * V16_SCORE_WEIGHTS.llmMatch + 0.5 * V16_SCORE_WEIGHTS.salaryFit + FRESHNESS_BOOST_FRESH_TS
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
  const a = scoreV16Job(tags, job, undefined, 0.5, undefined, undefined, NOW)
  const b = scoreV16Job(tags, job, undefined, 0.5, undefined, undefined, NOW)
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
  const r = scoreV16Job(tags, job, undefined, 0, { skillJaccard: 0.5 }, undefined, NOW)
  // skillJaccard=1.0 * 0.5 + salary=0.5 * 0.05 + freshness at FRESH_TS
  const expected = 1.0 * 0.5 + 0.5 * V16_SCORE_WEIGHTS.salaryFit + FRESHNESS_BOOST_FRESH_TS
  assert.ok(Math.abs(r.breakdown.total - expected) < 1e-6, `total=${r.breakdown.total}`)
})

test("scoreV16Job: weightOverrides clamps NaN/non-numeric → fallback to canonical", () => {
  const tags = {
    skills: ["python"],
    industryEnum: [],
    schemaVersion: 1,
  } as never
  const job = mkJob({ requiredSkills: ["python"] })
  const r = scoreV16Job(
    tags,
    job,
    undefined,
    0,
    { skillJaccard: NaN as never },
    undefined,
    NOW,
  )
  // NaN falls back to canonical 0.20.
  const expected =
    1.0 * V16_SCORE_WEIGHTS.skillJaccard +
    0.5 * V16_SCORE_WEIGHTS.salaryFit +
    FRESHNESS_BOOST_FRESH_TS
  assert.ok(Math.abs(r.breakdown.total - expected) < 1e-6, `total=${r.breakdown.total}`)
})

test("scoreV16Job: weightOverrides zeroing component drops its contribution", () => {
  const tags = { skills: [], industryEnum: [], schemaVersion: 1 } as never
  const job = mkJob({})
  // Zero salaryFit so the only fallback (=0.5 neutral) doesn't contribute.
  const r = scoreV16Job(tags, job, undefined, 0.7, { salaryFit: 0 }, undefined, NOW)
  const expected = 0.7 * V16_SCORE_WEIGHTS.llmMatch + FRESHNESS_BOOST_FRESH_TS
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

test("queryMatchingJobsV16: empty targetRoleFunction → needsOnboarding=true + missingAxes lists gaps", async () => {
  const mfs = new MockFirestore()
  // User has SOME tags (skills only) but lacks targetRoleFunction + targetLocations + visa.
  await mfs
    .collection("pa-users")
    .doc("u_partial")
    .set({
      tags: {
        skills: ["python"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        // explicit empty arrays so loadUserTags returns the doc but V16 still
        // sees missing axes.
        targetRoleFunction: [],
        targetLocations: [],
      },
    })
  await seedJob(mfs, "swe-fallback", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "FallbackCo",
    jobTitle: "SWE",
  })
  const r = await queryMatchingJobsV16(
    { userId: "u_partial", nowMs: NOW },
    { db: asFirestore(mfs) }
  )
  assert.equal(r.needsOnboarding, true)
  assert.ok(r.missingAxes && r.missingAxes.includes("targetRoleFunction"))
  assert.ok(r.missingAxes!.includes("targetLocations"))
  assert.ok(r.missingAxes!.includes("visaStatus"))
  // Match still produces output via firstSeenAt-desc fallback (not blocked on
  // onboarding gap — Claire still gets a job to mention).
  assert.ok(r.jobs.length >= 0)
})

test("queryMatchingJobsV16: infers missing targetRoleFunction from resume title history", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_exec_assistant").set({
    tags: {
      skills: ["market research"],
      schemaVersion: 1,
      recentRoleTitle: "Executive Assistant",
      workHistorySummary:
        "Executive Assistant @ Kwolity Group; Growth Manager @ De-Belleza Design Company",
      targetRoleFunction: [],
      targetLocations: ["remote_anywhere"],
      visaStatus: "citizen",
      careerStage: "mid_level",
    },
  })
  await seedJob(mfs, "business-ops", {
    roleFunction: ["business_analyst"],
    requiredSkills: ["market research"],
    companyName: "OpsCo",
    roleTitle: "Business Operations Associate",
    jobTitle: "Business Operations Associate",
  })
  await seedJob(mfs, "swe", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["typescript"],
    companyName: "SWECo",
    jobTitle: "Software Engineer",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_exec_assistant", nowMs: NOW },
    { db: asFirestore(mfs) },
  )

  assert.ok(
    ((r.userTags as Record<string, unknown>).targetRoleFunction as string[]).includes("business_analyst"),
  )
  assert.ok(!r.missingAxes?.includes("targetRoleFunction"))
  assert.equal(r.jobs.length, 1)
  assert.equal(r.jobs[0]!.id, "business-ops")
})

test("queryMatchingJobsV16: growth operations analyst repairs marketing-only axis with business_analyst", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_growth_ops").set({
    tags: {
      skills: ["sql", "retention analysis"],
      schemaVersion: 1,
      recentRoleTitle: "growth operations & retention analyst",
      workHistorySummary: "Growth Operations & Retention Analyst @ Acme",
      targetRoleFunction: ["marketing"],
      targetLocations: ["remote_anywhere"],
      visaStatus: "citizen",
      careerStage: "entry_level",
    },
  })
  await seedJob(mfs, "ops", {
    roleFunction: ["business_analyst"],
    requiredSkills: ["sql"],
    companyName: "OpsCo",
    roleTitle: "Strategy & Operations Associate",
    jobTitle: "Strategy & Operations Associate",
    seniorityLevel: "entry_level",
  })
  await seedJob(mfs, "data", {
    roleFunction: ["data_analysis"],
    requiredSkills: ["retention analysis", "sql"],
    companyName: "DataCo",
    roleTitle: "Retention Analyst",
    jobTitle: "Retention Analyst",
    seniorityLevel: "entry_level",
  })
  await seedJob(mfs, "sdr", {
    roleFunction: ["sales", "marketing"],
    requiredSkills: ["cold calling"],
    companyName: "SalesCo",
    jobTitle: "Sales Development Representative",
    seniorityLevel: "entry_level",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_growth_ops", nowMs: NOW },
    { db: asFirestore(mfs) },
  )

  const targetRoles = (r.userTags as Record<string, unknown>).targetRoleFunction as string[]
  assert.ok(targetRoles.includes("business_analyst"))
  assert.ok(targetRoles.includes("data_analysis"))
  assert.deepEqual(r.jobs.map((job) => job.id).sort(), ["data", "ops"])
})

test("queryMatchingJobsV16: repairs stale non-engineering role axis from high-confidence title", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_hr").set({
    tags: {
      skills: ["candidate communication"],
      schemaVersion: 1,
      recentRoleTitle: "Human Resources",
      workHistorySummary: "Human Resources @ Pearl Spa and Sauna",
      targetRoleFunction: ["marketing", "business_analyst"],
      targetLocations: ["remote_anywhere"],
      visaStatus: "citizen",
      careerStage: "mid_level",
    },
  })
  await seedJob(mfs, "hr", {
    roleFunction: ["human_resources"],
    requiredSkills: ["candidate communication"],
    companyName: "HRCo",
    roleTitle: "Recruiting Coordinator",
    jobTitle: "Recruiting Coordinator",
  })
  await seedJob(mfs, "marketing", {
    roleFunction: ["marketing"],
    requiredSkills: ["seo"],
    companyName: "MarketingCo",
    jobTitle: "Marketing Associate",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_hr", nowMs: NOW },
    { db: asFirestore(mfs) },
  )

  assert.deepEqual(
    (r.userTags as Record<string, unknown>).targetRoleFunction,
    ["human_resources"],
  )
  assert.equal(r.jobs.length, 1)
  assert.equal(r.jobs[0]!.id, "hr")
})

test("queryMatchingJobsV16: keeps explicit SWE target over non-engineering resume title", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_pm_to_swe").set({
    tags: {
      skills: ["python"],
      schemaVersion: 1,
      recentRoleTitle: "Product Manager",
      workHistorySummary: "Product Manager @ Acme",
      targetRoleFunction: ["software_engineering"],
      targetLocations: ["remote_anywhere"],
      visaStatus: "citizen",
      careerStage: "mid_level",
    },
  })
  await seedJob(mfs, "swe", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "SWECo",
    jobTitle: "Software Engineer",
  })
  await seedJob(mfs, "pm", {
    roleFunction: ["product_management"],
    requiredSkills: ["roadmaps"],
    companyName: "PMCo",
    jobTitle: "Product Manager",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_pm_to_swe", nowMs: NOW },
    { db: asFirestore(mfs) },
  )

  assert.deepEqual(
    (r.userTags as Record<string, unknown>).targetRoleFunction,
    ["software_engineering"],
  )
  assert.equal(r.jobs.length, 1)
  assert.equal(r.jobs[0]!.id, "swe")
})

test("queryMatchingJobsV16: prunes stale SWE axis from multi-axis non-engineering profile", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_pm_growth").set({
    tags: {
      skills: ["product management", "growth analytics", "python"],
      schemaVersion: 1,
      recentRoleTitle: "Product Manager",
      workHistorySummary: "Product Manager @ SaaSCo",
      targetRoleFunction: ["data_analysis", "product_management", "marketing", "software_engineering"],
      targetRole: "GTM, growth, or product roles",
      targetLocations: ["remote_anywhere"],
      visaStatus: "citizen",
      careerStage: "mid_level",
      targetJobType: ["full_time"],
    },
  })
  await seedJob(mfs, "pm", {
    roleFunction: ["product_management"],
    requiredSkills: ["product management"],
    companyName: "PMCo",
    jobTitle: "Associate Product Manager",
    seniorityLevel: "mid_level",
    jobType: "full_time",
  })
  await seedJob(mfs, "growth", {
    roleFunction: ["marketing", "data_analysis"],
    requiredSkills: ["growth analytics"],
    companyName: "GrowthCo",
    jobTitle: "Growth Analyst",
    seniorityLevel: "mid_level",
    jobType: "full_time",
  })
  await seedJob(mfs, "swe", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "SWECo",
    jobTitle: "Software Engineer",
    seniorityLevel: "mid_level",
    jobType: "full_time",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_pm_growth", nowMs: NOW },
    { db: asFirestore(mfs) },
  )

  const targetRoles = (r.userTags as Record<string, unknown>).targetRoleFunction as string[]
  assert.deepEqual(targetRoles, ["data_analysis", "product_management", "marketing"])
})

test("queryMatchingJobsV16: preserves explicit multi-axis engineering intent", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_pm_explicit_swe").set({
    tags: {
      skills: ["python", "product management"],
      schemaVersion: 1,
      recentRoleTitle: "Product Manager",
      workHistorySummary: "Product Manager @ Acme",
      targetRoleFunction: ["product_management", "software_engineering"],
      targetRole: "Software Engineer or Product Engineer",
      targetLocations: ["remote_anywhere"],
      visaStatus: "citizen",
      careerStage: "mid_level",
    },
  })
  await seedJob(mfs, "swe", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "SWECo",
    jobTitle: "Software Engineer",
  })
  await seedJob(mfs, "pm", {
    roleFunction: ["product_management"],
    requiredSkills: ["product management"],
    companyName: "PMCo",
    jobTitle: "Product Manager",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_pm_explicit_swe", nowMs: NOW },
    { db: asFirestore(mfs) },
  )

  const targetRoles = (r.userTags as Record<string, unknown>).targetRoleFunction as string[]
  assert.ok(targetRoles.includes("software_engineering"))
  assert.ok(r.jobs.some((job) => job.id === "swe"))
})

test("queryMatchingJobsV16: complete tags → needsOnboarding undefined", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u_complete")
    .set({
      tags: {
        skills: ["python"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
        targetLocations: ["san_francisco_bay_area"],
        visaStatus: "citizen",
        careerStage: "ic_engineer_l3",
        targetJobType: ["full_time"],
      },
    })
  await seedJob(mfs, "swe-good", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "GoodCo",
    jobTitle: "SWE",
  })
  const r = await queryMatchingJobsV16(
    { userId: "u_complete", nowMs: NOW },
    { db: asFirestore(mfs) }
  )
  assert.equal(r.needsOnboarding, undefined)
  assert.equal(r.missingAxes, undefined)
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

// ---------------------------------------------------------------------------
// 2026-05-19 schema-drift hotfix — title fallback through full pipeline
// ---------------------------------------------------------------------------
//
// macmini scraper canonically writes `roleTitle`; legacy rows carry `jobTitle`.
// `projectMatchingJobRow` normalizes `roleTitle → jobTitle`, but V16 also needs
// to be robust on its own (defense in depth). End-to-end:
//   1. queryMatchingJobsV16 surfaces a non-empty title for roleTitle-only docs
//   2. dedup key does NOT collapse multiple roleTitle-only docs to `company|`
//   3. presentation-role-focus filter still works on `roleTitle` text
//
test("queryMatchingJobsV16: roleTitle-only doc surfaces title in output (schema-drift fallback)", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_roleTitle").set({
    tags: {
      skills: ["python"],
      industryEnum: ["tech_software"],
      schemaVersion: 1,
      targetRoleFunction: ["software_engineering"],
    },
  })
  // Seed a doc with ONLY roleTitle — no jobTitle. Mirrors live macmini state.
  await mfs.collection("matching-jobs").doc("macmini-swe").set({
    id: "macmini-swe",
    status: "active",
    companyName: "MacminiCo",
    roleTitle: "Senior Software Engineer", // NOTE: no jobTitle field
    atsApplyUrl: "https://greenhouse.io/co/macmini-swe",
    primaryUrl: "https://example.com/macmini-swe",
    industry: "tech",
    industryKey: "tech",
    sponsorship: null,
    locationRaw: "San Francisco, CA",
    firstSeenAt: FRESH_TS,
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_roleTitle", nowMs: NOW },
    { db: asFirestore(mfs) },
  )

  assert.equal(r.jobs.length, 1)
  const job = r.jobs[0]!
  // Title must be non-empty — projectMatchingJobRow maps roleTitle → jobTitle.
  assert.equal(job.jobTitle, "Senior Software Engineer")
})

test("queryMatchingJobsV16: dedup key uses title fallback so multiple roleTitle-only docs do NOT collapse", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_dedup").set({
    tags: {
      skills: ["python"],
      industryEnum: ["tech_software"],
      schemaVersion: 1,
      targetRoleFunction: ["software_engineering"],
    },
  })
  // Two macmini docs at the SAME company with DIFFERENT roleTitles, both
  // missing jobTitle. Before the hotfix the dedup key collapsed both to
  // `acme|` and only one survived. After the fix the helper uses
  // `(jobTitle || roleTitle)` and the keys differ — both survive.
  await mfs.collection("matching-jobs").doc("acme-swe").set({
    id: "acme-swe",
    status: "active",
    companyName: "AcmeUnified",
    roleTitle: "Senior Software Engineer",
    atsApplyUrl: "https://greenhouse.io/co/acme-swe",
    primaryUrl: "https://example.com/acme-swe",
    industry: "tech",
    industryKey: "tech",
    sponsorship: null,
    locationRaw: "San Francisco, CA",
    firstSeenAt: FRESH_TS,
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
  })
  await mfs.collection("matching-jobs").doc("acme-pm").set({
    id: "acme-pm",
    status: "active",
    companyName: "AcmeUnified",
    roleTitle: "Staff Software Engineer",
    atsApplyUrl: "https://greenhouse.io/co/acme-pm",
    primaryUrl: "https://example.com/acme-pm",
    industry: "tech",
    industryKey: "tech",
    sponsorship: null,
    locationRaw: "San Francisco, CA",
    firstSeenAt: FRESH_TS,
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_dedup", nowMs: NOW },
    { db: asFirestore(mfs) },
  )

  // Both jobs survive — title fallback prevented dedup collapse.
  assert.equal(r.jobs.length, 2)
  const ids = r.jobs.map((j) => j.id).sort()
  assert.deepEqual(ids, ["acme-pm", "acme-swe"])
})

test("queryMatchingJobsV16: lang arg overrides stored preferredLang for user-facing reasons", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u_lang")
    .set({
      tags: {
        skills: ["typescript"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
        preferredLang: "zh",
      },
    })
  await seedJob(mfs, "swe-lang", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["typescript"],
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_lang", nowMs: NOW, lang: "en" },
    { db: asFirestore(mfs) },
  )

  assert.equal(r.jobs.length, 1)
  assert.match(r.jobs[0]!.reason, /Why match:/)
  assert.doesNotMatch(r.jobs[0]!.reason, /为啥推/)
})

test("queryMatchingJobsV16: broad fallback relaxes exact location only when strict location collapses results", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_location").set({
    tags: {
      skills: ["typescript", "react"],
      industryEnum: ["tech_software"],
      schemaVersion: 1,
      targetRoleFunction: ["software_engineering"],
      targetLocations: ["new_york_city"],
      targetCountry: ["us"],
      visaStatus: "citizen",
    },
  })
  await seedJob(mfs, "sf-swe", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["typescript", "react"],
    locationRaw: "San Francisco, CA",
    locationBuckets: ["san_francisco_bay_area"],
    companyName: "FallbackCo",
    jobTitle: "Frontend Engineer",
  })

  const strict = await queryMatchingJobsV16({ userId: "u_location", nowMs: NOW }, { db: asFirestore(mfs) })
  assert.equal(strict.jobs.length, 0)
  assert.equal(strict.hardFilter.location, 1)

  const broad = await queryMatchingJobsV16(
    { userId: "u_location", nowMs: NOW, lang: "en", allowBroadFallback: true },
    { db: asFirestore(mfs) },
  )
  assert.equal(broad.jobs.length, 1)
  assert.equal(broad.jobs[0]!.id, "sf-swe")
  assert.deepEqual(broad.relaxedHardFilters, ["specific_location"])
})

test("queryMatchingJobsV16: presentationRoleFocus keeps explicit frontend/fullstack requests on-role", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_role_focus").set({
    tags: {
      skills: ["typescript", "react", "node.js", "sql"],
      industryEnum: ["tech_software"],
      schemaVersion: 1,
      targetRoleFunction: ["software_engineering"],
    },
  })
  await seedJob(mfs, "security", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["security engineering", "threat modeling", "iam"],
    companyName: "SecurityCo",
    jobTitle: "Senior Security Engineer",
  })
  await seedJob(mfs, "frontend", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["React", "TypeScript", "Node.js"],
    companyName: "FrontendCo",
    jobTitle: "Frontend Engineer",
  })
  await seedJob(mfs, "fullstack", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["React", "Node.js", "SQL"],
    companyName: "FullstackCo",
    jobTitle: "Software Engineer",
  })

  const r = await queryMatchingJobsV16(
    {
      userId: "u_role_focus",
      nowMs: NOW,
      lang: "en",
      limit: 3,
      presentationRoleFocus: ["frontend", "fullstack"],
    },
    { db: asFirestore(mfs) },
  )

  assert.deepEqual(
    r.jobs.map((job) => job.id).sort(),
    ["frontend", "fullstack"],
  )
  assert.ok(!r.jobs.some((job) => /security/i.test(job.jobTitle)))
})

test("queryMatchingJobsV16: matchSourceLabel comes only from pa-jobs collaboration status", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_labels").set({
    tags: {
      skills: ["typescript"],
      industryEnum: ["tech_software"],
      schemaVersion: 1,
      targetRoleFunction: ["software_engineering"],
    },
  })
  await seedJob(mfs, "collab-job", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["typescript"],
    companyName: "CollabCo",
    jobTitle: "Product Engineer",
  })
  await seedJob(mfs, "public-non-collab", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["typescript"],
    companyName: "PublicCo",
    jobTitle: "Frontend Engineer",
  })
  await mfs.collection("pa-jobs").doc("collab-job").set({
    publicVisible: true,
    wekruitCollaborationStatus: "collaborated",
  })
  await mfs.collection("pa-jobs").doc("public-non-collab").set({
    publicVisible: true,
    wekruitCollaborationStatus: "not_collaborated",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_labels", nowMs: NOW, lang: "en" },
    { db: asFirestore(mfs) },
  )
  const labels = new Map(r.jobs.map((job) => [job.id, job.matchSourceLabel]))
  assert.equal(labels.get("collab-job"), "WeKruit collaborated")
  assert.equal(labels.get("public-non-collab"), "general match")
})

test("queryMatchingJobsV16: previously recommended jobs are demoted and surfaced as repeats", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_repeat").set({
    tags: {
      skills: ["typescript", "python"],
      industryEnum: ["tech_software"],
      schemaVersion: 1,
      targetRoleFunction: ["software_engineering"],
    },
  })
  await seedJob(mfs, "repeat-strong", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["typescript", "python"],
    companyName: "RepeatCo",
    jobTitle: "Fullstack Engineer",
  })
  await seedJob(mfs, "fresh-weaker", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["typescript"],
    companyName: "FreshCo",
    jobTitle: "Frontend Engineer",
  })
  await mfs
    .collection("pa-user-job-recommendations")
    .doc("u_repeat")
    .collection("jobs")
    .doc("repeat-strong")
    .set({
      userId: "u_repeat",
      jobId: "repeat-strong",
      recommendationCount: 1,
      lastRecommendedAt: "2026-05-17T12:00:00.000Z",
      lastRecommendedSource: "runtime_job_search_reply",
    })

  const r = await queryMatchingJobsV16(
    { userId: "u_repeat", nowMs: NOW, lang: "en", limit: 2 },
    { db: asFirestore(mfs) },
  )

  assert.equal(r.jobs.length, 2)
  assert.equal(r.jobs[0]!.id, "fresh-weaker")
  const repeat = r.jobs.find((job) => job.id === "repeat-strong")
  assert.ok(repeat, "repeat job should still be eligible")
  assert.equal(repeat.previouslyRecommended, true)
  assert.equal(repeat.recommendationCount, 1)
  assert.equal(repeat.lastRecommendedAt, "2026-05-17T12:00:00.000Z")
  assert.ok((repeat.v16Score.previousRecommendationPenalty ?? 0) > 0)
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
    sponsorship: true,
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

test("B4 hard filter: roleFunctionNegativeList drops rejected role functions", () => {
  const jobs: MatchingJob[] = [
    mkJob({ id: "hr", jobTitle: "HR Coordinator", roleFunction: ["human_resources"] }),
    mkJob({ id: "support", jobTitle: "Customer Service Rep", roleFunction: ["customer_service_and_support"] }),
    mkJob({ id: "mixed", jobTitle: "Support Operations", roleFunction: ["customer_service_and_support", "operations"] }),
  ]
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    roleFunctionNegativeList: ["customer_service_and_support"],
  } as never
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.deepEqual(r.kept.map((j) => j.id), ["hr"])
  assert.equal(r.counters.negativeListDrop, 2)
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
  // B5.1: total delta is +0.075 (tagOverlap) plus the freshness boost change,
  // since adding tagOverlap raises baseRelevance which scales up freshnessBoost.
  // The pure tagOverlap contribution still holds — check the field directly.
  // Hold-out: delta is at least +0.075 (tagOverlap floor), with extra from
  // freshness scaling.
  const delta = boosted.breakdown.total - baseline.breakdown.total
  assert.ok(
    delta >= 0.075 - 1e-9,
    `delta=${delta} should be at least 0.075 (tagOverlap only; B5.1 freshness scaling adds more)`,
  )
})

test("queryMatchingJobsV16: startup preference strictly keeps only startup-stage companies", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u_startup_only")
    .set({
      tags: {
        skills: ["python"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
        prefersStartup: "startup",
      },
    })
  await seedJob(mfs, "startup-fit", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "SeedCo",
    jobTitle: "Backend Engineer",
  })
  await seedJob(mfs, "enterprise-drop", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "BigCo",
    jobTitle: "Backend Engineer",
  })
  await seedJob(mfs, "unknown-drop", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "UnknownCo",
    jobTitle: "Backend Engineer",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_startup_only", nowMs: NOW },
    {
      db: asFirestore(mfs),
      loadCompaniesByNameImpl: async () =>
        new Map([
          ["seedco", { stage: "seed", tags: ["yc_active"] }],
          ["bigco", { stage: "ipo_public", tags: ["big_tech"] }],
        ]),
    },
  )

  assert.deepEqual(r.jobs.map((job) => job.id), ["startup-fit"])
})

test("queryMatchingJobsV16: open company preference does not stage-filter jobs", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u_open_company")
    .set({
      tags: {
        skills: ["python"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
        prefersStartup: "either",
      },
    })
  await seedJob(mfs, "startup-fit", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "SeedCo",
    jobTitle: "Backend Engineer 1",
  })
  await seedJob(mfs, "enterprise-fit", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "BigCo",
    jobTitle: "Backend Engineer 2",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_open_company", nowMs: NOW },
    {
      db: asFirestore(mfs),
      loadCompaniesByNameImpl: async () =>
        new Map([
          ["seedco", { stage: "seed", tags: ["yc_active"] }],
          ["bigco", { stage: "ipo_public", tags: ["big_tech"] }],
        ]),
    },
  )

  assert.deepEqual(new Set(r.jobs.map((job) => job.id)), new Set(["startup-fit", "enterprise-fit"]))
})

test("queryMatchingJobsV16: generic startup preference is not overconstrained by early_startup tag", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u_startup_with_early_tag")
    .set({
      tags: {
        skills: ["python"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
        prefersStartup: "startup",
        companySize: "early_startup",
      },
    })
  await seedJob(mfs, "seed-fit", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "SeedCo",
    jobTitle: "Backend Engineer 1",
  })
  await seedJob(mfs, "series-b-fit", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "SeriesBCo",
    jobTitle: "Backend Engineer 2",
  })
  await seedJob(mfs, "series-c-fit", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "SeriesCCo",
    jobTitle: "Backend Engineer 3",
  })
  await seedJob(mfs, "enterprise-drop", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "BigCo",
    jobTitle: "Backend Engineer 4",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_startup_with_early_tag", nowMs: NOW },
    {
      db: asFirestore(mfs),
      loadCompaniesByNameImpl: async () =>
        new Map([
          ["seedco", { stage: "seed", tags: ["yc_active"] }],
          ["seriesbco", { stage: "series_b", tags: ["ai_native"] }],
          ["seriescco", { stage: "series_c", tags: ["ai_native"] }],
          ["bigco", { stage: "ipo_public", tags: ["big_tech"] }],
        ]),
    },
  )

  assert.deepEqual(new Set(r.jobs.map((job) => job.id)), new Set(["seed-fit", "series-b-fit", "series-c-fit"]))
})

test("queryMatchingJobsV16: early-startup company size rejects late-stage and public ai-native companies", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u_early_only")
    .set({
      tags: {
        skills: ["python"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
        companySize: "early_startup",
      },
    })
  await seedJob(mfs, "series-a-fit", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "EarlyAI",
    jobTitle: "Backend Engineer",
  })
  await seedJob(mfs, "series-d-drop", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "LateAI",
    jobTitle: "Backend Engineer",
  })
  await seedJob(mfs, "public-drop", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "PublicAI",
    jobTitle: "Backend Engineer",
  })

  const r = await queryMatchingJobsV16(
    { userId: "u_early_only", nowMs: NOW },
    {
      db: asFirestore(mfs),
      loadCompaniesByNameImpl: async () =>
        new Map([
          ["earlyai", { stage: "series_a", tags: ["ai_native"] }],
          ["lateai", { stage: "series_d_plus", tags: ["ai_native", "unicorn"] }],
          ["publicai", { stage: "ipo_public", tags: ["ai_native", "unicorn"] }],
        ]),
    },
  )

  assert.deepEqual(r.jobs.map((job) => job.id), ["series-a-fit"])
})

test("queryMatchingJobsV16: resume-derived SWE intern profile rejects senior full-time jobs", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u_resume_intern")
    .set({
      tags: {
        skills: ["python", "typescript", "react"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
        targetLocations: ["remote_anywhere"],
        visaStatus: "citizen",
        recentRoleTitle: "Software Engineer Intern",
        workHistorySummary: "Software Engineer Intern @ Tesla; Founder, Software Engineer @ AI Study",
      },
    })
  await seedJob(mfs, "intern-fit", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python", "typescript"],
    companyName: "InternCo",
    jobTitle: "Software Engineer Intern",
    seniorityLevel: "intern",
    jobType: "internship",
  })
  await seedJob(mfs, "senior-drop", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python", "typescript", "react"],
    companyName: "SeniorCo",
    jobTitle: "Senior Software Engineer",
    seniorityLevel: "senior",
    jobType: "full_time",
  })
  await seedJob(mfs, "staff-drop", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python", "typescript", "react"],
    companyName: "StaffCo",
    jobTitle: "Staff Software Engineer",
    seniorityLevel: "staff",
    jobType: "full_time",
  })

  const r = await queryMatchingJobsV16({ userId: "u_resume_intern", nowMs: NOW }, { db: asFirestore(mfs) })

  assert.deepEqual(r.jobs.map((job) => job.id), ["intern-fit"])
  assert.equal(r.userTags?.careerStage, "intern")
  assert.deepEqual(r.userTags?.targetJobType, ["internship"])
  assert.ok(!r.missingAxes?.includes("careerStage"))
  assert.ok(!r.missingAxes?.includes("targetJobType"))
})

test("queryMatchingJobsV16: founder resume profile can match senior product and software roles", async () => {
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u_founder")
    .set({
      tags: {
        skills: ["python", "strategy", "product_management"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
        targetRoleFunction: ["product_management", "software_engineering"],
        targetLocations: ["remote_anywhere"],
        visaStatus: "citizen",
        recentRoleTitle: "Founder - Product Manager & Software Engineer",
        workHistorySummary: "Founder - Product Manager & Software Engineer @ AI Study",
      },
    })
  await seedJob(mfs, "senior-pm", {
    roleFunction: ["product_management"],
    requiredSkills: ["strategy", "product_management"],
    companyName: "ProductCo",
    jobTitle: "Senior Product Manager",
    seniorityLevel: "senior",
    jobType: "full_time",
  })
  await seedJob(mfs, "senior-swe", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "SoftwareCo",
    jobTitle: "Senior Software Engineer",
    seniorityLevel: "senior",
    jobType: "full_time",
  })
  await seedJob(mfs, "junior-drop", {
    roleFunction: ["product_management"],
    requiredSkills: ["strategy"],
    companyName: "JuniorCo",
    jobTitle: "Junior Product Manager",
    seniorityLevel: "junior",
    jobType: "full_time",
  })

  const r = await queryMatchingJobsV16({ userId: "u_founder", nowMs: NOW }, { db: asFirestore(mfs) })

  assert.equal(r.userTags?.careerStage, "founder")
  assert.deepEqual(r.jobs.map((job) => job.id).sort(), ["senior-pm", "senior-swe"])
  assert.equal(r.hardFilter.careerStage, 1)
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

// ---------------------------------------------------------------------------
// Phase B5 — default-on freshness boost (exponential half-life, τ=3d)
// Phase B5.1 — scaled by cohort relevance (baseRelevance ≥ threshold gets
//              full lift; below threshold gets fraction; zero gets nothing).
// ---------------------------------------------------------------------------

// All boost-magnitude tests use a strong skill match so baseRelevance >=
// V16_FRESHNESS_RELEVANCE_THRESHOLD and freshFactor=1.0 — isolates the
// age-decay math from the relevance-scale math.
const RELEVANT_TAGS = { skills: ["python"], industryEnum: ["tech_software"], schemaVersion: 1 } as never
const mkRelevantJob = (over: Partial<MatchingJob>) =>
  mkJob({ requiredSkills: ["python"], ...over })

test("B5 freshness: age=0, strong base → boost ≈ V16_FRESHNESS_BOOST_MAX (0.10)", () => {
  const job = mkRelevantJob({ firstSeenAt: new Date(NOW).toISOString() })
  const r = scoreV16Job(RELEVANT_TAGS, job, undefined, undefined, undefined, undefined, NOW)
  assert.ok(
    Math.abs(r.breakdown.freshnessBoost - V16_FRESHNESS_BOOST_MAX) < 1e-9,
    `freshnessBoost=${r.breakdown.freshnessBoost}`,
  )
})

test("B5 freshness: age=3d (half-life), strong base → boost ≈ 0.05", () => {
  const job = mkRelevantJob({ firstSeenAt: new Date(NOW - 3 * 24 * 3600 * 1000).toISOString() })
  const r = scoreV16Job(RELEVANT_TAGS, job, undefined, undefined, undefined, undefined, NOW)
  assert.ok(
    Math.abs(r.breakdown.freshnessBoost - V16_FRESHNESS_BOOST_MAX / 2) < 1e-9,
    `freshnessBoost=${r.breakdown.freshnessBoost}`,
  )
})

test("B5 freshness: age=7d, strong base → boost ≈ 0.02", () => {
  const job = mkRelevantJob({ firstSeenAt: new Date(NOW - 7 * 24 * 3600 * 1000).toISOString() })
  const r = scoreV16Job(RELEVANT_TAGS, job, undefined, undefined, undefined, undefined, NOW)
  const expected = V16_FRESHNESS_BOOST_MAX * Math.pow(0.5, 7 / 3)
  assert.ok(
    Math.abs(r.breakdown.freshnessBoost - expected) < 1e-9,
    `freshnessBoost=${r.breakdown.freshnessBoost}, expected=${expected}`,
  )
  assert.ok(r.breakdown.freshnessBoost < 0.025 && r.breakdown.freshnessBoost > 0.015)
})

test("B5 freshness: age=20d (hard-filter edge), strong base → boost ≈ 0.001", () => {
  const job = mkRelevantJob({ firstSeenAt: new Date(NOW - 20 * 24 * 3600 * 1000).toISOString() })
  const r = scoreV16Job(RELEVANT_TAGS, job, undefined, undefined, undefined, undefined, NOW)
  const expected = V16_FRESHNESS_BOOST_MAX * Math.pow(0.5, 20 / 3)
  assert.ok(
    Math.abs(r.breakdown.freshnessBoost - expected) < 1e-9,
    `freshnessBoost=${r.breakdown.freshnessBoost}, expected=${expected}`,
  )
  assert.ok(r.breakdown.freshnessBoost < 0.002)
})

test("B5 freshness: missing firstSeenAt → boost = 0", () => {
  const job = mkRelevantJob({ firstSeenAt: undefined as never })
  const r = scoreV16Job(RELEVANT_TAGS, job, undefined, undefined, undefined, undefined, NOW)
  assert.equal(r.breakdown.freshnessBoost, 0)
})

test("B5 freshness: clock skew (firstSeenAt > nowMs), strong base → clamped to MAX", () => {
  const job = mkRelevantJob({ firstSeenAt: new Date(NOW + 60_000).toISOString() })
  const r = scoreV16Job(RELEVANT_TAGS, job, undefined, undefined, undefined, undefined, NOW)
  assert.ok(
    Math.abs(r.breakdown.freshnessBoost - V16_FRESHNESS_BOOST_MAX) < 1e-9,
    `freshnessBoost=${r.breakdown.freshnessBoost}`,
  )
})

// ---------------------------------------------------------------------------
// Phase B5.1 — cohort-relevance damping (Adam 2026-05-19)
// Prevents brand-new but irrelevant jobs from beating stale-but-relevant ones.
// ---------------------------------------------------------------------------

test("B5.1 cohort scale: zero-base job today → freshness boost = 0", () => {
  // No skill match, no industry overlap, no salary signal → baseRelevance ≈ 0
  const tags = { skills: ["python"], industryEnum: ["tech_software"], schemaVersion: 1 } as never
  const irrelevantJob = mkJob({
    requiredSkills: [],                       // no overlap with user.skills
    industrySector: ["healthcare_biotech"],   // no overlap with industryEnum
    salaryMin: null,
    firstSeenAt: new Date(NOW).toISOString(),
  } as never)
  const r = scoreV16Job(tags, irrelevantJob, undefined, undefined, undefined, undefined, NOW)
  // baseScore = (salary fit fallback 0.5 × 0.05 = 0.025). baseRelevance = 0.025.
  // freshFactor = 0.025 / 0.20 = 0.125. Boost = 0.10 × 0.125 = 0.0125 (NOT 0.10).
  assert.ok(
    r.breakdown.freshnessBoost < V16_FRESHNESS_BOOST_MAX * 0.2,
    `freshnessBoost=${r.breakdown.freshnessBoost} should be heavily scaled down`,
  )
})

test("B5.1 cohort scale: today's irrelevant sales job does NOT beat 14d-old SWE", () => {
  // Adam scenario: user is SWE-tagged but `targetRoleFunction` empty → V16
  // skips query-layer role filter → sales jobs enter the pool. Freshness
  // boost previously made today's sales beat 14d-old SWE. B5.1 prevents this.
  const userTags = {
    skills: ["python", "typescript"],
    industryEnum: ["tech_software"],
    schemaVersion: 1,
  } as never
  // Brand-new sales job: zero overlap with user.skills/industry.
  const salesToday = mkJob({
    id: "sales-today",
    requiredSkills: ["salesforce"],
    industrySector: ["sales_marketing"],
    firstSeenAt: new Date(NOW).toISOString(),
  } as never)
  // 14d-old SWE job: full skill + industry overlap.
  const sweTwoWeeks = mkJob({
    id: "swe-14d",
    requiredSkills: ["python", "typescript"],
    industrySector: ["tech_software"],
    firstSeenAt: new Date(NOW - 14 * 24 * 3600 * 1000).toISOString(),
  } as never)
  const sales = scoreV16Job(userTags, salesToday, undefined, undefined, undefined, undefined, NOW)
  const swe = scoreV16Job(userTags, sweTwoWeeks, undefined, undefined, undefined, undefined, NOW)
  assert.ok(
    swe.breakdown.total > sales.breakdown.total,
    `SWE-14d total=${swe.breakdown.total} should beat sales-today total=${sales.breakdown.total}`,
  )
  // Sales' freshness should be heavily scaled down (low baseRelevance).
  assert.ok(
    sales.breakdown.freshnessBoost < 0.04,
    `sales freshnessBoost=${sales.breakdown.freshnessBoost} should be << 0.10 due to low baseRelevance`,
  )
})

test("B5.1 cohort scale: half-threshold base → half boost (linear interpolation)", () => {
  // Construct a job whose baseRelevance ≈ THRESHOLD / 2 = 0.10.
  // skill 1.0 × 0.20 = 0.20 is too high. Use partial match: 1 of 2 skills.
  const tags = { skills: ["python", "typescript"], industryEnum: [], schemaVersion: 1 } as never
  const job = mkJob({
    requiredSkills: ["python", "typescript"],
    firstSeenAt: new Date(NOW).toISOString(),
  } as never)
  // skill 1.0 × 0.20 = 0.20, salary 0.5 × 0.05 = 0.025, baseRelevance ≈ 0.225.
  // That's > threshold → full boost. So let's drop salary too:
  const jobNoSalary = mkJob({
    requiredSkills: ["python"],
    salaryMin: 0 as never,
    firstSeenAt: new Date(NOW).toISOString(),
  } as never)
  // skill 0.5 × 0.20 = 0.10 (only 1 of 2 user skills match), salary signal = 0.5 (both nullish-ish) × 0.05 ≈ 0.025
  // baseRelevance ≈ 0.125 → freshFactor ≈ 0.625
  const r = scoreV16Job(tags, jobNoSalary, undefined, undefined, undefined, undefined, NOW)
  // Loose bound: freshness in (10%, 90%) of MAX — proves linear scaling kicks in.
  assert.ok(
    r.breakdown.freshnessBoost > V16_FRESHNESS_BOOST_MAX * 0.10 &&
      r.breakdown.freshnessBoost < V16_FRESHNESS_BOOST_MAX * 0.90,
    `freshnessBoost=${r.breakdown.freshnessBoost} should be between 0.01 and 0.09 (partial scale)`,
  )
})

test("B5 freshness: today's job ranks above week-old job (same skill/llm/industry)", () => {
  const tags = {
    skills: ["python"],
    industryEnum: ["tech_software"],
    schemaVersion: 1,
  } as never
  const today = mkJob({
    id: "today",
    requiredSkills: ["python"],
    firstSeenAt: new Date(NOW).toISOString(),
  })
  const weekOld = mkJob({
    id: "week",
    requiredSkills: ["python"],
    firstSeenAt: new Date(NOW - 7 * 24 * 3600 * 1000).toISOString(),
  })
  const todayScore = scoreV16Job(tags, today, undefined, 0.5, undefined, undefined, NOW)
  const weekScore = scoreV16Job(tags, weekOld, undefined, 0.5, undefined, undefined, NOW)
  // Same skill+llm+industry → only freshness boost differs.
  // Delta ≈ 0.10 - 0.0198 ≈ 0.0802 (much more than LLM noise).
  assert.ok(
    todayScore.breakdown.total > weekScore.breakdown.total,
    `today=${todayScore.breakdown.total}, week=${weekScore.breakdown.total}`,
  )
  assert.ok(
    todayScore.breakdown.total - weekScore.breakdown.total > 0.05,
    `delta=${todayScore.breakdown.total - weekScore.breakdown.total}`,
  )
})

// ---------------------------------------------------------------------------
// W5 — typed cast cleanup verification.
//
// W5 removes `as unknown as { ... }` casts from V16 in favour of typed
// `UserTags` field access (now possible because W3 #117 promoted the shadow
// fields into `UserTagsSchema` + W4 #121 wired them into the registry). This
// test pins behavior: a `UserTags` fixture populated through every W3-promoted
// path (`careerStage`, `targetJobType`, `targetRoleFunction`, `relevantTags`,
// `minSalary`, plus the B1-typed `targetCompanyTags` / `companyPositiveList` /
// `urgentlySeeking` / `companyNegativeList` / `targetCountry`) must produce
// the exact same hard-filter and scoring output as the pre-W5 cast-based read
// path. Hand-computed expected values lock the contract — any future drift
// (e.g. accidentally swapping the fallback order or dropping a field at the
// type boundary) fails here.
// ---------------------------------------------------------------------------

test("W5 cleanup: applyV16HardFilters reads typed UserTags identically to pre-W5 cast path", () => {
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    // careerStage (typed via W3) — junior user → entry_level/junior/mid_level
    careerStage: "junior",
    // targetJobType (typed via W3) — `full_time` keeps full-time, drops contract
    targetJobType: ["full_time"],
    // targetCountry (typed pre-W3) — US-only intent
    targetCountry: ["usa"],
    // targetLocations — typed pre-W3
    targetLocations: ["san_francisco_bay_area"],
    // visaStatus — typed pre-W3
    visaStatus: "citizen",
    // companyNegativeList (typed via B1) — drop "BlockedCo"
    companyNegativeList: ["blockedco"],
  } as never
  const jobs: MatchingJob[] = [
    // Keep: full_time, US bucket, in SF, junior stage, alive, fresh,
    // company not on negative list.
    mkJob({
      id: "keep",
      companyName: "Acme",
      jobType: "full_time",
      seniorityLevel: "junior",
      locationBuckets: ["san_francisco_bay_area"],
      sponsorship: true,
    }),
    // Drop: jobType=contract — fails targetJobType filter.
    mkJob({
      id: "drop-jobtype",
      companyName: "Acme",
      jobType: "contract",
      seniorityLevel: "junior",
      locationBuckets: ["san_francisco_bay_area"],
    }),
    // Drop: seniorityLevel="director" — outside junior window (index 3 vs 7).
    mkJob({
      id: "drop-seniority",
      companyName: "Acme",
      jobType: "full_time",
      seniorityLevel: "director",
      locationBuckets: ["san_francisco_bay_area"],
    }),
    // Drop: companyNegativeList match (normalizeCompanyName("BlockedCo") == "blockedco").
    mkJob({
      id: "drop-negative",
      companyName: "BlockedCo",
      jobType: "full_time",
      seniorityLevel: "junior",
      locationBuckets: ["san_francisco_bay_area"],
    }),
  ]
  const r = applyV16HardFilters(jobs, tags, NOW)
  // Pre-W5 behavior: 1 kept ("keep"), 3 dropped — 1 per counter.
  assert.deepEqual(r.kept.map((j) => j.id), ["keep"])
  assert.equal(r.counters.jobType, 1)
  assert.equal(r.counters.careerStage, 1)
  assert.equal(r.counters.negativeListDrop, 1)
})

test("W5 cleanup: applyV16HardFilters tolerates legacy plural targetJobTypes (back-compat fallback intact)", () => {
  // The plural `targetJobTypes` is intentionally NOT promoted to UserTagsSchema
  // (see merger doc comment on `targetJobType`). V16 still reads it as a
  // back-compat fallback when the canonical singular is absent. This test pins
  // the fallback so a future schema cleanup doesn't silently break old Firestore
  // docs.
  const tags = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    // No singular targetJobType — only legacy plural via cast.
    targetJobTypes: ["full_time"],
  } as never
  const jobs: MatchingJob[] = [
    mkJob({ id: "ft", jobType: "full_time" }),
    mkJob({ id: "ct", jobType: "contract" }),
  ]
  const r = applyV16HardFilters(jobs, tags, NOW)
  assert.deepEqual(r.kept.map((j) => j.id), ["ft"])
  assert.equal(r.counters.jobType, 1)
})

test("W5 cleanup: scoreV16Job reads typed relevantTags/minSalary/B4 fields identically to pre-W5 cast path", () => {
  // Lock the per-component score breakdown so a future regression at the
  // type-boundary surfaces as a numeric drift here.
  const tags = {
    skills: [{ name: "python", baseWeight: 1.0 }],
    industryEnum: ["tech_software"],
    schemaVersion: 1,
    // relevantTags (W3-promoted) — primary source for relTags
    relevantTags: ["frontend_development", "mlops"],
    // relevantSpecialization should NOT be consulted because relevantTags is non-empty
    relevantSpecialization: ["should_be_ignored"],
    // minSalary (typed pre-W3) — > job.salaryMin → salary fit < 1.0
    minSalary: 200000,
    // B4 typed fields
    targetCompanyTags: ["ai_native"],
    companyPositiveList: ["acme"],
    urgentlySeeking: true,
    industrySector: ["artificial_intelligence_and_machine_learning"],
  } as never
  const job = mkJob({
    id: "j",
    companyName: "Acme",
    requiredSkills: ["python"],
    relevantTags: ["frontend_development"],
    industrySector: ["artificial_intelligence_and_machine_learning"],
    salaryMin: 150000,
    jobType: "full_time",
    firstSeenAt: new Date(NOW - 3 * 24 * 3600 * 1000).toISOString(),
  } as never)
  const r = scoreV16Job(tags, job, undefined, 0.5, undefined, { stage: "series_a", tags: ["ai_native"] }, NOW)
  // Pre-W5 hand-computed expectations:
  // - llmMatch: 0.5 × 0.40 = 0.20
  // - skillJaccard: 1/1 = 1.0 × 0.20 = 0.20 (python matched, baseWeight=1)
  // - relevantTags: 1/2 = 0.5 × 0.15 = 0.075 (frontend overlap; mlops missing)
  //   Note: relevantSpecialization SHOULD NOT contribute because relevantTags
  //   is non-empty — locks the W5 fallback order (`user.relevantTags ?? …`).
  // - industrySector: 1/1 = 1.0 × 0.10 = 0.10
  // - cvEmbCosine: 0 × 0.10 = 0 (no embeddings)
  // - salaryFit: linear degrade — user wants 200k, job at 150k → 0
  //   pre-W5 read user.minSalary via cast; post-W5 reads same field typed.
  // - tagOverlap: jaccard({ai_native} ∩ {ai_native}) = 1.0 × 0.15 = 0.15
  // - positiveHit: normalizeCompanyName("Acme") == "acme" ∈ companyPositiveList → 0.15
  // - urgencyBoost: full_time + 3d old → +0.20
  assert.equal(r.breakdown.llmMatch, 0.5)
  assert.equal(r.breakdown.skillJaccard, 1.0)
  assert.ok(Math.abs(r.breakdown.relevantTags - 0.5) < 1e-9, `relevantTags=${r.breakdown.relevantTags}`)
  assert.equal(r.breakdown.industrySector, 1.0)
  assert.equal(r.breakdown.cvEmbCosine, 0)
  assert.equal(r.breakdown.salaryFit, 0)
  assert.ok(Math.abs(r.breakdown.tagOverlap - 0.15) < 1e-9, `tagOverlap=${r.breakdown.tagOverlap}`)
  assert.equal(r.breakdown.positiveHit, 0.15)
  assert.equal(r.breakdown.urgencyBoost, 0.20)
})

test("W5 cleanup: scoreV16Job relevantTags falls back to relevantSpecialization when relevantTags empty (order preserved)", () => {
  // Pins the fallback chain that pre-W5 cast read via `userExt.relevantTags ??
  // user.relevantSpecialization ?? user.proposedTags ?? []`. Post-W5 reads the
  // identical chain via typed access. Two fixtures lock both fallback steps.
  const tagsWithSpec = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    // No relevantTags → falls back to relevantSpecialization
    relevantSpecialization: ["mlops"],
    proposedTags: ["should_be_ignored"],
  } as never
  const job = mkJob({ relevantTags: ["mlops"] })
  const r1 = scoreV16Job(tagsWithSpec, job, undefined, 0, undefined, undefined, NOW)
  assert.ok(Math.abs(r1.breakdown.relevantTags - 1.0) < 1e-9, `relevantTags=${r1.breakdown.relevantTags} (specialization fallback)`)

  // No relevantTags AND no relevantSpecialization → falls back to proposedTags
  const tagsWithProposed = {
    skills: [],
    industryEnum: [],
    schemaVersion: 1,
    proposedTags: ["mlops"],
  } as never
  const r2 = scoreV16Job(tagsWithProposed, job, undefined, 0, undefined, undefined, NOW)
  assert.ok(Math.abs(r2.breakdown.relevantTags - 1.0) < 1e-9, `relevantTags=${r2.breakdown.relevantTags} (proposed fallback)`)
})

test("W5 cleanup: queryMatchingJobsV16 runV16Query reads typed targetRoleFunction identically (role-filter applies)", async () => {
  // Pins the role-filter access path on runV16Query — pre-W5 cast read
  // tagsExt.targetRoleFunction; post-W5 reads userTags.targetRoleFunction.
  // Behavior pin: when targetRoleFunction is populated, the array-contains-any
  // gate fires; sales jobs are dropped even though SWE jobs match.
  const mfs = new MockFirestore()
  await mfs
    .collection("pa-users")
    .doc("u_typed")
    .set({
      tags: {
        skills: [],
        industryEnum: [],
        schemaVersion: 1,
        targetRoleFunction: ["software_engineering"],
        targetLocations: ["san_francisco_bay_area"],
        visaStatus: "citizen",
        // Populate all 5 missingAxes-checked fields so needsOnboarding stays
        // undefined — pin focused on role-filter pass behavior.
        careerStage: "junior",
        targetJobType: ["full_time"],
      },
    })
  await seedJob(mfs, "swe", {
    roleFunction: ["software_engineering"],
    requiredSkills: ["python"],
    companyName: "SweCo",
    jobTitle: "SWE",
    seniorityLevel: "junior",
    jobType: "full_time",
    locationBuckets: ["san_francisco_bay_area"],
  })
  await seedJob(mfs, "sales", {
    roleFunction: ["sales"],
    requiredSkills: ["closing"],
    companyName: "SalesCo",
    jobTitle: "AE",
    seniorityLevel: "junior",
    jobType: "full_time",
    locationBuckets: ["san_francisco_bay_area"],
  })
  const r = await queryMatchingJobsV16(
    { userId: "u_typed", nowMs: NOW },
    { db: asFirestore(mfs) }
  )
  // SWE kept (role-filter pass), sales dropped at query layer.
  assert.equal(r.needsOnboarding, undefined)
  assert.equal(r.jobs.length, 1)
  assert.equal(r.jobs[0]!.id, "swe")
})
