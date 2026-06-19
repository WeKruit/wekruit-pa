/**
 * paAdminRecruiterSubmissionAction — operator decision callable for the
 * recruiter-submission review board.
 *
 *   advance / reject / reviewing / duplicate → set status accordingly +
 *     adminDecision { by, at, note }
 *   wekruit_interview / client_review / hired → set status to the action
 *     name, same adminDecision conventions (status pipeline stages)
 *   request_info → keep/set status "reviewing" + append requestedInfo[]
 *     { message, at, by }
 *   comment → create pa-recruiter-submissions/{id}/comments/{commentId}
 *     { message, by:"wekruit", authorName, authorEmail?, at } — no status /
 *     adminDecision / statusHistory change; returns { ok, submissionId,
 *     commentId }
 *
 * Idempotent: re-applying the same action returns ok without duplicating
 * the decision — the first decidedAt is kept, the note is updated.
 *
 * Status writes here are what the recruiter-board codebase's
 * paRecruiterSubmissionFeedbackNotify trigger (onDocumentWritten over
 * pa-recruiter-submissions) reacts to — recruiter emails/inbox notices are
 * its job, NEVER this callable's.
 */

import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"
import {
  RECRUITER_CANDIDATE_REJECTION_CATEGORIES,
  RECRUITER_CANDIDATE_TIERS,
  recordRecruiterSubmissionRejection,
  recruiterFeedbackForRejection,
  reusableForCandidateTier,
} from "./recruiter-candidate-tracking.js"
import { applyGlobalCandidateTier } from "./candidate-tier.js"
import { suggestTierFromRecruiterAi, type RecruiterAiVerdict } from "@pa/core-types"

/** Read the AI's suggested tier from the submission's persisted aiEvaluation. */
function recruiterAiSuggestedTier(submission: Record<string, unknown>): ReturnType<typeof suggestTierFromRecruiterAi> | null {
  const ai = submission.aiEvaluation
  if (!ai || typeof ai !== "object") return null
  const verdict = (ai as { verdict?: unknown }).verdict
  const hardGaps =
    ((ai as { checklist?: { hard?: { gaps?: unknown } } }).checklist?.hard?.gaps as unknown[] | undefined)?.length ?? 0
  if (verdict !== "advance" && verdict !== "borderline" && verdict !== "reject") return null
  return suggestTierFromRecruiterAi(verdict as RecruiterAiVerdict, hardGaps)
}

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const SUBMISSIONS_COLLECTION = "pa-recruiter-submissions"
const COMMENTS_SUBCOLLECTION = "comments"
const COMMENT_MESSAGE_MAX = 4_000

const RecruiterCandidateRejectionSchema = z.object({
  category: z.enum(RECRUITER_CANDIDATE_REJECTION_CATEGORIES),
  candidateTier: z.enum(RECRUITER_CANDIDATE_TIERS),
  reason: z.string().optional().transform((value) => (value ?? "").trim()).pipe(z.string().max(4_000)),
  // Structured quick-reject chip ids (e.g. "weak_school", "low_gpa") the operator
  // tapped on the board reject form. Advisory metadata alongside the free-text reason.
  reasons: z.array(z.string().max(80)).max(24).optional(),
})

// Operator's per-item checklist assessment (AI mark + override) keyed by the
// rubric item id/text. "save_marks" persists this without a status change.
const ChecklistMarksSchema = z.record(z.string().max(400), z.enum(["met", "gap", "flag", "clear"]))

export const AdminRecruiterSubmissionActionInputSchema = z.object({
  submissionId: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  action: z.enum(["advance", "reject", "reviewing", "duplicate", "request_info", "wekruit_interview", "client_review", "hired", "comment", "save_marks"]),
  note: z.string().max(4_000).optional(),
  requestMessage: z.string().max(4_000).optional(),
  message: z.string().optional(),
  rejection: RecruiterCandidateRejectionSchema.optional(),
  checklistMarks: ChecklistMarksSchema.optional(),
  adminToken: z.string().optional(),
})
export type AdminRecruiterSubmissionActionInput = z.infer<typeof AdminRecruiterSubmissionActionInputSchema>

