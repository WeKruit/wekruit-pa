import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { HttpsError } from "firebase-functions/v2/https"
import { createCandidateJobStateId, createEmployerVisibleProfileId, PA_COLLECTIONS } from "@pa/core-types"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  runAdminPassedCandidateIntroDecision,
  runAdminPassedCandidatesSnapshot,
} from "../admin-passed-candidates.js"

const now = "2026-05-13T20:00:00.000Z"

function snapshot(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshotId: createEmployerVisibleProfileId("job-1", "cand-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    candidateJobStateId: createCandidateJobStateId("cand-1", "job-1"),
    createdFromState: "passed",
    displayName: "Candidate One",
    resumeSummary: "Built React recruiting tools.",
    passReason: "Strong first interview",
    matchReason: "React and product design match",
    consentAt: now,
    createdAt: now,
    createdBy: "system",
    ...patch,
  }
}

async function seedState(mfs: MockFirestore, candidateId = "cand-1", jobId = "job-1", patch: Record<string, unknown> = {}) {
  await mfs.collection(PA_COLLECTIONS.candidateJobStates).doc(createCandidateJobStateId(candidateId, jobId)).set({
    id: createCandidateJobStateId(candidateId, jobId),
    candidateId,
    jobId,
    state: "passed",
    stateUpdatedAt: now,
    prescreenSessionId: `session-${candidateId}`,
    ...patch,
  })
}

