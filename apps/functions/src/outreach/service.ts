import {
  createCandidateJobStateId,
  createOutreachDuplicateSuppressionKey,
  type CandidateJobMatch,
  type OutboundInvite,
} from "@pa/core-types"
import type { EnqueueOutboundInput } from "@pa/pa-broker"
import { evaluateOutreachPolicy } from "./policy.js"
import {
  S6_OUTREACH_POLICY_VERSION,
  type OutreachCandidateSnapshot,
  type OutreachHistoryInvite,
  type OutreachJobSnapshot,
  type OutreachPolicyDecision,
} from "./types.js"
import type { SendblueCapacitySelection } from "../sendblue/pool.js"

type ReservableCapacityStatus = "active" | "warmup" | "throttled" | "paused" | "degraded"

export type PlanJobOutreachInput = {
  job: OutreachJobSnapshot
  matches: CandidateJobMatch[]
  candidatesById: Record<string, OutreachCandidateSnapshot | undefined>
  capacityByCandidateId: Record<string, SendblueCapacitySelection | undefined>
  candidateJobStateByCandidateId?: Record<string, PlanJobCandidateState | undefined>
  existingInvitesByCandidateId?: Record<string, OutreachHistoryInvite[] | undefined>
  recentDeclinesByCandidateId?: Record<string, OutreachHistoryInvite[] | undefined>
  now: string
  dryRun: boolean
  approvalMode?: "none" | "approved"
  persistDecisions?: boolean
  batchSize?: number
}

export type PlanJobCandidateState =
  | "candidate_matched"
  | "outbound_queued"
  | "outbound_sent"
  | "candidate_interested"
  | "prescreen_started"
  | "passed"
  | "not_passed"
  | "paused"
  | "employer_visible"
  | "archived"

export type PlanJobOutreachDeps = {
  writeInviteDecision?: (invite: OutboundInvite) => Promise<{
    invite: OutboundInvite
    created: boolean
    idempotent: boolean
    auditEventId: string
  }>
  reserveCapacity?: (input: {
    candidateId: string
    groupId: string
    fromNumber?: string
    status: ReservableCapacityStatus
    dailyCap: number
    checkedAt: string
    reservationKey: string
  }) => Promise<SendblueCapacitySelection>
  enqueueOutbound?: (input: EnqueueOutboundInput) => Promise<{ id: string; created: boolean }>
  markQueued?: (input: {
    inviteId: string
    outboundId: string
    queuedAt: string
    actor: "system"
  }) => Promise<unknown>
}

export type PlanJobOutreachRow = {
  candidateId: string
  matchId: string
  invite: OutboundInvite
  decision: OutreachPolicyDecision
  queuedOutboundId?: string
}

export type PlanJobOutreachSummary = {
  total: number
  queueEligible: number
  queued: number
  blocked: number
  pendingApproval: number
  dryRun: number
  duplicates: number
}

export type PlanJobOutreachResult = {
  rows: PlanJobOutreachRow[]
  summary: PlanJobOutreachSummary
}

export function renderOutreachInviteBody(args: {
  job: OutreachJobSnapshot
  jobUrl: string
}): string {
  const company = args.job.companyName?.trim() || "this company"
  return `Claire from WeKruit here. ${company} looks like a strong fit for ${args.job.jobTitle}. Want to do the quick first interview? ${args.jobUrl} Reply stop to pause outreach.`
}

export function buildOutboundInviteFromDecision(args: {
  match: CandidateJobMatch
  job?: OutreachJobSnapshot
  decision: OutreachPolicyDecision
  now: string
}): OutboundInvite {
  const invite: OutboundInvite = {
    inviteId: args.decision.inviteId,
    candidateId: args.match.candidateId,
    jobId: args.match.jobId,
    candidateJobStateId: createCandidateJobStateId(args.match.candidateId, args.match.jobId),
    matchId: args.match.matchId,
    status: args.decision.status,
    policyDecision: args.decision.policyDecision,
    approvalState: args.decision.approvalState,
    dryRun: args.decision.dryRun,
    policyVersion: S6_OUTREACH_POLICY_VERSION,
    decisionReason: args.decision.decisionReason,
    blockedSignals: args.decision.blockedSignals,
    missingInfo: [],
    ...(args.job?.companyName
      ? {
          duplicateSuppressionKey: createOutreachDuplicateSuppressionKey(
            args.match.candidateId,
            args.job.companyName,
            args.job.roleKey ?? args.job.jobTitle
          ),
        }
      : {}),
    ...(args.decision.cooldownUntil ? { cooldownUntil: args.decision.cooldownUntil } : {}),
    ...(args.decision.stickyAccountGroupId ? { stickyAccountGroupId: args.decision.stickyAccountGroupId } : {}),
    ...(args.decision.capacitySnapshot ? { capacitySnapshot: args.decision.capacitySnapshot } : {}),
    createdAt: args.now,
  }
  return invite
}

function emptySummary(): PlanJobOutreachSummary {
  return {
    total: 0,
    queueEligible: 0,
    queued: 0,
    blocked: 0,
    pendingApproval: 0,
    dryRun: 0,
    duplicates: 0,
  }
}

