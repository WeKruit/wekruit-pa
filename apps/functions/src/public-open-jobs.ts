/**
 * Public HTTP CF — paPublicOpenJobs.
 *
 * Two modes routed by `?source=`:
 *
 *   1. `source=scraped` (DEFAULT, no auth)
 *      Powers the WeKruit Open "Hunting list" surface at
 *      `candidate.wekruit.com/open` (also `layoff.wekruit.com/open`).
 *      Returns sanitized rows from `matching-jobs` — the macmini
 *      nightly scrape pool. Companies NOT in active collab with
 *      WeKruit; surfaced so laid-off candidates can browse the
 *      outbound queue. Anonymous, CDN-cached.
 *
 *   2. `source=collab` (REQUIRES API key + Origin allowlist)
 *      Returns sanitized WeKruit-collab jobs from `pa-jobs` (jobs
 *      where `publicVisible=true && wekruitCollaborationStatus=
 *      "collaborated"`). Hydrated with `pa-companies/{normName}`
 *      profile data (logo, stage, employee range). For external
 *      partners syndicating WeKruit jobs onto their own surfaces.
 *      Each row carries `wekruitUrl` so partner pages link back to
 *      `candidate.wekruit.com/j/<id>` instead of direct-apply
 *      (we own the funnel).
 *
 * Why a CF instead of direct Firestore client read:
 *   - `matching-jobs` has no public Firestore read rule (LLM rerank,
 *     liveness sweep, freshness mutation — collection is internal).
 *   - `pa-jobs` MAY be readable but its docs carry recruiterBoard,
 *     prescreenConfig.questions, publicId — must NOT leak.
 *   A server-side projection layer is the only safe surface. Mirrors
 *   the pattern of `paPublicCvIngest` at apps/functions/src/public-cv-ingest.ts.
 *
 * Cache contract (BOTH modes — partner MUST respect):
 *   Browser:    max-age=60
 *   CDN:        s-maxage=300, stale-while-revalidate=600
 *   In-memory:  60s LRU per (mode, scanCap) inside warm CF instance
 *   ETag:       sha1(rowIds + params) — 304 on If-None-Match match
 *
 * Pagination contract:
 *   - `cursor` is forward-only opaque base64 of `{fs, id}`. Pass back
 *     the prior response's `nextCursor` to continue. Restart from no
 *     cursor periodically (cursor may dangle if doc rotates out of
 *     the active snapshot — handler degrades to offset=0 silently).
 *   - Legacy `offset` still accepted; clamped to 2000.
 *
 * NOT auth'd in scraped mode — public candidate surface.
 * API-key + Origin gated in collab mode — see verifyCollabAuth.
 *
 * Full partner integration spec: apps/functions/docs/PUBLIC-JOBS-API.md
 */
import { onRequest } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore, Timestamp, type Query } from "firebase-admin/firestore"
import { getApps, initializeApp } from "firebase-admin/app"
import { normalizeCompanyName } from "@pa/core-types"
import { createHash } from "node:crypto"

if (!getApps().length) initializeApp()

// ---------------------------------------------------------------- secrets

// CSV of partner API keys (e.g. "key_partnerA_xyz,key_partnerB_abc").
// Compared with constant-time check inside verifyCollabAuth.
const PA_PUBLIC_COLLAB_API_KEYS = defineSecret("PA_PUBLIC_COLLAB_API_KEYS")

// CSV of allowed browser Origin values (e.g. "https://partner.com,https://staging.partner.com").
// When a request includes an Origin header, it MUST match one of these.
// Server-to-server requests with no Origin header are accepted on API key alone.
// Set to "*" to disable Origin gating (key-only).
const PA_PUBLIC_COLLAB_ORIGINS = defineSecret("PA_PUBLIC_COLLAB_ORIGINS")

// ---------------------------------------------------------------- constants

const API_VERSION = "v1"
// Apex `wekruit.com` and `candidate.wekruit.com` both CNAME to the same
// `wekruit-pa-landing` Firebase Hosting site (Vite SPA serving /j/:jobId),
// so either host resolves to the same PublicJob page. Apex is the partner-
// facing brand surface (shorter, no "candidate." subdomain leakage).
// Override at runtime via WEKRUIT_PUBLIC_BASE env var if needed.
const WEKRUIT_PUBLIC_BASE =
  process.env.WEKRUIT_PUBLIC_BASE ?? "https://wekruit.com"

// ---------------------------------------------------------------- types --

