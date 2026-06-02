import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { PA_COLLECTIONS, createEvalArtifactId } from "@pa/core-types"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  buildFlywheelFeedbackEvent,
  materializeEvalArtifactForCorrection,
  runAdminFlywheelEvalSnapshot,
  runFlywheelMarketplaceSimulation,
  type FlywheelSimulationInput,
} from "../flywheel-eval.js"

const now = "2026-05-14T12:00:00.000Z"

function json(value: unknown): string {
  return JSON.stringify(value)
}

describe("flywheel eval builders", () => {
  it("builds redacted candidate behavior feedback without raw payload leakage", () => {
    const event = buildFlywheelFeedbackEvent({
      eventId: "feedback-prescreen-1",
      behavior: "prescreen_pass",
      candidateId: "cand-1",
      jobId: "job-1",
      candidateJobStateId: "cand-1__job-1",
      outcome: "passed",
      signals: {
        scoreBucket: "high",
        transcriptText: "email candidate@example.com transcript raw",
        storageUri: "gs://bucket/resume.pdf",
      },
      createdAt: now,
    })

    assert.equal(event.kind, "candidate_behavior")
    assert.equal(event.actor, "system")
    assert.deepEqual(event.payloadRedacted, {
      behavior: "prescreen_pass",
      scoreBucket: "high",
    })
    assert.doesNotMatch(json(event), /candidate@example\.com|gs:\/\/|transcript raw/)
  })

  it("materializes correction artifacts with deterministic ids and no raw free text", () => {
    const artifact = materializeEvalArtifactForCorrection({
      correction: {
        eventId: "corr-1",
        targetType: "candidate_profile",
        targetId: "cand-1",
        actor: "candidate",
        candidateId: "cand-1",
        reason: "My email is candidate@example.com and the transcript says raw text",
        beforeRedacted: { targetRoleFunction: ["sales"] },
        afterRedacted: { targetRoleFunction: ["software_engineering"] },
        evidence: [],
        createdAt: now,
      },
      createdAt: now,
    })

    assert.equal(artifact.artifactId, createEvalArtifactId("candidate_profile_correction", "corr-1"))
    assert.equal(artifact.kind, "candidate_profile_correction")
    assert.equal(artifact.createdBy, "candidate")
    assert.deepEqual(artifact.sourceCorrectionEventIds, ["corr-1"])
    assert.doesNotMatch(json(artifact), /candidate@example\.com|transcript says raw text|reason/)
  })
})

describe("runFlywheelMarketplaceSimulation", () => {
  it("is deterministic and never writes outbound rows", () => {
    const input: FlywheelSimulationInput = {
      scenarioRef: "sim-basic",
      candidates: [
        { candidateId: "cand-a", tags: ["react", "ai"] },
        { candidateId: "cand-b", tags: ["sales"] },
      ],
      jobs: [
        { jobId: "job-a", tags: ["react"], active: true },
        { jobId: "job-b", tags: ["sales"], active: false },
      ],
      events: [
        { kind: "prescreen_pass", candidateId: "cand-a", jobId: "job-a" },
        { kind: "outbound_delivery", candidateId: "cand-b", jobId: "job-b" },
      ],
    }

    const first = runFlywheelMarketplaceSimulation(input)
    const second = runFlywheelMarketplaceSimulation(input)

    assert.deepEqual(first, second)
    assert.equal(first.dryRun, true)
    assert.equal(first.counts.outboundWrites, 0)
    assert.equal(first.counts.candidates, 2)
    assert.equal(first.counts.jobs, 2)
    assert.equal(first.counts.generatedArtifactSummaries, 2)
    assert.deepEqual(first.artifacts.map((artifact) => artifact.artifactId), [
      "sim_marketplace_simulation__sim-basic__000",
      "sim_marketplace_simulation__sim-basic__001",
    ])
  })
})

