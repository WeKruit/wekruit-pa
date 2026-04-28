/**
 * Phase 22 — Proactive check-in: pa_scheduled_jobs schema extension.
 *
 * Layered on top of Phase 7 scheduler conventions (status/attempts/maxAttempts/backoffSec).
 * DO NOT remove dueAt — Phase 7 callers depend on it. nextFireAt is the proactive-domain alias.
 *
 * Storage: existing `pa_scheduled_jobs` collection (PA_COLLECTIONS.scheduledJobs).
 * No new collection.
 *
 * NOTE: fireWindowHash uses a pure-JS SHA-1 implementation for browser compatibility
 * (the dashboard imports types from core-types). No node:crypto dependency.
 */

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
// Pure-JS SHA-1 for browser + Node compatibility (no node:crypto).
// ---------------------------------------------------------------------------

/**
 * Left-rotate for SHA-1.
 */
function rotl32(n: number, s: number): number {
  return ((n << s) | (n >>> (32 - s))) >>> 0
}

/**
 * Minimal pure-JS SHA-1. Produces a 40-char hex string.
 * Only used for fireWindowHash — not cryptographically sensitive
 * (the output is a dedup key, not a security primitive).
 */
function sha1Hex(message: string): string {
  // Convert string to UTF-8 bytes (ASCII subset only needed for jobId strings)
  const bytes: number[] = []
  for (let i = 0; i < message.length; i++) {
    const c = message.charCodeAt(i)
    if (c < 0x80) {
      bytes.push(c)
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }

  const msgLen = bytes.length
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const bitLen = msgLen * 8
  // Append 64-bit big-endian bit length (JS number safe up to 2^53)
  bytes.push(0, 0, 0, 0)
  bytes.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff)

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0

  for (let i = 0; i < bytes.length; i += 64) {
    const w = new Uint32Array(80)
    for (let j = 0; j < 16; j++) {
      w[j] = ((bytes[i + j * 4]! << 24) | (bytes[i + j * 4 + 1]! << 16) |
        (bytes[i + j * 4 + 2]! << 8) | bytes[i + j * 4 + 3]!) >>> 0
    }
    for (let j = 16; j < 80; j++) {
      w[j] = rotl32(w[j - 3]! ^ w[j - 8]! ^ w[j - 14]! ^ w[j - 16]!, 1)
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4]
    for (let j = 0; j < 80; j++) {
      let f: number, k: number
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
      else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const temp = (rotl32(a, 5) + f + e + k + w[j]!) >>> 0
      e = d; d = c; c = rotl32(b, 30); b = a; a = temp
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0
  }

  return [h0, h1, h2, h3, h4]
    .map((h) => h.toString(16).padStart(8, "0"))
    .join("")
}

/**
 * Returns a hex SHA-1 of `${jobId}:${Math.floor(nextFireAtMs / 60000)}`.
 * Same trigger fired within the same 60-second window always produces the
 * same hash — used as the deduplication key in pa_audit_events (D-06, PROACTIVE-05).
 *
 * Pure-JS implementation, no node:crypto — safe for browser bundles.
 *
 * @param jobId        - Firestore document id of the pa_scheduled_jobs row
 * @param nextFireAtMs - nextFireAt as Unix epoch milliseconds
 */
export function fireWindowHash(jobId: string, nextFireAtMs: number): string {
  const bucket = Math.floor(nextFireAtMs / 60000)
  return sha1Hex(`${jobId}:${bucket}`)
}
