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
  assert.deepEqual(result.matches[0]!.whyMatched, [
    "Backend Engineer at Direct Co is in your WeKruit pipeline; Claire can run the first screen.",
  ])
  assert.doesNotMatch(JSON.stringify(result), /This role matches your saved profile/)
  assert.doesNotMatch(JSON.stringify(result), /rawTranscript/)
})

test("runCandidateListMatches uses stateUpdatedAt for state-only pipeline activity time", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
  await mfs.collection("pa-candidate-job-states").doc("cand-1__job-direct").set({
    id: "cand-1__job-direct",
    candidateId: "cand-1",
    jobId: "job-direct",
    state: "prescreen_started",
    stateUpdatedAt: "2026-05-14T20:15:00.000Z",
  })
  await mfs.collection("pa-jobs").doc("job-direct").set({
    publicVisible: true,
    prescreenConfig: { jobTitle: "Backend Engineer", company: "Direct Co" },
  })

  const result = await runCandidateListMatches({}, { uid: "firebase-1" }, { db: asFirestore(mfs) })

  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.status, "interview_started")
  assert.equal(result.matches[0]!.computedAt, "2026-05-14T20:15:00.000Z")
})

test("runCandidateListMatches surfaces ONLY recorded recs; collab flag derived from pa-jobs collaboration status", async () => {
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
  // The matcher recorded these two jobs for this candidate (daily-recommend pattern).
  await mfs.collection("pa-user-job-recommendations").doc("cand-1").collection("jobs").doc("job-collab").set({
    userId: "cand-1",
    jobId: "job-collab",
    recommendationCount: 1,
    lastRecommendedAt: "2026-05-14T18:00:00.000Z",
    lastRecommendedSource: "job_rec_daily_batch",
  })
  await mfs.collection("pa-user-job-recommendations").doc("cand-1").collection("jobs").doc("job-general").set({
    userId: "cand-1",
    jobId: "job-general",
    recommendationCount: 1,
    lastRecommendedAt: "2026-05-13T18:00:00.000Z",
    lastRecommendedSource: "job_rec_daily_batch",
  })
  // A stale recorded rec whose job no longer exists anywhere → must drop.
  await mfs.collection("pa-user-job-recommendations").doc("cand-1").collection("jobs").doc("job-gone").set({
    userId: "cand-1",
    jobId: "job-gone",
    recommendationCount: 1,
    lastRecommendedAt: "2026-05-12T18:00:00.000Z",
  })
  // Collab job: mirrored into matching-jobs AND carried in pa-jobs (collaborated +
  // prescreenConfig) → collab: true, display hydrated from pa-jobs (salary reveal).
  await mfs.collection("matching-jobs").doc("job-collab").set({
    status: "active",
    title: "Backend Engineer",
    companyName: "Rain",
    roleFunction: ["software_engineering"],
    industrySector: ["financial_technology"],
    descriptionMd: "Build payment APIs with Python and SQL.",
  })
  await mfs.collection("pa-jobs").doc("job-collab").set({
    publicVisible: true,
    wekruitCollaborationStatus: "collaborated",
    title: "Backend Engineer",
    companyName: "Rain",
    location: "New York",
    prescreenConfig: {
      jobTitle: "Backend Engineer",
      company: "Rain",
      questions: [{ id: "q1", prompt: "Tell me about a payments system you built." }],
      level1Reveal: { salaryRange: "$150k-$220k" },
    },
  })
  // General job: matching-jobs only, no collaboration → collab: false, no CTA.
  await mfs.collection("matching-jobs").doc("job-general").set({
    status: "active",
    title: "Data Engineer",
    companyName: "Acme",
    roleFunction: ["software_engineering"],
    descriptionMd: "Pipelines in Python and SQL.",
  })
  const writesBefore = mfs.writeLog.length

  const result = await runCandidateListMatches(
    { limit: 10 },
    { uid: "firebase-1" },
    {
      db: asFirestore(mfs),
      now: () => new Date("2026-05-14T18:30:00.000Z"),
    }
  )

  assert.equal(mfs.writeLog.length, writesBefore)
  // Both recorded recs surface; the stale job-gone rec is dropped.
  assert.equal(result.matches.length, 2)
  assert.equal(result.matches.some((m) => m.jobId === "job-gone"), false)

  // Collab rec ranks first (tier: collab before general) + carries the CTA flag.
  const collab = result.matches.find((m) => m.jobId === "job-collab")!
  const general = result.matches.find((m) => m.jobId === "job-general")!
  assert.equal(result.matches[0]!.jobId, "job-collab")
  assert.equal(collab.collab, true)
  assert.equal(collab.status, "recommended")
  assert.equal(collab.job.title, "Backend Engineer")
  assert.equal(collab.job.href, "/j/job-collab")
  // Salary reveal comes from the pa-jobs prescreenConfig (employer-authoritative).
  assert.equal(collab.job.salaryRange, "$150k-$220k")
  // Adam directive 2026-05-30: the recommended reason is the GROUNDED pitch — it cites the role at
  // the company and reads human (never raw snake_case, never "Matches your resume skills:"). When the
  // recorded rec carries no stored grounded reason, it gracefully falls back to a clean role@company
  // line ("Backend Engineer at Rain — a strong fit on your saved profile"); either way it is grounded
  // in the live job + never the weak template. (The exact tag-citation depends on a stored reason, so
  // we assert the role@company grounding + the absence of the bad patterns, not specific tag tokens.)
  const whyCollab = collab.whyMatched.join(" ")
  assert.match(whyCollab, /Backend Engineer at Rain/)
  assert.doesNotMatch(whyCollab, /Matches your resume skills:/i)
  assert.doesNotMatch(whyCollab, /Aligned with your target role area:/i)
  assert.doesNotMatch(whyCollab, /financial_technology/)

  // General rec is NOT collab → no pre-screen CTA on the client.
  assert.equal(general.collab, false)
  assert.equal(general.status, "recommended")
})