describe("runAdminFlywheelEvalSnapshot", () => {
  it("aggregates recent eval artifacts, feedback, and corrections", async () => {
    const mfs = new MockFirestore()
    await mfs.collection(PA_COLLECTIONS.evalArtifacts).doc("artifact-1").set({
      artifactId: "artifact-1",
      kind: "marketplace_simulation",
      status: "ready",
      sourceFeedbackEventIds: ["feedback-1"],
      scenarioRef: "sim",
      payloadRedacted: { ok: true },
      createdBy: "system",
      createdAt: "2026-05-14T10:00:00.000Z",
    })
    await mfs.collection(PA_COLLECTIONS.feedbackEvents).doc("feedback-1").set({
      eventId: "feedback-1",
      kind: "candidate_behavior",
      actor: "system",
      candidateId: "cand-1",
      outcome: "passed",
      payloadRedacted: { behavior: "prescreen_pass" },
      createdAt: "2026-05-14T10:01:00.000Z",
    })
    await mfs.collection(PA_COLLECTIONS.feedbackEvents).doc("feedback-2").set({
      eventId: "feedback-2",
      kind: "employer_action",
      actor: "employer",
      candidateId: "cand-2",
      jobId: "job-2",
      candidateJobStateId: "cand-2__job-2",
      outcome: "intro_rejected",
      payloadRedacted: { decision: "rejected" },
      evidence: [{ source: "admin", summary: "Employer rejected intro after review." }],
      createdAt: "2026-05-14T10:03:00.000Z",
    })
    await mfs.collection(PA_COLLECTIONS.feedbackEvents).doc("feedback-3").set({
      eventId: "feedback-3",
      kind: "recruiter_submission_feedback",
      actor: "operator",
      jobId: "job-3",
      outcome: "advanced",
      payloadRedacted: {
        submissionId: "sub-3",
        recruiterId: "recruiter-1",
        status: "advanced",
        previousStatus: "reviewing",
        statusChanged: true,
        feedbackChanged: true,
        rating: 4,
        reasonIds: ["strong_match"],
        hasFeedbackNote: true,
        source: "recruiter_board_admin",
      },
      evidence: [{ source: "admin", summary: "Recruiter submission review updated", refId: "sub-3" }],
      createdAt: "2026-05-14T10:04:00.000Z",
    })
    await mfs.collection(PA_COLLECTIONS.feedbackEvents).doc("feedback-4").set({
      eventId: "feedback-4",
      kind: "recruiter_role_application_decision",
      actor: "operator",
      jobId: "job-4",
      outcome: "approved",
      payloadRedacted: {
        applicationId: "app-4",
        recruiterId: "recruiter-1",
        status: "approved",
        previousStatus: "pending",
        statusChanged: true,
        preparedCandidateCount: 2,
        anonymizeCandidates: false,
        adminReviewRecommendation: "approve",
        adminReviewQualityScore: 82,
        hasAdminNote: true,
        source: "recruiter_board_admin",
      },
      evidence: [{ source: "admin", summary: "Recruiter role application approved", refId: "app-4" }],
      createdAt: "2026-05-14T10:05:00.000Z",
    })
    await mfs.collection(PA_COLLECTIONS.feedbackEvents).doc("feedback-5").set({
      eventId: "feedback-5",
      kind: "recruiter_role_feedback",
      actor: "worker",
      jobId: "job-5",
      outcome: "hard",
      payloadRedacted: {
        feedbackId: "role-feedback-5",
        recruiterId: "recruiter-1",
        difficulty: "hard",
        reasonIds: ["small_candidate_pool"],
        hasNote: true,
        source: "recruiter_board",
      },
      evidence: [{ source: "system", summary: "Recruiter role feedback submitted", refId: "role-feedback-5" }],
      createdAt: "2026-05-14T10:06:00.000Z",
    })
    await mfs.collection(PA_COLLECTIONS.correctionEvents).doc("corr-1").set({
      eventId: "corr-1",
      targetType: "candidate_profile",
      targetId: "cand-1",
      actor: "candidate",
      candidateId: "cand-1",
      reason: "raw text can stay in correction",
      beforeRedacted: {},
      afterRedacted: { skills: ["typescript"] },
      createdAt: "2026-05-14T10:02:00.000Z",
    })

    const result = await runAdminFlywheelEvalSnapshot(
      { limit: 10 },
      { db: asFirestore(mfs), now: () => now },
    )

    assert.equal(result.generatedAt, now)
    assert.deepEqual(result.counts, {
      evalArtifacts: 1,
      feedbackEvents: 5,
      correctionEvents: 1,
      artifactsByKind: { marketplace_simulation: 1 },
      artifactsByStatus: { ready: 1 },
      correctionsByTarget: { candidate_profile: 1 },
      correctionsByActor: { candidate: 1 },
      feedbackByKind: { candidate_behavior: 1, employer_action: 1, recruiter_submission_feedback: 1, recruiter_role_application_decision: 1, recruiter_role_feedback: 1 },
      feedbackByOutcome: { passed: 1, intro_rejected: 1, advanced: 1, approved: 1, hard: 1 },
      employerIntroByOutcome: { intro_rejected: 1 },
    })
    assert.equal(result.recentArtifacts[0]!.artifactId, "artifact-1")
    assert.equal(result.recentCorrections[0]!.eventId, "corr-1")
    assert.equal(result.recentFeedback[0]!.eventId, "feedback-5")
    assert.equal(result.recentFeedback[0]!.kind, "recruiter_role_feedback")
    assert.doesNotMatch(json(result.recentFeedback[0]), /candidate@example\.com|linkedin\.com|raw admin note|raw pitch|raw role feedback/)
    assert.equal(result.recentFeedback[1]!.eventId, "feedback-4")
    assert.equal(result.recentFeedback[1]!.kind, "recruiter_role_application_decision")
    assert.doesNotMatch(json(result.recentFeedback[1]), /candidate@example\.com|linkedin\.com|raw admin note|raw pitch/)
    assert.equal(result.recentFeedback[2]!.eventId, "feedback-3")
    assert.equal(result.recentFeedback[2]!.kind, "recruiter_submission_feedback")
    assert.doesNotMatch(json(result.recentFeedback[2]), /candidate@example\.com|linkedin\.com|raw admin note/)
    assert.equal(result.recentFeedback[3]!.eventId, "feedback-2")
    assert.deepEqual(result.recentFeedback[3]!.payloadRedacted, { decision: "rejected" })
    assert.equal(result.recentFeedback[4]!.eventId, "feedback-1")
    assert.deepEqual(result.recentFeedback[4]!.payloadRedacted, { behavior: "prescreen_pass" })
  })
})
