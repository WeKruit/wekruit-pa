import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildRecruiterRoleOpsRows } from "../RecruiterRoleOps.helpers.js"

function readyRole(id: string, title: string) {
  return {
    id,
    publicId: id,
    title,
    compSummary: "$20k referral fee",
    wekruitCollaborationStatus: "collaborated",
    recruiterBoard: {
      active: true,
      sortOrder: 1,
      label: { company: "Acme", location: "New York" },
      interviewProcess: "Intro, technical, final",
      culture: { bet: "High-trust founding team", bullets: ["Fast feedback"] },
      checklist: {
        groups: [
          { kind: "hard", heading: "Hard checks", items: [{ id: "hard-1", text: "5+ years backend" }] },
          { kind: "fit", heading: "Fit checks", items: [{ id: "fit-1", text: "Startup ownership" }] },
        ],
      },
    },
  }
}

describe("buildRecruiterRoleOpsRows activation stages", () => {
  it("turns recruiter role activity into a deterministic marketplace activation stage", () => {
    const rows = buildRecruiterRoleOpsRows({
      jobs: [
        readyRole("role-no-access", "Needs recruiter coverage"),
        readyRole("role-no-supply", "Needs sourced supply"),
        readyRole("role-ready-no-submission", "Needs submission"),
        readyRole("role-review-queue", "Needs WeKruit review"),
        readyRole("role-moving", "Candidate moving"),
      ],
      applications: [
        { id: "app-1", jobId: "role-no-supply", recruiterId: "rec-1", status: "approved" },
        { id: "app-2", jobId: "role-ready-no-submission", recruiterId: "rec-2", status: "approved" },
        { id: "app-3", jobId: "role-review-queue", recruiterId: "rec-3", status: "approved" },
        { id: "app-4", jobId: "role-moving", recruiterId: "rec-4", status: "approved" },
      ],
      candidates: [
        { id: "cand-1", jobId: "role-ready-no-submission", recruiterId: "rec-2", stage: "ready" },
        { id: "cand-2", jobId: "role-review-queue", recruiterId: "rec-3", stage: "submitted" },
        { id: "cand-3", jobId: "role-moving", recruiterId: "rec-4", stage: "submitted" },
      ],
      submissions: [
        { id: "sub-1", jobId: "role-review-queue", recruiterId: "rec-3", status: "submitted" },
        { id: "sub-2", jobId: "role-moving", recruiterId: "rec-4", status: "advanced" },
      ],
      feedback: [],
      questions: [],
    })

    const byId = new Map(rows.map((row) => [row.id, row]))

    assert.equal(byId.get("role-no-access")?.activationStage, "needs_recruiter_coverage")
    assert.match(byId.get("role-no-access")?.activationReason ?? "", /No approved recruiter/)

    assert.equal(byId.get("role-no-supply")?.activationStage, "needs_sourced_supply")
    assert.match(byId.get("role-no-supply")?.activationReason ?? "", /approved recruiter.*no active sourced/i)

    assert.equal(byId.get("role-ready-no-submission")?.activationStage, "needs_submission")
    assert.match(byId.get("role-ready-no-submission")?.activationReason ?? "", /ready candidate.*no submission/i)

    assert.equal(byId.get("role-review-queue")?.activationStage, "needs_review")
    assert.match(byId.get("role-review-queue")?.activationReason ?? "", /pending submission/i)

    assert.equal(byId.get("role-moving")?.activationStage, "moving")
    assert.match(byId.get("role-moving")?.activationReason ?? "", /advanced/i)
  })
})
