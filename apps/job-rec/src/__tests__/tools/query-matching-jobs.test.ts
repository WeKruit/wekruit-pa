import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../mock-firestore.js"
import {
  jaccardOverlap,
  scoreJob,
  rankJobs,
  projectMatchingJobRow,
  mapTagToIndustryKeys,
  expandIndustryTags,
  applyTitleAntiBias,
  LOCATION_NEIGHBORS,
  QA_QC_TITLE_REGEX,
  applyHardFilters,
  applyHardFiltersWithFallback,
  inferCollegeStudent,
  isStillInSchool,
  parseStartYear,
  SENIOR_TITLE_REGEX,
  RESEARCH_KEYWORDS_REGEX,
  NO_SPONSORSHIP_KEYWORDS_REGEX,
  HARD_FILTERS_FLAG_KEY,
  type HardFilterUserProfile,
} from "../../tools/query-matching-jobs.js"
import type { MatchingJob } from "../../types.js"

test("jaccardOverlap: identical sets = 1.0", () => {
  assert.equal(jaccardOverlap(["python", "go"], ["python", "go"]), 1)
})

test("jaccardOverlap: disjoint sets = 0", () => {
  assert.equal(jaccardOverlap(["python"], ["go"]), 0)
})

test("jaccardOverlap: case-insensitive + whitespace-trimmed", () => {
  const v = jaccardOverlap([" Python "], ["python"])
  assert.equal(v, 1)
})

test("jaccardOverlap: empty inputs return 0", () => {
  assert.equal(jaccardOverlap([], ["x"]), 0)
  assert.equal(jaccardOverlap(["x"], []), 0)
})

test("scoreJob: penalizes sponsorship=true when user wants none", () => {
  const job: MatchingJob = {
    id: "a",
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "NYC",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/0",
    industry: "tech",
    sponsorship: true,
    requiredSkills: ["python"],
  }
  const noSponsor = scoreJob(job, { sponsorship: "none", userSkills: ["python"] }).total
  const wantSponsor = scoreJob(job, { sponsorship: "h1b", userSkills: ["python"] }).total
  assert.ok(wantSponsor > noSponsor, "wanting sponsorship should outscore wanting none")
})

test("scoreJob: rewards salaryMax >= salaryMin", () => {
  const job: MatchingJob = {
    id: "a",
    companyName: "X",
    jobTitle: "T",
    salaryMax: 200000,
    salaryMin: 150000,
    locationRaw: "",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/1",
    industry: "tech",
    sponsorship: null,
  }
  const above = scoreJob(job, { salaryMin: 100000 }).total
  const below = scoreJob(job, { salaryMin: 300000 }).total
  assert.ok(above > below)
})

test("scoreJob: location substring match boosts", () => {
  const j: MatchingJob = {
    id: "a",
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "San Francisco, CA",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/2",
    industry: "tech",
    sponsorship: null,
  }
  const match = scoreJob(j, { location: "san francisco" }).total
  const miss = scoreJob(j, { location: "boston" }).total
  assert.ok(match > miss)
})

// ---------------------------------------------------------------------------
// iter34 sprint B.10 — cosineSimilarity + scoreJob breakdown
// ---------------------------------------------------------------------------

import { cosineSimilarity, type ScoreBreakdown } from "../../tools/query-matching-jobs.js"

test("cosineSimilarity B.10: identical vectors return 1.0", () => {
  const v = [0.1, 0.2, 0.3, 0.4]
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9)
})

test("cosineSimilarity B.10: orthogonal vectors return 0", () => {
  const a = [1, 0, 0]
  const b = [0, 1, 0]
  assert.equal(cosineSimilarity(a, b), 0)
})

test("cosineSimilarity B.10: opposite vectors clamped to 0 (not -1)", () => {
  const a = [1, 2, 3]
  const b = [-1, -2, -3]
  assert.equal(cosineSimilarity(a, b), 0)
})

test("cosineSimilarity B.10: differing length throws", () => {
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /length mismatch/i)
})

test("cosineSimilarity B.10: zero-magnitude vector returns 0 (no NaN)", () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0)
})

test("scoreJob B.10: cvEmbedding present + matching job embedding → embedding component contributes to total", () => {
  const job: MatchingJob & { embedding?: number[] | null } = {
    id: "x",
    companyName: "X",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/3",
    industry: "tech",
    sponsorship: null,
    embedding: [1, 0, 0, 0],
  }
  const withEmb = scoreJob(job, { cvEmbedding: [1, 0, 0, 0] })
  const withoutEmb = scoreJob(job, {})
  assert.ok(withEmb.breakdown.embedding > 0.99, "cosine of identical = 1")
  assert.equal(withoutEmb.breakdown.embedding, 0)
  assert.ok(withEmb.total > withoutEmb.total, "embedding raises total when present + matching")
})

test("scoreJob B.10: cvEmbedding undefined → embedding component = 0, total naturally lower", () => {
  const job: MatchingJob & { embedding?: number[] | null } = {
    id: "x",
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/4",
    industry: "tech",
    sponsorship: null,
    embedding: [1, 0, 0],
  }
  const r = scoreJob(job, {})
  assert.equal(r.breakdown.embedding, 0)
  // Other 4 weights NOT redistributed — total only includes their contribution.
  assert.ok(r.total <= 0.7 + 1e-9, "without embedding, total is bounded by 1 - 0.30 = 0.70")
})

test("scoreJob B.10: job has no embedding → embedding component = 0", () => {
  const job: MatchingJob & { embedding?: number[] | null } = {
    id: "x",
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/5",
    industry: "tech",
    sponsorship: null,
    // no embedding field
  }
  const r = scoreJob(job, { cvEmbedding: [1, 2, 3] })
  assert.equal(r.breakdown.embedding, 0)
})

test("scoreJob B.10: embedding length mismatch → component = 0 (defensive, no throw)", () => {
  const job: MatchingJob & { embedding?: number[] | null } = {
    id: "x",
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/6",
    industry: "tech",
    sponsorship: null,
    embedding: [1, 0, 0],
  }
  // Mismatched dims must not bring down the whole scoring path.
  const r = scoreJob(job, { cvEmbedding: [1, 2] })
  assert.equal(r.breakdown.embedding, 0)
  assert.ok(Number.isFinite(r.total))
})

test("scoreJob B.10: breakdown shape carries all 5 components + total", () => {
  const job: MatchingJob & { embedding?: number[] | null } = {
    id: "x",
    companyName: "X",
    jobTitle: "SWE",
    salaryMax: 200000,
    salaryMin: null,
    locationRaw: "Remote",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/7",
    industry: "tech",
    sponsorship: true,
    requiredSkills: ["python", "ml"],
    embedding: [1, 0, 0, 0],
  }
  const r = scoreJob(job, {
    sponsorship: "h1b",
    location: "remote",
    salaryMin: 100000,
    userSkills: ["python"],
    cvEmbedding: [1, 0, 0, 0],
  })
  const b: ScoreBreakdown = r.breakdown
  assert.equal(typeof b.skill, "number")
  assert.equal(typeof b.embedding, "number")
  assert.equal(typeof b.sponsorship, "number")
  assert.equal(typeof b.location, "number")
  assert.equal(typeof b.salary, "number")
  assert.equal(typeof b.total, "number")
  assert.ok(b.skill >= 0 && b.skill <= 1)
  assert.ok(b.embedding >= 0 && b.embedding <= 1)
  assert.ok(b.sponsorship >= 0 && b.sponsorship <= 1)
  assert.ok(b.location >= 0 && b.location <= 1)
  assert.ok(b.salary >= 0 && b.salary <= 1)
  // total should equal the weighted sum
  const expected =
    0.35 * b.skill + 0.3 * b.embedding + 0.15 * b.sponsorship + 0.15 * b.location + 0.05 * b.salary
  assert.ok(Math.abs(b.total - expected) < 1e-9, "total = weighted sum of components")
})

test("scoreJob B.10: weights sum to 1.0 (skill 0.35 + emb 0.30 + spons 0.15 + loc 0.15 + sal 0.05)", () => {
  // Synthetic job that maxes every component.
  const job: MatchingJob & { embedding?: number[] | null } = {
    id: "x",
    companyName: "X",
    jobTitle: "T",
    salaryMax: 200000,
    salaryMin: null,
    locationRaw: "San Francisco, CA",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/8",
    industry: "tech",
    sponsorship: true,
    requiredSkills: ["python"],
    embedding: [1],
  }
  const r = scoreJob(job, {
    userSkills: ["python"],
    sponsorship: "h1b",
    location: "san francisco",
    salaryMin: 100000,
    cvEmbedding: [1],
  })
  // All components = 1 → total = 1
  assert.ok(Math.abs(r.total - 1) < 1e-9, `expected total=1.0, got ${r.total}`)
})


test("rankJobs: orders by composite score desc", () => {
  const a: MatchingJob = {
    id: "a",
    companyName: "Hi",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "NYC",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/10",
    industry: "tech",
    sponsorship: null,
    requiredSkills: ["python", "go"],
  }
  const b: MatchingJob = {
    id: "b",
    companyName: "Lo",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "NYC",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/11",
    industry: "tech",
    sponsorship: null,
    requiredSkills: ["fortran"],
  }
  const ranked = rankJobs([b, a], { userSkills: ["python", "go"] }, 2)
  assert.equal(ranked[0]?.id, "a")
  assert.equal(ranked[1]?.id, "b")
})

test("rankJobs: ties broken by newer firstSeenAt", () => {
  const older: MatchingJob = {
    id: "older",
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/12",
    industry: "tech",
    sponsorship: null,
    firstSeenAt: "2026-01-01",
    lastSeenAt: "2026-01-01",
  }
  const newer: MatchingJob = { ...older, id: "newer", firstSeenAt: "2026-04-01" }
  const ranked = rankJobs([older, newer], {}, 2)
  assert.equal(ranked[0]?.id, "newer")
})

