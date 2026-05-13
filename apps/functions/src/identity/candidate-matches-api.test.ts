import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"

import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import { runCandidateListMatches } from "./candidate-matches-api.js"

test("runCandidateListMatches requires authenticated mapped candidate", async () => {
  const mfs = new MockFirestore()
  await assert.rejects(
    () => runCandidateListMatches({}, undefined, { db: asFirestore(mfs) }),
    (err) => err instanceof HttpsError && err.code === "unauthenticated"
  )
  await assert.rejects(
    () => runCandidateListMatches({}, { uid: "firebase-1" }, { db: asFirestore(mfs) }),
    (err) => err instanceof HttpsError && err.code === "failed-precondition"
  )
})

test("runCandidateListMatches returns public-safe candidate-owned match cards only", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
  await mfs.collection("pa-candidate-job-matches").doc("cand-1__job-1").set({
    matchId: "cand-1__job-1",
    candidateId: "cand-1",
    jobId: "job-1",
    hardFilterResult: "soft_block",
    recommendedAction: "hitl_review",
    finalRank: 2,
    reasons: ["React and TypeScript match the role."],
    risks: ["internal risk should not leak"],
    evidence: [{ source: "job_match", summary: "internal" }],
    scoreBreakdown: { skillJaccard: { score: 0.9 } },
    computedAt: "2026-05-13T12:00:00.000Z",
  })
  await mfs.collection("pa-candidate-job-matches").doc("cand-2__job-1").set({
    candidateId: "cand-2",
    jobId: "job-1",
    reasons: ["wrong candidate"],
  })
  await mfs.collection("pa-candidate-job-matches").doc("cand-1__job-2").set({
    matchId: "cand-1__job-2",
    candidateId: "cand-1",
    jobId: "job-2",
    hardFilterResult: "hard_block",
    recommendedAction: "do_not_contact",
    reasons: ["hidden"],
  })
  await mfs.collection("pa-jobs").doc("job-1").set({
    publicVisible: true,
    prescreenConfig: {
      jobTitle: "Frontend Engineer",
      company: "Acme",
      level1Reveal: { salaryRange: "$150k-$190k" },
    },
    location: "San Francisco",
  })
  await mfs.collection("pa-jobs").doc("job-2").set({
    publicVisible: true,
    prescreenConfig: { jobTitle: "Blocked Role", company: "Hidden" },
  })
  await mfs.collection("pa-candidate-job-states").doc("cand-1__job-1").set({
    id: "cand-1__job-1",
    candidateId: "cand-1",
    jobId: "job-1",
    state: "prescreen_started",
  })
  await mfs.collection("pa-outbound-invites").doc("invite-1").set({
    inviteId: "invite-1",
    candidateId: "cand-1",
    jobId: "job-1",
    status: "queued",
  })
  const writesBefore = mfs.writeLog.length

  const result = await runCandidateListMatches(
    { limit: 10 },
    { uid: "firebase-1" },
    { db: asFirestore(mfs) }
  )

  assert.equal(mfs.writeLog.length, writesBefore)
  assert.equal(result.ok, true)
  assert.equal(result.candidateId, "cand-1")
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.jobId, "job-1")
  assert.equal(result.matches[0]!.bucket, "invited")
  assert.equal(result.matches[0]!.status, "interview_started")
  assert.equal(result.matches[0]!.job.title, "Frontend Engineer")
  assert.equal(result.matches[0]!.job.company, "Acme")
  assert.equal(result.matches[0]!.job.href, "/j/job-1")
  assert.deepEqual(result.matches[0]!.whyMatched, ["React and TypeScript match the role."])

  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /scoreBreakdown|evidence|recommendedAction|internal risk/)
})

test("runCandidateListMatches suppresses non-public jobs", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
  await mfs.collection("pa-candidate-job-matches").doc("cand-1__hidden").set({
    matchId: "cand-1__hidden",
    candidateId: "cand-1",
    jobId: "hidden",
    hardFilterResult: "pass",
    recommendedAction: "hitl_review",
    reasons: ["Should not show"],
  })
  await mfs.collection("pa-jobs").doc("hidden").set({
    publicVisible: false,
    prescreenConfig: { jobTitle: "Hidden Role", company: "Hidden Co" },
  })

  const result = await runCandidateListMatches({}, { uid: "firebase-1" }, { db: asFirestore(mfs) })
  assert.equal(result.matches.length, 0)
})
