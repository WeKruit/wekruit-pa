/**
 * iter30 WS1 — per-user CV parse quota (lifetime cap = 2).
 *
 * Field: `pa-users/{userId}.resumeParseCount`. Atomic increment via
 * `FieldValue.increment(1)` after a successful parse + Firestore write.
 *
 * On the 3rd attempt (count >= 2), ingestCv returns `{ ok: false,
 * reason: "quota_exhausted" }` and the webhook side enqueues a Claire-voice
 * rejection iMessage (idempotent per-user-per-day).
 *
 * Kill-switch: `PA_RESUME_QUOTA_DISABLED=true` env (cold-start).
 */

import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"

export const QUOTA_LIMIT = (() => {
  const env = parseInt(process.env.PA_RESUME_QUOTA_LIMIT ?? "2", 10)
  return Number.isFinite(env) && env >= 0 ? env : 2
})()

const PA_USERS_COLLECTION = "pa-users"

export function quotaKillSwitchOn(): boolean {
  const v = (process.env.PA_RESUME_QUOTA_DISABLED ?? "").trim().toLowerCase()
  return v === "true" || v === "1" || v === "on" || v === "yes"
}

export async function readQuotaCount(db: Firestore, userId: string): Promise<number> {
  try {
    const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
    const v = (snap.data() ?? {}) as { resumeParseCount?: unknown }
    return typeof v.resumeParseCount === "number" ? v.resumeParseCount : 0
  } catch {
    return 0
  }
}

export async function incrementQuota(
  db: Firestore,
  userId: string,
  nowIso: string
): Promise<void> {
  await db.collection(PA_USERS_COLLECTION).doc(userId).set(
    {
      resumeParseCount: FieldValue.increment(1),
      resumeParseLastAt: nowIso,
    },
    { merge: true }
  )
}

export function isQuotaExhausted(count: number): boolean {
  if (quotaKillSwitchOn()) return false
  return count >= QUOTA_LIMIT
}
