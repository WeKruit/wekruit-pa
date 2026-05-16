/**
 * Client wrapper for the `paPublicOpenJobs` HTTP CF.
 *
 * Reads from `VITE_OPEN_JOBS_URL` (set by `scripts/inject-pa-landing-vite-env.mjs`
 * + apps/pa-landing/.env.production.local). Falls back to the canonical
 * us-central1 deployment URL so the page still works locally without env.
 *
 * Shape mirrors the server projection. Keep this type the single source of
 * truth for the WeKruit Open page table/cards renderer.
 */

const FALLBACK_URL = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicOpenJobs"

function endpoint(): string {
  const raw = import.meta.env.VITE_OPEN_JOBS_URL
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim()
  return FALLBACK_URL
}

export interface OpenJobRow {
  id: string
  title: string
  company: string
  function?: string
  level?: string
  location?: string
  locationRaw?: string
  comp?: string
  posted?: string
  source?: string
  summary?: string
  atsApplyUrl?: string
  industrySector?: string[]
  remote: boolean
  sponsorship?: boolean | null
  firstSeenAt?: string
}

export interface OpenJobsResponse {
  ok: boolean
  count: number
  scanned: number
  rows: OpenJobRow[]
  reason?: string
}

export interface OpenJobsFilters {
  limit?: number
  freshDays?: number
  function?: string[]
  level?: string[]
  location?: string[]
  remoteOnly?: boolean
  search?: string
}

function buildQuery(f: OpenJobsFilters): string {
  const p = new URLSearchParams()
  if (f.limit) p.set("limit", String(f.limit))
  if (f.freshDays) p.set("freshDays", String(f.freshDays))
  if (f.function && f.function.length) p.set("function", f.function.join(","))
  if (f.level && f.level.length) p.set("level", f.level.join(","))
  if (f.location && f.location.length) p.set("location", f.location.join(","))
  if (f.remoteOnly) p.set("remoteOnly", "true")
  if (f.search) p.set("search", f.search)
  return p.toString()
}

// ---- sessionStorage stale-while-revalidate cache ------------------------
//
// Adam directive 2026-05-16 — "caching要做好, 不然每个用户过来打开都要重新read".
// Bookend the CF-side snapshot cache + CDN s-maxage with a client cache so
// repeat /open or /market visits within a single session paint instantly
// and we only re-hit the CF when the cached payload is older than 5 min.
//
// Strategy: sessionStorage keyed by the full query URL. Each entry stores
// {rows, fetchedAt}. On read:
//   - <5 min stale: return cached rows immediately and skip the network
//   - 5-30 min stale: return cached rows AND kick off a background refresh
//                     (stale-while-revalidate so a slow CF cold-start never
//                     blocks the user)
//   - >30 min stale: ignore the cache, await a fresh fetch
//
// Set window.__WEKRUIT_DISABLE_OPEN_CACHE = true to force-bypass during QA.

const CACHE_TTL_MS = 5 * 60 * 1000
const SWR_TTL_MS = 30 * 60 * 1000

interface CacheEntry {
  rows: OpenJobRow[]
  fetchedAt: number
}

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null
    return window.sessionStorage
  } catch {
    return null
  }
}

function cacheKey(url: string): string {
  return `wkr.open-jobs.v1:${url}`
}

function readCache(url: string): CacheEntry | null {
  const store = getStorage()
  if (!store) return null
  try {
    const raw = store.getItem(cacheKey(url))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CacheEntry>
    if (!parsed.rows || typeof parsed.fetchedAt !== "number") return null
    return { rows: parsed.rows, fetchedAt: parsed.fetchedAt }
  } catch {
    return null
  }
}

function writeCache(url: string, entry: CacheEntry): void {
  const store = getStorage()
  if (!store) return
  try {
    store.setItem(cacheKey(url), JSON.stringify(entry))
  } catch {
    // Quota / private mode → soft-fail, network path still works.
  }
}

async function networkFetch(url: string): Promise<OpenJobRow[]> {
  const r = await fetch(url, { method: "GET" })
  if (!r.ok) throw new Error(`open-jobs ${r.status}`)
  const body = (await r.json()) as OpenJobsResponse
  if (!body.ok) throw new Error(body.reason ?? "open-jobs failed")
  return body.rows
}

declare global {
  interface Window {
    __WEKRUIT_DISABLE_OPEN_CACHE?: boolean
  }
}

export async function fetchOpenJobs(filters: OpenJobsFilters = {}): Promise<OpenJobRow[]> {
  const url = `${endpoint()}?${buildQuery(filters)}`
  const bypass = typeof window !== "undefined" && window.__WEKRUIT_DISABLE_OPEN_CACHE === true
  const now = Date.now()
  const cached = bypass ? null : readCache(url)

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rows
  }

  if (cached && now - cached.fetchedAt < SWR_TTL_MS) {
    // Stale-while-revalidate — surface cached payload now, refresh in bg.
    void networkFetch(url)
      .then((rows) => writeCache(url, { rows, fetchedAt: Date.now() }))
      .catch(() => undefined)
    return cached.rows
  }

  const rows = await networkFetch(url)
  writeCache(url, { rows, fetchedAt: Date.now() })
  return rows
}

/** Pretty-print a canonical-tag token: `software_engineering` → `Software Engineering`. */
export function humanizeToken(token: string | undefined): string {
  if (!token) return ""
  return token
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}
