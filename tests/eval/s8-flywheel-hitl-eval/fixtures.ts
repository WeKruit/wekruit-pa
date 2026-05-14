import type {
  CorrectionEvent,
  EvalArtifact,
  FeedbackEvent,
} from "../../../packages/core-types/src/index.js"

export const now = "2026-05-14T12:00:00.000Z"
export const candidateId = "cand-s8-redacted"
export const jobId = "job-s8-product-designer"
export const correctionEventId = "corr-s8-profile-tags-1"
export const feedbackEventId = "feedback-s8-prescreen-pass-1"
export const scenarioRef = "tests/scenarios/s8-flywheel-hitl-eval/correction-to-artifact.yaml"

export function correctionEvent(over: Partial<CorrectionEvent> = {}): CorrectionEvent {
  return {
    eventId: correctionEventId,
    targetType: "user_tags",
    targetId: candidateId,
    actor: "operator",
    candidateId,
    jobId,
    reason: "Operator corrected redacted candidate tag projection after HITL review.",
    beforeRedacted: {
      skills: ["react"],
      targetLocations: ["remote_us"],
    },
    afterRedacted: {
      skills: ["react", "figma"],
      targetLocations: ["remote_us", "sf_bay_area"],
    },
    evidence: [
      {
        source: "admin",
        summary: "Redacted correction from S8 fixture.",
        refId: "review-s8-1",
      },
    ],
    createdAt: now,
    ...over,
  }
}

export function candidateCorrectionEvent(over: Partial<CorrectionEvent> = {}): CorrectionEvent {
  return correctionEvent({
    eventId: "corr-s8-candidate-self-1",
    targetType: "candidate_profile",
    actor: "candidate",
    reason: "Candidate updated redacted preference summary from profile page.",
    beforeRedacted: {
      preferredRole: "frontend",
    },
    afterRedacted: {
      preferredRole: "product_design_engineering",
      workPreference: "hybrid_or_remote",
    },
    evidence: [
      {
        source: "conversation",
        summary: "Candidate-authored profile correction with raw text removed.",
        refId: "self-profile-correction-s8-1",
      },
    ],
    ...over,
  })
}

export function prescreenFeedbackEvent(over: Partial<FeedbackEvent> = {}): FeedbackEvent {
  return {
    eventId: feedbackEventId,
    kind: "prescreen_outcome",
    actor: "system",
    candidateId,
    jobId,
    candidateJobStateId: `${candidateId}__${jobId}`,
    outcome: "PASS",
    payloadRedacted: {
      terminal: "PASS",
      scoreBucket: "strong",
      source: "first_interview",
    },
    evidence: [
      {
        source: "prescreen",
        summary: "Candidate passed first interview; raw turns omitted.",
        refId: "ps-s8-pass",
      },
    ],
    createdAt: now,
    ...over,
  }
}

export function evalArtifact(over: Partial<EvalArtifact> = {}): EvalArtifact {
  return {
    artifactId: "eval_artifact_correction_regression_fixture__s8_redacted",
    kind: "correction_regression_fixture",
    status: "ready",
    sourceCorrectionEventIds: [correctionEventId],
    sourceFeedbackEventIds: [],
    scenarioRef,
    candidateId,
    jobId,
    payloadRedacted: {
      targetType: "user_tags",
      beforeRedacted: { skills: ["react"] },
      afterRedacted: { skills: ["react", "figma"] },
      expectedFlywheelUse: "regression_fixture",
    },
    evidence: [
      {
        source: "admin",
        summary: "Redacted S8 eval artifact fixture.",
        refId: "review-s8-1",
      },
    ],
    latestRunResult: {
      status: "not_run",
      command: "pnpm --dir tests/eval/s8-flywheel-hitl-eval test",
      summary: "Fixture is redacted and ready for deterministic replay.",
      metrics: { outboundWrites: 0 },
    },
    createdBy: "operator",
    createdAt: now,
    ...over,
  }
}
