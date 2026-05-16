/**
 * Public HTTP CF — paPublicOpenJobs.
 *
 * Powers the WeKruit Open "Hunting list" surface at layoff.wekruit.com/open
 * (also reachable on candidate.wekruit.com/open). Returns sanitized,
 * paginated scraped jobs from the `matching-jobs` collection — the same
 * pipeline macmini drops nightly. These companies are NOT in active collab
 * with WeKruit; we surface them so laid-off candidates can browse the
 * outbound queue.
 *
 * Why a CF instead of direct Firestore client read: `matching-jobs` has no
 * public read rule in config/firebase/firestore.rules — collection is
 * internal (LLM rerank, dead-job sweep, freshness mutation). A thin
 * server-side projection layer is the canonical pattern (mirrors
 * paPublicCvIngest at apps/functions/src/public-cv-ingest.ts).
 *
 * Filter contract — mirrors v16 hard filters (CLAUDE.md v1.6 D9/D10):
 *   - status === "active"
 *   - dead !== true
 *   - atsApplyUrl present, non-jobright.ai
 *   - firstSeenAt within `freshDays` (default 45)
 *   - optional in-memory narrowing by roleFunction / locationBuckets /
 *     seniorityLevel / remoteOnly / search keyword
 *
 * NOT auth'd — public candidate surface. Returns only sanitized fields.
 */
import { onRequest } from "firebase-functions/v2/https"
import { getFirestore, Timestamp, type Query } from "firebase-admin/firestore"
import { getApps, initializeApp } from "firebase-admin/app"

if (!getApps().length) initializeApp()

// ---------------------------------------------------------------- types --

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

interface QueryParams {
  limit: number
  offset: number
  freshDays: number
  function?: string[]
  level?: string[]
  location?: string[]
  remoteOnly: boolean
  search?: string
}

// --------------------------------------------------------- field helpers -

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) if (typeof item === "string" && item.trim().length > 0) out.push(item.trim())
  return out
}

function tsToMs(v: unknown): number | null {
  if (!v) return null
  if (v instanceof Timestamp) return v.toMillis()
  if (typeof v === "object" && v !== null && "_seconds" in v) {
    const sec = Number((v as { _seconds?: unknown })._seconds ?? 0)
    return Number.isFinite(sec) ? sec * 1000 : null
  }
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const p = Date.parse(v)
    return Number.isFinite(p) ? p : null
  }
  return null
}

export function formatPostedAgo(ms: number, now: number): string {
  const delta = Math.max(0, now - ms)
  const day = 24 * 60 * 60 * 1000
  const h = Math.round(delta / (60 * 60 * 1000))
  if (h < 24) return h <= 1 ? "1h" : `${h}h`
  const d = Math.round(delta / day)
  if (d < 14) return `${d}d`
  const w = Math.round(d / 7)
  return `${w}w`
}

export function formatComp(min: unknown, max: unknown): string | undefined {
  const lo = typeof min === "number" && Number.isFinite(min) ? Math.round(min / 1000) : null
  const hi = typeof max === "number" && Number.isFinite(max) ? Math.round(max / 1000) : null
  if (lo && hi) return `$${lo}–${hi}k`
  if (lo) return `$${lo}k+`
  return undefined
}

function sourceFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const host = new URL(url).hostname.replace(/^www\./, "")
    return host
  } catch {
    return undefined
  }
}

