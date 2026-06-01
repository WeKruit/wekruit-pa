// @ts-nocheck - runs with node --test via tsx.
import assert from "node:assert/strict"
import test from "node:test"

import { recruiterNotificationInboxMeta } from "./recruiter-inbox.js"

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
