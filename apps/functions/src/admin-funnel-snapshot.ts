/**
 * `paAdminFunnelSnapshot` + `paAdminPassedNotVisibleList` — admin-only
 * point-in-time funnel over the marketplace `pa-candidate-job-states` ladder.
 *
 * Why this exists: prod has ~733 prescreens but ~0 employer-visible profiles.
 * The reducer (packages/core-types/src/marketplace.ts reduceCandidateJobState)
 * does NOT let PASS jump `prescreen_started → passed`: it requires
 * `prescreen_started → prescreen_review_pending → passed`, and
 * `passed → employer_visible` requires a separately-written employer snapshot.
 * So most (candidate × job) docs are stuck mid-spine and the (prescreens
 * conducted) → (employer_visible) gap is the measurable leak. This CF
 * group-counts every state on the ordered ladder so the gap is visible, plus
 * the orthogonal interview sub-track (`interviewState`) so "interviews actually
 * booked/completed" surfaces separately from the pass/fail spine.
 *
 * `paAdminPassedNotVisibleList` lists the stuck PASSED population — state docs
 * in a passed-tier state (`passed`/`prescreen_passed`-aliased) that have NO
 * employer-visible snapshot (no `employerVisibleProfileId` and no
 * `pa-employer-visible-profiles/{jobId}__{candidateId}` doc).
 *
 * Architecture mirrors `admin-ops-metrics.ts`: pure deps-injected handlers
 * (`runAdminFunnelSnapshot` / `runAdminPassedNotVisibleList`, unit-testable
 * without firebase-admin) + thin onCall shims. Auth via the shared
 * `authorizeAdminCallable` (Firebase Auth `admin` claim OR `PA_ADMIN_TOKEN`).
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import {
  PA_COLLECTIONS,
  createEmployerVisibleProfileId,
  isSyntheticTestProfile,
  isInternalOperatorProfile,
  isDemoPreviewProfile,
  type CandidateListUserDoc,
} from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

// Per-collection scan ceiling. Current pool is well under this; a hit flips
// `truncated` so the UI warns rather than silently undercounting. The whole
// `pa-candidate-job-states` collection fits in one .select() scan at 1GiB.
const SCAN_CAP = 20_000

// Ordered funnel spine (recon stateLadder). These are counted in this order;
// the off-spine states are tallied separately so the spine sums cleanly.
export const FUNNEL_LADDER = [
  "candidate_matched",
  "outbound_queued",
  "outbound_sent",
  "candidate_interested",
  "prescreen_started",
  "prescreen_review_pending",
  "passed",
  "employer_visible",
  "intro_accepted",
] as const
export type FunnelLadderState = (typeof FUNNEL_LADDER)[number]

// Off-ladder / terminal-aside states (counted, but not part of the spine flow).
export const OFF_LADDER_STATES = ["not_passed", "intro_rejected", "paused", "archived"] as const
export type OffLadderState = (typeof OFF_LADDER_STATES)[number]

// Orthogonal interview-booking sub-track (recon: persisted on
// CandidateJobStateDoc.interviewState; NEVER changes `state`).
export const INTERVIEW_TRACK_STATES = [
  "interview_offered",
  "interview_booked",
  "interview_completed",
  "interview_no_show",
] as const
export type InterviewTrackTally = (typeof INTERVIEW_TRACK_STATES)[number]

// Passed-tier states for the "passed but not employer-visible" leak detector.
// `prescreen_passed` is accepted as a defensive alias in case any legacy doc
// carries it (the canonical enum is `passed`); both mean "PASS recorded".
const PASSED_TIER_STATES = new Set(["passed", "prescreen_passed"])

// pa-users `source` values that mark non-real (test/synthetic) accounts.
const TEST_USER_SOURCES = new Set(["dev_test", "e2e_run", "qa_run"])
// Dev/test phones with standing send authorization (Adam + Noah).
const DEV_TEST_PHONES = new Set(["+14243201960", "+12154034668"])

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const AdminFunnelSnapshotInputSchema = z.object({
  /** Include synthetic/test/internal candidate accounts when true. */
  includeTest: z.boolean().optional().default(false),
  /** Admin-token fallback for scripted callers. */
  adminToken: z.string().optional(),
})
export type AdminFunnelSnapshotInput = z.infer<typeof AdminFunnelSnapshotInputSchema>