test("runCandidateListMatches treats a collaborated pa-job WITHOUT prescreen questions as non-collab", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({ firebaseUid: "firebase-1", candidateId: "cand-1" })
  await mfs.collection("pa-users").doc("cand-1").set({ tags: { skills: [{ name: "python" }] } })
  await mfs.collection("pa-user-job-recommendations").doc("cand-1").collection("jobs").doc("job-x").set({
    userId: "cand-1",
    jobId: "job-x",
    recommendationCount: 1,
    lastRecommendedAt: "2026-05-14T18:00:00.000Z",
  })
  await mfs.collection("matching-jobs").doc("job-x").set({
    status: "active",
    title: "Engineer",
    companyName: "Co",
    descriptionMd: "Python.",
  })
  // collaborated but no prescreenConfig.questions → not pre-screenable → collab:false.
  await mfs.collection("pa-jobs").doc("job-x").set({
    publicVisible: true,
    wekruitCollaborationStatus: "collaborated",
    title: "Engineer",
    companyName: "Co",
  })

  const result = await runCandidateListMatches(
    { limit: 10 },
    { uid: "firebase-1" },
    { db: asFirestore(mfs), now: () => new Date("2026-05-14T18:30:00.000Z") }
  )
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.jobId, "job-x")
  assert.equal(result.matches[0]!.collab, false)
})

test("runCandidateListMatches surfaces the STORED grounded matchReason on a match card", async () => {
  // Adam directive 2026-05-30: when the matcher persisted a grounded pitch on
  // the candidate-job-match doc, /me surfaces it verbatim — preferred over the
  // legacy `reasons` array, never the weak templates.
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
  await mfs.collection("pa-candidate-job-matches").doc("cand-1__job-helium").set({
    matchId: "cand-1__job-helium",
    candidateId: "cand-1",
    jobId: "job-helium",
    finalRank: 1,
    // The legacy weak reasons co-exist on the doc — the STORED grounded pitch
    // must win.
    reasons: ["Matches your resume skills: react, typescript."],
    matchReason:
      "Full-Stack Engineer at Helium — your React/TS background fits the stack, and it leans into the comp + early equity you said matter most.",
  })
  await mfs.collection("pa-jobs").doc("job-helium").set({
    publicVisible: true,
    prescreenConfig: { jobTitle: "Full-Stack Engineer", company: "Helium" },
  })

  const result = await runCandidateListMatches(
    { limit: 10 },
    { uid: "firebase-1" },
    { db: asFirestore(mfs) }
  )

  assert.equal(result.matches.length, 1)
  assert.deepEqual(result.matches[0]!.whyMatched, [
    "Full-Stack Engineer at Helium — your React/TS background fits the stack, and it leans into the comp + early equity you said matter most.",
  ])
  // The legacy weak template on the same doc is never surfaced.
  assert.doesNotMatch(JSON.stringify(result), /Matches your resume skills:/i)
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

test("runCandidateListMatches maps pending terminal review to candidate reviewing", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
  await mfs.collection("pa-candidate-job-states").doc("cand-1__job-pass").set({
    id: "cand-1__job-pass",
    candidateId: "cand-1",
    jobId: "job-pass",
    state: "prescreen_review_pending",
    prescreenSessionId: "ps-pass",
  })
  await mfs.collection("pa-prescreen-sessions").doc("ps-pass").set({
    sessionId: "ps-pass",
    userId: "cand-1",
    jobId: "job-pass",
    terminal: "PASS",
    terminalActionPendingReview: true,
  })
  await mfs.collection("pa-jobs").doc("job-pass").set({
    publicVisible: true,
    prescreenConfig: { jobTitle: "GTM & Growth Marketing Manager", company: "Paradigm" },
  })

  const result = await runCandidateListMatches({}, { uid: "firebase-1" }, { db: asFirestore(mfs) })

  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.status, "review_pending")
  assert.doesNotMatch(JSON.stringify(result), /terminalActionPendingReview|ps-pass/)
})

