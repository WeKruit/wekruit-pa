import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import {
  formatJobLine,
  formatBatchMessage,
  runDailyJobRecBatch,
} from "../daily-batch.js"
import type { MatchingJob } from "../types.js"

test("formatJobLine: bare URL on its own line (Bible v7.5.2)", () => {
  const j: MatchingJob = {
    id: "j1",
    companyName: "Acme",
    jobTitle: "Senior SWE",
    salaryMax: 250000,
    salaryMin: null,
    locationRaw: "San Francisco, CA",
    primaryUrl: "https://jobs.example.com/j1",
    industry: "tech",
    sponsorship: null,
  }
  const line = formatJobLine(j)
  const lines = line.split("\n")
  assert.equal(lines.length, 2)
  // URL must be bare (no markdown, no surrounding chars)
  assert.equal(lines[1], "https://jobs.example.com/j1")
  // Title-co block must mention salary in $k form
  assert.match(lines[0]!, /\$250k/)
})

test("formatJobLine: omits salary when salaryMax is null", () => {
  const j: MatchingJob = {
    id: "j1",
    companyName: "Acme",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "Remote",
    primaryUrl: "https://x",
    industry: "tech",
    sponsorship: null,
  }
  const line = formatJobLine(j)
  assert.doesNotMatch(line, /\$/)
})

test("formatBatchMessage: empty input -> empty string", () => {
  assert.equal(formatBatchMessage([]), "")
})

test("formatBatchMessage: lead-in adapts to count", () => {
  const j = (id: string): MatchingJob => ({
    id,
    companyName: "X",
    jobTitle: "T",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "",
    primaryUrl: `https://x/${id}`,
    industry: "tech",
    sponsorship: null,
  })
  const one = formatBatchMessage([j("a")])
  const three = formatBatchMessage([j("a"), j("b"), j("c")])
  assert.match(one, /1 个/)
  assert.match(three, /3 个/)
})

test("runDailyJobRecBatch: skips users when feature flag is OFF", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => false,
    todayYmd: () => "20260430",
  })
  assert.equal(out.skippedFlag, 1)
  assert.equal(out.delivered, 0)
})

test("runDailyJobRecBatch: delivers when flag ON + jobs available + writes lastJobBatchSentAt", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u1").set({ phoneE164: "+15551112222" })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    companyName: "Acme",
    roleTitle: "SWE",
    salaryMax: 200000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 1)
  assert.equal(out.skippedFlag, 0)
  // lastJobBatchSentAt should be merged onto the profile
  const profile = (await mfs.collection("pa-job-profiles").doc("u1").get()).data()
  assert.ok(profile?.lastJobBatchSentAt)
  // pa-outbound write went out
  const outboundWrites = mfs.writeLog.filter((w) => w.path === "pa-outbound")
  assert.equal(outboundWrites.length, 1)
})

test("runDailyJobRecBatch: skipped_no_jobs when corpus empty for filters", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u1").set({ phoneE164: "+15551112222" })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "fintech", sponsorship: "none", location: "Mars", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
  })
  assert.equal(out.skippedNoJobs, 1)
  assert.equal(out.delivered, 0)
})

test("runDailyJobRecBatch: idempotency key includes YYYYMMDD", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u1").set({ phoneE164: "+15551112222" })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "Remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    companyName: "Co",
    roleTitle: "SWE",
    salaryMax: null,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
  })
  await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  const w = mfs.writeLog.filter((w) => w.path === "pa-outbound")[0]
  assert.equal(w?.data.idempotencyKey, "u1-20260430-batch")
})

test("runDailyJobRecBatch: filters out non-active profile statuses", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "Remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "paused",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
  })
  assert.equal(out.total, 0)
  assert.equal(out.delivered, 0)
})

// ---------------- Stream F5 — new-shape profile + cosine + rerank ----------------

import { normalizeJobProfile, cosineSimilarity } from "../daily-batch.js"

