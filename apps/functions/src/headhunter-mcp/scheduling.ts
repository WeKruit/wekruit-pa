/**
 * headhunter-mcp/scheduling.ts — let the headhunter agent offer a candidate real
 * Cal.com interview slots (the schedule half of the autonomous loop).
 *
 * Reuses the SDK-free offer core `buildInterviewOffer` (the exact path the
 * candidate-facing Claire tool + the proactive HITL invite use), so the offer is
 * persisted to the SAME pa-interview-bookings doc the candidate's later slot pick
 * resolves against. Gated by `isSchedulingEligible` (dev cohort — Adam/Noah — or
 * the paSchedulingEnabled flag), so today it works for the dev user only.
 *
 * This OFFERS + records availability; it sends no SMS and books nothing. The
 * actual booking is either the candidate's own Claire flow, or the
 * book-on-behalf runner `runBookInterviewSlot` (below), which calls the SAME
 * SDK-free `bookInterviewSlotCore` the candidate book tool delegates to.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { ClaireToolContext } from "../claire-agent/types.js"
import {
  buildInterviewOffer,
  bookInterviewSlotCore,
  type InterviewOfferResult,
  type BookInterviewSlotResult,
} from "../claire-agent/tools/scheduling-tools.js"
import { isSchedulingEligible } from "../claire-agent/scheduling-gate.js"

export type ScheduleInterviewResult =
  | InterviewOfferResult
  | { ok: false; reason: "scheduling_not_enabled"; note: string }

export async function runScheduleInterview(
  input: {
    userId: string
    jobId?: string
    timeZone?: string
    partOfDay?: "morning" | "afternoon" | "evening" | "any"
  },
  deps: { db: Firestore },
): Promise<ScheduleInterviewResult> {
  if (!input.userId) {
    return { ok: false, reason: "scheduling_not_enabled", note: "missing userId" }
  }
  if (!(await isSchedulingEligible(deps.db, input.userId, { env: process.env }))) {
    return {
      ok: false,
      reason: "scheduling_not_enabled",
      note: "candidate is not in the scheduling dev cohort and the paSchedulingEnabled flag is off (today: dev users only, e.g. Adam)",
    }
  }
  // Minimal headhunter-side context for the SDK-free offer core. buildInterviewOffer
  // only reads db / userId / jobId / sessionId / log / nowIso; the messaging
  // `transport` is never touched on the offer path, so a partial cast is safe.
  const ctx = {
    db: deps.db,
    userId: input.userId,
    sessionId: `hh-sched-${input.userId}`,
    lang: "en" as const,
    judgeModel: "gpt-5.4-nano",
    jobId: input.jobId,
    log: () => undefined,
    nowIso: () => new Date().toISOString(),
  } as unknown as ClaireToolContext

  return buildInterviewOffer(ctx, {
    timeZone: input.timeZone ?? null,
    partOfDay: input.partOfDay ?? null,
    jobChoice: input.jobId ?? null,
  })
}

export type BookInterviewSlotRunResult =
  | BookInterviewSlotResult
  | { ok: false; reason: "scheduling_not_enabled"; note: string }
  | { ok: false; reason: "missing_userId"; note: string }
  | { ok: false; reason: "no_slot_selected"; note: string }
  | { ok: false; reason: "not_confirmed"; note: string }

/**
 * Book-on-behalf: confirm a candidate's chosen interview slot from the persisted
 * Cal.com offer and create a REAL booking + WeKruit confirmation email. This is
 * a CANDIDATE-FACING SIDE EFFECT (real calendar invite + email), so it is
 * confirm-gated: the headhunter tool must pass confirm:true (the agent persona
 * restates userId + slot to the operator first). A dry-run (confirm:false)
 * returns not_confirmed and books NOTHING.
 *
 * Reuses the EXACT SDK-free `bookInterviewSlotCore` the candidate book tool
 * delegates to (same offered-slot resolution, dedup/reschedule guards, Cal POST,
 * persistence, email), so a headhunter booking and the candidate's own Claire
 * flow are byte-identical at the Cal layer. Gated by `isSchedulingEligible` —
 * today only the dev cohort (Adam/Noah) passes; a real candidate silently
 * no-ops with scheduling_not_enabled until paSchedulingEnabled is ramped.
 *
 * The book core needs a slot reference; the operator passes slotNumber (1-based,
 * exactly as schedule_interview / get_scheduling_status listed them) OR the exact
 * slotIso. The job is recovered cross-turn from the candidate's live offer doc
 * (resolveActiveSchedulingJobId) when jobId is omitted, identical to the
 * candidate path — so a headhunter never has to thread the jobId through.
 */
export async function runBookInterviewSlot(
  input: {
    userId: string
    /** confirm-first: must be true to actually book. false/absent = dry-run, no write. */
    confirm?: boolean
    jobId?: string
    slotNumber?: number | null
    slotIso?: string | null
    candidateEmail?: string | null
    candidateName?: string | null
    timeZone?: string | null
  },
  deps: { db: Firestore },
): Promise<BookInterviewSlotRunResult> {
  if (!input.userId) {
    return { ok: false, reason: "missing_userId", note: "missing userId" }
  }
  if (typeof input.slotNumber !== "number" && !(input.slotIso ?? "").trim()) {
    return {
      ok: false,
      reason: "no_slot_selected",
      note: "pass slotNumber (1-based, as schedule_interview listed) or the exact slotIso the candidate was offered",
    }
  }
  if (!(await isSchedulingEligible(deps.db, input.userId, { env: process.env }))) {
    return {
      ok: false,
      reason: "scheduling_not_enabled",
      note: "candidate is not in the scheduling dev cohort and the paSchedulingEnabled flag is off (today: dev users only, e.g. Adam). No booking was created.",
    }
  }
  // Confirm-first: a dry-run NEVER touches Cal.com (no real interview, no email).
  if (input.confirm !== true) {
    return {
      ok: false,
      reason: "not_confirmed",
      note: "dry-run only — this books a REAL Cal.com interview AND emails the candidate. Restate the exact userId + slot to the operator, then call again with confirm:true.",
    }
  }
  // Minimal headhunter-side context for the SDK-free book core. bookInterviewSlotCore
  // reads ONLY db / userId / jobId / sessionId / nowIso / log / toE164? — never the
  // messaging `transport` — so a partial cast is safe. No toE164 → Cal attendee
  // books with no phone (intended for a book-on-behalf; the candidate's email +
  // calendar invite still go out). statedTime is intentionally NOT passed: the
  // operator picks the slot explicitly, so the AM/PM mismatch backstop is N/A.
  const ctx = {
    db: deps.db,
    userId: input.userId,
    sessionId: `hh-sched-${input.userId}`,
    lang: "en" as const,
    judgeModel: "gpt-5.4-nano",
    jobId: input.jobId,
    log: () => undefined,
    nowIso: () => new Date().toISOString(),
  } as unknown as ClaireToolContext

  return bookInterviewSlotCore(ctx, {
    slotNumber: input.slotNumber ?? null,
    slotIso: input.slotIso ?? null,
    statedTime: null,
    candidateEmail: input.candidateEmail ?? null,
    candidateName: input.candidateName ?? null,
    timeZone: input.timeZone ?? null,
  })
}
