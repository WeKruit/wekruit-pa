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