function firstNonEmptyLine(md: unknown): string | undefined {
  if (typeof md !== "string") return undefined
  for (const raw of md.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/[_`]/g, "").trim()
    if (line.length >= 10 && line.length <= 220) return line
  }
  return undefined
}

const JOBRIGHT_RE = /jobright\.ai/i

// --------------------------------------------------------- query parsing -

function parseList(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  const flat = Array.isArray(raw) ? raw.join(",") : raw
  return flat
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function parseQuery(q: Record<string, unknown>): QueryParams {
  const limit = Math.max(1, Math.min(200, Number(q.limit) || 60))
  const offset = Math.max(0, Math.min(2000, Number(q.offset) || 0))
  const freshDays = Math.max(1, Math.min(180, Number(q.freshDays) || 45))
  const search = asString(q.search)?.toLowerCase()
  return {
    limit,
    offset,
    freshDays,
    function: parseList(q.function as string | string[] | undefined),
    level: parseList(q.level as string | string[] | undefined),
    location: parseList(q.location as string | string[] | undefined),
    remoteOnly: q.remoteOnly === "true" || q.remoteOnly === "1",
    search,
  }
}

// --------------------------------------------------------- projection ----

export function toOpenJobRow(id: string, data: Record<string, unknown>, now: number): OpenJobRow | null {
  const status = asString(data.status)
  if (status !== "active") return null
  if (data.dead === true) return null

  const ats = asString(data.atsApplyUrl)
  if (!ats || JOBRIGHT_RE.test(ats)) return null

  const title = asString(data.roleTitle) ?? asString(data.jobTitle)
  const company = asString(data.companyName) ?? asString(data.company)
  if (!title || !company) return null

  const firstSeenMs = tsToMs(data.firstSeenAt)
  const roleFunctions = asStringArray(data.roleFunction)
  const buckets = asStringArray(data.locationBuckets)
  const locationRaw = asString(data.locationRaw)
  const seniority = asString(data.seniorityLevel)
  const sponsorship = data.sponsorship === true || data.sponsorship === false ? (data.sponsorship as boolean) : null
  const industry = asStringArray(data.industrySector)
  const isRemote = buckets.some((b) => /remote/i.test(b)) || /remote/i.test(locationRaw ?? "")

  return {
    id,
    title,
    company,
    function: roleFunctions[0],
    level: seniority,
    location: buckets[0] ?? locationRaw,
    locationRaw,
    comp: formatComp(data.salaryMin, data.salaryMax),
    posted: firstSeenMs ? formatPostedAgo(firstSeenMs, now) : undefined,
    source: sourceFromUrl(ats),
    summary: firstNonEmptyLine(data.jobDescription) ?? firstNonEmptyLine(data.descriptionMd),
    atsApplyUrl: ats,
    industrySector: industry,
    remote: isRemote,
    sponsorship,
    firstSeenAt: firstSeenMs ? new Date(firstSeenMs).toISOString() : undefined,
  }
}

// --------------------------------------------------------- filter --------

export function matchesFilters(j: OpenJobRow, p: QueryParams): boolean {
  if (p.remoteOnly && !j.remote) return false
  if (p.function && p.function.length > 0) {
    if (!j.function || !p.function.includes(j.function)) return false
  }
  if (p.level && p.level.length > 0) {
    if (!j.level || !p.level.includes(j.level)) return false
  }
  if (p.location && p.location.length > 0) {
    const blob = [j.location ?? "", j.locationRaw ?? "", ...(j.location ? [] : [])].join(" ").toLowerCase()
    if (!p.location.some((needle) => blob.includes(needle.toLowerCase()))) return false
  }
  if (p.search) {
    const hay = `${j.title} ${j.company} ${j.function ?? ""} ${j.location ?? ""} ${j.summary ?? ""}`.toLowerCase()
    if (!hay.includes(p.search)) return false
  }
  return true
}

// --------------------------------------------------------- handler -------

interface RunDeps {
  db?: ReturnType<typeof getFirestore>
  now?: number
}

// ---------------------------------------------------------- snapshot cache
// Module-scope LRU keyed by (scanCap) — the inner firestore read scans the
// freshest N matching-jobs docs and projects them. Filters/limit run in
// memory below from this cached snapshot. Multiple concurrent requests on
// the same warm CF instance reuse the snapshot instead of hitting Firestore.
//
// 60s TTL is the same staleness the CDN already permits (s-maxage=60). With
// concurrency=40 a hot instance can serve ~40 req/inst-min from a single
// Firestore scan — caching across instances comes from the CDN, not here.
interface SnapshotCacheEntry {
  rows: OpenJobRow[]
  scanned: number
  builtAt: number
}
const SNAPSHOT_TTL_MS = 60_000
const snapshotCache = new Map<number, SnapshotCacheEntry>()

export function _resetSnapshotCacheForTest(): void {
  snapshotCache.clear()
}

async function loadSnapshot(scanCap: number, db: ReturnType<typeof getFirestore>, now: number): Promise<SnapshotCacheEntry> {
  const cached = snapshotCache.get(scanCap)
  if (cached && now - cached.builtAt < SNAPSHOT_TTL_MS) return cached

  const q: Query = db
    .collection("matching-jobs")
    .where("status", "==", "active")
    .orderBy("firstSeenAt", "desc")
    .limit(scanCap)
  const snap = await q.get()
  const rows: OpenJobRow[] = []
  for (const doc of snap.docs) {
    const row = toOpenJobRow(doc.id, doc.data() as Record<string, unknown>, now)
    if (row) rows.push(row)
  }
  rows.sort((a, b) => {
    const am = a.firstSeenAt ? Date.parse(a.firstSeenAt) : 0
    const bm = b.firstSeenAt ? Date.parse(b.firstSeenAt) : 0
    return bm - am
  })

  const entry: SnapshotCacheEntry = { rows, scanned: snap.size, builtAt: now }
  snapshotCache.set(scanCap, entry)
  return entry
}

export async function runOpenJobs(
  params: QueryParams,
  deps: RunDeps = {}
): Promise<{ rows: OpenJobRow[]; scanned: number; total: number; cached: boolean }> {
  const db = deps.db ?? getFirestore()
  const now = deps.now ?? Date.now()
  const freshThresholdMs = now - params.freshDays * 24 * 60 * 60 * 1000

  // Walk the active set ordered by freshness. The collection is bounded
  // (~6500 active rows) so we cap the scan rather than running a Firestore
  // composite query that would force a new index. Floor at 300 so even
  // tight limits (e.g. limit=3 with filters) still see enough rows to find
  // matches; ceiling at 800 to keep p95 under the 30s timeout.
  //
  // Pagination: client may request a page (offset, limit) of the filtered
  // sorted set. We need to filter the full scan window first, THEN slice,
  // so the scan cap is based on the page's far edge.
  const window = params.offset + params.limit
  const SCAN_CAP = Math.min(800, Math.max(300, window * 6))
  const cacheBefore = snapshotCache.get(SCAN_CAP)
  const cached = !!cacheBefore && now - cacheBefore.builtAt < SNAPSHOT_TTL_MS

  const snapshot = await loadSnapshot(SCAN_CAP, db, now)

  const filtered: OpenJobRow[] = []
  for (const row of snapshot.rows) {
    if (row.firstSeenAt) {
      const ms = Date.parse(row.firstSeenAt)
      if (Number.isFinite(ms) && ms < freshThresholdMs) continue
    }
    if (!matchesFilters(row, params)) continue
    filtered.push(row)
  }

  filtered.sort((a, b) => {
    const am = a.firstSeenAt ? Date.parse(a.firstSeenAt) : 0
    const bm = b.firstSeenAt ? Date.parse(b.firstSeenAt) : 0
    return bm - am
  })

  const total = filtered.length
  return {
    rows: filtered.slice(params.offset, params.offset + params.limit),
    scanned: snapshot.scanned,
    total,
    cached,
  }
}

// --------------------------------------------------------- CF export -----

function setCors(res: { set: (k: string, v: string) => void }): void {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type")
  res.set("Access-Control-Max-Age", "3600")
  // Tiered caching to keep Firestore reads bounded under load:
  //   - browser holds 60s (max-age)
  //   - CDN (Cloud Run + Fastly fronting Firebase Hosting CFs) holds 5m
  //     (s-maxage) and serves stale-while-revalidate for another 10m so a
  //     cold instance never blocks user paint
  //   - in-memory snapshot inside the CF instance (loadSnapshot, 60s TTL)
  //     deduplicates Firestore reads across concurrent requests on the
  //     same warm instance
  res.set("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600")
  res.set("Vary", "Accept-Encoding")
}

export const paPublicOpenJobs = onRequest(
  {
    region: "us-central1",
    cors: false, // handled manually for symmetry with paPublicCvIngest
    // 512MiB needed: firebase-admin SDK + 800-doc snapshot + projection +
    // sort + JSON serialize at limit=80 hits ~280MiB peak; 256MiB OOMs.
    memory: "512MiB",
    timeoutSeconds: 30,
    concurrency: 40,
  },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }

    try {
      const params = parseQuery(req.query as Record<string, unknown>)
      const { rows, scanned, total, cached } = await runOpenJobs(params)
      res.set("X-Cache", cached ? "HIT" : "MISS")
      res.status(200).json({
        ok: true,
        count: rows.length,
        scanned,
        total,
        offset: params.offset,
        limit: params.limit,
        cached,
        rows,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      res.status(500).json({ ok: false, reason })
    }
  }
)
