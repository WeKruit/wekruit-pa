export const MATCH_DEBUG_DEFAULT_WEIGHTS = {
  llmMatch: 0.4,
  skillJaccard: 0.2,
  relevantTags: 0.15,
  industrySector: 0.1,
  cvEmbCosine: 0.1,
  salaryFit: 0.05,
} as const

export type MatchDebugWeightKey = keyof typeof MATCH_DEBUG_DEFAULT_WEIGHTS

export const MATCH_DEBUG_WEIGHT_KEYS: MatchDebugWeightKey[] = [
  "llmMatch",
  "skillJaccard",
  "relevantTags",
  "industrySector",
  "cvEmbCosine",
  "salaryFit",
]

export type MatchDebugDirection = "candidate_to_jobs" | "job_to_candidates"

export function matchDebugCallableName(direction: MatchDebugDirection): "paAdminMatchDebug" | "paAdminJobMatchDebug" {
  return direction === "candidate_to_jobs" ? "paAdminMatchDebug" : "paAdminJobMatchDebug"
}

export function matchDebugPrimaryInputLabel(direction: MatchDebugDirection): "userId" | "jobId" {
  return direction === "candidate_to_jobs" ? "userId" : "jobId"
}

export function buildCandidateDebugRequest(
  userId: string,
  weights: Record<MatchDebugWeightKey, number>,
  limit = 10
) {
  return {
    userId: userId.trim(),
    weightOverrides: weights,
    limit,
  }
}

export function buildJobDebugRequest(jobId: string, limit = 20) {
  return {
    jobId: jobId.trim(),
    limit,
  }
}

export function formatScore(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return value.toFixed(3)
}

export function actionTone(action: string | undefined): "ok" | "warn" | "muted" {
  if (action === "auto_outbound") return "ok"
  if (action === "hitl_review") return "warn"
  return "muted"
}

export function displaySponsorship(value: boolean | null | undefined): string {
  if (value === true) return "Yes"
  if (value === false) return "No"
  return "Unknown/Review"
}

export function compactList(values: unknown, fallback = "-"): string {
  if (!Array.isArray(values) || values.length === 0) return fallback
  return values.map((value) => String(value)).join(", ")
}
