/**
 * `paAdminInterviewBookingsList` — admin-only list of EVERY interview booking
 * for the dashboard "/admin/interviews" table, and `paAdminInterviewOutcome` —
 * the per-row operator outcome-stamp action (completed / no_show / cancelled).
 *
 * Why: until now the only window onto pa-interview-bookings was the per-candidate
 * `get_scheduling_status` MCP tool (Slack) and the candidate /me surface. Ops had
 * no all-bookings table and no way to stamp an interview outcome. This adds both.
 *
 * Architecture mirrors admin-recruiter-submissions-list.ts (trimmed-projection
 * list) + admin-recruiter-submission-action.ts (admin-gated onCall mutation):
 *  - pure deps-injected runners + thin admin-gated onCall wrappers
 *  - `authorizeAdminCallable` (req.auth.token.admin) gate, PA_ADMIN_TOKEN secret
 *  - the list reuses the canonical `runSchedulingStatus` per-row projection shape
 *    so Slack + dashboard + /me stay consistent
 *  - the outcome action writes the booking doc status (InterviewBookingStatus)
 *    AND emits the parallel candidate×job FSM event (interview_completed /
 *    interview_no_show) via commitCandidateJobEvent — fail-open, idempotent.
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { PA_COLLECTIONS, type CandidateJobEvent } from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"
import { commitCandidateJobEvent } from "./claire-agent/reducers/candidate-job-state.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const BOOKINGS_COLLECTION = PA_COLLECTIONS.interviewBookings // "pa-interview-bookings"
const STATES_COLLECTION = PA_COLLECTIONS.candidateJobStates // "pa-candidate-job-states"
const JOBS_COLLECTION = PA_COLLECTIONS.jobs // "pa-jobs"
const USERS_COLLECTION = PA_COLLECTIONS.users // "pa-users"

// Generous vs. expected booking volume; a hit flips `truncated` so the UI warns.
const SCAN_CAP = 5_000

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function createCandidateJobStateId(candidateId: string, jobId: string): string {
  return `${candidateId}__${jobId}`
}

/** A booking → the canonical per-row projection (mirrors runSchedulingStatus). */
export interface AdminInterviewBookingRow {
  bookingId: string
  userId?: string
  candidateName?: string
  candidateEmail?: string
  jobId?: string
  jobTitle?: string
  companyName?: string
  status?: string
  timeZone?: string
  offeredCount: number
  selectedSlotIso?: string
  /** Best display timestamp for the booked/offered slot. */
  when?: string
  meetingUrl?: string
  calBookingUid?: string
  source?: string
  confirmationEmailSentAt?: string
  outcomeAt?: string
  outcomeNote?: string
  lastError?: string
  /** Main-ladder candidate×job FSM state (best-effort join). */
  fsmState?: string
  updatedAt?: string
}

export interface AdminInterviewBookingsListResult {
  rows: AdminInterviewBookingRow[]
  total: number
  truncated: boolean
  generatedAt: string
}

export interface AdminInterviewBookingsListDeps {
  db: Firestore
}

export const AdminInterviewBookingsListInputSchema = z.object({
  adminToken: z.string().nullish(),
})
export type AdminInterviewBookingsListInput = z.infer<typeof AdminInterviewBookingsListInputSchema>

