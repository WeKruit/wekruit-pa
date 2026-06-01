import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildRoleApplicationReview } from "../RecruiterApplicationReview.helpers.js"

describe("buildRoleApplicationReview", () => {
  it("recommends approval when a recruiter has prepared candidate proof", () => {
    const review = buildRoleApplicationReview({
      application: {
        id: "app-1",
        recruiterId: "recruiter-a",
        recruiterEmail: "a@example.com",
        jobId: "job-1",
        jobTitleSnapshot: "Founding Engineer",
        status: "pending",
        preparedCandidateIds: ["cand-1"],
        preparedCandidateCount: 1,
      },
      profiles: [{ id: "recruiter-a", email: "a@example.com", status: "active" }],
      submissions: [
        { id: "sub-1", recruiterId: "recruiter-a", status: "advanced", recruiterFeedbackRating: 4 },
        { id: "sub-2", recruiterId: "recruiter-a", status: "submitted", recruiterFeedbackRating: 3 },
      ],
      candidates: [
        {
          id: "cand-1",
          recruiterId: "recruiter-a",
          jobId: "job-1",
          stage: "ready",
          candidate: { name: "Ada", currentRole: "Staff Engineer", yoe: "8 years" },
        },
      ],
      applications: [],
    })

    assert.equal(review.recommendation, "approve")
    assert.equal(review.metrics.preparedCandidates, 1)
    assert.equal(review.metrics.readyPreparedCandidates, 1)
    assert.equal(review.preparedCandidates[0]?.label, "Ada")
  })

  it("recommends decline for low-rated recruiters without candidate proof", () => {
    const review = buildRoleApplicationReview({
      application: {
        id: "app-1",
        recruiterId: "recruiter-a",
        recruiterEmail: "a@example.com",
        jobId: "job-1",
        jobTitleSnapshot: "Founding Engineer",
        status: "pending",
      },
      profiles: [{ id: "recruiter-a", email: "a@example.com", status: "active" }],
      submissions: [
        { id: "sub-1", recruiterId: "recruiter-a", status: "rejected", recruiterFeedbackRating: 2 },
        { id: "sub-2", recruiterId: "recruiter-a", status: "duplicate", recruiterFeedbackRating: 2 },
        { id: "sub-3", recruiterId: "recruiter-a", status: "rejected", recruiterFeedbackRating: 1 },
      ],
      candidates: [],
      applications: [],
    })

    assert.equal(review.recommendation, "decline")
    assert.equal(review.risks.some((risk) => risk.includes("below the approval bar")), true)
  })

  it("accounts for role and recruiter load", () => {
    const applications = [
      { id: "app-0", recruiterId: "recruiter-a", jobId: "job-1", status: "pending" as const },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `pending-${index}`,
        recruiterId: "recruiter-a",
        jobId: `pending-job-${index}`,
        status: "pending" as const,
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `role-approved-${index}`,
        recruiterId: `other-${index}`,
        jobId: "job-1",
        status: "approved" as const,
      })),
    ]
    const review = buildRoleApplicationReview({
      application: applications[0]!,
      profiles: [{ id: "recruiter-a", email: "a@example.com", status: "active" }],
      submissions: [],
      candidates: [],
      applications,
    })

    assert.equal(review.metrics.pendingApplications, 3)
    assert.equal(review.metrics.sameRoleApprovedRecruiters, 8)
    assert.equal(review.risks.some((risk) => risk.includes("three other pending")), true)
    assert.equal(review.risks.some((risk) => risk.includes("enough recruiter coverage")), true)
  })
})
