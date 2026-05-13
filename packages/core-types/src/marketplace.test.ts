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
  CandidateJobMatchSchema,
  CandidateJobStateDocSchema,
  CandidateProfileMarketplaceFieldsSchema,
  CandidateProfileSchema,
  CandidateSelfProfileSchema,
  CorrectionEventSchema,
  EmployerVisibleProfileSchema,
  FeedbackEventSchema,
  JobEnrichmentEvalFixtureSchema,
  JobOpportunityDraftSchema,
  JobOpportunitySchema,
  JobOpportunityPublicSchema,
  OutboundInviteSchema,
  PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION,
  PA_JOB_ENRICHMENT_SUBCOLLECTION,
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
  createJobEnrichmentEvalFixtureId,
  createJobEnrichmentDraftId,
  createJobOpportunityDraftId,
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
