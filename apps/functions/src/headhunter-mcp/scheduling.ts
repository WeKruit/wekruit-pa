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
 * actual booking is either the candidate's own Claire flow, or a future
 * book-on-behalf tool (book core extraction pending).
 */
import type { Firestore } from "firebase-admin/firestore"
import type { ClaireToolContext } from "../claire-agent/types.js"
import { buildInterviewOffer, type InterviewOfferResult } from "../claire-agent/tools/scheduling-tools.js"
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
