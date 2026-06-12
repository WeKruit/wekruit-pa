import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildRecruiterRoleOpsRows } from "../RecruiterRoleOps.helpers.js"

function readyRole(id: string, title: string, priority?: { rank?: number; tier?: string; note?: string; emailAudience?: string }) {
  return {
    id,
    publicId: id,
    title,
    compSummary: "$20k referral fee",
    wekruitCollaborationStatus: "collaborated",
    recruiterBoard: {
      active: true,
      sortOrder: 1,
      ...(priority ? { priority } : {}),
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

function roleWithBoardSort(
  id: string,
  title: string,
  sortOrder: number,
  priority?: { rank?: number; tier?: string; note?: string; emailAudience?: string },
) {
  const role = readyRole(id, title, priority)
  return { ...role, recruiterBoard: { ...role.recruiterBoard, sortOrder } }
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

  it("sorts active roles by explicit priority rank before board sort order", () => {
    const rows = buildRecruiterRoleOpsRows({
      jobs: [
        roleWithBoardSort("role-board-first", "Board first", 1),
        roleWithBoardSort("role-p2", "Priority two", 30, {
          rank: 2,
          tier: "high",
          note: "Second",
          emailAudience: "both",
        }),
        roleWithBoardSort("role-p1", "Priority one", 40, {
          rank: 1,
          tier: "urgent",
          note: "First",
          emailAudience: "recruiters",
        }),
      ],
      applications: [],
      candidates: [],
      submissions: [],
      feedback: [],
      questions: [],
    })

    assert.deepEqual(rows.map((row) => row.id), ["role-p1", "role-p2", "role-board-first"])
    assert.equal(rows[0]?.priorityRank, 1)
    assert.equal(rows[0]?.priorityTier, "urgent")
    assert.equal(rows[0]?.priorityNote, "First")
    assert.equal(rows[1]?.priorityEmailAudience, "both")
    assert.equal(rows[2]?.priorityRank, null)
    assert.equal(rows[2]?.prioritySort, 9999)
  })
})
