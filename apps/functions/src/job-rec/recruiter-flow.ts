// DEPRECATED — Stream D pivot (2026-04-30) reverted to Claire-only architecture.
// This file is NOT loaded by onPaInbound anymore (dispatcher removed in apps/functions/src/index.ts).
// Kept for reference: `runRecruiterFlow` may be repurposed later.
// Do NOT import from production code. It must never create sendable
// pa-outbound rows directly; non-runtime output is handed to Claire runtime.
/**
 * Stream C — runRecruiterFlow
 *
 * Lifecycle wrapper that runs a single RecruiterAgent turn against an
 * inbound iMessage carrying a CV (mediaUrl). Mirrors the lifecycle
 * contract of `claimAndProcessInboundEvent` (pa-orchestrator) but
 * routes the LLM turn through `@pa/job-rec` instead of the default
 * Claire orchestrator.
 *
 * Why this lives in apps/functions and not @pa/job-rec: this code
 * binds Cloud-Functions-side concerns (Firestore lifecycle on
 * pa-inbound-events, output normalization, runtime-event handoff
 * schema). @pa/job-rec stays pure-logic and reusable from cron.
 *
 * Lifecycle (atomic, mirrors claimInboundEvent semantics):
 *   1. Transaction: read pa-inbound-events/{id}; if status !== "pending"
 *      AND lease not expired → return null (no-op; idempotent).
 *      Otherwise flip status="running", leaseUntil=now+90s, attempts++.
 *   2. Resolve user phoneE164 (delivery target). Missing → mark failed.
 *   3. Run RecruiterAgent turn (LLM + tools).
 *   4. Normalize text via normalizeForIMessage (Bible v7.5.2 hard rules).
 *   5. Hand proposed assistant text to Claire runtime as a system event.
 *   7. Mark event status="succeeded", completedAt, recruiterTurnRan=true.
 *   8. On error: mark status="failed" + failureReason; re-throw so the
 *      caller's outer logger surfaces the error. We do NOT fall back to
 *      default Claire after pre-claim — the inbound row is already ours.
 */

import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  type InboundEvent,
  type User,
} from "@pa/core-types"
import { normalizeForIMessage } from "@pa/pa-orchestrator"
import {
  runRecruiterTurn as defaultRunRecruiterTurn,
  type RecruiterAgentDeps,
  type RunRecruiterTurnArgs,
  type RunRecruiterTurnResult,
} from "@pa/job-rec"
import { enqueueRuntimeEventHandoff } from "../runtime-event-handoff.js"

const DEFAULT_LEASE_MS = Number(process.env.PA_INBOUND_LEASE_MS || "90000")

export type RunRecruiterFlowOptions = {
  mediaUrl: string
  /** Override the default `runRecruiterTurn` (tests inject a fake). */
  runRecruiterTurnImpl?: (
    deps: RecruiterAgentDeps,
    args: RunRecruiterTurnArgs
  ) => Promise<RunRecruiterTurnResult>
  /** Override Date for deterministic lease/timestamp assertions in tests. */
  now?: () => Date
  /** Override resume bucket (forwarded to parseResume tool). */
  resumeBucket?: string
  /** Override the model identifier. */
  model?: string
  /** Override the normalizer (tests verify it ran). */
  normalize?: (text: string) => { text: string }
  log?: (...args: unknown[]) => void
}

export type RunRecruiterFlowResult =
  | { ok: true; outboundId: string; assistantTextLen: number }
  | { ok: false; reason: "already_processed" | "no_phone" | "empty_output" | "runtime_handoff_blocked" }

function defaultLog(..._args: unknown[]): void {
  /* swallow */
}

/**
 * Atomic claim — flips pending→running with a lease. Returns the
 * post-claim event payload, or null if the row is already taken by
 * another worker (idempotency).
 */
async function claimForRecruiter(
  db: Firestore,
  eventId: string,
  now: Date
): Promise<InboundEvent | null> {
  const ref = db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return null
    const raw = snap.data() as (InboundEvent & { leaseUntil?: string }) | undefined
    if (!raw) return null
    // Honor the same predicate as orchestrator.claimInboundEvent: only
    // claim if pending OR running-with-expired-lease. This guarantees
    // re-firings of the same event no-op.
    const leaseExpired =
      typeof raw.leaseUntil === "string"
        ? new Date(raw.leaseUntil).getTime() <= now.getTime()
        : true
    if (raw.status !== "pending" && !(raw.status === "running" && leaseExpired)) {
      return null
    }
    const claimedAt = now.toISOString()
    const leaseUntil = new Date(now.getTime() + DEFAULT_LEASE_MS).toISOString()
    const patch = {
      status: "running" as const,
      attempts: (raw.attempts ?? 0) + 1,
      claimedAt,
      leaseUntil,
      startedAt: raw.startedAt ?? claimedAt,
      updatedAt: claimedAt,
    }
    tx.set(ref, patch, { merge: true })
    return { ...raw, ...patch }
  })
}

