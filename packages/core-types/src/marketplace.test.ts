import assert from "node:assert/strict"
import test from "node:test"
import {
  CandidateHandleSchema,
  CandidateJobMatchSchema,
  CandidateJobStateDocSchema,
  CandidateProfileMarketplaceFieldsSchema,
  CandidateProfileSchema,
  CorrectionEventSchema,
  EmployerVisibleProfileSchema,
  FeedbackEventSchema,
  OutboundInviteSchema,
  ResumeArtifactSchema,
  createCandidateHandleId,
  createCandidateJobStateId,
  createEmployerVisibleProfileId,
  reduceCandidateJobState,
  reduceCandidateLifecycleState,
  type CandidateJobEvent,
  type CandidateLifecycleEvent,
  type CandidateLifecycleState,
} from "./marketplace.js"

const now = "2026-05-13T12:00:00.000Z"

function lifecycle(type: CandidateLifecycleEvent["type"], over: Partial<CandidateLifecycleEvent> = {}): CandidateLifecycleEvent {
  return {
    eventId: `evt-${type}`,
    candidateId: "cand-1",
    actor: "system",
    occurredAt: now,
    evidence: [{ source: "system", summary: "test" }],
    type,
    ...(over as Record<string, unknown>),
  } as CandidateLifecycleEvent
}

function job(type: CandidateJobEvent["type"], over: Partial<CandidateJobEvent> = {}): CandidateJobEvent {
  return {
    eventId: `evt-${type}`,
    candidateId: "cand-1",
    jobId: "job-1",
    actor: "system",
    occurredAt: now,
    evidence: [{ source: "system", summary: "test" }],
    type,
    ...(over as Record<string, unknown>),
  } as CandidateJobEvent
}