export interface OpenJobRow {
  id: string
  /** Canonical WeKruit candidate-facing page URL — partner pages MUST link here. */
  wekruitUrl: string
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
  /**
   * Direct ATS apply URL. Present in `source=scraped` rows (jobright
   * surface). OMITTED in `source=collab` rows — partner must drive
   * candidates through `wekruitUrl` so we own the funnel.
   */
  atsApplyUrl?: string
  industrySector?: string[]
  remote: boolean
  sponsorship?: boolean | null
  firstSeenAt?: string
  /** Collab-mode only: hydrated from `pa-companies/{normalizedName}`. */
  companyProfile?: PublicCompanyProfile
  /** Collab-mode only: `true` if WeKruit has an active employer collab. */
  collaborated?: boolean
}

export interface PublicCompanyProfile {
  displayName?: string
  logoUrl?: string | null
  hqLocation?: string | null
  employeeRange?: string | null
  industry?: string | null
  companyStage?: string
  companyTags?: string[]
}

export type JobSource = "scraped" | "collab"

interface QueryParams {
  source: JobSource
  limit: number
  offset: number
  cursor?: CursorPayload
  freshDays: number
  function?: string[]
  level?: string[]
  location?: string[]
  remoteOnly: boolean
  search?: string
}

interface CursorPayload {
  /** firstSeenAt milliseconds since epoch */
  fs: number
  /** Firestore doc id */
  id: string
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

/** Canonical wekruit page URL for a job — partner pages MUST link here. */
export function buildWekruitUrl(id: string): string {
  return `${WEKRUIT_PUBLIC_BASE}/j/${encodeURIComponent(id)}`
}

// --------------------------------------------------------- cursor encoding

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

export function encodeCursor(payload: CursorPayload): string {
  return base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"))
}

export function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = JSON.parse(base64UrlDecode(raw).toString("utf8")) as Record<string, unknown>
    const fs = Number(json.fs)
    const id = typeof json.id === "string" ? json.id : ""
    if (!Number.isFinite(fs) || !id) return null
    return { fs, id }
  } catch {
    return null
  }
}

// --------------------------------------------------------- ETag

export function computeEtag(
  rows: Array<Pick<OpenJobRow, "id" | "firstSeenAt">>,
  params: Pick<QueryParams, "source" | "limit" | "offset" | "cursor" | "freshDays" | "function" | "level" | "location" | "remoteOnly" | "search">
): string {
  const h = createHash("sha1")
  h.update(API_VERSION)
  h.update("|")
  h.update(params.source)
  h.update("|")
  h.update(String(params.limit))
  h.update("|")
  h.update(String(params.offset))
  h.update("|")
  h.update(params.cursor ? `${params.cursor.fs}.${params.cursor.id}` : "")
  h.update("|")
  h.update(String(params.freshDays))
  h.update("|")
  h.update((params.function ?? []).join(","))
  h.update("|")
  h.update((params.level ?? []).join(","))
  h.update("|")
  h.update((params.location ?? []).join(","))
  h.update("|")
  h.update(params.remoteOnly ? "1" : "0")
  h.update("|")
  h.update(params.search ?? "")
  h.update("|rows|")
  for (const r of rows) {
    h.update(r.id)
    h.update(":")
    h.update(r.firstSeenAt ?? "")
    h.update(",")
  }
  return `"${API_VERSION}-${h.digest("hex").slice(0, 24)}"`
}

// --------------------------------------------------------- query parsing -