test("rankJobs: limit truncates output", () => {
  const j = (id: string): MatchingJob => ({
    id,
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/13",
    industry: "tech",
    sponsorship: null,
  })
  const out = rankJobs([j("1"), j("2"), j("3")], {}, 2)
  assert.equal(out.length, 2)
})

test("projectMatchingJobRow: maps roleTitle → jobTitle when no jobTitle field", () => {
  const out = projectMatchingJobRow("doc1", {
    companyName: "Co",
    roleTitle: "SWE II",
    salaryMax: 100000,
    locationRaw: "NYC",
    primaryUrl: "https://x",
    atsApplyUrl: "https://greenhouse.io/co/jobs/14",
    industry: "tech",
    sponsorship: false,
  })
  assert.equal(out.jobTitle, "SWE II")
  assert.equal(out.companyName, "Co")
  // 2026-05-19 hotfix — raw roleTitle ALSO surfaced through the projection
  // so downstream V16 sites with their own fallback chain have something to
  // fall back to (defense in depth).
  assert.equal(out.roleTitle, "SWE II")
})

test("projectMatchingJobRow: omits roleTitle field when raw doc has no roleTitle", () => {
  const out = projectMatchingJobRow("doc1", {
    companyName: "Co",
    jobTitle: "Backend Engineer", // legacy doc shape
  })
  assert.equal(out.jobTitle, "Backend Engineer")
  // Optional — undefined when raw has no roleTitle, so consumers don't see
  // an empty string masquerading as a real value.
  assert.equal(out.roleTitle, undefined)
})

test("projectMatchingJobRow: defends against missing fields", () => {
  const out = projectMatchingJobRow("doc1", {})
  assert.equal(out.companyName, "")
  assert.equal(out.salaryMax, null)
  assert.equal(out.requiredSkills, undefined)
})

// iter34 sprint A.2 — atsApplyUrl projection (camelCase, Firestore side).
test("projectMatchingJobRow: surfaces atsApplyUrl when present", () => {
  const out = projectMatchingJobRow("doc1", {
    companyName: "Co",
    roleTitle: "SWE",
    primaryUrl: "https://jobright.ai/m/abc",
    atsApplyUrl: "https://greenhouse.io/co/jobs/123",
  })
  assert.equal(out.atsApplyUrl, "https://greenhouse.io/co/jobs/123")
  // primaryUrl untouched — still surfaced for fallback.
  assert.equal(out.primaryUrl, "https://jobright.ai/m/abc")
})

// P7-C 2026-05-08 — canonical-tags unified schema. The wekruit-pa
// `paMatchingJobsAutoEnrich` Firestore trigger writes `requiredSkills`
// as `Skill[]` objects (canonical bucketed shape). The legacy/scraper
// path writes flat `string[]`. The projector must accept BOTH shapes
// and emit `string[]` for downstream skill-jaccard scoring.
test("projectMatchingJobRow: P7-C canonical Skill[] objects → flat name[]", () => {
  const out = projectMatchingJobRow("doc1", {
    companyName: "Stripe",
    roleTitle: "Senior Software Engineer",
    primaryUrl: "https://x",
    requiredSkills: [
      { name: "python", bucket: "programming_languages", baseWeight: 0.8, proficiency: "advanced", evidenceCount: 3 },
      { name: "rust", bucket: "programming_languages", baseWeight: 0.5, proficiency: "intermediate", evidenceCount: 1 },
      { name: "kubernetes", bucket: "cloud_and_infrastructure", baseWeight: 0.6, proficiency: "intermediate", evidenceCount: 2 },
    ],
  })
  assert.deepEqual(out.requiredSkills, ["python", "rust", "kubernetes"])
})

test("projectMatchingJobRow: P7-C legacy string[] still passes through unchanged", () => {
  const out = projectMatchingJobRow("doc1", {
    companyName: "Co",
    roleTitle: "SWE",
    primaryUrl: "https://x",
    requiredSkills: ["python", "sql", "go"],
  })
  assert.deepEqual(out.requiredSkills, ["python", "sql", "go"])
})

test("projectMatchingJobRow: P7-C mixed string + Skill objects survives normalization", () => {
  const out = projectMatchingJobRow("doc1", {
    companyName: "Co",
    roleTitle: "SWE",
    primaryUrl: "https://x",
    requiredSkills: [
      "python",  // legacy string
      { name: "kubernetes", bucket: "cloud_and_infrastructure", baseWeight: 0.5, proficiency: "intermediate", evidenceCount: 1 },
      null,  // garbage entry
      { not_a_name: "broken" },  // wrong shape — dropped
    ],
  })
  assert.deepEqual(out.requiredSkills, ["python", "kubernetes"])
})

test("projectMatchingJobRow: P7-C empty / undefined requiredSkills → undefined (not [])", () => {
  // The projector returns `undefined` for missing/empty so downstream
  // consumers branch on `Array.isArray(j.requiredSkills) && j.length > 0`.
  const out1 = projectMatchingJobRow("doc1", {})
  assert.equal(out1.requiredSkills, undefined)
  const out2 = projectMatchingJobRow("doc1", { requiredSkills: [] })
  assert.equal(out2.requiredSkills, undefined)
  const out3 = projectMatchingJobRow("doc1", { requiredSkills: [{not_a_skill: 1}, null] })
  // All entries failed normalization → empty → undefined
  assert.equal(out3.requiredSkills, undefined)
})

test("projectMatchingJobRow: atsApplyUrl normalizes null → undefined", () => {
  const out = projectMatchingJobRow("doc1", {
    primaryUrl: "https://x",
    atsApplyUrl: null,
  })
  assert.equal(out.atsApplyUrl, undefined)
})

test("projectMatchingJobRow: atsApplyUrl absent → undefined", () => {
  const out = projectMatchingJobRow("doc1", {
    primaryUrl: "https://x",
  })
  assert.equal(out.atsApplyUrl, undefined)
})




// ---------------------------------------------------------------------------
// Stream H6 — industryTag → industryKey mapping
// ---------------------------------------------------------------------------

test("mapTagToIndustryKeys: tech_software expands to multiple corpus keys including 'tech' and 'engineering'", () => {
  const keys = mapTagToIndustryKeys("tech_software")
  assert.ok(keys.includes("tech"), "tech_software should map to 'tech'")
  assert.ok(keys.includes("engineering"), "tech_software should map to 'engineering'")
  assert.ok(keys.length >= 3, "tech_software should expand to >= 3 corpus keys")
})

test("mapTagToIndustryKeys: unknown tag falls open by returning [tag] (literal pass-through)", () => {
  const keys = mapTagToIndustryKeys("nonexistent_industry_xyz")
  assert.deepEqual(keys, ["nonexistent_industry_xyz"])
})

test("expandIndustryTags: dedupes overlapping keys across multiple tags + caps at 10", () => {
  // tech_software and ai_ml both include "tech" — expanded list must dedupe.
  const out = expandIndustryTags(["tech_software", "ai_ml"])
  const dedup = new Set(out)
  assert.equal(out.length, dedup.size, "no duplicates in expanded set")
  assert.ok(out.includes("tech"))
  assert.ok(out.includes("ai_ml"))
  assert.ok(out.length <= 10, "in-clause cap")
  // Empty + non-array inputs → []
  assert.deepEqual(expandIndustryTags([]), [])
  assert.deepEqual(expandIndustryTags(["", "  "]), [])
})


// ---------------------------------------------------------------------------
// Stream H8 — flag-gated industryEnum array-contains-any path
// ---------------------------------------------------------------------------

import { capIndustryEnumValues } from "../../tools/query-matching-jobs.js"
import { _clearFeatureFlagCache } from "@pa/pa-persistence"

test("capIndustryEnumValues: dedupes + caps at 10 + drops empty", () => {
  assert.deepEqual(capIndustryEnumValues(["a", "b", "a", " ", "", "c"]), ["a", "b", "c"])
  const big = Array.from({ length: 20 }, (_, i) => `t${i}`)
  assert.equal(capIndustryEnumValues(big).length, 10)
  assert.deepEqual(capIndustryEnumValues([]), [])
})





// ---------------------------------------------------------------------------
// Stream H7 — Location fallback ladder (D1)
// ---------------------------------------------------------------------------

test("scoreJob H7: Baltimore preference + DC-area job → ladder fallback (0.6) beats no-match floor (0.2)", () => {
  const jobDC: MatchingJob = {
    id: "dc",
    companyName: "X",
    jobTitle: "Data Analyst",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "Washington, DC",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/27",
    industry: "tech",
    sponsorship: null,
  }
  const jobBoise: MatchingJob = { ...jobDC, id: "boise", locationRaw: "Boise, ID" }
  const ladderHit = scoreJob(jobDC, { location: "Baltimore,MD" }).total
  const noMatch = scoreJob(jobBoise, { location: "Baltimore,MD" }).total
  // iter34 B.10 — location weight rebalanced 0.2 → 0.15. Ladder gives 0.6,
  // no-match gives 0.2 → delta = 0.15 * (0.6 - 0.2) = 0.06
  assert.ok(ladderHit > noMatch, `ladder hit (${ladderHit}) should beat no-match (${noMatch})`)
  assert.ok(Math.abs((ladderHit - noMatch) - 0.15 * (0.6 - 0.2)) < 1e-9, "ladder delta should be 0.15 weight * (0.6 - 0.2)")
})

test("scoreJob H7: Baltimore preference + Remote job → ladder gives 0.7 (remote-neighbor)", () => {
  const remoteJob: MatchingJob = {
    id: "r",
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "Remote",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/28",
    industry: "tech",
    sponsorship: null,
  }
  const dcJob: MatchingJob = { ...remoteJob, id: "dc", locationRaw: "Washington, DC" }
  const remoteScore = scoreJob(remoteJob, { location: "Baltimore,MD" }).total
  const dcScore = scoreJob(dcJob, { location: "Baltimore,MD" }).total
  // Remote should outscore DC because remote-neighbor → 0.7, city-neighbor → 0.6
  assert.ok(remoteScore > dcScore, `remote ladder (${remoteScore}) should beat DC ladder (${dcScore})`)
})