describe("runAdminPassedCandidatesSnapshot", () => {
  it("rejects blank jobId input", async () => {
    const mfs = new MockFirestore()
    await assert.rejects(
      () => runAdminPassedCandidatesSnapshot({ jobId: "   " }, { db: asFirestore(mfs), now: () => now }),
      (err) => err instanceof HttpsError && err.code === "invalid-argument",
    )
  })

  it("lists only passed employer-visible snapshots for the requested job", async () => {
    const mfs = new MockFirestore()
    await seedState(mfs)
    await mfs.collection(PA_COLLECTIONS.employerVisibleProfiles).doc("job-1__cand-1").set(snapshot())
    await mfs.collection(PA_COLLECTIONS.employerVisibleProfiles).doc("job-1__cand-2").set(snapshot({
      snapshotId: "job-1__cand-2",
      candidateId: "cand-2",
      candidateJobStateId: createCandidateJobStateId("cand-2", "job-1"),
      createdFromState: "not_passed",
    }))
    await mfs.collection(PA_COLLECTIONS.employerVisibleProfiles).doc("job-2__cand-3").set(snapshot({
      snapshotId: "job-2__cand-3",
      candidateId: "cand-3",
      jobId: "job-2",
      candidateJobStateId: createCandidateJobStateId("cand-3", "job-2"),
    }))
    await mfs.collection(PA_COLLECTIONS.users).doc("cand-1").set({
      displayName: "Global Name",
      piiConsentAt: now,
      level1Status: "complete",
      email: "do-not-return@example.com",
      phoneE164: "+15555550100",
      linkedinUrl: "https://linkedin.com/in/private",
    })

    const result = await runAdminPassedCandidatesSnapshot(
      { jobId: "job-1", limit: 500 },
      { db: asFirestore(mfs), now: () => now },
    )

    assert.equal(result.filters.jobId, "job-1")
    assert.equal(result.filters.limit, 100)
    assert.equal(result.summary.totalPassedSnapshots, 1)
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0]!.candidateId, "cand-1")
    assert.equal(result.rows[0]!.displayName, "Candidate One")
    assert.equal(result.rows[0]!.profile.piiConsentAt, now)
    assert.deepEqual(Object.keys(result.rows[0]!).filter((key) => /email|phone|linkedin/i.test(key)), [])
    assert.doesNotMatch(JSON.stringify(result), /do-not-return@example\.com|\+15555550100|linkedin\.com/)
  })

  it("drops snapshots whose linked candidate-job state is not passed for the same candidate and job", async () => {
    const mfs = new MockFirestore()
    await seedState(mfs, "cand-1", "job-1", { state: "not_passed" })
    await mfs.collection(PA_COLLECTIONS.employerVisibleProfiles).doc("job-1__cand-1").set(snapshot())

    const result = await runAdminPassedCandidatesSnapshot(
      { jobId: "job-1", limit: 10 },
      { db: asFirestore(mfs), now: () => now },
    )

    assert.equal(result.rows.length, 0)
    assert.equal(result.summary.droppedStateMismatch, 1)
  })

  it("projects transcript turns through linked prescreenSessionId and redacts contact/resume text", async () => {
    const mfs = new MockFirestore()
    await seedState(mfs)
    await mfs.collection(PA_COLLECTIONS.employerVisibleProfiles).doc("job-1__cand-1").set(snapshot())
    await mfs.collection("pa-prescreen-sessions/session-cand-1/turns").doc("m1").set({
      id: "m1",
      qId: "q_react_experience",
      body: "Email me at candidate@example.com or +1 555 555 0100; resume https://cdn.example.com/resume.pdf linkedin https://linkedin.com/in/private @private_handle",
      ts: now,
    })
    await mfs.collection("pa-prescreen-sessions/other-session/turns").doc("m2").set({
      id: "m2",
      body: "wrong session should not appear",
      ts: now,
    })

    const result = await runAdminPassedCandidatesSnapshot(
      { jobId: "job-1" },
      { db: asFirestore(mfs), now: () => now },
    )

    assert.equal(result.rows[0]!.transcript.prescreenSessionId, "session-cand-1")
    assert.equal(result.rows[0]!.transcript.turns.length, 1)
    assert.match(result.rows[0]!.transcript.turns[0]!.body, /\[redacted email\]/)
    assert.match(result.rows[0]!.transcript.turns[0]!.body, /\[redacted phone\]/)
    assert.match(result.rows[0]!.transcript.turns[0]!.body, /\[redacted resume\]/)
    assert.match(result.rows[0]!.transcript.turns[0]!.body, /\[redacted linkedin\]/)
    assert.match(result.rows[0]!.transcript.turns[0]!.body, /\[redacted handle\]/)
    assert.doesNotMatch(JSON.stringify(result), /candidate@example\.com|\+1 555 555 0100|resume\.pdf|linkedin\.com|@private_handle|wrong session/)
  })

  it("records employer intro decisions through the passed-profile boundary", async () => {
    const mfs = new MockFirestore()
    await seedState(mfs, "cand-1", "job-1", {
      state: "employer_visible",
      employerVisibleProfileId: "job-1__cand-1",
    })
    await mfs.collection(PA_COLLECTIONS.employerVisibleProfiles).doc("job-1__cand-1").set(snapshot())

    const result = await runAdminPassedCandidateIntroDecision(
      {
        snapshotId: "job-1__cand-1",
        decision: "rejected",
        reason: "Hiring manager needs deeper distributed systems ownership from candidate@example.com.",
      },
      {
        db: asFirestore(mfs),
        now: () => now,
        actorEmail: "operator@wekruit.com",
      },
    )

    assert.equal(result.ok, true)
    assert.equal(result.state, "intro_rejected")
    assert.equal(result.decision, "rejected")
    assert.equal(result.feedbackEventId, "fb-employer-intro-rejected-job-1__cand-1")

    const state = mfs.store.get(PA_COLLECTIONS.candidateJobStates)!.get(createCandidateJobStateId("cand-1", "job-1"))!
    assert.equal(state.state, "intro_rejected")
    assert.equal(state.latestEmployerFeedbackEventId, result.feedbackEventId)

    const feedback = mfs.store.get(PA_COLLECTIONS.feedbackEvents)!.get(result.feedbackEventId)!
    assert.equal(feedback.kind, "employer_action")
    assert.equal(feedback.outcome, "intro_rejected")
    assert.match(String((feedback.payloadRedacted as Record<string, unknown>).reason), /\[redacted email\]/)
    assert.doesNotMatch(JSON.stringify(feedback), /candidate@example\.com/)

    const refreshed = await runAdminPassedCandidatesSnapshot(
      { jobId: "job-1" },
      { db: asFirestore(mfs), now: () => now },
    )
    assert.equal(refreshed.rows[0]!.state, "intro_rejected")
    assert.equal(refreshed.rows[0]!.latestEmployerAction?.status, "rejected")
    assert.match(refreshed.rows[0]!.latestEmployerAction?.reason ?? "", /\[redacted email\]/)
  })
})
