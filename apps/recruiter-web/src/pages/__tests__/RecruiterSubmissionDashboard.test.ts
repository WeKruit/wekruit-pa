import assert from "node:assert/strict"
import test from "node:test"

import {
  buildRecruiterSubmissionDashboard,
  submissionIsConfirmedActiveReview,
  submissionIsConfirmedOpen,
} from "../RecruiterSubmissionDashboard.helpers.js"

test("submission dashboard separates consent-blocked packets from active WeKruit review", () => {
  const dashboard = buildRecruiterSubmissionDashboard([
    { id: "pending-consent", status: "submitted", candidateConsentStatus: "pending_candidate_confirmation" },
    { id: "failed-consent", status: "reviewing", candidateConsentStatus: "confirmation_email_failed" },
    { id: "ready-review", status: "reviewing", candidateConsentStatus: "candidate_confirmed" },
    { id: "advanced", status: "advanced", candidateConsentStatus: "candidate_confirmed" },
  ])

  assert.deepEqual(
    dashboard.hero.map((item) => [item.label, item.value]),
    [
      ["Consent blocked", "2"],
      ["Active review", "1"],
      ["Advanced", "1"],
      ["Needs action", "2"],
    ],
  )
  assert.equal(dashboard.consentBlocked.length, 2)
  assert.equal(dashboard.active.length, 1)
  assert.equal(dashboard.needsAction.length, 2)
})

test("submission metric predicates keep consent-blocked packets out of review and open movement counts", () => {
  const submissions = [
    { id: "pending-consent", status: "submitted", candidateConsentStatus: "pending_candidate_confirmation" },
    { id: "failed-consent", status: "reviewing", candidateConsentStatus: "confirmation_email_failed" },
    { id: "ready-review", status: "reviewing", candidateConsentStatus: "candidate_confirmed" },
    { id: "advanced", status: "advanced", candidateConsentStatus: "candidate_confirmed" },
    { id: "closed", status: "rejected", candidateConsentStatus: "candidate_confirmed" },
  ]

  assert.deepEqual(submissions.filter(submissionIsConfirmedActiveReview).map((submission) => submission.id), [
    "ready-review",
  ])
  assert.deepEqual(submissions.filter(submissionIsConfirmedOpen).map((submission) => submission.id), [
    "ready-review",
    "advanced",
  ])
})