test("Stream F5: normalizeJobProfile accepts legacy shape verbatim", () => {
  const out = normalizeJobProfile({
    industry: "tech",
    sponsorship: "h1b",
    location: "SF",
    sizePreference: "either",
    salaryMin: 150000,
  })
  assert.ok(out)
  assert.equal(out!.industry, "tech")
  assert.equal(out!.sponsorship, "h1b")
  assert.equal(out!.location, "SF")
  assert.equal(out!.sizePreference, "either")
  assert.equal(out!.salaryMin, 150000)
  assert.deepEqual(out!.industryTags, ["tech"])
})

test("Stream F5: normalizeJobProfile maps new shape (industryTags + sponsorshipNeeded) to legacy filters", () => {
  const out = normalizeJobProfile({
    industryTags: ["fintech_finance", "ai_ml"],
    sponsorshipNeeded: "H1B",
    locationPreference: "湾区",
    sizePreference: "startup",
    salaryMin: 200000,
  })
  assert.ok(out)
  assert.equal(out!.industry, "fintech")
  assert.equal(out!.sponsorship, "h1b")
  assert.equal(out!.location, "湾区")
  assert.equal(out!.sizePreference, "startup")
  assert.equal(out!.salaryMin, 200000)
  assert.deepEqual(out!.industryTags, ["fintech_finance", "ai_ml"])
})

test("Stream F5: normalizeJobProfile returns null on garbage input", () => {
  assert.equal(normalizeJobProfile(null), null)
  assert.equal(normalizeJobProfile(undefined), null)
  assert.equal(normalizeJobProfile({}), null)
  assert.equal(normalizeJobProfile({ industryTags: [] }), null)
  assert.equal(normalizeJobProfile("tech"), null)
})

test("Stream F5: cosineSimilarity is 1.0 for identical vectors and 0 for orthogonal", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1)
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0)
  // Empty / mismatched dims → 0
  assert.equal(cosineSimilarity([], [1]), 0)
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0)
  // Magnitude doesn't affect direction
  const c = cosineSimilarity([2, 0, 0], [4, 0, 0])
  assert.ok(Math.abs(c - 1) < 1e-9)
})

test("Stream F5: runDailyJobRecBatch handles new-shape profile end-to-end (delivers)", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_new").set({ phoneE164: "+15553334444" })
  await mfs.collection("pa-job-profiles").doc("u_new").set({
    userId: "u_new",
    profile: {
      industryTags: ["fintech_finance"],
      sponsorshipNeeded: "H1B",
      locationPreference: "Remote",
      sizePreference: "startup",
      salaryMin: null,
    },
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
  })
  await mfs.collection("matching-jobs").doc("j_fin").set({
    status: "active",
    industryKey: "fintech",
    companyName: "FinCo",
    roleTitle: "Quant Eng",
    salaryMax: 350000,
    locationRaw: "Remote",
    primaryUrl: "https://j/fin",
    industry: "fintech",
    sponsorship: true,
    firstSeenAt: "2026-04-30",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 1)
  const w = mfs.writeLog.filter((w) => w.path === "pa-outbound")[0]
  assert.ok(w?.data.body)
  assert.match(String(w!.data.body), /FinCo/)
  // Bare URL on its own line (Bible v7.5.2)
  assert.match(String(w!.data.body), /\nhttps:\/\/j\/fin/)
})

import { rerankByCosine } from "../daily-batch.js"

test("Stream F5: rerankByCosine sorts by cosine similarity, jobs without embedding sink to back", () => {
  const userEmbed = [1, 0, 0]
  const jobs = [
    {
      id: "j_far",
      companyName: "Far",
      jobTitle: "Far Role",
      salaryMax: null,
      salaryMin: null,
      locationRaw: "",
      primaryUrl: "https://x/far",
      industry: "tech",
      sponsorship: null,
      embedding: [0, 1, 0], // orthogonal to user → score 0
    },
    {
      id: "j_close",
      companyName: "Close",
      jobTitle: "Close Role",
      salaryMax: null,
      salaryMin: null,
      locationRaw: "",
      primaryUrl: "https://x/close",
      industry: "tech",
      sponsorship: null,
      embedding: [1, 0, 0], // identical to user → score 1
    },
    {
      id: "j_noemb",
      companyName: "NoEmb",
      jobTitle: "NoEmb Role",
      salaryMax: null,
      salaryMin: null,
      locationRaw: "",
      primaryUrl: "https://x/noemb",
      industry: "tech",
      sponsorship: null,
      // no embedding field
    },
  ]
  const out = rerankByCosine(jobs, userEmbed, 3)
  assert.equal(out[0]!.id, "j_close")
  // far (orthogonal score 0) and noemb (also score 0) tie, but close is on top
  assert.notEqual(out[2]!.id, "j_close")
})

