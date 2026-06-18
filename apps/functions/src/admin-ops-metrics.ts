/**
 * `paAdminOpsMetrics` — admin-only operational time-series for the dashboard
 * "Operations Overview" page.
 *
 * Adam-locked definitions (2026-06-16):
 *  - NEW USERS = distinct new `pa-users` people by `createdAt`, stacked by the
 *    channel they entered through. Each person is counted ONCE (no double
 *    count), so the stacked total = real distinct new people:
 *      • recruiterSubmitted — pa-user carries `recruiterSubmissionTracking`
 *        (created/linked by a recruiter board submission)
 *      • authenticated      — pa-user has a `pa-candidate-auth` mapping
 *        (Firebase Authentication identity)
 *      • direct             — everything else (SMS/iMessage/QR/public job/etc.)
 *    Channel priority recruiterSubmitted > authenticated > direct so each
 *    bucket is disjoint. This is the superset of Adam's "all user auth +
 *    submitted candidates" and also captures direct PA signups.
 *  - INTERVIEWS CONDUCTED = distinct candidates entering the "WeKruit
 *    interview" stage, mirroring the recruiter page. Source = recruiter
 *    submission `statusHistory` entries `wekruit_interview` (legacy `advanced`)
 *    by `atIso`, UNIONed with prescreen sessions that actually ran. Deduped by
 *    candidate per day. Prescreen sessions "share the same status" as recruiter
 *    pipeline candidates per Adam.
 *  - MOVED TO CLIENT = distinct candidates entering the "With client" stage =
 *    recruiter `client_review` entries UNION marketplace candidate-job-states
 *    reaching `employer_visible`/`intro_accepted`. Deduped by candidate per day.
 *
 * The callable returns a DAILY series over the requested lookback range; the
 * dashboard rolls it up to daily/weekly/biweekly/monthly client-side (instant
 * toggle, no refetch). New-user days are mutually exclusive per person so a
 * client-side sum across days stays a correct distinct count.
 *
 * Architecture mirrors `promote-sandbox-tag.ts` / `admin-prescreen-ops.ts`:
 * pure `runAdminOpsMetrics(input, deps)` (deps-injected, unit-testable without
 * firebase-admin) + a thin onCall shim. Auth via the shared
 * `authorizeAdminCallable` (Firebase Auth `admin` claim OR `PA_ADMIN_TOKEN`).
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import {
  PA_COLLECTIONS,
  isSyntheticTestProfile,
  type CandidateListUserDoc,
} from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

// Collections without a PA_COLLECTIONS key (owned by other workspaces).
const RECRUITER_SUBMISSIONS_COLLECTION = "pa-recruiter-submissions"
const PRESCREEN_SESSIONS_COLLECTION = "pa-prescreen-sessions"

const DAY_MS = 86_400_000
// Per-collection scan ceiling. Current collection sizes are well under this;
// a hit flips `truncated` so the UI can warn rather than silently undercount.
const SCAN_CAP = 12_000

// Recruiter submission statuses that mean "candidate had a WeKruit interview".
// Legacy `advanced` rendered as "WeKruit interview" in the dashboard, so it
// counts the same (see RecruiterBoardOps.statusDisplay).
const INTERVIEW_STATUSES = new Set(["wekruit_interview", "advanced"])
// Recruiter status meaning "sent to the client" (the "With client" stage).
const CLIENT_STATUSES = new Set(["client_review"])
// Marketplace candidate-job-states that mean the candidate is in front of the
// employer / client.
const CLIENT_JOB_STATES = new Set(["employer_visible", "intro_accepted"])
// pa-users `source` values that mark non-real (test/synthetic) accounts.
const TEST_USER_SOURCES = new Set(["dev_test", "e2e_run", "qa_run"])
// Operators whose own recruiter submissions are seed/test data — the candidates
// they added are excluded from the counts (unless includeTest).
const EXCLUDED_OPERATOR_EMAILS = new Set(["admin1@wekruit.com"])
// Server-side result cache — the 5-collection scan is heavy, so repeat loads
// read one cached doc instead of re-scanning. 30-min freshness is fine for an
// ops dashboard.
const OPS_METRICS_CACHE_COLLECTION = "pa-ops-metrics-cache"
const OPS_METRICS_CACHE_TTL_MS = 30 * 60_000
// Bump when the computation changes so stale cached results aren't served.
const OPS_METRICS_CACHE_VERSION = "v4"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AdminOpsMetricsInputSchema = z.object({
  /** Lookback window in days (inclusive of today). */
  rangeDays: z.number().int().min(7).max(400).default(120),
  /** Include synthetic/test accounts and test sessions when true. */
  includeTest: z.boolean().optional().default(false),
  /** Admin-token fallback for scripted callers. */
  adminToken: z.string().optional(),
})
export type AdminOpsMetricsInput = z.infer<typeof AdminOpsMetricsInputSchema>

