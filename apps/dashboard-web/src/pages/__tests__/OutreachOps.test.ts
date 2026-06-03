import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"

import {
  OUTREACH_OPS_CALLABLE_NAME,
  OUTREACH_OPS_ROUTE,
  buildOutreachOpsSnapshotRequest,
  classifyBlockedSignals,
  getReadOnlyActionState,
  redactContactLikeText,
  summarizeBlockedSignals,
  type OutreachOpsInviteRow,
  type OutreachOpsSnapshot,
} from "../OutreachOps.helpers.js"
import { OutreachOpsSnapshotView } from "../OutreachOps.js"

test("OutreachOps helpers target the admin snapshot callable", () => {
  assert.equal(OUTREACH_OPS_CALLABLE_NAME, "paAdminOutreachOpsSnapshot")
  assert.deepEqual(
    buildOutreachOpsSnapshotRequest({
      jobId: " job-1 ",
      status: " failed ",
      approvalState: " pending ",
      limit: 500,
    }),
    {
      jobId: "job-1",
      status: "failed",
      approvalState: "pending",
      limit: 200,
    },
  )
})

test("OutreachOps route and nav are wired in App", () => {
  const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8")
  const sidebarSource = readFileSync(
    new URL("../../components/console/Sidebar.tsx", import.meta.url),
    "utf8",
  )
  assert.equal(OUTREACH_OPS_ROUTE, "/admin/outreach-ops")
  assert.match(appSource, /import OutreachOps from "\.\/pages\/OutreachOps\.js"/)
  assert.match(sidebarSource, /to: "\/admin\/outreach-ops"/)
  assert.match(appSource, /<Route path="\/admin\/outreach-ops" element={<OutreachOps \/>} \/>/)
  assert.doesNotMatch(appSource, /<Route path="\/j\/:jobId"/)
  assert.doesNotMatch(appSource, /PublicJob/)
})

test("OutreachOps page renders snapshot sections without raw contact fields", () => {
  const snapshot: OutreachOpsSnapshot = {
    generatedAt: "2026-05-13T20:00:00.000Z",
    filters: { limit: 50 },
    summary: {
      totalInvites: 2,
      allowed: 0,
      blocked: 1,
      pendingApproval: 1,
      approved: 0,
      queued: 0,
      sent: 0,
      delivered: 0,
      failed: 1,
      deadLetter: 0,
      dryRun: 2,
      capacityBlocked: 1,
      cooldownBlocked: 0,
      optOutBlocked: 0,
      duplicateBlocked: 0,
    },
    jobs: [
      {
        jobId: "job-1",
        jobTitle: "Product Designer",
        companyName: "Invoko",
        pendingInvites: 1,
        blockedInvites: 1,
        queuedInvites: 0,
      },
    ],
    capacity: [
      {
        groupId: "group-1",
        fromNumber: "+15555550100",
        status: "active",
        dailyCap: 1,
        usedToday: 1,
        remainingToday: 0,
        rolling24hUsed: 3,
        checkedAt: "2026-05-13T20:00:00.000Z",
        reason: "capacity blocked for +15555550100",
      },
    ],
    failures: [
      {
        inviteId: "invite-2",
        candidateId: "cand-2",
        candidateDisplayName: "candidate@example.com",
        jobId: "job-1",
        jobTitle: "Product Designer",
        companyName: "Invoko",
        policyDecision: "blocked",
        approvalState: "pending",
        status: "failed",
        dryRun: true,
        decisionReason: "resume.pdf failed for +15555550100",
        blockedSignals: ["channel_capacity"],
        createdAt: "2026-05-13T19:55:00.000Z",
        updatedAt: "2026-05-13T19:56:00.000Z",
        lastError: "Email candidate@example.com or use +15555550100",
        phoneE164: "+15555550100",
        email: "candidate@example.com",
        resumeUrl: "https://storage.example/resume.pdf",
      },
    ],
    approvalBatches: [{ batchId: "pending-review", pendingInvites: 1, createdAt: "2026-05-13T19:55:00.000Z" }],
    invites: [
      {
        inviteId: "invite-1",
        candidateId: "cand-1",
        candidateDisplayName: "Candidate One",
        jobId: "job-1",
        jobTitle: "Product Designer",
        companyName: "Invoko",
        finalScore: 0.91,
        policyDecision: "hitl_review",
        approvalState: "pending",
        status: "draft",
        dryRun: true,
        decisionReason: "warmup requires review",
        blockedSignals: ["warmup_requires_hitl"],
        createdAt: "2026-05-13T19:50:00.000Z",
      },
    ],
  }

  const html = renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(OutreachOpsSnapshotView, { snapshot })),
  )

  assert.match(html, /Outreach Ops/)
  assert.match(html, /Pending Review/)
  assert.match(html, /Blocked/)
  assert.match(html, /Failures/)
  assert.match(html, /Capacity/)
  assert.match(html, /Jobs/)
  assert.doesNotMatch(html, /candidate@example\.com/)
  assert.doesNotMatch(html, /\+15555550100/)
  assert.doesNotMatch(html, /resume\.pdf/)
  assert.doesNotMatch(html, /Queue disabled/)
  assert.doesNotMatch(html, /<button/)
  assert.match(html, /\[redacted email\]/)
  assert.equal(redactContactLikeText("candidate@example.com +15555550100 resume.pdf"), "[redacted email] [redacted phone] [redacted resume]")
})

