/**
 * Client wrapper for the `paPublicOpenJobs` HTTP CF.
 *
 * Adam directive 2026-05-16 — switched from a homegrown sessionStorage
 * stale-while-revalidate cache to TanStack Query. The QueryClient lives
 * at the root of pa-landing (`main.tsx`); open-jobs queries override the
 * defaults with staleTime=6h + gcTime=24h (Adam 2026-06-11 — the feed
 * updates ~daily, in-session navigation must never refetch), which gives us:
 *   - dedup of concurrent identical requests (Tabs flipping between
 *     "Direct line" and "Hunting list" no longer double-fetch)
 *   - instant repaint on revisit during the same session
 *   - first-class refetch / invalidation primitives we can call from
 *     other surfaces (e.g. when a candidate marks "Apply" we can bump
 *     the queryClient cache without rerunning the CF)
 *   - automatic garbage collection when no component is observing
 *
 * Pagination is client-side reveal-on-demand: the CF returns up to 200
 * rows in one network round-trip (already cached by `loadSnapshot` +
 * CDN s-maxage=3600); `useOpenJobsPage` slices that down to a windowed
 * view so the page paints fast and "Load more" is instant.
 */

import { useMemo, useState } from "react"
import { useQuery, type UseQueryResult } from "@tanstack/react-query"

// Direct CF URL — used only as the local-dev fallback (vite dev server has no
// Firebase Hosting rewrite for /api/open-jobs) and as the VITE_OPEN_JOBS_URL
// escape hatch. Production traffic goes same-origin through the Hosting
// rewrite so the Firebase CDN honors the CF's s-maxage/stale-while-revalidate
// headers and visitors stop hitting the function directly (Adam 2026-06-11).
const CLOUD_FUNCTIONS_URL = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicOpenJobs"

/** Same-origin Hosting rewrite → paPublicOpenJobs (see firebase.json pa-landing). */
const SAME_ORIGIN_PATH = "/api/open-jobs"

export function openJobsEndpoint(): string {
  const raw = import.meta.env.VITE_OPEN_JOBS_URL
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim()
  if (import.meta.env.DEV) return CLOUD_FUNCTIONS_URL
  return SAME_ORIGIN_PATH
}

// The scrape pool refreshes ~daily, so a 6h client staleTime means at most
// one network round-trip per session-ish window while in-session navigation
// (landing → market → back) never refetches. gcTime 24h keeps the entry
// alive across long browsing sessions. Mirrors the CDN policy on the CF
// (s-maxage=3600, stale-while-revalidate=86400).
export const OPEN_JOBS_STALE_TIME_MS = 6 * 60 * 60 * 1000
export const OPEN_JOBS_GC_TIME_MS = 24 * 60 * 60 * 1000

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
  cached?: boolean
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

async function fetchOpenJobsNetwork(filters: OpenJobsFilters): Promise<OpenJobRow[]> {
  const url = `${openJobsEndpoint()}?${buildQuery(filters)}`
  const r = await fetch(url, { method: "GET" })
  if (!r.ok) throw new Error(`open-jobs ${r.status}`)
  const body = (await r.json()) as OpenJobsResponse
  if (!body.ok) throw new Error(body.reason ?? "open-jobs failed")
  return body.rows
}

/**
 * Backwards-compatible raw fetcher — kept so non-React callers (e.g.
 * pre-hydration server-render snapshots if we ever add them) can still
 * invoke the CF. New code should prefer `useOpenJobs` so it participates
 * in the QueryClient cache.
 */
export async function fetchOpenJobs(filters: OpenJobsFilters = {}): Promise<OpenJobRow[]> {
  return fetchOpenJobsNetwork(filters)
}

/** Stable, normalized query key from filters — order-independent. */
function queryKeyForFilters(filters: OpenJobsFilters): unknown[] {
  return [
    "open-jobs",
    {
      limit: filters.limit ?? 80,
      freshDays: filters.freshDays ?? 45,
      function: filters.function ? [...filters.function].sort() : [],
      level: filters.level ? [...filters.level].sort() : [],
      location: filters.location ? [...filters.location].sort() : [],
      remoteOnly: filters.remoteOnly ?? false,
      search: filters.search ?? "",
    },
  ]
}

/**
 * Primary React hook — returns the full TanStack Query result so the
 * caller can render loading / error states without re-creating them.
 */
export function useOpenJobs(filters: OpenJobsFilters = {}): UseQueryResult<OpenJobRow[]> {
  return useQuery({
    queryKey: queryKeyForFilters(filters),
    queryFn: () => fetchOpenJobsNetwork({ limit: 80, freshDays: 45, ...filters }),
    staleTime: OPEN_JOBS_STALE_TIME_MS,
    gcTime: OPEN_JOBS_GC_TIME_MS,
  })
}

/**
 * Pagination wrapper — same fetch as `useOpenJobs`, but slices the result
 * to a windowed view that grows by `pageSize` rows whenever
 * `showMore()` is called. Caps at the total fetched length (no infinite
 * recursion past what the CF returned).
 *
 * Default `pageSize=24` lines up roughly with one viewport on desktop,
 * which keeps the DOM weight bounded and "Load more" interaction snappy.
 */
export function useOpenJobsPage(
  filters: OpenJobsFilters = {},
  pageSize = 24,
): {
  rows: OpenJobRow[]
  totalLoaded: number
  visibleCount: number
  isLoading: boolean
  isError: boolean
  error: unknown
  hasMore: boolean
  showMore: () => void
  reset: () => void
} {
  const q = useOpenJobs(filters)
  const [visibleCount, setVisibleCount] = useState(pageSize)
  const all = q.data ?? []
  const visible = useMemo(() => all.slice(0, visibleCount), [all, visibleCount])
  return {
    rows: visible,
    totalLoaded: all.length,
    visibleCount: visible.length,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    hasMore: visibleCount < all.length,
    showMore: () => setVisibleCount((n) => Math.min(n + pageSize, all.length)),
    reset: () => setVisibleCount(pageSize),
  }
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