export interface FunnelStageRow {
  state: FunnelLadderState
  count: number
  /** Percent of the previous (upstream) ladder stage, 0–100, or null at the top. */
  pctOfPrev: number | null
  /** Percent of the top ladder stage (`candidate_matched`), 0–100, or null if top is 0. */
  pctOfTop: number | null
}

export interface AdminFunnelSnapshotResult {
  generatedAt: string
  includeTest: boolean
  /** Total (candidate × job) state docs counted (after test exclusion). */
  total: number
  stages: FunnelStageRow[]
  offLadder: Record<OffLadderState, number>
  interview: Record<InterviewTrackTally, number>
  /** Stuck-PASS leak: passed-tier docs with no employer-visible snapshot. */
  passedNotVisible: number
  /** True if the state scan hit the cap (counts may undercount). */
  truncated: boolean
}

export const AdminPassedNotVisibleInputSchema = z.object({
  includeTest: z.boolean().optional().default(false),
  /** Max rows returned (the count is exact; rows are a bounded sample). */
  limit: z.number().int().min(1).max(2_000).optional().default(500),
  adminToken: z.string().optional(),
})
export type AdminPassedNotVisibleInput = z.infer<typeof AdminPassedNotVisibleInputSchema>

export interface PassedNotVisibleRow {
  userId: string
  jobId: string
  state: string
  prescreenSessionId?: string
  passedAt: string
}

export interface AdminPassedNotVisibleResult {
  generatedAt: string
  includeTest: boolean
  /** Exact count of stuck passed-tier docs with no snapshot. */
  total: number
  /** Bounded sample of the stuck population (≤ `limit`). */
  rows: PassedNotVisibleRow[]
  /** True if the state scan hit the cap. */
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce any Firestore timestamp shape (ISO, epoch ms, Timestamp) to ISO. */
export function toIso(value: unknown): string {
  if (typeof value === "string" && value) return value
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString()
  if (value && typeof value === "object") {
    const obj = value as { toDate?: () => Date; seconds?: number; _seconds?: number }
    if (typeof obj.toDate === "function") {
      try {
        const d = obj.toDate()
        if (d instanceof Date && Number.isFinite(d.getTime())) return d.toISOString()
      } catch {
        /* fall through */
      }
    }
    if (typeof obj.seconds === "number") return new Date(obj.seconds * 1000).toISOString()
    if (typeof obj._seconds === "number") return new Date(obj._seconds * 1000).toISOString()
  }
  return ""
}

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
  let q = db.collection(collection).orderBy(tsField, "desc").limit(cap)
  if (fields.length > 0) q = q.select(...fields)
  const snap = await q.get()
  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
  return { docs, truncated: docs.length >= cap }
}

/** Scan the users collection once → set of test/internal candidate ids to drop. */
async function loadExcludedUserIds(db: Firestore): Promise<{ ids: Set<string>; truncated: boolean }> {
  const scan = await scanOrdered(db, PA_COLLECTIONS.users, "createdAt", [
    "createdAt",
    "source",
    "testMode",
    "isDemo",
    "demoSourcePool",
    "phoneE164",
    "email",
  ])
  const ids = new Set<string>()
  for (const { id, data } of scan.docs) {
    if (isTestOrInternalUser(id, data)) ids.add(id)
  }
  return { ids, truncated: scan.truncated }
}

/**
 * A pa-user that should never count toward the funnel: synthetic/QA,
 * demo/preview, internal operator (@wekruit.com), an explicit test `source`, or
 * a dev/test phone (Adam/Noah). State docs carry NO test flag, so exclusion is
 * resolved from the candidate (user) side — same approach as admin-ops-metrics.
 */
export function isTestOrInternalUser(id: string, data: Record<string, unknown>): boolean {
  const doc = { ...data, id } as unknown as CandidateListUserDoc
  if (isSyntheticTestProfile(doc) || isInternalOperatorProfile(doc) || isDemoPreviewProfile(doc)) {
    return true
  }
  const source = typeof data.source === "string" ? data.source : ""
  if (TEST_USER_SOURCES.has(source)) return true
  const phone = typeof data.phoneE164 === "string" ? data.phoneE164 : ""
  return DEV_TEST_PHONES.has(phone)
}

function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null
  return Math.round((part / whole) * 1000) / 10
}

// ---------------------------------------------------------------------------
// Pure handler — funnel snapshot
// ---------------------------------------------------------------------------

