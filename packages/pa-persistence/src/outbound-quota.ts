/**
 * Phase 26 T2 — Sendblue daily NEW-CONTACT counter (P9-Prod-Ops).
 *
 * Counts unique phone numbers contacted per day, NOT total messages sent.
 * A candidate who receives 5 prescreen questions counts as 1 contact.
 * A new phone never messaged today counts as 1 new contact.
 *
 * Doc shape: `pa-outbound-daily/{YYYYMMDD}` → `{ count, contacts: string[], lastUpdatedAt }`.
 * Operator runs Firestore TTL on `expiresAt` (set to date+30d) so historic
 * counters self-collect after a month.
 *
 * `incrementDailyOutbound(db, date, phone?)` only increments when `phone` is
 * not already in today's contacts set. Without a phone arg, always increments
 * (legacy compat — callers should migrate to pass phone).
 *
 * `getDailyOutboundCount(db, date)` returns the unique-contact count.
 */

import type { Firestore } from "firebase-admin/firestore"

export const OUTBOUND_QUOTA_COLLECTION = "pa-outbound-daily"

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

/**
 * Check whether `phone` is already a known contact for today's bucket.
 * Used by the quota gate to skip the increment for existing contacts.
 */
export async function isDailyContactKnown(
  db: Firestore,
  phone: string,
  date: Date = new Date()
): Promise<boolean> {
  const bucket = formatDailyBucket(date)
  const ref = db.collection(OUTBOUND_QUOTA_COLLECTION).doc(bucket)
  const snap = await ref.get()
  if (!snap.exists) return false
  const v = snap.data() as { contacts?: string[] } | undefined
  return Array.isArray(v?.contacts) && v.contacts.includes(phone)
}

/**
 * Record a new contact and increment the daily counter. If `phone` is provided
 * and already in today's contact set, this is a no-op (returns current count
 * without incrementing). Without `phone`, always increments (legacy compat).
 */
export async function incrementDailyOutbound(
  db: Firestore,
  date: Date = new Date(),
  phone?: string
): Promise<number> {
  const bucket = formatDailyBucket(date)
  const ref = db.collection(OUTBOUND_QUOTA_COLLECTION).doc(bucket)
  const nowIso = date.toISOString()
  const expiresAt = new Date(date.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  return await db.runTransaction(async (t) => {
    const snap = await (
      t.get as (r: typeof ref) => Promise<{ exists: boolean; data: () => unknown }>
    )(ref)
    const prev = snap.exists ? ((snap.data() as { count?: number; contacts?: string[] }) ?? {}) : {}
    const contacts: string[] = Array.isArray(prev.contacts) ? prev.contacts : []

    if (phone && contacts.includes(phone)) {
      return Number(prev.count ?? 0)
    }

    const next = Number(prev.count ?? 0) + 1
    const nextContacts = phone ? [...contacts, phone] : contacts
    const payload = {
      bucket,
      count: next,
      contacts: nextContacts,
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
