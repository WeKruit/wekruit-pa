/**
 * Firestore collection names for the personal-assistant platform.
 * Namespaced (`pa-*`) for shared Firebase project `wekruit-5f89b` alongside other products.
 */
export const PA_COLLECTIONS = {
  users: "pa-users",
  sessions: "pa-sessions",
  messages: "pa-messages",
  agents: "pa-agents",
  /** Feature flags / dynamic config (Remote Config pattern on Firestore) */
  remoteConfig: "pa-remote-config",
  /** Runtime-approved iMessage transport outbox */
  outbound: "pa-outbound",
  /** Durable inbound queue from channel adapters */
  inboundEvents: "pa-inbound-events",
  /** Per-turn orchestration state machine (broker arch) */
  agentTurns: "pa-agent-turns",
  /** Per-turn state machine consumed by pa-orchestrator (Phase 1 Mem0 path) */
  turns: "pa-turns",
  /** Upstream conversation-owner arbitration trace for Claire turn routing. */
  turnTraces: "pa-turn-traces",
  /** First-class committed evidence extracted by the conversation arbiter/action layer. */
  conversationEvidence: "pa-conversation-evidence",
  /** Memory action audit (remember/forget/list/clear) */
  memoryActions: "pa-memory-actions",
  /** Rolled-up conversation summaries */
  conversationSummaries: "pa-conversation-summaries",
  /** GCS pointer rows for archived month-bucketed messages */
  messageArchives: "pa-message-archives",
  /** Connector / tool invocation ledger */
  toolCalls: "pa-tool-calls",
  /** Append-only audit log */
  auditEvents: "pa-audit-events",
  /** Rate limit counters (sliding or fixed windows) */
  rateLimits: "pa-rate-limits",
  /** Abuse / safety signals */
  abuseEvents: "pa-abuse-events",
  /** Explicit links between channel sessions for one logical user */
  sessionLinks: "pa-session-links",
  /** Memory operator metadata and write/delete/export audit */
  memoryEvents: "pa-memory-events",
  agentVersions: "pa-agent-versions",
  memoryProfiles: "pa-memory-profiles",
  memoryFacts: "pa-memory-facts",
  memoryEvolutionEvents: "pa-memory-evolution-events",
  surpriseEvents: "pa-surprise-events",
  scheduledJobs: "pa-scheduled-jobs",
  runtimeHeartbeats: "pa-runtime-heartbeats",
  /** Per-worker durable cursors (e.g. last processed iMessage ROWID) */
  workerCursors: "pa-worker-cursors",
  /** Closed-beta participants — source of truth for allowlist + onboarding */
  betaParticipants: "pa-beta-participants",
  /** v2.0 S1 — global candidate linked handles; candidateId == pa-users doc id. */
  candidateHandles: "pa-candidate-handles",
  /** v2.0 S2 — Firebase Auth uid to canonical candidate id mapping. */
  candidateAuth: "pa-candidate-auth",
  /** v2.0 S2 — redacted candidate-facing profile projection. */
  candidateSelfProfiles: "pa-candidate-self-profiles",
  /** v2.0 S2 — append-only candidate identity resolution events. */
  candidateIdentityEvents: "pa-candidate-identity-events",
  /** v2.0 S2 — deterministic identity conflicts for operator review. */
  candidateIdentityConflicts: "pa-candidate-identity-conflicts",
  /** v2.0 S1 — canonical resume artifact pointers and parse status. */
  resumeArtifacts: "pa-resume-artifacts",
  /** v2.0 S3 — operator-owned bulk resume upload batches. */
  bulkUploadBatches: "pa-bulk-upload-batches",
  /** v2.0 S1 — per-candidate-per-job opportunity state. */
  candidateJobStates: "pa-candidate-job-states",
  /** v2.0 S1 — latest match evidence for a candidate/job pair. */
  candidateJobMatches: "pa-candidate-job-matches",
  /** v2.0 S1 — marketplace invite policy state, separate from pa-outbound delivery rows. */
  outboundInvites: "pa-outbound-invites",
  /** v2.0 S1 — passed-only employer-visible candidate snapshots. */
  employerVisibleProfiles: "pa-employer-visible-profiles",
  /** v2.0 S1 — append-only outcome and behavior feedback. */
  feedbackEvents: "pa-feedback-events",
  /** v2.0 S1 — append-only HITL correction events. */
  correctionEvents: "pa-correction-events",
  /** v2.0 S8 — redacted eval/regression artifacts generated from flywheel events. */
  evalArtifacts: "pa-eval-artifacts",
  /** Canonical screening-eval artifacts for prescreen/practice/external-supply HITL review. */
  evaluationAttempts: "pa-evaluation-attempts",
  /** v2.0 S9 — candidate privacy/export/delete/stop request intake queue. */
  privacyRequests: "pa-privacy-requests",
  /** v2.0 S9 — redacted launch-readiness snapshots for production hardening. */
  launchReadinessSnapshots: "pa-launch-readiness-snapshots",
  /** v2.0 S9 — manual outreach stop controls. */
  outreachStopControls: "pa-outreach-stop-controls",
  /** Public job docs. Draft enrichment internals must live only in subcollections. */
  jobs: "pa-jobs",
  /** v2.0 external-supply — operator-uploaded sourcing batches (Juicebox/Lessie/Coresignal/manual-csv). */
  externalSourcingBatches: "pa-external-sourcing-batches",
  /** v2.0 external-supply — normalized per-row candidate records ingested from a batch. */
  externalCandidateRecords: "pa-external-candidate-records",
  /** v2.0 external-supply — pa-users to external record join with linked/pending/blocked status. */
  candidateSourceLinks: "pa-candidate-source-links",
  /** v2.0 external-supply — evaluation run metadata (company x job scope, status, counts). */
  candidateEvaluationRuns: "pa-candidate-evaluation-runs",
  /** v2.0 external-supply — per-candidate company+job evaluation result (deterministic doc id). */
  candidateCompanyJobEvaluations: "pa-candidate-company-job-evaluations",
  /** v2.0 external-supply — ChatGPT Agent Mode research prompt + parsed findings tasks. */
  agentResearchTasks: "pa-agent-research-tasks",
  /** v2.0 external-supply — outreach plans (tier->channel, copy, suppression, approval). */
  outreachPlans: "pa-outreach-plans",
  /** v2.0 external-supply — Instantly sync record (dry-run or live) per plan. */
  instantlySyncRecords: "pa-instantly-sync-records",
  /**
   * v2.0 external-supply V1.1 — Mailgun direct-send sync record per plan.
   * Mailgun is the active email-delivery channel as of 2026-05-14
   * (Adam directive); Instantly stays in the codebase for an easy switch.
   */
  mailgunSyncRecords: "pa-mailgun-sync-records",
  /** v2.0 external-supply — append-only outreach events from Instantly / Mailgun / manual LinkedIn. */
  outreachEvents: "pa-outreach-events",
  /** v2.0 external-supply — monthly source-quality rollup metrics per external source. */
  sourceQualityMetrics: "pa-source-quality-metrics",
  /**
   * v2.0 external-supply V2 — per-candidate agent-ranking result row.
   * Operator-only read; mutations only via Admin SDK / callable. See
   * `apps/functions/src/external-supply/firestore-rules.note.md`.
   */
  agentRankingResults: "pa-agent-ranking-results",
  /**
   * Phase A3 (post-v1.7) — centralized company directory.
   * Shared with v2.0 external-supply (employer prefs) AND Phase A5
   * nightly enricher (stage/tags/funding from YC/Wikidata/Clearbit/LLM).
   * Operator-only read (sensitive employer competitor lists);
   * score-time reads in V16 go through Admin SDK via load-companies.ts.
   */
  companies: "pa-companies",
  /** Canonical practice interview question bank imported from legacy sources. */
  practiceQuestionBank: "pa-practice-question-bank",
  /**
   * v2.0 — candidate referral records.
   * Doc shape: { inviterId, inviteeEmail (lower), inviteeUserId?, stage, slug,
   *   rewardInterviewAmount/Paid, rewardPlacementAmount/Paid, payoutStatus,
   *   note, createdAt, updatedAt, detail? }.
   * Attribution rule: inviteeEmail is always the signing-up user's verified
   * auth email lower-cased; no fuzzy match.
   */
  referrals: "pa-referrals",
  /**
   * v2.0 — referral slug → inviter uid reverse index. Doc id is the URL slug
   * (e.g. `maya-okafor`). One doc per slug. Used by /r/:slug to resolve the
   * inviter for the hero copy + by signup attribution to find the right
   * referral row.
   */
  referralSlugs: "pa-referral-slugs",
  /**
   * Human-approve-then-send outbound queue. One doc = one queued message
   * awaiting operator approval before delivery; reusable across recovery /
   * ai_review / rec / reengage kinds. The queue NEVER sends — it is pure CRUD;
   * a separate approved-send worker (outside this contract) reads `approved`
   * rows and dispatches via the existing transport. Deterministic doc ids
   * (`pending-<userId>-<reasonCode>-<sourceSessionId|short>`) make backfill
   * re-runs idempotent (no duplicate queue rows). See `PendingOutboundSchema`.
   */
  pendingOutbound: "pa-pending-outbound",
} as const

/**
 * v2.0 external-supply V2 — bare constant export sibling of
 * `PA_COLLECTIONS.agentRankingResults`. Lead resolution L-A1
 * (EXECUTOR-PLANS.md §A): both surfaces required so V1 callables can use the
 * map while V2 helpers consume the bare const.
 */
export const PA_AGENT_RANKING_RESULTS = "pa-agent-ranking-results" as const

export const PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION = "items"
export const PA_JOB_ENRICHMENT_SUBCOLLECTION = "enrichment"
export const PA_JOB_ENRICHMENT_EVAL_FIXTURES_SUBCOLLECTION = "enrichment-eval-fixtures"

export const PA_REMOTE_CONFIG_DOC = "platform"