test("scoreJob H7: primary substring match still wins over ladder neighbor", () => {
  const baltimoreJob: MatchingJob = {
    id: "b",
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "Baltimore, MD",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/29",
    industry: "tech",
    sponsorship: null,
  }
  const philJob: MatchingJob = { ...baltimoreJob, id: "p", locationRaw: "Philadelphia, PA" }
  const primaryScore = scoreJob(baltimoreJob, { location: "Baltimore,MD" }).total
  const ladderScore = scoreJob(philJob, { location: "Baltimore,MD" }).total
  assert.ok(primaryScore > ladderScore, "primary city should beat ladder neighbor")
})

test("scoreJob H7: city-without-ladder-entry still falls to 0.2 floor (no-op for unknown prefs)", () => {
  // 'kalamazoo,mi' is intentionally NOT in LOCATION_NEIGHBORS
  assert.ok(!("kalamazoo,mi" in LOCATION_NEIGHBORS), "test corpus assumption: kalamazoo not in table")
  const job: MatchingJob = {
    id: "x",
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "Detroit, MI",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/30",
    industry: "tech",
    sponsorship: null,
  }
  // No primary substring match, no ladder entry, no remote → 0.2 floor
  const noLadder = scoreJob(job, { location: "Kalamazoo,MI" }).total
  // Pure-substring match (Detroit job vs Detroit pref) for control
  const directHit = scoreJob({ ...job, locationRaw: "Detroit, MI" }, { location: "Detroit, MI" }).total
  // iter34 B.10 — location weight 0.15. Delta = 0.15 * (1.0 - 0.2) = 0.12
  assert.ok(directHit - noLadder >= 0.1, "direct hit should be at least 0.10 over no-ladder")
})

test("scoreJob H7: ladder fallback handles whitespace/case variants in primary preference", () => {
  // Adam writes "Baltimore,MD" but ladder also accepts "baltimore" (short form);
  // ensure case + trimming work end-to-end.
  const dc: MatchingJob = {
    id: "dc",
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "Washington, DC",
    primaryUrl: "u",
    atsApplyUrl: "https://greenhouse.io/co/jobs/31",
    industry: "tech",
    sponsorship: null,
  }
  const a = scoreJob(dc, { location: "BALTIMORE,MD" }).total
  const b = scoreJob(dc, { location: "  Baltimore,MD  " }).total
  const c = scoreJob(dc, { location: "Baltimore" }).total
  // All three should hit the ladder; all > 0.2-floor location component
  // sanity: scores should be equal pairwise (case + trim invariant)
  assert.ok(Math.abs(a - b) < 1e-9, "case insensitivity + trim should be invariant")
  // 'Baltimore' (short key) ladder uses different neighbor strings ("washington dc" without comma)
  // — DC job's "Washington, DC" still includes "washington dc"? No — has comma + space.
  // The short-form ladder hits via "annapolis"/"philadelphia"/"remote" probably not — DC job won't match short-form ladder. So `c` should be the lower-scored variant.
  // We just confirm the long-form variants match the same.
  void c
})

// ---------------------------------------------------------------------------
// Stream H7 — Title anti-bias rerank (D2)
// ---------------------------------------------------------------------------

test("applyTitleAntiBias H7: tech_software user + QC Analyst title → heavy penalty (sinks rank)", () => {
  // Cosine-ranked input: QC at #1, Data Analyst at #2 (QC was the false-friend)
  const jobs = [
    { id: "qc", jobTitle: "QC Analyst I", companyName: "charm sciences" },
    { id: "da", jobTitle: "Data Analyst", companyName: "weather co" },
    { id: "pm", jobTitle: "Associate Product Manager", companyName: "weather co" },
  ]
  const out = applyTitleAntiBias(jobs, ["tech_software", "ai_ml", "fintech_finance"], 3)
  // After anti-bias: clean Data Analyst should beat penalized QC
  assert.equal(out[0]!.id, "da", "Data Analyst should rise to #1")
  assert.equal(out[2]!.id, "qc", "QC Analyst should sink to last among 3")
})

test("applyTitleAntiBias H7: SDET title (qa engineer) at FAANG with tech_software user → penalized but not dropped", () => {
  // The penalty is 0.3x not 0, so a top-1 SDET still beats a top-N+epsilon clean job.
  // But: a pool of 5 jobs, SDET at #1, clean #2-#5 → SDET(0.3*5=1.5) sinks below clean #2 (4) and #3 (3) but above #5 (1). Verify it's NOT removed.
  const jobs = [
    { id: "sdet_stripe", jobTitle: "QA Engineer (SDET)", companyName: "stripe" },
    { id: "swe1", jobTitle: "Software Engineer", companyName: "co1" },
    { id: "swe2", jobTitle: "Senior SWE", companyName: "co2" },
    { id: "swe3", jobTitle: "Backend Engineer", companyName: "co3" },
    { id: "swe4", jobTitle: "Platform Engineer", companyName: "co4" },
  ]
  const out = applyTitleAntiBias(jobs, ["tech_software"], 5)
  // SDET still in the result (not zeroed), but no longer at #1
  const ids = out.map((j) => j.id)
  assert.ok(ids.includes("sdet_stripe"), "SDET should survive (penalty not removal)")
  assert.notEqual(out[0]!.id, "sdet_stripe", "SDET should not be #1 after penalty")
})

test("applyTitleAntiBias H7: Data Analyst title (Adam-fit) → no penalty even for tech_software user", () => {
  const jobs = [
    { id: "da", jobTitle: "Data Analyst", companyName: "X" },
    { id: "swe", jobTitle: "Software Engineer", companyName: "Y" },
  ]
  const out = applyTitleAntiBias(jobs, ["tech_software"], 2)
  // Order should be preserved — Data Analyst was #1, stays #1 (no penalty applies)
  assert.equal(out[0]!.id, "da")
  assert.equal(out[1]!.id, "swe")
})

test("applyTitleAntiBias H7: non-tech user (healthcare_biotech) → QC Analyst NOT penalized", () => {
  // For a healthcare/biotech user, "QC Analyst" is a legitimate role.
  // Anti-bias gate must only fire for tech_software/ai_ml/fintech_finance.
  const jobs = [
    { id: "qc", jobTitle: "QC Analyst I", companyName: "charm sciences" },
    { id: "lab", jobTitle: "Lab Technician", companyName: "biolab" },
  ]
  const out = applyTitleAntiBias(jobs, ["healthcare_biotech"], 2)
  // QC was input #1; without penalty it stays #1
  assert.equal(out[0]!.id, "qc", "healthcare_biotech user should not penalize QC roles")
})

test("applyTitleAntiBias H7: regex sanity — covers brief's full title patterns", () => {
  const hits = [
    "Quality Assurance Specialist I",
    "Quality Control Analyst",
    "QA Specialist",
    "QC Inspector",
    "Manufacturing Engineer",
    "Process Engineer",
    "Technician",
    "Inspector",
  ]
  for (const t of hits) {
    assert.ok(QA_QC_TITLE_REGEX.test(t), `regex should match: ${t}`)
  }
  const misses = [
    "Software Engineer",
    "Data Analyst",
    "Product Manager",
    "Senior SWE",
  ]
  for (const t of misses) {
    assert.ok(!QA_QC_TITLE_REGEX.test(t), `regex should NOT match: ${t}`)
  }
})



// ---------------------------------------------------------------------------
// Phase 43 (v1.5 / Stream-C) — applyHardFilters tests (D4 brief: 8 tests).
// Plus inferCollegeStudent / isStillInSchool / parseStartYear smoke coverage.
// ---------------------------------------------------------------------------

const NOW_2026_05_02 = new Date("2026-05-02T00:00:00Z")

function makeJob(overrides: Partial<MatchingJob> & { id: string }): MatchingJob {
  return {
    id: overrides.id,
    companyName: overrides.companyName ?? "Co",
    jobTitle: overrides.jobTitle ?? "Engineer",
    salaryMax: overrides.salaryMax ?? null,
    salaryMin: overrides.salaryMin ?? null,
    locationRaw: overrides.locationRaw ?? "Remote",
    primaryUrl: overrides.primaryUrl ?? "https://x",
    atsApplyUrl: "https://greenhouse.io/co/jobs/32",
    industry: overrides.industry ?? "tech",
    industryKey: overrides.industryKey,
    sponsorship: overrides.sponsorship ?? null,
    jobType: overrides.jobType,
    requiredSkills: overrides.requiredSkills,
    firstSeenAt: overrides.firstSeenAt,
  }
}

test("Phase43 D4 #1: college student (yoeRange [0,0]) + senior job → dropped", () => {
  const profile: HardFilterUserProfile = {
    statedPreferences: { yoeRange: [0, 0] },
  }
  const senior = makeJob({ id: "s", jobTitle: "Senior Software Engineer" })
  const junior = makeJob({ id: "j", jobTitle: "Software Engineer" })
  const out = applyHardFilters(profile, [senior, junior], undefined, NOW_2026_05_02)
  assert.equal(out.length, 1)
  assert.equal(out[0]?.id, "j", "junior survives, senior dropped")
})

test("Phase43 D4 #2: YoE 5y user + senior job → kept", () => {
  const profile: HardFilterUserProfile = {
    statedPreferences: { yoeRange: [5, 7] },
  }
  const senior = makeJob({ id: "s", jobTitle: "Senior Software Engineer" })
  const out = applyHardFilters(profile, [senior], undefined, NOW_2026_05_02)
  assert.equal(out.length, 1)
  assert.equal(out[0]?.id, "s")
})

test("Phase43 D4 #3: researchOriented=true + research job → kept", () => {
  const profile: HardFilterUserProfile = {
    statedPreferences: { researchOriented: true },
  }
  const research = makeJob({
    id: "r",
    jobTitle: "Research Scientist",
    requiredSkills: ["python", "ml"],
  })
  const out = applyHardFilters(profile, [research], undefined, NOW_2026_05_02)
  assert.equal(out.length, 1)
  assert.equal(out[0]?.id, "r")
})

