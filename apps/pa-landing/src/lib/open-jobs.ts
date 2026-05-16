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

export async function fetchOpenJobs(filters: OpenJobsFilters = {}): Promise<OpenJobRow[]> {
  const url = `${endpoint()}?${buildQuery(filters)}`
  const r = await fetch(url, { method: "GET" })
  if (!r.ok) throw new Error(`open-jobs ${r.status}`)
  const body = (await r.json()) as OpenJobsResponse
  if (!body.ok) throw new Error(body.reason ?? "open-jobs failed")
  return body.rows
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
