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
  recentArtifacts: FlywheelEvalArtifactRow[]
  recentCorrections: FlywheelEvalCorrectionRow[]
  recentFeedback: FlywheelEvalFeedbackRow[]
}

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
