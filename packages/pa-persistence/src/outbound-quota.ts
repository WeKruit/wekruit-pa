/**
 * Phase 26 T2 — Sendblue daily-outbound counter (P9-Prod-Ops).
 *
 * Doc shape: `pa_outbound_daily/{YYYYMMDD}` → `{ count, lastUpdatedAt }`.
 * Operator runs Firestore TTL on `expiresAt` (set to date+30d) so historic
 * counters self-collect after a month.
 *
 * `incrementDailyOutbound(db, date)` is transactional and returns the post-
 * increment count so callers can decide soft-warn vs hard-block in a single
 * round-trip. `getDailyOutboundCount(db, date)` is a read-only counterpart
 * for dashboards / pre-send observers.
 */

import type { Firestore } from "firebase-admin/firestore"

export const OUTBOUND_QUOTA_COLLECTION = "pa_outbound_daily"

/** Format `YYYYMMDD` UTC bucket id from a Date. */
export function formatDailyBucket(date: Date = new Date()): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0")
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0")
  const d = date.getUTCDate().toString().padStart(2, "0")
  return `${y}${m}${d}`
}

export async function getDailyOutboundCount(
  db: Firestore,
  date: Date = new Date()
): Promise<number> {
  const bucket = formatDailyBucket(date)
  const ref = db.collection(OUTBOUND_QUOTA_COLLECTION).doc(bucket)
  const snap = await ref.get()
  if (!snap.exists) return 0
  const v = snap.data() as { count?: number } | undefined
  return Number(v?.count ?? 0)
}

export async function incrementDailyOutbound(
  db: Firestore,
  date: Date = new Date()
): Promise<number> {
  const bucket = formatDailyBucket(date)
  const ref = db.collection(OUTBOUND_QUOTA_COLLECTION).doc(bucket)
  const nowIso = date.toISOString()
  // expiresAt = bucket date + 30 days, for Firestore TTL eligibility
  const expiresAt = new Date(date.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  return await db.runTransaction(async (t) => {
    const snap = await (
      t.get as (r: typeof ref) => Promise<{ exists: boolean; data: () => unknown }>
    )(ref)
    const prev = snap.exists ? ((snap.data() as { count?: number }) ?? {}) : {}
    const next = Number(prev.count ?? 0) + 1
    const payload = {
      bucket,
      count: next,
      lastUpdatedAt: nowIso,
      expiresAt,
    }
    if (snap.exists) {
      ;(t.update as (r: typeof ref, p: Record<string, unknown>) => unknown)(ref, payload)
    } else {
      ;(t.set as (r: typeof ref, p: Record<string, unknown>) => unknown)(ref, payload)
    }
    return next
  })
}
