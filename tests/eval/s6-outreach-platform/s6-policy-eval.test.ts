import assert from "node:assert/strict"
import test from "node:test"
import { createOutreachDuplicateSuppressionKey } from "../../../packages/core-types/src/index.js"
import { applyCandidateJobEvent } from "../../../packages/pa-persistence/src/marketplace.js"
import { evaluateOutreachPolicy } from "../../../apps/functions/src/outreach/policy.js"
import {
  candidate,
  candidateJobEvent,
  capacity,
  fullCapacity,
  job,
  makeFakeFirestore,
  match,
  missingCapacity,
  now,
  outboundInvite,
  warmupCapacity,
} from "./fixtures.js"

test("live queue requires approved mode, dryRun false, capacity, reachable handle, and queueable policy state", () => {
  const base = {
    match: match(),
    candidate: candidate(),
    job: job(),
    capacity: capacity(),
    now,
    dryRun: false,
    approvalMode: "approved" as const,
  }

  const allowed = evaluateOutreachPolicy(base)
  assert.equal(allowed.allowQueue, true)
  assert.equal(allowed.queueEligible, true)
  assert.equal(allowed.status, "approved")

  const dryRun = evaluateOutreachPolicy({ ...base, dryRun: true })
  assert.equal(dryRun.queueEligible, true)
  assert.equal(dryRun.allowQueue, false)
  assert.equal(dryRun.status, "draft")

  const missingApproval = evaluateOutreachPolicy({ ...base, approvalMode: "none" as const })
  assert.equal(missingApproval.queueEligible, true)
  assert.equal(missingApproval.allowQueue, false)

  const unreachable = evaluateOutreachPolicy({
    ...base,
    candidate: candidate({ phoneE164: undefined, imessageChatId: undefined, channels: {} }),
  })
  assert.equal(unreachable.allowQueue, false)
  assert.equal(unreachable.blockedSignals.includes("unreachable"), true)

  const hitlPolicy = evaluateOutreachPolicy({
    ...base,
    match: match({ recommendedAction: "hitl_review", finalScore: 0.72 }),
  })
  assert.equal(hitlPolicy.policyDecision, "hitl_review")
  assert.equal(hitlPolicy.approvalState, "pending")
  assert.equal(hitlPolicy.allowQueue, false)
})

test("capacity-full and missing capacity block live queue while warmup requires HITL", () => {
  const base = {
    match: match(),
    candidate: candidate(),
    job: job(),
    now,
    dryRun: false,
    approvalMode: "approved" as const,
  }

  const full = evaluateOutreachPolicy({ ...base, capacity: fullCapacity() })
  assert.equal(full.policyDecision, "blocked")
  assert.equal(full.allowQueue, false)
  assert.equal(full.blockedSignals.includes("channel_capacity"), true)

  const missing = evaluateOutreachPolicy({ ...base, capacity: missingCapacity() })
  assert.equal(missing.policyDecision, "blocked")
  assert.equal(missing.allowQueue, false)
  assert.equal(missing.blockedSignals.includes("channel_capacity"), true)

  const warmup = evaluateOutreachPolicy({ ...base, capacity: warmupCapacity() })
  assert.equal(warmup.policyDecision, "hitl_review")
  assert.equal(warmup.approvalState, "pending")
  assert.equal(warmup.allowQueue, false)
  assert.deepEqual(warmup.blockedSignals, ["hitl_required", "sendblue_warmup"])
})

test("candidate cooldown and same company-role duplicate suppress outbound", () => {
  const cooldown = evaluateOutreachPolicy({
    match: match(),
    candidate: candidate({
      outreach: { status: "cooldown", cooldownUntil: "2026-05-20T12:00:00.000Z" },
    }),
    job: job(),
    capacity: capacity(),
    now,
    dryRun: false,
    approvalMode: "approved",
  })

  assert.equal(cooldown.allowQueue, false)
  assert.equal(cooldown.cooldownUntil, "2026-05-20T12:00:00.000Z")
  assert.equal(cooldown.blockedSignals.includes("cooldown_active"), true)

  const recentOutbound = evaluateOutreachPolicy({
    match: match(),
    candidate: candidate({
      outreach: { status: "allowed", lastOutboundAt: "2026-05-12T12:00:00.000Z" },
    }),
    job: job(),
    capacity: capacity(),
    now,
    dryRun: false,
    approvalMode: "approved",
  })
  assert.equal(recentOutbound.allowQueue, false)
  assert.equal(recentOutbound.cooldownUntil, "2026-05-19T12:00:00.000Z")
  assert.equal(recentOutbound.blockedSignals.includes("cooldown_active"), true)

  const duplicate = evaluateOutreachPolicy({
    match: match({ candidateId: "cand-dup", jobId: "job-new" }),
    candidate: candidate({ candidateId: "cand-dup" }),
    job: job({ jobId: "job-new", companyName: "Invoko", roleKey: "product-designer" }),
    capacity: capacity(),
    existingInvites: [
      outboundInvite({
        candidateId: "cand-dup",
        jobId: "job-old",
        status: "sent",
        dryRun: false,
        duplicateSuppressionKey: createOutreachDuplicateSuppressionKey("cand-dup", "Invoko", "product-designer"),
        createdAt: "2026-05-10T12:00:00.000Z",
      }),
    ],
    now,
    dryRun: false,
    approvalMode: "approved",
  })

  assert.equal(duplicate.allowQueue, false)
  assert.equal(duplicate.blockedSignals.includes("duplicate_company_role"), true)
})

test("low match score may block outbound but never blocks the first interview state path", async () => {
  const { db } = makeFakeFirestore()

  const firstInterview = await applyCandidateJobEvent(
    db,
    candidateJobEvent("prescreen_started", { matchScore: 0.01 })
  )
  assert.equal(firstInterview.state, "prescreen_started")
  assert.equal(firstInterview.reason, "first_interview_started")

  const outboundDecision = evaluateOutreachPolicy({
    match: match({ finalScore: 0.01, recommendedAction: "auto_outbound" }),
    candidate: candidate(),
    job: job(),
    capacity: capacity(),
    now,
    dryRun: false,
    approvalMode: "approved",
  })
  assert.equal(outboundDecision.policyDecision, "blocked")
  assert.equal(outboundDecision.allowQueue, false)
  assert.equal(outboundDecision.blockedSignals.includes("low_match"), true)
})
