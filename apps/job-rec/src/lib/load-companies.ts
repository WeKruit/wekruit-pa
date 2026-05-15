/**
 * Phase B5 — Score-time `pa-companies` lookup helper.
 *
 * Used by V16 `scoreJob` to enrich the post-hard-filter candidate set with
 * `companyStage` + `companyTags` from the centralized `pa-companies`
 * Firestore collection. Per GOAL spec section B5:
 *
 *   - Normalize each input name via `normalizeCompanyName` (doubles as doc id).
 *   - Batch up to 10 ids at a time (Firestore `in`-cap headroom; we use
 *     parallel `doc().get()` reads which is simpler than `where(FieldPath
 *     .documentId(), "in", chunk)` and behaves identically on the production
 *     Admin SDK plus the in-memory mock used by tests).
 *   - In-memory LRU cache: 1000 entries, 5-minute TTL, keyed by normalized
 *     name. Cache hits skip Firestore reads entirely.
 *   - Missing docs are *omitted* from the returned Map — the V16 caller
 *     handles absent keys with neutral defaults (no `unknown` stub here).
 *
 * Stage is informational only (weight 0 in score formula). Tags drive the
 * 0.15 Jaccard overlap signal in V16.
 */

import type { Firestore } from "firebase-admin/firestore"
import type { CompanyStage } from "@wekruit/shared-tags"
import { normalizeCompanyName } from "@pa/core-types"

export interface LoadedCompanyInfo {
  stage: CompanyStage
  /** `CompanyTag[]` in spirit; open-vocab — string[] at the type boundary. */
  tags: string[]
}

// ---------------------------------------------------------------------------
// Tunables (exported for tests)
// ---------------------------------------------------------------------------

/** Max entries retained in the in-memory LRU cache. */
export const LOAD_COMPANIES_CACHE_MAX = 1000
/** Cache TTL in milliseconds (5 minutes). */
export const LOAD_COMPANIES_CACHE_TTL_MS = 5 * 60 * 1000
/** Per-batch fan-out cap when fetching from Firestore. */
export const LOAD_COMPANIES_BATCH_SIZE = 10

// ---------------------------------------------------------------------------
// LRU cache (module-level — shared across all callers within a process)
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: LoadedCompanyInfo
  /** Epoch ms when this entry expires. */
  expiresAt: number
}

/**
 * `Map` preserves insertion order, so we treat the oldest key as the LRU
 * eviction candidate. On read-hit we `delete` then re-`set` to promote.
 */
const cache = new Map<string, CacheEntry>()

/** Test helper — flushes the LRU. NOT for production code. */
export function __resetLoadCompaniesCacheForTests(): void {
  cache.clear()
}

function cacheGet(key: string, now: number): LoadedCompanyInfo | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= now) {
    cache.delete(key)
    return undefined
  }
  // Promote to most-recently-used.
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function cacheSet(key: string, value: LoadedCompanyInfo, now: number): void {
  // Evict oldest until under cap (handles both fresh insert and re-set).
  if (cache.has(key)) cache.delete(key)
  while (cache.size >= LOAD_COMPANIES_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  cache.set(key, { value, expiresAt: now + LOAD_COMPANIES_CACHE_TTL_MS })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Batch-fetch `pa-companies` docs by their normalized-name doc ids.
 *
 * @param db    Admin-SDK Firestore handle (or mock satisfying the same shape).
 * @param names Raw company names — will be normalized internally; dedupe is
 *              applied before any Firestore I/O.
 *
 * @returns A `Map<normalizedName, LoadedCompanyInfo>` containing only the
 *          companies that exist in `pa-companies`. Missing docs are omitted.
 */
export async function loadCompaniesByName(
  db: Firestore,
  names: string[],
): Promise<Map<string, LoadedCompanyInfo>> {
  const result = new Map<string, LoadedCompanyInfo>()
  if (!Array.isArray(names) || names.length === 0) return result

  // 1. Normalize + dedupe input.
  const normalized = new Set<string>()
  for (const raw of names) {
    if (typeof raw !== "string" || raw.length === 0) continue
    const id = normalizeCompanyName(raw)
    if (id.length > 0) normalized.add(id)
  }
  if (normalized.size === 0) return result

  // 2. Drain cache hits first.
  const now = Date.now()
  const toFetch: string[] = []
  for (const id of normalized) {
    const hit = cacheGet(id, now)
    if (hit) {
      result.set(id, hit)
    } else {
      toFetch.push(id)
    }
  }
  if (toFetch.length === 0) return result

  // 3. Batch-fetch misses, up to 10 in flight per chunk.
  const coll = db.collection("pa-companies")
  for (let i = 0; i < toFetch.length; i += LOAD_COMPANIES_BATCH_SIZE) {
    const chunk = toFetch.slice(i, i + LOAD_COMPANIES_BATCH_SIZE)
    const snaps = await Promise.all(chunk.map((id) => coll.doc(id).get()))
    for (let j = 0; j < snaps.length; j++) {
      const id = chunk[j]!
      const snap = snaps[j]!
      if (!snap.exists) continue
      const data = snap.data() as Record<string, unknown> | undefined
      if (!data) continue
      const stage = (typeof data["companyStage"] === "string"
        ? (data["companyStage"] as CompanyStage)
        : "unknown") satisfies CompanyStage
      const rawTags = data["companyTags"]
      const tags = Array.isArray(rawTags)
        ? (rawTags.filter((t): t is string => typeof t === "string"))
        : []
      const info: LoadedCompanyInfo = { stage, tags }
      result.set(id, info)
      cacheSet(id, info, now)
    }
  }

  return result
}
