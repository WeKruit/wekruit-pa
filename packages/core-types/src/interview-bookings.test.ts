import assert from "node:assert/strict"
import test from "node:test"

import {
  InterviewBookingSchema,
  InterviewBookingStatusSchema,
  OfferedSlotSchema,
  interviewBookingDocId,
} from "./interview-bookings.js"

test("InterviewBookingSchema round-trips a full confirmed doc", () => {
  const doc = {
    id: "calbk-u1__job-abc",
    userId: "u1",
    jobId: "job-abc",
    status: "confirmed" as const,
    eventTypeId: 5847961,
    timeZone: "America/New_York",
    offeredSlots: [
      { iso: "2026-06-02T09:00:00.000-04:00", date: "2026-06-02" },
      { iso: "2026-06-03T14:00:00.000-04:00", date: "2026-06-03" },
    ],
    offeredAt: "2026-06-01T12:00:00.000Z",
    selectedSlotIso: "2026-06-03T14:00:00.000-04:00",
    calBookingId: 123456,
    calBookingUid: "abc-uid",
    confirmationEmailSentAt: "2026-06-01T12:01:00.000Z",
    confirmationEmailMessageId: "<mg-id@wekruit.com>",
    candidateEmail: "cand@example.com",
    lastError: null,
    sessionId: "sess-1",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:01:00.000Z",
    version: 2,
  }
  const parsed = InterviewBookingSchema.parse(doc)
  assert.deepEqual(parsed, doc)
})

test("InterviewBookingSchema round-trips a minimal offered doc (defaulted offeredSlots)", () => {
  const doc = {
    id: "calbk-u2__job-xyz",
    userId: "u2",
    jobId: "job-xyz",
    status: "offered" as const,
    eventTypeId: 4508818,
    timeZone: "America/New_York",
    offeredSlots: [{ iso: "2026-06-05T11:00:00.000-04:00", date: "2026-06-05" }],
    offeredAt: "2026-06-01T12:00:00.000Z",
    selectedSlotIso: null,
    calBookingId: null,
    calBookingUid: null,
    confirmationEmailSentAt: null,
    confirmationEmailMessageId: null,
    candidateEmail: null,
    lastError: null,
    sessionId: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    version: 0,
  }
  const parsed = InterviewBookingSchema.parse(doc)
  assert.equal(parsed.status, "offered")
  assert.equal(parsed.offeredSlots.length, 1)
})

test("offeredSlots defaults to [] when omitted", () => {
  const parsed = InterviewBookingSchema.parse({
    id: "calbk-u3__job-1",
    userId: "u3",
    jobId: "job-1",
    status: "offered" as const,
    eventTypeId: 4508818,
    timeZone: "America/New_York",
    offeredAt: null,
    selectedSlotIso: null,
    calBookingId: null,
    calBookingUid: null,
    confirmationEmailSentAt: null,
    confirmationEmailMessageId: null,
    candidateEmail: null,
    lastError: null,
    sessionId: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    version: 0,
  })
  assert.deepEqual(parsed.offeredSlots, [])
})

test("InterviewBookingStatusSchema rejects a bad status", () => {
  assert.throws(() => InterviewBookingStatusSchema.parse("requested"))
  assert.equal(InterviewBookingStatusSchema.parse("booked"), "booked")
})

test("OfferedSlotSchema requires non-empty iso + date", () => {
  assert.throws(() => OfferedSlotSchema.parse({ iso: "", date: "2026-06-02" }))
  assert.throws(() => OfferedSlotSchema.parse({ iso: "x", date: "" }))
})

test("interviewBookingDocId is deterministic, slugified, calbk- namespaced", () => {
  const a = interviewBookingDocId({ userId: "8fEwIduUrzxZsblHHsNz", jobId: "hs-11005382-invoko" })
  const b = interviewBookingDocId({ userId: "8fEwIduUrzxZsblHHsNz", jobId: "hs-11005382-invoko" })
  assert.equal(a, b, "deterministic")
  assert.ok(a.startsWith("calbk-"), "calbk- namespace")
  // slugify lowercases + replaces non-[a-z0-9] with - and collapses repeats.
  assert.equal(
    interviewBookingDocId({ userId: "User_ID 1", jobId: "Job//ABC" }),
    "calbk-user-id-1__job-abc",
  )
  // distinct from the legacy booking- namespace.
  assert.notEqual(a.slice(0, 8), "booking-")
})