export interface OpsMetricsDayBucket {
  /** UTC midnight of the day, ISO date `YYYY-MM-DD`. */
  date: string
  newUsersTotal: number
  newUsersAuthenticated: number
  newUsersRecruiterSubmitted: number
  newUsersDirect: number
  interviewsConducted: number
  prescreensConducted: number
  movedToClient: number
}

export interface OpsMetricsTotals {
  newUsersTotal: number
  newUsersAuthenticated: number
  newUsersRecruiterSubmitted: number
  newUsersDirect: number
  interviewsConducted: number
  prescreensConducted: number
  movedToClient: number
}

export interface AdminOpsMetricsResult {
  rangeStart: string
  rangeEnd: string
  rangeDays: number
  generatedAt: string
  includeTest: boolean
  days: OpsMetricsDayBucket[]
  totals: OpsMetricsTotals
  truncated: {
    users: boolean
    auth: boolean
    recruiterSubmissions: boolean
    prescreenSessions: boolean
    candidateJobStates: boolean
  }
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Coerce any Firestore timestamp shape (ISO string, epoch ms, Timestamp) to ms. */
export function toMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : 0
  }
  if (value && typeof value === "object") {
    const obj = value as { toDate?: () => Date; seconds?: number; _seconds?: number }
    if (typeof obj.toDate === "function") {
      try {
        const d = obj.toDate()
        if (d instanceof Date && Number.isFinite(d.getTime())) return d.getTime()
      } catch {
        /* fall through */
      }
    }
    if (typeof obj.seconds === "number") return obj.seconds * 1000
    if (typeof obj._seconds === "number") return obj._seconds * 1000
  }
  return 0
}

function startOfUtcDayMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

