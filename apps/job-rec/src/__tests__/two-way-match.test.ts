import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import type { MatchingJob } from "../types.js"
import {
  candidateMatchToMarketplaceMatch,
  rankCandidatesForJob,
  scoreCandidateForJob,
  type MatchingCandidateRow,
} from "../two-way-match.js"

const NOW = Date.parse("2026-05-13T12:00:00Z")
const FRESH_TS = new Date(NOW - 3 * 24 * 3600 * 1000).toISOString()

function job(
  over: Partial<MatchingJob & { embedding?: number[] | null }> = {}
): MatchingJob & { embedding?: number[] | null } {
  return {
    id: "job-1",
    companyName: "Acme AI",
    jobTitle: "AI Product Engineer",
    salaryMin: 160_000,
    salaryMax: 220_000,
    locationRaw: "San Francisco, CA",
    primaryUrl: "https://jobs.example.com/acme-ai",
    atsApplyUrl: "https://greenhouse.io/acme/jobs/1",
    industry: "tech",
    sponsorship: true,
    jobType: "full_time",
    requiredSkills: ["typescript", "react", "rag"],
    firstSeenAt: FRESH_TS,
    roleFunction: ["software_engineering"],
    industrySector: ["tech_software"],
    relevantTags: ["ai_agents", "frontend"],
    locationBuckets: ["san_francisco_bay_area"],
    seniorityLevel: "mid_level",
    embedding: [1, 0],
    ...over,
  }
}

function candidate(over: Partial<MatchingCandidateRow> = {}): MatchingCandidateRow {
  return {
    userId: "user-1",
    displayName: "Ada",
    lifecycle: "profile_ready",
    outreach: { paused: false, doNotContact: false },
    tagsUpdatedAt: "2026-05-12T00:00:00.000Z",
    tags: {
      skills: [
        { name: "typescript", proficiency: "advanced", baseWeight: 0.9 },
        { name: "react", proficiency: "advanced", baseWeight: 0.8 },
        { name: "rag", proficiency: "intermediate", baseWeight: 0.7 },
      ],
      relevantTags: ["ai_agents", "frontend"],
      industrySector: ["tech_software"],
      visaStatus: "citizen",
      targetRoleFunction: ["software_engineering"],
      targetLocations: ["san_francisco_bay_area"],
      careerStage: "mid_level",
      targetJobType: ["full_time"],
      minSalary: 150_000,
      embedding: [1, 0],
      schemaVersion: 1,
    },
    cvEmbedding: [1, 0],
    llmMatch: 0.9,
    ...over,
  }
}

test("rankCandidatesForJob ranks a strong job-to-candidate match with auto_outbound recommendation", () => {
  const ranked = rankCandidatesForJob(job(), [
    candidate({ userId: "weaker", displayName: "Weak", llmMatch: 0.1, tags: { ...candidate().tags, skills: ["python"] } }),
    candidate({ userId: "strong", displayName: "Strong" }),
  ], { nowMs: NOW })

  assert.equal(ranked.length, 2)
  assert.equal(ranked[0]!.candidateId, "strong")
  assert.equal(ranked[0]!.hardFilterResult, "pass")
  assert.equal(ranked[0]!.recommendedAction, "auto_outbound")
  assert.ok(ranked[0]!.scoreBreakdown.skillJaccard.score > 0.95)
  assert.ok(ranked[0]!.matchedSignals.some((signal) => signal.includes("typescript")))
})

test("scoreCandidateForJob suppresses role mismatches as do_not_contact", () => {
  const result = scoreCandidateForJob(job(), candidate({
    tags: { ...candidate().tags, targetRoleFunction: ["sales"] },
  }), { nowMs: NOW })

  assert.equal(result.hardFilterResult, "hard_block")
  assert.equal(result.recommendedAction, "do_not_contact")
  assert.deepEqual(result.blockedSignals, ["role_mismatch"])
})

test("scoreCandidateForJob suppresses sponsor-needed candidates when job explicitly cannot sponsor", () => {
  const result = scoreCandidateForJob(
    job({ sponsorship: false }),
    candidate({ tags: { ...candidate().tags, visaStatus: "sponsor_needed" } }),
    { nowMs: NOW }
  )

  assert.equal(result.hardFilterResult, "hard_block")
  assert.equal(result.recommendedAction, "do_not_contact")
  assert.deepEqual(result.blockedSignals, ["visa_sponsorship_unavailable"])
})

test("scoreCandidateForJob routes sponsor-needed candidates to review when sponsorship is unknown", () => {
  const result = scoreCandidateForJob(
    job({ sponsorship: null }),
    candidate({ tags: { ...candidate().tags, visaStatus: "sponsor_needed" } }),
    { nowMs: NOW }
  )

  assert.equal(result.hardFilterResult, "soft_block")
  assert.equal(result.recommendedAction, "hitl_review")
  assert.deepEqual(result.missingInfo, ["job_sponsorship"])
  assert.equal(result.blockedSignals.length, 0)
})

test("scoreCandidateForJob routes promising candidates with missing profile info to hitl_review", () => {
  const base = candidate()
  const result = scoreCandidateForJob(
    job(),
    candidate({
      tags: {
        ...base.tags,
        targetLocations: undefined,
        careerStage: undefined,
      },
    }),
    { nowMs: NOW }
  )

  assert.equal(result.hardFilterResult, "soft_block")
  assert.equal(result.recommendedAction, "hitl_review")
  assert.deepEqual(result.missingInfo.sort(), ["candidate_career_stage", "candidate_location"].sort())
  assert.ok((result.finalScore ?? 0) > 0.6)
})

test("candidateMatchToMarketplaceMatch produces a CandidateJobMatch-shaped pure projection", () => {
  const result = scoreCandidateForJob(job(), candidate({ userId: "user-42" }), { nowMs: NOW })
  const match = candidateMatchToMarketplaceMatch(result, {
    matchVersion: "s5-preview-v1",
    jobEnrichmentVersion: "job-enrich-v1",
    computedAt: "2026-05-13T12:00:00.000Z",
    createdAt: "2026-05-13T12:00:00.000Z",
  })

  assert.equal(match.matchId, "user-42__job-1")
  assert.equal(match.candidateId, "user-42")
  assert.equal(match.jobId, "job-1")
  assert.equal(match.direction, "job_to_candidate")
  assert.equal(match.recommendedAction, "auto_outbound")
  assert.equal(match.scoreBreakdown.skillJaccard.score, result.scoreBreakdown.skillJaccard.score)
})

test("candidate-to-jobs V16 entry point remains the existing queryMatchingJobsV16", () => {
  const source = readFileSync(new URL("../tools/query-matching-jobs-v16.ts", import.meta.url), "utf8")
  assert.match(source, /export async function queryMatchingJobsV16/)
})
