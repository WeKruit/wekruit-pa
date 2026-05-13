import {
  createCandidateJobMatchId,
  createCandidateJobStateId,
  createOutboundInviteId,
  type CandidateJobMatch,
  type OutboundInvite,
} from "@pa/core-types"
import type { SendblueCapacitySelection } from "../../sendblue/pool.js"
import type { OutreachCandidateSnapshot, OutreachJobSnapshot } from "../types.js"

export const now = "2026-05-13T12:00:00.000Z"

export function match(over: Partial<CandidateJobMatch> = {}): CandidateJobMatch {
  return {
    matchId: createCandidateJobMatchId("cand-1", "job-1"),
    candidateId: "cand-1",
    jobId: "job-1",
    direction: "job_to_candidate",
    matchVersion: "s5-test",
    jobEnrichmentVersion: "job-enrich-v1",
    computedAt: now,
    scoreBreakdown: {
      skills: { score: 0.86, weight: 0.6, summary: "React and TypeScript match" },
      location: { score: 1, weight: 0.2 },
    },
    matchedSignals: ["react", "typescript", "remote_anywhere"],
    blockedSignals: [],
    candidateLifecycleStateAtMatch: "retained",
    candidateTagsUpdatedAt: now,
    hardFilterResult: "pass",
    finalScore: 0.88,
    reasons: [],
    risks: [],
    missingInfo: [],
    recommendedAction: "auto_outbound",
    evidence: [{ source: "job_match", summary: "S5 match fixture" }],
    createdAt: now,
    ...over,
  }
}

export function candidate(over: Partial<OutreachCandidateSnapshot> = {}): OutreachCandidateSnapshot {
  return {
    candidateId: "cand-1",
    candidateLifecycleState: "retained",
    outreach: { status: "allowed", stickyAccountGroupId: "group-1" },
    phoneE164: "+15555550123",
    ...over,
  }
}

export function job(over: Partial<OutreachJobSnapshot> = {}): OutreachJobSnapshot {
  return {
    jobId: "job-1",
    jobTitle: "Product Designer",
    companyName: "Invoko",
    roleKey: "product-designer",
    ...over,
  }
}

export function capacity(over: Partial<SendblueCapacitySelection> = {}): SendblueCapacitySelection {
  return {
    ok: true,
    groupId: "group-1",
    fromNumber: "+15555550100",
    reason: "selected",
    capacitySnapshot: {
      groupId: "group-1",
      fromNumber: "+15555550100",
      status: "active",
      dailyCap: 10,
      usedToday: 1,
      remainingToday: 9,
      checkedAt: now,
    },
    ...over,
  } as SendblueCapacitySelection
}

export function invite(
  over: Partial<OutboundInvite> & { companyName?: string; roleKey?: string } = {}
): OutboundInvite & { companyName?: string; roleKey?: string } {
  const baseMatch = match()
  return {
    inviteId: createOutboundInviteId({
      candidateId: baseMatch.candidateId,
      jobId: baseMatch.jobId,
      matchId: baseMatch.matchId,
    }),
    candidateId: baseMatch.candidateId,
    jobId: baseMatch.jobId,
    candidateJobStateId: createCandidateJobStateId(baseMatch.candidateId, baseMatch.jobId),
    matchId: baseMatch.matchId,
    status: "draft",
    policyDecision: "auto_outbound",
    approvalState: "not_required",
    dryRun: true,
    policyVersion: "s6-outreach-policy-v1",
    decisionReason: "fixture",
    blockedSignals: [],
    missingInfo: [],
    createdAt: now,
    ...over,
  }
}
