import type { Firestore } from "firebase-admin/firestore"
import { createCandidateHandleId, PA_COLLECTIONS } from "@pa/core-types"
import { canonicalizeLinkedInUrl, linkedinHash } from "@pa/external-supply"

const RECRUITER_CANDIDATE_EVENTS_COLLECTION = "pa-recruiter-candidate-events"

export const RECRUITER_CANDIDATE_REJECTION_CATEGORIES = ["quality", "role_fit"] as const
export const RECRUITER_CANDIDATE_TIERS = ["tier_1", "tier_2", "tier_3"] as const

export type RecruiterCandidateRejectionCategory = (typeof RECRUITER_CANDIDATE_REJECTION_CATEGORIES)[number]
export type RecruiterCandidateTier = (typeof RECRUITER_CANDIDATE_TIERS)[number]

export interface RecruiterCandidateRejectionInput {
  category: RecruiterCandidateRejectionCategory
  candidateTier: RecruiterCandidateTier
  reason: string
}

export interface RecruiterCandidateTrackingResult {
  status: "tracked" | "skipped_no_linkedin"
  candidateId?: string
  canonicalLinkedInUrl?: string
  handleHash?: string
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function submissionCandidate(submission: Record<string, unknown>): Record<string, unknown> {
  return asRecord(submission.candidate)
}

function candidateName(submission: Record<string, unknown>): string | undefined {
  const candidate = submissionCandidate(submission)
  return cleanString(candidate.name)
}

function candidateEmail(submission: Record<string, unknown>): string | undefined {
  const candidate = submissionCandidate(submission)
  return cleanString(candidate.email)?.toLowerCase()
}

function candidateCurrentRole(submission: Record<string, unknown>): string | undefined {
  const candidate = submissionCandidate(submission)
  return cleanString(candidate.currentRole)
}

function candidateLinkedIn(submission: Record<string, unknown>): string | null {
  const candidate = submissionCandidate(submission)
  return canonicalizeLinkedInUrl(cleanString(candidate.linkedinUrl) ?? cleanString(candidate.link))
}

function deterministicRecruiterCandidateId(handleHash: string): string {
  return `cand_recruiter_${handleHash.slice(0, 32)}`
}

function hasString(data: Record<string, unknown>, key: string): boolean {
  return typeof data[key] === "string" && (data[key] as string).trim().length > 0
}

export function reusableForCandidateTier(tier: RecruiterCandidateTier): boolean {
  return tier !== "tier_3"
}

export function recruiterFeedbackForRejection(
  category: RecruiterCandidateRejectionCategory,
  tier: RecruiterCandidateTier,
): { rating: 1 | 2 | 3; reasons: string[] } {
  if (tier === "tier_3") return { rating: 1, reasons: [category, "tier_3_hard_reject"] }
  if (tier === "tier_2") return { rating: 2, reasons: [category, "tier_2_reusable"] }
  return { rating: 3, reasons: [category, "tier_1_reusable"] }
}

export async function ensureRecruiterSubmissionCandidateTracked(
  db: Firestore,
  args: {
    submissionId: string
    submission: Record<string, unknown>
    now: string
    writeCreatedEvent?: boolean
    statusOverride?: string
  },
): Promise<RecruiterCandidateTrackingResult> {
  const canonicalLinkedInUrl = candidateLinkedIn(args.submission)
  if (!canonicalLinkedInUrl) return { status: "skipped_no_linkedin" }

  const handleHash = linkedinHash(canonicalLinkedInUrl)
  const handleId = createCandidateHandleId("linkedin", handleHash)
  const handleRef = db.collection(PA_COLLECTIONS.candidateHandles).doc(handleId)
  const handleSnap = await handleRef.get()
  const handleData = handleSnap.data() ?? {}
  const candidateId = cleanString(handleData.candidateId) ?? deterministicRecruiterCandidateId(handleHash)

  const userRef = db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const userSnap = await userRef.get()
  const userData = userSnap.data() ?? {}
  const name = candidateName(args.submission)
  const email = candidateEmail(args.submission)
  const currentRole = candidateCurrentRole(args.submission)
  const jobId = cleanString(args.submission.jobId) ?? cleanString(args.submission.inboundJobId)
  const recruiterId = cleanString(args.submission.recruiterId)
  const recruiterEmail = cleanString(args.submission.recruiterEmail)
    ?? cleanString(asRecord(args.submission.submitter).email)

  const userPatch: Record<string, unknown> = {
    id: candidateId,
    updatedAt: args.now,
    recruiterSubmissionTracking: {
      lastSubmissionId: args.submissionId,
      lastStatus: args.statusOverride ?? cleanString(args.submission.status) ?? "submitted",
      ...(jobId ? { lastJobId: jobId } : {}),
      ...(recruiterId ? { lastRecruiterId: recruiterId } : {}),
      updatedAt: args.now,
    },
  }
  if (!userSnap.exists) userPatch.createdAt = args.now
  if (!hasString(userData, "candidateLifecycleState")) userPatch.candidateLifecycleState = "prospect"
  if (!hasString(userData, "linkedinUrl")) userPatch.linkedinUrl = canonicalLinkedInUrl
  if (name && !hasString(userData, "displayName")) userPatch.displayName = name
  if (email && !hasString(userData, "email")) userPatch.email = email
  if (currentRole) userPatch.latestRecruiterCurrentRole = currentRole

  await userRef.set(userPatch, { merge: true })

  if (!handleSnap.exists) {
    await handleRef.set({
      handleId,
      candidateId,
      kind: "linkedin",
      handleHash,
      normalizedValue: canonicalLinkedInUrl,
      source: "recruiter_submission",
      createdAt: args.now,
      updatedAt: args.now,
    }, { merge: false })
  } else {
    await handleRef.set({ updatedAt: args.now }, { merge: true })
  }

  if (args.writeCreatedEvent) {
    await db.collection(RECRUITER_CANDIDATE_EVENTS_COLLECTION).doc(`created_${args.submissionId}`).set({
      kind: "recruiter_submission_created",
      candidateId,
      submissionId: args.submissionId,
      candidateLinkedInUrl: canonicalLinkedInUrl,
      ...(email ? { candidateEmail: email } : {}),
      ...(jobId ? { jobId } : {}),
      ...(recruiterId ? { recruiterId } : {}),
      ...(recruiterEmail ? { recruiterEmail } : {}),
      at: args.now,
    }, { merge: true })
  }

  return { status: "tracked", candidateId, canonicalLinkedInUrl, handleHash }
}

export async function recordRecruiterSubmissionRejection(
  db: Firestore,
  args: {
    submissionId: string
    submission: Record<string, unknown>
    rejection: RecruiterCandidateRejectionInput
    actorEmail: string
    now: string
  },
): Promise<RecruiterCandidateTrackingResult> {
  const tracking = await ensureRecruiterSubmissionCandidateTracked(db, {
    submissionId: args.submissionId,
    submission: args.submission,
    now: args.now,
    statusOverride: "rejected",
    writeCreatedEvent: false,
  })
  if (tracking.status !== "tracked" || !tracking.candidateId) return tracking

  const reusableForOtherCompanies = reusableForCandidateTier(args.rejection.candidateTier)
  await db.collection(PA_COLLECTIONS.users).doc(tracking.candidateId).set({
    updatedAt: args.now,
    recruiterSubmissionDisposition: {
      lastSubmissionId: args.submissionId,
      lastStatus: "rejected",
      lastRejectionCategory: args.rejection.category,
      candidateTier: args.rejection.candidateTier,
      reusableForOtherCompanies,
      lastRejectionReason: args.rejection.reason,
      updatedAt: args.now,
    },
  }, { merge: true })

  const candidate = submissionCandidate(args.submission)
  const email = candidateEmail(args.submission)
  const jobId = cleanString(args.submission.jobId) ?? cleanString(args.submission.inboundJobId)
  const recruiterId = cleanString(args.submission.recruiterId)
  const recruiterEmail = cleanString(args.submission.recruiterEmail)
    ?? cleanString(asRecord(args.submission.submitter).email)

  await db.collection(RECRUITER_CANDIDATE_EVENTS_COLLECTION).doc(`rejected_${args.submissionId}`).set({
    kind: "recruiter_submission_rejected",
    candidateId: tracking.candidateId,
    submissionId: args.submissionId,
    candidateLinkedInUrl: tracking.canonicalLinkedInUrl,
    ...(email ? { candidateEmail: email } : {}),
    ...(cleanString(candidate.name) ? { candidateName: cleanString(candidate.name) } : {}),
    ...(jobId ? { jobId } : {}),
    ...(recruiterId ? { recruiterId } : {}),
    ...(recruiterEmail ? { recruiterEmail } : {}),
    rejectionCategory: args.rejection.category,
    candidateTier: args.rejection.candidateTier,
    reusableForOtherCompanies,
    reason: args.rejection.reason,
    by: args.actorEmail,
    at: args.now,
  }, { merge: true })

  return tracking
}
