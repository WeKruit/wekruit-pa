/**
 * Prescreen-NURTURE — Dispatcher.
 *
 * Runs a single claimed nurture scheduled-job through the proactive runtime
 * handoff so Claire composes a personalized check-in in her own voice. Reuses
 * the same idempotency primitive as the proactive engine (fireWindowHash +
 * checkFireWindowExists) so a job can never double-nurture, and stamps
 * `prescreenMetrics.totalNurtureSent++ / lastNurtureAt` + an audit event after
 * a successful handoff.
 *
 * This module never composes candidate copy and never writes a sendable
 * transport row — it hands structured facts to the runtime, exactly like the
 * proactive-turn path. Fail-open: a dispatch failure marks the job failed but
 * never throws into the sweep loop.
 */

import { fireWindowHash } from "@pa/core-types"
import {
  buildPrescreenNurtureContext,
  type NurtureComposerStore,
  type PrescreenNurtureContext,
} from "./prescreen-nurture-composer.js"
import type { PrescreenNurtureScheduledJob } from "./prescreen-nurture-scheduler.js"

/** Idempotency seed — `prescreen-nurture-<candidateId>-<jobId>-<nurturingNumber>`. */
export function nurtureFireSeed(args: {
  candidateId: string
  jobId: string
  nurturingNumber: number
}): string {
  return `prescreen-nurture-${args.candidateId}-${args.jobId}-${args.nurturingNumber}`
}

export type NurtureDispatchResult =
  | { dispatched: false; reason: "already_fired" }
  | { dispatched: false; reason: "runtime_blocked"; runtimeReason: string }
  | { dispatched: true; runtimeEventId: string; runtimeEventCreated: boolean; fireWindowHash: string }

export interface NurtureDispatchStore {
  composer: NurtureComposerStore
  /**
   * Idempotency guard — has a nurture for this fire window already fired?
   * Backed by an audit-event lookup on fireWindowHash.
   */
  checkFireWindowExists(fwHash: string): Promise<boolean>
  /**
   * Hand structured facts to Claire runtime. Returns ok+ids or a block reason
   * (e.g. user not routable / no existing session).
   */
  enqueueRuntimeEvent(
    userId: string,
    input: {
      eventKind: string
      idempotencyKey: string
      context: Record<string, unknown>
    }
  ): Promise<{ ok: true; runtimeEventId: string; created: boolean } | { ok: false; reason: string }>
  /** Stamp prescreenMetrics.totalNurtureSent++ + lastNurtureAt on the session. */
  stampSessionNurtured(sessionId: string, nurturingNumber: number, nowIso: string): Promise<void>
  /** Write an audit row (top-level fireWindowHash for the idempotency lookup). */
  writeAuditEvent(row: Record<string, unknown>): Promise<void>
  log(...args: unknown[]): void
}

/**
 * Dispatch one nurture. Steps:
 *   1. Compute fireWindowHash from the deterministic seed × nextFireAt.
 *   2. Idempotency: skip if an audit row for this window already exists.
 *   3. Build personalized context (composer).
 *   4. Hand off to Claire runtime (enqueueRuntimeEvent).
 *   5. On success: stamp session metrics + audit row.
 */
export async function dispatchNurture(
  job: PrescreenNurtureScheduledJob,
  store: NurtureDispatchStore,
  opts: { now?: () => Date } = {}
): Promise<NurtureDispatchResult> {
  const now = (opts.now ?? (() => new Date()))()
  const nowIso = now.toISOString()

  const seed = nurtureFireSeed({
    candidateId: job.userId,
    jobId: job.opportunityJobId,
    nurturingNumber: job.nurturingNumber,
  })
  const nextFireAtMs = new Date(job.nextFireAt).getTime()
  const fwHash = fireWindowHash(seed, Number.isNaN(nextFireAtMs) ? now.getTime() : nextFireAtMs)

  // (2) Idempotency — never double-nurture the same window.
  if (await store.checkFireWindowExists(fwHash)) {
    store.log("[nurture-dispatch] idempotent_skip", {
      jobId: job.jobId,
      userId: job.userId,
      fireWindowHash: fwHash,
    })
    return { dispatched: false, reason: "already_fired" }
  }

  // (3) Personalize per session.
  const context: PrescreenNurtureContext = await buildPrescreenNurtureContext(store.composer, {
    candidateId: job.userId,
    jobId: job.opportunityJobId,
    sessionId: job.sessionId,
    nurturingNumber: job.nurturingNumber,
  })

  // (4) Hand off to Claire runtime. Idempotency key includes fwHash so a
  // re-claim within the same window collapses to the same runtime event.
  const runtime = await store.enqueueRuntimeEvent(job.userId, {
    eventKind: "prescreen_review_nurture_v1",
    idempotencyKey: `nurture:${job.jobId}:${fwHash}`,
    context: {
      ...context,
      prescreenTerminal: job.prescreenTerminal,
      scheduledJobId: job.jobId,
      fireWindowHash: fwHash,
      source: "prescreen_review_nurture",
    },
  })

  if (!runtime.ok) {
    await store.writeAuditEvent({
      kind: "prescreen_nurture_suppressed",
      userId: job.userId,
      jobId: job.opportunityJobId,
      sessionId: job.sessionId,
      nurturingNumber: job.nurturingNumber,
      fireWindowHash: fwHash,
      runtimeReason: runtime.reason,
      createdAt: nowIso,
    })
    store.log("[nurture-dispatch] runtime_blocked", {
      jobId: job.jobId,
      userId: job.userId,
      reason: runtime.reason,
    })
    return { dispatched: false, reason: "runtime_blocked", runtimeReason: runtime.reason }
  }

  // (5) Stamp session metrics + audit (only when a candidate-facing message
  // was actually enqueued for this window — `created` true means new event).
  await store.stampSessionNurtured(job.sessionId, job.nurturingNumber, nowIso)
  await store.writeAuditEvent({
    kind: "prescreen_nurture_sent",
    userId: job.userId,
    jobId: job.opportunityJobId,
    sessionId: job.sessionId,
    nurturingNumber: job.nurturingNumber,
    prescreenTerminal: job.prescreenTerminal,
    fireWindowHash: fwHash,
    runtimeEventId: runtime.runtimeEventId,
    runtimeEventCreated: runtime.created,
    createdAt: nowIso,
  })

  store.log("[nurture-dispatch] sent", {
    jobId: job.jobId,
    userId: job.userId,
    nurturingNumber: job.nurturingNumber,
    runtimeEventId: runtime.runtimeEventId,
    fireWindowHash: fwHash,
  })

  return {
    dispatched: true,
    runtimeEventId: runtime.runtimeEventId,
    runtimeEventCreated: runtime.created,
    fireWindowHash: fwHash,
  }
}

/** Type guard: is this scheduled-job row a prescreen-nurture job? */
export function isPrescreenNurtureJob(
  row: Record<string, unknown> | null | undefined
): boolean {
  return Boolean(row && row["nurturingType"] === "prescreen_review_nurture")
}
