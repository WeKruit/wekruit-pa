/**
 * Prescreen-NURTURE — Firestore dispatch store + runNurtureTurn adapter.
 *
 * Wires the pure `dispatchNurture` logic to production seams:
 *   - composer reads (job/session/user) via createFirestoreNurtureComposerStore
 *   - idempotency lookup across nurture audit kinds (checkFireWindowExists)
 *   - runtime handoff via enqueueRuntimeEventHandoff (Claire composes)
 *   - prescreenMetrics stamping on the session
 *   - audit-event writes (top-level fireWindowHash for the idempotency lookup)
 *   - scheduled-job status update (fired / failed) after dispatch
 *
 * Everything is fail-open: a dispatch failure marks the job failed and returns
 * a non-throwing result so the proactive-sweep loop continues.
 */

import { randomUUID } from "node:crypto"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { enqueueRuntimeEventHandoff } from "./runtime-event-handoff.js"
import { createFirestoreNurtureComposerStore } from "./prescreen-nurture-composer.js"
import {
  dispatchNurture,
  type NurtureDispatchResult,
  type NurtureDispatchStore,
} from "./prescreen-nurture-dispatch.js"
import type { PrescreenNurtureScheduledJob } from "./prescreen-nurture-scheduler.js"

const PRESCREEN_SESSIONS = "pa-prescreen-sessions"
// Idempotency only guards against a double SEND. A *suppressed* window had no
// candidate-facing message, so it must stay retryable — only the `sent` kind
// blocks a re-fire of the same window.
const NURTURE_SENT_AUDIT_KIND = "prescreen_nurture_sent"

export function createFirestoreNurtureDispatchStore(
  db: Firestore,
  log: (...args: unknown[]) => void = () => {}
): NurtureDispatchStore {
  const nowIso = () => new Date().toISOString()
  return {
    composer: createFirestoreNurtureComposerStore(db),

    async checkFireWindowExists(fwHash) {
      const snap = await db
        .collection(PA_COLLECTIONS.auditEvents)
        .where("kind", "==", NURTURE_SENT_AUDIT_KIND)
        .where("fireWindowHash", "==", fwHash)
        .limit(1)
        .get()
      return !snap.empty
    },

    async enqueueRuntimeEvent(userId, input) {
      const result = await enqueueRuntimeEventHandoff(db, {
        userId,
        source: "prescreen_review_nurture",
        eventKind: input.eventKind,
        idempotencyKey: input.idempotencyKey,
        requireExistingSession: true,
        context: input.context,
      })
      return result.ok
        ? { ok: true, runtimeEventId: result.eventId, created: result.created }
        : { ok: false, reason: result.reason }
    },

    async stampSessionNurtured(sessionId, _nurturingNumber, when) {
      await db.collection(PRESCREEN_SESSIONS).doc(sessionId).set(
        {
          prescreenMetrics: {
            totalNurtureSent: FieldValue.increment(1),
            lastNurtureAt: when,
          },
          updatedAt: when,
        },
        { merge: true }
      )
    },

    async writeAuditEvent(row) {
      const id = randomUUID()
      await db
        .collection(PA_COLLECTIONS.auditEvents)
        .doc(id)
        .set({ id, createdAt: row["createdAt"] ?? nowIso(), actor: "orchestrator", ...row })
    },

    log,
  }
}

/**
 * Production `runNurtureTurn` for the proactive-sweep SweepStore. Dispatches the
 * nurture, then updates the scheduled-job status (fired on success/idempotent,
 * failed on runtime block). Never throws.
 */
export async function runNurtureTurn(
  db: Firestore,
  userId: string,
  job: PrescreenNurtureScheduledJob,
  log: (...args: unknown[]) => void = () => {}
): Promise<NurtureDispatchResult> {
  const store = createFirestoreNurtureDispatchStore(db, log)
  let result: NurtureDispatchResult
  try {
    result = await dispatchNurture(job, store)
  } catch (err) {
    log("[nurture-dispatch] fatal", {
      jobId: job.jobId,
      error: err instanceof Error ? err.message : String(err),
    })
    await safeSetJobStatus(db, job.jobId, {
      status: "failed",
      lastError: err instanceof Error ? err.message : String(err),
    })
    return { dispatched: false, reason: "runtime_blocked", runtimeReason: "dispatch_error" }
  }

  if (result.dispatched) {
    await safeSetJobStatus(db, job.jobId, { status: "fired", lastFiredAt: new Date().toISOString() })
  } else if (result.reason === "already_fired") {
    // Window already covered — close the row so it stops being re-fetched.
    await safeSetJobStatus(db, job.jobId, { status: "fired" })
  } else {
    await safeSetJobStatus(db, job.jobId, {
      status: "failed",
      lastError: `runtime_blocked:${result.runtimeReason}`,
    })
  }
  return result
}

async function safeSetJobStatus(
  db: Firestore,
  jobId: string,
  patch: Record<string, unknown>
): Promise<void> {
  try {
    await db
      .collection(PA_COLLECTIONS.scheduledJobs)
      .doc(jobId)
      .set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true })
  } catch {
    /* fail-open — status update best-effort */
  }
}
