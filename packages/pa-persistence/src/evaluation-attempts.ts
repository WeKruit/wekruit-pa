import { createHash } from "node:crypto"
import type { Firestore, Query } from "firebase-admin/firestore"
import {
  CorrectionEventSchema,
  EvaluationAttemptSchema,
  HumanReviewSchema,
  PA_COLLECTIONS,
  type CorrectionEvent,
  type EvaluationAttempt,
  type EvaluationEvidenceRef,
  type EvaluationPurpose,
  type EvaluationSource,
  type HumanReview,
  type HumanReviewStatus,
} from "@pa/core-types"

const COLLECTION = PA_COLLECTIONS.evaluationAttempts

export interface ListEvaluationAttemptsInput {
  source?: EvaluationSource
  purpose?: EvaluationPurpose
  candidateId?: string
  jobId?: string
  humanReviewStatus?: HumanReviewStatus
  limit?: number
}

export interface SaveHumanReviewInput {
  attemptId: string
  review: HumanReview
  reviewer: string
  nowIso?: string
  correctionReason?: string
}

function boundedLimit(limit: number | undefined): number {
  if (!limit) return 50
  return Math.max(1, Math.min(250, Math.floor(limit)))
}

function parseAttempt(data: unknown): EvaluationAttempt | null {
  const parsed = EvaluationAttemptSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

export async function getEvaluationAttempt(
  db: Firestore,
  id: string,
): Promise<EvaluationAttempt | null> {
  const snap = await db.collection(COLLECTION).doc(id).get()
  if (!snap.exists) return null
  return parseAttempt(snap.data())
}

export async function listEvaluationAttempts(
  db: Firestore,
  input: ListEvaluationAttemptsInput = {},
): Promise<EvaluationAttempt[]> {
  let q: Query = db.collection(COLLECTION)
  if (input.source) q = q.where("source", "==", input.source)
  if (input.purpose) q = q.where("purpose", "==", input.purpose)
  if (input.candidateId) q = q.where("candidateId", "==", input.candidateId)
  if (input.jobId) q = q.where("jobId", "==", input.jobId)
  if (input.humanReviewStatus) q = q.where("humanReview.status", "==", input.humanReviewStatus)
  const snap = await q.limit(boundedLimit(input.limit)).get()
  return snap.docs
    .map((doc) => parseAttempt(doc.data()))
    .filter((row): row is EvaluationAttempt => row !== null)
}

export async function saveEvaluationAttempt(
  db: Firestore,
  attempt: EvaluationAttempt,
): Promise<EvaluationAttempt> {
  const parsed = EvaluationAttemptSchema.parse(attempt)
  await db.collection(COLLECTION).doc(parsed.attemptId).set(parsed, { merge: false })
  return parsed
}

export async function saveHumanReview(
  db: Firestore,
  input: SaveHumanReviewInput,
): Promise<{ attempt: EvaluationAttempt; correctionEvent?: CorrectionEvent }> {
  const existing = await getEvaluationAttempt(db, input.attemptId)
  if (!existing) throw new Error(`evaluation_attempt_not_found:${input.attemptId}`)
  const reviewedAt = input.nowIso ?? new Date().toISOString()
  const correctionEventId = shouldWriteCorrection(input.review.status)
    ? createEvaluationReviewCorrectionEventId(input.attemptId, reviewedAt)
    : undefined
  const review = HumanReviewSchema.parse({
    ...input.review,
    reviewer: input.review.reviewer ?? input.reviewer,
    reviewedAt: input.review.reviewedAt ?? reviewedAt,
    ...(correctionEventId ? { correctionEventId } : {}),
  })
  const next = EvaluationAttemptSchema.parse({
    ...existing,
    humanReview: review,
    updatedAt: reviewedAt,
  })

  await db.collection(COLLECTION).doc(next.attemptId).set(next, { merge: false })

  if (!correctionEventId) return { attempt: next }

  const correction = CorrectionEventSchema.parse({
    eventId: correctionEventId,
    targetType: "evaluation_attempt",
    targetId: next.attemptId,
    actor: "operator",
    candidateId: next.candidateId,
    jobId: next.jobId,
    reason: input.correctionReason ?? `evaluation_attempt_${review.status}`,
    beforeRedacted: {
      proposedOutcome: existing.proposedOutcome,
      humanReview: existing.humanReview,
    },
    afterRedacted: {
      finalOutcome: review.finalOutcome,
      status: review.status,
      reviewer: review.reviewer,
    },
    evidence: next.evidence.slice(0, 5).map((ev) => ({
      source: toCorrectionEvidenceSource(ev.source),
      summary: ev.summary,
      refId: ev.refId,
    })),
    createdAt: reviewedAt,
  })
  await db.collection(PA_COLLECTIONS.correctionEvents).doc(correction.eventId).set(correction, { merge: false })
  return { attempt: next, correctionEvent: correction }
}

function shouldWriteCorrection(status: HumanReviewStatus): boolean {
  return status === "overridden" || status === "rejected" || status === "needs_more_info"
}

function toCorrectionEvidenceSource(source: EvaluationEvidenceRef["source"]): CorrectionEvent["evidence"][number]["source"] {
  switch (source) {
    case "transcript_turn":
      return "conversation"
    case "resume":
      return "resume_parse"
    case "job":
      return "job_match"
    case "external_record":
      return "external_sourcing"
    case "evaluator":
      return "llm_infer"
    case "practice_question":
      return "admin"
  }
}

function createEvaluationReviewCorrectionEventId(attemptId: string, reviewedAt: string): string {
  const hash = createHash("sha256").update(`${attemptId}|${reviewedAt}`).digest("hex").slice(0, 32)
  return `eval_attempt_review_${hash}`
}