/** Status vocabulary shared with the recruiter-board codebase. */
const ACTION_TO_STATUS = {
  advance: "advanced",
  reject: "rejected",
  reviewing: "reviewing",
  duplicate: "duplicate",
  request_info: "reviewing",
  wekruit_interview: "wekruit_interview",
  client_review: "client_review",
  hired: "hired",
} as const

export type AdminRecruiterSubmissionActionResult =
  | { ok: true; submissionId: string; status: string }
  | { ok: true; submissionId: string; commentId: string }

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function appendStatusHistory(
  data: Record<string, unknown>,
  status: string,
  atIso: string,
): Array<Record<string, unknown>> {
  const existing = Array.isArray(data.statusHistory)
    ? data.statusHistory.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : []
  return [...existing, { status, by: "admin", atIso }]
}

export async function runAdminRecruiterSubmissionAction(
  raw: unknown,
  deps: { db: Firestore; now?: () => string; actorEmail?: string },
): Promise<AdminRecruiterSubmissionActionResult> {
  const parsed = AdminRecruiterSubmissionActionInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const { submissionId, action } = parsed.data
  const rejection = parsed.data.rejection
  if (action === "reject" && !rejection) {
    throw new HttpsError("invalid-argument", "rejection_required")
  }
  const note = action === "reject" ? rejection?.reason : cleanString(parsed.data.note)
  const requestMessage = cleanString(parsed.data.requestMessage)
  if (action === "request_info" && !requestMessage) {
    throw new HttpsError("invalid-argument", "requestMessage_required")
  }

  const ref = deps.db.collection(SUBMISSIONS_COLLECTION).doc(submissionId)

  if (action === "comment") {
    const message = cleanString(parsed.data.message)
    if (!message) {
      throw new HttpsError("invalid-argument", "message_required")
    }
    if (message.length > COMMENT_MESSAGE_MAX) {
      throw new HttpsError("invalid-argument", "message_too_long")
    }
    const exists = (await ref.get()).exists
    if (!exists) {
      throw new HttpsError("not-found", "submission_not_found")
    }
    const actorEmail = cleanString(deps.actorEmail)
    const commentRef = ref.collection(COMMENTS_SUBCOLLECTION).doc()
    await commentRef.set({
      message,
      by: "wekruit",
      authorName: actorEmail?.split("@")[0]?.trim() || "WeKruit",
      ...(actorEmail ? { authorEmail: actorEmail } : {}),
      at: deps.now?.() ?? new Date().toISOString(),
    })
    return { ok: true, submissionId, commentId: commentRef.id }
  }

  const checklistMarks = parsed.data.checklistMarks
  if (action === "save_marks") {
    // Pure assessment write: persist the operator's per-item checklist marks
    // (AI-derived + overrides) with NO status / decision change.
    if (!checklistMarks || Object.keys(checklistMarks).length === 0) {
      throw new HttpsError("invalid-argument", "checklistMarks_required")
    }
    const snap = await ref.get()
    if (!snap.exists) {
      throw new HttpsError("not-found", "submission_not_found")
    }
    const at = deps.now?.() ?? new Date().toISOString()
    const by = cleanString(deps.actorEmail) ?? "admin_token"
    await ref.set(
      { adminChecklistMarks: { marks: checklistMarks, by, at }, updatedAt: at },
      { merge: true },
    )
    return { ok: true, submissionId, status: cleanString((snap.data() ?? {}).status) ?? "" }
  }

  const snap = await ref.get()
  if (!snap.exists) {
    throw new HttpsError("not-found", "submission_not_found")
  }
  const data = (snap.data() ?? {}) as Record<string, unknown>
  const at = deps.now?.() ?? new Date().toISOString()
  const by = cleanString(deps.actorEmail) ?? "admin_token"
  const targetStatus = ACTION_TO_STATUS[action]
  const currentStatus = cleanString(data.status) ?? ""

  const patch: Record<string, unknown> = { updatedAt: at }
  // Persist the operator's checklist assessment alongside any decision (e.g.
  // override marks then reject in one go), not just the dedicated save_marks path.
  if (checklistMarks && Object.keys(checklistMarks).length > 0) {
    patch.adminChecklistMarks = { marks: checklistMarks, by, at }
  }
  if (action === "reject" && rejection) {
    const feedback = recruiterFeedbackForRejection(rejection.category, rejection.candidateTier)
    const chipReasons = (rejection.reasons ?? []).map((r) => r.trim()).filter(Boolean)
    patch.rejection = {
      category: rejection.category,
      candidateTier: rejection.candidateTier,
      reusableForOtherCompanies: reusableForCandidateTier(rejection.candidateTier),
      reason: rejection.reason,
      ...(chipReasons.length > 0 ? { reasons: chipReasons } : {}),
      by,
      at,
    }
    patch.recruiterFeedbackNote = rejection.reason
    patch.recruiterFeedbackRating = feedback.rating
    // Merge the tier-derived feedback reasons with the operator's quick-reject chips.
    patch.recruiterFeedbackReasons = [...new Set([...feedback.reasons, ...chipReasons])]
  }

  if (action === "request_info") {
    const existing = Array.isArray(data.requestedInfo)
      ? data.requestedInfo.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      : []
    patch.requestedInfo = [...existing, { message: requestMessage, at, by }]
    if (currentStatus !== targetStatus) {
      patch.status = targetStatus
      patch.statusHistory = appendStatusHistory(data, targetStatus, at)
    }
  } else {
    const existingDecision =
      data.adminDecision && typeof data.adminDecision === "object" && !Array.isArray(data.adminDecision)
        ? (data.adminDecision as Record<string, unknown>)
        : null
    const sameStatus = currentStatus === targetStatus
    if (sameStatus && existingDecision) {
      // Idempotent re-apply: keep the first decidedAt/by, update the note.
      const keptNote = note ?? cleanString(existingDecision.note)
      patch.adminDecision = {
        by: cleanString(existingDecision.by) ?? by,
        at: cleanString(existingDecision.at) ?? at,
        ...(keptNote ? { note: keptNote } : {}),
      }
    } else {
      patch.adminDecision = { by, at, ...(note ? { note } : {}) }
      if (!sameStatus) {
        patch.status = targetStatus
        patch.statusHistory = appendStatusHistory(data, targetStatus, at)
      }
    }
  }

  await ref.set(patch, { merge: true })
  if (action === "reject" && rejection) {
    const tracking = await recordRecruiterSubmissionRejection(deps.db, {
      submissionId,
      submission: data,
      rejection,
      actorEmail: by,
      now: at,
    })
    // Stamp the unified global candidate tier (best-wins) so this rejection
    // surfaces the candidate in the Rejected-by-tier browse for re-review.
    if (tracking.status === "tracked" && tracking.candidateId) {
      const jobId = cleanString(data.jobId) ?? cleanString(data.inboundJobId)
      await applyGlobalCandidateTier(
        {
          candidateId: tracking.candidateId,
          tier: rejection.candidateTier,
          source: "recruiter",
          ...(jobId ? { jobId } : {}),
          reason: rejection.reason,
          aiSuggestedTier: recruiterAiSuggestedTier(data),
          humanConfirmed: true,
          actor: by,
        },
        { db: deps.db, now: () => at },
      )
    }
  }
  return { ok: true, submissionId, status: targetStatus }
}

export const paAdminRecruiterSubmissionAction = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 60, maxInstances: 1, secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runAdminRecruiterSubmissionAction(req.data, {
      db: getFirestore(),
      actorEmail: cleanString(req.auth?.token?.email),
    })
  },
)
