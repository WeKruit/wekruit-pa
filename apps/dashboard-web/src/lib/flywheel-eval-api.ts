export const FLYWHEEL_EVAL_CALLABLE_NAME = "paAdminFlywheelEvalSnapshot"
export const FLYWHEEL_EVAL_ROUTE = "/admin/flywheel-eval"
export const FLYWHEEL_EVAL_DEFAULT_LIMIT = 20

export type CountMap = Record<string, number>

export interface FlywheelEvalSnapshotRequest {
  limit: number
}

export interface FlywheelEvalArtifactRow {
  id: string
  artifactId?: string
  kind: string
  status: string
  sourceCorrectionEventIds: string[]
  sourceFeedbackEventIds: string[]
  candidateId?: string
  jobId?: string
  candidateJobStateId?: string
  payloadRedacted: Record<string, unknown>
  evidence: FlywheelEvalEvidenceSummary[]
  latestRunResult?: {
    status?: string
    runAt?: string
    summary?: string
  }
  createdAt?: string
  updatedAt?: string
}

export interface FlywheelEvalCorrectionRow {
  id: string
  eventId?: string
  targetType: string
  targetId?: string
  actor: string
  candidateId?: string
  jobId?: string
  reason?: string
  beforeRedacted: Record<string, unknown>
  afterRedacted: Record<string, unknown>
  evidence: FlywheelEvalEvidenceSummary[]
  createdAt?: string
}

export interface FlywheelEvalFeedbackRow {
  id: string
  eventId?: string
  kind: string
  actor: string
  outcome?: string
  candidateId?: string
  jobId?: string
  candidateJobStateId?: string
  payloadRedacted: Record<string, unknown>
  evidence: FlywheelEvalEvidenceSummary[]
  createdAt?: string
}

export interface FlywheelMarketplaceLoopCoverage {
  id: string
  label: string
  status: "covered" | "missing"
  count: number
  requirement: string
}

export interface FlywheelCoverageSummary {
  coveredLoops: number
  totalLoops: number
  allRequiredLoopsCovered: boolean
  marketplaceLoops: FlywheelMarketplaceLoopCoverage[]
}

export interface FlywheelEvalEvidenceSummary {
  source?: string
  summary: string
  confidence?: number
  refId?: string
}

export interface FlywheelEvalSnapshot {
  generatedAt?: string
  filters: FlywheelEvalSnapshotRequest
  counts: {
    artifactsByKind: CountMap
    artifactsByStatus: CountMap
    feedbackByKind: CountMap
    feedbackByOutcome: CountMap
    employerIntroByOutcome: CountMap
    correctionsByTarget: CountMap
    correctionsByActor: CountMap
  }
  coverage: FlywheelCoverageSummary
  recentArtifacts: FlywheelEvalArtifactRow[]
  recentCorrections: FlywheelEvalCorrectionRow[]
  recentFeedback: FlywheelEvalFeedbackRow[]
}

const MARKETPLACE_LOOP_COVERAGE_DEFAULTS: FlywheelMarketplaceLoopCoverage[] = [
  {
    id: "candidate_interview",
    label: "Candidate interview outcome",
    status: "missing",
    count: 0,
    requirement: "Candidate interview and behavior outcomes are feeding the flywheel.",
  },
  {
    id: "employer_intro",
    label: "Employer intro outcome",
    status: "missing",
    count: 0,
    requirement: "Employer accept/reject decisions are feeding the flywheel.",
  },
  {
    id: "recruiter_submission_review",
    label: "Recruiter submission review",
    status: "missing",
    count: 0,
    requirement: "WeKruit review outcomes for recruiter-submitted candidates are feeding the flywheel.",
  },
  {
    id: "recruiter_role_access",
    label: "Recruiter role access",
    status: "missing",
    count: 0,
    requirement: "Recruiter role approval/rejection decisions are feeding the flywheel.",
  },
  {
    id: "recruiter_role_feedback",
    label: "Recruiter role feedback",
    status: "missing",
    count: 0,
    requirement: "Recruiter role difficulty feedback is feeding the flywheel.",
  },
  {
    id: "hitl_correction",
    label: "HITL correction",
    status: "missing",
    count: 0,
    requirement: "Candidate, operator, or system corrections are feeding eval/regression artifacts.",
  },
  {
    id: "eval_artifact",
    label: "Eval artifact",
    status: "missing",
    count: 0,
    requirement: "Generated eval artifacts exist for regression or simulation coverage.",
  },
]

export function buildFlywheelEvalSnapshotRequest(limit?: number): FlywheelEvalSnapshotRequest {
  const parsed = Number.isFinite(limit) ? Math.trunc(Number(limit)) : FLYWHEEL_EVAL_DEFAULT_LIMIT
  return { limit: Math.max(1, Math.min(100, parsed || FLYWHEEL_EVAL_DEFAULT_LIMIT)) }
}

export async function getFlywheelEvalSnapshot(
  request: FlywheelEvalSnapshotRequest = buildFlywheelEvalSnapshotRequest(),
): Promise<FlywheelEvalSnapshot> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("./firebase.js"),
  ])
  const fn = httpsCallable<FlywheelEvalSnapshotRequest, Partial<FlywheelEvalSnapshot>>(
    firebase.functions(),
    FLYWHEEL_EVAL_CALLABLE_NAME,
  )
  const result = await fn(request)
  return normalizeFlywheelEvalSnapshot(result.data, request)
}

