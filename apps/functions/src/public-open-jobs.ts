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
  const freshDays = Math.max(1, Math.min(180, Number(q.freshDays) || 45))
  const search = asString(q.search)?.toLowerCase()
  return {
    limit,
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

export async function runOpenJobs(params: QueryParams, deps: RunDeps = {}): Promise<{ rows: OpenJobRow[]; scanned: number }> {
  const db = deps.db ?? getFirestore()
  const now = deps.now ?? Date.now()
  const freshThresholdMs = now - params.freshDays * 24 * 60 * 60 * 1000

  // Walk the active set ordered by freshness. The collection is bounded
  // (~6500 active rows) so we cap the scan rather than running a Firestore
  // composite query that would force a new index. Floor at 300 so even
  // tight limits (e.g. limit=3 with filters) still see enough rows to find
  // matches; ceiling at 800 to keep p95 under the 30s timeout.
  const SCAN_CAP = Math.min(800, Math.max(300, params.limit * 6))

  // Match v16 queryMatchingJobs (apps/job-rec/.../query-matching-jobs-v16.ts):
  // orderBy firstSeenAt desc so the scan window is the freshest set —
  // not a random doc-id slice. Composite index already exists for this
  // pattern (status==active + firstSeenAt desc).
  const q: Query = db
    .collection("matching-jobs")
    .where("status", "==", "active")
    .orderBy("firstSeenAt", "desc")
    .limit(SCAN_CAP)

  const snap = await q.get()
  const rows: OpenJobRow[] = []
  for (const doc of snap.docs) {
    const row = toOpenJobRow(doc.id, doc.data() as Record<string, unknown>, now)
    if (!row) continue
    if (row.firstSeenAt) {
      const ms = Date.parse(row.firstSeenAt)
      if (Number.isFinite(ms) && ms < freshThresholdMs) continue
    }
    if (!matchesFilters(row, params)) continue
    rows.push(row)
  }

  rows.sort((a, b) => {
    const am = a.firstSeenAt ? Date.parse(a.firstSeenAt) : 0
    const bm = b.firstSeenAt ? Date.parse(b.firstSeenAt) : 0
    return bm - am
  })

  return { rows: rows.slice(0, params.limit), scanned: snap.size }
}

// --------------------------------------------------------- CF export -----

function setCors(res: { set: (k: string, v: string) => void }): void {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type")
  res.set("Access-Control-Max-Age", "3600")
  // 60s edge cache — list mutates nightly + matching-jobs auto-enrich
  // bursts, but a minute of staleness is fine for a public job board.
  res.set("Cache-Control", "public, max-age=60, s-maxage=60")
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
      const { rows, scanned } = await runOpenJobs(params)
      res.status(200).json({ ok: true, count: rows.length, scanned, rows })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      res.status(500).json({ ok: false, reason })
    }
  }
)
