import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import {
  formatJobLine,
  formatBatchMessage,
  runDailyJobRecBatch,
} from "../daily-batch.js"
import type { MatchingJob } from "../types.js"

function sessionDocId(userId: string, phoneE164: string): string {
  const h = createHash("sha256").update(`${userId}|imessage|${phoneE164}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

async function seedUser(
  mfs: MockFirestore,
  userId: string,
  phoneE164: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await mfs.collection("pa-users").doc(userId).set({ phoneE164, ...extra })
  await mfs.collection("pa-sessions").doc(sessionDocId(userId, phoneE164)).set({
    id: sessionDocId(userId, phoneE164),
    userId,
    channel: "imessage",
    externalChatId: phoneE164,
    createdAt: "2026-04-30T00:00:00.000Z",
  })
}

function jobRecRuntimeWrites(mfs: MockFirestore) {
  return mfs.writeLog.filter(
    (w) =>
      w.path === "pa-inbound-events" &&
      (w.data.rawMeta as Record<string, unknown> | undefined)?.runtimeEventSource === "job_rec"
  )
}

function firstJobRecProposedMessage(mfs: MockFirestore): string {
  const row = jobRecRuntimeWrites(mfs)[0]?.data
  const ctx = (row?.rawMeta as Record<string, unknown> | undefined)?.context as
    | Record<string, unknown>
    | undefined
  return String(ctx?.proposedMessage ?? "")
}

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

// iter34 sprint A.2 — atsApplyUrl preferred over primaryUrl when present.
test("formatJobLine: atsApplyUrl present → URL line uses ATS link", () => {
  const j: MatchingJob = {
    id: "j1",
    companyName: "Acme",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "NYC",
    primaryUrl: "https://jobright.ai/m/abc",
    atsApplyUrl: "https://boards.greenhouse.io/acme/jobs/123",
    industry: "tech",
    sponsorship: null,
  }
  const line = formatJobLine(j)
  const lines = line.split("\n")
  assert.equal(lines[1], "https://boards.greenhouse.io/acme/jobs/123")
  // jobright mirror MUST NOT appear when ATS link is available.
  assert.doesNotMatch(line, /jobright/)
})

test("formatJobLine: atsApplyUrl undefined → falls back to primaryUrl", () => {
  const j: MatchingJob = {
    id: "j1",
    companyName: "Acme",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "NYC",
    primaryUrl: "https://jobright.ai/m/abc",
    atsApplyUrl: undefined,
    industry: "tech",
    sponsorship: null,
  }
  const line = formatJobLine(j)
  const lines = line.split("\n")
  assert.equal(lines[1], "https://jobright.ai/m/abc")
})

test("formatJobLine: atsApplyUrl absent (legacy MatchingJob shape) → primaryUrl wins", () => {
  // Legacy shape — no `atsApplyUrl` field at all (older fixtures, reverse-match
  // synth before iter34 A.2).
  const j: MatchingJob = {
    id: "j1",
    companyName: "Acme",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "NYC",
    primaryUrl: "https://primary.example.com/x",
    industry: "tech",
    sponsorship: null,
  }
  const line = formatJobLine(j)
  const lines = line.split("\n")
  assert.equal(lines[1], "https://primary.example.com/x")
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
    atsApplyUrl: "https://greenhouse.io/co/jobs/3",
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
  await seedUser(mfs, "u1", "+15551112222")
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
    atsApplyUrl: "https://greenhouse.io/co/jobs/4",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
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
  // job-rec hands the candidate-visible message to Claire runtime.
  assert.equal(jobRecRuntimeWrites(mfs).length, 1)
})

test("runDailyJobRecBatch: skipped_no_jobs when corpus empty for filters", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
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
  await seedUser(mfs, "u1", "+15551112222")
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
    atsApplyUrl: "https://greenhouse.io/co/jobs/5",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
  })
  await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  const w = jobRecRuntimeWrites(mfs)[0]
  assert.equal(w?.data.idempotencyKey, "runtime-event:job-rec:u1-20260430-batch")
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
  await seedUser(mfs, "u_new", "+15553334444")
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
    atsApplyUrl: "https://greenhouse.io/co/jobs/6",
    industry: "fintech",
    sponsorship: true,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecProposedMessage(mfs)
  assert.match(body, /FinCo/)
  // Bare URL on its own line (Bible v7.5.2). atsApplyUrl is preferred over primaryUrl
  // post-iter34-A.2, so we match the greenhouse ATS link rather than primaryUrl.
  assert.match(body, /\nhttps:\/\/greenhouse\.io\/co\/jobs\/6/)
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
      atsApplyUrl: "https://greenhouse.io/co/jobs/7",
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
      atsApplyUrl: "https://greenhouse.io/co/jobs/8",
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
      atsApplyUrl: "https://greenhouse.io/co/jobs/9",
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
  await seedUser(mfs, "u_re", "+15554445555")
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
    atsApplyUrl: "https://greenhouse.io/co/jobs/10",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
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
    atsApplyUrl: "https://greenhouse.io/co/jobs/11",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
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
  const body = firstJobRecProposedMessage(mfs)
  // HighCo wins because its embedding is identical to user
  assert.match(body, /HighCo/)
  assert.doesNotMatch(body, /LowCo/)
})

test("Stream H10: cross-encoder reranker reorders cosine-ranked jobs by relevance", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u_x", "+15553336666")
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
    atsApplyUrl: "https://greenhouse.io/co/jobs/12",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
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
    atsApplyUrl: "https://greenhouse.io/co/jobs/13",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
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
  const body = firstJobRecProposedMessage(mfs)
  assert.match(body, /DataCo/, "cross-encoder picks Data Scientist over QC Analyst")
  assert.doesNotMatch(body, /LabCo/)
})

test("Stream H10: cross-encoder fail-open (all-null scores) preserves cosine order", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u_fo", "+15557778888")
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
    atsApplyUrl: "https://greenhouse.io/co/jobs/14",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
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
    atsApplyUrl: "https://greenhouse.io/co/jobs/15",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
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
  const body = firstJobRecProposedMessage(mfs)
  // Cosine still ranks TopCo > BotCo despite reranker fail-open.
  assert.match(body, /TopCo/)
  assert.doesNotMatch(body, /BotCo/)
})

test("Stream H12: dedupe by (jobTitle|companyName) drops near-identical JDs", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
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
    primaryUrl: "https://j/1", atsApplyUrl: "https://greenhouse.io/co/jobs/h12-1",
    industry: "tech", sponsorship: false, firstSeenAt: "2026-04-30",
 lastSeenAt: "2026-04-30",
  })
  await mfs.collection("matching-jobs").doc("j2").set({
    status: "active", industryKey: "tech", companyName: "Mastercard",
    roleTitle: "Tax Consultant", salaryMax: 120000, locationRaw: "Richmond, VA",
    primaryUrl: "https://j/2", atsApplyUrl: "https://greenhouse.io/co/jobs/h12-2",
    industry: "tech", sponsorship: false, firstSeenAt: "2026-04-29",
 lastSeenAt: "2026-04-29",
  })
  await mfs.collection("matching-jobs").doc("j3").set({
    status: "active", industryKey: "tech", companyName: "Stripe",
    roleTitle: "Software Engineer", salaryMax: 200000, locationRaw: "Remote",
    primaryUrl: "https://j/3", atsApplyUrl: "https://greenhouse.io/co/jobs/h12-3",
    industry: "tech", sponsorship: false, firstSeenAt: "2026-04-28",
 lastSeenAt: "2026-04-28",
  })
  await mfs.collection("matching-jobs").doc("j4").set({
    status: "active", industryKey: "tech", companyName: "Stripe",
    roleTitle: "Software Engineer", salaryMax: 200000, locationRaw: "San Francisco, CA",
    primaryUrl: "https://j/4", atsApplyUrl: "https://greenhouse.io/co/jobs/h12-4",
    industry: "tech", sponsorship: false, firstSeenAt: "2026-04-27",
 lastSeenAt: "2026-04-27",
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async () => true,
    todayYmd: () => "20260430",
    jobsPerUser: 4,  // request 4 — dedupe should still leave 2 unique
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecProposedMessage(mfs)
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


// =============================================================================
// Stream H13 — friend-tone CV-aware daily-push opener (D4: 6 tests + edges)
// =============================================================================
import {
  formatDailyPushBody,
  formatJobLineWithReason,
  buildJobReason,
  type DailyPushContext,
} from "../daily-batch.js"

const h13Job = (over: Partial<MatchingJob> = {}): MatchingJob => ({
  id: over.id ?? "j1",
  companyName: over.companyName ?? "Stripe",
  jobTitle: over.jobTitle ?? "Senior PM",
  salaryMax: over.salaryMax ?? null,
  salaryMin: null,
  locationRaw: over.locationRaw ?? "San Francisco, CA",
  primaryUrl: over.primaryUrl ?? "https://j/1",
  // iter34 sprint A.2 — forward atsApplyUrl override so URL-fallback tests
  // can exercise both paths. Default undefined matches legacy fixtures.
  atsApplyUrl: over.atsApplyUrl,
  industry: over.industry ?? "tech",
  industryKey: over.industryKey ?? "tech_software",
  sponsorship: null,
  requiredSkills: over.requiredSkills ?? ["Python", "ML"],
})

test("H13 variant B (CV-known, prefs-unknown) zh: opener names recentCompany + topSkill[0]", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    recentRoleTitle: "Data Analyst",
    topSkills: ["Python", "ML", "SQL"],
    industryTags: ["tech_software", "ai_ml"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  // Variant B opener: should reference NEUROVA + Python + the friend-tone phrase
  assert.match(body, /NEUROVA/)
  assert.match(body, /Python/)
  assert.match(body, /没具体问过你想找啥|没问过/)
  // Per-job line still has bare URL on its own line
  assert.match(body, /\nhttps:\/\/j\/1$/)
  // Per-job reason injected (skill exact match Python)
  assert.match(body, /Python 经验直接对得上/)
})

test("H13 variant B en: opener uses friend-tone English with recentCompany + topSkill", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    topSkills: ["Python"],
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "en",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  assert.match(body, /NEUROVA/)
  assert.match(body, /Python/)
  assert.match(body, /haven't asked|Hey/)
  // English reason
  assert.match(body, /your Python experience lines up directly/)
})

test("H13 variant A (CV + prefs) zh: opener references stated targetRole, no 'haven't asked' phrase", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    topSkills: ["Python"],
    industryTags: ["fintech_finance"],
    hasUserStatedPreferences: true,
    statedPreferences: { targetRole: ["支付"] },
    language: "zh",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  assert.match(body, /支付/)
  assert.doesNotMatch(body, /没问过|没具体问过/)
  // Should not nudge for CV (we have it)
  assert.doesNotMatch(body, /发我看看简历/)
})

test("H13 variant A en: opener uses stated targetRole in English", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    topSkills: ["Python"],
    industryTags: ["fintech_finance"],
    hasUserStatedPreferences: true,
    statedPreferences: { targetRole: ["payments"] },
    language: "en",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  assert.match(body, /payments/)
  assert.doesNotMatch(body, /haven't asked/)
})

test("H13 variant C (no CV) zh: keeps legacy lead + appends gentle CV nudge", () => {
  const ctx: DailyPushContext = {
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const body = formatDailyPushBody(
    [h13Job(), h13Job({ id: "j2", companyName: "Acme", primaryUrl: "https://j/2" })],
    ctx
  )
  assert.match(body, /今日给你挑了 2 个/)
  assert.match(body, /顺便发我看看简历/)
})

test("H13 variant C en: legacy lead + CV nudge in English", () => {
  const ctx: DailyPushContext = {
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "en",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  assert.match(body, /Picked 1/)
  assert.match(body, /send me your CV/)
})

test("H13 edge: CV with no recentCompany (only skills) → falls to variant C (no nudge needed if recentCompany absent)", () => {
  // recentCompany undefined → variant C even if topSkills present
  const ctx: DailyPushContext = {
    topSkills: ["Python", "Tableau"],
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  // No recentCompany → the friend-tone "看你简历那段 X" branch must NOT fire
  assert.doesNotMatch(body, /看你简历那段/)
  // Variant C does fire — legacy lead + nudge
  assert.match(body, /今日给你挑了/)
  assert.match(body, /顺便发我看看简历/)
})

test("H13 cap: variant B lead-in is ≤ 250 chars even with long company + long skill", () => {
  const ctx: DailyPushContext = {
    recentCompany: "A".repeat(200),
    topSkills: ["B".repeat(100)],
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const body = formatDailyPushBody([h13Job()], ctx)
  const leadIn = body.split("\n\n")[0]!
  assert.ok(leadIn.length <= 250, `lead-in ${leadIn.length} chars exceeds 250`)
})

test("H13 buildJobReason: skill exact-match wins over industry-match", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    topSkills: ["Python"],
    industryTags: ["tech_software"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const job = h13Job({ requiredSkills: ["Python"], industryKey: "tech_software" })
  // Skill match should take precedence
  assert.equal(buildJobReason(job, ctx), "你 Python 经验直接对得上")
})

test("H13 buildJobReason: returns empty string when no signal — clean line beats forced reason", () => {
  const ctx: DailyPushContext = {
    recentCompany: "NEUROVA",
    topSkills: ["Cobol"],
    industryTags: ["healthcare_biotech"],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const job = h13Job({ requiredSkills: ["JavaScript"], industryKey: "tech_software" })
  // No skill overlap, no industry overlap → empty
  assert.equal(buildJobReason(job, ctx), "")
})

test("H13 formatJobLineWithReason: when reason empty, falls back to plain title-line + URL (no trailing dash)", () => {
  const ctx: DailyPushContext = {
    industryTags: [],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const job = h13Job({ requiredSkills: [], salaryMax: 250000 })
  const out = formatJobLineWithReason(job, ctx)
  // Should have title-line then bare URL on next line, no " — " trailing
  assert.match(out, /\$250k\nhttps/)
  assert.doesNotMatch(out, / — \nhttps/)
})

// iter34 sprint A.2 — atsApplyUrl preferred in H13 path too.
test("H13 formatJobLineWithReason: atsApplyUrl wins over primaryUrl", () => {
  const ctx: DailyPushContext = {
    industryTags: [],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const job = h13Job({
    requiredSkills: [],
    primaryUrl: "https://jobright.ai/m/x",
    atsApplyUrl: "https://lever.co/co/jobs/1",
  })
  const out = formatJobLineWithReason(job, ctx)
  const lines = out.split("\n")
  assert.equal(lines[1], "https://lever.co/co/jobs/1")
})

test("H13 formatJobLineWithReason: atsApplyUrl undefined → falls back to primaryUrl", () => {
  const ctx: DailyPushContext = {
    industryTags: [],
    hasUserStatedPreferences: false,
    language: "zh",
  }
  const job = h13Job({
    requiredSkills: [],
    primaryUrl: "https://primary.example.com/x",
    atsApplyUrl: undefined,
  })
  const out = formatJobLineWithReason(job, ctx)
  const lines = out.split("\n")
  assert.equal(lines[1], "https://primary.example.com/x")
})

test("H13 runDailyJobRecBatch wires friend-tone variant B end-to-end (default flag on)", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222", { preferredLanguage: "zh" })
  // Resume doc with NEUROVA + Python — exercises variant B path
  await mfs.collection("parsedCandidateResumes").doc("r1").set({
    userId: "u1",
    createdAt: "2026-04-30T00:00:00Z",
    candidateProfile: { name: "Adam", skills: ["Python", "ML", "SQL"] },
    experiences: [
      { title: "Data Analyst", company: "NEUROVA", startDate: "2024", endDate: "present" },
    ],
  })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: {
      industry: "tech",
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    industryEnum: ["tech_software"],
    companyName: "Stripe",
    roleTitle: "Senior PM",
    salaryMax: 250000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/16",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["Python"],
  })
  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    // Selective flag: paJobRecEnabled / paFriendToneOpenerEnabled true; matchingIndustryEnumPopulated also true (industryEnum populated above for H8 path).
    getFlag: async (_db, key) => {
      if (key === "paJobRecEnabled") return true
      if (key === "paFriendToneOpenerEnabled") return true
      if (key === "matchingIndustryEnumPopulated") return true
      return false
    },
    todayYmd: () => "20260430",
    jobsPerUser: 1,
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecProposedMessage(mfs)
  // Friend-tone B applied: NEUROVA + Python referenced in lead-in
  assert.match(body, /NEUROVA/)
  assert.match(body, /Python/)
  assert.match(body, /没/)  // friend-tone phrase contains 没
})

// =============================================================================
// Stream F (Phase 42) — match-explainer wiring tests
// =============================================================================
import type { ChatImpl } from "../match-explainer.js"

test("Phase 42 regression: explainer flag OFF → body bytewise matches H13 (no LLM call)", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("parsedCandidateResumes").doc("r1").set({
    userId: "u1",
    createdAt: "2026-04-30T00:00:00Z",
    experiences: [{ title: "Data Analyst", company: "NEUROVA" }],
    candidateProfile: { name: "Adam", skills: ["Python", "ML", "SQL"] },
  })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: {
      industry: "tech",
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    industryEnum: ["tech_software"],
    companyName: "Stripe",
    roleTitle: "Senior PM",
    salaryMax: 250000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/17",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["Python"],
  })

  let chatCallCount = 0
  const stubChat: ChatImpl = async () => {
    chatCallCount += 1
    return { text: "SHOULD NOT BE CALLED", usage: { inputTokens: 0, outputTokens: 0 } }
  }

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    // paMatchExplainerEnabled returns FALSE → explainer path skipped entirely.
    getFlag: async (_db, key) => {
      if (key === "paJobRecEnabled") return true
      if (key === "paFriendToneOpenerEnabled") return true
      if (key === "matchingIndustryEnumPopulated") return true
      if (key === "paMatchExplainerEnabled") return false
      return false
    },
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    matchExplainerChatImpl: stubChat,
  })
  assert.equal(out.delivered, 1)
  assert.equal(chatCallCount, 0, "explainer must NOT run when flag is off")
  const body = firstJobRecProposedMessage(mfs)
  // H13 heuristic still fires (Python skill overlap) — bytewise compatible
  // with pre-Phase-42 because no ctx.reasons map was populated.
  assert.match(body, /Python 经验直接对得上/)
  // Pa-job-rec-explanations must be untouched.
  assert.equal(mfs.writeLog.some((w) => w.path === "pa-job-rec-explanations"), false)
})

test("Phase 42: explainer flag ON → LLM reason injected into body + cached", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("parsedCandidateResumes").doc("r1").set({
    userId: "u1",
    createdAt: "2026-04-30T00:00:00Z",
    experiences: [{ title: "Senior PM", company: "NEUROVA" }],
    candidateProfile: { name: "Adam", skills: ["payments", "product strategy"] },
  })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: {
      industry: "fintech",
      industryTags: ["fintech_finance"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "fintech",
    industryEnum: ["fintech_finance"],
    companyName: "Stripe",
    roleTitle: "Senior Product Manager",
    salaryMax: 280000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/18",
    industry: "fintech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["payments"],
  })

  let chatCallCount = 0
  const stubChat: ChatImpl = async () => {
    chatCallCount += 1
    return {
      text: "你 NEUROVA 那段 payments 经验和 Stripe 这条线直接对得上",
      usage: { inputTokens: 200, outputTokens: 30 },
    }
  }

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key) => {
      if (key === "paJobRecEnabled") return true
      if (key === "paFriendToneOpenerEnabled") return true
      if (key === "matchingIndustryEnumPopulated") return true
      if (key === "paMatchExplainerEnabled") return true
      return false
    },
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    matchExplainerChatImpl: stubChat,
  })
  assert.equal(out.delivered, 1)
  assert.equal(chatCallCount, 1, "explainer must run exactly once")
  const body = firstJobRecProposedMessage(mfs)
  // LLM-grounded reason replaces the heuristic reason (Stripe job skill
  // overlap on "payments" would have produced "你 payments 经验直接对得上";
  // explainer's grounded reason wins).
  assert.match(body, /NEUROVA 那段 payments 经验和 Stripe 这条线直接对得上/)
  // Cache write happened in pa-job-rec-explanations.
  assert.ok(
    mfs.writeLog.some(
      (w) => w.path === "pa-job-rec-explanations" && w.id === "u1__j1__zh"
    ),
    "cache write expected"
  )
  // Cost-ledger increment.
  assert.ok(
    mfs.writeLog.some(
      (w) => w.path === "pa-cost-ledger" && w.id === "match-explainer__20260430"
    ),
    "ledger write expected"
  )
})

test("Phase 42: explainer flag ON + LLM throws → fail-open keeps H13 heuristic line", async () => {
  const mfs = new MockFirestore()
  await seedUser(mfs, "u1", "+15551112222")
  await mfs.collection("parsedCandidateResumes").doc("r1").set({
    userId: "u1",
    createdAt: "2026-04-30T00:00:00Z",
    experiences: [{ title: "Data Analyst", company: "NEUROVA" }],
    candidateProfile: { name: "Adam", skills: ["Python", "ML"] },
  })
  await mfs.collection("pa-job-profiles").doc("u1").set({
    userId: "u1",
    profile: {
      industry: "tech",
      industryTags: ["tech_software"],
      sponsorshipNeeded: "none",
      locationPreference: "Remote",
      sizePreference: "any",
      salaryMin: null,
    },
    cvParsedAt: "2026-04-30T00:00:00Z",
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  })
  await mfs.collection("matching-jobs").doc("j1").set({
    status: "active",
    industryKey: "tech",
    industryEnum: ["tech_software"],
    companyName: "Stripe",
    roleTitle: "Senior PM",
    salaryMax: 250000,
    locationRaw: "Remote",
    primaryUrl: "https://j/1",
    atsApplyUrl: "https://greenhouse.io/co/jobs/19",
    industry: "tech",
    sponsorship: false,
    firstSeenAt: "2026-04-30",
    lastSeenAt: "2026-04-30",
    requiredSkills: ["Python"],
  })

  const stubChat: ChatImpl = async () => {
    throw new Error("match-explainer: HTTP 503 upstream")
  }

  const out = await runDailyJobRecBatch({
    db: asFirestore(mfs),
    getFlag: async (_db, key) => {
      if (key === "paJobRecEnabled") return true
      if (key === "paFriendToneOpenerEnabled") return true
      if (key === "matchingIndustryEnumPopulated") return true
      if (key === "paMatchExplainerEnabled") return true
      return false
    },
    todayYmd: () => "20260430",
    jobsPerUser: 1,
    matchExplainerChatImpl: stubChat,
  })
  assert.equal(out.delivered, 1)
  const body = firstJobRecProposedMessage(mfs)
  // Heuristic reason still appears (Python skill overlap) — fail-open
  // means we degrade to H13 behavior, never break the user.
  assert.match(body, /Python 经验直接对得上/)
  // No cache poisoned with empty string.
  assert.equal(
    mfs.writeLog.some((w) => w.path === "pa-job-rec-explanations"),
    false,
    "no cache write on LLM failure"
  )
})