export async function runAdminInterviewBookingsList(
  deps: AdminInterviewBookingsListDeps,
): Promise<AdminInterviewBookingsListResult> {
  // Plain limit, NO orderBy — orderBy would drop docs missing the sort field;
  // we want every booking and let the client sort.
  const snap = await deps.db.collection(BOOKINGS_COLLECTION).limit(SCAN_CAP).get()

  // Best-effort joins: candidate names (pa-users), job title/company (pa-jobs),
  // and the candidate×job main-ladder FSM state (pa-candidate-job-states). All
  // batched by id via getAll so the table renders human-readable labels.
  const userIds = new Set<string>()
  const jobIds = new Set<string>()
  const stateIds = new Set<string>()
  for (const d of snap.docs) {
    const b = d.data() as Record<string, unknown>
    const userId = str(b.userId)
    const jobId = str(b.jobId)
    if (userId) userIds.add(userId)
    if (jobId) jobIds.add(jobId)
    if (userId && jobId) stateIds.add(createCandidateJobStateId(userId, jobId))
  }

  const getAllByIds = async (collection: string, ids: string[]) => {
    if (ids.length === 0) return new Map<string, Record<string, unknown>>()
    const refs = ids.map((id) => deps.db.collection(collection).doc(id))
    const docs = await deps.db.getAll(...refs)
    const out = new Map<string, Record<string, unknown>>()
    for (const doc of docs) {
      if (doc.exists) out.set(doc.id, doc.data() as Record<string, unknown>)
    }
    return out
  }

  const [usersById, jobsById, statesById] = await Promise.all([
    getAllByIds(USERS_COLLECTION, [...userIds]),
    getAllByIds(JOBS_COLLECTION, [...jobIds]),
    getAllByIds(STATES_COLLECTION, [...stateIds]),
  ])

  const rows: AdminInterviewBookingRow[] = snap.docs.map((d) => {
    const b = d.data() as Record<string, unknown>
    const userId = str(b.userId)
    const jobId = str(b.jobId)
    const user = userId ? usersById.get(userId) : undefined
    const job = jobId ? jobsById.get(jobId) : undefined
    const state = userId && jobId ? statesById.get(createCandidateJobStateId(userId, jobId)) : undefined
    const offeredSlots = Array.isArray(b.offeredSlots) ? b.offeredSlots : []
    const selectedSlotIso = str(b.selectedSlotIso)
    const firstOfferedIso =
      offeredSlots.length > 0 && offeredSlots[0] && typeof offeredSlots[0] === "object"
        ? str((offeredSlots[0] as Record<string, unknown>).iso)
        : undefined
    return {
      bookingId: d.id,
      ...(userId ? { userId } : {}),
      ...(user
        ? {
            ...(str(user.name) || str(user.fullName)
              ? { candidateName: str(user.name) ?? str(user.fullName) }
              : {}),
            ...(str(user.email) ? { candidateEmail: str(user.email) } : {}),
          }
        : {}),
      ...(jobId ? { jobId } : {}),
      ...(job
        ? {
            ...(str(job.title) || str(job.jobTitle) || str(job.roleTitle)
              ? { jobTitle: str(job.title) ?? str(job.jobTitle) ?? str(job.roleTitle) }
              : {}),
            ...(str(job.companyName) || str(job.company) || str(job.companyDisplayName)
              ? { companyName: str(job.companyName) ?? str(job.company) ?? str(job.companyDisplayName) }
              : {}),
          }
        : {}),
      ...(str(b.status) ? { status: str(b.status) } : {}),
      ...(str(b.timeZone) ? { timeZone: str(b.timeZone) } : {}),
      offeredCount: offeredSlots.length,
      ...(selectedSlotIso ? { selectedSlotIso } : {}),
      ...(selectedSlotIso ?? firstOfferedIso ? { when: selectedSlotIso ?? firstOfferedIso } : {}),
      ...(str(b.meetingUrl) ? { meetingUrl: str(b.meetingUrl) } : {}),
      ...(str(b.calBookingUid) ? { calBookingUid: str(b.calBookingUid) } : {}),
      ...(str(b.source) ? { source: str(b.source) } : {}),
      ...(str(b.confirmationEmailSentAt) ? { confirmationEmailSentAt: str(b.confirmationEmailSentAt) } : {}),
      ...(str(b.outcomeAt) ? { outcomeAt: str(b.outcomeAt) } : {}),
      ...(str(b.outcomeNote) ? { outcomeNote: str(b.outcomeNote) } : {}),
      ...(str(b.lastError) ? { lastError: str(b.lastError) } : {}),
      ...(state && str(state.state) ? { fsmState: str(state.state) } : {}),
      ...(str(b.updatedAt) ? { updatedAt: str(b.updatedAt) } : {}),
    }
  })

  return {
    rows,
    total: rows.length,
    truncated: rows.length >= SCAN_CAP,
    generatedAt: new Date().toISOString(),
  }
}

export const paAdminInterviewBookingsList = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req): Promise<AdminInterviewBookingsListResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminInterviewBookingsListInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }
    try {
      return await runAdminInterviewBookingsList({ db: getFirestore() })
    } catch (err) {
      logger.error("[admin-interview-bookings-list] failed", err)
      throw new HttpsError("internal", "interview bookings list failed")
    }
  },
)

// ───────────────────────── outcome-stamp action ─────────────────────────

/**
 * Maps the operator outcome to (1) the booking-doc InterviewBookingStatus and
 * (2) the parallel candidate×job FSM event type. `cancelled` has no FSM event
 * (it's a status-only annotation — there is no `interview_cancelled` in the
 * marketplace event union), so only the booking status is written.
 */
const OUTCOME_TO_BOOKING_STATUS = {
  completed: "completed",
  no_show: "no_show",
  cancelled: "cancelled",
} as const

const OUTCOME_TO_FSM_EVENT_TYPE = {
  completed: "interview_completed",
  no_show: "interview_no_show",
  cancelled: null,
} as const

