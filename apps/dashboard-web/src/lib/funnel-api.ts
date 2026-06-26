/**
 * Firebase callable wrappers for `paAdminFunnelSnapshot` +
 * `paAdminPassedNotVisibleList` (apps/functions/src/admin-funnel-snapshot.ts).
 * Both are admin-gated point-in-time reads over `pa-candidate-job-states`.
 * A small sessionStorage cache (3-min TTL) makes re-opening the page instant.
 */
import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase.js"

export const FUNNEL_SNAPSHOT_CALLABLE = "paAdminFunnelSnapshot"
export const PASSED_NOT_VISIBLE_CALLABLE = "paAdminPassedNotVisibleList"
export const FUNNEL_ROUTE = "/admin/funnel"

// Mirror of the CF's ordered ladder so the UI renders stages in funnel order
// even though the wire payload is already ordered.
export const FUNNEL_LADDER = [
  "candidate_matched",
  "outbound_queued",
  "outbound_sent",
  "candidate_interested",
  "prescreen_started",
  "prescreen_review_pending",
  "passed",
  "employer_visible",
  "intro_accepted",
] as const
export type FunnelLadderState = (typeof FUNNEL_LADDER)[number]

export const OFF_LADDER_STATES = ["not_passed", "intro_rejected", "paused", "archived"] as const
export type OffLadderState = (typeof OFF_LADDER_STATES)[number]

export const INTERVIEW_TRACK_STATES = [
  "interview_offered",
  "interview_booked",
  "interview_completed",
  "interview_no_show",
] as const
export type InterviewTrackTally = (typeof INTERVIEW_TRACK_STATES)[number]

/** Human label per ladder state (kept here so the page stays presentational). */
export const STATE_LABELS: Record<string, string> = {
  candidate_matched: "Matched",
  outbound_queued: "Outbound queued",
  outbound_sent: "Outbound sent",
  candidate_interested: "Interested",
  prescreen_started: "Prescreen started",
  prescreen_review_pending: "Review pending",
  passed: "Passed",
  employer_visible: "Employer-visible",
  intro_accepted: "Intro accepted",
  not_passed: "Not passed",
  intro_rejected: "Intro rejected",
  paused: "Paused",
  archived: "Archived",
  interview_offered: "Interview offered",
  interview_booked: "Interview booked",
  interview_completed: "Interview completed",
  interview_no_show: "Interview no-show",
}

export interface FunnelStageRow {
  state: FunnelLadderState
  count: number
  pctOfPrev: number | null
  pctOfTop: number | null
}

export interface AdminFunnelSnapshotResult {
  generatedAt: string
  includeTest: boolean
  total: number
  stages: FunnelStageRow[]
  offLadder: Record<OffLadderState, number>
  interview: Record<InterviewTrackTally, number>
  passedNotVisible: number
  truncated: boolean
}

export interface AdminFunnelSnapshotInput {
  includeTest?: boolean
}

export interface PassedNotVisibleRow {
  userId: string
  jobId: string
  state: string
  prescreenSessionId?: string
  passedAt: string
}

export interface AdminPassedNotVisibleResult {
  generatedAt: string
  includeTest: boolean
  total: number
  rows: PassedNotVisibleRow[]
  truncated: boolean
}

export interface AdminPassedNotVisibleInput {
  includeTest?: boolean
  limit?: number
}

const CLIENT_CACHE_TTL_MS = 3 * 60_000

function cached<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { at?: number; data?: T }
    if (parsed.data && typeof parsed.at === "number" && Date.now() - parsed.at < CLIENT_CACHE_TTL_MS) {
      return parsed.data
    }
  } catch {
    /* ignore cache read errors */
  }
  return null
}

function store<T>(key: string, data: T): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data }))
  } catch {
    /* ignore quota errors */
  }
}

export async function getFunnelSnapshot(
  input: AdminFunnelSnapshotInput,
): Promise<AdminFunnelSnapshotResult> {
  const key = `funnel-snapshot:v1:t${input.includeTest ? 1 : 0}`
  const hit = cached<AdminFunnelSnapshotResult>(key)
  if (hit) return hit
  const fn = httpsCallable<AdminFunnelSnapshotInput, AdminFunnelSnapshotResult>(
    functions(),
    FUNNEL_SNAPSHOT_CALLABLE,
  )
  const result = await fn(input)
  store(key, result.data)
  return result.data
}

export async function getPassedNotVisible(
  input: AdminPassedNotVisibleInput,
): Promise<AdminPassedNotVisibleResult> {
  const key = `passed-not-visible:v1:t${input.includeTest ? 1 : 0}:l${input.limit ?? 500}`
  const hit = cached<AdminPassedNotVisibleResult>(key)
  if (hit) return hit
  const fn = httpsCallable<AdminPassedNotVisibleInput, AdminPassedNotVisibleResult>(
    functions(),
    PASSED_NOT_VISIBLE_CALLABLE,
  )
  const result = await fn(input)
  store(key, result.data)
  return result.data
}
