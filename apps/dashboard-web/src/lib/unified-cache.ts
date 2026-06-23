/**
 * Unified front-end cache for the whole admin dashboard.
 *
 * Problem: every page did fresh Firestore `getDocs` / callable fetches on mount,
 * so navigating back to a page re-read thousands of docs and took ~20s EVERY
 * time. There was no shared cache (only a couple of per-callable sessionStorage
 * caches). This is the one cache all pages route through.
 *
 * Two layers:
 *  - L1 in-memory Map — survives SPA navigation (instant re-open within a tab
 *    session). Preserves rich values (Map/Set/class instances) by reference.
 *  - L2 sessionStorage — survives a tab reload (best-effort JSON; values that
 *    can't serialize, e.g. Map/Set, simply stay L1-only).
 *
 * Use `cachedLoad(key, loader, ttl)` to wrap an imperative load (a fresh hit
 * skips the loader entirely), or `useCachedResource(key, loader, ttl)` for a
 * stale-while-revalidate hook (instant cached render + background refresh).
 * `invalidate` / `invalidatePrefix` clear entries (wire to a Refresh button or
 * after a mutation).
 */
import { useCallback, useEffect, useRef, useState } from "react"

interface Entry {
  at: number
  data: unknown
}

const L1 = new Map<string, Entry>()
const L2_PREFIX = "dwcache:"

/** Default freshness window. Re-opening a page inside this is instant. */
export const DEFAULT_CACHE_TTL_MS = 3 * 60_000

function readL2(key: string): Entry | null {
  try {
    const raw = sessionStorage.getItem(L2_PREFIX + key)
    if (raw) {
      const e = JSON.parse(raw) as Entry
      if (e && typeof e.at === "number") return e
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Map/Set values stringify to `{}` WITHOUT throwing, which would silently store
 * a corrupt empty object in L2 and then crash callers on reload (e.g. a cached
 * `Map` read back as `{}` → `.get is not a function`). So values that contain a
 * Map/Set are kept L1-only — they survive navigation and are simply re-fetched
 * on a tab reload.
 */
function isJsonSafe(v: unknown): boolean {
  if (v instanceof Map || v instanceof Set) return false
  if (v && typeof v === "object") {
    for (const val of Object.values(v as Record<string, unknown>)) {
      if (val instanceof Map || val instanceof Set) return false
    }
  }
  return true
}

function writeL2(key: string, e: Entry): void {
  if (!isJsonSafe(e.data)) return // Map/Set → L1-only (see isJsonSafe).
  try {
    sessionStorage.setItem(L2_PREFIX + key, JSON.stringify(e))
  } catch {
    // Quota or other serialization issue — L1 still holds the value.
  }
}

/** Returns the cached value + whether it is past `ttlMs`, or null on a miss. */
export function readCache<T>(key: string, ttlMs: number): { data: T; stale: boolean } | null {
  let e = L1.get(key)
  if (!e) {
    const l2 = readL2(key)
    if (l2) {
      L1.set(key, l2)
      e = l2
    }
  }
  if (!e) return null
  return { data: e.data as T, stale: Date.now() - e.at >= ttlMs }
}

export function writeCache<T>(key: string, data: T): void {
  const e: Entry = { at: Date.now(), data }
  L1.set(key, e)
  writeL2(key, e)
}

export function invalidate(key: string): void {
  L1.delete(key)
  try {
    sessionStorage.removeItem(L2_PREFIX + key)
  } catch {
    /* ignore */
  }
}

/** Clear every entry whose key starts with `prefix` (e.g. "candidates:"). */
export function invalidatePrefix(prefix: string): void {
  for (const k of [...L1.keys()]) if (k.startsWith(prefix)) L1.delete(k)
  try {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(L2_PREFIX + prefix)) sessionStorage.removeItem(k)
    }
  } catch {
    /* ignore */
  }
}

/**
 * Cache-through imperative load: a FRESH hit returns the cached value without
 * calling `loader` at all (the instant-re-open win). A miss or stale entry runs
 * `loader` and caches the result. Pass `force` to bypass the cache.
 */
export async function cachedLoad<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_CACHE_TTL_MS,
  force = false,
): Promise<T> {
  if (!force) {
    const hit = readCache<T>(key, ttlMs)
    if (hit && !hit.stale) return hit.data
  }
  const data = await loader()
  writeCache(key, data)
  return data
}

/**
 * Stale-while-revalidate hook: renders cached data instantly (even if stale),
 * then revalidates in the background. `refresh()` forces a reload.
 */
export function useCachedResource<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_CACHE_TTL_MS,
): { data: T | null; loading: boolean; error: unknown; refresh: () => void } {
  const seed = readCache<T>(key, ttlMs)
  const [data, setData] = useState<T | null>(seed ? seed.data : null)
  const [loading, setLoading] = useState(!seed)
  const [error, setError] = useState<unknown>(null)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const run = useCallback(
    async (force: boolean) => {
      const hit = readCache<T>(key, ttlMs)
      if (hit) {
        setData(hit.data)
        if (!hit.stale && !force) {
          setLoading(false)
          return
        }
      } else {
        setLoading(true)
      }
      try {
        const fresh = await loaderRef.current()
        writeCache(key, fresh)
        setData(fresh)
        setError(null)
      } catch (e) {
        setError(e)
      } finally {
        setLoading(false)
      }
    },
    [key, ttlMs],
  )

  useEffect(() => {
    void run(false)
  }, [run])

  return { data, loading, error, refresh: () => void run(true) }
}
