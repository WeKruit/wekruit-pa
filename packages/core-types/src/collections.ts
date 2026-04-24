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
} as const

export const PA_REMOTE_CONFIG_DOC = "platform"
