import test from "node:test"
import assert from "node:assert/strict"
import {
  JobProfileSchema,
  JobProfileDocSchema,
  ResumeProfileSchema,
  MatchingJobSchema,
  ParseResumeInputSchema,
  QueryMatchingJobsInputSchema,
  SaveJobProfileInputSchema,
  SendImessageInputSchema,
  JOB_PROFILES_COLLECTION,
  JOB_REC_FLAG_KEY,
} from "../types.js"

test("JobProfileSchema accepts canonical onboarding answer", () => {
  const ok = {
    industry: "tech",
    sponsorship: "h1b",
    location: "湾区",
    sizePreference: "either",
    salaryMin: 120000,
  }
  const parsed = JobProfileSchema.parse(ok)
  assert.equal(parsed.industry, "tech")
  assert.equal(parsed.salaryMin, 120000)
})

test("JobProfileSchema makes salaryMin optional", () => {
  const parsed = JobProfileSchema.parse({
    industry: "any",
    sponsorship: "either",
    location: "remote",
    sizePreference: "startup",
  })
  assert.equal(parsed.salaryMin, undefined)
})

test("JobProfileSchema rejects unknown industry", () => {
  assert.throws(() =>
    JobProfileSchema.parse({
      industry: "crypto-bro",
      sponsorship: "none",
      location: "NYC",
      sizePreference: "bigtech",
    })
  )
})

test("JobProfileDocSchema enforces status enum", () => {
  const ts = "2026-04-30T00:00:00Z"
  const ok = JobProfileDocSchema.parse({
    userId: "u1",
    profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
    cvParsedAt: ts,
    lastJobBatchSentAt: null,
    status: "active",
    createdAt: ts,
    updatedAt: ts,
  })
  assert.equal(ok.status, "active")
  assert.throws(() =>
    JobProfileDocSchema.parse({
      userId: "u1",
      profile: { industry: "tech", sponsorship: "none", location: "remote", sizePreference: "either" },
      cvParsedAt: ts,
      lastJobBatchSentAt: null,
      status: "something_else",
      createdAt: ts,
      updatedAt: ts,
    })
  )
})

test("ResumeProfileSchema requires every named field", () => {
  assert.throws(() =>
    ResumeProfileSchema.parse({
      name: "x",
      currentRole: "y",
      yearsExp: 1,
      // missing skills, education, lastCompany, signatureProject
    } as unknown)
  )
})

test("MatchingJobSchema accepts nullable salaries", () => {
  const ok = MatchingJobSchema.parse({
    id: "j1",
    companyName: "Co",
    jobTitle: "SWE",
    salaryMax: null,
    salaryMin: null,
    locationRaw: "Remote",
    primaryUrl: "https://example.com/j1",
    industry: "tech",
    sponsorship: null,
  })
  assert.equal(ok.salaryMax, null)
  assert.equal(ok.sponsorship, null)
})

test("ParseResumeInputSchema rejects empty mediaUrl", () => {
  assert.throws(() => ParseResumeInputSchema.parse({ mediaUrl: "", userId: "u1" }))
})

test("QueryMatchingJobsInputSchema applies default limit", () => {
  const out = QueryMatchingJobsInputSchema.parse({ filters: { industry: "tech" } })
  assert.equal(out.limit, 5)
})

test("QueryMatchingJobsInputSchema caps limit at 20", () => {
  assert.throws(() =>
    QueryMatchingJobsInputSchema.parse({ filters: { industry: "tech" }, limit: 50 })
  )
})

test("SaveJobProfileInputSchema requires non-empty userId", () => {
  assert.throws(() =>
    SaveJobProfileInputSchema.parse({
      userId: "",
      profile: { industry: "tech", sponsorship: "none", location: "x", sizePreference: "either" },
    })
  )
})

test("SendImessageInputSchema requires structured context and rejects legacy content", () => {
  const parsed = SendImessageInputSchema.parse({
    userId: "u1",
    context: { eventKind: "job_recommendations_requested" },
  })
  assert.deepEqual(parsed.context, { eventKind: "job_recommendations_requested" })
  assert.throws(() =>
    SendImessageInputSchema.parse({ userId: "u1", content: "legacy copy" })
  )
})

test("module exports stable collection + flag constants", () => {
  assert.equal(JOB_PROFILES_COLLECTION, "pa-job-profiles")
  assert.equal(JOB_REC_FLAG_KEY, "paJobRecEnabled")
})
