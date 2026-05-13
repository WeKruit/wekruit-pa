import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createCandidateJobStateId, createOutboundInviteId, PA_COLLECTIONS } from "@pa/core-types"
import { MockFirestore, asFirestore } from "../../job-rec/__tests__/mock-firestore.js"
import { runAdminOutreachOpsSnapshot } from "../admin.js"
import { now } from "./fixtures.js"

describe("runAdminOutreachOpsSnapshot", () => {
  it("projects typed invite rows with summary and capacity evidence", async () => {
    const mfs = new MockFirestore()
    const inviteId = createOutboundInviteId({
      candidateId: "cand-1",
      jobId: "job-1",
      matchId: "cand-1__job-1",
    })
    await mfs.collection(PA_COLLECTIONS.outboundInvites).doc(inviteId).set({
      inviteId,
      candidateId: "cand-1",
      jobId: "job-1",
      candidateJobStateId: createCandidateJobStateId("cand-1", "job-1"),
      matchId: "cand-1__job-1",
      status: "blocked",
      policyDecision: "blocked",
      approvalState: "pending",
      dryRun: true,
      policyVersion: "s6-outreach-policy-v1",
      decisionReason: "capacity blocked",
      blockedSignals: ["channel_capacity"],
      capacitySnapshot: {
        groupId: "group-1",
        fromNumber: "+15555550100",
        status: "active",
        dailyCap: 1,
        usedToday: 1,
        remainingToday: 0,
        checkedAt: now,
      },
      createdAt: now,
    })
    await mfs.collection(PA_COLLECTIONS.jobs).doc("job-1").set({
      roleTitle: "Product Designer",
      companyName: "Invoko",
    })

    const snapshot = await runAdminOutreachOpsSnapshot(
      { jobId: "job-1", limit: 10 },
      { db: asFirestore(mfs), now: () => now }
    )

    assert.equal(snapshot.summary.totalInvites, 1)
    assert.equal(snapshot.summary.blocked, 1)
    assert.equal(snapshot.summary.pendingApproval, 1)
    assert.equal(snapshot.summary.capacityBlocked, 1)
    assert.equal(snapshot.invites[0]!.candidateDisplayName, "cand-1")
    assert.equal(snapshot.invites[0]!.jobTitle, "Product Designer")
    assert.equal(snapshot.invites[0]!.companyName, "Invoko")
    assert.equal(snapshot.capacity[0]!.remainingToday, 0)
    assert.equal(snapshot.jobs[0]!.jobId, "job-1")
  })

  it("filters by status and approval state after reading S6 rows", async () => {
    const mfs = new MockFirestore()
    for (const [id, status, approvalState] of [
      ["one", "draft", "pending"],
      ["two", "queued", "approved"],
    ] as const) {
      await mfs.collection(PA_COLLECTIONS.outboundInvites).doc(id).set({
        inviteId: id,
        candidateId: id,
        jobId: "job-1",
        candidateJobStateId: createCandidateJobStateId(id, "job-1"),
        status,
        policyDecision: status === "queued" ? "auto_outbound" : "hitl_review",
        approvalState,
        dryRun: status !== "queued",
        policyVersion: "s6-outreach-policy-v1",
        decisionReason: "fixture",
        blockedSignals: approvalState === "pending" ? ["hitl_required"] : [],
        createdAt: now,
      })
    }

    const snapshot = await runAdminOutreachOpsSnapshot(
      { status: "queued", approvalState: "approved", limit: 10 },
      { db: asFirestore(mfs), now: () => now }
    )
    assert.equal(snapshot.invites.length, 1)
    assert.equal(snapshot.invites[0]!.status, "queued")
    assert.equal(snapshot.summary.queued, 1)
  })
})
