import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../mock-firestore.js"
import {
  jaccardOverlap,
  scoreJob,
  rankJobs,
  projectMatchingJobRow,
  queryMatchingJobs,
  mapTagToIndustryKeys,
  expandIndustryTags,
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
    industry: "tech",
    sponsorship: true,
    requiredSkills: ["python"],
  }
  const noSponsor = scoreJob(job, { sponsorship: "none", userSkills: ["python"] })
  const wantSponsor = scoreJob(job, { sponsorship: "h1b", userSkills: ["python"] })
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
    industry: "tech",
    sponsorship: null,
  }
  const above = scoreJob(job, { salaryMin: 100000 })
  const below = scoreJob(job, { salaryMin: 300000 })
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
    industry: "tech",
    sponsorship: null,
  }
  const match = scoreJob(j, { location: "san francisco" })
  const miss = scoreJob(j, { location: "boston" })
  assert.ok(match > miss)
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
    industry: "tech",
    sponsorship: null,
    firstSeenAt: "2026-01-01",
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
    industry: "tech",
    sponsorship: false,
  })
  assert.equal(out.jobTitle, "SWE II")
  assert.equal(out.companyName, "Co")
})

test("projectMatchingJobRow: defends against missing fields", () => {
  const out = projectMatchingJobRow("doc1", {})
  assert.equal(out.companyName, "")
  assert.equal(out.salaryMax, null)
  assert.equal(out.requiredSkills, undefined)
})

test("queryMatchingJobs: returns top-N from active corpus", async () => {
  const mfs = new MockFirestore()
  for (let i = 0; i < 3; i++) {
    await mfs.collection("matching-jobs").doc(`j${i}`).set({
      status: "active",
      industryKey: "tech",
      companyName: `Co${i}`,
      roleTitle: "SWE",
      salaryMax: 100000 + i * 10000,
      locationRaw: "NYC",
      primaryUrl: `https://x/${i}`,
      industry: "tech",
      sponsorship: false,
      requiredSkills: ["python"],
      firstSeenAt: `2026-04-${String(28 - i).padStart(2, "0")}`,
    })
  }
  const out = await queryMatchingJobs(
    { filters: { industry: "tech", userSkills: ["python"] }, limit: 2 },
    { db: asFirestore(mfs) }
  )
  assert.equal(out.jobs.length, 2)
  // newest first (j0 has firstSeenAt 2026-04-28)
  assert.equal(out.jobs[0]?.id, "j0")
})

test("queryMatchingJobs: hard-filters out sponsorship=true when user wants none", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("matching-jobs").doc("a").set({
    status: "active",
    companyName: "A",
    roleTitle: "SWE",
    salaryMax: null,
    locationRaw: "NYC",
    primaryUrl: "https://a",
    industry: "tech",
    industryKey: "tech",
    sponsorship: true,
    firstSeenAt: "2026-04-30",
  })
  await mfs.collection("matching-jobs").doc("b").set({
    status: "active",
    companyName: "B",
    roleTitle: "SWE",
    salaryMax: null,
    locationRaw: "NYC",
    primaryUrl: "https://b",
    industry: "tech",
    industryKey: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-29",
  })
  const out = await queryMatchingJobs(
    { filters: { industry: "tech", sponsorship: "none" }, limit: 5 },
    { db: asFirestore(mfs) }
  )
  assert.equal(out.jobs.length, 1)
  assert.equal(out.jobs[0]?.id, "b")
})

test("queryMatchingJobs: ignores industry filter when industry == any", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("matching-jobs").doc("a").set({
    status: "active",
    companyName: "A",
    roleTitle: "SWE",
    salaryMax: null,
    locationRaw: "NYC",
    primaryUrl: "https://a",
    industry: "fintech",
    industryKey: "fintech",
    sponsorship: null,
    firstSeenAt: "2026-04-30",
  })
  const out = await queryMatchingJobs(
    { filters: { industry: "any" }, limit: 5 },
    { db: asFirestore(mfs) }
  )
  assert.equal(out.jobs.length, 1)
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

test("queryMatchingJobs: industryTags filter uses industryKey 'in' path and matches multiple corpus keys", async () => {
  const mfs = new MockFirestore()
  // Three rows spanning different industryKey values — only those reachable
  // via the tech_software/ai_ml tag union should be returned.
  await mfs.collection("matching-jobs").doc("a").set({
    status: "active",
    companyName: "AICo",
    roleTitle: "ML Eng",
    salaryMax: 200000,
    locationRaw: "Baltimore, MD",
    primaryUrl: "https://a",
    industry: "ai_ml",
    industryKey: "ai_ml", // hits ai_ml expansion
    sponsorship: false,
    requiredSkills: ["python", "ml"],
    firstSeenAt: "2026-04-30",
  })
  await mfs.collection("matching-jobs").doc("b").set({
    status: "active",
    companyName: "TechCo",
    roleTitle: "SWE",
    salaryMax: 180000,
    locationRaw: "Remote",
    primaryUrl: "https://b",
    industry: "tech",
    industryKey: "tech", // hits tech_software expansion
    sponsorship: false,
    requiredSkills: ["python"],
    firstSeenAt: "2026-04-29",
  })
  await mfs.collection("matching-jobs").doc("c").set({
    status: "active",
    companyName: "MarketingCo",
    roleTitle: "Marketing Mgr",
    salaryMax: 120000,
    locationRaw: "Anywhere",
    primaryUrl: "https://c",
    industry: "marketing",
    industryKey: "marketing", // NOT in tech_software/ai_ml expansion
    sponsorship: false,
    firstSeenAt: "2026-04-28",
  })
  const out = await queryMatchingJobs(
    {
      filters: {
        industryTags: ["tech_software", "ai_ml"],
        sponsorship: "h1b",
        userSkills: ["python"],
      },
      limit: 5,
    },
    { db: asFirestore(mfs) }
  )
  const ids = new Set(out.jobs.map((j) => j.id))
  assert.ok(ids.has("a"), "ai_ml row should be returned")
  assert.ok(ids.has("b"), "tech row should be returned")
  assert.ok(!ids.has("c"), "marketing row should be filtered OUT by industryKey-in")
})