async function loadPhone(db: Firestore, userId: string): Promise<string | null> {
  const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
  if (!snap.exists) return null
  const data = snap.data() as Partial<User> | undefined
  const phone = data?.phoneE164
  if (typeof phone !== "string" || phone.trim().length === 0) return null
  return phone.trim()
}

/**
 * Run a single recruiter turn for an inbound event. Owns the
 * pa-inbound-events lifecycle from claim → completion. Throws on
 * recruiter or persistence failures (caller logs at the outer CF).
 */
export async function runRecruiterFlow(
  db: Firestore,
  event: InboundEvent,
  opts: RunRecruiterFlowOptions
): Promise<RunRecruiterFlowResult> {
  const log = opts.log ?? defaultLog
  const now = opts.now ?? (() => new Date())
  const runTurn = opts.runRecruiterTurnImpl ?? defaultRunRecruiterTurn
  const normalize = opts.normalize ?? ((t: string) => normalizeForIMessage(t))

  const eventId = event.id
  const ref = db.collection(PA_COLLECTIONS.inboundEvents).doc(eventId)

  // ---- 1. Atomic claim ------------------------------------------------
  const claimed = await claimForRecruiter(db, eventId, now())
  if (!claimed) {
    log("[recruiter-flow] already_claimed_or_completed", { eventId })
    return { ok: false, reason: "already_processed" }
  }

  try {
    // ---- 2. Phone resolution -----------------------------------------
    const toE164 = await loadPhone(db, claimed.userId)
    if (!toE164) {
      const failedAt = now().toISOString()
      await ref.set(
        {
          status: "failed",
          errorCode: "no_phone",
          error: "user has no phoneE164; cannot deliver",
          completedAt: failedAt,
          updatedAt: failedAt,
        },
        { merge: true }
      )
      log("[recruiter-flow] no_phone", { eventId, userId: claimed.userId })
      return { ok: false, reason: "no_phone" }
    }

    // ---- 3. Build deps + run RecruiterAgent --------------------------
    const deps: RecruiterAgentDeps = {
      db,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.resumeBucket ? { resumeBucket: opts.resumeBucket } : {}),
      tools: {
        parseResume: { db },
        queryMatchingJobs: { db },
        saveJobProfile: { db },
        sendImessage: { db },
      },
      log,
    }
    const turnResult = await runTurn(deps, {
      userMessage: event.body || "",
      attachmentMediaUrl: opts.mediaUrl,
      sessionId: event.sessionId,
      userId: event.userId,
    })

    const rawText = turnResult.text || ""
    const normalized = normalize(rawText)
    const assistantText = normalized.text || ""

    // ---- 4. Runtime handoff ------------------------------------------
    let outboundId: string | null = null
    if (assistantText.length === 0) {
      log("[recruiter-flow] empty_output_skipping_message", { eventId })
    } else {
      const runtime = await enqueueRuntimeEventHandoff(db, {
        userId: event.userId,
        toE164,
        sessionId: event.sessionId,
        source: "deprecated_recruiter_flow",
        eventKind: "recruiter_agent_output",
        idempotencyKey: eventId,
        context: {
          proposedMessage: assistantText,
          inboundEventId: eventId,
          mediaUrl: opts.mediaUrl,
        },
      })
      if (runtime.ok) outboundId = runtime.eventId
      else {
        const failedAt = now().toISOString()
        await ref.set(
          {
            status: "failed",
            errorCode: "runtime_handoff_blocked",
            error: runtime.reason,
            completedAt: failedAt,
            updatedAt: failedAt,
          },
          { merge: true }
        )
        log("[recruiter-flow] runtime_handoff_blocked", { eventId, reason: runtime.reason })
        return { ok: false, reason: "runtime_handoff_blocked" }
      }
    }

    // ---- 5. Mark event succeeded ------------------------------------
    const completedAt = now().toISOString()
    await ref.set(
      {
        status: "succeeded",
        completedAt,
        updatedAt: completedAt,
        recruiterTurnRan: true,
        ...(outboundId ? { outboundId } : {}),
      },
      { merge: true }
    )
    log("[recruiter-flow] succeeded", {
      eventId,
      userId: event.userId,
      assistantTextLen: assistantText.length,
      outboundId,
    })

    if (assistantText.length === 0) {
      return { ok: false, reason: "empty_output" }
    }
    return { ok: true, outboundId: outboundId!, assistantTextLen: assistantText.length }
  } catch (err) {
    // Mark event failed so the lease doesn't get re-claimed silently.
    const failedAt = now().toISOString()
    const message = err instanceof Error ? err.message : String(err)
    try {
      await ref.set(
        {
          status: "failed",
          errorCode: "recruiter_turn_failed",
          error: message.slice(0, 500),
          completedAt: failedAt,
          updatedAt: failedAt,
        },
        { merge: true }
      )
    } catch (markErr) {
      log("[recruiter-flow] failed_to_mark_failed", {
        eventId,
        markErr: markErr instanceof Error ? markErr.message : String(markErr),
      })
    }
    log("[recruiter-flow] threw", { eventId, err: message })
    throw err
  }
}
