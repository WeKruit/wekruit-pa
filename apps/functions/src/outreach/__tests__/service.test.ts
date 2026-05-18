import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createCandidateJobStateId } from "@pa/core-types"
import { planJobOutreach, renderOutreachInviteBody } from "../service.js"
import { candidate, capacity, invite, job, match, now } from "./fixtures.js"

describe("planJobOutreach", () => {
  it("dry-run persists invite decisions without enqueueing outbound rows", async () => {
    const writes: string[] = []
    const enqueues: string[] = []
    const result = await planJobOutreach(
      {
        job: job(),
        matches: [match()],
        candidatesById: { "cand-1": candidate() },
        capacityByCandidateId: { "cand-1": capacity() },
        now,
        dryRun: true,
        persistDecisions: true,
      },
      {
        reserveCapacity: async (input) => {
          assert.equal(input.reservationKey.length > 0, true)
          return capacity({
            capacitySnapshot: {
              groupId: input.groupId,
              fromNumber: input.fromNumber,
              status: input.status,
              dailyCap: input.dailyCap,
              usedToday: 2,
              remainingToday: 8,
              checkedAt: input.checkedAt,
            },
          })
        },
        writeInviteDecision: async (outboundInvite) => {
          writes.push(outboundInvite.inviteId)
          return { invite: outboundInvite, created: true, idempotent: false, auditEventId: "audit-1" }
        },
        enqueueRuntimeInvite: async () => {
          enqueues.push("called")
          return { id: "runtime-1", created: true }
        },
      }
    )

    assert.equal(result.summary.total, 1)
    assert.equal(result.summary.queueEligible, 1)
    assert.equal(result.summary.queued, 0)
    assert.equal(writes.length, 1)
    assert.equal(enqueues.length, 0)
  })

  it("live approved path writes invite and hands the invite to runtime", async () => {
    const writes: string[] = []
    const enqueues: string[] = []
    const result = await planJobOutreach(
      {
        job: job(),
        matches: [match()],
        candidatesById: { "cand-1": candidate() },
        capacityByCandidateId: { "cand-1": capacity() },
        now,
        dryRun: false,
        persistDecisions: true,
        approvalMode: "approved",
      },
      {
        writeInviteDecision: async (outboundInvite) => {
          writes.push(outboundInvite.inviteId)
          return { invite: outboundInvite, created: true, idempotent: false, auditEventId: "audit-1" }
        },
        reserveCapacity: async () => capacity({
          capacitySnapshot: {
            ...capacity().capacitySnapshot,
            usedToday: 2,
            remainingToday: 8,
          },
        }),
        enqueueRuntimeInvite: async (input) => {
          enqueues.push(input.idempotencyKey)
          assert.equal(input.toE164, "+15555550123")
          assert.equal(input.context.inviteId.length > 0, true)
          assert.equal(input.context.jobTitle, "Product Designer")
          assert.equal(input.context.jobUrl, "https://candidate.wekruit.com/j/job-1")
          return { id: "runtime-1", created: true }
        },
      }
    )

    assert.equal(result.summary.queued, 1)
    assert.equal(writes.length, 1)
    assert.equal(enqueues.length, 1)
    assert.equal(result.rows[0]!.queuedRuntimeEventId, "runtime-1")
    assert.equal(result.rows[0]!.decision.capacitySnapshot?.usedToday, 2)
  })

  it("live approved path blocks before enqueue when transactional capacity reservation fails", async () => {
    const enqueues: string[] = []
    const result = await planJobOutreach(
      {
        job: job(),
        matches: [match()],
        candidatesById: { "cand-1": candidate() },
        capacityByCandidateId: { "cand-1": capacity() },
        now,
        dryRun: false,
        persistDecisions: true,
        approvalMode: "approved",
      },
      {
        reserveCapacity: async () => ({
          ok: false,
          groupId: "group-1",
          fromNumber: "+15555550100",
          reason: "channel_capacity",
          capacitySnapshot: {
            groupId: "group-1",
            fromNumber: "+15555550100",
            status: "active",
            dailyCap: 10,
            usedToday: 10,
            remainingToday: 0,
            checkedAt: now,
            reason: "capacity_full",
          },
        }),
        writeInviteDecision: async (outboundInvite) => {
          assert.equal(outboundInvite.status, "blocked")
          assert.equal(outboundInvite.policyDecision, "blocked")
          return { invite: outboundInvite, created: true, idempotent: false, auditEventId: "audit-1" }
        },
        enqueueRuntimeInvite: async () => {
          enqueues.push("called")
          return { id: "runtime-1", created: true }
        },
      }
    )

    assert.equal(result.summary.queued, 0)
    assert.equal(result.summary.blocked, 1)
    assert.equal(enqueues.length, 0)
  })

  it("live approved path blocks before capacity reservation when global outreach stop is paused", async () => {
    const enqueues: string[] = []
    const reserves: string[] = []
    const writes: string[] = []
    const result = await planJobOutreach(
      {
        job: job(),
        matches: [match()],
        candidatesById: { "cand-1": candidate() },
        capacityByCandidateId: { "cand-1": capacity() },
        now,
        dryRun: false,
        persistDecisions: true,
        approvalMode: "approved",
      },
      {
        readOutreachStopControl: async () => ({
          paused: true,
          reason: "launch readiness pause",
        }),
        reserveCapacity: async () => {
          reserves.push("called")
          return capacity()
        },
        writeInviteDecision: async (outboundInvite) => {
          writes.push(outboundInvite.inviteId)
          assert.equal(outboundInvite.status, "blocked")
          assert.equal(outboundInvite.policyDecision, "blocked")
          assert.deepEqual(outboundInvite.blockedSignals, ["global_outreach_stop"])
          return { invite: outboundInvite, created: true, idempotent: false, auditEventId: "audit-1" }
        },
        enqueueRuntimeInvite: async () => {
          enqueues.push("called")
          return { id: "runtime-1", created: true }
        },
      }
    )

    assert.equal(result.summary.queued, 0)
    assert.equal(result.summary.blocked, 1)
    assert.equal(writes.length, 1)
    assert.equal(reserves.length, 0)
    assert.equal(enqueues.length, 0)
  })

  it("blocked and HITL decisions write evidence but do not queue", async () => {
    const result = await planJobOutreach(
      {
        job: job(),
        matches: [
          match({ candidateId: "cand-1", recommendedAction: "hitl_review" }),
          match({ candidateId: "cand-2", jobId: "job-1", matchId: "cand-2__job-1", recommendedAction: "do_not_contact" }),
        ],
        candidatesById: {
          "cand-1": candidate({ candidateId: "cand-1" }),
          "cand-2": candidate({ candidateId: "cand-2" }),
        },
        capacityByCandidateId: {
          "cand-1": capacity(),
          "cand-2": capacity(),
        },
        now,
        dryRun: false,
        persistDecisions: true,
        approvalMode: "approved",
      },
      {
        writeInviteDecision: async (outboundInvite) => ({ invite: outboundInvite, created: true, idempotent: false, auditEventId: "audit" }),
        enqueueRuntimeInvite: async () => {
          throw new Error("blocked decisions must not enqueue")
        },
      }
    )

    assert.equal(result.summary.pendingApproval, 1)
    assert.equal(result.summary.blocked, 1)
    assert.equal(result.summary.queued, 0)
  })

  it("uses existing invite history to keep reruns idempotent", async () => {
    const existingInvite = invite({ status: "queued" })
    const result = await planJobOutreach(
      {
        job: job(),
        matches: [match()],
        candidatesById: { "cand-1": candidate() },
        capacityByCandidateId: { "cand-1": capacity() },
        existingInvitesByCandidateId: { "cand-1": [existingInvite] },
        now,
        dryRun: false,
        persistDecisions: true,
        approvalMode: "approved",
      },
      {
        writeInviteDecision: async (outboundInvite) => ({ invite: outboundInvite, created: false, idempotent: true, auditEventId: "audit" }),
        enqueueRuntimeInvite: async () => {
          throw new Error("duplicate rerun must not enqueue")
        },
      }
    )

    assert.equal(result.summary.duplicates, 1)
    assert.equal(result.summary.queued, 0)
  })
})

describe("renderOutreachInviteBody", () => {
  it("renders deterministic candidate-facing copy with the public job URL", () => {
    assert.equal(
      renderOutreachInviteBody({
        job: job({ jobTitle: "Product Designer", companyName: "Invoko" }),
        jobUrl: "https://candidate.wekruit.com/j/job-1",
      }),
      "Claire from WeKruit here. Invoko looks like a strong fit for Product Designer. Want to do the quick first interview? https://candidate.wekruit.com/j/job-1 Reply stop to pause outreach."
    )
  })
})