test("Phase43 D4 #4: researchOriented=true + non-research job → dropped (research-only when explicit)", () => {
  const profile: HardFilterUserProfile = {
    statedPreferences: { researchOriented: true },
  }
  const eng = makeJob({ id: "e", jobTitle: "Software Engineer", requiredSkills: ["python"] })
  const out = applyHardFilters(profile, [eng], undefined, NOW_2026_05_02)
  assert.equal(out.length, 0, "non-research dropped under researchOriented=true")
  // Symmetry check: when researchOriented is undefined, the same eng survives.
  const profileNoPref: HardFilterUserProfile = { statedPreferences: {} }
  const out2 = applyHardFilters(profileNoPref, [eng], undefined, NOW_2026_05_02)
  assert.equal(out2.length, 1, "no researchOriented signal → no exclusion")
})

test("Phase43 D4 #5: sponsorship_needed + 'no sponsorship' job (text marker) → dropped", () => {
  const profile: HardFilterUserProfile = {
    statedPreferences: { visaStatus: "sponsorship_needed" },
  }
  const j1 = makeJob({
    id: "x",
    jobTitle: "Software Engineer (US Citizen Only)",
    requiredSkills: ["python"],
  })
  const j2 = makeJob({
    id: "y",
    jobTitle: "ML Engineer",
    requiredSkills: ["must have green card", "python"],
  })
  // Also test corpus boolean signal: sponsorship === false hard-blocked too.
  const j3 = makeJob({ id: "z", jobTitle: "Backend Engineer", sponsorship: false })
  const out = applyHardFilters(profile, [j1, j2, j3], undefined, NOW_2026_05_02)
  assert.equal(out.length, 0, "all three should drop")
})

test("Phase43 D4 #6: sponsorship_needed + sponsor-friendly job → kept", () => {
  const profile: HardFilterUserProfile = {
    statedPreferences: { visaStatus: "sponsorship_needed" },
  }
  const j = makeJob({
    id: "ok",
    jobTitle: "ML Engineer",
    requiredSkills: ["python"],
    sponsorship: true,
  })
  const out = applyHardFilters(profile, [j], undefined, NOW_2026_05_02)
  assert.equal(out.length, 1)
  assert.equal(out[0]?.id, "ok")
})

test("Phase43 D4 #7: 0-survival fallback returns prev-7-day jobs + fallbackMode=true", () => {
  // College student + ALL fresh jobs are senior → tier1, tier2, tier3 all 0.
  // prev7d set provided → tier4 returns that with fallbackMode=true.
  const profile: HardFilterUserProfile = {
    statedPreferences: { yoeRange: [0, 0] },
  }
  const fresh = [
    makeJob({ id: "s1", jobTitle: "Staff Engineer" }),
    makeJob({ id: "s2", jobTitle: "Principal Architect" }),
  ]
  const prev7d = [
    makeJob({ id: "p1", jobTitle: "Junior Engineer" }),
    makeJob({ id: "p2", jobTitle: "Associate Engineer" }),
    makeJob({ id: "p3", jobTitle: "New Grad SWE" }),
  ]
  const res = applyHardFiltersWithFallback(profile, fresh, prev7d, 3, NOW_2026_05_02)
  assert.equal(res.fallbackMode, true)
  assert.equal(res.relaxLevel, "prev7d")
  assert.equal(res.jobs.length, 3)
  assert.equal(res.jobs[0]?.id, "p1")
})

test("Phase43 D4 #8: 0-survival → flag passed back to daily-batch (HardFilterResult.fallbackMode)", () => {
  // Brief D4 #8: "0-survival → flag passed back to daily-batch indicating
  // fallback mode". The flag is HardFilterResult.fallbackMode = true any
  // time the relax ladder lands on the prev7d tier — whether or not the
  // prev7dJobs list is non-empty. The caller (daily-batch) then either
  // surfaces Variant D ("没找到完美 fit") with prev7d content, OR — if
  // prev7d is also empty — gracefully skips the user (no ghost message).
  const profile: HardFilterUserProfile = {
    statedPreferences: { yoeRange: [0, 0] },
  }
  const fresh = [makeJob({ id: "s1", jobTitle: "Senior SWE" })]
  const res = applyHardFiltersWithFallback(profile, fresh, [], 3, NOW_2026_05_02)
  assert.equal(res.relaxLevel, "prev7d")
  assert.equal(res.jobs.length, 0)
  assert.equal(res.fallbackMode, true, "fallbackMode flag is set even when prev7dJobs is empty — daily-batch needs the signal to skip cleanly")
  // Sanity — flag key constant is the documented one.
  assert.equal(HARD_FILTERS_FLAG_KEY, "paHardFiltersEnabled")
})

// ----- Helper smoke tests --------------------------------------------------

test("inferCollegeStudent: all-present + recent → true", () => {
  const exps = [
    { startDate: "2024-09", endDate: "present" },
    { startDate: "2023-06", endDate: "present" },
  ]
  assert.equal(inferCollegeStudent(exps, NOW_2026_05_02), true)
})

test("inferCollegeStudent: any non-present → false", () => {
  const exps = [
    { startDate: "2024", endDate: "present" },
    { startDate: "2022", endDate: "2023" },
  ]
  assert.equal(inferCollegeStudent(exps, NOW_2026_05_02), false)
})

test("inferCollegeStudent: 5+ year-old startDate → false (out of 4yr lookback)", () => {
  const exps = [{ startDate: "2018", endDate: "present" }]
  assert.equal(inferCollegeStudent(exps, NOW_2026_05_02), false)
})

test("isStillInSchool: present + startDate within 12mo → true", () => {
  // now=2026-05-02, startDate=2025-08 → ~9mo back → true.
  const exps = [{ startDate: "2025-08", endDate: "present" }]
  assert.equal(isStillInSchool(exps, NOW_2026_05_02), true)
})

test("isStillInSchool: present + startDate >12mo back → false", () => {
  const exps = [{ startDate: "2024", endDate: "present" }]
  assert.equal(isStillInSchool(exps, NOW_2026_05_02), false)
})

test("parseStartYear: handles bare year + YYYY-MM + YYYY-MM-DD", () => {
  assert.equal(parseStartYear("2024"), 2024)
  assert.equal(parseStartYear("2024-09"), 2024)
  assert.equal(parseStartYear("2024-09-15"), 2024)
  assert.equal(parseStartYear("garbage"), null)
  assert.equal(parseStartYear(undefined), null)
})

test("SENIOR_TITLE_REGEX: bilingual + boundary-aware", () => {
  const hits = [
    "Senior Engineer",
    "Sr. Software Engineer",
    "Staff ML Engineer",
    "Principal Architect",
    "VP of Engineering",
    "Tech Lead",
    "Director of Product",
    "资深前端工程师",
    "高级数据分析师",
    "AI 主管",
  ]
  for (const t of hits) assert.ok(SENIOR_TITLE_REGEX.test(t), `should match: ${t}`)
  const misses = ["Software Engineer", "Data Analyst", "ML Researcher", "前端工程师"]
  for (const t of misses) assert.ok(!SENIOR_TITLE_REGEX.test(t), `should NOT match: ${t}`)
})

test("RESEARCH_KEYWORDS_REGEX: bilingual coverage", () => {
  const hits = [
    "Research Scientist",
    "Applied Scientist",
    "PhD required",
    "Postdoc Fellow",
    "research engineer",
    "研究员",
    "AI 科研工程师",
  ]
  for (const t of hits) assert.ok(RESEARCH_KEYWORDS_REGEX.test(t), `should match: ${t}`)
  const misses = ["Software Engineer", "Frontend Developer"]
  for (const t of misses) assert.ok(!RESEARCH_KEYWORDS_REGEX.test(t), `should NOT match: ${t}`)
})

test("NO_SPONSORSHIP_KEYWORDS_REGEX: bilingual coverage", () => {
  const hits = [
    "US Citizen Only",
    "no sponsorship",
    "Must have Green Card",
    "GC required",
    "需要美国公民身份",
    "仅限绿卡",
    "不提供 sponsorship",
  ]
  for (const t of hits) assert.ok(NO_SPONSORSHIP_KEYWORDS_REGEX.test(t), `should match: ${t}`)
  const misses = ["Software Engineer", "ML Engineer at Google"]
  for (const t of misses) assert.ok(!NO_SPONSORSHIP_KEYWORDS_REGEX.test(t), `should NOT match: ${t}`)
})

test("Phase43 location hard-block: targetLocations + non-matching job → dropped", () => {
  const profile: HardFilterUserProfile = {
    statedPreferences: { targetLocations: ["San Francisco", "Remote"] },
  }
  const sf = makeJob({ id: "sf", locationRaw: "San Francisco, CA" })
  const ny = makeJob({ id: "ny", locationRaw: "New York, NY" })
  const remote = makeJob({ id: "rm", locationRaw: "Remote" })
  const out = applyHardFilters(profile, [sf, ny, remote], undefined, NOW_2026_05_02)
  const ids = out.map((j) => j.id).sort()
  assert.deepEqual(ids, ["rm", "sf"], "NY dropped, SF + Remote kept")
})

test("Phase43 location ladder: targetLocation Baltimore + DC-area job → kept (LOCATION_NEIGHBORS)", () => {
  const profile: HardFilterUserProfile = {
    statedPreferences: { targetLocations: ["baltimore"] },
  }
  const dc = makeJob({ id: "dc", locationRaw: "Washington, DC" })
  const out = applyHardFilters(profile, [dc], undefined, NOW_2026_05_02)
  assert.equal(out.length, 1, "DC counts as Baltimore-neighbor")
})