function parseList(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  const flat = Array.isArray(raw) ? raw.join(",") : raw
  return flat
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function parseSource(raw: unknown): JobSource {
  return raw === "collab" ? "collab" : "scraped"
}

export function parseQuery(q: Record<string, unknown>): QueryParams {
  const limit = Math.max(1, Math.min(200, Number(q.limit) || 60))
  const offset = Math.max(0, Math.min(2000, Number(q.offset) || 0))
  const freshDays = Math.max(1, Math.min(365, Number(q.freshDays) || 45))
  const search = asString(q.search)?.toLowerCase()
  const cursorRaw = asString(q.cursor)
  const cursor = cursorRaw ? decodeCursor(cursorRaw) ?? undefined : undefined
  return {
    source: parseSource(q.source),
    limit,
    offset,
    cursor,
    freshDays,
    function: parseList(q.function as string | string[] | undefined),
    level: parseList(q.level as string | string[] | undefined),
    location: parseList(q.location as string | string[] | undefined),
    remoteOnly: q.remoteOnly === "true" || q.remoteOnly === "1",
    search,
  }
}

// --------------------------------------------------------- scraped projection

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
    wekruitUrl: buildWekruitUrl(id),
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

// --------------------------------------------------------- collab projection

/**
 * Strip "Source" / "Job Source" / "Original Source" sections + standalone
 * source URLs from descriptionMd. Mirrors apps/pa-landing/src/lib/public-jobs.ts
 * stripJobSourceSection. Collab jobs hide the underlying scrape provenance
 * because the partner pays for placement.
 */
export function stripJobSourceSection(markdown?: string): string | undefined {
  const raw = markdown?.trim()
  if (!raw) return raw
  const lines = raw.split(/\r?\n/)
  const kept: string[] = []
  let skippingSource = false

  const isSourceHeading = (value: string): boolean => {
    const n = value
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\*\*/, "")
      .replace(/\*\*$/, "")
      .trim()
      .toLowerCase()
    return n === "source" || n === "job source" || n === "original source"
  }
  const isHeading = (value: string): boolean =>
    /^#{1,6}\s+\S/.test(value) || /^\*\*[^*]+\*\*$/.test(value)
  const isStandaloneSourceUrl = (value: string): boolean => {
    const t = value.trim()
    return /^https?:\/\/\S+$/i.test(t) || /^\[[^\]]+\]\(https?:\/\/[^)]+\)$/i.test(t)
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && isSourceHeading(trimmed)) {
      skippingSource = true
      continue
    }
    if (skippingSource) {
      if (trimmed && isHeading(trimmed)) {
        skippingSource = false
      } else {
        continue
      }
    }
    if (isStandaloneSourceUrl(trimmed)) continue
    kept.push(line)
  }
  return kept.join("\n").trim()
}

/**
 * Project a `pa-jobs/{id}` document into a partner-safe row. Returns null
 * if the doc is not eligible for public exposure. NEVER reads or returns:
 *   - prescreenConfig.questions / prescreenPipeline (full prescreen logic)
 *   - recruiterBoard (admin hiring-board payload)
 *   - publicId (opaque resolver — keep server-side)
 *   - hiringManager*, interviewSeats (UI-only fields for our own page)
 *   - atsApplyUrl (we want partner candidates on candidate.wekruit.com)
 */
export function toCollabJobRow(id: string, data: Record<string, unknown>, now: number): OpenJobRow | null {
  if (data.publicVisible !== true) return null
  if (data.dead === true) return null
  if (data.wekruitCollaborationStatus !== "collaborated") return null

  const title =
    asString(data.title) ??
    asString(data.jobTitle) ??
    asString((data.prescreenConfig as Record<string, unknown> | undefined)?.jobTitle) ??
    "Open role"
  const company =
    asString(data.companyName) ??
    asString(data.company) ??
    asString((data.prescreenConfig as Record<string, unknown> | undefined)?.company) ??
    "Confidential employer"

  const firstSeenMs = tsToMs(data.firstSeenAt) ?? tsToMs(data.createdAt) ?? tsToMs(data.updatedAt)
  const roleFunctions = asStringArray(data.roleFunction)
  const buckets = asStringArray(data.locationBuckets)
  const locationRaw = asString(data.location) ?? asString(data.rawLocation) ?? asString(data.locationRaw)
  const seniority = asString(data.seniorityLevel)
  const industry = asStringArray(data.industrySector)
  const isRemote = buckets.some((b) => /remote/i.test(b)) || /remote/i.test(locationRaw ?? "")

  const stripped = stripJobSourceSection(asString(data.descriptionMd))
  const salaryRange =
    asString(data.salaryRange) ??
    asString(((data.prescreenConfig as Record<string, unknown> | undefined)?.level1Reveal as Record<string, unknown> | undefined)?.salaryRange) ??
    formatComp(data.salaryMin, data.salaryMax)

  return {
    id,
    wekruitUrl: buildWekruitUrl(id),
    title,
    company,
    function: roleFunctions[0],
    level: seniority,
    location: buckets[0] ?? locationRaw,
    locationRaw,
    comp: salaryRange,
    posted: firstSeenMs ? formatPostedAgo(firstSeenMs, now) : undefined,
    source: undefined, // intentionally omitted in collab mode
    summary: firstNonEmptyLine(stripped) ?? firstNonEmptyLine(data.description),
    // atsApplyUrl intentionally omitted — funnel must flow through wekruitUrl
    industrySector: industry,
    remote: isRemote,
    sponsorship: data.sponsorship === true || data.sponsorship === false ? (data.sponsorship as boolean) : null,
    firstSeenAt: firstSeenMs ? new Date(firstSeenMs).toISOString() : undefined,
    collaborated: true,
  }
}

