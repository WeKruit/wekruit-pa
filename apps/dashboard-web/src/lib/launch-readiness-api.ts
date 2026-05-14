import { httpsCallable } from "firebase/functions"

export const LAUNCH_READINESS_ROUTE = "/admin/launch-readiness"
export const LAUNCH_READINESS_SNAPSHOT_CALLABLE = "paAdminLaunchReadinessSnapshot"
export const OUTREACH_STOP_CONTROL_CALLABLE = "paAdminOutreachStopControl"
export const LAUNCH_READINESS_DEFAULT_LIMIT = 25

export type LaunchReadinessStatus = "green" | "yellow" | "red" | "unknown"
export type PrivacyRequestKind = "export" | "delete" | "stop_outreach" | "privacy_question"
export type PrivacyRequestStatus = "submitted" | "in_review" | "resolved" | "rejected" | "cancelled"

export interface LaunchReadinessSnapshotRequest {
  limit: number
  persistSnapshot?: boolean
}

export interface LaunchReadinessSection {
  key: string
  label: string
  status: LaunchReadinessStatus
  count?: number
  summary?: string
  sourceRoute?: string
  updatedAt?: string
}

export interface LaunchReadinessPrivacyRequestRow {
  requestId: string
  kind: PrivacyRequestKind
  status: PrivacyRequestStatus
  candidateId?: string
  sourceSurface?: string
  createdAt: string
  updatedAt?: string
}

export interface LaunchReadinessStopControlRow {
  controlId: string
  scope: "global" | "outreach_batch"
  scopeId?: string
  paused: boolean
  reason?: string
  updatedAt?: string
}

export interface LaunchReadinessSnapshot {
  snapshotId?: string
  generatedAt?: string
  status: LaunchReadinessStatus
  counts: Record<string, number>
  sections: LaunchReadinessSection[]
  privacyRequests: LaunchReadinessPrivacyRequestRow[]
  stopControls: LaunchReadinessStopControlRow[]
}

export interface LaunchReadinessResult {
  ok: true
  snapshot: LaunchReadinessSnapshot
  persisted: boolean
  created: boolean
}

export interface OutreachStopControlInput {
  scope: "global" | "outreach_batch"
  scopeId?: string
  paused: boolean
  reason?: string
}

export interface OutreachStopControlResult {
  ok: true
  control: LaunchReadinessStopControlRow
  changed: boolean
}

export function buildLaunchReadinessSnapshotRequest(
  limit?: number,
  persistSnapshot = true,
): LaunchReadinessSnapshotRequest {
  const parsed = Number.isFinite(limit) ? Math.trunc(Number(limit)) : LAUNCH_READINESS_DEFAULT_LIMIT
  return {
    limit: Math.max(1, Math.min(100, parsed || LAUNCH_READINESS_DEFAULT_LIMIT)),
    persistSnapshot,
  }
}

export async function getLaunchReadinessSnapshot(
  request: LaunchReadinessSnapshotRequest = buildLaunchReadinessSnapshotRequest(),
): Promise<LaunchReadinessResult> {
  const { functions } = await import("./firebase.js")
  const fn = httpsCallable<LaunchReadinessSnapshotRequest, Partial<LaunchReadinessResult>>(
    functions(),
    LAUNCH_READINESS_SNAPSHOT_CALLABLE,
  )
  const result = await fn(request)
  return normalizeLaunchReadinessResult(result.data, request)
}

export async function setOutreachStopControl(
  input: OutreachStopControlInput,
): Promise<OutreachStopControlResult> {
  const { functions } = await import("./firebase.js")
  const fn = httpsCallable<OutreachStopControlInput, OutreachStopControlResult>(
    functions(),
    OUTREACH_STOP_CONTROL_CALLABLE,
  )
  const result = await fn(input)
  return result.data
}

export function normalizeLaunchReadinessResult(
  result: Partial<LaunchReadinessResult> | null | undefined,
  request: LaunchReadinessSnapshotRequest = buildLaunchReadinessSnapshotRequest(),
): LaunchReadinessResult {
  const snapshot = (result?.snapshot ?? {}) as Partial<LaunchReadinessSnapshot>
  return {
    ok: true,
    persisted: Boolean(result?.persisted),
    created: Boolean(result?.created),
    snapshot: {
      snapshotId: snapshot.snapshotId,
      generatedAt: snapshot.generatedAt,
      status: normalizeStatus(snapshot.status),
      counts: normalizeCounts(snapshot.counts),
      sections: (snapshot.sections ?? []).map(normalizeSection),
      privacyRequests: (snapshot.privacyRequests ?? []).map(normalizePrivacyRequestRow),
      stopControls: (snapshot.stopControls ?? []).map(normalizeStopControlRow),
    },
  }
}

function normalizeStatus(status: unknown): LaunchReadinessStatus {
  return status === "green" || status === "yellow" || status === "red" || status === "unknown"
    ? status
    : "unknown"
}

function normalizeCounts(counts: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(counts ?? {})) {
    out[key] = Number.isFinite(Number(value)) ? Number(value) : 0
  }
  return out
}

function normalizeSection(section: Partial<LaunchReadinessSection>): LaunchReadinessSection {
  return {
    key: section.key ?? "unknown",
    label: section.label ?? "Unknown",
    status: normalizeStatus(section.status),
    count: section.count,
    summary: section.summary,
    sourceRoute: section.sourceRoute,
    updatedAt: section.updatedAt,
  }
}

function normalizePrivacyRequestRow(
  row: Partial<LaunchReadinessPrivacyRequestRow>
): LaunchReadinessPrivacyRequestRow {
  return {
    requestId: row.requestId ?? "unknown-request",
    kind: row.kind ?? "privacy_question",
    status: row.status ?? "submitted",
    candidateId: row.candidateId,
    sourceSurface: row.sourceSurface,
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt,
  }
}

function normalizeStopControlRow(
  row: Partial<LaunchReadinessStopControlRow>
): LaunchReadinessStopControlRow {
  return {
    controlId: row.controlId ?? "unknown-control",
    scope: row.scope ?? "global",
    scopeId: row.scopeId,
    paused: Boolean(row.paused),
    reason: row.reason,
    updatedAt: row.updatedAt,
  }
}
