import type {
  CandidateJobMatch,
  CandidateJobState,
  CandidateLifecycleState,
  OutboundInvite,
  OutboundInviteCapacitySnapshot,
} from "@pa/core-types"
import type { SendblueCapacitySelection } from "../sendblue/pool.js"

export const S6_OUTREACH_POLICY_VERSION = "s6-outreach-policy-v1"

export type OutreachCandidateSnapshot = {
  candidateId: string
  candidateLifecycleState?: CandidateLifecycleState
  outreach?: {
    status?: "allowed" | "cooldown" | "paused" | "opted_out"
    stickyAccountGroupId?: string
    lastOutboundAt?: string
    cooldownUntil?: string
    optedOutAt?: string
  }
  doNotContact?: boolean
  outreachPaused?: boolean
  phoneE164?: string
  imessageChatId?: string
  channels?: {
    imessageHandle?: string
  }
}

export type OutreachJobSnapshot = {
  jobId: string
  jobTitle: string
  companyName?: string
  roleKey?: string
}

export type OutreachHistoryInvite = Pick<
  OutboundInvite,
  | "inviteId"
  | "candidateId"
  | "jobId"
  | "status"
  | "policyDecision"
  | "cooldownUntil"
  | "duplicateSuppressionKey"
  | "createdAt"
> & {
  companyName?: string
  roleKey?: string
}

export type OutreachPolicyInput = {
  match: CandidateJobMatch
  candidate: OutreachCandidateSnapshot
  job: OutreachJobSnapshot
  candidateJobState?: CandidateJobState
  existingInvites?: OutreachHistoryInvite[]
  recentDeclines?: OutreachHistoryInvite[]
  capacity: SendblueCapacitySelection
  now: string
  dryRun: boolean
  approvalMode?: "none" | "approved"
  batchSize?: number
}

export type OutreachPolicyDecision = {
  inviteId: string
  outboundIdempotencyKey: string
  queueEligible: boolean
  allowQueue: boolean
  policyDecision: OutboundInvite["policyDecision"]
  approvalState: OutboundInvite["approvalState"]
  status: OutboundInvite["status"]
  dryRun: boolean
  policyVersion: string
  decisionReason: string
  blockedSignals: string[]
  cooldownUntil?: string
  stickyAccountGroupId?: string
  capacitySnapshot?: OutboundInviteCapacitySnapshot
}