export interface AdminFunnelDeps {
  db: Firestore
  now?: () => number
}

export async function runAdminFunnelSnapshot(
  input: AdminFunnelSnapshotInput,
  deps: AdminFunnelDeps,
): Promise<AdminFunnelSnapshotResult> {
  const nowMs = deps.now ? deps.now() : Date.now()

  // Exclude test/internal candidates (resolved from the users scan) unless
  // includeTest. The state docs carry no test flag, so the USER profile is the
  // only reliable signal — mirror admin-ops-metrics.
  const excluded = input.includeTest
    ? { ids: new Set<string>(), truncated: false }
    : await loadExcludedUserIds(deps.db)

  const statesScan = await scanOrdered(deps.db, PA_COLLECTIONS.candidateJobStates, "stateUpdatedAt", [
    "stateUpdatedAt",
    "state",
    "candidateId",
    "jobId",
    "employerVisibleProfileId",
    // interviewState is read below for the interview sub-track tally; Firestore
    // .select() returns ONLY projected fields, so it MUST be listed or the tally
    // is silently always 0.
    "interviewState",
  ])

  const ladderCounts = new Map<string, number>()
  const offCounts = new Map<string, number>()
  const interviewCounts = new Map<string, number>()
  const ladderSet = new Set<string>(FUNNEL_LADDER)
  const offSet = new Set<string>(OFF_LADDER_STATES)
  const interviewSet = new Set<string>(INTERVIEW_TRACK_STATES)

  let total = 0
  let passedNotVisible = 0

  for (const { data } of statesScan.docs) {
    const candidateId = typeof data.candidateId === "string" ? data.candidateId : ""
    if (!candidateId) continue
    if (!input.includeTest && excluded.ids.has(candidateId)) continue

    const state = typeof data.state === "string" ? data.state : ""
    if (!state) continue
    total += 1

    if (ladderSet.has(state)) ladderCounts.set(state, (ladderCounts.get(state) ?? 0) + 1)
    else if (offSet.has(state)) offCounts.set(state, (offCounts.get(state) ?? 0) + 1)

    // interviewState is orthogonal — tally separately from `state`.
    const interviewState = typeof data.interviewState === "string" ? data.interviewState : ""
    if (interviewState && interviewSet.has(interviewState)) {
      interviewCounts.set(interviewState, (interviewCounts.get(interviewState) ?? 0) + 1)
    }

    // Passed-tier with no snapshot id = stuck PASS (the leak). Cheap signal:
    // employerVisibleProfileId unset. (The detail list CF additionally probes
    // the snapshot collection; here we use the in-doc signal for the count.)
    if (PASSED_TIER_STATES.has(state)) {
      const profId = typeof data.employerVisibleProfileId === "string" ? data.employerVisibleProfileId : ""
      if (!profId) passedNotVisible += 1
    }
  }

  // Build ordered stage rows with conversion %.
  const topCount = ladderCounts.get(FUNNEL_LADDER[0]) ?? 0
  const stages: FunnelStageRow[] = FUNNEL_LADDER.map((state, idx) => {
    const count = ladderCounts.get(state) ?? 0
    const prevCount = idx === 0 ? null : (ladderCounts.get(FUNNEL_LADDER[idx - 1]) ?? 0)
    return {
      state,
      count,
      pctOfPrev: prevCount === null ? null : pct(count, prevCount),
      pctOfTop: idx === 0 ? null : pct(count, topCount),
    }
  })

  const offLadder = Object.fromEntries(
    OFF_LADDER_STATES.map((s) => [s, offCounts.get(s) ?? 0]),
  ) as Record<OffLadderState, number>
  const interview = Object.fromEntries(
    INTERVIEW_TRACK_STATES.map((s) => [s, interviewCounts.get(s) ?? 0]),
  ) as Record<InterviewTrackTally, number>

  return {
    generatedAt: new Date(nowMs).toISOString(),
    includeTest: input.includeTest,
    total,
    stages,
    offLadder,
    interview,
    passedNotVisible,
    truncated: statesScan.truncated || excluded.truncated,
  }
}

// ---------------------------------------------------------------------------
// Pure handler — passed-but-not-visible list
// ---------------------------------------------------------------------------

