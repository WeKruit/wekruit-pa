import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildSubmissionAdminReviewSummary,
  buildSubmissionChecklistReview,
} from "../RecruiterSubmissionReview.helpers.js"

describe("buildSubmissionChecklistReview", () => {
  const role = {
    recruiterBoard: {
      checklist: {
        groups: [
          {
            kind: "hard",
            heading: "Hard filters",
            items: [
              { id: "hard-publications", text: "Publication record at top venues" },
              { id: "hard-training", text: "Hands-on post-training work" },
            ],
          },
          {
            kind: "anti",
            heading: "Anti-signals",
            items: [
              { id: "anti-remote-only", text: "Wants remote-only" },
            ],
          },
        ],
      },
    },
  }

  it("maps submitted checklist ids back to readable role requirement text", () => {
    const review = buildSubmissionChecklistReview({
      checklist: {
        "hard-publications": true,
        "hard-training": false,
        "anti-remote-only": true,
        "legacy-checked-id": true,
      },
    }, role)

    assert.equal(review.hasReadableChecklist, true)
    assert.equal(review.checkedTotal, 2)
    assert.equal(review.total, 3)
    assert.deepEqual(review.missingHard.map((item) => item.text), ["Hands-on post-training work"])
    assert.deepEqual(review.antiFlags.map((item) => item.text), ["Wants remote-only"])
    assert.deepEqual(review.orphanCheckedIds, ["legacy-checked-id"])
  })

  it("returns a review-ready summary when consent and hard proof are clean", () => {
    const review = buildSubmissionChecklistReview({
      candidateConsentStatus: "candidate_confirmed",
      status: "reviewing",
      checklist: {
        "hard-publications": true,
        "hard-training": true,
      },
    }, role)
    const summary = buildSubmissionAdminReviewSummary({
      candidateConsentStatus: "candidate_confirmed",
      status: "reviewing",
    }, review)

    assert.equal(summary.title, "Ready for WeKruit review")
    assert.equal(summary.tone, "info")
  })

  it("prioritizes missing consent before checklist verdicts", () => {
    const review = buildSubmissionChecklistReview({
      candidateConsentStatus: "pending_candidate_confirmation",
      checklist: {
        "hard-publications": false,
        "hard-training": false,
      },
    }, role)
    const summary = buildSubmissionAdminReviewSummary({
      candidateConsentStatus: "pending_candidate_confirmation",
    }, review)

    assert.equal(summary.title, "Await candidate consent")
    assert.equal(summary.tone, "info")
  })
})
