import { z } from "zod"
import type { ConnectorContext, ConnectorDef } from "./connector-types.js"

/**
 * P7 — the SCALING-PROPERTY proof. A brand-new capability added as a PURE
 * registry addition: this ConnectorDef + one line in `connectorRegistry`
 * (packages/pa-connectors/src/index.ts) makes the agent route to it by
 * description — ZERO changes to the agent loop, the run adapter, or any router.
 *
 * `execute` = REDUCER (deterministic): dedup (scheduling no-rebook, lock #5) +
 * state commit (pa-interview-bookings) + idempotency key + structured verdict
 * `{ ok, action, reason, detail }` the LLM narrates ("tell them").
 */

// Strict-compatible schema (P5 lesson): `.nullable()` not `.optional()` so the
// @openai/agents SDK can expose it under Responses strict function-calling.
const ScheduleInterviewInputSchema = z.object({
  jobId: z.string().nullable(),
  preferredWindows: z.array(z.string()).nullable(),
  timezone: z.string().nullable(),
})

const ScheduleInterviewOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("schedule-interview"),
  action: z.enum(["committed", "deduped", "redirected", "done"]),
  reason: z.string().nullable(),
  detail: z.object({
    bookingId: z.string().nullable(),
    priorBookingId: z.string().nullable(),
    requestedWindows: z.array(z.string()),
  }),
  summary: z.string(),
})

export type ScheduleInterviewInput = z.infer<typeof ScheduleInterviewInputSchema>
export type ScheduleInterviewOutput = z.infer<typeof ScheduleInterviewOutputSchema>

export const SCHEDULE_INTERVIEW_CONNECTOR: ConnectorDef<ScheduleInterviewInput, ScheduleInterviewOutput> = {
  name: "schedule-interview",
  version: "1",
  // Hermes-style routing boundary: WHAT + verbatim triggers (EN+ZH) + "Do NOT call".
  description:
    "Book the candidate's first interview / pre-screen time slot for a specific job. " +
    "CALL THIS when the user wants to schedule / book / set up an interview or screen, or offers their availability — " +
    'e.g. "schedule my interview", "book me in for the screen", "set up a time", "when can I interview?", ' +
    '"帮我约个面试时间", "什么时候能面试". ' +
    "Do NOT call for general job search (use find-match), for casual chat, or to change an already-confirmed booking unless the user explicitly asks to reschedule.",
  inputSchema: ScheduleInterviewInputSchema,
  outputSchema: ScheduleInterviewOutputSchema,
  expectedLatencyMs: 800,
  execute: async (input: ScheduleInterviewInput, ctx: ConnectorContext): Promise<ScheduleInterviewOutput> => {
    const jobId = (input.jobId ?? "").trim() || "unknown_job"
    // idempotency / candidate×job state id — also the no-rebook dedup key.
    const bookingId = `booking-${ctx.userId}__${jobId}`
    const requestedWindows = (input.preferredWindows ?? []).map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
    const ref = ctx.db.collection("pa-interview-bookings").doc(bookingId)

    // Atomic dedup + commit-once. The existence check AND the write happen in
    // ONE transaction so two concurrent same-user×job turns can't both read
    // "absent" and double-book (a plain get()-then-set() was racy). Firestore
    // serializes the txn on the doc; the loser retries, sees the booking, and
    // dedups. Returns true iff THIS turn created the booking.
    const committed = await ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists) return false
      tx.set(ref, {
        bookingId,
        userId: ctx.userId,
        jobId,
        requestedWindows,
        timezone: input.timezone ?? null,
        status: "requested",
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
        createdAt: new Date().toISOString(),
      })
      return true
    })

    if (!committed) {
      // DEDUP — scheduling no-rebook. The LLM narrates this verdict to the user.
      return {
        ok: true,
        source: "schedule-interview",
        action: "deduped",
        reason: "already_booked",
        detail: { bookingId, priorBookingId: bookingId, requestedWindows },
        summary: "You already have an interview booked for this role — I didn't double-book.",
      }
    }

    return {
      ok: true,
      source: "schedule-interview",
      action: "committed",
      reason: null,
      detail: { bookingId, priorBookingId: null, requestedWindows },
      summary: requestedWindows.length
        ? `Got your interview request in (${requestedWindows.length} time${requestedWindows.length === 1 ? "" : "s"} noted) — I'll confirm the slot.`
        : "Got your interview request in — I'll confirm a slot.",
    }
  },
}
