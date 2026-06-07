/**
 * Prescreen-NURTURE — Scheduler.
 *
 * Decides, for each enumerated eligible candidate, whether the *next* nurture
 * check-in is due per the cadence policy, and if so creates a pending
 * `pa-scheduled-jobs` doc the proactive-sweep picks up and dispatches.
 *
 * Cadence policy:
 *   - firstNurtureDelay: 24h after the candidate-job state enters review-pending
 *   - interval:          7d between subsequent check-ins
 *   - max:               3 nurtures per session
 *
 * The whole engine is gated on the `paPrescreenNurtureEnabled` feature flag
 * (default OFF). Flag OFF → schedules 0 jobs (proves inert).
 *
 * This module never sends. It only writes scheduled-job rows (and is idempotent
 * on a deterministic doc id keyed by candidate × job × nurtureNumber, so a
 * re-run in the same window never double-schedules).
 */

import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { getFlag } from "@pa/pa-persistence"
import {
  enumerateNurtureCandidates,
  createFirestoreNurtureEnumeratorStore,
  type NurtureEligible,
  type NurtureEnumeratorStore,
} from "./prescreen-nurture-enumerator.js"

/** Feature flag that gates the entire prescreen-nurture engine (default OFF). */
export const PRESCREEN_NURTURE_FLAG = "paPrescreenNurtureEnabled"

/** nurturingType discriminator stamped on scheduled-job rows we own. */
export const PRESCREEN_NURTURE_TYPE = "prescreen_review_nurture"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export interface PrescreenNurtureCadence {
  /** Delay after review-pending entry before the FIRST check-in. */
  firstNurtureDelayMs: number
  /** Spacing between subsequent check-ins. */
  intervalMs: number
  /** Hard cap on check-ins per session. */
  maxNurturesPerSession: number
}

export const DEFAULT_NURTURE_CADENCE: PrescreenNurtureCadence = Object.freeze({
  firstNurtureDelayMs: 24 * HOUR_MS, // 24h
  intervalMs: 7 * DAY_MS, // 7d
  maxNurturesPerSession: 3,
})

/**
 * Shape of the scheduled-job row this engine writes into `pa-scheduled-jobs`.
 * Distinct from the proactive ScheduledJob trigger union — identified by the
 * `nurturingType` discriminator so the proactive-sweep can branch on it.
 */
export interface PrescreenNurtureScheduledJob {
  jobId: string
  nurturingType: typeof PRESCREEN_NURTURE_TYPE
  userId: string
  /** The opportunity (matching job) this nurture is about. */
  opportunityJobId: string
  sessionId: string
  /** 1-based ordinal: which nurture in the sequence this is. */
  nurturingNumber: number
  /** Terminal recorded on the prescreen session (for context personalization). */
  prescreenTerminal: string
  status: "pending"
  nextFireAt: string
  /** Phase 7 legacy alias — kept equal to nextFireAt for the sweep query. */
  dueAt: string
  createdAt: string
  attempts: number
  maxAttempts: number
  backoffSec: number
}

/**
 * Deterministic doc id: candidate × opportunity × nurtureNumber. Re-running the
 * scheduler in the same window overwrites the same doc instead of creating a
 * duplicate. Sanitized so it is a valid Firestore id.
 */
export function nurtureScheduledJobId(args: {
  candidateId: string
  jobId: string
  nurturingNumber: number
}): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200)
  return `nurture-${safe(args.candidateId)}-${safe(args.jobId)}-${args.nurturingNumber}`
}

/**
 * Compute the next nurture fire-time for an eligible candidate, or null when
 * none is due yet / cap reached.
 *
 *   - nurture #1 fires at stateUpdatedAt + firstNurtureDelay
 *   - nurture #(n+1) fires at lastNurtureAt + interval
 *
 * Returns the 1-based ordinal and the fire time. A nurture is "due" only when
 * its computed fire time is at or before `now` (the enumerator already required
 * stateUpdatedAt ≤ now − firstNurtureDelay, so #1 is always due once enumerated;
 * #2+ depends on lastNurtureAt + interval).
 */
export function computeNextNurture(
  eligible: NurtureEligible,
  now: Date,
  cadence: PrescreenNurtureCadence = DEFAULT_NURTURE_CADENCE
): { nurturingNumber: number; nextFireAt: string } | null {
  const sent = eligible.totalNurtureSent
  if (sent >= cadence.maxNurturesPerSession) return null

  const nurturingNumber = sent + 1

  let fireAtMs: number
  if (sent === 0) {
    // First nurture: anchored to when review-pending began.
    fireAtMs = new Date(eligible.stateUpdatedAt).getTime() + cadence.firstNurtureDelayMs
  } else {
    // Subsequent: interval after the last one sent.
    const last = eligible.lastNurtureAt ? new Date(eligible.lastNurtureAt).getTime() : NaN
    if (Number.isNaN(last)) return null
    fireAtMs = last + cadence.intervalMs
  }

  if (Number.isNaN(fireAtMs)) return null
  // Not due yet.
  if (fireAtMs > now.getTime()) return null

  return { nurturingNumber, nextFireAt: new Date(fireAtMs).toISOString() }
}

