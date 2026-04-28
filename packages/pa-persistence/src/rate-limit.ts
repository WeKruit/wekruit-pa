/**
 * Phase 26 T1 — per-user rate-limit (token bucket via Firestore docs).
 *
 * Doc shape: `pa_rate_limit/{userId}_{minuteBucket}` → `{ count, expiresAt }`.
 * `expiresAt` is a Firestore-TTL-eligible field; operator configures a TTL
 * policy on the collection so stale buckets self-collect (no manual sweeper).
 *
 * `checkAndIncrementRateLimit(db, userId, { limit, windowSec })` is
 * transactional: read current count, +1 if under limit, return `{ allowed,
 * remaining }`. When at/over limit, increment is skipped and `allowed=false`.
 *
 * Bucket key derivation:
 *   minuteBucket = floor(now_ms / (windowSec * 1000))
 * which produces a stable integer per `windowSec` slice. Default
 * `windowSec=60` yields the documented "20 messages per minute" semantics
 * (CONTEXT.md success #6).
 */

import type { Firestore } from "firebase-admin/firestore"

export const RATE_LIMIT_COLLECTION = "pa_rate_limit"

export interface RateLimitOptions {
  limit?: number
  windowSec?: number
  /** Inject for tests so the bucket id is deterministic. */
  now?: () => number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  bucketId: string
}

function bucketDocId(userId: string, nowMs: number, windowSec: number): {
  bucketId: string
  bucketIndex: number
} {
  const bucketIndex = Math.floor(nowMs / (windowSec * 1000))
  return { bucketId: `${userId}_${bucketIndex}`, bucketIndex }
}

export async function checkAndIncrementRateLimit(
  db: Firestore,
  userId: string,
  opts: RateLimitOptions = {}
): Promise<RateLimitResult> {
  const limit = opts.limit ?? 20
  const windowSec = opts.windowSec ?? 60
  const nowMs = opts.now ? opts.now() : Date.now()
  const { bucketId } = bucketDocId(userId, nowMs, windowSec)
  const ref = db.collection(RATE_LIMIT_COLLECTION).doc(bucketId)
  const expiresAtMs = nowMs + windowSec * 1000

  return await db.runTransaction(async (t) => {
    const snap = await (
      t.get as (r: typeof ref) => Promise<{ exists: boolean; data: () => unknown }>
    )(ref)
    const prev = snap.exists ? ((snap.data() as { count?: number }) ?? {}) : {}
    const prevCount = Number(prev.count ?? 0)

    if (prevCount >= limit) {
      return { allowed: false, remaining: 0, bucketId }
    }
    const nextCount = prevCount + 1
    const payload = {
      count: nextCount,
      expiresAt: new Date(expiresAtMs).toISOString(),
      userId,
      bucketId,
      updatedAt: new Date(nowMs).toISOString(),
    }
    if (snap.exists) {
      ;(t.update as (r: typeof ref, p: Record<string, unknown>) => unknown)(ref, payload)
    } else {
      ;(t.set as (r: typeof ref, p: Record<string, unknown>) => unknown)(ref, payload)
    }
    return { allowed: true, remaining: Math.max(0, limit - nextCount), bucketId }
  })
}
