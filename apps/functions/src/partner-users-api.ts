/**
 * Public partner API — paPartnerUsersApi.
 *
 * Surface: GET https://wekruit.com/api/v1/partner/users
 * Auth: X-API-Key header. Keys shaped `key_<partnerSource>_<random>` —
 * the prefix is parsed to derive the `pa-users.source` filter, so each
 * key is scoped to exactly one partner's data.
 *
 * Spec: docs/superpowers/specs/2026-05-27-partner-users-api-design.md
 */
import { getApps, initializeApp } from "firebase-admin/app"
import { Timestamp, getFirestore, type Firestore, type Query } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { onRequest } from "firebase-functions/v2/https"
import { createHash } from "node:crypto"
import {
  CandidateJobStateSchema,
  PA_COLLECTIONS,
  isPaUserSource,
  type CandidateJobState,
  type PaUserSource,
} from "@pa/core-types"

if (!getApps().length) initializeApp()

// ---------------------------------------------------------------- secrets

// Reuses the SAME partner-key secret as the job API (paPublicOpenJobs). One
// key per partner, shaped `key_<source>_<random>` — the prefix is parsed to
// derive the pa-users.source filter, so a job-API key already issued to a
// partner (e.g. key_layoffhedge_…) also authorizes that partner's users feed,
// scoped to their own source. No separate secret to provision.
const PA_PUBLIC_COLLAB_API_KEYS = defineSecret("PA_PUBLIC_COLLAB_API_KEYS")
/** Reused from paPublicOpenJobs — same browser origin allowlist applies. */
const PA_PUBLIC_COLLAB_ORIGINS = defineSecret("PA_PUBLIC_COLLAB_ORIGINS")

// ---------------------------------------------------------------- constants

const API_VERSION = "v1"
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const PER_USER_JOB_CAP = 50

// ---------------------------------------------------------------- types

interface AuthOk {
  ok: true
  partnerSource: PaUserSource
}

interface AuthFail {
  ok: false
  reason:
    | "missing_api_key"
    | "invalid_api_key"
    | "invalid_api_key_format"
    | "key_partner_mismatch"
    | "origin_not_allowed"
}

type AuthResult = AuthOk | AuthFail

// ---------------------------------------------------------------- auth

const PARTNER_KEY_RE = /^key_([a-z][a-z0-9_]+?)_[A-Za-z0-9]+$/

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function verifyPartnerKey(
  apiKey: string | undefined,
  origin: string | undefined,
  keysCsv: string,
  originsCsv: string,
): AuthResult {
  if (!apiKey) return { ok: false, reason: "missing_api_key" }

  const match = PARTNER_KEY_RE.exec(apiKey)
  if (!match) return { ok: false, reason: "invalid_api_key_format" }
  const partnerSlug = match[1]!

  const keys = keysCsv.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  const apiKeyBuf = Buffer.from(apiKey)
  let matched = false
  for (const k of keys) {
    if (constantTimeEqual(apiKeyBuf, Buffer.from(k))) {
      matched = true
      break
    }
  }
  if (!matched) return { ok: false, reason: "invalid_api_key" }

  if (!isPaUserSource(partnerSlug)) return { ok: false, reason: "key_partner_mismatch" }
  const partnerSource = partnerSlug as PaUserSource

  const originsTrim = originsCsv.trim()
  if (originsTrim === "*" || originsTrim === "") return { ok: true, partnerSource }
  if (!origin) return { ok: true, partnerSource }
  const allowed = originsTrim.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  if (!allowed.includes(origin)) return { ok: false, reason: "origin_not_allowed" }
  return { ok: true, partnerSource }
}

// Internal test exports (do not call from production code).
export const __test_verifyPartnerKey = verifyPartnerKey
export const __test_PARTNER_KEY_RE = PARTNER_KEY_RE

// ---------------------------------------------------------------- query

export interface PartnerUsersFetchArgs {
  db: Firestore
  partnerSource: PaUserSource
  limit: number
  cursorOpaque?: string
  status?: CandidateJobState[]
  since?: string // ISO 8601
}