/**
 * Project a `pa-companies/{normalizedName}` doc into the partner-safe
 * `companyProfile` payload. Used to hydrate collab-mode rows.
 */
export function toPublicCompanyProfile(data: Record<string, unknown> | undefined): PublicCompanyProfile | undefined {
  if (!data) return undefined
  const displayName = asString(data.displayName)
  const logoUrl = typeof data.logoUrl === "string" ? data.logoUrl : null
  const hqLocation = typeof data.hqLocation === "string" ? data.hqLocation : null
  const employeeRange = typeof data.employeeRange === "string" ? data.employeeRange : null
  const industry = typeof data.industry === "string" ? data.industry : null
  const companyStage = asString(data.companyStage)
  const companyTags = asStringArray(data.companyTags)
  if (!displayName && !logoUrl && !companyStage && companyTags.length === 0) return undefined
  return { displayName, logoUrl, hqLocation, employeeRange, industry, companyStage, companyTags }
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
    const blob = [j.location ?? "", j.locationRaw ?? ""].join(" ").toLowerCase()
    if (!p.location.some((needle) => blob.includes(needle.toLowerCase()))) return false
  }
  if (p.search) {
    const hay = `${j.title} ${j.company} ${j.function ?? ""} ${j.location ?? ""} ${j.summary ?? ""}`.toLowerCase()
    if (!hay.includes(p.search)) return false
  }
  return true
}

// --------------------------------------------------------- auth

export interface AuthResult {
  ok: boolean
  reason?: "missing_api_key" | "invalid_api_key" | "origin_not_allowed"
}

/**
 * Constant-time-ish API-key check + Origin allowlist match. Used only
 * when `source=collab`. Reads from Firebase secrets at call time.
 *
 * Pass `keysCsv` / `originsCsv` as overrides in tests; otherwise reads
 * `PA_PUBLIC_COLLAB_API_KEYS` / `PA_PUBLIC_COLLAB_ORIGINS` secrets.
 */
export function verifyCollabAuth(
  apiKey: string | undefined,
  origin: string | undefined,
  keysCsv: string,
  originsCsv: string
): AuthResult {
  const keys = keysCsv.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  if (!apiKey) return { ok: false, reason: "missing_api_key" }
  const apiKeyBuf = Buffer.from(apiKey)
  let matched = false
  for (const k of keys) {
    const kb = Buffer.from(k)
    if (kb.length === apiKeyBuf.length) {
      // crypto.timingSafeEqual would throw on length mismatch; pre-check
      // length above. Constant-time per-pair compare.
      let diff = 0
      for (let i = 0; i < kb.length; i++) diff |= kb[i]! ^ apiKeyBuf[i]!
      if (diff === 0) {
        matched = true
        break
      }
    }
  }
  if (!matched) return { ok: false, reason: "invalid_api_key" }

  const originsTrim = originsCsv.trim()
  if (originsTrim === "*" || originsTrim === "") return { ok: true } // disabled
  if (!origin) return { ok: true } // server-to-server crawl, key alone suffices
  const allowed = originsTrim.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  if (!allowed.includes(origin)) return { ok: false, reason: "origin_not_allowed" }
  return { ok: true }
}

// --------------------------------------------------------- handler -------

interface RunDeps {
  db?: ReturnType<typeof getFirestore>
  now?: number
}

// ---------------------------------------------------------- snapshot cache
// Module-scope LRU keyed by (mode, scanCap). 60s TTL = same staleness the
// CDN already permits. Concurrency=40 means a hot instance serves ~40 req
// per inst-min from one Firestore scan.
interface SnapshotCacheEntry {
  rows: OpenJobRow[]
  scanned: number
  builtAt: number
}
const SNAPSHOT_TTL_MS = 60_000
const snapshotCache = new Map<string, SnapshotCacheEntry>()

function cacheKey(mode: JobSource, scanCap: number): string {
  return `${mode}:${scanCap}`
}

export function _resetSnapshotCacheForTest(): void {
  snapshotCache.clear()
}

async function loadScrapedSnapshot(
  scanCap: number,
  db: ReturnType<typeof getFirestore>,
  now: number
): Promise<SnapshotCacheEntry> {
  const key = cacheKey("scraped", scanCap)
  const cached = snapshotCache.get(key)
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
  snapshotCache.set(key, entry)
  return entry
}

