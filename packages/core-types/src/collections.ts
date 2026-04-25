/**
 * Firestore collection names for the personal-assistant platform.
 * Namespaced (`pa_*`) for shared Firebase project `wekruit-5f89b` alongside other products.
 */
export const PA_COLLECTIONS = {
  users: "pa_users",
  sessions: "pa_sessions",
  messages: "pa_messages",
  agents: "pa_agents",
  /** Feature flags / dynamic config (Remote Config pattern on Firestore) */
  remoteConfig: "pa_remote_config",
  /** Operator-queued iMessage send (consumed by macOS worker) */
  outbound: "pa_outbound",
  /** Durable inbound queue from channel adapters */
  inboundEvents: "pa_inbound_events",
  /** Per-turn orchestration state machine (broker arch) */
  agentTurns: "pa_agent_turns",
  /** Per-turn state machine consumed by pa-orchestrator (Phase 1 Mem0 path) */
  turns: "pa_turns",
  /** Memory action audit (remember/forget/list/clear) */
  memoryActions: "pa_memory_actions",
  /** Rolled-up conversation summaries */
  conversationSummaries: "pa_conversation_summaries",
  /** GCS pointer rows for archived month-bucketed messages */
  messageArchives: "pa_message_archives",
  /** Connector / tool invocation ledger */
  toolCalls: "pa_tool_calls",
  /** Append-only audit log */
  auditEvents: "pa_audit_events",
  /** Rate limit counters (sliding or fixed windows) */
  rateLimits: "pa_rate_limits",
  /** Abuse / safety signals */
  abuseEvents: "pa_abuse_events",
  /** Explicit links between channel sessions for one logical user */
  sessionLinks: "pa_session_links",
  /** Memory operator metadata and write/delete/export audit */
  memoryEvents: "pa_memory_events",
  agentVersions: "pa_agent_versions",
  memoryProfiles: "pa_memory_profiles",
  memoryFacts: "pa_memory_facts",
  memoryEvolutionEvents: "pa_memory_evolution_events",
  surpriseEvents: "pa_surprise_events",
  scheduledJobs: "pa_scheduled_jobs",
  runtimeHeartbeats: "pa_runtime_heartbeats",
} as const

export const PA_REMOTE_CONFIG_DOC = "platform"
