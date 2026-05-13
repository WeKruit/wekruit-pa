export type MarketplaceRow = Record<string, unknown> & { id: string }

export const S1_MARKETPLACE_COLLECTIONS = {
  candidateHandles: "pa-candidate-handles",
  resumeArtifacts: "pa-resume-artifacts",
  candidateJobStates: "pa-candidate-job-states",
  candidateJobMatches: "pa-candidate-job-matches",
  outboundInvites: "pa-outbound-invites",
  employerVisibleProfiles: "pa-employer-visible-profiles",
  feedbackEvents: "pa-feedback-events",
  correctionEvents: "pa-correction-events",
} as const

export const S2_IDENTITY_COLLECTIONS = {
  candidateAuth: "pa-candidate-auth",
  candidateSelfProfiles: "pa-candidate-self-profiles",
  identityEvents: "pa-candidate-identity-events",
  identityConflicts: "pa-candidate-identity-conflicts",
} as const

export type MarketplaceTableKey =
  | "authMappings"
  | "handles"
  | "resumes"
  | "jobStates"
  | "matches"
  | "invites"
  | "employerSnapshots"
  | "identityEvents"
  | "identityConflicts"
  | "feedback"
  | "corrections"

export type MarketplaceRowsByKey = Record<MarketplaceTableKey, MarketplaceRow[]>

export const MARKETPLACE_TABLES: {
  key: MarketplaceTableKey
  title: string
  collection: string
  timeFields: string[]
}[] = [
  {
    key: "authMappings",
    title: "Candidate auth mappings",
    collection: S2_IDENTITY_COLLECTIONS.candidateAuth,
    timeFields: ["lastClaimedAt", "updatedAt", "createdAt"],
  },
  {
    key: "handles",
    title: "Linked handles",
    collection: S1_MARKETPLACE_COLLECTIONS.candidateHandles,
    timeFields: ["updatedAt", "createdAt", "verifiedAt"],
  },
  {
    key: "resumes",
    title: "Resume artifacts",
    collection: S1_MARKETPLACE_COLLECTIONS.resumeArtifacts,
    timeFields: ["updatedAt", "createdAt"],
  },
  {
    key: "jobStates",
    title: "Candidate job states",
    collection: S1_MARKETPLACE_COLLECTIONS.candidateJobStates,
    timeFields: ["stateUpdatedAt", "updatedAt", "createdAt"],
  },
  {
    key: "matches",
    title: "Job matches",
    collection: S1_MARKETPLACE_COLLECTIONS.candidateJobMatches,
    timeFields: ["updatedAt", "createdAt"],
  },
  {
    key: "invites",
    title: "Outbound invites",
    collection: S1_MARKETPLACE_COLLECTIONS.outboundInvites,
    timeFields: ["updatedAt", "createdAt"],
  },
  {
    key: "employerSnapshots",
    title: "Employer-visible snapshots",
    collection: S1_MARKETPLACE_COLLECTIONS.employerVisibleProfiles,
    timeFields: ["createdAt"],
  },
  {
    key: "identityEvents",
    title: "Identity events",
    collection: S2_IDENTITY_COLLECTIONS.identityEvents,
    timeFields: ["createdAt"],
  },
  {
    key: "identityConflicts",
    title: "Identity conflicts",
    collection: S2_IDENTITY_COLLECTIONS.identityConflicts,
    timeFields: ["updatedAt", "createdAt"],
  },
  {
    key: "feedback",
    title: "Feedback events",
    collection: S1_MARKETPLACE_COLLECTIONS.feedbackEvents,
    timeFields: ["createdAt"],
  },
  {
    key: "corrections",
    title: "Correction events",
    collection: S1_MARKETPLACE_COLLECTIONS.correctionEvents,
    timeFields: ["createdAt"],
  },
]

export function emptyMarketplaceRows(): MarketplaceRowsByKey {
  return {
    authMappings: [],
    handles: [],
    resumes: [],
    jobStates: [],
    matches: [],
    invites: [],
    employerSnapshots: [],
    identityEvents: [],
    identityConflicts: [],
    feedback: [],
    corrections: [],
  }
}

export function rowTime(row: MarketplaceRow, fields: readonly string[]): number {
  for (const field of fields) {
    const raw = row[field]
    if (typeof raw !== "string") continue
    const value = Date.parse(raw)
    if (Number.isFinite(value)) return value
  }
  return 0
}

export function sortRowsByTime(rows: readonly MarketplaceRow[], fields: readonly string[]): MarketplaceRow[] {
  return [...rows].sort((a, b) => rowTime(b, fields) - rowTime(a, fields))
}

export function formatScore(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return value.toFixed(2)
}

export function formatPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return `${Math.round(value * 100)}%`
}

export function compactValue(value: unknown, max = 220): string {
  if (value === undefined || value === null || value === "") return "-"
  const raw = typeof value === "string" ? value : JSON.stringify(value)
  return raw.length > max ? `${raw.slice(0, max)}...` : raw
}

export function summarizeMarketplace(rows: MarketplaceRowsByKey): {
  totalJobStates: number
  passedJobs: number
  activeJobs: number
  notPassedJobs: number
  employerVisibleProfiles: number
  resumeArtifacts: number
  handles: number
  authMappings: number
  identityEvents: number
  openIdentityConflicts: number
} {
  const jobStates = rows.jobStates
  return {
    totalJobStates: jobStates.length,
    passedJobs: jobStates.filter((row) => row.state === "passed" || row.state === "employer_visible").length,
    activeJobs: jobStates.filter((row) =>
      ["candidate_matched", "outbound_queued", "outbound_sent", "candidate_interested", "prescreen_started", "paused"].includes(
        String(row.state)
      )
    ).length,
    notPassedJobs: jobStates.filter((row) => row.state === "not_passed").length,
    employerVisibleProfiles: rows.employerSnapshots.length,
    resumeArtifacts: rows.resumes.length,
    handles: rows.handles.length,
    authMappings: rows.authMappings.length,
    identityEvents: rows.identityEvents.length,
    openIdentityConflicts: rows.identityConflicts.filter((row) => !isResolvedIdentityConflict(row)).length,
  }
}

export function isResolvedIdentityConflict(row: MarketplaceRow): boolean {
  const status = String(row.status ?? row.state ?? "").toLowerCase()
  return Boolean(row.resolvedAt) || ["resolved", "closed", "dismissed"].includes(status)
}
