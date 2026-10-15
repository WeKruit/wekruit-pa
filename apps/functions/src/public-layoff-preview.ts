/**
 * Public HTTP CF - paPublicLayoffPreview.
 *
 * Powers the rolling candidate preview on layoff.wekruit.com hero section
 * (the "Currently available - N people - updated daily" table). Returns a
 * redacted, demo+real mixed projection of `pa-users` filtered to the
 * layoff list.
 *
 * Data lives in the pa-users collection:
 *   - internal demo rows are seeded via apps/functions/scripts/seed-layoff-demo.mjs
 *   - `getHired: true` rows are excluded from the preview
 *   - real signups and demo seed rows mix in the same response
 *
 * Filter contract:
 *   - source === "WeKruit_Laid_Off"
 *   - getHired !== true  (covers both `false` and `undefined`)
 *   - has displayName + layoffContext.lastCompany
 *
 * Output projection (NEVER returns isDemo / getHired / phoneE164 / email):
 *   - id, firstName, lastInitial, lastCompany, function, jobTitle,
 *     location, joinedAtIso, verified
 *
 * Cache: 5 min in-instance + 60s edge cache. Counts shift slowly under
 * normal load, so stale-while-revalidate up to 10 min is safe.
 *
 * Pattern mirrors apps/functions/src/public-open-jobs.ts.
 */
import { onRequest } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, type Firestore, type Timestamp } from "firebase-admin/firestore"
import { getApps, initializeApp } from "firebase-admin/app"

import { PA_COLLECTIONS } from "@pa/core-types"
import { WEKRUIT_LAYOFF_SOURCE } from "@pa/pa-orchestrator"

if (!getApps().length) initializeApp()

const SNAPSHOT_TTL_MS = 5 * 60 * 1000
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 50
const MAX_FETCH = 300

interface PreviewRow {
  id: string
  firstName: string
  lastInitial: string
  lastCompany: string
  function: string | null
  jobTitle: string
  location: string
  joinedAtIso: string
  verified: boolean
}

interface PreviewResponse {
  ok: true
  count: number
  totalAvailable: number
  joinedThisWeek: number
  rows: PreviewRow[]
}

let cached: { at: number; rows: PreviewRow[]; total: number; thisWeek: number } | null = null

function asIsoFromTimestamp(value: unknown): string | null {
  if (!value) return null
  if (typeof value === "string") return value
  const ts = value as Partial<Timestamp>
  if (typeof ts.toDate === "function") {
    try {
      return ts.toDate().toISOString()
    } catch {
      return null
    }
  }
  return null
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = value.trim()
  return text ? text : null
}

function firstText(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  for (const item of value) {
    const text = cleanText(item)
    if (text) return text
  }
  return null
}

