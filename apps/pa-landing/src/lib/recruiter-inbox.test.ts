// @ts-nocheck - runs with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"

import { recruiterNotificationInboxMeta } from "./recruiter-inbox.js"

test("recruiterNotificationInboxMeta routes candidate calibration to the candidate workspace", () => {
  assert.deepEqual(recruiterNotificationInboxMeta("candidate_calibration"), {
    typeLabel: "Candidate calibration",
    unreadBucket: "Unread candidate calibration",
    action: "candidates",
    cta: "Open candidate",
    readTone: "info",
  })
})

test("recruiterNotificationInboxMeta routes candidate confirmation into the submission tracker", () => {
  assert.deepEqual(recruiterNotificationInboxMeta("candidate_confirmation"), {
    typeLabel: "Candidate confirmation",
    unreadBucket: "Unread candidate confirmation",
    action: "submissions",
    cta: "Track submission",
    readTone: "success",
  })
})

test("recruiterNotificationInboxMeta routes payout updates into earnings", () => {
  assert.deepEqual(recruiterNotificationInboxMeta("payout_update"), {
    typeLabel: "Payout update",
    unreadBucket: "Unread payout update",
    action: "earnings",
    cta: "Open earnings",
    readTone: "success",
  })
})

test("recruiterNotificationInboxMeta routes role-question answers back to roles", () => {
  assert.deepEqual(recruiterNotificationInboxMeta("role_question_answer"), {
    typeLabel: "Role answer returned",
    unreadBucket: "Unread role answer",
    action: "roles",
    cta: "Open answer",
    readTone: "info",
  })
})

test("recruiterNotificationInboxMeta keeps submission feedback in the submission tracker", () => {
  assert.deepEqual(recruiterNotificationInboxMeta("submission_feedback"), {
    typeLabel: "Submission notification",
    unreadBucket: "Unread submission feedback",
    action: "submissions",
    cta: "Review submission",
    readTone: "info",
  })
})
