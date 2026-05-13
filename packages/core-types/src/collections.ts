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
  /** Operator-queued iMessage send (consumed by macOS worker) */
  outbound: "pa-outbound",
  /** Durable inbound queue from channel adapters */
  inboundEvents: "pa-inbound-events",
  /** Per-turn orchestration state machine (broker arch) */
  agentTurns: "pa-agent-turns",
  /** Per-turn state machine consumed by pa-orchestrator (Phase 1 Mem0 path) */
  turns: "pa-turns",
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
} as const

export const PA_BULK_UPLOAD_ITEMS_SUBCOLLECTION = "items"

export const PA_REMOTE_CONFIG_DOC = "platform"