function updateSummary(summary: PlanJobOutreachSummary, decision: OutreachPolicyDecision, queued: boolean): void {
  summary.total += 1
  if (decision.queueEligible) summary.queueEligible += 1
  if (queued) summary.queued += 1
  if (decision.approvalState === "pending") summary.pendingApproval += 1
  if (decision.dryRun) summary.dryRun += 1
  if (decision.blockedSignals.includes("duplicate_invite")) summary.duplicates += 1
  if (decision.policyDecision === "blocked" || decision.policyDecision === "do_not_contact") summary.blocked += 1
}

function capacityReservationSignal(reason: string | undefined): string {
  if (reason === "warmup_requires_hitl") return "sendblue_warmup"
  if (reason && reason.includes("capacity")) return "channel_capacity"
  if (reason === "missing_capacity") return "channel_capacity"
  return reason || "channel_capacity"
}

function reservableCapacityStatus(status: SendblueCapacitySelection["capacitySnapshot"]["status"]): ReservableCapacityStatus {
  if (
    status === "active" ||
    status === "warmup" ||
    status === "throttled" ||
    status === "paused" ||
    status === "degraded"
  ) {
    return status
  }
  throw new Error(`capacity_status_not_reservable:${status}`)
}

function blockForCapacityReservation(
  decision: OutreachPolicyDecision,
  reservation: SendblueCapacitySelection
): OutreachPolicyDecision {
  return {
    ...decision,
    queueEligible: false,
    allowQueue: false,
    policyDecision: "blocked",
    approvalState: "rejected",
    status: "blocked",
    decisionReason: "Sendblue capacity reservation failed",
    blockedSignals: [...new Set([...decision.blockedSignals, capacityReservationSignal(reservation.reason)])],
    stickyAccountGroupId: reservation.groupId ?? decision.stickyAccountGroupId,
    capacitySnapshot: reservation.capacitySnapshot,
  }
}

export async function planJobOutreach(
  input: PlanJobOutreachInput,
  deps: PlanJobOutreachDeps = {}
): Promise<PlanJobOutreachResult> {
  const rows: PlanJobOutreachRow[] = []
  const summary = emptySummary()

  for (const match of input.matches) {
    const candidate = input.candidatesById[match.candidateId]
    const capacity = input.capacityByCandidateId[match.candidateId]
    if (!candidate || !capacity) {
      continue
    }
    const decision = evaluateOutreachPolicy({
      match,
      candidate,
      job: input.job,
      candidateJobState: input.candidateJobStateByCandidateId?.[match.candidateId],
      existingInvites: input.existingInvitesByCandidateId?.[match.candidateId],
      recentDeclines: input.recentDeclinesByCandidateId?.[match.candidateId],
      capacity,
      now: input.now,
      dryRun: input.dryRun,
      approvalMode: input.approvalMode,
      batchSize: input.batchSize ?? input.matches.length,
    })
    let finalDecision = decision
    if (decision.allowQueue) {
      if (!deps.reserveCapacity) throw new Error("reserveCapacity dependency required")
      if (!capacity.ok) throw new Error(`capacity_not_reservable:${capacity.reason}`)
      const reservation = await deps.reserveCapacity({
        candidateId: candidate.candidateId,
        groupId: capacity.groupId,
        ...(capacity.fromNumber ? { fromNumber: capacity.fromNumber } : {}),
        status: reservableCapacityStatus(capacity.capacitySnapshot.status),
        dailyCap: capacity.capacitySnapshot.dailyCap,
        checkedAt: input.now,
        reservationKey: decision.inviteId,
      })
      finalDecision = reservation.ok
        ? {
            ...decision,
            stickyAccountGroupId: reservation.groupId,
            capacitySnapshot: reservation.capacitySnapshot,
          }
        : blockForCapacityReservation(decision, reservation)
    }
    const invite = buildOutboundInviteFromDecision({ match, job: input.job, decision: finalDecision, now: input.now })

    if (input.persistDecisions && deps.writeInviteDecision) {
      await deps.writeInviteDecision(invite)
    }

    let queuedOutboundId: string | undefined
    if (finalDecision.allowQueue) {
      if (!deps.enqueueOutbound) throw new Error("enqueueOutbound dependency required")
      if (!deps.markQueued) throw new Error("markQueued dependency required")
      if (!candidate.phoneE164) throw new Error("candidate_phone_required_for_live_queue")
      const enqueueResult = await deps.enqueueOutbound({
        userId: candidate.candidateId,
        toE164: candidate.phoneE164,
        ...(candidate.imessageChatId ? { imessageChatId: candidate.imessageChatId } : {}),
        body: renderOutreachInviteBody({
          job: input.job,
          jobUrl: `https://candidate.wekruit.com/j/${input.job.jobId}`,
        }),
        idempotencyKey: decision.outboundIdempotencyKey,
      })
      queuedOutboundId = enqueueResult.id
      await deps.markQueued({
        inviteId: invite.inviteId,
        outboundId: enqueueResult.id,
        queuedAt: input.now,
        actor: "system",
      })
    }

    rows.push({
      candidateId: match.candidateId,
      matchId: match.matchId,
      invite,
      decision: finalDecision,
      ...(queuedOutboundId ? { queuedOutboundId } : {}),
    })
    updateSummary(summary, finalDecision, Boolean(queuedOutboundId))
  }

  return { rows, summary }
}