export const AdminInterviewOutcomeInputSchema = z
  .object({
    bookingId: z.string().trim().min(1).optional(),
    userId: z.string().trim().min(1).optional(),
    jobId: z.string().trim().min(1).optional(),
    outcome: z.enum(["completed", "no_show", "cancelled"]),
    note: z.string().max(4_000).optional(),
    adminToken: z.string().nullish(),
  })
  .refine((v) => Boolean(v.bookingId) || (Boolean(v.userId) && Boolean(v.jobId)), {
    message: "bookingId or (userId and jobId) required",
  })
export type AdminInterviewOutcomeInput = z.infer<typeof AdminInterviewOutcomeInputSchema>

export type AdminInterviewOutcomeResult = {
  ok: true
  bookingId: string
  userId?: string
  jobId?: string
  outcome: "completed" | "no_show" | "cancelled"
  bookingStatus: string
  fsmEmitted: boolean
}

export interface AdminInterviewOutcomeDeps {
  db: Firestore
  now?: () => string
  actorEmail?: string
}

export async function runAdminInterviewOutcome(
  raw: unknown,
  deps: AdminInterviewOutcomeDeps,
): Promise<AdminInterviewOutcomeResult> {
  const parsed = AdminInterviewOutcomeInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const { outcome } = parsed.data
  const now = deps.now?.() ?? new Date().toISOString()
  const note = str(parsed.data.note)
  const by = str(deps.actorEmail) ?? "admin_token"

  // Resolve the booking doc — explicit bookingId wins; else look up the single
  // booking for (userId × jobId). The Cal.com doc-id namespace is deterministic
  // (calbk-<userId>__<jobId>) but a userId/jobId pair could also match the legacy
  // booking-... id, so we query rather than assume the id shape.
  const ref = parsed.data.bookingId
    ? deps.db.collection(BOOKINGS_COLLECTION).doc(parsed.data.bookingId)
    : await (async () => {
        const snap = await deps.db
          .collection(BOOKINGS_COLLECTION)
          .where("userId", "==", parsed.data.userId)
          .where("jobId", "==", parsed.data.jobId)
          .limit(1)
          .get()
        if (snap.empty) {
          throw new HttpsError("not-found", "interview_booking_not_found")
        }
        return snap.docs[0]!.ref
      })()

  const snap = await ref.get()
  if (!snap.exists) {
    throw new HttpsError("not-found", "interview_booking_not_found")
  }
  const booking = (snap.data() ?? {}) as Record<string, unknown>
  const userId = str(booking.userId) ?? str(parsed.data.userId)
  const jobId = str(booking.jobId) ?? str(parsed.data.jobId)
  const bookingStatus = OUTCOME_TO_BOOKING_STATUS[outcome]

  // (1) Write the booking-doc status + outcome trail.
  await ref.set(
    {
      status: bookingStatus,
      outcome,
      outcomeAt: now,
      ...(note ? { outcomeNote: note } : {}),
      outcomeBy: by,
      updatedAt: now,
    },
    { merge: true },
  )

  // (2) Emit the parallel candidate×job FSM event (fail-open, idempotent).
  // `cancelled` has no FSM event in the marketplace union — booking status only.
  let fsmEmitted = false
  const fsmEventType = OUTCOME_TO_FSM_EVENT_TYPE[outcome]
  if (fsmEventType && userId && jobId) {
    try {
      const event = {
        type: fsmEventType,
        // Deterministic so a re-stamp dedups to a no-op via the audit-keyed txn.
        eventId: `${fsmEventType}:${userId}:${jobId}:${ref.id}`,
        candidateId: userId,
        jobId,
        actor: "operator",
        occurredAt: now,
        evidence: [
          {
            source: "system",
            summary: `operator stamped interview ${outcome}${note ? `: ${note}` : ""}`,
          },
        ],
        interviewBookingId: ref.id,
        ...(outcome === "completed" ? { outcome } : {}),
      } as CandidateJobEvent
      await commitCandidateJobEvent(deps.db, event)
      fsmEmitted = true
    } catch (err) {
      logger.warn("[admin-interview-outcome] FSM emit failed (non-fatal)", {
        bookingId: ref.id,
        userId,
        jobId,
        outcome,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    ok: true,
    bookingId: ref.id,
    ...(userId ? { userId } : {}),
    ...(jobId ? { jobId } : {}),
    outcome,
    bookingStatus,
    fsmEmitted,
  }
}

export const paAdminInterviewOutcome = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 60, maxInstances: 1, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminInterviewOutcomeResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminInterviewOutcome(req.data, {
      db: getFirestore(),
      actorEmail: str(req.auth?.token?.email),
    })
  },
)
