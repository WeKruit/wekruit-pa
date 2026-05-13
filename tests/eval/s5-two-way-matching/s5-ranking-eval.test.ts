import assert from "node:assert/strict"
import test from "node:test"
import { CorrectionEventSchema } from "@pa/core-types"
import { queryMatchingJobsV16 } from "../../../apps/job-rec/src/tools/query-matching-jobs-v16.js"
import { rankCandidatesForJob, type MatchingCandidateRow } from "../../../apps/job-rec/src/two-way-match.js"
import type { MatchingJob } from "../../../apps/job-rec/src/types.js"
import { MockFirestore, asFirestore } from "../../../apps/job-rec/src/__tests__/mock-firestore.js"

const NOW = Date.parse("2026-05-13T12:00:00.000Z")
const FRESH_TS = new Date(NOW - 2 * 24 * 3600 * 1000).toISOString()

function matchingJob(over: Partial<MatchingJob> = {}): MatchingJob {
  return {
    id: "job-strong",
    companyName: "Acme AI",
    jobTitle: "AI Product Engineer",
    salaryMin: 160_000,
    salaryMax: 220_000,
    locationRaw: "San Francisco, CA",
    primaryUrl: "https://jobs.example.com/acme",
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
    ...over,
  }
}

function candidate(over: Partial<MatchingCandidateRow> = {}): MatchingCandidateRow {
  return {
    userId: "cand-strong",
    displayName: "Strong Candidate",
    lifecycle: "retained",
    outreach: { paused: false, doNotContact: false, reachable: true },
    tagsUpdatedAt: "2026-05-13T00:00:00.000Z",
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
      schemaVersion: 1,
    },
    cvEmbedding: [1, 0],
    llmMatch: 0.9,
    ...over,
  }
}

test("candidate -> jobs ranks the strong job and suppresses role mismatch", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-users").doc("cand-1").set({
    tags: {
      skills: ["typescript", "react", "rag"],
      relevantTags: ["ai_agents", "frontend"],
      industrySector: ["tech_software"],
      visaStatus: "sponsor_needed",
      targetRoleFunction: ["software_engineering"],
      targetLocations: ["san_francisco_bay_area"],
      careerStage: "mid_level",
      targetJobType: ["full_time"],
      minSalary: 150_000,
      schemaVersion: 1,
    },
  })
  await mfs.collection("matching-jobs").doc("job-strong").set({
    ...matchingJob(),
    status: "active",
  })
  await mfs.collection("matching-jobs").doc("job-sales").set({
    ...matchingJob({
      id: "job-sales",
      jobTitle: "Account Executive",
      roleFunction: ["sales"],
      industrySector: ["tech_software"],
      requiredSkills: ["salesforce"],
    }),
    status: "active",
  })
  await mfs.collection("matching-jobs").doc("job-sponsor-unknown").set({
    ...matchingJob({
      id: "job-sponsor-unknown",
      jobTitle: "Frontend Engineer",
      sponsorship: null,
      requiredSkills: ["typescript", "react"],
    }),
    status: "active",
  })

  const result = await queryMatchingJobsV16(
    { userId: "cand-1", limit: 5, nowMs: NOW },
    { db: asFirestore(mfs), log: () => undefined }
  )

  const ids = result.jobs.map((job) => job.id)
  assert.ok(ids.includes("job-strong"))
  assert.ok(ids.includes("job-sponsor-unknown"), "sponsorship silence must not become false")
  assert.equal(ids.includes("job-sales"), false, "roleFunction mismatch must be query-suppressed")
})

test("job -> candidates ranks strong candidate first and routes edge cases correctly", () => {
  const ranked = rankCandidatesForJob(matchingJob(), [
    candidate(),
    candidate({
      userId: "cand-role-mismatch",
      tags: { ...candidate().tags, targetRoleFunction: ["sales"] },
    }),
    candidate({
      userId: "cand-missing-info",
      tags: { ...candidate().tags, targetLocations: undefined, careerStage: undefined },
    }),
  ], { nowMs: NOW })

  assert.equal(ranked[0]!.candidateId, "cand-strong")
  assert.equal(ranked[0]!.recommendedAction, "auto_outbound")
  assert.equal(ranked.find((row) => row.candidateId === "cand-role-mismatch")?.recommendedAction, "do_not_contact")
  assert.equal(ranked.find((row) => row.candidateId === "cand-missing-info")?.recommendedAction, "hitl_review")

  const sponsorBlocked = rankCandidatesForJob(
    matchingJob({ sponsorship: false }),
    [candidate({ userId: "cand-sponsor", tags: { ...candidate().tags, visaStatus: "sponsor_needed" } })],
    { nowMs: NOW }
  )[0]!
  assert.equal(sponsorBlocked.hardFilterResult, "hard_block")
  assert.equal(sponsorBlocked.recommendedAction, "do_not_contact")

  const sponsorUnknown = rankCandidatesForJob(
    matchingJob({ sponsorship: null }),
    [candidate({ userId: "cand-sponsor", tags: { ...candidate().tags, visaStatus: "sponsor_needed" } })],
    { nowMs: NOW }
  )[0]!
  assert.equal(sponsorUnknown.hardFilterResult, "soft_block")
  assert.equal(sponsorUnknown.recommendedAction, "hitl_review")
})

test("HITL candidate-job-match correction is a pinned regression fixture", () => {
  const correction = CorrectionEventSchema.parse({
    eventId: "corr-s5-ranking-1",
    targetType: "candidate_job_match",
    targetId: "cand-missing-info__job-strong",
    actor: "operator",
    reason: "Promising candidate but missing location should go to HITL, not auto outbound.",
    evidence: [{ source: "admin", summary: "S5 eval correction fixture" }],
    beforeRedacted: { recommendedAction: "auto_outbound" },
    afterRedacted: { recommendedAction: "hitl_review" },
    createdAt: "2026-05-13T12:00:00.000Z",
  })

  assert.equal(correction.targetType, "candidate_job_match")
  assert.deepEqual(correction.afterRedacted, { recommendedAction: "hitl_review" })
})
