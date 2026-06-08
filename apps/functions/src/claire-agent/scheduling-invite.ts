/**
 * scheduling-invite.ts — PROACTIVE interview invite on a HITL PASS commit.
 *
 * GAP 1: when the dashboard "approve" commits a prescreen PASS (commitPrescreenOutcome
 * in evaluation-attempts.ts), today scheduling is REACTIVE — the candidate must text
 * back (or send __PA_SCHEDULE__) before Claire offers times. This module flips that to
 * PROACTIVE: right after the employer-visible-profile write, it builds a REAL Cal.com
 * offer (the SAME buildInterviewOffer the offer_interview_slots tool uses) and texts the
 * candidate the real times, instead of waiting.
 *
 * HARD RULES (outbound proactive messaging is high-stakes):
 *   1. GATED — fires ONLY for scheduling-eligible candidates (isSchedulingEligible:
 *      dev uids OR the paSchedulingEnabled flag). At the live default that is the dev
 *      uids ONLY, so a real candidate gets NO proactive invite until Adam ramps the flag.
 *   2. IDEMPOTENT — two layers so a re-commit (or retry) NEVER double-invites:
 *        (a) a `schedulingInviteSentAt` stamp on the prescreen session short-circuits a
 *            second attempt cheaply (before any Cal.com call);
 *        (b) the outbound enqueue uses a DETERMINISTIC idempotency key
 *            (`scheduling_invite:<jobId>:<candidateId>`) → enqueueOutbound hashes it to a
 *            fixed doc id and treats a duplicate as the existing row (created:false), so
 *            even if (a) is bypassed by a race, only ONE iMessage is ever queued.
 *   3. FAIL-OPEN — a proactive-invite failure NEVER fails the commit. Every path is
 *      wrapped; this function NEVER throws. The caller invokes it AFTER the commit's
 *      durable writes and ignores its result.
 *   4. OPT-OUT-RESPECTING — never proactively message an opted-out / paused / deleted
 *      candidate, nor when the global outreach kill-switch is paused.
 *
 * NOTE: this module deliberately does NOT import the @openai/agents SDK (it reuses the
 * SDK-free buildInterviewOffer core + a deterministic copy template), so the
 * paReviewEvaluationAttempt CF can call it without the agent-SDK boot cost/risk.
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { readOutreachStopControl } from "@pa/pa-persistence"
import { sendRuntimeApprovedIMessage } from "../runtime-approved-outbox.js"
import { buildInterviewOffer } from "./tools/scheduling-tools.js"
import { isSchedulingEligible } from "./scheduling-gate.js"
import type { ClaireToolContext } from "./types.js"

const PRESCREEN_SESSIONS_COLLECTION = "pa-prescreen-sessions"

/** Why a proactive invite did/didn't go out (for logs + the commit telemetry). */
export type ProactiveSchedulingInviteOutcome =
  | { sent: true; outboundId?: string; slotCount: number }
  | {
      sent: false
      reason:
        | "not_eligible"
        | "opted_out"
        | "already_invited"
        | "no_offer"
        | "send_failed"
        | "error"
    }

export interface SendProactiveSchedulingInviteArgs {
  db: Firestore
  /** candidate uid the PASS was committed for. */
  candidateId: string
  /** the job the PASS was committed for. */
  jobId: string
  /** candidate phone (E.164) — required to text; absent → no send. */
  toE164: string
  /** the prescreen session id (carries the idempotency stamp). */
  sessionId: string
  /** clock (commit's reviewedAt). */
  nowIso: string
  log?: (event: string, payload?: Record<string, unknown>) => void
  /** Test seams (production uses the real impls). */
  buildOffer?: typeof buildInterviewOffer
  sendSms?: typeof sendRuntimeApprovedIMessage
  /** env for the flag emergency override (defaults to process.env). */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
}

/**
 * Opt-out gate — mirrors proactive.ts isOptedOut semantics (global kill-switch +
 * per-user lifecycle/outreach status). Fail-soft reads; a read error does NOT
 * block (the commit already happened) but the eligibility gate + idempotency
 * still bound the blast radius. Returns true when we must NOT proactively message.
 */