export async function runAdminPassedNotVisibleList(
  input: AdminPassedNotVisibleInput,
  deps: AdminFunnelDeps,
): Promise<AdminPassedNotVisibleResult> {
  const nowMs = deps.now ? deps.now() : Date.now()

  const excluded = input.includeTest
    ? { ids: new Set<string>(), truncated: false }
    : await loadExcludedUserIds(deps.db)

  const statesScan = await scanOrdered(deps.db, PA_COLLECTIONS.candidateJobStates, "stateUpdatedAt", [
    "stateUpdatedAt",
    "state",
    "candidateId",
    "jobId",
    "employerVisibleProfileId",
    "prescreenSessionId",
  ])

  // First pass: collect passed-tier docs whose in-doc snapshot id is unset.
  // Then confirm against the snapshot collection (a doc may have a snapshot
  // that the state-transition step never recorded back onto the state doc).
  const candidates: Array<{
    userId: string
    jobId: string
    state: string
    prescreenSessionId?: string
    passedAt: string
  }> = []
  for (const { data } of statesScan.docs) {
    const state = typeof data.state === "string" ? data.state : ""
    if (!PASSED_TIER_STATES.has(state)) continue
    const userId = typeof data.candidateId === "string" ? data.candidateId : ""
    const jobId = typeof data.jobId === "string" ? data.jobId : ""
    if (!userId || !jobId) continue
    if (!input.includeTest && excluded.ids.has(userId)) continue
    const profId = typeof data.employerVisibleProfileId === "string" ? data.employerVisibleProfileId : ""
    if (profId) continue // already advanced/recorded → not stuck
    candidates.push({
      userId,
      jobId,
      state,
      ...(typeof data.prescreenSessionId === "string" && data.prescreenSessionId
        ? { prescreenSessionId: data.prescreenSessionId }
        : {}),
      passedAt: toIso(data.stateUpdatedAt),
    })
  }

  // Confirm absence of the snapshot doc for each (jobId, userId). A snapshot
  // existing despite an unset in-doc id means the transition half-completed —
  // still surfaces as a leak (the state never advanced to employer_visible),
  // but we DON'T count it here because the snapshot exists; we only keep docs
  // with genuinely no snapshot so the row population is the true stuck set.
  const confirmed: PassedNotVisibleRow[] = []
  for (const c of candidates) {
    const snapId = createEmployerVisibleProfileId(c.jobId, c.userId)
    let hasSnapshot = false
    try {
      const snap = await deps.db.collection(PA_COLLECTIONS.employerVisibleProfiles).doc(snapId).get()
      hasSnapshot = snap.exists
    } catch {
      hasSnapshot = false // probe failure → treat as stuck (surface for review)
    }
    if (hasSnapshot) continue
    confirmed.push({
      userId: c.userId,
      jobId: c.jobId,
      state: c.state,
      ...(c.prescreenSessionId ? { prescreenSessionId: c.prescreenSessionId } : {}),
      passedAt: c.passedAt,
    })
  }

  confirmed.sort((a, b) => b.passedAt.localeCompare(a.passedAt))
  const rows = confirmed.slice(0, input.limit)

  return {
    generatedAt: new Date(nowMs).toISOString(),
    includeTest: input.includeTest,
    total: confirmed.length,
    rows,
    truncated: statesScan.truncated || excluded.truncated,
  }
}

// ---------------------------------------------------------------------------
// Production CFs — thin shims.
// ---------------------------------------------------------------------------

export const paAdminFunnelSnapshot = onCall(
  {
    region: "us-central1",
    // Single-collection scan (+ a users scan for test exclusion) — 1GiB gives
    // ample headroom as the pool grows, mirroring admin-ops-metrics.
    memory: "1GiB",
    timeoutSeconds: 120,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<AdminFunnelSnapshotResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminFunnelSnapshotInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    try {
      return await runAdminFunnelSnapshot(parsed.data, { db: getFirestore() })
    } catch (err) {
      logger.error("[admin-funnel-snapshot] failed", err)
      throw new HttpsError("internal", "funnel snapshot aggregation failed")
    }
  },
)

export const paAdminPassedNotVisibleList = onCall(
  {
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 120,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<AdminPassedNotVisibleResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminPassedNotVisibleInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    try {
      return await runAdminPassedNotVisibleList(parsed.data, { db: getFirestore() })
    } catch (err) {
      logger.error("[admin-passed-not-visible] failed", err)
      throw new HttpsError("internal", "passed-not-visible aggregation failed")
    }
  },
)