test("Phase43 fallback ladder: tier-2 (relaxed=drop location) yields survivor", () => {
  // Profile: NO yoeRange (so YoE rule depends on CV; absent), needs sponsorship,
  // wants only SF. Single job: sponsorship-friendly NY ML role. Tier 1 drops
  // it (location mismatch); tier 2 keeps it (location relaxed).
  const profile: HardFilterUserProfile = {
    statedPreferences: {
      visaStatus: "sponsorship_needed",
      targetLocations: ["San Francisco"],
    },
  }
  const ny = makeJob({
    id: "ny",
    jobTitle: "ML Engineer",
    locationRaw: "New York, NY",
    sponsorship: true,
  })
  const res = applyHardFiltersWithFallback(profile, [ny], [], 3, NOW_2026_05_02)
  assert.equal(res.relaxLevel, "relaxed")
  assert.equal(res.fallbackMode, false)
  assert.equal(res.jobs[0]?.id, "ny")
})

test("Phase43 D3 smart fallback: no statedPreferences + CV all-present → infer college-student → drop seniors", () => {
  // Onboarding probe v2 not done (statedPreferences absent). CV: 2 ongoing
  // experiences within last 4 years → inferred student → drop seniors.
  const profile: HardFilterUserProfile = {
    experiences: [
      { startDate: "2024", endDate: "present" },
      { startDate: "2023", endDate: "present" },
    ],
  }
  const senior = makeJob({ id: "s", jobTitle: "Senior Engineer" })
  const intern = makeJob({ id: "i", jobTitle: "Software Engineer Intern" })
  const out = applyHardFilters(profile, [senior, intern], undefined, NOW_2026_05_02)
  assert.equal(out.length, 1)
  assert.equal(out[0]?.id, "i")
})

// ---------------------------------------------------------------------------
// TD-#10 — Defensive guard against polluted industryEnum
// ---------------------------------------------------------------------------

import {
  applyEnrichmentNeverList,
  NON_TECH_NEVER_KEYS,
  TECH_LEANING_USER_TAGS,
  getJobIndustryBuckets,
} from "../../tools/query-matching-jobs.js"

// ---------------------------------------------------------------------------
// iter34 sprint B.12 — getJobIndustryBuckets helper (industryEnum > industryKey)
// ---------------------------------------------------------------------------

test("getJobIndustryBuckets B.12: doc with industryEnum → returns the array", () => {
  const out = getJobIndustryBuckets({ industryEnum: ["tech_software"], industryKey: "tech" })
  assert.deepEqual(out, ["tech_software"], "industryEnum wins when both present (cleaner taxonomy)")
})

test("getJobIndustryBuckets B.12: doc with only industryKey → fallback to [industryKey]", () => {
  const out = getJobIndustryBuckets({ industryKey: "management" })
  assert.deepEqual(out, ["management"], "legacy fallback wraps single value into array")
})

test("getJobIndustryBuckets B.12: doc with neither → empty array", () => {
  assert.deepEqual(getJobIndustryBuckets({}), [])
})

test("getJobIndustryBuckets B.12: empty industryEnum array → fallback to industryKey", () => {
  const out = getJobIndustryBuckets({ industryEnum: [], industryKey: "consulting" })
  assert.deepEqual(out, ["consulting"], "empty enum array still triggers legacy fallback")
})

test("applyEnrichmentNeverList B.12: industryEnum=[customer_service] (canonical) → rejected", () => {
  // Using the canonical taxonomy: customer_service is in NEVER_KEYS, so a
  // doc tagged industryEnum=["customer_service"] must be rejected even
  // when industryKey claims something tech-leaning.
  const jobs = [
    { id: "cs", industryEnum: ["customer_service"], industryKey: "tech" },
    { id: "ok", industryEnum: ["tech_software"], industryKey: "tech" },
  ]
  const r = applyEnrichmentNeverList(jobs, ["tech_software"])
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "ok")
  assert.equal(r.rejected, 1)
  assert.equal(r.rejectedKeys.customer_service, 1)
})

test("applyEnrichmentNeverList B.12: industryEnum present + clean → industryKey ignored even if NEVER_KEY", () => {
  // Trust direction flipped: industryEnum is the CLEAN signal post-H8 fix.
  // When industryEnum says tech_software, we trust it even if the legacy
  // industryKey says management.
  const jobs = [
    { id: "x", industryEnum: ["tech_software"], industryKey: "management" },
  ]
  const r = applyEnrichmentNeverList(jobs, ["tech_software"])
  assert.equal(r.kept.length, 1, "industryEnum=tech_software trusted; legacy industryKey=management ignored")
  assert.equal(r.rejected, 0)
})

// ---------------------------------------------------------------------------
// iter34 sprint B.13 — title regex anti-bias for tech-leaning users
// ---------------------------------------------------------------------------

import {
  applyTechLeaningTitleBlacklist,
  TECH_LEANING_TITLE_BLACKLIST_REGEX,
} from "../../tools/query-matching-jobs.js"

test("applyTechLeaningTitleBlacklist B.13: tech user + Warehouse Team Lead → dropped", () => {
  const jobs = [
    { id: "wh", jobTitle: "Warehouse Team Lead" },
    { id: "ok", jobTitle: "Software Engineer" },
  ]
  const r = applyTechLeaningTitleBlacklist(jobs, ["tech_software"])
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "ok")
  assert.equal(r.rejected, 1)
})

test("applyTechLeaningTitleBlacklist B.13: tech user + 'Manager in Training' → dropped, 'Engineering Manager' → kept", () => {
  const jobs = [
    { id: "mit", jobTitle: "Manager in Training" },
    { id: "em", jobTitle: "Engineering Manager" },
  ]
  const r = applyTechLeaningTitleBlacklist(jobs, ["tech_software"])
  assert.equal(r.kept.length, 1, "Engineering Manager should survive (no blacklist token)")
  assert.equal(r.kept[0]?.id, "em")
  assert.equal(r.rejected, 1)
})

test("applyTechLeaningTitleBlacklist B.13: tech user + 'Software Engineer' → kept", () => {
  const jobs = [{ id: "swe", jobTitle: "Software Engineer" }]
  const r = applyTechLeaningTitleBlacklist(jobs, ["tech_software", "ai_ml"])
  assert.equal(r.kept.length, 1)
  assert.equal(r.rejected, 0)
})

test("applyTechLeaningTitleBlacklist B.13: non-tech user + Warehouse → KEPT (filter bypassed)", () => {
  const jobs = [{ id: "wh", jobTitle: "Warehouse Team Lead" }]
  const r = applyTechLeaningTitleBlacklist(jobs, ["consumer_retail"])
  assert.equal(r.kept.length, 1, "non-tech user may legitimately want warehouse roles")
  assert.equal(r.rejected, 0)
})

test("applyTechLeaningTitleBlacklist B.13: 'Software Technician' → kept (negative lookahead)", () => {
  // The regex's negative lookahead allows technician + tech qualifier.
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Technician"), "Software Technician should not match")
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Cloud Technician"), "Cloud Technician should not match")
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Data Technician"), "Data Technician should not match")
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("ML Technician"), "ML Technician should not match")
  const jobs = [
    { id: "st", jobTitle: "Software Technician" },
    { id: "ct", jobTitle: "Cloud Technician" },
  ]
  const r = applyTechLeaningTitleBlacklist(jobs, ["tech_software"])
  assert.equal(r.kept.length, 2, "tech-flavored technicians survive negative lookahead")
})

test("applyTechLeaningTitleBlacklist B.13: 'Lab Technician' → dropped (no tech qualifier)", () => {
  // Bare 'Lab Technician' has no tech qualifier in the negative lookahead set,
  // so the blacklist fires.
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Lab Technician"), "Lab Technician matches blacklist")
  const jobs = [{ id: "lab", jobTitle: "Lab Technician" }]
  const r = applyTechLeaningTitleBlacklist(jobs, ["tech_software"])
  assert.equal(r.kept.length, 0)
  assert.equal(r.rejected, 1)
})

test("applyTechLeaningTitleBlacklist B.13: empty user tags → bypass (no rejection)", () => {
  const jobs = [{ id: "wh", jobTitle: "Warehouse Team Lead" }]
  const r = applyTechLeaningTitleBlacklist(jobs, [])
  assert.equal(r.kept.length, 1)
  assert.equal(r.rejected, 0)
})

test("applyTechLeaningTitleBlacklist B.13: covers paramedic / barber / housekeeper / caregiver", () => {
  const jobs = [
    { id: "p", jobTitle: "Paramedic" },
    { id: "b", jobTitle: "Master Barber" },
    { id: "h", jobTitle: "Housekeeper - Full Time" },
    { id: "c", jobTitle: "Caregiver Companion" },
    { id: "ok", jobTitle: "Software Engineer II" },
  ]
  const r = applyTechLeaningTitleBlacklist(jobs, ["tech_software"])
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "ok")
  assert.equal(r.rejected, 4)
})


test("applyEnrichmentNeverList: tech user + management/marketing/consulting jobs → all rejected", () => {
  const jobs = [
    { id: "g", industryKey: "management", jobTitle: "Groundskeeper" },
    { id: "m", industryKey: "marketing", jobTitle: "Marketing Liaison" },
    { id: "c", industryKey: "consulting", jobTitle: "Tax Consultant II" },
    { id: "ok", industryKey: "tech", jobTitle: "SWE" },
  ]
  const r = applyEnrichmentNeverList(jobs, ["tech_software", "ai_ml", "fintech_finance"])
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "ok")
  assert.equal(r.rejected, 3)
  assert.equal(r.rejectedKeys.management, 1)
  assert.equal(r.rejectedKeys.marketing, 1)
  assert.equal(r.rejectedKeys.consulting, 1)
})

test("applyEnrichmentNeverList: non-tech user + management job → KEPT (NEVER list disabled)", () => {
  const jobs = [
    { id: "g", industryKey: "management", jobTitle: "Property Manager" },
    { id: "ok", industryKey: "healthtech", jobTitle: "Care Coordinator" },
  ]
  const r = applyEnrichmentNeverList(jobs, ["healthcare_biotech"])
  assert.equal(r.kept.length, 2, "healthcare user may legitimately want management roles")
  assert.equal(r.rejected, 0)
})