export function normalizeFlywheelEvalSnapshot(
  snapshot: Partial<FlywheelEvalSnapshot> | null | undefined,
  request: FlywheelEvalSnapshotRequest = buildFlywheelEvalSnapshotRequest(),
): FlywheelEvalSnapshot {
  return {
    generatedAt: snapshot?.generatedAt,
    filters: snapshot?.filters ?? request,
    counts: {
      artifactsByKind: normalizeCountMap(snapshot?.counts?.artifactsByKind),
      artifactsByStatus: normalizeCountMap(snapshot?.counts?.artifactsByStatus),
      feedbackByKind: normalizeCountMap(snapshot?.counts?.feedbackByKind),
      feedbackByOutcome: normalizeCountMap(snapshot?.counts?.feedbackByOutcome),
      employerIntroByOutcome: normalizeCountMap(snapshot?.counts?.employerIntroByOutcome),
      correctionsByTarget: normalizeCountMap(snapshot?.counts?.correctionsByTarget),
      correctionsByActor: normalizeCountMap(snapshot?.counts?.correctionsByActor),
    },
    coverage: normalizeCoverageSummary(snapshot?.coverage),
    recentArtifacts: (snapshot?.recentArtifacts ?? []).map(normalizeArtifactRow),
    recentCorrections: (snapshot?.recentCorrections ?? []).map(normalizeCorrectionRow),
    recentFeedback: (snapshot?.recentFeedback ?? []).map(normalizeFeedbackRow),
  }
}

function normalizeCountMap(value: CountMap | undefined): CountMap {
  const out: CountMap = {}
  for (const [key, count] of Object.entries(value ?? {})) {
    if (!key) continue
    const numeric = Number(count)
    out[key] = Number.isFinite(numeric) ? numeric : 0
  }
  return out
}

function normalizeCoverageSummary(value: Partial<FlywheelCoverageSummary> | undefined): FlywheelCoverageSummary {
  const byId = new Map((value?.marketplaceLoops ?? []).map((loop) => [loop.id, loop]))
  const marketplaceLoops = MARKETPLACE_LOOP_COVERAGE_DEFAULTS.map((fallback) => {
    const raw = byId.get(fallback.id)
    const count = Number(raw?.count ?? fallback.count)
    const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
    const status: FlywheelMarketplaceLoopCoverage["status"] =
      raw?.status === "covered" || normalizedCount > 0 ? "covered" : "missing"
    return {
      id: raw?.id ?? fallback.id,
      label: raw?.label ?? fallback.label,
      status,
      count: normalizedCount,
      requirement: raw?.requirement ?? fallback.requirement,
    }
  })
  const coveredLoops = marketplaceLoops.filter((loop) => loop.status === "covered").length
  return {
    coveredLoops,
    totalLoops: marketplaceLoops.length,
    allRequiredLoopsCovered: coveredLoops === marketplaceLoops.length,
    marketplaceLoops,
  }
}

function normalizeArtifactRow(row: Partial<FlywheelEvalArtifactRow>): FlywheelEvalArtifactRow {
  return {
    id: row.id ?? row.artifactId ?? "unknown-artifact",
    artifactId: row.artifactId,
    kind: row.kind ?? "unknown",
    status: row.status ?? "unknown",
    sourceCorrectionEventIds: row.sourceCorrectionEventIds ?? [],
    sourceFeedbackEventIds: row.sourceFeedbackEventIds ?? [],
    candidateId: row.candidateId,
    jobId: row.jobId,
    candidateJobStateId: row.candidateJobStateId,
    payloadRedacted: row.payloadRedacted ?? {},
    evidence: normalizeEvidence(row.evidence),
    latestRunResult: row.latestRunResult,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function normalizeCorrectionRow(row: Partial<FlywheelEvalCorrectionRow>): FlywheelEvalCorrectionRow {
  return {
    id: row.id ?? row.eventId ?? "unknown-correction",
    eventId: row.eventId,
    targetType: row.targetType ?? "unknown",
    targetId: row.targetId,
    actor: row.actor ?? "unknown",
    candidateId: row.candidateId,
    jobId: row.jobId,
    reason: row.reason,
    beforeRedacted: row.beforeRedacted ?? {},
    afterRedacted: row.afterRedacted ?? {},
    evidence: normalizeEvidence(row.evidence),
    createdAt: row.createdAt,
  }
}

function normalizeFeedbackRow(row: Partial<FlywheelEvalFeedbackRow>): FlywheelEvalFeedbackRow {
  return {
    id: row.id ?? row.eventId ?? "unknown-feedback",
    eventId: row.eventId,
    kind: row.kind ?? "unknown",
    actor: row.actor ?? "unknown",
    outcome: row.outcome,
    candidateId: row.candidateId,
    jobId: row.jobId,
    candidateJobStateId: row.candidateJobStateId,
    payloadRedacted: row.payloadRedacted ?? {},
    evidence: normalizeEvidence(row.evidence),
    createdAt: row.createdAt,
  }
}

function normalizeEvidence(rows: FlywheelEvalEvidenceSummary[] | undefined): FlywheelEvalEvidenceSummary[] {
  return (rows ?? []).map((row) => ({
    source: row.source,
    summary: row.summary ?? "",
    confidence: row.confidence,
    refId: row.refId,
  }))
}