export interface PartnerUsersJobRow {
  jobId: string
  jobTitle: string
  company: string
  state: CandidateJobState
  stateUpdatedAt: string
  prescreenSessionId?: string
  wekruitJobUrl: string
}

export interface PartnerUsersUserRow {
  email: string
  name?: string
  wekruitUserId: string
  registeredAt: string
  lifecycleState?: string
  jobs: PartnerUsersJobRow[]
  summary: {
    totalJobs: number
    passedJobs: number
    notPassedJobs: number
    activePrescreens: number
    employerVisibleJobs: number
  }
}

export interface PartnerUsersResponse {
  users: PartnerUsersUserRow[]
  nextCursor?: string
  hasMore: boolean
  generatedAt: string
  partner: PaUserSource
  apiVersion: string
}

interface CursorPayload {
  // pa-users stores createdAt as an ISO 8601 string (no numeric *Ms field).
  // ISO 8601 sorts lexicographically === chronologically, so it is a valid
  // Firestore orderBy + cursor key.
  createdAt: string
  docId: string
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

function decodeCursor(opaque: string): CursorPayload | null {
  try {
    const decoded = JSON.parse(Buffer.from(opaque, "base64url").toString("utf8"))
    if (
      decoded &&
      typeof decoded === "object" &&
      typeof decoded.createdAt === "string" &&
      typeof decoded.docId === "string"
    ) {
      return { createdAt: decoded.createdAt, docId: decoded.docId }
    }
    return null
  } catch {
    return null
  }
}

function toIsoString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (typeof value === "object" && value !== null && "_seconds" in value) {
    const sec = Number((value as { _seconds?: unknown })._seconds ?? 0)
    return new Date(sec * 1000).toISOString()
  }
  return fallback
}

function activePrescreenStates(): ReadonlySet<CandidateJobState> {
  return new Set<CandidateJobState>([
    "prescreen_started",
    "prescreen_review_pending",
    "paused",
  ])
}

const ACTIVE_PRESCREEN = activePrescreenStates()