test("runCandidateListMatches lets committed state win over stale proposed terminal and exposes approved decision", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
  await mfs.collection("pa-candidate-job-states").doc("cand-1__job-pass").set({
    id: "cand-1__job-pass",
    candidateId: "cand-1",
    jobId: "job-pass",
    state: "not_passed",
    prescreenSessionId: "ps-pass",
  })
  await mfs.collection("pa-prescreen-sessions").doc("ps-pass").set({
    sessionId: "ps-pass",
    userId: "cand-1",
    jobId: "job-pass",
    terminal: "PASS",
    terminalActionPendingReview: false,
    review: {
      status: "overridden",
      finalTerminal: "FAIL",
      candidateDecision: {
        candidateMessageBody: "Thanks for completing the screen. This role is not the right next step.",
        decisionReason: "The role needs direct enterprise GTM ownership, which was not clear in this screen.",
        recommendedActions: ["Add a GTM launch example to your profile.", "Keep your WeKruit profile active for stronger matches."],
        finalTerminal: "FAIL",
        reviewedAt: "2026-05-20T00:00:00.000Z",
        decisionOutboundId: "out-internal",
      },
    },
  })
  await mfs.collection("pa-jobs").doc("job-pass").set({
    publicVisible: true,
    prescreenConfig: { jobTitle: "GTM & Growth Marketing Manager", company: "Paradigm" },
  })

  const result = await runCandidateListMatches({}, { uid: "firebase-1" }, { db: asFirestore(mfs) })

  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.status, "not_passed")
  assert.deepEqual(result.matches[0]!.reviewDecision, {
    candidateMessageBody: "Thanks for completing the screen. This role is not the right next step.",
    decisionReason: "The role needs direct enterprise GTM ownership, which was not clear in this screen.",
    recommendedActions: ["Add a GTM launch example to your profile.", "Keep your WeKruit profile active for stronger matches."],
    finalTerminal: "FAIL",
    reviewedAt: "2026-05-20T00:00:00.000Z",
  })
  assert.doesNotMatch(JSON.stringify(result), /out-internal|decisionOutboundId|terminalActionPendingReview|ps-pass/)
})

test("runCandidateListMatches never exposes candidate decision while review is pending", async () => {
  const mfs = new MockFirestore()
  await mfs.collection("pa-candidate-auth").doc("firebase-1").set({
    firebaseUid: "firebase-1",
    candidateId: "cand-1",
  })
  await mfs.collection("pa-candidate-job-states").doc("cand-1__job-review").set({
    id: "cand-1__job-review",
    candidateId: "cand-1",
    jobId: "job-review",
    state: "prescreen_review_pending",
    prescreenSessionId: "ps-review",
  })
  await mfs.collection("pa-prescreen-sessions").doc("ps-review").set({
    sessionId: "ps-review",
    userId: "cand-1",
    jobId: "job-review",
    terminal: "FAIL",
    terminalActionPendingReview: true,
    review: {
      candidateDecision: {
        candidateMessageBody: "This should not show yet.",
        decisionReason: "Draft only.",
        recommendedActions: ["Draft action"],
        finalTerminal: "FAIL",
        reviewedAt: "2026-05-20T00:00:00.000Z",
      },
    },
  })
  await mfs.collection("pa-jobs").doc("job-review").set({
    publicVisible: true,
    prescreenConfig: { jobTitle: "Frontend Engineer", company: "Review Co" },
  })

  const result = await runCandidateListMatches({}, { uid: "firebase-1" }, { db: asFirestore(mfs) })

  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.status, "review_pending")
  assert.equal(result.matches[0]!.reviewDecision, undefined)
  assert.doesNotMatch(JSON.stringify(result), /This should not show yet|Draft action/)
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
