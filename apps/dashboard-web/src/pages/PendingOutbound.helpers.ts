/**
 * Pure view-model helpers for the /admin/pending-outbound page. Kept separate
 * (and dependency-free) so they can be unit-tested under the node:test harness
 * without rendering React or booting firebase (same pattern as
 * BulkResumes.helpers.ts / OutreachOps.helpers.ts).
 */
import type {
  PendingOutboundRow,
  PendingOutboundStatus,
} from "../lib/pending-outbound-api.js"

export type Tone = "ok" | "warn" | "info" | "muted"

/** Status -> badge tone for the queue table. */
export function statusTone(status: PendingOutboundStatus): Tone {
  switch (status) {
    case "sent":
      return "ok"
    case "approved":
      return "info"
    case "failed":
    case "skipped":
      return "warn"
    case "pending":
    default:
      return "muted"
  }
}

/**
 * A row is SENDABLE only if it is `approved` and NOT suppressed. Suppressed
 * rows (opt-out / cooldown) are never sendable from the UI — this mirrors the
 * server-side hard gate so the operator never even sees a live "Send" affordance
 * for a blocked recipient.
 */
export function isSendable(row: PendingOutboundRow): boolean {
  return row.status === "approved" && !row.suppressed
}

/**
 * A row can be selected for a BATCH operation (approve-selected / send-approved)
 * only when it is actionable: pending or approved, and not suppressed. Suppressed
 * rows can never be batch-selected.
 */
export function isBatchSelectable(row: PendingOutboundRow): boolean {
  if (row.suppressed) return false
  return row.status === "pending" || row.status === "approved"
}

/** Rows eligible to be approved in a batch "approve selected" pass. */
export function approvableFromSelection(
  rows: PendingOutboundRow[],
  selectedIds: ReadonlySet<string>
): PendingOutboundRow[] {
  return rows.filter(
    (r) => selectedIds.has(r.id) && r.status === "pending" && !r.suppressed
  )
}

/**
 * Rows eligible for a rolling "send approved" pass: approved + not suppressed.
 * Optionally restricted to the current selection. The send itself is rolling
 * (one-at-a-time) and server-gated; this only computes the candidate set.
 */
export function sendableFromSelection(
  rows: PendingOutboundRow[],
  selectedIds?: ReadonlySet<string>
): PendingOutboundRow[] {
  return rows.filter(
    (r) => isSendable(r) && (!selectedIds || selectedIds.has(r.id))
  )
}

export type ReasonGroup = {
  reasonCode: string
  rows: PendingOutboundRow[]
  /** Count of rows currently sendable in this group. */
  sendableCount: number
  /** Count of suppressed rows in this group. */
  suppressedCount: number
}

/**
 * Group rows by `reasonCode` (dup_send / chinese_in_prod / ...). Groups are
 * ordered by descending size, then alphabetically for stable rendering.
 */
export function groupByReasonCode(rows: PendingOutboundRow[]): ReasonGroup[] {
  const map = new Map<string, PendingOutboundRow[]>()
  for (const row of rows) {
    const key = row.reasonCode || "unknown"
    const arr = map.get(key)
    if (arr) arr.push(row)
    else map.set(key, [row])
  }
  const groups: ReasonGroup[] = []
  for (const [reasonCode, groupRows] of map.entries()) {
    groups.push({
      reasonCode,
      rows: groupRows,
      sendableCount: groupRows.filter(isSendable).length,
      suppressedCount: groupRows.filter((r) => r.suppressed).length,
    })
  }
  groups.sort((a, b) => {
    if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length
    return a.reasonCode < b.reasonCode ? -1 : 1
  })
  return groups
}

/** Human label for a send outcome reason code returned by the server. */
export function sendReasonLabel(reason: string): string {
  switch (reason) {
    case "sent":
      return "Sent"
    case "send_not_wired":
      return "Send not wired (live Sendblue dispatch is gated — pending wiring)"
    case "no_reachable_handle_at_send_time":
      return "No reachable handle at send time"
    case "opted_out":
    case "opted_out_at_send_time":
      return "Candidate opted out"
    case "do_not_contact":
      return "Candidate is do-not-contact"
    case "outreach_paused":
      return "Outreach paused for candidate"
    case "send_failed":
      return "Send failed (provider error)"
    default:
      if (reason.startsWith("suppressed")) return reason
      return reason
  }
}

/** Compact summary for the page header. */
export function summarize(rows: PendingOutboundRow[]): {
  total: number
  pending: number
  approved: number
  suppressed: number
  sendable: number
} {
  return {
    total: rows.length,
    pending: rows.filter((r) => r.status === "pending").length,
    approved: rows.filter((r) => r.status === "approved").length,
    suppressed: rows.filter((r) => r.suppressed).length,
    sendable: rows.filter(isSendable).length,
  }
}