async function loadCollabSnapshot(
  scanCap: number,
  db: ReturnType<typeof getFirestore>,
  now: number
): Promise<SnapshotCacheEntry> {
  const key = cacheKey("collab", scanCap)
  const cached = snapshotCache.get(key)
  if (cached && now - cached.builtAt < SNAPSHOT_TTL_MS) return cached

  // pa-jobs is small (~15 active docs today). Index existence on
  // (publicVisible, wekruitCollaborationStatus) is not guaranteed across
  // envs, so filter wekruitCollaborationStatus in memory after the
  // publicVisible query (cheap at this scale).
  const q: Query = db
    .collection("pa-jobs")
    .where("publicVisible", "==", true)
    .limit(scanCap)
  const snap = await q.get()

  const rows: OpenJobRow[] = []
  const companyIds = new Set<string>()
  for (const doc of snap.docs) {
    const row = toCollabJobRow(doc.id, doc.data() as Record<string, unknown>, now)
    if (row) {
      rows.push(row)
      const cid = normalizeCompanyName(row.company)
      if (cid) companyIds.add(cid)
    }
  }

  // Hydrate companyProfile in one batched read.
  if (companyIds.size > 0) {
    const refs = Array.from(companyIds).map((id) => db.collection("pa-companies").doc(id))
    const docs = await db.getAll(...refs)
    const byId = new Map<string, PublicCompanyProfile | undefined>()
    for (const d of docs) {
      if (!d.exists) continue
      byId.set(d.id, toPublicCompanyProfile(d.data() as Record<string, unknown> | undefined))
    }
    for (const row of rows) {
      const cid = normalizeCompanyName(row.company)
      const profile = cid ? byId.get(cid) : undefined
      if (profile) row.companyProfile = profile
    }
  }

  rows.sort((a, b) => {
    const am = a.firstSeenAt ? Date.parse(a.firstSeenAt) : 0
    const bm = b.firstSeenAt ? Date.parse(b.firstSeenAt) : 0
    return bm - am
  })

  const entry: SnapshotCacheEntry = { rows, scanned: snap.size, builtAt: now }
  snapshotCache.set(key, entry)
  return entry
}

/**
 * Apply cursor / offset window to a sorted+filtered row array.
 * Cursor takes precedence over offset. If cursor row no longer present
 * in snapshot (rotated out), fall through to offset=0 — partner sees a
 * fresh start on next call.
 */
export function applyPagination(
  filtered: OpenJobRow[],
  params: QueryParams
): { rows: OpenJobRow[]; nextCursor: string | null; hasMore: boolean } {
  let startIdx = params.offset
  if (params.cursor) {
    const cursorIdx = filtered.findIndex((r) => r.id === params.cursor!.id)
    startIdx = cursorIdx >= 0 ? cursorIdx + 1 : 0
  }
  const endIdx = startIdx + params.limit
  const rows = filtered.slice(startIdx, endIdx)
  const hasMore = endIdx < filtered.length
  const last = rows[rows.length - 1]
  const nextCursor =
    hasMore && last && last.firstSeenAt
      ? encodeCursor({ fs: Date.parse(last.firstSeenAt), id: last.id })
      : null
  return { rows, nextCursor, hasMore }
}

export async function runOpenJobs(
  params: QueryParams,
  deps: RunDeps = {}
): Promise<{
  rows: OpenJobRow[]
  scanned: number
  total: number
  cached: boolean
  nextCursor: string | null
  hasMore: boolean
}> {
  const db = deps.db ?? getFirestore()
  const now = deps.now ?? Date.now()
  const freshThresholdMs = now - params.freshDays * 24 * 60 * 60 * 1000

  // Walk the active set ordered by freshness. Bounded (~6500 active rows
  // for scraped, ~15 for collab). Scan cap scales with the page far edge
  // (offset+limit*6) so even tight pages still see enough rows to find
  // matches. Floor 300, ceiling 800 for scraped; collab capped at 200.
  const window = params.offset + params.limit
  const SCAN_CAP =
    params.source === "collab"
      ? Math.min(200, Math.max(50, window * 4))
      : Math.min(800, Math.max(300, window * 6))
  const cacheBefore = snapshotCache.get(cacheKey(params.source, SCAN_CAP))
  const cached = !!cacheBefore && now - cacheBefore.builtAt < SNAPSHOT_TTL_MS

  const snapshot =
    params.source === "collab"
      ? await loadCollabSnapshot(SCAN_CAP, db, now)
      : await loadScrapedSnapshot(SCAN_CAP, db, now)

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
  const paged = applyPagination(filtered, params)
  return {
    rows: paged.rows,
    scanned: snapshot.scanned,
    total,
    cached,
    nextCursor: paged.nextCursor,
    hasMore: paged.hasMore,
  }
}

