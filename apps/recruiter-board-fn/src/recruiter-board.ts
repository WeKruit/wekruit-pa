/**
 * Recruiter board HTTP Cloud Functions.
 *
 * Backs the `/recruiters` route on candidate.wekruit.com. Public, CORS-enabled.
 * Lives in the `recruiter-board` multi-codebase (separate from pa-orchestrator)
 * so cold start + bundle stay small and the API stays usable for downstream
 * consumers (e.g. recruiter agents calling the public list endpoint).
 *
 *   GET  paCollabJobsList          -> sanitized list of WeKruit collab jobs
 *                                     (supports ?limit, ?offset, ?since, ?status)
 *   POST paRecruiterSubmission     -> writes pa-recruiter-submissions doc
 *                                     (honors Idempotency-Key header)
 *   GET  paCollabJobsListSchema    -> JSON Schema for the list response shape
 *
 * Companion docs:
 *   .planning/INITIATIVE-recruiter-board.md
 */
import { onRequest } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue, type Firestore, type Timestamp } from "firebase-admin/firestore"
import { getAuth } from "firebase-admin/auth"
import { createHash, randomUUID } from "node:crypto"
import { appendSubmissionToSheet } from "./recruiter-board-sheet.js"

// Memory floor for these endpoints. They serve small JSON payloads (11 docs
// today, ~80 docs ceiling). Pinned to a fixed value rather than the platform
// default to make cost behavior predictable; the new dedicated codebase has
// no shared bundle weight. 128MiB OOMed at startup (firebase-admin +
// googleapis runtime peak ~144MiB; logs 2026-05-27 14:49-16:12 UTC showed
// "Memory limit of 128 MiB exceeded with 144 MiB used" → readiness probe
// failed → 500). Bumped to 256MiB. See firebase.json `recruiter-board`
// codebase entry for deploy isolation.
const RECRUITER_BOARD_MEMORY = "256MiB"

// Optional environment variable. When set and the runtime SA has Editor access
// on the sheet, each submission is appended to a per-jobId tab. If unset, the
// Firestore write still happens and sheet sync is skipped.
const RECRUITER_BOARD_SHEET_ID_ENV = "RECRUITER_BOARD_SHEET_ID"

// ─────────────────────────────────────────────────────────────────────────────
// Hiring-board admin gating
//
// Anonymous visitors of https://wekruit.github.io/hiring-board/ must NEVER
// see the real company name on a collab job. Authenticated `@wekruit.com`
// staff get the full payload (real company, real Firestore doc id) so they
// can perform admin operations from the same surface.
// ─────────────────────────────────────────────────────────────────────────────

const HIRING_BOARD_ADMIN_EMAIL_DOMAIN = "@wekruit.com"

/**
 * Verifies a Bearer Firebase ID token and returns true when the caller's
 * email ends with `@wekruit.com`. Any missing/malformed/expired/invalid
 * token returns false (we never throw — anonymous viewing is allowed, just
 * with the anonymized payload).
 *
 * `verifyIdToken` is dependency-injected so unit tests can run without
 * Firebase Auth wired up.
 */
export async function isHiringBoardAdmin(
  req: { headers: { authorization?: string } },
  verifyIdToken?: (token: string) => Promise<{ email?: string }>,
): Promise<boolean> {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith("Bearer ")) return false
  const token = auth.slice("Bearer ".length).trim()
  if (!token) return false
  const verify =
    verifyIdToken ??
    (async (t: string) => {
      const decoded = await getAuth().verifyIdToken(t)
      return { email: decoded.email }
    })
  try {
    const decoded = await verify(token)
    return (decoded.email ?? "").toLowerCase().endsWith(HIRING_BOARD_ADMIN_EMAIL_DOMAIN)
  } catch {
    return false
  }
}

/**
 * Maps a hiring-board public-facing `jobId` (which is the opaque
 * `publicId` for anonymous viewers) back to the real Firestore doc id.
 *
 * Accepts both:
 *   - A real Firestore doc id (admin path, or legacy bookmark) — returned
 *     as-is when the doc exists.
 *   - A `publicId` UUID — resolved via `where("publicId", "==", X)`.
 *
 * Returns null when neither resolves to a collab job.
 */
