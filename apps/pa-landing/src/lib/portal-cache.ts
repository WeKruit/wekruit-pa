/**
 * portal-cache.ts — localStorage cache for /me critical-path data so the
 * portal renders instantly on repeat visits without waiting for callables.
 *
 * Cached per Firebase uid:
 *   - portalReady (from paCandidateMagicLinkVerify)
 *   - candidateId
 *   - selfProfile (from paCandidateClaimProfile)
 *
 * Flow:
 *   1. Mount: read cache → render UI optimistically.
 *   2. Background: call paCandidateMagicLinkVerify + paCandidateClaimProfile
 *      (or just Firestore onSnapshot) to refresh.
 *   3. On callable success: write cache.
 *   4. Sign-out / different uid: cache effectively invalid (different key).
 *
 * Adam directive 2026-05-27: "为什么不能直接读数据库 firestore? 然后 client
 * side cache?" Pure UX optimization — server gates remain authoritative.
 */
import type { CandidateSelfProfile } from "./candidate-profile-correction.js"

const CACHE_KEY_PREFIX = "pa_portal_v1:"

/**
 * Partial cache. The gate hook writes `portalReady`; the claim hook writes
 * `candidateId + selfProfile`. Readers consume whichever fields exist.
 */
export interface PortalCache {
  portalReady?: boolean
  candidateId?: string
  selfProfile?: CandidateSelfProfile
  /** Wall-clock ms when the cache row was last updated. */
  cachedAt: number
}

function key(uid: string): string {
  return `${CACHE_KEY_PREFIX}${uid}`
}

export function readPortalCache(uid: string | null | undefined): PortalCache | null {
  if (!uid) return null
  try {
    const raw = window.localStorage.getItem(key(uid))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PortalCache>
    if (typeof parsed.cachedAt !== "number") return null
    return parsed as PortalCache
  } catch {
    return null
  }
}

/** Shallow-merge `patch` into the cached row for `uid`. */
export function mergePortalCache(uid: string, patch: Omit<Partial<PortalCache>, "cachedAt">): void {
  try {
    const current = readPortalCache(uid) ?? { cachedAt: 0 }
    const next: PortalCache = { ...current, ...patch, cachedAt: Date.now() }
    window.localStorage.setItem(key(uid), JSON.stringify(next))
  } catch {
    // Quota / private mode — ignore. Next render still fetches.
  }
}

export function clearPortalCache(uid: string | null | undefined): void {
  if (!uid) return
  try {
    window.localStorage.removeItem(key(uid))
  } catch {
    // ignore
  }
}