// --------------------------------------------------------- CF export -----

function setCors(res: { set: (k: string, v: string) => void }, origin: string | undefined): void {
  // Echo Origin when present so credentialed/non-credentialed both work;
  // scraped mode is unauth so * also works. Vary on Origin to avoid CDN
  // serving the wrong CORS header to a partner with a different Origin.
  res.set("Access-Control-Allow-Origin", origin ?? "*")
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type,If-None-Match,X-WeKruit-Api-Key")
  res.set("Access-Control-Expose-Headers", "ETag,X-Cache,Last-Modified")
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
  res.set("Vary", "Accept-Encoding, Origin, X-WeKruit-Api-Key")
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
    // Keep one instance warm at all times. /market and /open are c-end
    // landing surfaces and the 2.5-3s cold-start was the dominant tail
    // latency the user reported. Single 512MiB instance idle ≈ $5/mo on
    // GCF v2, which is a fair trade for sub-200ms p50 first paint.
    minInstances: 1,
    secrets: [PA_PUBLIC_COLLAB_API_KEYS, PA_PUBLIC_COLLAB_ORIGINS],
  },
  async (req, res) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined
    setCors(res, origin)
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

      // Auth gate — collab mode only.
      if (params.source === "collab") {
        const apiKey =
          (typeof req.query.apiKey === "string" ? req.query.apiKey : undefined) ??
          (typeof req.headers["x-wekruit-api-key"] === "string"
            ? (req.headers["x-wekruit-api-key"] as string)
            : undefined)
        const keysCsv = PA_PUBLIC_COLLAB_API_KEYS.value() ?? ""
        const originsCsv = PA_PUBLIC_COLLAB_ORIGINS.value() ?? ""
        if (!keysCsv) {
          res.status(503).json({
            ok: false,
            reason: "collab_mode_not_configured",
            hint: "Set PA_PUBLIC_COLLAB_API_KEYS Firebase secret",
          })
          return
        }
        const auth = verifyCollabAuth(apiKey, origin, keysCsv, originsCsv)
        if (!auth.ok) {
          const status = auth.reason === "origin_not_allowed" ? 403 : 401
          // Never cache auth failures — partner may have just been issued a
          // key, or just fixed a typo, and a CDN-cached 401 stalls them out
          // for 5 minutes against the same query.
          res.set("Cache-Control", "no-store")
          // Diagnostic fingerprint for debugging client-side auth issues
          // without leaking the full key. Logs the byte length, first 4 +
          // last 4 chars, source (header vs query), and presence of common
          // mangling signatures (whitespace, "Bearer " prefix).
          const fp =
            apiKey === undefined
              ? "absent"
              : `len=${apiKey.length} head=${apiKey.slice(0, 4)} tail=${apiKey.slice(-4)} ws=${/\s/.test(apiKey) ? "yes" : "no"} bearer=${apiKey.startsWith("Bearer ") ? "yes" : "no"}`
          const src =
            typeof req.query.apiKey === "string"
              ? "query"
              : typeof req.headers["x-wekruit-api-key"] === "string"
                ? "header"
                : "none"
          console.warn(
            `paPublicOpenJobs auth_fail reason=${auth.reason} src=${src} key_fp=${fp} origin=${origin ?? "absent"}`
          )
          res.status(status).json({ ok: false, reason: auth.reason })
          return
        }
      }

      const result = await runOpenJobs(params)

      const etag = computeEtag(result.rows, params)
      res.set("ETag", etag)
      const ifNoneMatch = typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"] : undefined
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.status(304).send("")
        return
      }

      res.set("X-Cache", result.cached ? "HIT" : "MISS")
      res.status(200).json({
        ok: true,
        apiVersion: API_VERSION,
        source: params.source,
        generatedAt: new Date().toISOString(),
        count: result.rows.length,
        scanned: result.scanned,
        total: result.total,
        offset: params.offset,
        limit: params.limit,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        cached: result.cached,
        rows: result.rows,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      res.status(500).json({ ok: false, reason })
    }
  }
)
