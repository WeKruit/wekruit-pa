import assert from "node:assert/strict"
import test from "node:test"
import {
  EvalArtifactSchema,
  PA_COLLECTIONS,
  createEvalArtifactId,
  reduceCandidateJobState,
} from "../../../packages/core-types/src/index.js"
import {
  correctionEvent,
  evalArtifact,
  prescreenFeedbackEvent,
} from "./fixtures.js"

test("S8 correction eval artifact is deterministic, redacted, and sourced", () => {
  const correction = correctionEvent()
  const artifact = EvalArtifactSchema.parse(evalArtifact({
    artifactId: createEvalArtifactId("correction_regression_fixture", correction.eventId),
    sourceCorrectionEventIds: [correction.eventId],
  }))

  assert.equal(PA_COLLECTIONS.evalArtifacts, "pa-eval-artifacts")
  assert.equal(artifact.artifactId, createEvalArtifactId("correction_regression_fixture", correction.eventId))
  assert.deepEqual(artifact.sourceCorrectionEventIds, [correction.eventId])
  assert.equal(artifact.candidateId, correction.candidateId)
  assert.equal(artifact.jobId, correction.jobId)
  assert.doesNotMatch(JSON.stringify(artifact), /@|linkedin\.com|gs:\/\/|rawPrompt|rawTranscript/i)
})

test("S8 candidate self-correction fixture remains open-ended but artifact-safe", () => {
  const correction = correctionEvent({
    eventId: "corr-s8-candidate-open-ended",
    actor: "candidate",
    targetType: "candidate_profile",
    reason: "Candidate provided an open-ended preference correction; raw user text is not copied into eval payload.",
    beforeRedacted: { roleFocus: "frontend" },
    afterRedacted: { roleFocus: "product_design_engineering", locationPreference: "country_us_then_bay_area" },
  })
  const artifact = EvalArtifactSchema.parse(evalArtifact({
    artifactId: createEvalArtifactId("candidate_profile_correction", correction.eventId),
    kind: "candidate_profile_correction",
    sourceCorrectionEventIds: [correction.eventId],
    createdBy: "candidate",
    payloadRedacted: {
      targetType: correction.targetType,
      appliedKeys: ["roleFocus", "locationPreference"],
      reviewState: "needs_review",
    },
  }))

  assert.equal(artifact.kind, "candidate_profile_correction")
  assert.equal(artifact.createdBy, "candidate")
  assert.deepEqual(artifact.payloadRedacted.appliedKeys, ["roleFocus", "locationPreference"])
})

test("S8 prescreen feedback artifact uses event ids and summaries, not raw turns", () => {
  const feedback = prescreenFeedbackEvent()
  const artifact = EvalArtifactSchema.parse(evalArtifact({
    artifactId: createEvalArtifactId("marketplace_simulation", feedback.eventId),
    kind: "marketplace_simulation",
    sourceCorrectionEventIds: [],
    sourceFeedbackEventIds: [feedback.eventId],
    payloadRedacted: {
      terminal: "PASS",
      scoreBucket: "strong",
      expectedState: "employer_visible",
    },
    evidence: feedback.evidence,
  }))

  assert.deepEqual(artifact.sourceFeedbackEventIds, [feedback.eventId])
  assert.doesNotMatch(JSON.stringify(artifact), /candidate@example|rawTranscript|rawPrompt|full interview turn text/i)
})

test("S8 eval artifacts reject raw prompts, transcripts, contact data, and storage locators", () => {
  const base = evalArtifact()
  const unsafeCases = [
    { payloadRedacted: { rawPrompt: "rank this candidate" } },
    { payloadRedacted: { rawTranscript: "full interview turn text" } },
    { payloadRedacted: { note: "candidate@example.com" } },
    { payloadRedacted: { note: "+1 415 555 0101" } },
    { payloadRedacted: { note: "https://www.linkedin.com/in/raw-profile" } },
    { payloadRedacted: { note: "gs://wekruit-private/resumes/raw.pdf" } },
  ]

  for (const unsafe of unsafeCases) {
    assert.throws(
      () => EvalArtifactSchema.parse({ ...base, ...unsafe }),
      /raw PII, storage locators, prompts, or transcripts/
    )
  }
})

test("S8 keeps first interview independent of match score and keeps NOT_PASS retained", () => {
  const started = reduceCandidateJobState("candidate_matched", {
    eventId: "evt-s8-start-low-score",
    type: "prescreen_started",
    actor: "candidate",
    candidateId: "cand-s8-low-score",
    jobId: "job-s8-product-designer",
    prescreenSessionId: "ps-s8-low-score",
    occurredAt: "2026-05-14T12:00:00.000Z",
    matchScore: 0.01,
  })
  assert.equal(started.state, "prescreen_started")
  assert.equal(started.reason, "first_interview_started")

  const notPassed = reduceCandidateJobState(started.state, {
    eventId: "evt-s8-not-pass",
    type: "prescreen_not_passed",
    actor: "system",
    candidateId: "cand-s8-low-score",
    jobId: "job-s8-product-designer",
    prescreenSessionId: "ps-s8-low-score",
    occurredAt: "2026-05-14T12:01:00.000Z",
  })
  assert.equal(notPassed.state, "not_passed")
  assert.equal(notPassed.reason, "candidate_retained_for_other_jobs")
})