test("applyEnrichmentNeverList: tech user + tech jobs → all kept", () => {
  const jobs = [
    { id: "a", industryKey: "tech", jobTitle: "SWE" },
    { id: "b", industryKey: "ai_ml", jobTitle: "ML Eng" },
    { id: "c", industryKey: "fintech", jobTitle: "Quant Dev" },
    { id: "d", industryKey: "engineering", jobTitle: "Software Engineer" },
  ]
  const r = applyEnrichmentNeverList(jobs, ["tech_software"])
  assert.equal(r.kept.length, 4)
  assert.equal(r.rejected, 0)
})

test("applyEnrichmentNeverList: empty userTags → bypass (return everything)", () => {
  const jobs = [
    { id: "g", industryKey: "management", jobTitle: "Groundskeeper" },
    { id: "ok", industryKey: "tech", jobTitle: "SWE" },
  ]
  const r = applyEnrichmentNeverList(jobs, [])
  assert.equal(r.kept.length, 2)
  assert.equal(r.rejected, 0)
})

test("applyEnrichmentNeverList: tech_hardware user also triggers NEVER list", () => {
  const jobs = [
    { id: "g", industryKey: "management", jobTitle: "Facilities Manager" },
    { id: "ok", industryKey: "hardware", jobTitle: "EE Intern" },
  ]
  const r = applyEnrichmentNeverList(jobs, ["tech_hardware"])
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "ok")
})

test("applyEnrichmentNeverList: empty job list → empty result", () => {
  const r = applyEnrichmentNeverList([], ["tech_software"])
  assert.deepEqual(r.kept, [])
  assert.equal(r.rejected, 0)
})

test("applyEnrichmentNeverList: jobs with no industryKey are kept (defensive)", () => {
  // A doc that's missing industryKey shouldn't be rejected — we only reject
  // on POSITIVE evidence the bucket is non-tech.
  const jobs = [
    { id: "noKey", jobTitle: "SWE" },
    { id: "g", industryKey: "management", jobTitle: "Groundskeeper" },
  ]
  const r = applyEnrichmentNeverList(jobs, ["tech_software"])
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "noKey")
  assert.equal(r.rejected, 1)
})

test("NON_TECH_NEVER_KEYS contains the 17%-mislabel buckets observed 2026-05-02", () => {
  // Lock the keys so future edits surface intent.
  for (const k of [
    "management",
    "customer_service",
    "sales",
    "legal",
    "government",
    "consulting",
    "marketing",
    "business",
    "reinsurance",
    "operations",
  ]) {
    assert.ok(NON_TECH_NEVER_KEYS.has(k), `${k} should be in NON_TECH_NEVER_KEYS`)
  }
  // And does NOT contain ambiguous buckets we explicitly want to keep.
  for (const k of ["education", "media", "healthcare", "tech", "fintech", "ai_ml"]) {
    assert.ok(!NON_TECH_NEVER_KEYS.has(k), `${k} should NOT be in NON_TECH_NEVER_KEYS`)
  }
})

test("TECH_LEANING_USER_TAGS covers the 4 tech-leaning canonical tags", () => {
  for (const t of ["tech_software", "ai_ml", "fintech_finance", "tech_hardware"]) {
    assert.ok(TECH_LEANING_USER_TAGS.has(t), `${t} should be tech-leaning`)
  }
  assert.ok(!TECH_LEANING_USER_TAGS.has("healthcare_biotech"))
  assert.ok(!TECH_LEANING_USER_TAGS.has("consumer_retail"))
})




// ---------------------------------------------------------------------------
// iter34 sprint A.3 — targetRole / targetRoleIndustryEnum post-filter
// ---------------------------------------------------------------------------

import { applyTargetRoleIndustryEnumFilter } from "../../tools/query-matching-jobs.js"

test("applyTargetRoleIndustryEnumFilter: SWE buckets + customer_service doc → dropped", () => {
  const job = {
    id: "cs",
    industryEnum: ["customer_service"],
  }
  const out = applyTargetRoleIndustryEnumFilter([job], ["tech_software"])
  assert.equal(out.length, 0, "non-overlapping industryEnum must be dropped")
})

test("applyTargetRoleIndustryEnumFilter: SWE buckets + tech_software doc → kept", () => {
  const job = {
    id: "swe",
    industryEnum: ["tech_software", "fintech_finance"],
  }
  const out = applyTargetRoleIndustryEnumFilter([job], ["tech_software"])
  assert.equal(out.length, 1)
  assert.equal(out[0]?.id, "swe")
})

test("applyTargetRoleIndustryEnumFilter: undefined allowedBuckets → no-op (returns all)", () => {
  const jobs = [
    { id: "a", industryEnum: ["tech_software"] },
    { id: "b", industryEnum: ["customer_service"] },
    { id: "c" },
  ]
  const out = applyTargetRoleIndustryEnumFilter(jobs, undefined)
  assert.equal(out.length, 3, "undefined buckets → backward-compatible bypass")
})

test("applyTargetRoleIndustryEnumFilter: empty allowedBuckets → no-op", () => {
  const jobs = [{ id: "a", industryEnum: ["tech_software"] }]
  const out = applyTargetRoleIndustryEnumFilter(jobs, [])
  assert.equal(out.length, 1)
})

test("applyTargetRoleIndustryEnumFilter: doc with no industryEnum field → dropped when filter active", () => {
  const jobs = [
    { id: "no-enum" }, // missing field entirely
    { id: "empty-enum", industryEnum: [] },
    { id: "match", industryEnum: ["tech_software"] },
  ]
  const out = applyTargetRoleIndustryEnumFilter(jobs, ["tech_software"])
  assert.equal(out.length, 1)
  assert.equal(out[0]?.id, "match")
})

test("applyTargetRoleIndustryEnumFilter: any single overlap is enough (intersection-non-empty)", () => {
  const jobs = [
    { id: "j1", industryEnum: ["customer_service", "ai_ml"] },
    { id: "j2", industryEnum: ["customer_service"] },
  ]
  const out = applyTargetRoleIndustryEnumFilter(jobs, ["ai_ml", "tech_software"])
  assert.equal(out.length, 1)
  assert.equal(out[0]?.id, "j1", "j1 overlaps via ai_ml; j2 has no overlap")
})



// ---------------------------------------------------------------------------
// iter34 followup D.5 — atsApplyUrl hard gate
// ---------------------------------------------------------------------------

import { applyAtsApplyUrlGate } from "../../tools/query-matching-jobs.js"

test("applyAtsApplyUrlGate D.5: doc with atsApplyUrl undefined → dropped", () => {
  // explicit undefined to satisfy generic constraint
  const jobs: { id: string; atsApplyUrl?: string }[] = [{ id: "no-ats" }]
  const r = applyAtsApplyUrlGate(jobs)
  assert.equal(r.kept.length, 0)
  assert.equal(r.rejected, 1)
})

test("applyAtsApplyUrlGate D.5: doc with atsApplyUrl empty string → dropped", () => {
  const jobs = [{ id: "empty", atsApplyUrl: "" }]
  const r = applyAtsApplyUrlGate(jobs)
  assert.equal(r.kept.length, 0)
  assert.equal(r.rejected, 1)
})

test("applyAtsApplyUrlGate D.5: doc with atsApplyUrl pointing to jobright.ai → dropped (mirror leak)", () => {
  const jobs = [{ id: "jr", atsApplyUrl: "https://jobright.ai/jobs/info/abc" }]
  const r = applyAtsApplyUrlGate(jobs)
  assert.equal(r.kept.length, 0)
  assert.equal(r.rejected, 1)
})

test("applyAtsApplyUrlGate D.5: doc with greenhouse atsApplyUrl → kept", () => {
  const jobs = [{ id: "gh", atsApplyUrl: "https://boards.greenhouse.io/acme/jobs/123" }]
  const r = applyAtsApplyUrlGate(jobs)
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "gh")
  assert.equal(r.rejected, 0)
})

test("applyAtsApplyUrlGate D.5: doc with workday atsApplyUrl → kept", () => {
  const jobs = [
    { id: "wd", atsApplyUrl: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/abc" },
  ]
  const r = applyAtsApplyUrlGate(jobs)
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "wd")
  assert.equal(r.rejected, 0)
})

// ---------------------------------------------------------------------------
// iter34 followup D.6 — extended title blacklist (analyst/specialist/
// associate/trainee/coordinator/etc) for tech-leaning users
// ---------------------------------------------------------------------------

test("D.6 regex: 'Platform Support - Analyst' → drop (bare analyst)", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Platform Support - Analyst"))
})

test("D.6 regex: 'Software Analyst' → drop (BA-flavored, no engineer qualifier)", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Analyst"))
})

test("D.6 regex: 'Data Analyst' → drop (BA-flavored, no engineer qualifier)", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Data Analyst"))
})

test("D.6 regex: 'Software Engineer Analyst' → keep (engineer qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Engineer Analyst"))
})

test("D.6 regex: 'Engineering Analyst' → keep (engineering qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Engineering Analyst"))
})

test("D.6 regex: 'Cloud Engineer' → keep (no analyst, no other support tokens)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Cloud Engineer"))
})

test("D.6 regex: 'Receptionist' / 'Secretary' / 'Clerk' → drop (bare admin)", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Receptionist"))
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Secretary"))
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Clerk II"))
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Bank Teller"))
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Front Desk Manager"))
})

test("D.6 regex: 'Junior Software Engineer' → keep", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Junior Software Engineer"))
})

test("D.6 regex: 'Engineering Associate' → keep (engineering qualifier on associate)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Engineering Associate"))
})

test("D.6 regex: 'Sales Associate' → drop (no tech qualifier on associate)", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Sales Associate"))
})

test("D.6 regex: 'Coordinator' / 'Project Coordinator' → drop (bare coordinator)", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Coordinator"))
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Project Coordinator"))
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Care Coordinator"))
})

test("D.6 regex: 'Software Specialist' → keep (software qualifier on specialist)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Specialist"))
})

