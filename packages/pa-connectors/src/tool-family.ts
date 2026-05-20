/**
 * Canonical tool-family taxonomy for pa_tool_calls audit rows and dashboards.
 * Maps connector / hosted-tool names to stable families (general vs collab match, etc.).
 */
export const PA_TOOL_FAMILIES = [
  "web_search",
  "memory",
  "match_general",
  "match_collab",
  "job_profile",
  "legacy_matching",
  "valet",
  "other",
] as const

export type PaToolFamily = (typeof PA_TOOL_FAMILIES)[number]

/** Resolve audit family from connector or hosted-tool name. */
export function resolveToolFamily(connectorName: string): PaToolFamily {
  switch (connectorName) {
    case "current-info":
    case "web_search":
      return "web_search"
    case "remember-fact":
      return "memory"
    case "find-match":
      return "match_general"
    case "match-against-collab-jobs":
      return "match_collab"
    case "save-job-profile":
      return "job_profile"
    case "wekruit-matching":
      return "legacy_matching"
    case "check-valet-install":
    case "valet-apply-status":
      return "valet"
    default:
      return "other"
  }
}
