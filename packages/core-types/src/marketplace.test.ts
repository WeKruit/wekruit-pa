import assert from "node:assert/strict"
import test from "node:test"
import {
  BulkResumeBatchSchema,
  BulkResumeItemSchema,
  CandidateHandleSchema,
  CandidateAuthMappingSchema,
  CandidateIdentityConflictSchema,
  CandidateIdentityEventSchema,
  CandidateIdentityResolutionSchema,
  CandidateJobEventSchema,
  CandidateJobMatchSchema,
  CandidateJobStateDocSchema,
  CandidateProfileMarketplaceFieldsSchema,
  CandidateProfileSchema,
  CandidateSelfProfileSchema,
  CorrectionEventSchema,
  EmployerVisibleProfileSchema,
  EvalArtifactSchema,
  FeedbackEventSchema,
  JobPresentedSourceSchema,
  makeJobPresentedEvent,
  JobEnrichmentEvalFixtureSchema,
  JobOpportunityDraftSchema,
  JobOpportunitySchema,
  JobOpportunityPublicSchema,
  LaunchReadinessSnapshotSchema,
  OutreachStopControlSchema,
  OutreachDecisionSchema,
  OutboundInviteSchema,
  PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION,
  PA_JOB_ENRICHMENT_SUBCOLLECTION,
  PrivacyRequestSchema,
  ResumeArtifactSchema,
  candidateHandleHashMaterial,
  canTransitionBulkResumeItemStatus,
  canTransitionJobEnrichmentDraftStatus,
  createCandidateHandleId,
  createCandidateJobMatchId,
  createCandidateJobStateId,
  createBulkResumeArtifactId,
  createBulkResumeItemId,
  createBulkResumeItemIdempotencyKey,
  createEmployerVisibleProfileId,
  createEvalArtifactId,
  createJobEnrichmentEvalFixtureId,
  createJobEnrichmentDraftId,
  createJobOpportunityDraftId,
  createLaunchReadinessSnapshotId,
  createOutreachDuplicateSuppressionKey,
  createOutreachIdempotencyKey,
  createOutreachStopControlId,
  createOutboundInviteId,
  createPrivacyRequestId,
  normalizeCandidateHandleValue,
  reduceBulkResumeItemStatus,
  reduceCandidateJobState,
  reduceCandidateLifecycleState,
  reduceJobEnrichmentDraftStatus,
  summarizeBulkResumeItemCounts,
  summarizeJobEnrichmentDraftCounts,
  toPublicJobOpportunity,
  type BulkResumeItemStatus,
  type CandidateJobEvent,
  type CandidateLifecycleEvent,
  type CandidateLifecycleState,
} from "./marketplace.js"
import {
  PA_COLLECTIONS,
  PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION,
  PA_JOB_ENRICHMENT_SUBCOLLECTION,
} from "./collections.js"

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
  const prescreenFields = [
    "prescreen_started",
    "prescreen_review_pending",
    "prescreen_passed",
    "prescreen_not_passed",
    "manual_pause",
  ].includes(type)
    ? { prescreenSessionId: "ps-job-1-cand-1" }
    : {}
  const employerFields =
    type === "employer_snapshot_created"
      ? { employerVisibleProfileId: createEmployerVisibleProfileId("job-1", "cand-1") }
      : {}
  return {
    eventId: `evt-${type}`,
    candidateId: "cand-1",
    jobId: "job-1",
    actor: "system",
    occurredAt: now,
    evidence: [{ source: "system", summary: "test" }],
    type,
    ...prescreenFields,
    ...employerFields,
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
    matchId: createCandidateJobMatchId("cand-1", "job-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    direction: "job_to_candidate",
    matchVersion: "s5-test",
    jobEnrichmentVersion: "job-enrich-v1",
    computedAt: now,
    scoreBreakdown: {
      skills: { score: 0.8, weight: 0.5, summary: "TypeScript and React match" },
      location: { score: 1, weight: 0.2 },
    },
    matchedSignals: ["typescript", "remote_anywhere"],
    blockedSignals: [],
    candidateLifecycleStateAtMatch: "retained",
    candidateTagsUpdatedAt: now,
    hardFilterResult: "soft_block",
    recommendedAction: "hitl_review",
    createdAt: now,
  })
  OutboundInviteSchema.parse({
    inviteId: createOutboundInviteId("cand-1", "job-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    candidateJobStateId: "cand-1__job-1",
    status: "draft",
    policyDecision: "hitl_review",
    approvalState: "pending",
    dryRun: true,
    policyVersion: "s6-outreach-policy-v1",
    decisionReason: "operator review required",
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
  FeedbackEventSchema.parse({
    eventId: "fb-candidate-behavior-1",
    kind: "candidate_behavior",
    actor: "candidate",
    candidateId: "cand-1",
    jobId: "job-1",
    outcome: "profile_correction_requested",
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
  CorrectionEventSchema.parse({
    eventId: "corr-outbound-copy-1",
    targetType: "outbound_copy",
    targetId: "outinvite-cand-1-job-1",
    actor: "system",
    candidateId: "cand-1",
    jobId: "job-1",
    reason: "copy caused candidate decline",
    createdAt: now,
  })
  CorrectionEventSchema.parse({
    eventId: "corr-candidate-1",
    targetType: "user_tags",
    targetId: "cand-1",
    actor: "candidate",
    candidateId: "cand-1",
    reason: "candidate corrected location preference",
    beforeRedacted: { targetLocations: ["remote_anywhere"] },
    afterRedacted: { targetLocations: ["sf_bay_area"] },
    createdAt: now,
  })
  // V2 external-supply Wave A — operator HITL override on an agent ranking row.
  CorrectionEventSchema.parse({
    eventId: "corr-agent-rank-1",
    targetType: "agent_ranking_result",
    targetId: "agent-rank__" + "a".repeat(64),
    actor: "operator",
    candidateId: "cand-1",
    jobId: "job-1",
    reason: "operator downgraded proposed tier_2 to retain_only",
    beforeRedacted: { proposedAgentTier: "tier_2_personal_email" },
    afterRedacted: { approvedTier: "retain_only" },
    createdAt: now,
  })
  EvalArtifactSchema.parse({
    artifactId: createEvalArtifactId("candidate_profile_correction", "corr-candidate-1"),
    kind: "candidate_profile_correction",
    status: "ready",
    sourceCorrectionEventIds: ["corr-candidate-1"],
    candidateId: "cand-1",
    payloadRedacted: {
      field: "targetLocations",
      before: ["remote_anywhere"],
      after: ["sf_bay_area"],
    },
    createdBy: "candidate",
    createdAt: now,
  })
  CandidateAuthMappingSchema.parse({
    firebaseUid: "firebase-uid-1",
    candidateId: "cand-1",
    emailHandleId: createCandidateHandleId("email", "c".repeat(64)),
    emailHandleHash: "c".repeat(64),
    createdAt: now,
    lastClaimedAt: now,
  })
  CandidateSelfProfileSchema.parse({
    candidateId: "cand-1",
    lifecycleState: "claimed",
    emailMasked: "a***@example.com",
    handles: [{ kind: "email", verifiedAt: now, source: "candidate" }],
    createdAt: now,
  })
  CandidateIdentityEventSchema.parse({
    eventId: "ident-1",
    type: "candidate_claimed",
    actor: "candidate",
    candidateId: "cand-1",
    source: "auth",
    createdAt: now,
  })
  CandidateIdentityConflictSchema.parse({
    conflictId: "conflict-1",
    kind: "pdf_email_employer_email_mismatch",
    pdfEmailHash: "d".repeat(64),
    employerEmailHash: "e".repeat(64),
    evidence: [{ source: "resume_parse", summary: "PDF email differs from employer hint" }],
    createdAt: now,
  })
  CandidateIdentityResolutionSchema.parse({
    outcome: "identity_conflict",
    conflict: {
      conflictId: "conflict-1",
      kind: "pdf_email_employer_email_mismatch",
      pdfEmailHash: "d".repeat(64),
      employerEmailHash: "e".repeat(64),
      createdAt: now,
    },
  })
})

test("feedback events model job_presented as a first-class flywheel signal", () => {
  // req #4 — "a job was offered" is recorded as a job_presented feedback event.
  // Positive case: system-surfaced presentation with candidate + job scope.
  const presented = FeedbackEventSchema.parse({
    eventId: "fb-job-presented-1",
    kind: "job_presented",
    actor: "system",
    candidateId: "cand-1",
    jobId: "job-1",
    outcome: "claire_agent",
    evidence: [{ source: "job_match", summary: "top-ranked collab job offered" }],
    payloadRedacted: { flow: "claire_agent", channel: "imessage" },
    createdAt: now,
  })
  assert.equal(presented.kind, "job_presented")
  assert.equal(presented.candidateId, "cand-1")
  assert.equal(presented.jobId, "job-1")

  // The Claire agent runtime surfaces via the canonical `orchestrator` actor
  // (the conceptual "agent" actor — no parallel `agent` enum value).
  FeedbackEventSchema.parse({
    eventId: "fb-job-presented-orchestrator-1",
    kind: "job_presented",
    actor: "orchestrator",
    candidateId: "cand-2",
    jobId: "job-2",
    outcome: "general_market_fallback",
    createdAt: now,
  })

  // Every documented surfacing flow is a valid outcome.
  for (const source of JobPresentedSourceSchema.options) {
    FeedbackEventSchema.parse({
      eventId: `fb-job-presented-${source}`,
      kind: "job_presented",
      actor: "system",
      candidateId: "cand-3",
      jobId: "job-3",
      outcome: source,
      createdAt: now,
    })
  }

  // Negative: job_presented requires both candidateId and jobId.
  assert.throws(
    () =>
      FeedbackEventSchema.parse({
        eventId: "fb-job-presented-bad",
        kind: "job_presented",
        actor: "system",
        outcome: "claire_agent",
        createdAt: now,
      }),
    /candidateId|jobId/
  )
  assert.throws(
    () =>
      FeedbackEventSchema.parse({
        eventId: "fb-job-presented-no-job",
        kind: "job_presented",
        actor: "system",
        candidateId: "cand-1",
        outcome: "claire_agent",
        createdAt: now,
      }),
    /jobId/
  )

  // Other kinds keep their historical candidate/job optionality (regression).
  FeedbackEventSchema.parse({
    eventId: "fb-manual-note-no-scope",
    kind: "manual_note",
    actor: "operator",
    outcome: "context only",
    createdAt: now,
  })
})

test("makeJobPresentedEvent builds a writer-ready job_presented event", () => {
  const event = makeJobPresentedEvent({
    eventId: "fb-helper-1",
    candidateId: "cand-1",
    jobId: "job-1",
    source: "collab_prescreen",
    createdAt: now,
    actor: "orchestrator",
    channel: "imessage",
    confidence: 0.82,
    evidenceSummary: "collab job offered after onboarding",
  })
  // Helper output must satisfy the schema with no further massaging.
  const parsed = FeedbackEventSchema.parse(event)
  assert.equal(parsed.kind, "job_presented")
  assert.equal(parsed.actor, "orchestrator")
  assert.equal(parsed.outcome, "collab_prescreen")
  assert.deepEqual(parsed.payloadRedacted, {
    flow: "collab_prescreen",
    channel: "imessage",
  })
  assert.equal(parsed.evidence[0]?.source, "job_match")
  assert.equal(parsed.evidence[0]?.confidence, 0.82)

  // Defaults: actor=system, channel falls back to the flow name.
  const defaulted = makeJobPresentedEvent({
    eventId: "fb-helper-2",
    candidateId: "cand-2",
    jobId: "job-2",
    source: "daily_batch",
    createdAt: now,
  })
  assert.equal(defaulted.actor, "system")
  assert.deepEqual(defaulted.payloadRedacted, {
    flow: "daily_batch",
    channel: "daily_batch",
  })
  FeedbackEventSchema.parse(defaulted)
})

test("privacy request schema captures request-only redacted records", () => {
  const requestId = createPrivacyRequestId({
    candidateId: "cand-1",
    kind: "delete",
    createdAt: now,
  })
  const request = PrivacyRequestSchema.parse({
    requestId,
    kind: "delete",
    status: "submitted",
    candidateId: "cand-1",
    sourceSurface: "me_profile",
    requestedBy: "candidate",
    detailRedacted: { note: "candidate requested account deletion", channel: "profile" },
    evidence: [{ source: "system", summary: "submitted from self-serve profile page" }],
    createdAt: now,
  })

  assert.equal(request.requestId, requestId)
  assert.equal(request.kind, "delete")
  assert.equal(request.status, "submitted")
  assert.equal(request.detailRedacted.note, "candidate requested account deletion")
  assert.throws(() =>
    PrivacyRequestSchema.parse({
      ...request,
      detailRedacted: { rawText: "delete me, candidate@example.com" },
    })
  )
  assert.throws(() =>
    PrivacyRequestSchema.parse({
      ...request,
      evidence: [{ source: "profile", summary: "see gs://resume-bucket/raw.pdf" }],
    })
  )
  assert.throws(() =>
    PrivacyRequestSchema.parse({
      ...request,
      resolutionSummary: "Candidate reached at +1 555 555 0100",
    })
  )
})

test("launch readiness snapshots stay redacted and summarize S9 safety state", () => {
  const snapshot = LaunchReadinessSnapshotSchema.parse({
    snapshotId: createLaunchReadinessSnapshotId(now, "s9-test"),
    generatedAt: now,
    status: "yellow",
    counts: {
      privacyOpen: 1,
      pausedControls: 0,
      outboundQueued: 0,
    },
    sections: [
      {
        key: "privacy_requests",
        label: "Privacy requests",
        status: "yellow",
        count: 1,
        summary: "One open request awaiting operator review",
        sourceRoute: "/admin/launch-readiness",
        updatedAt: now,
      },
    ],
    privacyRequests: [
      {
        requestId: createPrivacyRequestId({ candidateId: "cand-1", kind: "export", createdAt: now }),
        kind: "export",
        status: "submitted",
        candidateId: "cand-1",
        sourceSurface: "me_profile",
        createdAt: now,
      },
    ],
    stopControls: [
      {
        controlId: createOutreachStopControlId({ scope: "global" }),
        scope: "global",
        paused: false,
        updatedAt: now,
      },
    ],
    evidence: [{ source: "admin", summary: "redacted aggregate snapshot" }],
  })

  assert.equal(snapshot.status, "yellow")
  assert.equal(snapshot.counts.privacyOpen, 1)
  assert.throws(() =>
    LaunchReadinessSnapshotSchema.parse({
      ...snapshot,
      evidence: [{ source: "admin", summary: "raw resume at https://storage.googleapis.com/raw.pdf" }],
    })
  )
})

test("outreach stop controls enforce explicit scope and pause reason", () => {
  assert.equal(createOutreachStopControlId({ scope: "global" }), "outreach_stop_global")
  assert.equal(
    createOutreachStopControlId({ scope: "outreach_batch", scopeId: "batch-1" }),
    createOutreachStopControlId({ scope: "outreach_batch", scopeId: "batch-1" })
  )

  const global = OutreachStopControlSchema.parse({
    controlId: createOutreachStopControlId({ scope: "global" }),
    scope: "global",
    paused: true,
    reason: "launch readiness pause",
    actor: "operator",
    createdAt: now,
  })
  assert.equal(global.paused, true)

  assert.throws(() =>
    OutreachStopControlSchema.parse({
      ...global,
      scopeId: "batch-1",
    })
  )
  assert.throws(() =>
    OutreachStopControlSchema.parse({
      controlId: createOutreachStopControlId({ scope: "outreach_batch", scopeId: "batch-1" }),
      scope: "outreach_batch",
      paused: false,
      actor: "operator",
      createdAt: now,
    })
  )
  assert.throws(() =>
    OutreachStopControlSchema.parse({
      ...global,
      paused: true,
      reason: "",
    })
  )
})

test("candidate-job match schema requires S5 versioned evidence", () => {
  const match = CandidateJobMatchSchema.parse({
    matchId: createCandidateJobMatchId("cand-1", "job-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    direction: "job_to_candidate",
    matchVersion: "s5-test",
    jobEnrichmentVersion: "job-enrich-v1",
    computedAt: now,
    scoreBreakdown: {
      skills: { score: 0.8, weight: 0.5, summary: "TypeScript and React match" },
      location: { score: 1, weight: 0.2 },
    },
    matchedSignals: ["typescript", "remote_anywhere"],
    blockedSignals: ["missing_salary_expectation"],
    candidateLifecycleStateAtMatch: "retained",
    candidateTagsUpdatedAt: now,
    staleAt: "2026-05-20T12:00:00.000Z",
    hardFilterResult: "soft_block",
    finalScore: 0.74,
    recommendedAction: "hitl_review",
    createdAt: now,
  })

  assert.equal(match.direction, "job_to_candidate")
  assert.equal(match.scoreBreakdown.skills.score, 0.8)
  assert.deepEqual(match.matchedSignals, ["typescript", "remote_anywhere"])
})

test("candidate-job match schema rejects invalid score breakdown and nondeterministic ids", () => {
  const valid = {
    matchId: createCandidateJobMatchId("cand-1", "job-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    direction: "job_to_candidate",
    matchVersion: "s5-test",
    jobEnrichmentVersion: "job-enrich-v1",
    computedAt: now,
    scoreBreakdown: {
      skills: { score: 0.8 },
    },
    matchedSignals: [],
    blockedSignals: [],
    candidateLifecycleStateAtMatch: "retained",
    candidateTagsUpdatedAt: now,
    finalScore: 0.8,
    recommendedAction: "hitl_review",
    createdAt: now,
  }

  assert.throws(() => CandidateJobMatchSchema.parse({ ...valid, matchId: "random" }))
  assert.throws(() =>
    CandidateJobMatchSchema.parse({
      ...valid,
      scoreBreakdown: { skills: { score: 1.1 } },
    })
  )
  assert.throws(() => CandidateJobMatchSchema.parse({ ...valid, scoreBreakdown: {} }))
})

test("outbound invite schema carries S6 policy evidence without raw PII ids", () => {
  const inviteId = createOutboundInviteId("cand-internal-1", "job-internal-1")
  assert.equal(inviteId, "outinvite_cand-internal-1__job-internal-1")
  assert.equal(inviteId.includes("@"), false)
  assert.equal(inviteId.includes("+"), false)
  assert.equal(
    createOutreachIdempotencyKey(inviteId),
    "outreach_idempotency_outinvite_cand-internal-1__job-internal-1"
  )
  assert.equal(
    createOutreachDuplicateSuppressionKey("cand-internal-1", " Acme, Inc. ", "Senior Front-End Engineer!!"),
    "outreach_dupe_cand-internal-1__acme-inc__senior-front-end-engineer"
  )
  assert.equal(
    createOutreachDuplicateSuppressionKey("cand-internal-1", "ACME inc", "senior front end engineer"),
    "outreach_dupe_cand-internal-1__acme-inc__senior-front-end-engineer"
  )

  const invite = OutboundInviteSchema.parse({
    inviteId,
    candidateId: "cand-internal-1",
    jobId: "job-internal-1",
    candidateJobStateId: createCandidateJobStateId("cand-internal-1", "job-internal-1"),
    matchId: createCandidateJobMatchId("cand-internal-1", "job-internal-1"),
    status: "blocked",
    policyDecision: "blocked",
    approvalState: "pending",
    dryRun: true,
    policyVersion: "s6-outreach-policy-v1",
    decisionReason: "capacity blocked before queueing",
    blockedSignals: ["channel_capacity"],
    missingInfo: ["reachable_phone"],
    cooldownUntil: "2026-05-20T12:00:00.000Z",
    stickyAccountGroupId: "sendblue-group-1",
    duplicateSuppressionKey: createOutreachDuplicateSuppressionKey(
      "cand-internal-1",
      "Acme, Inc.",
      "Senior Front-End Engineer"
    ),
    capacitySnapshot: {
      groupId: "sendblue-group-1",
      fromNumber: "+15555550100",
      status: "active",
      dailyCap: 10,
      usedToday: 10,
      remainingToday: 0,
      rolling24hUsed: 11,
      checkedAt: now,
      reason: "daily_capacity_full",
    },
    rejectedAt: now,
    rejectedBy: "operator@wekruit.com",
    rejectionReason: "capacity cap reached",
    candidateResponse: {
      status: "declined",
      respondedAt: now,
      summary: "Candidate asked not to pursue this company.",
    },
    createdAt: now,
  })

  assert.equal(invite.dryRun, true)
  assert.equal(invite.capacitySnapshot?.remainingToday, 0)
  assert.deepEqual(invite.blockedSignals, ["channel_capacity"])
  assert.deepEqual(invite.missingInfo, ["reachable_phone"])
  assert.equal(invite.duplicateSuppressionKey, "outreach_dupe_cand-internal-1__acme-inc__senior-front-end-engineer")
  assert.equal(invite.candidateResponse?.status, "declined")
})

test("outreach decision schema preserves auto_outbound as contract evidence only", () => {
  const inviteId = createOutboundInviteId("cand-1", "job-1")
  const decision = OutreachDecisionSchema.parse({
    inviteId,
    candidateId: "cand-1",
    jobId: "job-1",
    matchId: createCandidateJobMatchId("cand-1", "job-1"),
    policyVersion: "s6-outreach-policy-v1",
    policyDecision: "auto_outbound",
    decisionReason: "candidate matched all required signals",
    blockedSignals: [],
    missingInfo: [],
    approvalState: "not_required",
    dryRun: true,
    idempotencyKey: createOutreachIdempotencyKey(inviteId),
    duplicateSuppressionKey: createOutreachDuplicateSuppressionKey("cand-1", "Acme", "Frontend Engineer"),
    capacitySnapshot: {
      groupId: "sendblue-group-1",
      status: "active",
      dailyCap: 10,
      usedToday: 3,
      remainingToday: 7,
      checkedAt: now,
    },
    decidedAt: now,
  })

  assert.equal(decision.policyDecision, "auto_outbound")
  assert.equal(decision.dryRun, true)
  assert.equal(decision.approvalState, "not_required")
  assert.equal(decision.outboundId, undefined)
})

test("outbound invite schema rejects manual approval as policy rewrite", () => {
  assert.throws(() =>
    OutboundInviteSchema.parse({
      inviteId: createOutboundInviteId("cand-1", "job-1"),
      candidateId: "cand-1",
      jobId: "job-1",
      candidateJobStateId: createCandidateJobStateId("cand-1", "job-1"),
      status: "approved",
      policyDecision: "manual_approved",
      approvalState: "approved",
      dryRun: false,
      policyVersion: "s6-outreach-policy-v1",
      decisionReason: "operator approved",
      createdAt: now,
    })
  )
})

test("job enrichment schemas keep drafts private and public opportunity safe", () => {
  assert.equal(PA_JOB_ENRICHMENT_SUBCOLLECTION, "enrichment")
  assert.equal(PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION, "enrichment-eval-fixtures")
  assert.equal(
    createJobOpportunityDraftId("job-1", "2026-05-13T12:00:00.000Z"),
    "jobopp_job-1_2026-05-13T12-00-00-000Z"
  )
  assert.equal(
    createJobEnrichmentEvalFixtureId("job-1", "fixture-main"),
    "jobopp_eval_job-1_fixture-main"
  )

  const opportunity = JobOpportunitySchema.parse(makeJobOpportunity())
  assert.equal(opportunity.hardFilters.sponsorshipAvailable, null)
  assert.deepEqual(opportunity.roleFunction, ["software_engineering"])
  assert.deepEqual(opportunity.industrySector, ["software_and_saas"])
  const publicOpportunity = JobOpportunityPublicSchema.parse(toPublicJobOpportunity(opportunity))
  assert.equal("softScoringWeights" in publicOpportunity, false)
  assert.equal("prescreen" in publicOpportunity, false)
  assert.equal("scoringRubric" in publicOpportunity, false)
  assert.equal("candidateBrief" in publicOpportunity, false)
  assert.equal("evidence" in publicOpportunity.seniority, false)

  const draft = JobOpportunityDraftSchema.parse({
    draftId: "draft-1",
    jobId: "job-1",
    status: "needs_review",
    approvalReady: false,
    rawSnapshot: {
      source: "ats",
      capturedAt: now,
      title: "Senior Product Engineer",
      companyName: "WeKruit",
      description: "Build Claire.",
    },
    opportunity,
    coverage: {
      overall: "low",
      missingSignals: ["seniority_evidence"],
      seniorityEvidence: "title_only",
      sponsorshipSignal: "silent",
    },
    hitlFlags: [
      {
        flagId: "flag-1",
        kind: "low_coverage",
        severity: "blocking",
        reason: "Seniority is inferred from title only.",
      },
    ],
    enrichmentVersion: "s4-test",
    createdAt: now,
    updatedAt: now,
  })
  assert.equal(draft.status, "needs_review")
  assert.equal(draft.approvalReady, false)

  assert.throws(
    () =>
      JobOpportunityDraftSchema.parse({
        ...draft,
        coverage: { ...draft.coverage, seniorityEvidence: "title_only", overall: "high" },
        hitlFlags: [],
        approvalReady: true,
      }),
    /title-only seniority evidence requires low coverage and HITL review/
  )

  JobEnrichmentEvalFixtureSchema.parse({
    fixtureId: "fixture-1",
    jobId: "job-1",
    rawSnapshot: draft.rawSnapshot,
    expectedCoverage: "low",
    expectedHitlFlags: ["low_coverage"],
    notes: "Title-only seniority cannot silently approve.",
    createdAt: now,
  })

  const review = reduceJobEnrichmentDraftStatus("draft", "needs_review", now)
  assert.equal(review.state, "needs_review")
  assert.equal(canTransitionJobEnrichmentDraftStatus("needs_review", "approved"), true)
  const invalid = reduceJobEnrichmentDraftStatus("approved", "reject", now)
  assert.equal(invalid.changed, false)
  assert.equal(invalid.reason, "invalid_job_enrichment_transition")

  assert.deepEqual(
    summarizeJobEnrichmentDraftCounts(["draft", "needs_review", "approved", "rejected"]),
    {
      total: 4,
      draft: 1,
      needsReview: 1,
      approved: 1,
      rejected: 1,
    }
  )
})

function makeJobOpportunity() {
  return {
    title: "Frontend Engineer",
    companyName: "Acme",
    roleFunction: ["software_engineering"],
    industrySector: ["software_and_saas"],
    relevantTags: ["react"],
    skills: [{ name: "react", bucket: "frameworks_and_libraries", proficiency: "advanced" }],
    seniority: {
      label: "entry level",
      minYears: 1,
      maxYears: 3,
      evidence: [{ source: "ats", summary: "JD asks for 1+ years." }],
    },
    hardFilters: {
      sponsorshipAvailable: null,
      locations: ["remote_united_states"],
      jobTypes: ["full_time"],
    },
    softScoringWeights: { industrySector: 0.25, skills: 0.45, roleFunction: 0.2, location: 0.1 },
    prescreen: {
      questions: [
        {
          questionId: "q-react",
          prompt: "Tell me about your React experience.",
          signal: "frontend depth",
        },
      ],
    },
    scoringRubric: { mustHave: ["React project work"], niceToHave: ["SaaS UI"], disqualifiers: [] },
    candidateBrief: {
      headline: "Frontend Engineer at Acme",
      sellingPoints: ["Remote US", "Product engineering"],
      risksToClarify: [],
    },
  }
}

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

test("candidate-job reducer preserves first-interview and lets a fresh screen retry NOT_PASS", () => {
  let state = reduceCandidateJobState("candidate_matched", job("prescreen_started", { matchScore: 0.01 })).state
  assert.equal(state, "prescreen_started", "match score must not block first interview")

  state = reduceCandidateJobState(state, job("prescreen_review_pending")).state
  assert.equal(state, "prescreen_review_pending")

  state = reduceCandidateJobState(state, job("prescreen_not_passed")).state
  assert.equal(state, "not_passed")

  state = reduceCandidateJobState(state, job("prescreen_started")).state
  assert.equal(state, "prescreen_started", "a new job prescreen session may retry after NOT_PASS")

  const global = reduceCandidateLifecycleState("active_job_seeker", lifecycle("retention_allowed"))
  assert.equal(global.state, "retained", "NOT_PASS is not a global exit")
})

test("candidate-job prescreen events carry session evidence", () => {
  assert.throws(
    () =>
      CandidateJobEventSchema.parse({
        eventId: "evt-pass-missing-session",
        candidateId: "cand-1",
        jobId: "job-1",
        actor: "system",
        occurredAt: now,
        evidence: [{ source: "prescreen", summary: "passed" }],
        type: "prescreen_passed",
      }),
    /prescreenSessionId/
  )
  assert.equal(
    CandidateJobEventSchema.parse(job("prescreen_review_pending")).prescreenSessionId,
    "ps-job-1-cand-1"
  )
  assert.equal(
    CandidateJobEventSchema.parse(job("prescreen_passed")).prescreenSessionId,
    "ps-job-1-cand-1"
  )
  assert.throws(
    () =>
      CandidateJobEventSchema.parse({
        eventId: "evt-snapshot-missing-id",
        candidateId: "cand-1",
        jobId: "job-1",
        actor: "system",
        occurredAt: now,
        evidence: [{ source: "prescreen", summary: "visible" }],
        type: "employer_snapshot_created",
      }),
    /employerVisibleProfileId/
  )
})

test("candidate-job reducer requires review-pending before final prescreen outcome", () => {
  const started = reduceCandidateJobState("candidate_matched", job("prescreen_started", { matchScore: 0.01 }))
  assert.equal(started.state, "prescreen_started")

  const directPass = reduceCandidateJobState(started.state, job("prescreen_passed"))
  assert.equal(directPass.state, "prescreen_started")
  assert.equal(directPass.changed, false)
  assert.equal(directPass.reason, "prescreen_final_requires_human_review")

  const directNotPass = reduceCandidateJobState(started.state, job("prescreen_not_passed"))
  assert.equal(directNotPass.state, "prescreen_started")
  assert.equal(directNotPass.changed, false)
  assert.equal(directNotPass.reason, "prescreen_final_requires_human_review")

  const pending = reduceCandidateJobState(started.state, job("prescreen_review_pending"))
  assert.equal(pending.state, "prescreen_review_pending")
  assert.equal(pending.reason, "prescreen_waiting_for_human_review")

  const reviewedPass = reduceCandidateJobState(pending.state, job("prescreen_passed"))
  assert.equal(reviewedPass.state, "passed")

  const reviewedNotPass = reduceCandidateJobState(pending.state, job("prescreen_not_passed"))
  assert.equal(reviewedNotPass.state, "not_passed")
})

test("candidate-job outbound events require invite and delivery evidence", () => {
  assert.throws(() => CandidateJobEventSchema.parse(job("outbound_queued")), /outboundInviteId/)
  assert.throws(
    () => CandidateJobEventSchema.parse(job("outbound_queued", { outboundInviteId: "invite-1" })),
    /outboundId/
  )
  assert.throws(
    () =>
      CandidateJobEventSchema.parse(
        job("outbound_queued", { evidence: [], outboundInviteId: "invite-1", outboundId: "outbound-1" })
      ),
    /Array must contain|too_small|at least/
  )
  assert.throws(() => CandidateJobEventSchema.parse(job("outbound_sent")), /outboundInviteId/)
  assert.throws(
    () =>
      CandidateJobEventSchema.parse(
        job("outbound_sent", { evidence: [], outboundInviteId: "invite-1", outboundId: "outbound-1" })
      ),
    /providerStatus|Array must contain|too_small|at least/
  )

  const queued = reduceCandidateJobState(
    "candidate_matched",
    job("outbound_queued", {
      evidence: [{ source: "outbound_delivery", summary: "queue row exists", refId: "outbound-1" }],
      outboundInviteId: "invite-1",
      outboundId: "outbound-1",
      matchId: createCandidateJobMatchId("cand-1", "job-1"),
    })
  )
  assert.equal(queued.state, "outbound_queued")

  const directSent = reduceCandidateJobState(
    "candidate_matched",
    job("outbound_sent", {
      evidence: [{ source: "outbound_delivery", summary: "provider accepted", refId: "outbound-1" }],
      outboundInviteId: "invite-1",
      outboundId: "outbound-1",
      providerStatus: "SENT",
    })
  )
  assert.equal(directSent.state, "candidate_matched")
  assert.equal(directSent.reason, "invalid_outbound_sent_transition")

  const sent = reduceCandidateJobState(
    "outbound_queued",
    job("outbound_sent", {
      evidence: [{ source: "outbound_delivery", summary: "provider accepted", refId: "outbound-1" }],
      outboundInviteId: "invite-1",
      outboundId: "outbound-1",
      providerStatus: "SENT",
    })
  )
  assert.equal(sent.state, "outbound_sent")

  for (const from of ["candidate_matched", "outbound_queued", "outbound_sent", "not_passed"] as const) {
    const started = reduceCandidateJobState(from, job("prescreen_started", { matchScore: 0.01 }))
    assert.equal(started.state, "prescreen_started")
  }
})

test("candidate-job reducer requires passed state before employer visibility", () => {
  const blocked = reduceCandidateJobState("prescreen_started", job("employer_snapshot_created"))
  assert.equal(blocked.state, "prescreen_started")
  assert.equal(blocked.changed, false)
  assert.equal(blocked.reason, "employer_visible_requires_passed_state")

  const pending = reduceCandidateJobState("prescreen_started", job("prescreen_review_pending")).state
  const passed = reduceCandidateJobState(pending, job("prescreen_passed")).state
  const visible = reduceCandidateJobState(passed, job("employer_snapshot_created"))
  assert.equal(visible.state, "employer_visible")
})

test("employer-visible profile snapshot rejects raw contact or storage values", () => {
  const base = {
    snapshotId: createEmployerVisibleProfileId("job-1", "cand-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    candidateJobStateId: createCandidateJobStateId("cand-1", "job-1"),
    createdFromState: "passed",
    createdAt: now,
  }
  assert.throws(
    () => EmployerVisibleProfileSchema.parse({ ...base, resumeSummary: "Email me at alice@example.com" }),
    /raw contact/
  )
  assert.throws(
    () => EmployerVisibleProfileSchema.parse({ ...base, profileSummary: "Call +1 415 555 0100" }),
    /raw contact/
  )
  assert.throws(
    () => EmployerVisibleProfileSchema.parse({ ...base, matchReason: "See https://linkedin.com/in/alice" }),
    /raw contact/
  )
  assert.throws(
    () => EmployerVisibleProfileSchema.parse({ ...base, sourceResumeArtifactId: "gs://bucket/resume.pdf" }),
    /raw contact/
  )
  assert.throws(
    () =>
      EmployerVisibleProfileSchema.parse({
        ...base,
        matchReason: "Resume artifact https://bucket.storage.googleapis.com/resume.pdf",
      }),
    /raw contact/
  )
  assert.doesNotThrow(() =>
    EmployerVisibleProfileSchema.parse({
      ...base,
      matchReason:
        "Lookalike hostnames are not treated as raw profile URLs: https://linkedin.com.evil.test/profile",
    })
  )
  assert.doesNotThrow(() =>
    EmployerVisibleProfileSchema.parse({
      ...base,
      profileSummary: "Frontend engineer with React and hiring-platform experience.",
      passReason: "Strong structured interview responses.",
    })
  )
  assert.doesNotThrow(() =>
    EmployerVisibleProfileSchema.parse({
      ...base,
      snapshotId: createEmployerVisibleProfileId("5063962007", "cand-1"),
      jobId: "5063962007",
      candidateJobStateId: createCandidateJobStateId("cand-1", "5063962007"),
      profileSummary: "Numeric ATS job ids are internal identifiers, not employer-visible contact text.",
    })
  )
})

test("eval artifacts require a source and reject unsafe raw payload values", () => {
  assert.equal(PA_COLLECTIONS.evalArtifacts, "pa-eval-artifacts")

  const base = {
    artifactId: createEvalArtifactId("correction_regression_fixture", "corr-1"),
    kind: "correction_regression_fixture",
    status: "ready",
    sourceCorrectionEventIds: ["corr-1"],
    candidateId: "cand-1",
    jobId: "job-1",
    payloadRedacted: {
      targetType: "job_tags",
      before: ["general_software"],
      after: ["ai_infra"],
    },
    latestRunResult: {
      status: "not_run",
      metrics: {},
    },
    evidence: [{ source: "admin", summary: "Operator changed a redacted job tag" }],
    createdBy: "operator",
    createdAt: now,
  }

  assert.doesNotThrow(() => EvalArtifactSchema.parse(base))
  assert.throws(
    () => EvalArtifactSchema.parse({ ...base, sourceCorrectionEventIds: [], scenarioRef: undefined, runRef: undefined }),
    /must reference/
  )
  assert.throws(
    () =>
      EvalArtifactSchema.parse({
        ...base,
        payloadRedacted: { candidateEmail: "alice@example.com" },
      }),
    /must not contain raw PII/
  )
  assert.throws(
    () =>
      EvalArtifactSchema.parse({
        ...base,
        payloadRedacted: { storage: "gs://bucket/resume.pdf" },
      }),
    /must not contain raw PII/
  )
  assert.throws(
    () =>
      EvalArtifactSchema.parse({
        ...base,
        payloadRedacted: { rawTranscript: "candidate said hello" },
      }),
    /must not contain raw PII/
  )
  assert.throws(
    () =>
      EvalArtifactSchema.parse({
        ...base,
        evidence: [{ source: "system", summary: "See https://linkedin.com/in/alice" }],
      }),
    /must not contain raw PII/
  )
})

test("document id helpers do not require raw PII", () => {
  assert.equal(createCandidateJobStateId("cand-1", "job-1"), "cand-1__job-1")
  assert.equal(createEmployerVisibleProfileId("job-1", "cand-1"), "job-1__cand-1")
  assert.equal(createCandidateHandleId("email", "f".repeat(64)), `email__${"f".repeat(64)}`)
  assert.equal(
    createEvalArtifactId("correction_regression_fixture", "corr-1"),
    createEvalArtifactId("correction_regression_fixture", "corr-1")
  )
  assert.equal(createEvalArtifactId("correction_regression_fixture", "corr-1").includes("corr-1"), false)
  assert.throws(() => createEvalArtifactId("correction_regression_fixture", "alice@example.com"), /internal_id/)
})

test("candidate handle normalizers keep matching identity material stable", () => {
  assert.equal(normalizeCandidateHandleValue("email", "  ALICE@Example.COM "), "alice@example.com")
  assert.equal(
    candidateHandleHashMaterial("email", normalizeCandidateHandleValue("email", "ALICE@Example.COM")),
    candidateHandleHashMaterial("email", normalizeCandidateHandleValue("email", " alice@example.com "))
  )
  assert.equal(normalizeCandidateHandleValue("phone", "+14155550100"), "+14155550100")
  assert.throws(() => normalizeCandidateHandleValue("phone", "415-555-0100"), /requires_e164/)
})

test("candidate handle ids are built from hashes, not raw PII", () => {
  const rawEmail = "alice@example.com"
  const handleId = createCandidateHandleId("email", "a".repeat(64))
  assert.equal(handleId.includes(rawEmail), false)
  assert.equal(candidateHandleHashMaterial("email", rawEmail), "email:alice@example.com")
})

test("candidate profile URL fields normalize bare LinkedIn URLs", () => {
  assert.equal(
    CandidateProfileMarketplaceFieldsSchema.parse({
      linkedinUrl: "www.linkedin.com/in/sreya-gopaladasu-b77540211",
      githubUrl: "github.com/sreya",
      calcomUrl: "cal.com/sreya",
    }).linkedinUrl,
    "https://www.linkedin.com/in/sreya-gopaladasu-b77540211",
  )
  assert.equal(
    CandidateProfileMarketplaceFieldsSchema.parse({
      githubUrl: "github.com/sreya",
    }).githubUrl,
    "https://github.com/sreya",
  )
  const selfProfile = CandidateSelfProfileSchema.parse({
    candidateId: "cand-1",
    linkedinUrl: "linkedin.com/in/sreya-gopaladasu-b77540211",
    githubUrl: "github.com/sreya",
    calcomUrl: "cal.com/sreya",
    createdAt: now,
  })
  assert.equal(selfProfile.linkedinUrl, "https://linkedin.com/in/sreya-gopaladasu-b77540211")
  assert.equal(selfProfile.githubUrl, "https://github.com/sreya")
  assert.equal(selfProfile.calcomUrl, "https://cal.com/sreya")
})

test("candidate self profile preserves OAuth connector metadata", () => {
  const selfProfile = CandidateSelfProfileSchema.parse({
    candidateId: "cand-1",
    linkedinOauthProfile: {
      connectedAt: now,
      name: "Sreya Gopaladasu",
      emailMasked: "s***@example.com",
      pictureUrl: "media.licdn.com/profile.jpg",
    },
    githubOauthProfile: {
      connectedAt: now,
      login: "sreya",
      name: "Sreya",
      url: "github.com/sreya",
      avatarUrl: "avatars.githubusercontent.com/u/1",
      emailMasked: "s***@example.com",
    },
    githubPublicRepos: [
      {
        name: "compiler",
        fullName: "sreya/compiler",
        url: "github.com/sreya/compiler",
        description: "Language tooling",
        language: "TypeScript",
        stars: 42,
        forks: 3,
        updatedAt: now,
      },
    ],
    createdAt: now,
  })

  assert.equal(selfProfile.linkedinOauthProfile?.pictureUrl, "https://media.licdn.com/profile.jpg")
  assert.equal(selfProfile.githubOauthProfile?.url, "https://github.com/sreya")
  assert.equal(selfProfile.githubPublicRepos?.[0]?.url, "https://github.com/sreya/compiler")
  assert.equal(selfProfile.githubPublicRepos?.[0]?.stars, 42)
})

test("candidate self profile preserves enriched LinkedIn experience details", () => {
  const selfProfile = CandidateSelfProfileSchema.parse({
    candidateId: "cand-1",
    experienceHighlights: [
      {
        title: "Senior Software Engineer",
        company: "Tesla",
        location: "Fremont, California, United States",
        description: "Built vehicle telemetry tools and improved release diagnostics.",
        department: "Engineering",
        managementLevel: "Individual Contributor",
        durationMonths: 24,
        companyId: 12345,
        companyIndustry: "Automotive",
        companySizeRange: "10,001+ employees",
        companyWebsite: "tesla.com",
        companyLinkedinUrl: "linkedin.com/company/tesla-motors",
        companyHqCity: "Austin",
        companyHqCountry: "United States",
        companyLogoUrl: "https://static.licdn.com/tesla.png",
        source: "coresignal_collect_v2",
        sourceLabel: "LinkedIn",
      },
    ],
    createdAt: now,
  })

  const experience = selfProfile.experienceHighlights?.[0]
  assert.equal(experience?.description, "Built vehicle telemetry tools and improved release diagnostics.")
  assert.equal(experience?.companyWebsite, "https://tesla.com")
  assert.equal(experience?.companyLinkedinUrl, "https://linkedin.com/company/tesla-motors")
  assert.equal(experience?.companyLogoUrl, "https://static.licdn.com/tesla.png")
  assert.equal(experience?.companyIndustry, "Automotive")
})

test("bulk resume schemas parse S3 batch and item contracts", () => {
  assert.equal(PA_COLLECTIONS.bulkUploadBatches, "pa-bulk-upload-batches")

  BulkResumeBatchSchema.parse({
    batchId: "batch-1",
    label: "May UI resumes",
    source: "admin_upload",
    jobId: "job-1",
    createdBy: "operator@wekruit.com",
    status: "draft",
    counts: {
      total: 1,
      queued: 1,
      parsing: 0,
      parsed: 0,
      review: 0,
      failed: 0,
      retryReady: 0,
    },
    createdAt: now,
  })

  BulkResumeItemSchema.parse({
    itemId: createBulkResumeItemId("batch-1", "a".repeat(64)),
    batchId: "batch-1",
    fileName: "resume.pdf",
    fileSha256: "a".repeat(64),
    employerEmailHint: "Candidate@Example.com",
    employerEmailHintHash: "b".repeat(64),
    employerEmailHintMasked: "c***@example.com",
    extractedEmailHash: "c".repeat(64),
    extractedEmailMasked: "d***@example.com",
    status: "queued",
    retryCount: 0,
    idempotencyKey: createBulkResumeItemIdempotencyKey("batch-1", "a".repeat(64), "c".repeat(64)),
    createdAt: now,
  })
})

test("bulk resume id helpers avoid raw PII and stay deterministic", () => {
  const rawEmail = "candidate@example.com"
  const fileSha = "f".repeat(64)
  const emailHash = "e".repeat(64)

  const itemId = createBulkResumeItemId("batch-1", fileSha)
  const artifactId = createBulkResumeArtifactId("cand-1", fileSha, emailHash)
  const idempotencyKey = createBulkResumeItemIdempotencyKey("batch-1", fileSha, emailHash)

  assert.equal(itemId, createBulkResumeItemId("batch-1", fileSha))
  assert.equal(artifactId, createBulkResumeArtifactId("cand-1", fileSha, emailHash))
  assert.equal(idempotencyKey, createBulkResumeItemIdempotencyKey("batch-1", fileSha, emailHash))
  assert.equal(itemId.includes(rawEmail), false)
  assert.equal(artifactId.includes(rawEmail), false)
  assert.equal(idempotencyKey.includes(rawEmail), false)
})

test("bulk resume item transitions preserve retry and terminal parsed behavior", () => {
  let status: BulkResumeItemStatus = "queued"
  status = reduceBulkResumeItemStatus(status, "start_parsing").state
  assert.equal(status, "parsing")
  status = reduceBulkResumeItemStatus(status, "parse_failed").state
  assert.equal(status, "parse_failed")
  status = reduceBulkResumeItemStatus(status, "make_retry_ready").state
  assert.equal(status, "retry_ready")
  status = reduceBulkResumeItemStatus(status, "start_parsing").state
  assert.equal(status, "parsing")
  status = reduceBulkResumeItemStatus(status, "parsed").state
  assert.equal(status, "parsed")

  assert.equal(canTransitionBulkResumeItemStatus("parsed", "retry_ready"), false)
  assert.equal(canTransitionBulkResumeItemStatus("queued", "parsed"), false)
  assert.equal(canTransitionBulkResumeItemStatus("retry_ready", "parse_failed"), false)
  assert.equal(reduceBulkResumeItemStatus("parsed", "parse_failed").state, "parsed")
  assert.equal(
    reduceBulkResumeItemStatus("parsing", "missing_email_review").reason,
    "pdf_email_missing_requires_operator_review"
  )
})

test("bulk resume batch counts classify review and retry states", () => {
  assert.deepEqual(
    summarizeBulkResumeItemCounts([
      "queued",
      "parsing",
      "parsed",
      "missing_email_review",
      "identity_conflict",
      "parse_failed",
      "failed",
      "retry_ready",
    ]),
    {
      total: 8,
      queued: 1,
      parsing: 1,
      parsed: 1,
      review: 2,
      failed: 2,
      retryReady: 1,
    }
  )
})
