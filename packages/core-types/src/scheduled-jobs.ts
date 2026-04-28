/**
 * Phase 22 — Proactive check-in: pa_scheduled_jobs schema extension.
 *
 * Layered on top of Phase 7 scheduler conventions (status/attempts/maxAttempts/backoffSec).
 * DO NOT remove dueAt — Phase 7 callers depend on it. nextFireAt is the proactive-domain alias.
 *
 * Storage: existing `pa_scheduled_jobs` collection (PA_COLLECTIONS.scheduledJobs).
 * No new collection.
 */
import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Trigger types (D-03: exactly 3 in v1)
// ---------------------------------------------------------------------------

export type ProactiveTriggerType = "time_anchor" | "silence_anchor" | "application_followup"

// ---------------------------------------------------------------------------
// Recurrence (D-12: only 2 modes in v1)
// ---------------------------------------------------------------------------

export type ProactiveRecurrence = "once" | "silence_rearm"

// ---------------------------------------------------------------------------
// Context — discriminated union by triggerType
// Each variant is self-describing so Firestore inspection needs no code.
// ---------------------------------------------------------------------------

export type TimeAnchorContext = {
  triggerType: "time_anchor"
  /** Human-readable label for the event (e.g. "面试 Acme Corp") */
  eventLabel: string
  /** Unix epoch ms of the event itself */
  eventAt: number
  /** Seconds before eventAt to fire the proactive message */
  leadTimeSec: number
}

export type SilenceAnchorContext = {
  triggerType: "silence_anchor"
  /** Silence window in seconds — fire when (now − lastUserMsgAt) > windowSec */
  windowSec: number
  /** Unix epoch ms of the user's most recent inbound message at trigger-create time */
  lastUserMsgAt: number
}

export type ApplicationFollowupContext = {
  triggerType: "application_followup"
  companyName: string
  jobTitle: string
  /** Unix epoch ms when the user submitted the application */
  appliedAt: number
  /** Seconds after appliedAt to fire the follow-up message */
  followupAfterSec: number
}

export type ProactiveJobContext =
  | TimeAnchorContext
  | SilenceAnchorContext
  | ApplicationFollowupContext

// ---------------------------------------------------------------------------
// Job status (superset of Phase 7 — proactive statuses added)
// ---------------------------------------------------------------------------

export const PROACTIVE_JOB_STATUS = Object.freeze({
  pending: "pending",
  running: "running",
  fired: "fired",
  cancelled_by_user: "cancelled_by_user",
  failed: "failed",
  dead_letter: "dead_letter",
} as const)

export type ProactiveJobStatus = (typeof PROACTIVE_JOB_STATUS)[keyof typeof PROACTIVE_JOB_STATUS]

// ---------------------------------------------------------------------------
// ScheduledJob — extends Phase 7 base without removing any field
// ---------------------------------------------------------------------------

/**
 * Proactive ScheduledJob row stored in pa_scheduled_jobs.
 *
 * Phase 7 base fields are preserved:
 *   - dueAt: ISO string (Phase 7 legacy alias for nextFireAt; write BOTH at create time)
 *   - attempts / maxAttempts / backoffSec
 *
 * Phase 22 adds:
 *   - jobId (doc id alias for readability)
 *   - userId
 *   - triggerType
 *   - nextFireAt (ISO string or Timestamp-compatible; proactive-domain canonical)
 *   - recurrence
 *   - context (discriminated union per triggerType)
 *   - lastFiredAt (optional, set by proactive-turn on fire)
 */
export interface ScheduledJob {
  // ─── Phase 22 fields ────────────────────────────────────────────────────
  jobId: string
  userId: string
  triggerType: ProactiveTriggerType
  /**
   * Proactive-domain canonical fire time (ISO string or Firestore Timestamp-like).
   * At job-create time, ALSO write `dueAt = nextFireAt` for Phase 7 compatibility.
   */
  nextFireAt: string
  recurrence: ProactiveRecurrence
  context: ProactiveJobContext
  status: ProactiveJobStatus
  createdAt: string
  lastFiredAt?: string

  // ─── Phase 7 base fields (DO NOT remove) ────────────────────────────────
  /**
   * Phase 7 legacy alias. Always set equal to nextFireAt at job-create time.
   * Sweep queries that predate Phase 22 may filter on dueAt.
   */
  dueAt: string
  attempts: number
  maxAttempts: number
  /** Seconds — Phase 22 convention; Phase 7 used backoffMs but proactive jobs
   *  store seconds to stay human-readable in Firestore. The sweep handler
   *  converts: nextFireAt = now + backoffSec * 1000. */
  backoffSec: number
}

// ---------------------------------------------------------------------------
// fireWindowHash — idempotency key per (jobId × 1-minute bucket) (D-06)
// ---------------------------------------------------------------------------

/**
 * Returns a hex SHA-1 of `${jobId}:${Math.floor(nextFireAtMs / 60000)}`.
 * Same trigger fired within the same 60-second window always produces the
 * same hash — used as the deduplication key in pa_audit_events.
 *
 * @param jobId      - Firestore document id of the pa_scheduled_jobs row
 * @param nextFireAtMs - nextFireAt as Unix epoch milliseconds
 */
export function fireWindowHash(jobId: string, nextFireAtMs: number): string {
  const bucket = Math.floor(nextFireAtMs / 60000)
  return createHash("sha1").update(`${jobId}:${bucket}`).digest("hex")
}