export interface NurtureSchedulerStore extends NurtureEnumeratorStore {
  /**
   * Firestore handle for the flag read. Production wires the live db so the
   * `paPrescreenNurtureEnabled` flag is honored; tests may omit it (then the
   * flag default OFF applies and 0 jobs are scheduled).
   */
  db?: Firestore
  /**
   * Create (or overwrite) a pending nurture scheduled-job row. Returns true if
   * a brand-new row was written, false if it overwrote an existing one
   * (idempotent re-run in the same window).
   */
  upsertScheduledJob(job: PrescreenNurtureScheduledJob): Promise<{ created: boolean }>
}

export interface ScheduleNurturesResult {
  skipped?: "disabled"
  enumerated: number
  scheduled: number
  notDue: number
}

/**
 * Enumerate eligible candidates and schedule the due nurtures. Flag-gated: when
 * `paPrescreenNurtureEnabled` is falsy, returns immediately with 0 scheduled.
 */
export async function scheduleNurtures(
  store: NurtureSchedulerStore,
  opts: { now?: () => Date; cadence?: PrescreenNurtureCadence; scanLimit?: number } = {}
): Promise<ScheduleNurturesResult> {
  const now = opts.now ?? (() => new Date())
  const cadence = opts.cadence ?? DEFAULT_NURTURE_CADENCE

  // Flag gate — whole engine OFF by default. No enumeration, no writes.
  const dbForFlag = store.db ?? makeNoopFirestoreForFlag()
  const enabled = Boolean(
    await getFlag(dbForFlag, PRESCREEN_NURTURE_FLAG, { env: process.env }, false)
  )
  if (!enabled) {
    store.log("[nurture-scheduler] skipped: paPrescreenNurtureEnabled is OFF")
    return { skipped: "disabled", enumerated: 0, scheduled: 0, notDue: 0 }
  }

  const eligible = await enumerateNurtureCandidates(store, {
    now,
    cadence,
    scanLimit: opts.scanLimit,
  })

  let scheduled = 0
  let notDue = 0
  for (const cand of eligible) {
    try {
      const next = computeNextNurture(cand, now(), cadence)
      if (!next) {
        notDue++
        continue
      }
      const nowIso = now().toISOString()
      const jobId = nurtureScheduledJobId({
        candidateId: cand.candidateId,
        jobId: cand.jobId,
        nurturingNumber: next.nurturingNumber,
      })
      const job: PrescreenNurtureScheduledJob = {
        jobId,
        nurturingType: PRESCREEN_NURTURE_TYPE,
        userId: cand.candidateId,
        opportunityJobId: cand.jobId,
        sessionId: cand.sessionId,
        nurturingNumber: next.nurturingNumber,
        prescreenTerminal: cand.prescreenTerminal,
        status: "pending",
        nextFireAt: next.nextFireAt,
        dueAt: next.nextFireAt,
        createdAt: nowIso,
        attempts: 0,
        maxAttempts: 3,
        backoffSec: 300,
      }
      await store.upsertScheduledJob(job)
      scheduled++
    } catch (err) {
      // Fail-open per candidate — a single bad write never breaks the run.
      store.log("[nurture-scheduler] schedule_error", {
        candidateId: cand.candidateId,
        jobId: cand.jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  store.log("[nurture-scheduler] complete", {
    enumerated: eligible.length,
    scheduled,
    notDue,
  })
  return { enumerated: eligible.length, scheduled, notDue }
}

/**
 * Firestore-shaped no-op stub used when no real db is supplied — `getFlag`
 * reads `{exists:false}` and falls through to the OFF default. The SDK env
 * override still fires before any read.
 */
function makeNoopFirestoreForFlag(): Firestore {
  const stub = {
    collection: () => ({
      doc: () => ({
        async get() {
          return { exists: false, data: () => undefined }
        },
      }),
    }),
  }
  return stub as unknown as Firestore
}

// ---------------------------------------------------------------------------
// Firestore-backed scheduler store
// ---------------------------------------------------------------------------

export function createFirestoreNurtureSchedulerStore(
  db: Firestore,
  log: (...args: unknown[]) => void = () => {}
): NurtureSchedulerStore {
  const enumerator = createFirestoreNurtureEnumeratorStore(db, log)
  return {
    ...enumerator,
    db,
    async upsertScheduledJob(job) {
      const ref = db.collection(PA_COLLECTIONS.scheduledJobs).doc(job.jobId)
      const existing = await ref.get()
      await ref.set(job, { merge: true })
      return { created: !existing.exists }
    },
  }
}
