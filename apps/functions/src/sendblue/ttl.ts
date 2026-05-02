/**
 * Stream H9 TD1 — Firestore TTL helpers.
 *
 * Background: Firestore TTL only triggers on Timestamp fields, NOT on ISO
 * strings. Several collections in this codebase historically wrote
 * `updatedAt: new Date().toISOString()` and the deploy runbook pointed the
 * collection's TTL policy at `updatedAt` — which silently never expired
 * anything. P7-D flagged the gap during the outbound reliability sweep.
 *
 * Fix: write a parallel `expiresAtTs: Timestamp` field on every TTL-relevant
 * row, and (separately, via gcloud) re-point the TTL policy at it. The
 * existing `updatedAt` ISO string is retained so app-level queries that read
 * it as a string keep working.
 *
 * Per-collection retention (matches H9 brief):
 *   pa-outbound        → 30 days
 *   pa-inbound-events  → 60 days
 *   pa-trigger-fires   → 30 days
 *
 * gcloud command (logged for Adam to apply manually post-deploy):
 *   gcloud firestore fields ttls update expiresAtTs \
 *     --collection-group=pa-outbound \
 *     --enable-ttl --project=wekruit-5f89b
 *   (repeat for pa-inbound-events and pa-trigger-fires)
 *
 * Or programmatically via the existing setFirestoreTTL admin endpoint
 * (apps/functions/src/admin-bootstrap.ts:453).
 */

import { Timestamp } from "firebase-admin/firestore"

const DAY_MS = 24 * 60 * 60 * 1000

export const TTL_DAYS = {
  outbound: 30,
  inboundEvents: 60,
  triggerFires: 30,
} as const

/**
 * Compute a `Timestamp` N days from `now`. Used as the value of the
 * `expiresAtTs` field on rows participating in Firestore TTL GC.
 *
 * Consumers MUST write the result as a Timestamp (NOT an ISO string) — TTL
 * GC only fires on Timestamp-typed fields per Firestore's documentation.
 */
export function computeExpiresAtTs(days: number, now: Date = new Date()): Timestamp {
  return Timestamp.fromDate(new Date(now.getTime() + days * DAY_MS))
}

/** 30-day expiry for pa-outbound rows. */
export function outboundExpiresAtTs(now: Date = new Date()): Timestamp {
  return computeExpiresAtTs(TTL_DAYS.outbound, now)
}

/** 60-day expiry for pa-inbound-events rows. */
export function inboundEventExpiresAtTs(now: Date = new Date()): Timestamp {
  return computeExpiresAtTs(TTL_DAYS.inboundEvents, now)
}

/** 30-day expiry for pa-trigger-fires rows. */
export function triggerFireExpiresAtTs(now: Date = new Date()): Timestamp {
  return computeExpiresAtTs(TTL_DAYS.triggerFires, now)
}
