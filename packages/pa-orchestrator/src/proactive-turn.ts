/**
 * Phase 22 — Proactive-turn runtime handoff path (D-02, PROACTIVE-04).
 *
 * Design principle: proactive ≡ external event, not a parallel message
 * pipeline. This module never composes candidate-visible copy and never
 * writes sendable transport rows directly. It creates a structured runtime
 * event so the normal Claire runtime decides whether/how to message.
 *
 * Flow:
 *   1. Kill-switch check (PA_PROACTIVE_DISABLED=1 → return skipped).
 *   2. Build structured event context for the scheduled trigger.
 *   3. Enqueue a synthetic pa-inbound-events runtime handoff.
 *   4. Write pa_audit_events kind=proactive_runtime_handoff.
 *   5. Update job status to "fired" + handle silence_rearm re-arm.
 */
import { fireWindowHash } from "@pa/core-types"
import type { ProactiveScheduledJob, SilenceAnchorContext } from "@pa/core-types"
import { getFlag } from "@pa/pa-persistence"
import type { Firestore } from "firebase-admin/firestore"

/**
 * Phase 24.5 — Firestore-shaped no-op stub used when the caller did not
 * provide a real DB. `getFlag()` reads `{exists:false}` and falls through to
 * its `defaultValue`; the SDK's env-emergency override fires BEFORE any read.
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

export type ProactiveTurnResult =
  | { skipped: true; reason: "disabled" }
  | { skipped: true; reason: "runtime_handoff_blocked"; runtimeReason: string; fireWindowHash: string }
  | { skipped: false; runtimeEventId: string; runtimeEventCreated: boolean; fireWindowHash: string }

/**
 * Injectable store for proactive-turn. Tests provide fakes; production
 * provides a Firestore-backed implementation.
 */
export type ProactiveTurnStore = {
  /** Enqueue a synthetic inbound event for Claire runtime to judge. */
  enqueueRuntimeEvent(
    userId: string,
    input: {
      eventKind: string
      idempotencyKey: string
      context: Record<string, unknown>
    }
  ): Promise<{ ok: true; runtimeEventId: string; created: boolean } | { ok: false; reason: string }>

  /** Write a row to pa_audit_events. */
  writeAuditEvent(row: Record<string, unknown>): Promise<void>

  /** Update pa_scheduled_jobs doc: set status + optional lastFiredAt. */
  updateJobStatus(jobId: string, patch: Record<string, unknown>): Promise<void>

  /**
   * Re-arm a silence_rearm job: reset status to pending + set new nextFireAt.
   * Only called when recurrence === "silence_rearm".
   */
  rearmJob(jobId: string, nextFireAt: string): Promise<void>

  log(...args: unknown[]): void

  /**
   * Phase 24.5 — optional Firestore handle for `getFlag()` reads. Tests omit
   * `db`; production wires the live Firestore so the flag in
   * `pa-feature-flags/PA_PROACTIVE_DISABLED` is honored. env=1 still
   * short-circuits inside the SDK as the emergency override.
   */
  db?: Firestore
}

/**
 * Build structured trigger facts. This is intentionally not candidate-visible
 * copy; Claire runtime must compose any eventual message from scratch.
 */
function buildRuntimeContext(job: ProactiveScheduledJob): Record<string, unknown> {
  const { context } = job
  const base = {
    scheduledJobId: job.jobId,
    triggerType: job.triggerType,
    recurrence: job.recurrence,
    nextFireAt: job.nextFireAt,
    dueAt: job.dueAt,
    source: "proactive_scheduled",
  }
  switch (context.triggerType) {
    case "time_anchor":
      return {
        ...base,
        timeAnchor: {
          eventLabel: context.eventLabel,
          eventAt: context.eventAt,
          leadTimeSec: context.leadTimeSec,
        },
      }
    case "silence_anchor":
      return {
        ...base,
        silenceAnchor: {
          windowSec: context.windowSec,
          lastUserMsgAt: context.lastUserMsgAt,
        },
      }
    case "application_followup":
      return {
        ...base,
        applicationFollowup: {
          companyName: context.companyName,
          jobTitle: context.jobTitle,
          appliedAt: context.appliedAt,
          followupAfterSec: context.followupAfterSec,
        },
      }
  }
}