async function isOptedOut(
  db: Firestore,
  userId: string,
  log: (event: string, payload?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    const control = await readOutreachStopControl(db, { scope: "global" })
    if (control.paused) {
      log("pa.scheduling.invite.gate.global_paused", { userId })
      return true
    }
  } catch (err) {
    log("pa.scheduling.invite.gate.stop_control_read_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
    const data = snap.exists ? (snap.data() ?? {}) : {}
    const lifecycle = data.candidateLifecycle as { state?: string } | undefined
    const state =
      (typeof data.candidateLifecycleState === "string"
        ? (data.candidateLifecycleState as string)
        : undefined) ?? lifecycle?.state
    if (state === "opted_out" || state === "deleted") {
      log("pa.scheduling.invite.gate.lifecycle_opted_out", { userId, state })
      return true
    }
    const outreach = data.outreach as { status?: string } | undefined
    if (outreach?.status === "opted_out" || outreach?.status === "paused") {
      log("pa.scheduling.invite.gate.outreach_status", { userId, status: outreach.status })
      return true
    }
  } catch (err) {
    log("pa.scheduling.invite.gate.user_read_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return false
}

/** Deterministic invite copy — Claire's voice, real slots, no internal jargon. */
export function composeSchedulingInviteText(slots: Array<{ label: string }>): string[] {
  const lines = slots.slice(0, 4).map((s, i) => `${i + 1}. ${s.label}`)
  const bubble1 = "Good news — you're moving to a first interview! Here are some times that work:"
  const bubble2 = `${lines.join("\n")}\n\nReply with the number that works and I'll lock it in.`
  return [bubble1, bubble2]
}

/**
 * Send (idempotently, fail-open) a proactive interview invite for a just-committed
 * PASS. Safe to call unconditionally after the commit — every non-eligible / opted-out
 * / already-invited / no-slots path returns a `sent:false` reason and sends NOTHING.
 */
export async function sendProactiveSchedulingInvite(
  args: SendProactiveSchedulingInviteArgs,
): Promise<ProactiveSchedulingInviteOutcome> {
  const log = args.log ?? (() => {})
  const { db, candidateId, jobId, toE164, sessionId, nowIso } = args
  const env = args.env ?? process.env
  const buildOffer = args.buildOffer ?? buildInterviewOffer
  const sendSms = args.sendSms ?? sendRuntimeApprovedIMessage

  try {
    if (!toE164 || !toE164.trim()) {
      log("pa.scheduling.invite.skip", { candidateId, jobId, reason: "no_phone" })
      return { sent: false, reason: "error" }
    }

    // GATE 1 — eligibility (dev uids OR paSchedulingEnabled flag). Default = dev-only.
    if (!(await isSchedulingEligible(db, candidateId, { env }))) {
      log("pa.scheduling.invite.gated", { candidateId, jobId })
      return { sent: false, reason: "not_eligible" }
    }

    // GATE 2 — opt-out (never proactively message an opted-out candidate).
    if (await isOptedOut(db, candidateId, log)) {
      return { sent: false, reason: "opted_out" }
    }

    // GATE 3 — idempotency stamp (cheap pre-check before any Cal.com call).
    const sessionRef = db.collection(PRESCREEN_SESSIONS_COLLECTION).doc(sessionId)
    try {
      const snap = await sessionRef.get()
      const data = snap.exists ? (snap.data() ?? {}) : {}
      if (typeof data.schedulingInviteSentAt === "string" && data.schedulingInviteSentAt) {
        log("pa.scheduling.invite.already_invited", { candidateId, jobId, sessionId })
        return { sent: false, reason: "already_invited" }
      }
    } catch (err) {
      // Read failure → fall through; the deterministic outbound idempotency key
      // below is the hard backstop against a double-send.
      log("pa.scheduling.invite.stamp_read_failed", {
        candidateId,
        jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // BUILD the real Cal.com offer (SDK-free; same path as offer_interview_slots).
    // ctx.jobId is set so the offer keys to THIS committed job's booking doc.
    const ctx: ClaireToolContext = {
      db,
      userId: candidateId,
      sessionId,
      jobId,
      lang: "en",
      transport: {} as ClaireToolContext["transport"],
      judgeModel: "scheduling-invite",
      toE164,
      log,
      nowIso: () => nowIso,
    }
    const offer = await buildOffer(ctx, { timeZone: null, partOfDay: null, jobChoice: jobId })
    if (!offer.ok || offer.slots.length === 0) {
      // calcom_unavailable / no_slots / no_schedulable_job / needs_job_choice → no
      // invite this round (fail-open). The candidate can still start scheduling
      // reactively (they text back) — we just didn't pre-empt it.
      log("pa.scheduling.invite.no_offer", {
        candidateId,
        jobId,
        reason: offer.ok ? "empty" : offer.reason,
      })
      return { sent: false, reason: "no_offer" }
    }

    // SEND — deterministic idempotency key keyed on (job, candidate). Two bubbles
    // queue under distinct keys so each is single-send; a re-commit re-derives the
    // SAME keys → enqueueOutbound returns the existing row (created:false), never a
    // second iMessage.
    const bubbles = composeSchedulingInviteText(offer.slots)
    let outboundId: string | undefined
    let anySent = false
    for (let i = 0; i < bubbles.length; i++) {
      try {
        const res = await sendSms({
          db,
          userId: candidateId,
          to: toE164,
          content: bubbles[i]!,
          runtimeSource: "pa_proactive_scheduling_invite",
          idempotencyKey: `scheduling_invite:${jobId}:${candidateId}:b${i}`,
        })
        anySent = true
        if (i === 0 && typeof res.outboundId === "string") outboundId = res.outboundId
      } catch (err) {
        log("pa.scheduling.invite.send_failed", {
          candidateId,
          jobId,
          bubble: i,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (!anySent) return { sent: false, reason: "send_failed" }

    // STAMP the session so a later re-commit short-circuits (best-effort; the
    // deterministic outbound key already guarantees single-send).
    try {
      await sessionRef.set(
        {
          schedulingInviteSentAt: nowIso,
          ...(outboundId ? { schedulingInviteOutboundId: outboundId } : {}),
          updatedAt: nowIso,
        },
        { merge: true },
      )
    } catch (err) {
      log("pa.scheduling.invite.stamp_write_failed", {
        candidateId,
        jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    log("pa.scheduling.invite.sent", { candidateId, jobId, slotCount: offer.slots.length })
    return { sent: true, ...(outboundId ? { outboundId } : {}), slotCount: offer.slots.length }
  } catch (err) {
    // Belt-and-suspenders: this function must NEVER throw into the commit path.
    log("pa.scheduling.invite.error", {
      candidateId,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false, reason: "error" }
  }
}
