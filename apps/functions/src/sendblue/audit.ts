/**
 * Audit producer for Sendblue webhook surface.
 *
 * Writes to `pa-audit-events` (PA_COLLECTIONS.auditEvents). Every deny / drop
 * path through the webhook produces a record so the dashboard abuse panel
 * (BETA-03 dependency) can surface them.
 */

import { PA_COLLECTIONS } from "@pa/core-types"
import type { Firestore } from "firebase-admin/firestore"

export type AuditEventType =
  | "allowlist_deny"
  | "group_chat_rejected"
  | "inbound_skipped"
  | "outbound_mirror"
  | "typing_indicator_received"
  | "line_blocked_received"
  | "signature_failure"
  | "malformed_body"
  | "outbound_event_logged"
  | "rate_limit_exceeded"
  | "quota_soft"
  | "quota_hardblock"
  // Phase 60 (DEV-01) — admin-only iMessage trigger that force-fires v1.6
  // match cascade. Audited so dashboards can surface "Adam ran __PA_FIND_MATCH__"
  // events alongside normal traffic.
  | "dev_trigger_find_match"

export type AuditChannel =
  | "imessage_sendblue"
  | "imessage_legacy"
  | "sms_sendblue"

export type AuditEventInput = {
  type: AuditEventType
  channel: AuditChannel
  fromNumber?: string
  toNumber?: string
  reason?: string
  payload?: Record<string, unknown>
  /** Optional correlation id (e.g. message_handle). */
  correlationId?: string
}

export async function recordAuditEvent(
  db: Firestore,
  input: AuditEventInput,
  now: Date = new Date()
): Promise<void> {
  const ts = now.toISOString()
  await db.collection(PA_COLLECTIONS.auditEvents).add({
    type: input.type,
    channel: input.channel,
    ...(input.fromNumber ? { fromNumber: input.fromNumber } : {}),
    ...(input.toNumber ? { toNumber: input.toNumber } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    createdAt: ts,
  })
}