/** ISO date key `YYYY-MM-DD` for the UTC day containing `ms`. */
export function utcDayKey(ms: number): string {
  return new Date(startOfUtcDayMs(ms)).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Generic windowed scan — ordered desc by `tsField`, in-memory window filter.
// Single read per collection (sizes are modest); `truncated` flags a cap hit.
// ---------------------------------------------------------------------------

interface ScannedDoc {
  id: string
  data: Record<string, unknown>
}

async function scanOrdered(
  db: Firestore,
  collection: string,
  tsField: string,
  fields: readonly string[],
  cap: number = SCAN_CAP,
): Promise<{ docs: ScannedDoc[]; truncated: boolean }> {
  // `.select(...)` only the fields we read — full docs (esp. recruiter
  // statusHistory) blow the function memory budget once the pool grows.
  let q = db.collection(collection).orderBy(tsField, "desc").limit(cap)
  if (fields.length > 0) q = q.select(...fields)
  const snap = await q.get()
  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
  return { docs, truncated: docs.length >= cap }
}

// ---------------------------------------------------------------------------
// Pure handler
// ---------------------------------------------------------------------------

export interface AdminOpsMetricsDeps {
  db: Firestore
  /** Injectable clock (ms epoch) for deterministic tests. */
  now?: () => number
}

interface StatusHistoryItem {
  status?: unknown
  atIso?: unknown
  at?: unknown
}

function statusHistoryOf(data: Record<string, unknown>): StatusHistoryItem[] {
  const raw = data.statusHistory
  return Array.isArray(raw) ? (raw as StatusHistoryItem[]) : []
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true"
}

export async function runAdminOpsMetrics(
  input: AdminOpsMetricsInput,
  deps: AdminOpsMetricsDeps,
): Promise<AdminOpsMetricsResult> {
  const nowMs = deps.now ? deps.now() : Date.now()
  const rangeEndMs = nowMs
  // Window starts at UTC midnight `rangeDays-1` days ago so today is included.
  const rangeStartMs = startOfUtcDayMs(nowMs) - (input.rangeDays - 1) * DAY_MS
  const inWindow = (ms: number): boolean => ms >= rangeStartMs && ms <= rangeEndMs

  // Per-day accumulators. Interview / client metrics dedup by candidate per day.
  const newUsers = new Map<
    string,
    { auth: number; recruiter: number; direct: number }
  >()
  const conducted = new Map<string, Set<string>>()
  const prescreens = new Map<string, Set<string>>()
  const movedToClient = new Map<string, Set<string>>()

  const ensureUserDay = (key: string) => {
    let v = newUsers.get(key)
    if (!v) {
      v = { auth: 0, recruiter: 0, direct: 0 }
      newUsers.set(key, v)
    }
    return v
  }
  const addConducted = (key: string, candidateId: string) => {
    let s = conducted.get(key)
    if (!s) {
      s = new Set()
      conducted.set(key, s)
    }
    s.add(candidateId)
  }
  const addPrescreen = (key: string, candidateId: string) => {
    let s = prescreens.get(key)
    if (!s) {
      s = new Set()
      prescreens.set(key, s)
    }
    s.add(candidateId)
  }
  const addClient = (key: string, candidateId: string) => {
    let s = movedToClient.get(key)
    if (!s) {
      s = new Set()
      movedToClient.set(key, s)
    }
    s.add(candidateId)
  }

  // --- Load all sources (parallel) ---------------------------------------
  const [usersScan, authScan, submissionsScan, prescreenScan, statesScan] = await Promise.all([
    scanOrdered(deps.db, PA_COLLECTIONS.users, "createdAt", [
      "createdAt",
      "source",
      "signupSource",
      "recruiterSubmissionTracking",
      "testMode",
      "phoneE164",
      "email",
    ]),
    scanOrdered(deps.db, PA_COLLECTIONS.candidateAuth, "createdAt", ["createdAt", "candidateId"]),
    scanOrdered(deps.db, RECRUITER_SUBMISSIONS_COLLECTION, "updatedAt", [
      "updatedAt",
      "statusHistory",
      "candidateId",
      "candidateUserId",
      "testMode",
      "isDemo",
      "recruiterEmail",
      "submitter",
    ]),
    scanOrdered(deps.db, PRESCREEN_SESSIONS_COLLECTION, "createdAt", [
      "createdAt",
      "userId",
      "terminal",
      "workSession",
      "testMode",
      "isDemo",
    ]),
    scanOrdered(deps.db, PA_COLLECTIONS.candidateJobStates, "stateUpdatedAt", [
      "stateUpdatedAt",
      "state",
      "candidateId",
    ]),
  ])

  // authSet — every candidateId that has a Firebase Auth mapping (any time).
  const authSet = new Set<string>()
  for (const doc of authScan.docs) {
    const cid = typeof doc.data.candidateId === "string" ? doc.data.candidateId : undefined
    if (cid) authSet.add(cid)
  }

  // Candidates ADDED BY an excluded operator (admin1's own recruiter submissions
  // are test/seed data) — dropped from every metric unless includeTest. Adam
  // 2026-06-17: "don't count candidates added by admin1@wekruit.com".
  const excludedCandidateIds = new Set<string>()
  if (!input.includeTest) {
    for (const { data } of submissionsScan.docs) {
      const sub =
        data.submitter && typeof data.submitter === "object" ? (data.submitter as { email?: unknown }) : undefined
      const rawEmail =
        typeof data.recruiterEmail === "string"
          ? data.recruiterEmail
          : typeof sub?.email === "string"
            ? sub.email
            : ""
      if (!EXCLUDED_OPERATOR_EMAILS.has(rawEmail.toLowerCase())) continue
      const cid =
        (typeof data.candidateId === "string" && data.candidateId) ||
        (typeof data.candidateUserId === "string" && data.candidateUserId) ||
        ""
      if (cid) excludedCandidateIds.add(cid)
    }
  }

  // --- New users (channel attribution, dedup by person) -------------------
  for (const { id, data } of usersScan.docs) {
    if (excludedCandidateIds.has(id)) continue
    const createdMs = toMs(data.createdAt)
    if (!createdMs || !inWindow(createdMs)) continue
    if (!input.includeTest) {
      const source = typeof data.source === "string" ? data.source : undefined
      if (source && TEST_USER_SOURCES.has(source)) continue
      // Admin-created candidates (bulk adds via the admin identity path) are
      // not organic signups — drop them. Adam 2026-06-17 (the "Direct" flood).
      if (data.signupSource === "identity:admin") continue
      // `isSyntheticTestProfile` reads `doc.id` — ensure it's set from the doc
      // key when the stored data omits it, so the call can't throw.
      if (isSyntheticTestProfile({ ...data, id } as unknown as CandidateListUserDoc)) continue
    }
    const key = utcDayKey(createdMs)
    const bucket = ensureUserDay(key)
    if (data.recruiterSubmissionTracking != null) bucket.recruiter += 1
    else if (authSet.has(id)) bucket.auth += 1
    else bucket.direct += 1
  }

  // --- Interviews conducted + moved to client (recruiter pipeline) --------
  for (const { id, data } of submissionsScan.docs) {
    if (!input.includeTest && (isTruthyFlag(data.testMode) || isTruthyFlag(data.isDemo))) continue
    const candidateId =
      (typeof data.candidateId === "string" && data.candidateId) ||
      (typeof data.candidateUserId === "string" && data.candidateUserId) ||
      `submission:${id}`
    if (excludedCandidateIds.has(candidateId)) continue
    for (const entry of statusHistoryOf(data)) {
      const status = typeof entry.status === "string" ? entry.status : ""
      if (!status) continue
      const atMs = toMs(entry.atIso ?? entry.at)
      if (!atMs || !inWindow(atMs)) continue
      const key = utcDayKey(atMs)
      if (INTERVIEW_STATUSES.has(status)) addConducted(key, candidateId)
      if (CLIENT_STATUSES.has(status)) addClient(key, candidateId)
    }
  }

  // --- Prescreens conducted (SEPARATE from interviews) --------------------
  // Adam 2026-06-17: prescreen is NOT an interview, but we track it as its own
  // count (Claire AI screens that actually ran), deduped by candidate per day.
  for (const { data } of prescreenScan.docs) {
    if (!input.includeTest && (isTruthyFlag(data.testMode) || isTruthyFlag(data.isDemo))) continue
    const userId = typeof data.userId === "string" ? data.userId : undefined
    if (!userId || excludedCandidateIds.has(userId)) continue
    const workSession =
      data.workSession && typeof data.workSession === "object"
        ? (data.workSession as Record<string, unknown>)
        : undefined
    const startedAt = workSession?.startedAt
    const ran = data.terminal != null || startedAt != null
    if (!ran) continue
    const tsMs = toMs(startedAt ?? data.createdAt)
    if (!tsMs || !inWindow(tsMs)) continue
    addPrescreen(utcDayKey(tsMs), userId)
  }

  // --- Moved to client (marketplace candidate-job-states) -----------------
  for (const { data } of statesScan.docs) {
    const state = typeof data.state === "string" ? data.state : ""
    if (!CLIENT_JOB_STATES.has(state)) continue
    const candidateId = typeof data.candidateId === "string" ? data.candidateId : undefined
    if (!candidateId || excludedCandidateIds.has(candidateId)) continue
    const atMs = toMs(data.stateUpdatedAt)
    if (!atMs || !inWindow(atMs)) continue
    addClient(utcDayKey(atMs), candidateId)
  }

  // --- Emit a continuous daily series (fill zeros) ------------------------
  const days: OpsMetricsDayBucket[] = []
  const totals: OpsMetricsTotals = {
    newUsersTotal: 0,
    newUsersAuthenticated: 0,
    newUsersRecruiterSubmitted: 0,
    newUsersDirect: 0,
    interviewsConducted: 0,
    prescreensConducted: 0,
    movedToClient: 0,
  }
  const firstDayMs = rangeStartMs
  const lastDayMs = startOfUtcDayMs(rangeEndMs)
  for (let ms = firstDayMs; ms <= lastDayMs; ms += DAY_MS) {
    const key = utcDayKey(ms)
    const nu = newUsers.get(key)
    const auth = nu?.auth ?? 0
    const recruiter = nu?.recruiter ?? 0
    const direct = nu?.direct ?? 0
    const total = auth + recruiter + direct
    const interviews = conducted.get(key)?.size ?? 0
    const prescreensCount = prescreens.get(key)?.size ?? 0
    const client = movedToClient.get(key)?.size ?? 0
    days.push({
      date: key,
      newUsersTotal: total,
      newUsersAuthenticated: auth,
      newUsersRecruiterSubmitted: recruiter,
      newUsersDirect: direct,
      interviewsConducted: interviews,
      prescreensConducted: prescreensCount,
      movedToClient: client,
    })
    totals.newUsersTotal += total
    totals.newUsersAuthenticated += auth
    totals.newUsersRecruiterSubmitted += recruiter
    totals.newUsersDirect += direct
    totals.interviewsConducted += interviews
    totals.prescreensConducted += prescreensCount
    totals.movedToClient += client
  }

  return {
    rangeStart: new Date(rangeStartMs).toISOString(),
    rangeEnd: new Date(rangeEndMs).toISOString(),
    rangeDays: input.rangeDays,
    generatedAt: new Date(nowMs).toISOString(),
    includeTest: input.includeTest,
    days,
    totals,
    truncated: {
      users: usersScan.truncated,
      auth: authScan.truncated,
      recruiterSubmissions: submissionsScan.truncated,
      prescreenSessions: prescreenScan.truncated,
      candidateJobStates: statesScan.truncated,
    },
  }
}

// ---------------------------------------------------------------------------
// Production CF — thin shim.
// ---------------------------------------------------------------------------

export const paAdminOpsMetrics = onCall(
  {
    region: "us-central1",
    // Scans 5 collections (pool grows) — 512MiB OOM'd at ~2.6k recruiter
    // submissions. .select() trims the footprint; 1GiB gives ample headroom.
    memory: "1GiB",
    timeoutSeconds: 120,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<AdminOpsMetricsResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminOpsMetricsInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }
    const db = getFirestore()
    const input = parsed.data
    const cacheRef = db
      .collection(OPS_METRICS_CACHE_COLLECTION)
      .doc(`${OPS_METRICS_CACHE_VERSION}_r${input.rangeDays}_t${input.includeTest ? 1 : 0}`)
    // Serve a fresh cached result (the 5-collection scan is heavy) — repeat
    // loads are a single doc read. Recompute past the TTL.
    try {
      const snap = await cacheRef.get()
      const cached = snap.exists ? (snap.data() as { cachedAtMs?: number; result?: AdminOpsMetricsResult }) : undefined
      if (cached?.result && typeof cached.cachedAtMs === "number" && Date.now() - cached.cachedAtMs < OPS_METRICS_CACHE_TTL_MS) {
        return cached.result
      }
    } catch {
      /* cache read failure → recompute */
    }
    try {
      const result = await runAdminOpsMetrics(input, { db })
      void cacheRef.set({ cachedAtMs: Date.now(), result }).catch(() => {})
      return result
    } catch (err) {
      logger.error("[admin-ops-metrics] failed", err)
      throw new HttpsError("internal", "ops metrics aggregation failed")
    }
  },
)
