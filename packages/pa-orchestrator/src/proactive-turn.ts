/**
 * Phase 22 — Proactive-turn orchestrator path (D-02, PROACTIVE-04).
 *
 * Design principle: proactive ≡ regular turn + synthetic user-role input.
 * This module does NOT define a parallel system prompt. It calls the SAME
 * turn runner the inbound path uses (Voice v1 prompt is already loaded there).
 *
 * Flow:
 *   1. Kill-switch check (PA_PROACTIVE_DISABLED=1 → return skipped).
 *   2. Build synthetic user-role input with [system-trigger:<type>] marker.
 *   3. Call store.runTurn() — reuses Voice v1 system prompt pipeline.
 *   4. Normalize output via store.normalizeOutput() (Phase 20).
 *   5. Enqueue runtime-approved transport with source=proactive.
 *   6. Write pa_audit_events kind=proactive_send.
 *   7. Update job status to "fired" + handle silence_rearm re-arm.
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
  | { skipped: false; outboundId: string; fireWindowHash: string }

/**
 * Injectable store for proactive-turn. Tests provide fakes; production
 * provides a Firestore-backed implementation.
 */
export type ProactiveTurnStore = {
  /**
   * Run a turn through the SAME orchestrator entry as inbound events.
   * Input role must be "user" to preserve Voice v1 few-shot anchoring (D-02).
   */
  runTurn(
    userId: string,
    input: { role: "user"; content: string; meta?: Record<string, unknown> }
  ): Promise<{ text: string; usage?: unknown }>

  /** Phase 20 output normalizer — applied before enqueue. */
  normalizeOutput(text: string): { text: string; chunks: string[] }

  /** Enqueue a runtime-approved transport row. */
  enqueueOutbound(
    userId: string,
    body: string,
    opts?: Record<string, unknown>
  ): Promise<{ outboundId: string }>

  /** Write a row to pa_audit_events. */
  writeAuditEvent(row: Record<string, unknown>): Promise<void>

  /** Update pa_scheduled_jobs doc: set status + optional lastFiredAt. */
  updateJobStatus(jobId: string, patch: Record<string, unknown>): Promise<void>

  /**
   * Re-arm a silence_rearm job: reset status to pending + set new nextFireAt.
   * Only called when recurrence === "silence_rearm".
   */
  rearmJob(jobId: string, nextFireAt: string): Promise<void>

  /** Resolve user's E.164 phone number for outbound routing. */
  getUserPhoneE164(userId: string): Promise<string>

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
 * Build the human-readable context line injected as the synthetic user input.
 * Keeps the system-trigger marker so the model knows this is a proactive nudge,
 * while the "user" role ensures Voice v1 mes_examples still anchor.
 */
function buildSyntheticContent(job: ProactiveScheduledJob): string {
  const { context } = job
  switch (context.triggerType) {
    case "time_anchor": {
      const eventDate = new Date(context.eventAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      return `[system-trigger:time_anchor] 你提前设定了一个提醒：「${context.eventLabel}」在 ${eventDate}。现在是提醒时间，请主动联系用户。`
    }
    case "silence_anchor":
      return `[system-trigger:silence_anchor] 用户已有 ${Math.round(context.windowSec / 3600)} 小时没有消息了。请主动关心一下。`
    case "application_followup": {
      const appliedDate = new Date(context.appliedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      return `[system-trigger:application_followup] 用户 ${context.followupAfterSec / 3600 < 48 ? `${Math.round(context.followupAfterSec / 3600)} 小时` : `${Math.round(context.followupAfterSec / 86400)} 天`}前投了 ${context.companyName} 的 ${context.jobTitle} 岗位（${appliedDate}），现在跟进一下进展。`
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

  // Build synthetic user-role input (D-02: role stays "user" for Voice v1)
  const syntheticContent = buildSyntheticContent(job)
  const syntheticInput = {
    role: "user" as const,
    content: syntheticContent,
    meta: {
      source: "proactive" as const,
      jobId: job.jobId,
      triggerType: job.triggerType,
      fireWindowHash: fwHash,
    },
  }

  // Run the turn through the same Voice v1 entry (D-02)
  const { text } = await store.runTurn(userId, syntheticInput)

  // Phase 20: normalize output before enqueue (D-11)
  const normalized = store.normalizeOutput(text)
  const body = normalized.text

  // Enqueue runtime-approved transport with proactive provenance (D-08)
  const phone = await store.getUserPhoneE164(userId)
  const { outboundId } = await store.enqueueOutbound(userId, body, {
    source: "proactive",
    proactiveJobId: job.jobId,
    toNumber: phone,
  })

  // Audit log (D-09)
  await store.writeAuditEvent({
    kind: "proactive_send",
    userId,
    jobId: job.jobId,
    triggerType: job.triggerType,
    fireWindowHash: fwHash,
    outboundId,
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
    outboundId,
    fireWindowHash: fwHash,
  })

  return { skipped: false, outboundId, fireWindowHash: fwHash }
}