test("Stream F5: runDailyJobRecBatch with rerank deps applies cosine + still delivers", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_re").set({ phoneE164: "+15554445555" })
  await mfs.collection("pa-job-profiles").doc("u_re").set({
    userId: "u_re",
    profile: {
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
  })
  await mfs.collection("matching-jobs").doc("j_high").set({
    status: "active",
    industryKey: "tech",
    companyName: "HighCo",
    roleTitle: "Senior",
    salaryMax: 300000,
    locationRaw: "Remote",
    primaryUrl: "https://j/high",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    embedding: [1, 0, 0],
  })
  await mfs.collection("matching-jobs").doc("j_low").set({
    status: "active",
    industryKey: "tech",
    companyName: "LowCo",
    roleTitle: "Junior",
    salaryMax: 80000,
    locationRaw: "Remote",
    primaryUrl: "https://j/low",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    embedding: [0, 1, 0], // orthogonal to user
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    userEmbedFetcher: async () => ({
      embedding: [1, 0, 0],
      resumeId: "rsm_x",
    }),
    candidatePoolSize: 50,
  })
  assert.equal(out.delivered, 1)
  const w = mfs.writeLog.filter((w) => w.path === "pa-outbound")[0]
  // HighCo wins because its embedding is identical to user
  assert.match(String(w!.data.body), /HighCo/)
  assert.doesNotMatch(String(w!.data.body), /LowCo/)
})

test("Stream H10: cross-encoder reranker reorders cosine-ranked jobs by relevance", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_x").set({ phoneE164: "+15553336666" })
  await mfs.collection("pa-job-profiles").doc("u_x").set({
    userId: "u_x",
    profile: {
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
  })
  // Two jobs with identical cosine score — only the cross-encoder should
  // distinguish them. j_real_fit has a clear "data scientist" title, j_qc
  // has a "QC analyst" title — cross-encoder should pick the former.
  await mfs.collection("matching-jobs").doc("j_qc").set({
    status: "active",
    industryKey: "engineering",
    companyName: "LabCo",
    jobTitle: "QC Analyst",
    roleTitle: "QC Analyst",
    salaryMax: 60000,
    locationRaw: "Remote",
    primaryUrl: "https://j/qc",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    embedding: [1, 0, 0],
    requiredSkills: ["Python"],
  })
  await mfs.collection("matching-jobs").doc("j_real_fit").set({
    status: "active",
    industryKey: "tech",
    companyName: "DataCo",
    jobTitle: "Senior Data Scientist",
    roleTitle: "Senior Data Scientist",
    salaryMax: 250000,
    locationRaw: "Remote",
    primaryUrl: "https://j/data",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    embedding: [1, 0, 0], // identical cosine to j_qc
    requiredSkills: ["Python", "PyTorch"],
  })

  // Stub cross-encoder: rank j_real_fit > j_qc.
  const reranker = async (
    _q: string,
    cands: Array<{ id: string; text: string }>
  ) => {
    return cands
      .map((c) => ({
        id: c.id,
        score: c.id === "j_real_fit" ? 0.85 : 0.001,
      }))
      .sort((a, b) => b.score - a.score)
  }

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    userEmbedFetcher: async () => ({ embedding: [1, 0, 0], resumeId: null }),
    crossEncoderReranker: reranker,
    crossEncoderPoolSize: 10,
  })
  assert.equal(out.delivered, 1)
  const body = String(
    mfs.writeLog.filter((w) => w.path === "pa-outbound")[0]!.data.body
  )
  assert.match(body, /DataCo/, "cross-encoder picks Data Scientist over QC Analyst")
  assert.doesNotMatch(body, /LabCo/)
})

