/**
 * Prescreen-NURTURE — Enumerator.
 *
 * Finds candidates with an ONGOING prescreen awaiting OUR response (passed /
 * under-review, waiting on WeKruit to pitch them + connect with the hiring
 * manager + get feedback). These candidates otherwise get radio silence for
 * 24-72h → anxiety + churn. The nurture engine sends periodic natural
 * "still working on it" check-ins to keep them engaged.
 *
 * This module is the read/eligibility half. It is pure logic over an injected
 * store so unit tests drive it without firebase-admin. It NEVER sends anything
 * and NEVER writes; it only returns the eligible list.
 *
 * Eligibility (all must hold):
 *   1. candidate-job state == "prescreen_review_pending"
 *   2. stateUpdatedAt ≤ (now − firstNurtureDelay)  — give us a beat before the
 *      first check-in (the review-pending ack just went out)
 *   3. a prescreen session exists with a terminal (PASS/FAIL/HARD_STOP)
 *   4. user lifecycleState is NOT opted_out / paused / deleted (opt-out respect)
 *   5. session.prescreenMetrics.totalNurtureSent < max (cap)
 *
 * Cadence timing (whether the *next* nurture is actually due) is decided by the
 * scheduler; the enumerator only filters out the never-eligible and the
 * capped/opted-out so the scheduler works a small candidate set.
 */

import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  DEFAULT_NURTURE_CADENCE,
  type PrescreenNurtureCadence,
} from "./prescreen-nurture-scheduler.js"

const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

/** Lifecycle states that suppress all outbound nurture (opt-out respect). */
export const NURTURE_BLOCKED_LIFECYCLE_STATES = Object.freeze([
  "opted_out",
  "paused",
  "deleted",
] as const)

/** A candidate eligible for a prescreen-review nurture check-in. */
export interface NurtureEligible {
  candidateId: string
  jobId: string
  sessionId: string
  /** Terminal recorded on the prescreen session (PASS/FAIL/HARD_STOP). */
  prescreenTerminal: string
  /** Nurtures already sent for this session (0..max-1 here, by the cap filter). */
  totalNurtureSent: number
  /** ISO of last nurture sent, or null if none yet. */
  lastNurtureAt: string | null
  /** ISO when the candidate-job state entered prescreen_review_pending. */
  stateUpdatedAt: string
}

/** Injected reads for the enumerator. */
export interface NurtureEnumeratorStore {
  /**
   * Candidate-job-state docs in `prescreen_review_pending` whose stateUpdatedAt
   * is at or before `dueBeforeIso`. Returns the raw doc fields the enumerator
   * needs.
   */
  fetchReviewPendingStates(dueBeforeIso: string, limit: number): Promise<
    Array<{ candidateId: string; jobId: string; prescreenSessionId?: string; stateUpdatedAt: string }>
  >
  /** Read a prescreen session's terminal + nurture metrics. null if missing. */
  fetchSession(sessionId: string): Promise<
    | {
        terminal: string | null
        totalNurtureSent: number
        lastNurtureAt: string | null
      }
    | null
  >
  /** Read a user's lifecycleState. undefined if user/doc missing. */
  fetchUserLifecycleState(userId: string): Promise<string | undefined>
  log(...args: unknown[]): void
}

export interface EnumerateNurtureOptions {
  now?: () => Date
  cadence?: PrescreenNurtureCadence
  /** Max review-pending states to scan per run (CF latency budget). */
  scanLimit?: number
}

/**
 * Return the eligible nurture candidates. Pure over the injected store.
 * Failures reading any single session/user are skipped (fail-open) so one bad
 * row never starves the rest.
 */
