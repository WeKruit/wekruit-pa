/**
 * v2.0 External Supply V1 — Zod schema contract tests.
 *
 * Coverage requirements (PLAN §11 Wave A6):
 *  - Round-trip parse + failure case for every status enum.
 *  - Round-trip parse + failure case for every record schema.
 *  - Doc-id helper behavior including UUID fallback for OutreachEvent.
 *  - Marketplace.ts enum extensions accept the new values.
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  AgentRankingActionSchema,
  AgentRankingEnsembleVoteSchema,
  AgentRankingResultSchema,
  AgentResearchFindingSchema,
  AgentResearchReviewStatusSchema,
  AgentResearchTaskSchema,
  CandidateCompanyJobEvaluationSchema,
  CandidateEvaluationRunSchema,
  CandidateSourceLinkSchema,
  EvaluationTierSchema,
  ExternalBatchStatusSchema,
  ExternalCandidateRecordSchema,
  ExternalSourceSchema,
  ExternalSourcingBatchSchema,
  IdentityResolutionStatusSchema,
  InstantlySyncRecordSchema,
  InstantlySyncStatusSchema,
  OutreachApprovalStatusSchema,
  OutreachChannelSchema,
  OutreachEventKindSchema,
  OutreachEventSchema,
  OutreachPlanSchema,
  SourceQualityMetricSchema,
  SuppressionBlockReasonSchema,
  SuppressionGateResultSchema,
  createAgentRankingResultId,
  createExternalEvaluationId,
  createOutreachEventId,
  createSourceQualityMetricId,
} from "./external-supply.js"
import {
  CandidateHandleSourceSchema,
  IdentityConflictKindSchema,
  IdentityEventTypeSchema,
  MarketplaceEvidenceSchema,
} from "./marketplace.js"

const now = "2026-05-13T12:00:00.000Z"
const sha = "a".repeat(64)

// ---------------------------------------------------------------------------
// Status enums — every value parses; one unknown value rejected per enum.
// ---------------------------------------------------------------------------

test("ExternalSourceSchema accepts every valid value and rejects unknowns", () => {
  for (const v of ["juicebox", "lessie", "coresignal", "coresignal_collect_v2", "manual_csv"]) {
    assert.equal(ExternalSourceSchema.parse(v), v)
  }
  assert.equal(ExternalSourceSchema.safeParse("indeed").success, false)
})

test("ExternalBatchStatusSchema accepts every valid value and rejects unknowns", () => {
  const all = [
    "uploading",
    "normalizing",
    "normalized",
    "resolving_identity",
    "ready_for_review",
    "ready_to_evaluate",
    "completed",
    "failed",
  ]
  for (const v of all) {
    assert.equal(ExternalBatchStatusSchema.parse(v), v)
  }
  assert.equal(ExternalBatchStatusSchema.safeParse("archived").success, false)
})

test("IdentityResolutionStatusSchema accepts every valid value and rejects unknowns", () => {
  for (const v of ["pending", "create_new", "merge_existing", "needs_review", "blocked"]) {
    assert.equal(IdentityResolutionStatusSchema.parse(v), v)
  }
  assert.equal(IdentityResolutionStatusSchema.safeParse("approved").success, false)
})

test("EvaluationTierSchema accepts every valid value and rejects unknowns", () => {
  for (const v of [
    "tier_1_personal_linkedin_and_email",
    "tier_2_personal_email",
    "tier_3_general_email",
    "retain_only",
    "blocked",
  ]) {
    assert.equal(EvaluationTierSchema.parse(v), v)
  }
  assert.equal(EvaluationTierSchema.safeParse("tier_4").success, false)
})

test("OutreachChannelSchema accepts every valid value and rejects unknowns", () => {
  for (const v of ["personal_linkedin", "personal_email", "general_email", "no_outreach"]) {
    assert.equal(OutreachChannelSchema.parse(v), v)
  }
  assert.equal(OutreachChannelSchema.safeParse("sms").success, false)
})

test("OutreachApprovalStatusSchema accepts every valid value and rejects unknowns", () => {
  for (const v of ["draft", "awaiting_approval", "approved", "rejected", "sent", "failed"]) {
    assert.equal(OutreachApprovalStatusSchema.parse(v), v)
  }
  assert.equal(OutreachApprovalStatusSchema.safeParse("queued").success, false)
})

test("InstantlySyncStatusSchema accepts every valid value and rejects unknowns", () => {
  for (const v of [
    "not_synced",
    "dry_run_planned",
    "queued",
    "synced",
    "sync_failed",
    "suppressed",
  ]) {
    assert.equal(InstantlySyncStatusSchema.parse(v), v)
  }
  assert.equal(InstantlySyncStatusSchema.safeParse("retrying").success, false)
})

test("OutreachEventKindSchema accepts every valid value and rejects unknowns", () => {
  const all = [
    "email_sent",
    "email_opened",
    "email_clicked",
    "email_replied",
    "email_bounced",
    "email_unsubscribed",
    "email_marked_spam",
    "manual_linkedin_sent",
    "manual_linkedin_replied",
    "candidate_interested",
    "candidate_declined",
  ]
  for (const v of all) {
    assert.equal(OutreachEventKindSchema.parse(v), v)
  }
  assert.equal(OutreachEventKindSchema.safeParse("email_archived").success, false)
})

test("AgentResearchReviewStatusSchema accepts every valid value and rejects unknowns", () => {
  for (const v of ["draft_prompt", "prompt_copied", "result_imported", "approved", "rejected"]) {
    assert.equal(AgentResearchReviewStatusSchema.parse(v), v)
  }
  assert.equal(AgentResearchReviewStatusSchema.safeParse("running").success, false)
})

test("SuppressionBlockReasonSchema accepts every valid value and rejects unknowns", () => {
  for (const v of [
    "opted_out",
    "previously_bounced",
    "invalid_email",
    "cooldown",
    "duplicate_company_role_recent",
    "low_confidence_personalization",
  ]) {
    assert.equal(SuppressionBlockReasonSchema.parse(v), v)
  }
  assert.equal(SuppressionBlockReasonSchema.safeParse("spam_score_high").success, false)
})

// ---------------------------------------------------------------------------
// Record schemas — round-trip + at least one failure case each.
// ---------------------------------------------------------------------------

test("ExternalSourcingBatchSchema parses a minimal valid batch", () => {
  const parsed = ExternalSourcingBatchSchema.parse({
    batchId: "batch-1",
    source: "juicebox",
    status: "normalized",
    rowCount: 10,
    validLinkedInCount: 8,
    validEmailCount: 9,
    duplicateCount: 1,
    needsReviewCount: 2,
    readyToProfileCount: 7,
    rawFileRef: {
      storageUri: "gs://bucket/path",
      mime: "text/csv",
      sha256: sha,
      sizeBytes: 1024,
    },
    normalizerVersion: "ext-norm-2026-05",
    importedBy: "operator-uid",
    meta: { adapterVersion: "juicebox-2026-05-A", columnMapping: { email: "Email" } },
    createdAt: now,
  })
  assert.equal(parsed.batchId, "batch-1")
  assert.equal(parsed.meta?.adapterVersion, "juicebox-2026-05-A")
})

test("ExternalSourcingBatchSchema rejects unknown source", () => {
  const r = ExternalSourcingBatchSchema.safeParse({
    batchId: "batch-1",
    source: "indeed",
    status: "normalized",
    rowCount: 0,
    validLinkedInCount: 0,
    validEmailCount: 0,
    duplicateCount: 0,
    needsReviewCount: 0,
    readyToProfileCount: 0,
    rawFileRef: { storageUri: "gs://b", mime: "text/csv", sha256: sha, sizeBytes: 0 },
    normalizerVersion: "v1",
    importedBy: "op",
    createdAt: now,
  })
  assert.equal(r.success, false)
})

test("ExternalCandidateRecordSchema parses a minimal valid record", () => {
  const parsed = ExternalCandidateRecordSchema.parse({
    recordId: "record-1",
    batchId: "batch-1",
    source: "juicebox",
    normalizationStatus: "ok",
    identityResolutionStatus: "pending",
    createdAt: now,
  })
  assert.equal(parsed.recordId, "record-1")
  assert.deepEqual(parsed.emails, [])
  assert.deepEqual(parsed.experience, [])
  assert.deepEqual(parsed.evidence, [])
})

test("ExternalCandidateRecordSchema rejects missing required normalizationStatus", () => {
  const r = ExternalCandidateRecordSchema.safeParse({
    recordId: "record-1",
    batchId: "batch-1",
    source: "juicebox",
    identityResolutionStatus: "pending",
    createdAt: now,
  })
  assert.equal(r.success, false)
})

test("CandidateSourceLinkSchema parses linked row + pending row", () => {
  const linked = CandidateSourceLinkSchema.parse({
    sourceLinkId: "sl-1",
    candidateId: "cand-1",
    source: "juicebox",
    batchId: "batch-1",
    recordId: "record-1",
    canonicalLinkedInUrl: "https://www.linkedin.com/in/alice",
    linkedinProfileHash: sha,
    emailHashes: [sha],
    confidence: 0.4,
    createdAt: now,
    createdBy: "system",
  })
  assert.equal(linked.status, "linked")
  assert.equal(linked.candidateId, "cand-1")

  const pending = CandidateSourceLinkSchema.parse({
    sourceLinkId: "sl-2",
    status: "pending_review",
    pendingRecordId: "record-2",
    source: "juicebox",
    batchId: "batch-1",
    recordId: "record-2",
    createdAt: now,
    createdBy: "system",
  })
  assert.equal(pending.candidateId, undefined)
  assert.equal(pending.pendingRecordId, "record-2")
})

test("CandidateSourceLinkSchema rejects invalid status", () => {
  const r = CandidateSourceLinkSchema.safeParse({
    sourceLinkId: "sl-1",
    candidateId: "cand-1",
    status: "ghosted",
    source: "juicebox",
    batchId: "batch-1",
    recordId: "record-1",
    createdAt: now,
    createdBy: "system",
  })
  assert.equal(r.success, false)
})

test("CandidateEvaluationRunSchema parses a queued run", () => {
  const parsed = CandidateEvaluationRunSchema.parse({
    runId: "run-1",
    companyId: "company-1",
    jobId: "job-1",
    rubricVersion: "rubric-2026-05-v1",
    triggeredBy: "operator-uid",
    candidateCount: 100,
    completedCount: 0,
    status: "queued",
    createdAt: now,
  })
  assert.equal(parsed.runId, "run-1")
  assert.equal(parsed.status, "queued")
})

test("CandidateEvaluationRunSchema rejects negative candidateCount", () => {
  const r = CandidateEvaluationRunSchema.safeParse({
    runId: "run-1",
    companyId: "company-1",
    jobId: "job-1",
    rubricVersion: "rubric-2026-05-v1",
    triggeredBy: "operator-uid",
    candidateCount: -1,
    completedCount: 0,
    status: "queued",
    createdAt: now,
  })
  assert.equal(r.success, false)
})

test("CandidateCompanyJobEvaluationSchema parses a complete evaluation", () => {
  const evalId = createExternalEvaluationId("cand-1", "job-1", "run-1")
  const parsed = CandidateCompanyJobEvaluationSchema.parse({
    evaluationId: evalId,
    candidateId: "cand-1",
    companyId: "company-1",
    jobId: "job-1",
    evaluationRunId: "run-1",
    rubricVersion: "rubric-2026-05-v1",
    generalRubricScore: 0.8,
    companyRubricScore: 0.7,
    jobRubricScore: 0.9,
    hardGateResult: "pass",
    hardGateReasons: [],
    softScore: 0.82,
    missingInfo: ["currentCompany"],
    risks: [],
    explanation: "Strong skills overlap; needs research on current employer.",
    proposedTier: "tier_2_personal_email",
    createdAt: now,
  })
  assert.equal(parsed.evaluationId, evalId)
  assert.equal(parsed.proposedTier, "tier_2_personal_email")
})

test("CandidateCompanyJobEvaluationSchema rejects softScore > 1", () => {
  const r = CandidateCompanyJobEvaluationSchema.safeParse({
    evaluationId: "e-1",
    candidateId: "cand-1",
    companyId: "company-1",
    jobId: "job-1",
    evaluationRunId: "run-1",
    rubricVersion: "rubric-2026-05-v1",
    generalRubricScore: 0.5,
    companyRubricScore: 0.5,
    jobRubricScore: 0.5,
    hardGateResult: "pass",
    softScore: 1.5,
    explanation: "x",
    proposedTier: "retain_only",
    createdAt: now,
  })
  assert.equal(r.success, false)
})

test("AgentResearchFindingSchema parses a finding with evidence URLs", () => {
  const parsed = AgentResearchFindingSchema.parse({
    findingId: "find-1",
    candidateId: "cand-1",
    field: "currentCompany",
    value: "Acme Corp",
    confidence: 0.78,
    evidenceUrls: ["https://example.com/proof"],
  })
  assert.equal(parsed.approved, false)
  assert.deepEqual(parsed.evidenceUrls, ["https://example.com/proof"])
})

test("AgentResearchFindingSchema rejects non-URL evidence", () => {
  const r = AgentResearchFindingSchema.safeParse({
    findingId: "find-1",
    candidateId: "cand-1",
    field: "currentCompany",
    value: "Acme",
    confidence: 0.5,
    evidenceUrls: ["not-a-url"],
  })
  assert.equal(r.success, false)
})

test("AgentResearchTaskSchema parses a draft prompt task", () => {
  const parsed = AgentResearchTaskSchema.parse({
    taskId: "task-1",
    evaluationRunId: "run-1",
    candidateIds: ["cand-1", "cand-2"],
    promptVersion: "agent-prompt-2026-05-A",
    prompt: "Research the following candidates...",
    expectedJsonSchemaVersion: "agent-result-2026-05-A",
    reviewStatus: "draft_prompt",
    createdAt: now,
  })
  assert.equal(parsed.taskId, "task-1")
  assert.deepEqual(parsed.evidence, [])
})

test("AgentResearchTaskSchema rejects empty prompt", () => {
  const r = AgentResearchTaskSchema.safeParse({
    taskId: "task-1",
    evaluationRunId: "run-1",
    candidateIds: [],
    promptVersion: "v1",
    prompt: "",
    expectedJsonSchemaVersion: "v1",
    reviewStatus: "draft_prompt",
    createdAt: now,
  })
  assert.equal(r.success, false)
})

test("SuppressionGateResultSchema parses allow + blocked variants", () => {
  const allow = SuppressionGateResultSchema.parse({ allow: true })
  assert.equal(allow.allow, true)
  assert.deepEqual(allow.blockedReasons, [])

  const blocked = SuppressionGateResultSchema.parse({
    allow: false,
    blockedReasons: ["opted_out", "cooldown"],
    cooldownUntil: now,
  })
  assert.equal(blocked.allow, false)
  assert.deepEqual(blocked.blockedReasons, ["opted_out", "cooldown"])
})

test("SuppressionGateResultSchema rejects unknown blocked reason", () => {
  const r = SuppressionGateResultSchema.safeParse({
    allow: false,
    blockedReasons: ["never_heard_of_it"],
  })
  assert.equal(r.success, false)
})

test("OutreachPlanSchema parses a minimal valid plan", () => {
  const parsed = OutreachPlanSchema.parse({
    planId: "plan-1",
    candidateId: "cand-1",
    companyId: "company-1",
    jobId: "job-1",
    evaluationId: createExternalEvaluationId("cand-1", "job-1", "run-1"),
    tier: "tier_2_personal_email",
    channelDecision: "personal_email",
    approvalStatus: "draft",
    suppressionGateResult: { allow: true },
    createdAt: now,
  })
  assert.equal(parsed.planId, "plan-1")
  assert.equal(parsed.tier, "tier_2_personal_email")
})

test("OutreachPlanSchema rejects missing suppressionGateResult", () => {
  const r = OutreachPlanSchema.safeParse({
    planId: "plan-1",
    candidateId: "cand-1",
    companyId: "company-1",
    jobId: "job-1",
    evaluationId: "e-1",
    tier: "tier_2_personal_email",
    channelDecision: "personal_email",
    approvalStatus: "draft",
    createdAt: now,
  })
  assert.equal(r.success, false)
})

test("InstantlySyncRecordSchema parses a dry-run sync", () => {
  const parsed = InstantlySyncRecordSchema.parse({
    syncId: "sync-1",
    planId: "plan-1",
    candidateId: "cand-1",
    jobId: "job-1",
    companyId: "company-1",
    syncStatus: "dry_run_planned",
    mode: "dry_run",
    dryRunPayload: { email: "alice@example.com" },
    createdAt: now,
  })
  assert.equal(parsed.mode, "dry_run")
  assert.equal(parsed.syncStatus, "dry_run_planned")
})

test("InstantlySyncRecordSchema rejects invalid mode", () => {
  const r = InstantlySyncRecordSchema.safeParse({
    syncId: "sync-1",
    planId: "plan-1",
    candidateId: "cand-1",
    jobId: "job-1",
    companyId: "company-1",
    syncStatus: "not_synced",
    mode: "test",
    createdAt: now,
  })
  assert.equal(r.success, false)
})

test("OutreachEventSchema parses an Instantly reply event", () => {
  const parsed = OutreachEventSchema.parse({
    eventId: createOutreachEventId("instantly", "evt_abc"),
    provider: "instantly",
    providerEventId: "evt_abc",
    candidateId: "cand-1",
    planId: "plan-1",
    jobId: "job-1",
    companyId: "company-1",
    kind: "email_replied",
    payloadRedacted: { from: "a***@example.com" },
    occurredAt: now,
    recordedAt: now,
  })
  // eventId is `${provider}__${sha256(provider:providerEventId)}` to keep
  // doc ids deterministic + free of any raw provider identifier.
  assert.match(parsed.eventId, /^instantly__[0-9a-f]{64}$/)
  assert.equal(parsed.kind, "email_replied")
})

test("OutreachEventSchema rejects unknown provider", () => {
  const r = OutreachEventSchema.safeParse({
    eventId: "evt-1",
    provider: "sendgrid",
    candidateId: "cand-1",
    planId: "plan-1",
    jobId: "job-1",
    companyId: "company-1",
    kind: "email_sent",
    occurredAt: now,
    recordedAt: now,
  })
  assert.equal(r.success, false)
})

test("SourceQualityMetricSchema parses a monthly rollup", () => {
  const parsed = SourceQualityMetricSchema.parse({
    metricId: createSourceQualityMetricId("juicebox", "2026-05"),
    source: "juicebox",
    windowStart: now,
    windowEnd: now,
    rowsIngested: 250,
    validRate: 0.9,
    duplicateRate: 0.05,
    identityConflictRate: 0.02,
    replyRate: 0.1,
    bounceRate: 0.03,
    conversionToFirstInterview: 0.04,
    createdAt: now,
  })
  assert.equal(parsed.metricId, "juicebox__2026-05")
  assert.equal(parsed.rowsIngested, 250)
})

test("SourceQualityMetricSchema rejects out-of-range rate", () => {
  const r = SourceQualityMetricSchema.safeParse({
    metricId: "juicebox__2026-05",
    source: "juicebox",
    windowStart: now,
    windowEnd: now,
    rowsIngested: 0,
    validRate: 1.5,
    duplicateRate: 0,
    identityConflictRate: 0,
    replyRate: 0,
    bounceRate: 0,
    conversionToFirstInterview: 0,
    createdAt: now,
  })
  assert.equal(r.success, false)
})

// ---------------------------------------------------------------------------
// Doc-id helpers
// ---------------------------------------------------------------------------

test("createExternalEvaluationId is the composite of candidate/job/run", () => {
  assert.equal(createExternalEvaluationId("c1", "j1", "r1"), "c1__j1__r1")
})

test("createOutreachEventId hashes providerEventId deterministically when present", () => {
  const id1 = createOutreachEventId("instantly", "evt_123")
  const id2 = createOutreachEventId("instantly", "evt_123")
  // Shape: `${provider}__${sha256-hex}` — 64 lowercase hex chars after sep.
  assert.match(id1, /^instantly__[0-9a-f]{64}$/)
  // Idempotency: same (provider, providerEventId) -> same id.
  assert.equal(id1, id2)
  // No raw providerEventId leak into the doc id.
  assert.equal(id1.includes("evt_123"), false)
  // Different providerEventId -> different id.
  const id3 = createOutreachEventId("instantly", "evt_999")
  assert.notEqual(id1, id3)
})

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test("createOutreachEventId falls back to uuid v4 when providerEventId is undefined", () => {
  const id = createOutreachEventId("instantly", undefined)
  assert.match(id, UUID_V4_REGEX)
})

test("createOutreachEventId treats empty string as absent and yields uuid", () => {
  const id = createOutreachEventId("instantly", "")
  assert.match(id, UUID_V4_REGEX)
})

test("createSourceQualityMetricId is the composite of source + yyyyMm", () => {
  assert.equal(createSourceQualityMetricId("juicebox", "2026-05"), "juicebox__2026-05")
})

// ---------------------------------------------------------------------------
// Marketplace.ts enum extensions accept the four sets of new values
// (PLAN §5.3). These guard against accidental reordering or removal.
// ---------------------------------------------------------------------------

test("MarketplaceEvidenceSchema.source accepts the three external-supply additions", () => {
  for (const source of ["external_sourcing", "agent_research", "instantly_delivery"]) {
    const parsed = MarketplaceEvidenceSchema.parse({
      source,
      summary: "external supply evidence",
    })
    assert.equal(parsed.source, source)
  }
})

test("CandidateHandleSourceSchema accepts external_sourcing", () => {
  assert.equal(CandidateHandleSourceSchema.parse("external_sourcing"), "external_sourcing")
})

test("IdentityConflictKindSchema accepts the two new external-supply kinds", () => {
  assert.equal(
    IdentityConflictKindSchema.parse("linkedin_email_candidate_mismatch"),
    "linkedin_email_candidate_mismatch"
  )
  assert.equal(IdentityConflictKindSchema.parse("external_fuzzy_match"), "external_fuzzy_match")
})

test("IdentityEventTypeSchema accepts the two new external-supply event types", () => {
  assert.equal(IdentityEventTypeSchema.parse("external_source_linked"), "external_source_linked")
  assert.equal(
    IdentityEventTypeSchema.parse("external_candidate_imported"),
    "external_candidate_imported"
  )
})

// ---------------------------------------------------------------------------
// V2 — Agent Ranking contracts (Wave A)
// ---------------------------------------------------------------------------

const minimalEnsembleVote = {
  modelUsed: "gpt-5.4-nano",
  proposedAgentTier: "tier_2_personal_email" as const,
  agentRationale: "Strong skills overlap with role; appropriate seniority.",
  agentRisks: [],
  agentRecommendedAction: "outreach_now" as const,
  inputTokens: 800,
  outputTokens: 120,
  costUsd: 0.0012,
}

const minimalAgentRankingResult = {
  resultId: "agent-rank__" + "f".repeat(64),
  evaluationRunId: "run-1",
  candidateRecordId: "record-1",
  companyId: "company-1",
  jobId: "job-1",
  deterministicTier: "tier_3_general_email" as const,
  proposedAgentTier: "tier_2_personal_email" as const,
  agentRationale: "Promoted from tier_3 to tier_2 due to direct domain match.",
  agentRisks: [],
  agentRecommendedAction: "outreach_now" as const,
  ensembleVotes: [minimalEnsembleVote],
  modelUsed: "gpt-5.4-nano",
  ensembleSize: 1,
  totalInputTokens: 800,
  totalOutputTokens: 120,
  totalCostUsd: 0.0012,
  dryRun: false,
  promptVersion: "agent-rank-2026-05-A",
  createdAt: now,
}

test("AgentRankingResultSchema parses a minimal proposed row", () => {
  const parsed = AgentRankingResultSchema.parse(minimalAgentRankingResult)
  assert.equal(parsed.resultId, minimalAgentRankingResult.resultId)
  // Defaults applied.
  assert.equal(parsed.status, "proposed")
  assert.equal(parsed.ensembleSize, 1)
  assert.equal(parsed.dryRun, false)
  assert.equal(parsed.approvedTier, undefined)
  assert.equal(parsed.approvedBy, undefined)
  assert.equal(parsed.approvedAt, undefined)
  assert.equal(parsed.correctionEventId, undefined)
})

test("AgentRankingResultSchema parses an overridden row with full approval audit", () => {
  const overriddenInput = {
    ...minimalAgentRankingResult,
    status: "overridden" as const,
    approvedTier: "retain_only" as const,
    approvedBy: "operator-uid",
    approvedAt: now,
    correctionEventId: "corr-agent-rank-1",
  }
  const parsed = AgentRankingResultSchema.parse(overriddenInput)
  assert.equal(parsed.status, "overridden")
  assert.equal(parsed.approvedTier, "retain_only")
  assert.equal(parsed.approvedBy, "operator-uid")
  assert.equal(parsed.approvedAt, now)
  assert.equal(parsed.correctionEventId, "corr-agent-rank-1")
  // Round-trip preserved.
  const reparsed = AgentRankingResultSchema.parse(parsed)
  assert.deepEqual(reparsed, parsed)
})

test("AgentRankingResultSchema rejects bad ensembleSize and negative tokens / cost", () => {
  // ensembleSize > 5.
  const tooBig = AgentRankingResultSchema.safeParse({
    ...minimalAgentRankingResult,
    ensembleSize: 6,
  })
  assert.equal(tooBig.success, false)

  // ensembleSize < 1.
  const tooSmall = AgentRankingResultSchema.safeParse({
    ...minimalAgentRankingResult,
    ensembleSize: 0,
  })
  assert.equal(tooSmall.success, false)

  // Negative input tokens.
  const negInput = AgentRankingResultSchema.safeParse({
    ...minimalAgentRankingResult,
    totalInputTokens: -1,
  })
  assert.equal(negInput.success, false)

  // Negative output tokens.
  const negOutput = AgentRankingResultSchema.safeParse({
    ...minimalAgentRankingResult,
    totalOutputTokens: -1,
  })
  assert.equal(negOutput.success, false)

  // Negative cost.
  const negCost = AgentRankingResultSchema.safeParse({
    ...minimalAgentRankingResult,
    totalCostUsd: -0.01,
  })
  assert.equal(negCost.success, false)
})

test("AgentRankingEnsembleVoteSchema requires every core field", () => {
  // Baseline parses.
  const ok = AgentRankingEnsembleVoteSchema.parse(minimalEnsembleVote)
  assert.equal(ok.modelUsed, "gpt-5.4-nano")

  // Each required field is removed in isolation -> safeParse fails.
  const requiredFields = [
    "modelUsed",
    "proposedAgentTier",
    "agentRationale",
    "agentRecommendedAction",
  ] as const
  for (const field of requiredFields) {
    const copy: Record<string, unknown> = { ...minimalEnsembleVote }
    delete copy[field]
    const r = AgentRankingEnsembleVoteSchema.safeParse(copy)
    assert.equal(r.success, false, `expected missing ${field} to fail parse`)
  }

  // AgentRankingActionSchema constraint asserted indirectly via vote rejection
  // of unknown action value.
  const badAction = AgentRankingEnsembleVoteSchema.safeParse({
    ...minimalEnsembleVote,
    agentRecommendedAction: "send_now",
  })
  assert.equal(badAction.success, false)
  // Sanity: the action enum itself accepts only the locked 4.
  for (const v of [
    "outreach_now",
    "outreach_after_research",
    "retain_warm",
    "do_not_contact",
  ]) {
    assert.equal(AgentRankingActionSchema.parse(v), v)
  }
})

test("createAgentRankingResultId is deterministic, unique, and well-formed", () => {
  const id1 = createAgentRankingResultId({
    evaluationRunId: "run-1",
    candidateRecordId: "record-1",
  })
  const id2 = createAgentRankingResultId({
    evaluationRunId: "run-1",
    candidateRecordId: "record-1",
  })
  assert.equal(id1, id2)
  // Shape: `agent-rank__${sha256 hex}` — 64 lowercase hex chars after sep.
  assert.match(id1, /^agent-rank__[a-f0-9]{64}$/)

  // Different inputs -> different ids.
  const id3 = createAgentRankingResultId({
    evaluationRunId: "run-1",
    candidateRecordId: "record-2",
  })
  assert.notEqual(id1, id3)
  const id4 = createAgentRankingResultId({
    evaluationRunId: "run-2",
    candidateRecordId: "record-1",
  })
  assert.notEqual(id1, id4)

  // Empty inputs throw.
  assert.throws(() =>
    createAgentRankingResultId({ evaluationRunId: "", candidateRecordId: "record-1" })
  )
  assert.throws(() =>
    createAgentRankingResultId({ evaluationRunId: "run-1", candidateRecordId: "" })
  )
})

test("SourceQualityMetricSchema parses a row with the V2 additive agent metrics", () => {
  const parsed = SourceQualityMetricSchema.parse({
    metricId: createSourceQualityMetricId("juicebox", "2026-05"),
    source: "juicebox",
    windowStart: now,
    windowEnd: now,
    rowsIngested: 250,
    validRate: 0.9,
    duplicateRate: 0.05,
    identityConflictRate: 0.02,
    replyRate: 0.1,
    bounceRate: 0.03,
    conversionToFirstInterview: 0.04,
    agentTierAcceptanceRate: 0.85,
    agentOperatorOverrideRate: 0.15,
    agentRankedTotal: 200,
    agentApprovedUnchangedTotal: 170,
    agentOverriddenTotal: 30,
    costTableVersion: "pricing-2026-05-A",
    createdAt: now,
  })
  assert.equal(parsed.agentTierAcceptanceRate, 0.85)
  assert.equal(parsed.agentOperatorOverrideRate, 0.15)
  assert.equal(parsed.agentRankedTotal, 200)
  assert.equal(parsed.agentApprovedUnchangedTotal, 170)
  assert.equal(parsed.agentOverriddenTotal, 30)
  assert.equal(parsed.costTableVersion, "pricing-2026-05-A")
})
