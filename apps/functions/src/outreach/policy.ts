import {
  createOutboundInviteId,
  createOutreachDuplicateSuppressionKey,
  createOutreachIdempotencyKey,
} from "@pa/core-types"
import type { OutboundInvite } from "@pa/core-types"
import {
  S6_OUTREACH_POLICY_VERSION,
  type OutreachHistoryInvite,
  type OutreachPolicyDecision,
  type OutreachPolicyInput,
} from "./types.js"

const CANDIDATE_COOLDOWN_DAYS = 7
const DUPLICATE_COMPANY_ROLE_DAYS = 30
const LARGE_BATCH_HITL_THRESHOLD = 25
const LOW_MATCH_THRESHOLD = 0.45

function timestampMs(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function addDaysIso(baseIso: string, days: number): string {
  return new Date(timestampMs(baseIso) + days * 24 * 60 * 60 * 1000).toISOString()
}

function isWithinDays(value: string | undefined, nowIso: string, days: number): boolean {
  const valueMs = timestampMs(value)
  if (!valueMs) return false
  const nowMs = timestampMs(nowIso)
  return nowMs >= valueMs && nowMs - valueMs < days * 24 * 60 * 60 * 1000
}

function roleKey(jobTitleOrRoleKey: string | undefined): string {
  return (jobTitleOrRoleKey ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
}

function createDecisionBase(input: OutreachPolicyInput): Pick<
  OutreachPolicyDecision,
  | "inviteId"
  | "outboundIdempotencyKey"
  | "policyVersion"
  | "dryRun"
  | "stickyAccountGroupId"
  | "capacitySnapshot"
> {
  const inviteId = createOutboundInviteId({
    candidateId: input.match.candidateId,
    jobId: input.match.jobId,
    matchId: input.match.matchId,
  })
  return {
    inviteId,
    outboundIdempotencyKey: createOutreachIdempotencyKey(inviteId),
    policyVersion: S6_OUTREACH_POLICY_VERSION,
    dryRun: input.dryRun,
    stickyAccountGroupId:
      input.candidate.outreach?.stickyAccountGroupId ?? input.capacity.groupId,
    capacitySnapshot: input.capacity.capacitySnapshot,
  }
}

function block(
  input: OutreachPolicyInput,
  decisionReason: string,
  blockedSignals: string[],
  extra: Partial<OutreachPolicyDecision> = {}
): OutreachPolicyDecision {
  return {
    ...createDecisionBase(input),
    queueEligible: false,
    allowQueue: false,
    policyDecision: "blocked",
    approvalState: "rejected",
    status: "blocked",
    decisionReason,
    blockedSignals,
    ...extra,
  }
}

function hitl(
  input: OutreachPolicyInput,
  decisionReason: string,
  blockedSignals: string[] = []
): OutreachPolicyDecision {
  return {
    ...createDecisionBase(input),
    queueEligible: false,
    allowQueue: false,
    policyDecision: "hitl_review",
    approvalState: "pending",
    status: "draft",
    decisionReason,
    blockedSignals,
  }
}

function allowed(input: OutreachPolicyInput): OutreachPolicyDecision {
  const allowQueue = !input.dryRun && input.approvalMode === "approved"
  return {
    ...createDecisionBase(input),
    queueEligible: true,
    allowQueue,
    policyDecision: input.match.recommendedAction === "hitl_review" ? "hitl_review" : "auto_outbound",
    approvalState: input.match.recommendedAction === "hitl_review" ? "pending" : "not_required",
    status: allowQueue ? "approved" : "draft",
    decisionReason: input.dryRun
      ? "eligible dry-run outreach decision"
      : "eligible approved outreach queue decision",
    blockedSignals: [],
  }
}

function isDuplicateInvite(invite: OutreachHistoryInvite, input: OutreachPolicyInput): boolean {
  if (invite.jobId === input.match.jobId && invite.status !== "cancelled" && invite.status !== "expired") {
    return true
  }
  if (!isWithinDays(invite.createdAt, input.now, DUPLICATE_COMPANY_ROLE_DAYS)) return false
  if (!input.job.companyName) return false
  const nextKey = createOutreachDuplicateSuppressionKey(
    input.match.candidateId,
    input.job.companyName,
    input.job.roleKey ?? roleKey(input.job.jobTitle)
  )
  if (invite.duplicateSuppressionKey) return invite.duplicateSuppressionKey === nextKey
  if (!invite.companyName) return false
  const existingKey = createOutreachDuplicateSuppressionKey(
    invite.candidateId,
    invite.companyName,
    invite.roleKey ?? invite.jobId
  )
  return existingKey === nextKey
}

function isSameJobInvite(invite: OutreachHistoryInvite, input: OutreachPolicyInput): boolean {
  return invite.jobId === input.match.jobId && invite.status !== "cancelled" && invite.status !== "expired"
}

function isRecentDecline(invite: OutreachHistoryInvite, input: OutreachPolicyInput): boolean {
  if (invite.status !== "declined") return false
  return isWithinDays(invite.createdAt, input.now, DUPLICATE_COMPANY_ROLE_DAYS)
}

function hasReachableHandle(input: OutreachPolicyInput): boolean {
  return Boolean(input.candidate.phoneE164)
}

function mapCapacityReason(reason: string | undefined): string {
  if (reason === "warmup_requires_hitl") return "sendblue_warmup"
  if (reason === "sticky_group_capacity") return "channel_capacity"
  if (reason === "missing_capacity") return "channel_capacity"
  return reason || "channel_capacity"
}

export function evaluateOutreachPolicy(input: OutreachPolicyInput): OutreachPolicyDecision {
  if (input.candidate.candidateLifecycleState === "deleted") {
    return block(input, "candidate profile is deleted", ["candidate_deleted"])
  }
  if (
    input.candidate.candidateLifecycleState === "opted_out" ||
    input.candidate.outreach?.status === "opted_out"
  ) {
    return block(input, "candidate opted out of outreach", ["opted_out"])
  }
  if (input.candidate.doNotContact) {
    return block(input, "candidate marked do not contact", ["candidate_do_not_contact"])
  }
  if (input.candidate.outreachPaused || input.candidate.outreach?.status === "paused") {
    return block(input, "candidate outreach is paused", ["candidate_outreach_paused"])
  }
  if (!hasReachableHandle(input)) {
    return block(input, "candidate has no reachable outreach handle", ["unreachable"])
  }
  if (input.candidate.outreach?.cooldownUntil && timestampMs(input.candidate.outreach.cooldownUntil) > timestampMs(input.now)) {
    return block(input, "candidate cooldown is active", ["cooldown_active"], {
      cooldownUntil: input.candidate.outreach.cooldownUntil,
    })
  }
  if (input.candidate.outreach?.lastOutboundAt && isWithinDays(
    input.candidate.outreach.lastOutboundAt,
    input.now,
    CANDIDATE_COOLDOWN_DAYS
  )) {
    return block(input, "candidate has recent outbound outreach", ["cooldown_active"], {
      cooldownUntil: addDaysIso(input.candidate.outreach.lastOutboundAt, CANDIDATE_COOLDOWN_DAYS),
    })
  }
  if (input.candidateJobState === "outbound_queued" || input.candidateJobState === "outbound_sent") {
    return block(input, "candidate already has queued or sent outreach for this job", ["already_in_job_flow"])
  }
  for (const invite of input.existingInvites ?? []) {
    if (isSameJobInvite(invite, input)) {
      return block(input, "candidate already has an outreach invite for this opportunity", ["duplicate_invite"])
    }
    if (isDuplicateInvite(invite, input)) {
      return block(input, "candidate already has recent outreach for this company and role", ["duplicate_company_role"])
    }
  }
  for (const invite of input.recentDeclines ?? []) {
    if (isRecentDecline(invite, input)) {
      return block(input, "candidate recently declined outreach", ["recent_decline"], {
        cooldownUntil: addDaysIso(invite.createdAt, DUPLICATE_COMPANY_ROLE_DAYS),
      })
    }
  }
  if (input.match.recommendedAction === "do_not_contact" || input.match.hardFilterResult === "hard_block") {
    return block(input, "S5 match says do not contact", ["do_not_contact"], {
      policyDecision: "do_not_contact",
    })
  }
  if (typeof input.match.finalScore === "number" && input.match.finalScore < LOW_MATCH_THRESHOLD) {
    return block(input, "S5 match score is below outreach threshold", ["low_match"])
  }
  if (!input.capacity.ok) {
    if (input.capacity.reason === "warmup_requires_hitl") {
      return hitl(input, "Sendblue group is in warmup", ["hitl_required", mapCapacityReason(input.capacity.reason)])
    }
    return block(input, "Sendblue group has no available capacity", [mapCapacityReason(input.capacity.reason)])
  }
  if (input.capacity.capacitySnapshot.remainingToday <= 0) {
    return block(input, "Sendblue group daily capacity is full", ["channel_capacity"])
  }
  if (input.match.recommendedAction === "hitl_review") {
    return hitl(input, "S5 match requires operator review", ["hitl_required"])
  }
  if ((input.batchSize ?? 0) > LARGE_BATCH_HITL_THRESHOLD) {
    return hitl(input, "large outreach batch requires operator approval", ["hitl_required"])
  }
  return allowed(input)
}