/**
 * Execute a proactive turn for a scheduled job.
 * Called by paProactiveSweep CF after claiming the job.
 *
 * @param userId - Firestore user id
 * @param job    - ProactiveScheduledJob row from pa_scheduled_jobs
 * @param store  - injectable store (Firestore-backed in production, fake in tests)
 */
export async function runProactiveTurn(
  userId: string,
  job: ProactiveScheduledJob,
  store: ProactiveTurnStore
): Promise<ProactiveTurnResult> {
  // D-10: kill switch check — return immediately, no reads, no writes.
  // Phase 24.5: flag-backed via getFlag(). env=1 short-circuits inside the
  // SDK as the emergency override BEFORE any Firestore read; when store.db
  // is absent (unit-test path) a no-op Firestore stub is used so the env
  // override path is preserved without re-introducing a bare
  // `process.env.PA_PROACTIVE_DISABLED` check in this file.
  const dbForFlag = store.db ?? makeNoopFirestoreForFlag()
  const disabled = Boolean(
    await getFlag(dbForFlag, "PA_PROACTIVE_DISABLED", { env: process.env }, false)
  )
  if (disabled) {
    store.log("[proactive-turn] skipped: PA_PROACTIVE_DISABLED flag is set", { jobId: job.jobId })
    return { skipped: true, reason: "disabled" }
  }

  const now = new Date()
  const nextFireAtMs = new Date(job.nextFireAt).getTime()
  const fwHash = fireWindowHash(job.jobId, nextFireAtMs)

  const runtime = await store.enqueueRuntimeEvent(userId, {
    eventKind: `proactive_${job.triggerType}`,
    idempotencyKey: `proactive:${job.jobId}:${fwHash}`,
    context: {
      ...buildRuntimeContext(job),
      fireWindowHash: fwHash,
    },
  })
  if (!runtime.ok) {
    await store.writeAuditEvent({
      kind: "proactive_runtime_suppressed",
      userId,
      jobId: job.jobId,
      triggerType: job.triggerType,
      fireWindowHash: fwHash,
      runtimeReason: runtime.reason,
      createdAt: now.toISOString(),
    })
    await store.updateJobStatus(job.jobId, {
      status: "failed",
      lastError: `runtime_handoff_blocked:${runtime.reason}`,
      updatedAt: now.toISOString(),
    })
    store.log("[proactive-turn] runtime handoff blocked", {
      jobId: job.jobId,
      triggerType: job.triggerType,
      reason: runtime.reason,
      fireWindowHash: fwHash,
    })
    return { skipped: true, reason: "runtime_handoff_blocked", runtimeReason: runtime.reason, fireWindowHash: fwHash }
  }

  await store.writeAuditEvent({
    kind: "proactive_runtime_handoff",
    userId,
    jobId: job.jobId,
    triggerType: job.triggerType,
    fireWindowHash: fwHash,
    runtimeEventId: runtime.runtimeEventId,
    runtimeEventCreated: runtime.created,
    createdAt: now.toISOString(),
  })

  // Update job status to fired
  await store.updateJobStatus(job.jobId, {
    status: "fired",
    lastFiredAt: now.toISOString(),
  })

  // D-12: silence_rearm re-arms the job after firing
  if (job.recurrence === "silence_rearm" && job.context.triggerType === "silence_anchor") {
    const ctx = job.context as SilenceAnchorContext
    const nextMs = now.getTime() + ctx.windowSec * 1000
    const nextFireAt = new Date(nextMs).toISOString()
    await store.rearmJob(job.jobId, nextFireAt)
  }

  store.log("[proactive-turn] fired", {
    jobId: job.jobId,
    triggerType: job.triggerType,
    runtimeEventId: runtime.runtimeEventId,
    runtimeEventCreated: runtime.created,
    fireWindowHash: fwHash,
  })

  return {
    skipped: false,
    runtimeEventId: runtime.runtimeEventId,
    runtimeEventCreated: runtime.created,
    fireWindowHash: fwHash,
  }
}