test("marketplace document schemas parse the S1 primitives", () => {
  CandidateProfileMarketplaceFieldsSchema.parse({
    candidateLifecycleState: "profile_ready",
    globalTags: {
      roleFunction: ["software_engineering"],
      skills: [
        {
          name: "typescript",
          bucket: "programming_languages",
          proficiency: "advanced",
        },
      ],
      careerStage: "entry_level",
      industrySector: ["software_and_saas"],
      targetLocations: ["remote_anywhere"],
      visaStatus: "sponsor_needed",
      targetJobType: ["full_time"],
      relevantTags: ["ai_infra"],
      minSalaryUsd: 120000,
      companySizePreference: ["early_startup"],
    },
  })
  CandidateProfileSchema.parse({
    candidateId: "cand-1",
    candidateLifecycleState: "profile_ready",
    createdAt: now,
  })
  CandidateHandleSchema.parse({
    handleId: createCandidateHandleId("email", "a".repeat(64)),
    candidateId: "cand-1",
    kind: "email",
    handleHash: "a".repeat(64),
    source: "resume",
    deliverable: true,
    createdAt: now,
  })
  ResumeArtifactSchema.parse({
    resumeId: "res-1",
    candidateId: "cand-1",
    status: "parsed",
    source: "candidate_upload",
    sha256: "b".repeat(64),
    createdAt: now,
  })
  CandidateJobStateDocSchema.parse({
    id: createCandidateJobStateId("cand-1", "job-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    state: "candidate_matched",
    stateUpdatedAt: now,
  })
  CandidateJobMatchSchema.parse({
    matchId: "cand-1__job-1",
    candidateId: "cand-1",
    jobId: "job-1",
    recommendedAction: "hitl_review",
    createdAt: now,
  })
  OutboundInviteSchema.parse({
    inviteId: "invite-1",
    candidateId: "cand-1",
    jobId: "job-1",
    candidateJobStateId: "cand-1__job-1",
    status: "draft",
    policyDecision: "hitl_review",
    createdAt: now,
  })
  EmployerVisibleProfileSchema.parse({
    snapshotId: createEmployerVisibleProfileId("job-1", "cand-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    candidateJobStateId: "cand-1__job-1",
    createdFromState: "passed",
    createdAt: now,
  })
  FeedbackEventSchema.parse({
    eventId: "fb-1",
    kind: "match_feedback",
    actor: "operator",
    candidateId: "cand-1",
    jobId: "job-1",
    createdAt: now,
  })
  CorrectionEventSchema.parse({
    eventId: "corr-1",
    targetType: "candidate_profile",
    targetId: "cand-1",
    actor: "operator",
    reason: "wrong visa tag",
    createdAt: now,
  })
})

test("candidate lifecycle reducer covers README states and terminal behavior", () => {
  const sequence: CandidateLifecycleState[] = []
  let state: CandidateLifecycleState = "prospect"
  state = reduceCandidateLifecycleState(state, lifecycle("profile_created")).state
  sequence.push(state)
  state = reduceCandidateLifecycleState(
    state,
    lifecycle("handle_linked", { handleKind: "email", verified: true, deliverable: true })
  ).state
  sequence.push(state)
  state = reduceCandidateLifecycleState(state, lifecycle("candidate_claimed")).state
  sequence.push(state)
  state = reduceCandidateLifecycleState(state, lifecycle("profile_ready")).state
  sequence.push(state)
  state = reduceCandidateLifecycleState(state, lifecycle("open_to_opportunities", { confidence: 0.91 })).state
  sequence.push(state)
  state = reduceCandidateLifecycleState(state, lifecycle("retention_allowed")).state
  sequence.push(state)
  state = reduceCandidateLifecycleState(state, lifecycle("opt_out_requested")).state
  sequence.push(state)
  state = reduceCandidateLifecycleState(state, lifecycle("explicit_opt_in")).state
  sequence.push(state)
  state = reduceCandidateLifecycleState(state, lifecycle("delete_fulfilled")).state
  sequence.push(state)

  assert.deepEqual(sequence, [
    "profile_created",
    "reachable",
    "claimed",
    "profile_ready",
    "active_job_seeker",
    "retained",
    "opted_out",
    "retained",
    "deleted",
  ])
  assert.equal(reduceCandidateLifecycleState("deleted", lifecycle("explicit_opt_in")).state, "deleted")
})

test("low-confidence opportunity signal is evidence, not direct lifecycle mutation", () => {
  const result = reduceCandidateLifecycleState(
    "profile_ready",
    lifecycle("open_to_opportunities", { confidence: 0.2 })
  )
  assert.equal(result.state, "profile_ready")
  assert.equal(result.changed, false)
})

test("candidate-job reducer preserves first-interview and NOT_PASS locks", () => {
  let state = reduceCandidateJobState("candidate_matched", job("prescreen_started", { matchScore: 0.01 })).state
  assert.equal(state, "prescreen_started", "match score must not block first interview")

  state = reduceCandidateJobState(state, job("prescreen_not_passed")).state
  assert.equal(state, "not_passed")

  const global = reduceCandidateLifecycleState("active_job_seeker", lifecycle("retention_allowed"))
  assert.equal(global.state, "retained", "NOT_PASS is not a global exit")
})

test("candidate-job reducer requires passed state before employer visibility", () => {
  const blocked = reduceCandidateJobState("prescreen_started", job("employer_snapshot_created"))
  assert.equal(blocked.state, "prescreen_started")
  assert.equal(blocked.changed, false)
  assert.equal(blocked.reason, "employer_visible_requires_passed_state")

  const passed = reduceCandidateJobState("prescreen_started", job("prescreen_passed")).state
  const visible = reduceCandidateJobState(passed, job("employer_snapshot_created"))
  assert.equal(visible.state, "employer_visible")
})

test("document id helpers do not require raw PII", () => {
  assert.equal(createCandidateJobStateId("cand-1", "job-1"), "cand-1__job-1")
  assert.equal(createEmployerVisibleProfileId("job-1", "cand-1"), "job-1__cand-1")
  assert.equal(createCandidateHandleId("email", "f".repeat(64)), `email__${"f".repeat(64)}`)
})