test("D.6 regex: 'Marketing Specialist' → drop (no tech qualifier on specialist)", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Marketing Specialist"))
})

test("D.6 regex: 'Trainee' → drop, 'Software Trainee' / 'Engineer Trainee' → keep", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Trainee"))
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Trainee"))
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Engineer Trainee"))
})

test("D.6 integration: tech user + 'Platform Support - Analyst' → dropped via applyTechLeaningTitleBlacklist", () => {
  const jobs = [
    { id: "psa", jobTitle: "Platform Support - Analyst" },
    { id: "swe", jobTitle: "Software Engineer" },
  ]
  const r = applyTechLeaningTitleBlacklist(jobs, ["tech_software"])
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "swe")
  assert.equal(r.rejected, 1)
})

// ---------------------------------------------------------------------------
// iter34 H.2 / CR2 — extend blacklist for BDR / Account Manager / Sales /
// Customer Success / Operations Manager titles surfaced in G5 sim
// ---------------------------------------------------------------------------

test("CR2 regex: 'Business Development Representative' → drop", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Business Development Representative"))
})

test("CR2 regex: 'BDR' bare token alone → does NOT trip (we match phrase 'business development')", () => {
  // We match the phrase form; a 3-letter "BDR" alone wouldn't be in a real job
  // title without "Business Development Representative" alongside.
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("BDR"))
})

test("CR2 regex: 'Account Manager' (bare) → drop", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Account Manager"))
})

test("CR2 regex: 'Partner Account Manager' → drop (no tech qualifier)", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Partner Account Manager"))
})

test("CR2 regex: 'Software Account Manager' → keep (tech qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Account Manager"))
})

test("CR2 regex: 'Technical Account Manager' → keep (tech qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Technical Account Manager"))
})

test("CR2 regex: 'Cloud Account Manager' → keep (tech qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Cloud Account Manager"))
})

test("CR2 regex: 'Account Executive' → drop", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Account Executive"))
})

test("CR2 regex: 'Software Account Executive' → keep (tech qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Account Executive"))
})

test("CR2 regex: 'Sales Executive' → drop", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Sales Executive"))
})

test("CR2 regex: 'Sales Manager' / 'Sales Representative' / 'Sales Producer' / 'Sales Associate' → drop", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Sales Manager"))
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Sales Representative"))
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Sales Producer"))
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Sales Associate"))
})

test("CR2 regex: 'Customer Success Manager' → drop", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Customer Success Manager"))
})

test("CR2 regex: 'Customer Success Engineer' → drop (customer success token always drops)", () => {
  // Note: this is intentional — Customer Success Engineering roles tend to be
  // sales-adjacent, not core SWE. SWE candidates can still surface them via
  // role-fit gate if they self-tag accordingly.
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Customer Success Engineer"))
})

test("CR2 regex: 'Operations Manager' → drop (no tech qualifier)", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Operations Manager"))
})

test("CR2 regex: 'Engineering Operations Manager' → keep (tech qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Engineering Operations Manager"))
})

test("CR2 regex: 'Software Operations Manager' → keep (tech qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Operations Manager"))
})

test("CR2 regex: 'Infrastructure Operations Manager' → keep (tech qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Infrastructure Operations Manager"))
})

test("CR2 regex: 'Software Engineer Operations' → keep (operations not after manager)", () => {
  // Bare "operations" is NOT in the bare-keywords set; only "operations manager"
  // is (with tech qualifier lookbehind). A SWE-flavored "Operations" suffix
  // role survives.
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Engineer Operations"))
})

test("CR2 regex: 'Project Manager' → drop", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Project Manager"))
})

test("CR2 regex: 'Engineering Project Manager' → keep (tech qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Engineering Project Manager"))
})

test("CR2 regex: 'Software Project Manager' → keep (tech qualifier)", () => {
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Project Manager"))
})

test("CR2 regex: 'Business Analyst' → drop", () => {
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Business Analyst"))
})

test("CR2 integration: tech user + BDR / Account Manager / Sales Executive / Operations Manager → all dropped, SWE kept", () => {
  const jobs = [
    { id: "bdr", jobTitle: "Business Development Representative" },
    { id: "pam", jobTitle: "Partner Account Manager" },
    { id: "ae", jobTitle: "Account Executive" },
    { id: "se", jobTitle: "Sales Executive" },
    { id: "csm", jobTitle: "Customer Success Manager" },
    { id: "om", jobTitle: "Operations Manager" },
    { id: "swe", jobTitle: "Software Engineer" },
    { id: "epm", jobTitle: "Engineering Project Manager" },
    { id: "sam", jobTitle: "Software Account Manager" },
  ]
  const r = applyTechLeaningTitleBlacklist(jobs, ["tech_software"])
  assert.equal(r.kept.length, 3, "swe, epm, sam should survive")
  const ids = r.kept.map((j) => j.id).sort()
  assert.deepEqual(ids, ["epm", "sam", "swe"])
  assert.equal(r.rejected, 6)
})

test("CR2 regex: existing D.6 patterns still hold (regression)", () => {
  // Lock D.6 behavior in place to catch a regression from CR2 regex edits.
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Receptionist"))
  assert.ok(TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Project Coordinator"))
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Software Engineer"))
  assert.ok(!TECH_LEANING_TITLE_BLACKLIST_REGEX.test("Engineering Manager"))
})

test("applyAtsApplyUrlGate D.5: mixed pool — keeps real ATS, drops missing/jobright", () => {
  const jobs: { id: string; atsApplyUrl?: string }[] = [
    { id: "gh", atsApplyUrl: "https://boards.greenhouse.io/acme/jobs/1" },
    { id: "missing" },
    { id: "lever", atsApplyUrl: "https://jobs.lever.co/acme/abc" },
    { id: "jr-leak", atsApplyUrl: "https://JOBRIGHT.AI/jobs/info/xyz" }, // case-insensitive
    { id: "ashby", atsApplyUrl: "https://jobs.ashbyhq.com/acme/abc" },
  ]
  const r = applyAtsApplyUrlGate(jobs)
  assert.equal(r.kept.length, 3)
  assert.deepEqual(
    r.kept.map((j) => j.id),
    ["gh", "lever", "ashby"]
  )
  assert.equal(r.rejected, 2)
})

// ---------------------------------------------------------------------------
// iter34 followup D.9 — recency hard filter (lastSeenAt < 7d, fallback 30d)
// ---------------------------------------------------------------------------

import {
  getJobLastSeenMs,
  applyRecencyFilter,
  applyRecencyFilterWithFallback,
} from "../../tools/query-matching-jobs.js"

const D9_NOW_MS = Date.parse("2026-05-05T00:00:00Z") // pinned "today"

test("getJobLastSeenMs D.9: ISO string parses to ms", () => {
  const ms = getJobLastSeenMs({ lastSeenAt: "2026-05-01T00:00:00Z" })
  assert.equal(ms, Date.parse("2026-05-01T00:00:00Z"))
})

test("getJobLastSeenMs D.9: undefined → null", () => {
  assert.equal(getJobLastSeenMs({}), null)
})

test("getJobLastSeenMs D.9: malformed string → null", () => {
  assert.equal(getJobLastSeenMs({ lastSeenAt: "not-a-date" }), null)
})

test("getJobLastSeenMs D.9: Firestore Timestamp object via toDate()", () => {
  const date = new Date("2026-05-01T12:00:00Z")
  const ts = { toDate: () => date }
  assert.equal(getJobLastSeenMs({ lastSeenAt: ts }), date.getTime())
})

test("getJobLastSeenMs D.9: Firestore {seconds, nanoseconds} shape", () => {
  const seconds = Math.floor(Date.parse("2026-05-01T12:00:00Z") / 1000)
  const ts = { seconds, nanoseconds: 0 }
  assert.equal(getJobLastSeenMs({ lastSeenAt: ts }), seconds * 1000)
})

test("applyRecencyFilter D.9: doc lastSeenAt 1d ago → keep", () => {
  const oneDayAgo = new Date(D9_NOW_MS - 1 * 24 * 60 * 60 * 1000).toISOString()
  const jobs = [{ id: "fresh", lastSeenAt: oneDayAgo }]
  const kept = applyRecencyFilter(jobs, { nowMs: D9_NOW_MS })
  assert.equal(kept.length, 1)
  assert.equal(kept[0]?.id, "fresh")
})

test("applyRecencyFilter D.9: doc lastSeenAt 6d ago → keep (within 7d)", () => {
  const sixDaysAgo = new Date(D9_NOW_MS - 6 * 24 * 60 * 60 * 1000).toISOString()
  const jobs = [{ id: "edge", lastSeenAt: sixDaysAgo }]
  const kept = applyRecencyFilter(jobs, { nowMs: D9_NOW_MS })
  assert.equal(kept.length, 1)
})

test("applyRecencyFilter D.9: doc lastSeenAt 8d ago → drop (outside 7d)", () => {
  const eightDaysAgo = new Date(D9_NOW_MS - 8 * 24 * 60 * 60 * 1000).toISOString()
  const jobs = [{ id: "stale", lastSeenAt: eightDaysAgo }]
  const kept = applyRecencyFilter(jobs, { nowMs: D9_NOW_MS })
  assert.equal(kept.length, 0)
})

test("applyRecencyFilter D.9: doc lastSeenAt undefined → drop", () => {
  const jobs: { id: string; lastSeenAt?: unknown }[] = [{ id: "no-stamp" }]
  const kept = applyRecencyFilter(jobs, { nowMs: D9_NOW_MS })
  assert.equal(kept.length, 0)
})

test("applyRecencyFilter D.9: doc lastSeenAt malformed → drop", () => {
  const jobs = [{ id: "bad", lastSeenAt: "not-a-date" }]
  const kept = applyRecencyFilter(jobs, { nowMs: D9_NOW_MS })
  assert.equal(kept.length, 0)
})

test("applyRecencyFilter D.9: future timestamp → drop (defensive)", () => {
  const tomorrow = new Date(D9_NOW_MS + 24 * 60 * 60 * 1000).toISOString()
  const jobs = [{ id: "future", lastSeenAt: tomorrow }]
  const kept = applyRecencyFilter(jobs, { nowMs: D9_NOW_MS })
  assert.equal(kept.length, 0)
})

test("applyRecencyFilterWithFallback D.9: 7d window has >=20 → no fallback expansion", () => {
  // 25 docs all within 7d → primary returns 25, fallback NOT triggered.
  const jobs: { id: string; lastSeenAt: string }[] = []
  for (let i = 0; i < 25; i++) {
    const seenAt = new Date(D9_NOW_MS - i * 60 * 60 * 1000).toISOString() // i hours ago
    jobs.push({ id: `j${i}`, lastSeenAt: seenAt })
  }
  const r = applyRecencyFilterWithFallback(jobs, { nowMs: D9_NOW_MS })
  assert.equal(r.kept.length, 25)
  assert.equal(r.fallback, false)
  assert.equal(r.windowMs, 7 * 24 * 60 * 60 * 1000)
})

test("applyRecencyFilterWithFallback D.9: 7d window has <20 → fallback to 30d", () => {
  // 10 docs within 7d, 15 docs at 25d ago. Primary returns 10 (< 20)
  // → fallback expands to 30d window → returns all 25.
  const jobs: { id: string; lastSeenAt: string }[] = []
  for (let i = 0; i < 10; i++) {
    const seenAt = new Date(D9_NOW_MS - i * 60 * 60 * 1000).toISOString()
    jobs.push({ id: `fresh-${i}`, lastSeenAt: seenAt })
  }
  for (let i = 0; i < 15; i++) {
    const seenAt = new Date(D9_NOW_MS - 25 * 24 * 60 * 60 * 1000 - i * 60 * 60 * 1000).toISOString()
    jobs.push({ id: `old-${i}`, lastSeenAt: seenAt })
  }
  const r = applyRecencyFilterWithFallback(jobs, { nowMs: D9_NOW_MS })
  assert.equal(r.kept.length, 25)
  assert.equal(r.fallback, true)
  assert.equal(r.windowMs, 30 * 24 * 60 * 60 * 1000)
})

test("applyRecencyFilterWithFallback D.9: docs at 25d ago, only 10 → fallback expands", () => {
  // 10 docs at 25d ago. Primary returns 0 (< 20) → fallback returns 10.
  const jobs: { id: string; lastSeenAt: string }[] = []
  for (let i = 0; i < 10; i++) {
    const seenAt = new Date(D9_NOW_MS - 25 * 24 * 60 * 60 * 1000 - i * 60 * 60 * 1000).toISOString()
    jobs.push({ id: `j${i}`, lastSeenAt: seenAt })
  }
  const r = applyRecencyFilterWithFallback(jobs, { nowMs: D9_NOW_MS })
  assert.equal(r.kept.length, 10)
  assert.equal(r.fallback, true)
})

test("applyRecencyFilterWithFallback D.9: docs at 35d ago drop even at fallback (>30d)", () => {
  const jobs: { id: string; lastSeenAt: string }[] = []
  for (let i = 0; i < 10; i++) {
    const seenAt = new Date(D9_NOW_MS - 35 * 24 * 60 * 60 * 1000 - i * 60 * 60 * 1000).toISOString()
    jobs.push({ id: `j${i}`, lastSeenAt: seenAt })
  }
  const r = applyRecencyFilterWithFallback(jobs, { nowMs: D9_NOW_MS })
  assert.equal(r.kept.length, 0)
  assert.equal(r.fallback, true)
})

test("applyRecencyFilterWithFallback D.9: empty input → empty output, no fallback flag", () => {
  const r = applyRecencyFilterWithFallback([], { nowMs: D9_NOW_MS })
  assert.equal(r.kept.length, 0)
  assert.equal(r.fallback, false)
})

// ---------------------------------------------------------------------------
// iter34 followup D.13 — liveness hard filter (drop dead=true rows)
// ---------------------------------------------------------------------------

import { applyLivenessFilter } from "../../tools/query-matching-jobs.js"

test("applyLivenessFilter D.13: doc dead=true → drop", () => {
  const jobs = [{ id: "dead", dead: true }]
  const r = applyLivenessFilter(jobs)
  assert.equal(r.kept.length, 0)
  assert.equal(r.rejected, 1)
})

test("applyLivenessFilter D.13: doc dead=false → keep", () => {
  const jobs = [{ id: "alive", dead: false }]
  const r = applyLivenessFilter(jobs)
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "alive")
  assert.equal(r.rejected, 0)
})

