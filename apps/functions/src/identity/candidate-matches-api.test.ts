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
    rawTranscript: "internal transcript should not leak",
    employerSnapshot: { passReason: "internal employer snapshot should not leak" },
    email: "candidate@example.com",
    phone: "+15555550123",
  })
  await mfs.collection("pa-outbound-invites").doc("invite-1").set({
    inviteId: "invite-1",
    candidateId: "cand-1",
    jobId: "job-1",
    status: "queued",
    providerMessageId: "provider-secret",
    toE164: "+15555550123",
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
  assert.doesNotMatch(
    serialized,
    /scoreBreakdown|evidence|recommendedAction|internal risk|rawTranscript|employerSnapshot|providerMessageId|toE164|candidate@example\.com|\+15555550123/
  )
})

test("runCandidateListMatches includes direct state-only candidate job rows", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
  await mfs.collection("pa-candidate-job-states").doc("cand-1__job-direct").set({
    id: "cand-1__job-direct",
    candidateId: "cand-1",
    jobId: "job-direct",
    state: "candidate_matched",
    rawTranscript: "direct transcript should not leak",
  })
  await mfs.collection("pa-jobs").doc("job-direct").set({
    publicVisible: true,
    prescreenConfig: { jobTitle: "Backend Engineer", company: "Direct Co" },
  })

  const result = await runCandidateListMatches({}, { uid: "firebase-1" }, { db: asFirestore(mfs) })

  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.matchId, "cand-1__job-direct")
  assert.equal(result.matches[0]!.jobId, "job-direct")
  assert.equal(result.matches[0]!.bucket, "recommended")
  assert.equal(result.matches[0]!.status, "recommended")
  assert.deepEqual(result.matches[0]!.whyMatched, ["This role matches your saved profile."])
  assert.doesNotMatch(JSON.stringify(result), /rawTranscript/)
})

test("runCandidateListMatches recommends published jobs from parsed candidate tags when no match rows exist", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
  await mfs.collection("pa-users").doc("cand-1").set({
    tags: {
      roleFunction: ["software_engineering"],
      industrySector: ["financial_technology"],
      skills: [{ name: "python" }, { name: "sql" }],
    },
  })
  await mfs.collection("pa-jobs").doc("job-fit").set({
    publicVisible: true,
    status: "active",
    title: "Backend Engineer",
    companyName: "Rain",
    location: "New York",
    descriptionMd: "Build payment APIs with Python and SQL.",
    roleFunction: ["software_engineering"],
    industrySector: ["financial_technology"],
    prescreenConfig: {
      jobTitle: "Backend Engineer",
      company: "Rain",
      level1Reveal: { salaryRange: "$150k-$220k" },
    },
  })
  await mfs.collection("pa-jobs").doc("job-weak").set({
    publicVisible: true,
    status: "active",
    title: "Growth Marketer",
    companyName: "Market Co",
    descriptionMd: "Run campaigns and social channels.",
    roleFunction: ["marketing"],
    industrySector: ["education"],
  })
  await mfs.collection("pa-jobs").doc("job-hidden").set({
    publicVisible: false,
    status: "active",
    title: "Hidden Python Role",
    descriptionMd: "Python SQL",
  })
  const writesBefore = mfs.writeLog.length

  const result = await runCandidateListMatches(
    { limit: 2 },
    { uid: "firebase-1" },
    {
      db: asFirestore(mfs),
      now: () => new Date("2026-05-14T18:30:00.000Z"),
    }
  )

  assert.equal(mfs.writeLog.length, writesBefore)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.jobId, "job-fit")
  assert.equal(result.matches[0]!.bucket, "recommended")
  assert.equal(result.matches[0]!.status, "recommended")
  assert.equal(result.matches[0]!.job.title, "Backend Engineer")
  assert.equal(result.matches[0]!.job.href, "/j/job-fit")
  assert.equal(result.matches[0]!.job.salaryRange, "$150k-$220k")
  assert.match(result.matches[0]!.whyMatched.join(" "), /python|sql|software_engineering|financial_technology/)
  assert.equal(result.matches.some((match) => match.jobId === "job-hidden"), false)
})

test("runCandidateListMatches maps employer visible state to candidate passed", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
  await mfs.collection("pa-candidate-job-states").doc("cand-1__job-pass").set({
    id: "cand-1__job-pass",
    candidateId: "cand-1",
    jobId: "job-pass",
    state: "employer_visible",
    employerVisibleProfileId: "evp-cand-1-job-pass",
  })
  await mfs.collection("pa-jobs").doc("job-pass").set({
    publicVisible: true,
    prescreenConfig: { jobTitle: "Product Engineer", company: "Pass Co" },
  })

  const result = await runCandidateListMatches({}, { uid: "firebase-1" }, { db: asFirestore(mfs) })

  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.bucket, "invited")
  assert.equal(result.matches[0]!.status, "passed")
  assert.doesNotMatch(JSON.stringify(result), /employerVisibleProfileId|evp-cand-1-job-pass/)
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
