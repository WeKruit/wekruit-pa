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
  candidateSourceLinks: "pa-candidate-source-links",
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
  | "sourceLinks"
  | "feedback"
  | "corrections"

export type MarketplaceRowsByKey = Record<MarketplaceTableKey, MarketplaceRow[]>

export type MarketplaceLearningLoopStatus =
  | "missing_matches"
  | "awaiting_feedback"
  | "needs_correction"
  | "learning"

export type MarketplaceLearningLoopMetric = {
  label: string
  value: string
  body: string
}

export type MarketplaceLearningLoopSummary = {
  status: MarketplaceLearningLoopStatus
  label: string
  body: string
  nextAction: string
  metrics: MarketplaceLearningLoopMetric[]
}

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
    key: "sourceLinks",
    title: "Source links",
    collection: S1_MARKETPLACE_COLLECTIONS.candidateSourceLinks,
    timeFields: ["createdAt"],
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
    sourceLinks: [],
    feedback: [],
    corrections: [],
  }
}

export function rowTime(row: MarketplaceRow, fields: readonly string[]): number {
  for (const field of fields) {
    const raw = row[field]
    const value = timeValue(raw)
    if (Number.isFinite(value)) return value
  }
  return 0
}

function timeValue(raw: unknown): number {
  if (typeof raw === "string") return Date.parse(raw)
  if (raw instanceof Date) return raw.getTime()
  if (raw && typeof raw === "object" && "toMillis" in raw && typeof raw.toMillis === "function") {
    return raw.toMillis()
  }
  if (raw && typeof raw === "object" && "seconds" in raw && typeof raw.seconds === "number") {
    return raw.seconds * 1000
  }
  return Number.NaN
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
  sourceLinks: number
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
    sourceLinks: rows.sourceLinks.length,
  }
}

export function summarizeMarketplaceLearningLoop(rows: MarketplaceRowsByKey): MarketplaceLearningLoopSummary {
  const matchCount = rows.matches.length
  const employerFeedback = rows.feedback.filter(isEmployerFeedbackEvent)
  const rejectedEmployerFeedback = employerFeedback.filter(isRejectedEmployerFeedbackEvent)
  const correctionCount = rows.corrections.length

  let status: MarketplaceLearningLoopStatus
  let label: string
  let body: string
  let nextAction: string

  if (matchCount === 0) {
    status = "missing_matches"
    label = "No match learning yet"
    body = "This candidate has no job-match artifacts for the marketplace loop to learn from."
    nextAction = "Run or review job matching before employer feedback can improve this profile."
  } else if (employerFeedback.length === 0) {
    status = "awaiting_feedback"
    label = "Awaiting employer feedback"
    body = "Match artifacts exist, but no accepted/rejected intro decision has taught the matcher what worked."
    nextAction = "Record accepted/rejected intro feedback from Passed Candidates once the hiring team responds."
  } else if (rejectedEmployerFeedback.length > 0 && correctionCount === 0) {
    status = "needs_correction"
    label = "Feedback needs correction signal"
    body = "Employer rejection feedback exists, but no correction event has converted that miss into durable learning."
    nextAction = "Convert rejection reason into a correction event so future matching avoids the same miss."
  } else {
    status = "learning"
    label = "Learning loop active"
    body = correctionCount
      ? "Match artifacts, employer feedback, and correction signal are connected for this candidate."
      : "Match artifacts and positive employer feedback are connected for this candidate."
    nextAction = correctionCount
      ? "Use the latest feedback and correction evidence before the next pass or outbound decision."
      : "Use the positive employer feedback before the next pass or outbound decision."
  }

  return {
    status,
    label,
    body,
    nextAction,
    metrics: [
      {
        label: "Match artifacts",
        value: String(matchCount),
        body: matchCount
          ? "Job-specific match rows available for this candidate."
          : "No job-specific match rows found yet.",
      },
      {
        label: "Employer feedback",
        value: String(employerFeedback.length),
        body: rejectedEmployerFeedback.length
          ? `${rejectedEmployerFeedback.length} rejected intro signal${rejectedEmployerFeedback.length === 1 ? "" : "s"} captured.`
          : employerFeedback.length
            ? "Accepted intro signal captured."
            : "No employer intro decision feedback found.",
      },
      {
        label: "Corrections",
        value: String(correctionCount),
        body: correctionCount
          ? "Correction events are available for regression or matching updates."
          : "No durable correction events are attached to this candidate yet.",
      },
    ],
  }
}

export function marketplaceExternalHref(value: unknown): string | undefined {
  const raw = firstMarketplaceText(value)
  if (!raw) return undefined
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^gs:\/\//i.test(raw)) return marketplaceStorageHref(raw)
  if (/^(?:www\.|linkedin\.com\/|github\.com\/|x\.com\/|twitter\.com\/)/i.test(raw)) {
    return `https://${raw}`
  }
  return undefined
}

export function marketplaceResumeArtifactFor(
  rows: readonly MarketplaceRow[],
  preferredArtifactId?: string
): MarketplaceRow | undefined {
  const preferred = preferredArtifactId?.trim()
  if (preferred) {
    const match = rows.find((row) =>
      [row.id, row.resumeId, row.parsedCandidateResumeId].some((value) => value === preferred)
    )
    if (match) return match
  }
  return rows[0]
}

export function marketplaceResumeOriginalSource(
  artifact?: MarketplaceRow | null,
  parsedResume?: MarketplaceRow | null
): { raw?: string; href?: string } {
  const raw = firstMarketplaceText(
    artifact?.storageUri,
    artifact?.mediaUrl,
    artifact?.resumeUrl,
    artifact?.sourceUrl,
    artifact?.fileUrl,
    parsedResume?.mediaUrl,
    parsedResume?.resumeUrl,
    parsedResume?.sourceUrl,
    parsedResume?.fileUrl
  )
  return { raw, href: marketplaceExternalHref(raw) }
}

export function isResolvedIdentityConflict(row: MarketplaceRow): boolean {
  const status = String(row.status ?? row.state ?? "").toLowerCase()
  return Boolean(row.resolvedAt) || ["resolved", "closed", "dismissed"].includes(status)
}

function firstMarketplaceText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function isEmployerFeedbackEvent(row: MarketplaceRow): boolean {
  const kind = String(row.kind ?? "").toLowerCase()
  const outcome = String(row.outcome ?? "").toLowerCase()
  const payload = row.payloadRedacted && typeof row.payloadRedacted === "object"
    ? row.payloadRedacted as Record<string, unknown>
    : {}
  const decision = String(payload.decision ?? "").toLowerCase()
  return kind === "employer_action" ||
    outcome === "intro_accepted" ||
    outcome === "intro_rejected" ||
    decision === "accepted" ||
    decision === "rejected"
}

function isRejectedEmployerFeedbackEvent(row: MarketplaceRow): boolean {
  const outcome = String(row.outcome ?? "").toLowerCase()
  const payload = row.payloadRedacted && typeof row.payloadRedacted === "object"
    ? row.payloadRedacted as Record<string, unknown>
    : {}
  const decision = String(payload.decision ?? "").toLowerCase()
  return outcome === "intro_rejected" || decision === "rejected"
}

function marketplaceStorageHref(value: string): string | undefined {
  const match = /^gs:\/\/([^/]+)\/(.+)$/i.exec(value.trim())
  if (!match) return undefined
  const bucket = encodeURIComponent(match[1]!)
  const objectPath = match[2]!
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
  return `https://storage.cloud.google.com/${bucket}/${objectPath}`
}
