/**
 * pa-interview-bookings — Cal.com-backed interview booking contract.
 *
 * One doc = one interview-booking lifecycle for a (candidate × job) pair. The
 * thin-Claire `offer_interview_slots` tool upserts the `offered` row (the
 * persisted `offeredSlots[]` is what a 1-based `slotNumber` resolves against on
 * the NEXT turn); `book_interview_slot` transitions the SAME doc
 * `offered` → `booked` → `confirmed`.
 *
 * Storage: `PA_COLLECTIONS.interviewBookings` ("pa-interview-bookings").
 *
 * Doc-id namespace collision note (LOCKED): the legacy `schedule_interview`
 * tool (matching-tools.ts) ALSO writes this collection, with doc id
 * `booking-${userId}__${jobId}` and a strict SUBSET of these fields
 * `{ bookingId, userId, jobId, slotIso, status:"requested", sessionId, createdAt }`.
 * The Cal.com tools use the DISTINCT `calbk-` doc-id namespace
 * (`interviewBookingDocId`) so the two producers never clobber each other. This
 * superset schema validates docs of either convention (the legacy fields are a
 * subset), so a single schema covers the whole collection. The legacy
 * `requested` status is NOT part of this enum — that producer writes a subset
 * doc and is intentionally NOT validated through `InterviewBookingSchema`.
 *
 * Invariants (mirrors v2.0 product rules):
 *  - `userId` is the internal pa-users doc id, NEVER raw PII.
 *  - State transitions are owned by deterministic reducers (the tool's
 *    `execute`), NEVER the LLM. The LLM only proposes slotNumber/partOfDay/tz.
 *  - `offeredSlots[]` is ordered exactly as presented to the candidate; a
 *    1-based `slotNumber` resolves to `offeredSlots[slotNumber-1].iso`.
 */

import { z } from "zod"

/** Lifecycle of a Cal.com-backed interview booking. */
export const InterviewBookingStatusSchema = z.enum([
  "offered", // slots presented to the candidate this/last turn; awaiting their pick
  "booked", // POST /bookings accepted; Cal.com booking created
  "confirmed", // our WeKruit Mailgun confirmation email sent (booked + emailed)
  "failed", // booking attempt failed (4xx) — recoverable, candidate can retry
  // Post-confirmation lifecycle (additive — never reached by the Cal.com tools
  // themselves; written by downstream interview-outcome producers / ops). The
  // booking still "dead-ended" at confirmed for the booking tools; these extend
  // the lifecycle so an interview can be marked done / missed / cancelled.
  "completed", // the interview took place
  "no_show", // candidate did not attend the booked interview
  "cancelled", // the booked interview was cancelled (either side)
])
export type InterviewBookingStatus = z.infer<typeof InterviewBookingStatusSchema>

/**
 * One slot we offered, in the order we listed it. `slotNumber` (1-based) is the
 * index into the booking doc's `offeredSlots[]`.
 */
export const OfferedSlotSchema = z.object({
  /** exact ISO string Cal returned (w/ offset) — what we POST back verbatim. */
  iso: z.string().min(1),
  /** "YYYY-MM-DD" bucket. */
  date: z.string().min(1),
})
export type OfferedSlot = z.infer<typeof OfferedSlotSchema>

/**
 * Canonical persisted shape of a `pa-interview-bookings` (Cal.com) document.
 *
 * `id` MUST equal the Firestore doc id (the deterministic key built by
 * `interviewBookingDocId`).
 */
export const InterviewBookingSchema = z.object({
  /** == doc id (interviewBookingDocId). */
  id: z.string().min(1),
  /** pa-users doc id (internal; never raw PII). */
  userId: z.string().min(1),
  /** the opportunity this interview is for. */
  jobId: z.string().min(1),
  status: InterviewBookingStatusSchema,
  /** Cal.com event type used for slots + booking. */
  eventTypeId: z.number().int().positive(),
  /** IANA tz used for slots + the booking attendee + human labels. */
  timeZone: z.string().min(1),
  // OFFER state — persisted so slotNumber resolves to the exact ISO next turn:
  offeredSlots: z.array(OfferedSlotSchema).default([]),
  offeredAt: z.string().min(1).nullable(),
  /**
   * High-entropy per-offer token used to authorize an UNAUTHENTICATED public
   * "book this time" email link (paBookInterviewViaLink). The link carries
   * `t=<offerToken>`; the public CF constant-time-compares it to this field
   * before booking. Re-offers REUSE the existing token (so prior emailed links
   * stay valid). Optional + nullable so legacy docs (and loadBooking's
   * `InterviewBookingSchema.partial().safeParse`) don't drop it.
   */
  offerToken: z.string().min(1).nullable().optional(),
  // BOOK state:
  selectedSlotIso: z.string().min(1).nullable(),
  calBookingId: z.number().int().nullable(),
  calBookingUid: z.string().min(1).nullable(),
  /**
   * Video-call join URL (e.g. Google Meet) parsed from the Cal booking response.
   * Surfaced in BOTH the confirmation email and the iMessage lock-in bubble.
   * Optional + nullable: absent on legacy docs and on bookings where Cal returned
   * no parseable join URL.
   */
  meetingUrl: z.string().min(1).nullable().optional(),
  // CONFIRM (email) state:
  confirmationEmailSentAt: z.string().min(1).nullable(),
  confirmationEmailMessageId: z.string().min(1).nullable(),
  /** resolved email used for the booking. */
  candidateEmail: z.string().min(1).nullable(),
  // failure trail:
  lastError: z.string().min(1).nullable(),
  // bookkeeping:
  sessionId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  version: z.number().int().nonnegative(),
})
export type InterviewBooking = z.infer<typeof InterviewBookingSchema>

/**
 * Sanitize a free-form id segment to a Firestore-safe slug. CASE-PRESERVING:
 * replaces anything that is not `[A-Za-z0-9]` with `-`, collapses repeats, and
 * trims leading/trailing `-`. Case is RETAINED so two Firebase auto-ids that
 * differ ONLY by letter-case map to DISTINCT booking docs (see
 * `interviewBookingDocId`). MUST stay byte-identical to the `slugifySegment`
 * copy in `apps/functions/scripts/migrate-interview-bookings-docid-case.mjs`.
 */
function slugifySegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
}

/**
 * Cal.com booking doc id — `calbk-${userId}__${jobId}` (slugified). DISTINCT
 * namespace from the legacy `booking-...` doc id so the two producers never
 * collide. One booking doc per (user × job).
 *
 * CASE-SENSITIVITY (LOCKED 2026-06-26): `slugifySegment` PRESERVES letter-case,
 * so two distinct case-sensitive Firebase auto-ids that differ ONLY by case map
 * to DISTINCT booking docs — matching the case-sensitive `pa-users` / `pa-jobs`
 * id space and the sibling builders `createCandidateJobStateId` /
 * `safeInternalIdPart` (marketplace.ts). An earlier revision LOWERCASED here,
 * which folded case and (theoretically) let two distinct ids share one doc; the
 * one-shot `scripts/migrate-interview-bookings-docid-case.mjs` rewrote the
 * lowercased legacy docs to this case-preserving scheme. Do NOT reintroduce
 * `.toLowerCase()` in the id path without re-migrating existing docs (it would
 * orphan every doc whose source ids contain uppercase).
 */
export function interviewBookingDocId(args: { userId: string; jobId: string }): string {
  return `calbk-${slugifySegment(args.userId)}__${slugifySegment(args.jobId)}`
}