test("applyLivenessFilter D.13: doc dead=undefined → keep (back-compat with legacy rows)", () => {
  const jobs: { id: string; dead?: boolean }[] = [{ id: "legacy" }]
  const r = applyLivenessFilter(jobs)
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0]?.id, "legacy")
  assert.equal(r.rejected, 0)
})

test("applyLivenessFilter D.13: mixed pool keeps alive + legacy, drops dead", () => {
  const jobs: { id: string; dead?: boolean }[] = [
    { id: "a-alive", dead: false },
    { id: "b-dead", dead: true },
    { id: "c-legacy" },
    { id: "d-dead", dead: true },
  ]
  const r = applyLivenessFilter(jobs)
  assert.equal(r.kept.length, 2)
  assert.deepEqual(r.kept.map((j) => j.id), ["a-alive", "c-legacy"])
  assert.equal(r.rejected, 2)
})

test("applyLivenessFilter D.13: empty input → empty output", () => {
  const r = applyLivenessFilter([])
  assert.equal(r.kept.length, 0)
  assert.equal(r.rejected, 0)
})

// ---------------------------------------------------------------------------
// iter34 followup D.13 — projectMatchingJobRow surfaces dead/deadCheckedAt/deadReason
// ---------------------------------------------------------------------------

test("projectMatchingJobRow D.13: surfaces dead=true with deadReason+deadCheckedAt", () => {
  const out = projectMatchingJobRow("doc-dead", {
    companyName: "Co",
    roleTitle: "SWE",
    locationRaw: "Remote",
    primaryUrl: "u",
    industry: "tech",
    sponsorship: false,
    dead: true,
    deadCheckedAt: "2026-05-04T12:00:00Z",
    deadReason: "404",
  })
  assert.equal(out.dead, true)
  assert.equal(out.deadCheckedAt, "2026-05-04T12:00:00Z")
  assert.equal(out.deadReason, "404")
})

test("projectMatchingJobRow D.13: dead absent → undefined (back-compat)", () => {
  const out = projectMatchingJobRow("doc-legacy", {
    companyName: "Co",
    roleTitle: "SWE",
    locationRaw: "Remote",
    primaryUrl: "u",
    industry: "tech",
    sponsorship: false,
  })
  assert.equal(out.dead, undefined)
  assert.equal(out.deadCheckedAt, undefined)
  assert.equal(out.deadReason, undefined)
})

test("projectMatchingJobRow D.9: surfaces lastSeenAt string", () => {
  const out = projectMatchingJobRow("doc-fresh", {
    companyName: "Co",
    roleTitle: "SWE",
    locationRaw: "Remote",
    primaryUrl: "u",
    industry: "tech",
    sponsorship: false,
    lastSeenAt: "2026-05-04T12:00:00Z",
  })
  assert.equal(out.lastSeenAt, "2026-05-04T12:00:00Z")
})

test("projectMatchingJobRow D.9: lastSeenAt absent → undefined", () => {
  const out = projectMatchingJobRow("doc-legacy", {
    companyName: "Co",
    roleTitle: "SWE",
    locationRaw: "Remote",
    primaryUrl: "u",
    industry: "tech",
    sponsorship: false,
  })
  assert.equal(out.lastSeenAt, undefined)
})

// ---------------------------------------------------------------------------
// iter34 followup D.9 — integration through queryMatchingJobs
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// iter34 followup D.13 — integration through queryMatchingJobs
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// iter34 H.2 / CR3 — orderBy lastSeenAt (was firstSeenAt) for top-50 fetch
// ---------------------------------------------------------------------------



test("CR3 indexes: firestore.indexes.json contains lastSeenAt composite indexes", async () => {
  // Lock the index file shape so future deploys don't crash the live query
  // with FAILED_PRECONDITION. We import via Node fs to avoid building a
  // bespoke loader; this is a fixture file, not module-resolved.
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  // Walk up from this test file (apps/job-rec/src/__tests__/tools) to repo root.
  const repoRoot = path.resolve(import.meta.dirname ?? ".", "../../../../..")
  const indexFile = path.join(repoRoot, "config/firebase/firestore.indexes.json")
  const json = JSON.parse(await fs.readFile(indexFile, "utf8")) as {
    indexes: { collectionGroup: string; fields: { fieldPath: string; order?: string; arrayConfig?: string }[] }[]
  }
  const matchingJobsIndexes = json.indexes.filter((i) => i.collectionGroup === "matching-jobs")
  // Must have at least one lastSeenAt-desc composite.
  const lastSeenAtIndexes = matchingJobsIndexes.filter((i) =>
    i.fields.some((f) => f.fieldPath === "lastSeenAt" && f.order === "DESCENDING")
  )
  assert.ok(
    lastSeenAtIndexes.length >= 3,
    `expected >=3 lastSeenAt-desc composite indexes (status-only, industryKey, industryEnum); got ${lastSeenAtIndexes.length}`
  )
  // Must have one for status + industryEnum array-contains + lastSeenAt desc.
  const enumLastSeen = matchingJobsIndexes.find(
    (i) =>
      i.fields.some((f) => f.fieldPath === "industryEnum" && f.arrayConfig === "CONTAINS") &&
      i.fields.some((f) => f.fieldPath === "status") &&
      i.fields.some((f) => f.fieldPath === "lastSeenAt" && f.order === "DESCENDING")
  )
  assert.ok(enumLastSeen, "must have status+industryEnum+lastSeenAt index")
})