function inviteRow(patch: Partial<OutreachOpsInviteRow>): OutreachOpsInviteRow {
  return {
    inviteId: "invite-base",
    candidateId: "candidate-base",
    candidateDisplayName: "Candidate Base",
    jobId: "job-base",
    jobTitle: "Designer",
    companyName: "Invoko",
    policyDecision: "auto_outbound",
    approvalState: "not_required",
    status: "draft",
    dryRun: true,
    decisionReason: "eligible",
    blockedSignals: [],
    createdAt: "2026-05-13T00:00:00.000Z",
    ...patch,
  }
}

test("OutreachOps helpers group blocked signals by S6 policy category", () => {
  assert.deepEqual(
    classifyBlockedSignals([
      "channel_capacity_full",
      "candidate_cooldown_active",
      "candidate_opted_out",
      "duplicate_company_role",
      "missing_level1",
    ]),
    {
      capacity: ["channel_capacity_full"],
      cooldown: ["candidate_cooldown_active"],
      optOut: ["candidate_opted_out"],
      duplicate: ["duplicate_company_role"],
      other: ["missing_level1"],
    },
  )
})

test("OutreachOps summaries count capacity cooldown opt-out duplicate blockers per invite", () => {
  assert.deepEqual(
    summarizeBlockedSignals([
      inviteRow({ blockedSignals: ["capacity_full", "cooldown_active"] }),
      inviteRow({ policyDecision: "do_not_contact", blockedSignals: ["outreach_blocked"] }),
      inviteRow({ blockedSignals: ["duplicate_job", "missing_profile"] }),
    ]),
    {
      capacity: 1,
      cooldown: 1,
      optOut: 1,
      duplicate: 1,
      other: 1,
    },
  )
})

test("OutreachOps read-only action state disables queueing for blocked cooldown capacity opt-out duplicate rows", () => {
  const state = getReadOnlyActionState(
    inviteRow({
      policyDecision: "blocked",
      approvalState: "pending",
      blockedSignals: ["capacity_full", "cooldown_active", "candidate_opted_out", "duplicate_job"],
      cooldownUntil: "2026-05-20T00:00:00.000Z",
      capacitySnapshot: {
        groupId: "group-1",
        status: "active",
        dailyCap: 5,
        usedToday: 5,
        remainingToday: 0,
        checkedAt: "2026-05-13T00:00:00.000Z",
      },
    }),
  )

  assert.equal(state.disabled, true)
  assert.equal(state.label, "Queue disabled")
  assert.ok(state.reasons.includes("S6 admin UI is read-only"))
  assert.ok(state.reasons.includes("policy blocked"))
  assert.ok(state.reasons.includes("capacity blocked"))
  assert.ok(state.reasons.includes("cooldown active"))
  assert.ok(state.reasons.includes("opt-out / do-not-contact"))
  assert.ok(state.reasons.includes("duplicate suppressed"))
  assert.ok(state.reasons.includes("pending HITL approval"))
})

test("OutreachOps read-only action state explains rejected failure rows", () => {
  const state = getReadOnlyActionState(
    inviteRow({
      dryRun: false,
      approvalState: "rejected",
      status: "dead_letter",
      lastError: "provider failure",
    }),
  )

  assert.equal(state.disabled, true)
  assert.ok(state.reasons.includes("S6 admin UI is read-only"))
  assert.ok(state.reasons.includes("approval rejected"))
  assert.ok(state.reasons.includes("failure requires backend retry path"))
  assert.equal(state.reasons.includes("dry-run decision"), false)
})
