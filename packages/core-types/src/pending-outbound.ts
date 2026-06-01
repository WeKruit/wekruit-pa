/**
 * pa-pending-outbound — human-approve-then-send outbound queue contract.
 *
 * One doc = one queued message that a human reviews before it is sent. The
 * queue is intentionally generic and reusable across recovery / ai_review /
 * rec / reengage flows (e.g. recovering users hit by a dup-send loop, queuing
 * an AI-drafted reply for review, queuing a job recommendation, or a
 * re-engagement nudge).
 *
 * Storage: `PA_COLLECTIONS.pendingOutbound` ("pa-pending-outbound").
 *
 * Invariants (mirrors v2.0 product rules):
 *  - `userId` is the internal pa-users doc id, NEVER raw PII.
 *  - `toE164` is denormalized at queue time for operator convenience but MUST
 *    be re-validated against the live pa-users handle at send time (a separate
 *    approved-send worker owns that step; this contract never sends anything).
 *  - Deterministic doc id `pending-<userId>-<reasonCode>-<sourceSessionId|short>`
 *    makes backfill re-runs idempotent — re-queuing the same logical message
 *    overwrites the same row instead of creating duplicates.
 *  - `suppressed` is the gate: an opt-out / cooldown blocks the send even if a
 *    human approves; the downstream sender must honor it.
 *  - State transitions (pending → approved → sent | skipped | failed) are owned
 *    by deterministic reducers / operator actions downstream. This schema only
 *    expresses the canonical persisted shape.
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Delivery channel for the queued message. Default `imessage`. */
export const PendingOutboundChannelSchema = z.enum(["imessage", "sms"])
export type PendingOutboundChannel = z.infer<typeof PendingOutboundChannelSchema>

/**
 * High-level reason family the queued message belongs to. Reusable buckets so
 * one queue powers recovery, AI-review, recommendation, and re-engagement.
 */
export const PendingOutboundKindSchema = z.enum([
  "recovery",
  "ai_review",
  "rec",
  "reengage",
])
export type PendingOutboundKind = z.infer<typeof PendingOutboundKindSchema>

/**
 * Machine-readable code for *why* this row was queued. Kept as an open string
 * (not an enum) so backfills can introduce new codes without a schema bump,
 * but the canonical / known codes are documented here:
 *  - `dup_send`         — duplicate-send loop detected
 *  - `chinese_in_prod`  — non-English copy leaked into a prod reply
 *  - `bot_error_loop`   — repeated bot-error responses
 *  - `failed_outbound`  — a prior outbound delivery failed
 *  - `dropoff`          — candidate went silent / dropped off
 */
export const PendingOutboundReasonCodeSchema = z.string().min(1)
export type PendingOutboundReasonCode = z.infer<
  typeof PendingOutboundReasonCodeSchema
>

/** Known machine reason codes (documentation/helper; not a closed enum). */
export const PENDING_OUTBOUND_REASON_CODES = Object.freeze({
  dupSend: "dup_send",
  chineseInProd: "chinese_in_prod",
  botErrorLoop: "bot_error_loop",
  failedOutbound: "failed_outbound",
  dropoff: "dropoff",
} as const)

/** Lifecycle status of a queued row. */
export const PendingOutboundStatusSchema = z.enum([
  "pending",
  "approved",
  "sent",
  "skipped",
  "failed",
])
export type PendingOutboundStatus = z.infer<typeof PendingOutboundStatusSchema>

// ---------------------------------------------------------------------------
// Document schema
// ---------------------------------------------------------------------------

/**
 * Canonical persisted shape of a `pa-pending-outbound` document.
 *
 * `id` MUST equal the Firestore doc id (the deterministic key built by
 * `pendingOutboundDocId`).
 */
export const PendingOutboundSchema = z.object({
  /** == doc id (deterministic key). */
  id: z.string().min(1),
  /** pa-users doc id (internal; never raw PII). */
  userId: z.string().min(1),
  /** Denormalized at queue time; RE-validated at send. */
  toE164: z.string().min(1).nullable(),
  /** Delivery channel. Defaults to `imessage`. */
  channel: PendingOutboundChannelSchema.default("imessage"),
  /** Reason family. */
  kind: PendingOutboundKindSchema,
  /** English-only, grounded copy; no over-apology. */
  draftBody: z.string().min(1),
  /** Human-readable reason (e.g. "dup_send x4 on 2026-05-2x"). */
  whyQueued: z.string().min(1),
  /** Machine code: dup_send | chinese_in_prod | bot_error_loop | failed_outbound | dropoff. */
  reasonCode: PendingOutboundReasonCodeSchema,
  /** Originating session, when known. */
  sourceSessionId: z.string().min(1).nullable(),
  /** Tags/profile snapshot at queue time, for operator context. */
  enrichmentSnapshot: z.record(z.string(), z.unknown()).nullable(),
  /** Lifecycle status. */
  status: PendingOutboundStatusSchema,
  /** True if opt-out / cooldown blocks the send (gate honored downstream). */
  suppressed: z.boolean(),
  /** Why suppressed, when applicable. */
  suppressedReason: z.string().min(1).nullable(),
  /** ISO 8601 queue timestamp. */
  createdAt: z.string().min(1),
  /** Operator who approved, when applicable. */
  approvedBy: z.string().min(1).nullable(),
  /** ISO 8601 approval timestamp. */
  approvedAt: z.string().min(1).nullable(),
  /** ISO 8601 send timestamp. */
  sentAt: z.string().min(1).nullable(),
  /** Last send error message, when a send attempt failed. */
  sendError: z.string().min(1).nullable(),
  /** Schema/migration version. */
  version: z.number().int().nonnegative(),
})

export type PendingOutbound = z.infer<typeof PendingOutboundSchema>

// ---------------------------------------------------------------------------
// Deterministic doc id
// ---------------------------------------------------------------------------

/**
 * Sanitize a free-form id segment to a Firestore-safe slug. Lowercases,
 * replaces anything that is not `[a-z0-9]` with `-`, and collapses repeats.
 */
function slugifySegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
}

/**
 * Builds the deterministic doc id for a queued message:
 *   `pending-<userId>-<reasonCode>-<sourceSessionId|short>`
 *
 * Re-running a backfill with the same `(userId, reasonCode, sourceSessionId)`
 * produces the same id, so the enqueue overwrites rather than duplicates. When
 * `sourceSessionId` is null/empty, a stable `nosession` segment is used.
 */
export function pendingOutboundDocId(args: {
  userId: string
  reasonCode: string
  sourceSessionId?: string | null
}): string {
  const user = slugifySegment(args.userId)
  const reason = slugifySegment(args.reasonCode)
  const sessionRaw = args.sourceSessionId
    ? slugifySegment(args.sourceSessionId)
    : ""
  const session = sessionRaw.length > 0 ? sessionRaw : "nosession"
  return `pending-${user}-${reason}-${session}`
}