export async function enumerateNurtureCandidates(
  store: NurtureEnumeratorStore,
  opts: EnumerateNurtureOptions = {}
): Promise<NurtureEligible[]> {
  const now = (opts.now ?? (() => new Date()))()
  const cadence = opts.cadence ?? DEFAULT_NURTURE_CADENCE
  const scanLimit = opts.scanLimit ?? 200

  // (2) Only states that entered review-pending at least firstNurtureDelay ago.
  const dueBefore = new Date(now.getTime() - cadence.firstNurtureDelayMs).toISOString()

  let states: Awaited<ReturnType<NurtureEnumeratorStore["fetchReviewPendingStates"]>>
  try {
    states = await store.fetchReviewPendingStates(dueBefore, scanLimit)
  } catch (err) {
    store.log("[nurture-enumerator] fetch_states_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }

  const eligible: NurtureEligible[] = []
  for (const state of states) {
    try {
      const sessionId = state.prescreenSessionId
      if (!sessionId) {
        store.log("[nurture-enumerator] skip_no_session", {
          candidateId: state.candidateId,
          jobId: state.jobId,
        })
        continue
      }

      // (4) Opt-out / paused / deleted respect — checked before reading the
      // session so we never waste a read on a suppressed user.
      const lifecycleState = await store.fetchUserLifecycleState(state.candidateId)
      if (
        lifecycleState &&
        (NURTURE_BLOCKED_LIFECYCLE_STATES as readonly string[]).includes(lifecycleState)
      ) {
        store.log("[nurture-enumerator] skip_blocked_lifecycle", {
          candidateId: state.candidateId,
          lifecycleState,
        })
        continue
      }

      // (3) Session must exist with a terminal.
      const session = await store.fetchSession(sessionId)
      if (!session || !session.terminal) {
        store.log("[nurture-enumerator] skip_no_terminal_session", {
          candidateId: state.candidateId,
          sessionId,
        })
        continue
      }

      // (5) Cap.
      if (session.totalNurtureSent >= cadence.maxNurturesPerSession) {
        store.log("[nurture-enumerator] skip_cap_reached", {
          candidateId: state.candidateId,
          sessionId,
          totalNurtureSent: session.totalNurtureSent,
          max: cadence.maxNurturesPerSession,
        })
        continue
      }

      eligible.push({
        candidateId: state.candidateId,
        jobId: state.jobId,
        sessionId,
        prescreenTerminal: session.terminal,
        totalNurtureSent: session.totalNurtureSent,
        lastNurtureAt: session.lastNurtureAt,
        stateUpdatedAt: state.stateUpdatedAt,
      })
    } catch (err) {
      // Fail-open per row — never let one bad doc break the sweep.
      store.log("[nurture-enumerator] row_error", {
        candidateId: state.candidateId,
        jobId: state.jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  store.log("[nurture-enumerator] complete", {
    scanned: states.length,
    eligible: eligible.length,
  })
  return eligible
}

// ---------------------------------------------------------------------------
// Firestore-backed store
// ---------------------------------------------------------------------------

export function createFirestoreNurtureEnumeratorStore(
  db: Firestore,
  log: (...args: unknown[]) => void = () => {}
): NurtureEnumeratorStore {
  return {
    async fetchReviewPendingStates(dueBeforeIso, limit) {
      const snap = await db
        .collection(PA_COLLECTIONS.candidateJobStates)
        .where("state", "==", "prescreen_review_pending")
        .where("stateUpdatedAt", "<=", dueBeforeIso)
        .limit(limit)
        .get()
      return snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>
        return {
          candidateId: String(data.candidateId ?? ""),
          jobId: String(data.jobId ?? ""),
          prescreenSessionId:
            typeof data.prescreenSessionId === "string" ? data.prescreenSessionId : undefined,
          stateUpdatedAt: String(data.stateUpdatedAt ?? ""),
        }
      })
    },

    async fetchSession(sessionId) {
      const snap = await db.collection(PRESCREEN_SESSIONS).doc(sessionId).get()
      if (!snap.exists) return null
      const data = (snap.data() ?? {}) as Record<string, unknown>
      const metrics =
        data.prescreenMetrics && typeof data.prescreenMetrics === "object"
          ? (data.prescreenMetrics as Record<string, unknown>)
          : {}
      const terminal = typeof data.terminal === "string" ? data.terminal : null
      const totalNurtureSent =
        typeof metrics.totalNurtureSent === "number" && metrics.totalNurtureSent >= 0
          ? metrics.totalNurtureSent
          : 0
      const lastNurtureAt =
        typeof metrics.lastNurtureAt === "string" ? metrics.lastNurtureAt : null
      return { terminal, totalNurtureSent, lastNurtureAt }
    },

    async fetchUserLifecycleState(userId) {
      const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      if (!snap.exists) return undefined
      const data = (snap.data() ?? {}) as Record<string, unknown>
      return typeof data.lifecycleState === "string" ? data.lifecycleState : undefined
    },

    log,
  }
}