export async function fetchPartnerUsers(args: PartnerUsersFetchArgs): Promise<PartnerUsersResponse> {
  const { db, partnerSource, limit } = args
  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, limit))
  const sinceMs = args.since ? Date.parse(args.since) : undefined

  // Users page (limit + 1 to detect hasMore).
  let usersQ: Query = db
    .collection(PA_COLLECTIONS.users)
    .where("source", "==", partnerSource)
    .orderBy("createdAt", "desc")
    .orderBy("__name__", "desc")
  const cursor = args.cursorOpaque ? decodeCursor(args.cursorOpaque) : null
  if (cursor) usersQ = usersQ.startAfter(cursor.createdAt, cursor.docId)
  usersQ = usersQ.limit(safeLimit + 1)
  const usersSnap = await usersQ.get()
  const usersDocs = usersSnap.docs.slice(0, safeLimit)
  const hasMore = usersSnap.docs.length > safeLimit

  // Per-user job states + job-doc hydration + prescreen session join.
  const rows = await Promise.all(
    usersDocs.map(async (userDoc) => {
      const userData = userDoc.data() ?? {}
      const candidateId = userDoc.id

      // No orderBy here: `stateUpdatedAt` is an ISO string and an equality+orderBy
      // on it would need a dedicated (candidateId, stateUpdatedAt) composite index.
      // The per-user list is capped at PER_USER_JOB_CAP, so we sort in memory.
      const stateSnap = await db
        .collection(PA_COLLECTIONS.candidateJobStates)
        .where("candidateId", "==", candidateId)
        .limit(PER_USER_JOB_CAP)
        .get()
      const jobStates = stateSnap.docs
        .map((d) => ({ id: d.id, data: d.data() ?? {} }))
        .sort((a, b) => {
          const av = toIsoString(a.data.stateUpdatedAt, "")
          const bv = toIsoString(b.data.stateUpdatedAt, "")
          return av === bv ? 0 : av < bv ? 1 : -1 // desc
        })

      const distinctJobIds = [
        ...new Set(jobStates.map((s) => (s.data.jobId as string | undefined) ?? "").filter(Boolean)),
      ]
      const jobDocs = await Promise.all(
        distinctJobIds.map((jobId) =>
          db.collection(PA_COLLECTIONS.jobs).doc(jobId).get().catch(() => null),
        ),
      )
      const jobMeta = new Map<string, { title: string; company: string }>()
      for (let i = 0; i < distinctJobIds.length; i++) {
        const snap = jobDocs[i]
        const data = (snap && typeof snap === "object" && "data" in snap ? snap.data?.() : null) ?? {}
        jobMeta.set(distinctJobIds[i]!, {
          title: (data.title as string | undefined) ?? "Unknown role",
          company: (data.company as string | undefined) ?? "",
        })
      }

      const jobs: PartnerUsersJobRow[] = []
      for (const s of jobStates) {
        const parsed = CandidateJobStateSchema.safeParse(s.data.state)
        if (!parsed.success) continue
        const jobId = (s.data.jobId as string | undefined) ?? ""
        if (!jobId) continue
        const stateUpdatedAt = toIsoString(s.data.stateUpdatedAt, new Date(0).toISOString())
        if (sinceMs !== undefined && Date.parse(stateUpdatedAt) < sinceMs) continue
        if (args.status && args.status.length > 0 && !args.status.includes(parsed.data)) continue
        const meta = jobMeta.get(jobId) ?? { title: "Unknown role", company: "" }

        // Latest prescreen session for this candidate+job. pa-prescreen-sessions
        // keys the candidate as `userId` (not candidateId) and timestamps as
        // `updatedAt` (ISO string). The existing (jobId, userId, updatedAt desc)
        // composite index covers this query.
        const psSnap = await db
          .collection("pa-prescreen-sessions")
          .where("jobId", "==", jobId)
          .where("userId", "==", candidateId)
          .orderBy("updatedAt", "desc")
          .limit(1)
          .get()
          .catch(() => ({ docs: [] as Array<{ id: string }> }))
        const prescreenSessionId = psSnap.docs[0]?.id

        jobs.push({
          jobId,
          jobTitle: meta.title,
          company: meta.company,
          state: parsed.data,
          stateUpdatedAt,
          prescreenSessionId,
          wekruitJobUrl: `https://wekruit.com/j/${jobId}`,
        })
      }

      // If a status filter is present, drop users with zero remaining jobs.
      if (args.status && args.status.length > 0 && jobs.length === 0) return null

      const summary = {
        totalJobs: jobs.length,
        passedJobs: jobs.filter((j) => j.state === "passed").length,
        notPassedJobs: jobs.filter((j) => j.state === "not_passed").length,
        activePrescreens: jobs.filter((j) => ACTIVE_PRESCREEN.has(j.state)).length,
        employerVisibleJobs: jobs.filter((j) => j.state === "employer_visible").length,
      }

      return {
        email: (userData.email as string | undefined) ?? "",
        name: (userData.displayName as string | undefined) ?? undefined,
        wekruitUserId: candidateId,
        registeredAt: toIsoString(userData.createdAt, new Date(0).toISOString()),
        lifecycleState: (userData.lifecycleState as string | undefined) ?? undefined,
        jobs,
        summary,
      } as PartnerUsersUserRow
    }),
  )

  const filteredRows = rows.filter((r): r is PartnerUsersUserRow => r !== null)

  let nextCursor: string | undefined
  if (hasMore && usersDocs.length > 0) {
    const last = usersDocs[usersDocs.length - 1]!
    const lastData = last.data() ?? {}
    nextCursor = encodeCursor({
      createdAt: toIsoString(lastData.createdAt, new Date(0).toISOString()),
      docId: last.id,
    })
  }

  return {
    users: filteredRows,
    nextCursor,
    hasMore,
    generatedAt: new Date().toISOString(),
    partner: partnerSource,
    apiVersion: API_VERSION,
  }
}

export const __test_fetchPartnerUsers = fetchPartnerUsers

// ---------------------------------------------------------------- request

interface ParsedHandlerQuery {
  limit: number
  cursorOpaque?: string
  status?: CandidateJobState[]
  since?: string
}