export async function resolvePublicIdToDocId(
  db: Firestore,
  jobId: string,
): Promise<string | null> {
  // Try direct doc id first — cheap, common admin path.
  const directSnap = await db.collection("pa-jobs").doc(jobId).get()
  if (directSnap.exists) return directSnap.id

  // Fall back to publicId lookup for anonymized URLs.
  const query = await db
    .collection("pa-jobs")
    .where("publicId", "==", jobId)
    .limit(1)
    .get()
  if (query.empty) return null
  return query.docs[0]!.id
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — recruiterBoard payload (mirrored loosely; see INITIATIVE doc)
// ─────────────────────────────────────────────────────────────────────────────

export interface RecruiterBoardLabel {
  company: string
  companyCode: string
  location: string
  pills: { text: string; tone?: "warm" | "cool" | "neutral" }[]
}

export interface RecruiterBoardCulture {
  bet: string
  bullets: string[]
}

export interface RecruiterBoardChecklistItem {
  id: string
  text: string
}

export interface RecruiterBoardChecklistGroup {
  kind: "hard" | "fit" | "bonus" | "anti"
  heading: string
  items: RecruiterBoardChecklistItem[]
}

export interface RecruiterBoardChecklist {
  groups: RecruiterBoardChecklistGroup[]
}

export interface RecruiterBoardPayload {
  active: boolean
  sortOrder: number
  label: RecruiterBoardLabel
  culture: RecruiterBoardCulture
  checklist: RecruiterBoardChecklist
  interviewProcess?: string
}

export interface JdBlock {
  heading: string
  body: string
  kind?: "list" | "prose"
}

// What the public list endpoint returns. For non-admins the `jobId` is the
// opaque `publicId` and `recruiterBoard.label.company` is anonymized (e.g.
// `"Co. A · early-stage AI infra startup"`). Admins see the real doc id and
// full payload.
//
// `updatedAt` is ISO-8601. It is derived from `recruiterBoard.updatedAt`
// (preferred) and falls back to the doc's `updatedAt` field, then to `null`
// when neither exists. Downstream consumers can poll the list with
// `?since=<ISO>` to fetch only changed jobs.
export interface PublicCollabJob {
  jobId: string
  title: string
  compSummary?: string
  jdBlocks: JdBlock[]
  recruiterBoard: RecruiterBoardPayload
  updatedAt: string | null
}

export interface CollabJobsListResponse {
  ok: true
  jobs: PublicCollabJob[]
  /** Total count of jobs matching the filters, ignoring offset/limit. */
  total: number
  /** Offset to pass on the next request, or `null` when this is the last page. */
  nextOffset: number | null
}

function setCors(res: { set: (k: string, v: string) => unknown }): void {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization")
  res.set("Access-Control-Max-Age", "3600")
}

// ─────────────────────────────────────────────────────────────────────────────
// paCollabJobsList — public GET (+ admin-elevated view via Bearer token)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips the real company name from a recruiter-board label when the
 * caller is not a hiring-board admin. The anonymized form is expected to
 * be of the shape `"Co. X · <description>"`; if upstream content already
 * contains a real name we fall back to `"Co. <companyCode>"` so we never
 * leak identity even on a malformed doc.
 */
function anonymizeCompanyLabel(
  label: RecruiterBoardLabel,
): RecruiterBoardLabel {
  const raw = label.company ?? ""
  // Already in the expected `"Co. A · ..."` shape — pass through.
  if (/^Co\.\s/.test(raw)) {
    return label
  }
  const code = (label.companyCode ?? "X").trim() || "X"
  return {
    ...label,
    company: `Co. ${code}`,
  }
}

export interface FetchCollabJobsOptions {
  isAdmin: boolean
  /** `"open"` = `recruiterBoard.active === true` (default). `"filled"` = `active === false`. */
  status?: "open" | "filled"
  /** ISO-8601. Returns only jobs whose `recruiterBoard.updatedAt` is strictly greater. */
  since?: string
  /** 1..200, clamped. Defaults to 50 in the HTTP layer. Undefined here = no limit. */
  limit?: number
  /** Defaults to 0. */
  offset?: number
}

export interface FetchCollabJobsResult {
  jobs: PublicCollabJob[]
  total: number
  nextOffset: number | null
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * Coerces a Firestore Timestamp / Date / ISO string / number into ISO-8601,
 * or `null` if the value is missing/unparseable.
 */
function coerceToIso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  // Firestore Timestamp: has `toDate()` method.
  if (typeof value === "object" && value !== null && typeof (value as { toDate?: unknown }).toDate === "function") {
    const d = (value as Timestamp).toDate()
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof value === "number") {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof value === "string") {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

function extractJobUpdatedAt(
  rb: RecruiterBoardPayload | undefined,
  docData: Record<string, unknown>,
): string | null {
  const rbUpdated = (rb as unknown as Record<string, unknown> | undefined)?.updatedAt
  return coerceToIso(rbUpdated) ?? coerceToIso(docData.updatedAt)
}

export async function fetchCollabJobs(
  db: Firestore,
  options: FetchCollabJobsOptions = { isAdmin: false },
): Promise<FetchCollabJobsResult> {
  const wantStatus: "open" | "filled" = options.status ?? "open"
  const wantActive = wantStatus === "open"

  // Validate `since` once up front so a malformed value fails fast in the
  // HTTP layer rather than silently filtering nothing.
  let sinceMs: number | null = null
  if (options.since !== undefined) {
    const parsed = Date.parse(options.since)
    if (Number.isNaN(parsed)) {
      throw new Error(`invalid_since:${options.since}`)
    }
    sinceMs = parsed
  }

  const snap = await db
    .collection("pa-jobs")
    .where("wekruitCollaborationStatus", "==", "collaborated")
    .get()

  const allMatching: PublicCollabJob[] = []
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    const rb = d.recruiterBoard as RecruiterBoardPayload | undefined
    if (!rb) continue
    if (Boolean(rb.active) !== wantActive) continue

    const updatedAtIso = extractJobUpdatedAt(rb, d)
    if (sinceMs !== null) {
      if (updatedAtIso === null) continue
      const updatedMs = Date.parse(updatedAtIso)
      if (Number.isNaN(updatedMs) || updatedMs <= sinceMs) continue
    }

    const publicId = typeof d.publicId === "string" ? d.publicId : undefined
    // Admin path: keep real Firestore doc id so admin operations resolve
    // against the same id used elsewhere in the dashboard. Non-admin: use
    // the opaque publicId; fall back to doc id only if the migration
    // hasn't run yet on this doc.
    const jobIdForCaller = options.isAdmin
      ? doc.id
      : (publicId ?? doc.id)

    const recruiterBoardForCaller: RecruiterBoardPayload = options.isAdmin
      ? rb
      : { ...rb, label: anonymizeCompanyLabel(rb.label) }

    allMatching.push({
      jobId: jobIdForCaller,
      title: String(d.title ?? ""),
      compSummary: typeof d.compSummary === "string" ? d.compSummary : undefined,
      jdBlocks: Array.isArray(d.jdBlocks) ? (d.jdBlocks as JdBlock[]) : [],
      recruiterBoard: recruiterBoardForCaller,
      updatedAt: updatedAtIso,
    })
  }
  allMatching.sort((a, b) => a.recruiterBoard.sortOrder - b.recruiterBoard.sortOrder)

  const total = allMatching.length
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  let limit = options.limit === undefined
    ? total - offset // no explicit limit -> return everything left
    : Math.max(0, Math.floor(options.limit))
  // Clamp explicit limits to MAX_LIMIT. When the caller passes no limit we
  // already used `total - offset`, so the clamp here is only for callers that
  // ask for more than the cap.
  if (options.limit !== undefined && limit > MAX_LIMIT) limit = MAX_LIMIT

  const pageEnd = offset + limit
  const jobs = allMatching.slice(offset, pageEnd)
  const nextOffset = pageEnd < total ? pageEnd : null

  return { jobs, total, nextOffset }
}

function parseQueryString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function parseQueryInt(value: unknown): { ok: true; value: number } | { ok: false } {
  const raw = parseQueryString(value)
  if (raw === undefined) return { ok: false }
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return { ok: false }
  return { ok: true, value: parsed }
}

export const paCollabJobsList = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
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

    const limitParsed = parseQueryInt(req.query.limit)
    const offsetParsed = parseQueryInt(req.query.offset)
    if (req.query.limit !== undefined && !limitParsed.ok) {
      res.status(400).json({ ok: false, reason: "invalid_limit" })
      return
    }
    if (req.query.offset !== undefined && !offsetParsed.ok) {
      res.status(400).json({ ok: false, reason: "invalid_offset" })
      return
    }
    const limit = limitParsed.ok
      ? Math.min(Math.max(1, limitParsed.value), MAX_LIMIT)
      : DEFAULT_LIMIT
    const offset = offsetParsed.ok ? Math.max(0, offsetParsed.value) : 0

    const since = parseQueryString(req.query.since)
    const statusRaw = parseQueryString(req.query.status)?.toLowerCase()
    let status: "open" | "filled" = "open"
    if (statusRaw !== undefined) {
      if (statusRaw !== "open" && statusRaw !== "filled") {
        res.status(400).json({ ok: false, reason: "invalid_status" })
        return
      }
      status = statusRaw
    }

    try {
      const isAdmin = await isHiringBoardAdmin(req)
      const { jobs, total, nextOffset } = await fetchCollabJobs(getFirestore(), {
        isAdmin,
        status,
        since,
        limit,
        offset,
      })
      // Admin payloads contain real company identity — never cache on a
      // shared/CDN layer. Anonymous payloads are safe to cache (60s).
      if (isAdmin) {
        res.set("Cache-Control", "private, max-age=0, no-store")
      } else {
        res.set("Cache-Control", "public, max-age=60, s-maxage=60")
      }
      const body: CollabJobsListResponse = { ok: true, jobs, total, nextOffset }
      res.status(200).json(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith("invalid_since:")) {
        res.status(400).json({ ok: false, reason: "invalid_since" })
        return
      }
      logger.error("paCollabJobsList_failed", { error: message })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// paCollabJobsListSchema — frozen JSON Schema for the list response shape
// ─────────────────────────────────────────────────────────────────────────────

const COLLAB_JOBS_LIST_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://wekruit.com/schemas/collab-jobs-list-response.json",
  title: "CollabJobsListResponse",
  description:
    "Response from GET paCollabJobsList. `total` ignores offset/limit. `nextOffset` is null on the final page.",
  type: "object",
  required: ["ok", "jobs", "total", "nextOffset"],
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", const: true },
    total: { type: "integer", minimum: 0 },
    nextOffset: { type: ["integer", "null"], minimum: 0 },
    jobs: {
      type: "array",
      items: {
        type: "object",
        required: ["jobId", "title", "jdBlocks", "recruiterBoard", "updatedAt"],
        properties: {
          jobId: { type: "string" },
          title: { type: "string" },
          compSummary: { type: "string" },
          updatedAt: { type: ["string", "null"], format: "date-time" },
          jdBlocks: {
            type: "array",
            items: {
              type: "object",
              required: ["heading", "body"],
              properties: {
                heading: { type: "string" },
                body: { type: "string" },
                kind: { type: "string", enum: ["list", "prose"] },
              },
            },
          },
          recruiterBoard: {
            type: "object",
            required: ["active", "sortOrder", "label", "culture", "checklist"],
            properties: {
              active: { type: "boolean" },
              sortOrder: { type: "number" },
              interviewProcess: { type: "string" },
              label: {
                type: "object",
                required: ["company", "companyCode", "location", "pills"],
                properties: {
                  company: { type: "string" },
                  companyCode: { type: "string" },
                  location: { type: "string" },
                  pills: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["text"],
                      properties: {
                        text: { type: "string" },
                        tone: { type: "string", enum: ["warm", "cool", "neutral"] },
                      },
                    },
                  },
                },
              },
              culture: {
                type: "object",
                required: ["bet", "bullets"],
                properties: {
                  bet: { type: "string" },
                  bullets: { type: "array", items: { type: "string" } },
                },
              },
              checklist: {
                type: "object",
                required: ["groups"],
                properties: {
                  groups: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["kind", "heading", "items"],
                      properties: {
                        kind: { type: "string", enum: ["hard", "fit", "bonus", "anti"] },
                        heading: { type: "string" },
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["id", "text"],
                            properties: {
                              id: { type: "string" },
                              text: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
})

export const paCollabJobsListSchema = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
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
    // The schema is frozen at deploy time, so it's safe to cache long.
    res.set("Cache-Control", "public, max-age=3600, s-maxage=3600")
    res.status(200).json(COLLAB_JOBS_LIST_SCHEMA)
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// paRecruiterSubmission — public POST
// ─────────────────────────────────────────────────────────────────────────────

interface SubmissionPayload {
  jobId: string
  submitter: { name: string; email: string; company?: string }
  candidate: {
    name: string
    link: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  checklist: { [itemId: string]: boolean }
  /** Caller hint: which surface produced this submission. Tracked verbatim. */
  source?: string
}

/** Allowed values for `source` in the request body. */
const ALLOWED_SUBMISSION_SOURCES = new Set(["hiring-board", "api", "unknown"])
/** Pattern for the `Idempotency-Key` header. Mirrors Stripe's rules. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0
}

function validateSubmission(input: unknown):
  | { ok: true; value: SubmissionPayload }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.jobId)) return { ok: false, reason: "missing_jobId" }
  if (b.jobId.length > 200) return { ok: false, reason: "jobId_too_long" }

  const s = b.submitter as Record<string, unknown> | undefined
  if (!s || typeof s !== "object") return { ok: false, reason: "missing_submitter" }
  if (!isNonEmptyString(s.name)) return { ok: false, reason: "missing_submitter_name" }
  if (!isNonEmptyString(s.email)) return { ok: false, reason: "missing_submitter_email" }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) return { ok: false, reason: "invalid_email" }
  if (s.name.length > 200 || s.email.length > 320) return { ok: false, reason: "submitter_too_long" }
  if (s.company !== undefined && (typeof s.company !== "string" || s.company.length > 200)) {
    return { ok: false, reason: "invalid_submitter_company" }
  }

  const c = b.candidate as Record<string, unknown> | undefined
  if (!c || typeof c !== "object") return { ok: false, reason: "missing_candidate" }
  if (!isNonEmptyString(c.name)) return { ok: false, reason: "missing_candidate_name" }
  if (!isNonEmptyString(c.link)) return { ok: false, reason: "missing_candidate_link" }
  if (c.name.length > 200) return { ok: false, reason: "candidate_name_too_long" }
  if (c.link.length > 2000) return { ok: false, reason: "candidate_link_too_long" }
  for (const k of ["currentRole", "yoe", "notes"] as const) {
    if (c[k] !== undefined && typeof c[k] !== "string") return { ok: false, reason: `invalid_${k}` }
    if (typeof c[k] === "string" && (c[k] as string).length > 4000) return { ok: false, reason: `${k}_too_long` }
  }

  const cl = b.checklist
  if (!cl || typeof cl !== "object") return { ok: false, reason: "missing_checklist" }
  const cleanedChecklist: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(cl as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length > 200) return { ok: false, reason: "invalid_checklist_key" }
    if (typeof v !== "boolean") return { ok: false, reason: "invalid_checklist_value" }
    cleanedChecklist[k] = v
  }

  // Optional `source` hint. Unknown strings are rejected so audit data stays
  // closed-vocab; missing values default to "unknown" downstream.
  let source: string | undefined = undefined
  if (b.source !== undefined) {
    if (typeof b.source !== "string") return { ok: false, reason: "invalid_source" }
    const trimmed = b.source.trim()
    if (trimmed.length === 0) {
      source = undefined
    } else if (!ALLOWED_SUBMISSION_SOURCES.has(trimmed)) {
      return { ok: false, reason: "invalid_source" }
    } else {
      source = trimmed
    }
  }

  return {
    ok: true,
    value: {
      jobId: b.jobId,
      submitter: {
        name: s.name.trim(),
        email: (s.email as string).trim().toLowerCase(),
        company: typeof s.company === "string" ? s.company.trim() : undefined,
      },
      candidate: {
        name: (c.name as string).trim(),
        link: (c.link as string).trim(),
        currentRole: typeof c.currentRole === "string" ? (c.currentRole as string).trim() : undefined,
        yoe: typeof c.yoe === "string" ? (c.yoe as string).trim() : undefined,
        notes: typeof c.notes === "string" ? (c.notes as string).trim() : undefined,
      },
      checklist: cleanedChecklist,
      source,
    },
  }
}

export interface SubmissionScore {
  hardChecked: number
  hardTotal: number
  fitChecked: number
  fitTotal: number
  bonusChecked: number
  bonusTotal: number
  antiChecked: number
  antiTotal: number
}

export function computeSubmissionScore(
  groups: RecruiterBoardChecklistGroup[],
  checklist: Record<string, boolean>,
): SubmissionScore {
  const score: SubmissionScore = {
    hardChecked: 0, hardTotal: 0,
    fitChecked: 0, fitTotal: 0,
    bonusChecked: 0, bonusTotal: 0,
    antiChecked: 0, antiTotal: 0,
  }
  for (const g of groups) {
    for (const item of g.items) {
      const checked = checklist[item.id] === true
      switch (g.kind) {
        case "hard":  score.hardTotal++;  if (checked) score.hardChecked++;  break
        case "fit":   score.fitTotal++;   if (checked) score.fitChecked++;   break
        case "bonus": score.bonusTotal++; if (checked) score.bonusChecked++; break
        case "anti":  score.antiTotal++;  if (checked) score.antiChecked++;  break
      }
    }
  }
  return score
}

export const paRecruiterSubmission = onRequest(
  { cors: false, region: "us-central1", memory: RECRUITER_BOARD_MEMORY },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }

    // Idempotency-Key (optional). When provided, we use it as the Firestore
    // doc id so retries of the same logical submission deduplicate. The
    // existing doc is returned with 200 (the caller gets the same
    // `submissionId` + `score` as the original write). Header is validated
    // with a Stripe-style allowlist to keep doc-ids safe.
    const idempotencyHeader = (req.get("idempotency-key") ?? "").trim()
    if (idempotencyHeader && !IDEMPOTENCY_KEY_RE.test(idempotencyHeader)) {
      res.status(400).json({ ok: false, reason: "invalid_idempotency_key" })
      return
    }

    const validated = validateSubmission(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    const payload = validated.value

    const db = getFirestore()

    // Fast path: idempotent replay returns the existing doc without
    // re-resolving the job or re-scoring the checklist.
    if (idempotencyHeader) {
      const existing = await db
        .collection("pa-recruiter-submissions")
        .doc(idempotencyHeader)
        .get()
      if (existing.exists) {
        const existingData = existing.data() as { score?: SubmissionScore } | undefined
        res.status(200).json({
          ok: true,
          submissionId: idempotencyHeader,
          score: existingData?.score ?? null,
          idempotent: true,
        })
        return
      }
    }

    // Frontend may send either the real Firestore doc id (admin path) or
    // an opaque `publicId` UUID (anonymous hiring-board path). Resolve to
    // the real doc id so every downstream reference is consistent.
    const realJobId = await resolvePublicIdToDocId(db, payload.jobId)
    if (!realJobId) {
      res.status(404).json({ ok: false, reason: "job_not_found" })
      return
    }
    const jobRef = db.collection("pa-jobs").doc(realJobId)
    const jobSnap = await jobRef.get()
    if (!jobSnap.exists) {
      res.status(404).json({ ok: false, reason: "job_not_found" })
      return
    }
    const jobData = jobSnap.data() as Record<string, unknown>
    if (jobData.wekruitCollaborationStatus !== "collaborated") {
      res.status(403).json({ ok: false, reason: "job_not_collab" })
      return
    }
    const rb = jobData.recruiterBoard as RecruiterBoardPayload | undefined
    if (!rb || rb.active !== true) {
      res.status(403).json({ ok: false, reason: "job_not_active_on_board" })
      return
    }

    const score = computeSubmissionScore(rb.checklist.groups, payload.checklist)

    const submissionId = idempotencyHeader || randomUUID()
    const ip = req.get("x-forwarded-for")?.split(",")[0]?.trim() || ""
    const callerSource = payload.source ?? "unknown"
    const submissionDoc = {
      submissionId,
      // Canonical Firestore doc id (what admin tooling expects). When the
      // caller used the public/anonymized id, `inboundJobId` preserves the
      // original lineage for audit.
      jobId: realJobId,
      inboundJobId: payload.jobId,
      jobTitleSnapshot: String(jobData.title ?? ""),
      companyLabelSnapshot: rb.label.company,
      submitter: payload.submitter,
      candidate: payload.candidate,
      checklist: payload.checklist,
      score,
      // Caller-supplied audit surface. Tracks which UI (hiring-board, api,
      // unknown) produced the submission so downstream filtering works.
      callerSource,
      idempotencyKey: idempotencyHeader || null,
      source: {
        userAgent: req.get("user-agent") ?? "",
        referrer: req.get("referer") ?? "",
        ipHash: ip ? createHash("sha256").update(ip).digest("hex").slice(0, 16) : "",
      },
      status: "new",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }

    try {
      if (idempotencyHeader) {
        // `create()` fails when the doc already exists. Combined with the
        // pre-check above, this protects against a narrow race where two
        // concurrent retries of the same key both miss the existence check.
        try {
          await db.collection("pa-recruiter-submissions").doc(submissionId).create(submissionDoc)
        } catch (createErr) {
          const message = String(createErr)
          if (message.includes("ALREADY_EXISTS") || message.includes("already exists")) {
            const existing = await db
              .collection("pa-recruiter-submissions")
              .doc(submissionId)
              .get()
            const existingData = existing.data() as { score?: SubmissionScore } | undefined
            res.status(200).json({
              ok: true,
              submissionId,
              score: existingData?.score ?? null,
              idempotent: true,
            })
            return
          }
          throw createErr
        }
      } else {
        await db.collection("pa-recruiter-submissions").doc(submissionId).set(submissionDoc)
      }
    } catch (err) {
      logger.error("paRecruiterSubmission_write_failed", { error: String(err), submissionId })
      res.status(500).json({ ok: false, reason: "write_failed" })
      return
    }

    logger.info("paRecruiterSubmission_received", {
      submissionId,
      jobId: realJobId,
      submitterEmail: payload.submitter.email,
      hardScore: `${score.hardChecked}/${score.hardTotal}`,
      callerSource,
      idempotent: false,
    })

    // Best-effort Sheet sync. Failure does not block the 200 — the Firestore
    // write is the source of truth and the doc keeps an error breadcrumb so
    // a retry job can pick it up later.
    const sheetId = (process.env[RECRUITER_BOARD_SHEET_ID_ENV] ?? "").trim()
    if (sheetId) {
      const sheetResult = await appendSubmissionToSheet(sheetId, {
        submissionId,
        jobId: realJobId,
        companyLabel: rb.label.company,
        submitter: payload.submitter,
        candidate: payload.candidate,
        checklist: payload.checklist,
        score,
        jobChecklistGroups: rb.checklist.groups,
        jobTitle: String(jobData.title ?? ""),
      })
      try {
        if (sheetResult.ok) {
          await db.collection("pa-recruiter-submissions").doc(submissionId).update({
            sheetSyncedAt: FieldValue.serverTimestamp(),
            sheetRowId: sheetResult.rowId,
          })
        } else {
          await db.collection("pa-recruiter-submissions").doc(submissionId).update({
            sheetSyncError: sheetResult.reason.slice(0, 500),
          })
        }
      } catch (err) {
        logger.error("paRecruiterSubmission_sheet_update_failed", {
          error: String(err),
          submissionId,
        })
      }
    }

    res.status(200).json({
      ok: true,
      submissionId,
      score,
    })
  },
)