function humanizeLocation(value: unknown): string | null {
  const text = cleanText(value)
  if (!text) return null
  const lower = text.toLowerCase()
  if (lower === "san_francisco_bay_area" || /\b(sf|san francisco|bay area)\b/i.test(text)) return "San Francisco Bay Area"
  if (lower === "new_york_city" || /\b(nyc|new york)\b/i.test(text)) return "New York"
  if (lower === "remote_us" || /\bremote\b/i.test(text)) return "Remote, US"
  return text
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function deriveFunctionFromTitle(value: unknown): string | null {
  const t = cleanText(value)?.toLowerCase()
  if (!t) return null
  if (t.includes("design") || t.includes("ux") || t.includes("brand")) return "Design"
  if (t.includes("eng") || t.includes("sw") || t.includes("developer")) return "Engineering"
  if (t.includes("pm") || t.includes("product")) return "Product"
  if (t.includes("sales") || t.includes("marketing") || t.includes("ae") || t.includes("cs")) return "GTM"
  return "Other"
}

function projectRow(docId: string, data: Record<string, unknown>): PreviewRow | null {
  const displayName = typeof data.displayName === "string" ? data.displayName.trim() : ""
  if (!displayName) return null
  const ctx = objectValue(data.layoffContext)
  const tags = objectValue(data.tags)
  const stated = objectValue(data.statedPreferences)
  const shared = objectValue(data.sharedOnboarding)
  const prompt = objectValue(shared.promptContext)
  const answers = objectValue(shared.answers)
  const locationAnswer = objectValue(answers.location_relocation)
  const lastCompany =
    cleanText(ctx.lastCompany) ??
    cleanText(data.lastCompany) ??
    cleanText(tags.recentCompany) ??
    firstText(prompt.recentCompanies) ??
    ""
  if (!lastCompany) return null
  const [firstRaw, ...rest] = displayName.split(/\s+/)
  const firstName = firstRaw ?? "-"
  const lastInitial = rest.length > 0 ? (rest[rest.length - 1] ?? "").slice(0, 1).replace(/[^A-Za-z]/g, "") : ""
  const joinedAtIso = asIsoFromTimestamp(data.lastLaidOffAt) ?? asIsoFromTimestamp(data.createdAt) ?? new Date().toISOString()
  const jobTitle =
    cleanText(ctx.jobTitle) ??
    cleanText(data.jobTitle) ??
    cleanText(tags.recentRoleTitle) ??
    firstText(prompt.recentTitles) ??
    ""
  const location =
    humanizeLocation(ctx.location) ??
    humanizeLocation(data.location) ??
    humanizeLocation(firstText(stated.targetLocations)) ??
    humanizeLocation(firstText(tags.targetLocations)) ??
    humanizeLocation(locationAnswer.answer) ??
    firstText(prompt.recentLocations) ??
    ""
  return {
    id: docId,
    firstName,
    lastInitial,
    lastCompany,
    function: cleanText(ctx.function) ?? cleanText(data.function) ?? deriveFunctionFromTitle(jobTitle),
    jobTitle,
    location,
    joinedAtIso,
    verified: data.onboardingStatus === "complete" || data.onboardingStatus === "active",
  }
}

async function loadSnapshot(db: Firestore): Promise<{ rows: PreviewRow[]; total: number; thisWeek: number; cached: boolean }> {
  const now = Date.now()
  if (cached && now - cached.at < SNAPSHOT_TTL_MS) {
    return { rows: cached.rows, total: cached.total, thisWeek: cached.thisWeek, cached: true }
  }
  // Fetch by source only, then sort/filter the small public preview slice in
  // memory. This avoids a production dependency on a composite Firestore index.
  const snap = await db
    .collection(PA_COLLECTIONS.users)
    .where("source", "==", WEKRUIT_LAYOFF_SOURCE)
    .limit(MAX_FETCH)
    .get()

  const sevenDaysAgo = Date.now() - 7 * 86400_000
  const rows: PreviewRow[] = []
  let totalAvailable = 0
  let joinedThisWeek = 0

  const sortMs = (data: Record<string, unknown>) => {
    const iso = asIsoFromTimestamp(data.lastLaidOffAt) ?? asIsoFromTimestamp(data.createdAt)
    const ms = Date.parse(iso ?? "")
    return Number.isFinite(ms) ? ms : 0
  }
  const sortedDocs = [...snap.docs].sort((a, b) => sortMs(b.data()) - sortMs(a.data()))

  for (const d of sortedDocs) {
    const data = d.data() ?? {}
    if (data.getHired === true) continue
    const projected = projectRow(d.id, data)
    if (!projected) continue
    totalAvailable += 1
    const laidOffMs = (() => {
      const iso = asIsoFromTimestamp(data.lastLaidOffAt)
      return iso ? Date.parse(iso) : 0
    })()
    if (laidOffMs >= sevenDaysAgo) joinedThisWeek += 1
    if (rows.length < MAX_LIMIT) {
      rows.push(projected)
    }
  }
  cached = { at: now, rows, total: totalAvailable, thisWeek: joinedThisWeek }
  return { rows, total: totalAvailable, thisWeek: joinedThisWeek, cached: false }
}

function setCors(res: { set: (k: string, v: string) => void }) {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type")
  res.set("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600")
  res.set("Vary", "Accept-Encoding")
}

export const paPublicLayoffPreview = onRequest(
  {
    region: "us-central1",
    cors: false,
    memory: "512MiB",
    timeoutSeconds: 20,
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
      const limitRaw = Number(req.query.limit)
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : DEFAULT_LIMIT
      const snap = await loadSnapshot(getFirestore())
      const rows = snap.rows.slice(0, limit)
      const body: PreviewResponse = {
        ok: true,
        count: rows.length,
        totalAvailable: snap.total,
        joinedThisWeek: snap.thisWeek,
        rows,
      }
      res.set("X-Cache", snap.cached ? "HIT" : "MISS")
      res.status(200).json(body)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      logger.error("paPublicLayoffPreview.failed", { reason })
      res.status(500).json({ ok: false, reason })
    }
  },
)