function parseHandlerQuery(q: Record<string, string | string[] | undefined>): ParsedHandlerQuery {
  const out: ParsedHandlerQuery = { limit: DEFAULT_LIMIT }

  const rawLimit = typeof q.limit === "string" ? q.limit : undefined
  if (rawLimit !== undefined) {
    const n = Number(rawLimit)
    if (!Number.isFinite(n)) throw new Error("invalid_query:limit")
    out.limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)))
  }

  const rawStatus = typeof q.status === "string" ? q.status : undefined
  if (rawStatus) {
    const items = rawStatus
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const validated: CandidateJobState[] = []
    for (const item of items) {
      const parsed = CandidateJobStateSchema.safeParse(item)
      if (!parsed.success) throw new Error("invalid_query:status")
      validated.push(parsed.data)
    }
    out.status = validated
  }

  const rawSince = typeof q.since === "string" ? q.since : undefined
  if (rawSince) {
    const t = Date.parse(rawSince)
    if (!Number.isFinite(t)) throw new Error("invalid_query:since")
    out.since = rawSince
  }

  const rawCursor = typeof q.cursor === "string" ? q.cursor : undefined
  if (rawCursor) {
    // Validate the cursor decodes; reject garbage with 400 (spec §4.5).
    if (decodeCursor(rawCursor) === null) throw new Error("invalid_query:cursor")
    out.cursorOpaque = rawCursor
  }

  return out
}

export const __test_parseHandlerQuery = parseHandlerQuery

// ---------------------------------------------------------------- handler

export const paPartnerUsersApi = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    maxInstances: 10,
    secrets: [PA_PUBLIC_COLLAB_API_KEYS, PA_PUBLIC_COLLAB_ORIGINS],
  },
  async (req, res) => {
    // CORS preflight — partners may call from a browser.
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
    res.setHeader("Access-Control-Max-Age", "3600")
    if (req.method === "OPTIONS") {
      res.status(204).end()
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }

    const apiKey = req.header("x-api-key") ?? undefined
    const origin = req.header("origin") ?? undefined
    const auth = verifyPartnerKey(
      apiKey,
      origin,
      PA_PUBLIC_COLLAB_API_KEYS.value(),
      PA_PUBLIC_COLLAB_ORIGINS.value(),
    )
    if (!auth.ok) {
      const status = auth.reason === "origin_not_allowed" || auth.reason === "key_partner_mismatch" ? 403 : 401
      const fp = apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 8) : "absent"
      console.warn(`paPartnerUsersApi auth_fail reason=${auth.reason} key_fp=${fp} origin=${origin ?? "absent"}`)
      res.status(status).json({ ok: false, reason: auth.reason })
      return
    }

    let parsedQuery: ParsedHandlerQuery
    try {
      parsedQuery = parseHandlerQuery(req.query as Record<string, string | string[] | undefined>)
    } catch (err) {
      // parseHandlerQuery throws Error with messages like "invalid_query:limit" —
      // log the full detail server-side, but return only the top-level reason
      // to the client (per spec §4.7).
      const detail = err instanceof Error ? err.message : "invalid_query"
      console.warn(`paPartnerUsersApi query_fail reason=invalid_query detail=${detail} partner=${auth.partnerSource}`)
      res.status(400).json({ ok: false, reason: "invalid_query" })
      return
    }

    try {
      const t0 = Date.now()
      const response = await fetchPartnerUsers({
        db: getFirestore(),
        partnerSource: auth.partnerSource,
        limit: parsedQuery.limit,
        cursorOpaque: parsedQuery.cursorOpaque,
        status: parsedQuery.status,
        since: parsedQuery.since,
      })
      const ms = Date.now() - t0
      console.info(
        `paPartnerUsersApi ok partner=${auth.partnerSource} users=${response.users.length} hasMore=${response.hasMore} latency_ms=${ms}`,
      )
      res.status(200).json(response)
    } catch (err) {
      const fp = apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 8) : "absent"
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`paPartnerUsersApi internal_error key_fp=${fp} err=${msg}`)
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)
