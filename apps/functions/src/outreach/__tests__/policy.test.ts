import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createOutreachDuplicateSuppressionKey } from "@pa/core-types"
import { evaluateOutreachPolicy } from "../policy.js"
import { candidate, capacity, invite, job, match, now } from "./fixtures.js"

describe("evaluateOutreachPolicy", () => {
  it("allows live queueing for an approved auto_outbound retained candidate", () => {
    const decision = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate(),
      job: job(),
      capacity: capacity(),
      now,
      dryRun: false,
      approvalMode: "approved",
    })

    assert.equal(decision.policyDecision, "auto_outbound")
    assert.equal(decision.queueEligible, true)
    assert.equal(decision.allowQueue, true)
    assert.equal(decision.approvalState, "not_required")
    assert.equal(decision.status, "approved")
    assert.equal(decision.stickyAccountGroupId, "group-1")
  })

  it("keeps dry-run as a persisted decision without allowing queueing", () => {
    const decision = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate(),
      job: job(),
      capacity: capacity(),
      now,
      dryRun: true,
    })

    assert.equal(decision.queueEligible, true)
    assert.equal(decision.allowQueue, false)
    assert.equal(decision.status, "draft")
    assert.equal(decision.dryRun, true)
  })

  it("routes hitl_review to pending approval without queueing", () => {
    const decision = evaluateOutreachPolicy({
      match: match({ recommendedAction: "hitl_review", finalScore: 0.7 }),
      candidate: candidate(),
      job: job(),
      capacity: capacity(),
      now,
      dryRun: false,
      approvalMode: "approved",
    })

    assert.equal(decision.policyDecision, "hitl_review")
    assert.equal(decision.approvalState, "pending")
    assert.equal(decision.allowQueue, false)
    assert.deepEqual(decision.blockedSignals, ["hitl_required"])
  })

  it("blocks S5 do_not_contact and hard filters", () => {
    for (const m of [
      match({ recommendedAction: "do_not_contact" }),
      match({ hardFilterResult: "hard_block" }),
    ]) {
      const decision = evaluateOutreachPolicy({
        match: m,
        candidate: candidate(),
        job: job(),
        capacity: capacity(),
        now,
        dryRun: false,
        approvalMode: "approved",
      })
      assert.equal(decision.policyDecision, "do_not_contact")
      assert.equal(decision.allowQueue, false)
    }
  })

  it("blocks opted-out paused deleted and do-not-contact candidates", () => {
    const cases = [
      candidate({ candidateLifecycleState: "opted_out" }),
      candidate({ candidateLifecycleState: "deleted" }),
      candidate({ outreach: { status: "opted_out" } }),
      candidate({ outreach: { status: "paused" } }),
      candidate({ doNotContact: true }),
      candidate({ outreachPaused: true }),
    ]
    for (const c of cases) {
      const decision = evaluateOutreachPolicy({
        match: match(),
        candidate: c,
        job: job(),
        capacity: capacity(),
        now,
        dryRun: false,
        approvalMode: "approved",
      })
      assert.equal(decision.policyDecision, "blocked")
      assert.equal(decision.allowQueue, false)
    }
  })

  it("blocks live queueing without a reachable phone", () => {
    const decision = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate({ phoneE164: undefined, imessageChatId: "chat-cand-1", channels: { imessageHandle: "chat-cand-1" } }),
      job: job(),
      capacity: capacity(),
      now,
      dryRun: false,
      approvalMode: "approved",
    })

    assert.equal(decision.allowQueue, false)
    assert.equal(decision.blockedSignals.includes("unreachable"), true)
  })

  it("blocks active cooldown with a concrete cooldownUntil or recent last outbound", () => {
    const decision = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate({ outreach: { status: "cooldown", cooldownUntil: "2026-05-20T12:00:00.000Z" } }),
      job: job(),
      capacity: capacity(),
      now,
      dryRun: false,
      approvalMode: "approved",
    })

    assert.equal(decision.allowQueue, false)
    assert.equal(decision.cooldownUntil, "2026-05-20T12:00:00.000Z")
    assert.equal(decision.blockedSignals.includes("cooldown_active"), true)

    const recentOutbound = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate({ outreach: { status: "allowed", lastOutboundAt: "2026-05-12T12:00:00.000Z" } }),
      job: job(),
      capacity: capacity(),
      now,
      dryRun: false,
      approvalMode: "approved",
    })
    assert.equal(recentOutbound.allowQueue, false)
    assert.equal(recentOutbound.cooldownUntil, "2026-05-19T12:00:00.000Z")
    assert.equal(recentOutbound.blockedSignals.includes("cooldown_active"), true)
  })

  it("suppresses existing non-terminal invites and already advanced candidate-job states", () => {
    const existing = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate(),
      job: job(),
      capacity: capacity(),
      existingInvites: [invite({ status: "queued" })],
      now,
      dryRun: false,
      approvalMode: "approved",
    })
    assert.equal(existing.allowQueue, false)
    assert.equal(existing.blockedSignals.includes("duplicate_invite"), true)

    const advanced = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate(),
      job: job(),
      capacity: capacity(),
      candidateJobState: "outbound_sent",
      now,
      dryRun: false,
      approvalMode: "approved",
    })
    assert.equal(advanced.allowQueue, false)
    assert.equal(advanced.blockedSignals.includes("already_in_job_flow"), true)
  })

  it("blocks recent decline and same company role duplicate windows", () => {
    const declined = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate(),
      job: job(),
      capacity: capacity(),
      recentDeclines: [invite({ status: "declined", companyName: "Invoko", roleKey: "product-designer" })],
      now,
      dryRun: false,
      approvalMode: "approved",
    })
    assert.equal(declined.allowQueue, false)
    assert.equal(declined.blockedSignals.includes("recent_decline"), true)

    const duplicate = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate(),
      job: job(),
      capacity: capacity(),
      existingInvites: [
        invite({
          jobId: "job-2",
          duplicateSuppressionKey: createOutreachDuplicateSuppressionKey("cand-1", "Invoko", "product-designer"),
        }),
      ],
      now,
      dryRun: false,
      approvalMode: "approved",
    })
    assert.equal(duplicate.allowQueue, false)
    assert.equal(duplicate.blockedSignals.includes("duplicate_company_role"), true)
  })

  it("blocks capacity-full and review-gates warmup groups", () => {
    const full = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate(),
      job: job(),
      capacity: capacity({
        ok: false,
        reason: "channel_capacity",
        groupId: "group-1",
        fromNumber: "+15555550100",
        capacitySnapshot: {
          groupId: "group-1",
          fromNumber: "+15555550100",
          status: "active",
          dailyCap: 1,
          usedToday: 1,
          remainingToday: 0,
          checkedAt: now,
        },
      }),
      now,
      dryRun: false,
      approvalMode: "approved",
    })
    assert.equal(full.policyDecision, "blocked")
    assert.equal(full.blockedSignals.includes("channel_capacity"), true)

    const warmup = evaluateOutreachPolicy({
      match: match(),
      candidate: candidate(),
      job: job(),
      capacity: capacity({
        ok: false,
        reason: "warmup_requires_hitl",
        capacitySnapshot: {
          groupId: "warm",
          fromNumber: "+15555550100",
          status: "warmup",
          dailyCap: 10,
          usedToday: 0,
          remainingToday: 10,
          checkedAt: now,
        },
      }),
      now,
      dryRun: false,
      approvalMode: "approved",
    })
    assert.equal(warmup.policyDecision, "hitl_review")
    assert.equal(warmup.approvalState, "pending")
  })
})