test("Stream H10: cross-encoder fail-open (all-null scores) preserves cosine order", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u_fo").set({ phoneE164: "+15557778888" })
  await mfs.collection("pa-job-profiles").doc("u_fo").set({
    userId: "u_fo",
    profile: {
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
  })
  await mfs.collection("matching-jobs").doc("j_top").set({
    status: "active",
    industryKey: "tech",
    companyName: "TopCo",
    jobTitle: "Senior Engineer",
    roleTitle: "Senior Engineer",
    salaryMax: 250000,
    locationRaw: "Remote",
    primaryUrl: "https://j/top",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    embedding: [1, 0, 0],
  })
  await mfs.collection("matching-jobs").doc("j_bot").set({
    status: "active",
    industryKey: "tech",
    companyName: "BotCo",
    jobTitle: "Junior Engineer",
    roleTitle: "Junior Engineer",
    salaryMax: 80000,
    locationRaw: "Remote",
    primaryUrl: "https://j/bot",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    embedding: [0, 1, 0], // orthogonal — sinks via cosine
  })

  // Reranker simulates network failure — returns input order with null scores.
  const reranker = async (
    _q: string,
    cands: Array<{ id: string; text: string }>
  ) => cands.map((c) => ({ id: c.id, score: null }))

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    userEmbedFetcher: async () => ({ embedding: [1, 0, 0], resumeId: null }),
    crossEncoderReranker: reranker,
  })
  assert.equal(out.delivered, 1)
  const body = String(
    mfs.writeLog.filter((w) => w.path === "pa-outbound")[0]!.data.body
  )
  // Cosine still ranks TopCo > BotCo despite reranker fail-open.
  assert.match(body, /TopCo/)
  assert.doesNotMatch(body, /BotCo/)
})

test("Stream H12: dedupe by (jobTitle|companyName) drops near-identical JDs", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("u1").set({ phoneE164: "+15551112222" })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  // 4 jobs: 2 are exact title+company duplicates across cities, 2 are unique.
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active", industryKey: "tech", companyName: "Mastercard",
    roleTitle: "Tax Consultant", salaryMax: 120000, locationRaw: "Princeton, NJ",
    primaryUrl: "https://j/1", industry: "tech", sponsorship: false, firstSeenAt: "2026-04-30",
  })
  await mfs.collection("matching-jobs").doc("j2").set({
    status: "active", industryKey: "tech", companyName: "Mastercard",
    roleTitle: "Tax Consultant", salaryMax: 120000, locationRaw: "Richmond, VA",
    primaryUrl: "https://j/2", industry: "tech", sponsorship: false, firstSeenAt: "2026-04-29",
  })
  await mfs.collection("matching-jobs").doc("j3").set({
    status: "active", industryKey: "tech", companyName: "Stripe",
    roleTitle: "Software Engineer", salaryMax: 200000, locationRaw: "Remote",
    primaryUrl: "https://j/3", industry: "tech", sponsorship: false, firstSeenAt: "2026-04-28",
  })
  await mfs.collection("matching-jobs").doc("j4").set({
    status: "active", industryKey: "tech", companyName: "Stripe",
    roleTitle: "Software Engineer", salaryMax: 200000, locationRaw: "San Francisco, CA",
    primaryUrl: "https://j/4", industry: "tech", sponsorship: false, firstSeenAt: "2026-04-27",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 4,  // request 4 — dedupe should still leave 2 unique
  })
  assert.equal(out.delivered, 1)
  const body = String(mfs.writeLog.filter((w) => w.path === "pa-outbound")[0]!.data.body)
  // Both unique title-company pairs should appear, but only ONCE each
  assert.match(body, /Tax Consultant/)
  assert.match(body, /Software Engineer/)
  // Mastercard appears exactly once (not twice)
  const mastercardCount = (body.match(/Mastercard/g) || []).length
  assert.equal(mastercardCount, 1, `Mastercard should appear once, got ${mastercardCount}`)
  // Stripe appears exactly once
  const stripeCount = (body.match(/Stripe/g) || []).length
  assert.equal(stripeCount, 1, `Stripe should appear once, got ${stripeCount}`)
})

