/**
 * v1.9 Phase 88 — Sendblue multi-number pool selector.
 *
 * Pool config:
 *   pa-config/sendblue-pool { numbers: [{ number, status, capacity }] }
 *
 * Selector strategy:
 *   - Filter to status === "active"
 *   - hash(userId) mod activeNumbers.length → same user always routed to
 *     same number (thread continuity)
 *   - Fall back to env SENDBLUE_FROM_NUMBER when pool empty / unconfigured
 *
 * Single-number pool produces identical behavior to pre-v1.9.
 */

import type { Firestore } from "firebase-admin/firestore"

export interface SendbluePoolNumber {
  number: string
  status: "active" | "paused"
  /** Soft daily cap (used by cost ledger; not enforced at send time). */
  capacity?: number
}

export interface SendbluePoolConfig {
  numbers: SendbluePoolNumber[]
}

/** Stable string hash → unsigned 32-bit. djb2 variant. */
export function hashStringToUint(s: string): number {
  let h = 5381 >>> 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0
  }
  return h
}

/**
 * Pure selector — pick a from-number for a given userId from a pool config.
 * Returns null when pool has zero active numbers.
 */
export function pickFromNumber(
  pool: SendbluePoolConfig | null,
  userId: string
): string | null {
  if (!pool || !Array.isArray(pool.numbers)) return null
  const active = pool.numbers.filter((n) => n.status === "active" && n.number)
  if (active.length === 0) return null
  const idx = hashStringToUint(userId) % active.length
  return active[idx].number
}

/**
 * Cached pool fetch from Firestore. 60s TTL keeps the hot path fast while
 * letting admins flip numbers on/off in seconds.
 */
let cached: { config: SendbluePoolConfig | null; expiresAt: number } | null = null
const POOL_TTL_MS = 60 * 1000

export async function loadSendbluePool(db: Firestore): Promise<SendbluePoolConfig | null> {
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.config
  try {
    const snap = await db.collection("pa-config").doc("sendblue-pool").get()
    if (!snap.exists) {
      cached = { config: null, expiresAt: now + POOL_TTL_MS }
      return null
    }
    const data = snap.data() as SendbluePoolConfig
    cached = { config: data, expiresAt: now + POOL_TTL_MS }
    return data
  } catch {
    cached = { config: null, expiresAt: now + POOL_TTL_MS }
    return null
  }
}

/** Test seam — clear cache. */
export function _resetPoolCache(): void {
  cached = null
}
