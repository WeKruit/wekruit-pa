import { httpsCallable } from "firebase/functions"

export const RECRUITER_SUBMISSION_ACTION_CALLABLE = "paAdminRecruiterSubmissionAction"

export type RecruiterSubmissionAction =
  | "advance"
  | "reject"
  | "reviewing"
  | "duplicate"
  | "request_info"
  | "wekruit_interview"
  | "client_review"
  | "hired"
  | "save_marks"

export type RecruiterCandidateRejectionCategory = "quality" | "role_fit"
export type RecruiterCandidateTier = "tier_1" | "tier_2" | "tier_3"

/** Operator per-item checklist assessment (AI mark + override) keyed by rubric item. */
export type ChecklistMark = "met" | "gap" | "flag" | "clear"
export type RecruiterChecklistMarks = Record<string, ChecklistMark>

export interface RecruiterSubmissionRejectionInput {
  category: RecruiterCandidateRejectionCategory
  candidateTier: RecruiterCandidateTier
  reason: string
  /** Structured quick-reject chip ids the operator tapped (e.g. "weak_school"). */
  reasons?: string[]
}

/** Client-side mirror of the callable's status writes (for optimistic UI). save_marks does NOT change status. */
export const RECRUITER_SUBMISSION_ACTION_TO_STATUS: Record<RecruiterSubmissionAction, string> = {
  advance: "advanced",
  reject: "rejected",
  reviewing: "reviewing",
  duplicate: "duplicate",
  request_info: "reviewing",
  wekruit_interview: "wekruit_interview",
  client_review: "client_review",
  hired: "hired",
  save_marks: "",
}

export interface RecruiterSubmissionActionInput {
  submissionId: string
  action: RecruiterSubmissionAction
  note?: string
  requestMessage?: string
  rejection?: RecruiterSubmissionRejectionInput
  checklistMarks?: RecruiterChecklistMarks
  adminToken?: string
}

export interface RecruiterSubmissionActionResult {
  ok: true
  submissionId: string
  status: string
}

export async function runRecruiterSubmissionAction(
  input: RecruiterSubmissionActionInput,
): Promise<RecruiterSubmissionActionResult> {
  const { functions } = await import("./firebase.js")
  const fn = httpsCallable<RecruiterSubmissionActionInput, Partial<RecruiterSubmissionActionResult>>(
    functions(),
    RECRUITER_SUBMISSION_ACTION_CALLABLE,
  )
  const result = await fn(input)
  if (result.data?.ok !== true || !result.data.status) {
    throw new Error("recruiter_submission_action_failed")
  }
  return {
    ok: true,
    submissionId: result.data.submissionId ?? input.submissionId,
    status: result.data.status,
  }
}

// --- Company sends (per-company "waiting for hiring manager" tracking) ---
export type CompanySendStatus = "sent" | "waiting_hm" | "interested" | "passed"

export interface CompanySend {
  id: string
  company: string
  status: CompanySendStatus
  feedback?: string
  sentAt: string
  updatedAt: string
  by?: string
}

export interface CompanySendInput {
  id?: string
  company: string
  status?: CompanySendStatus
  feedback?: string
}

export const COMPANY_SEND_STATUS_LABEL: Record<CompanySendStatus, string> = {
  sent: "Sent to company",
  waiting_hm: "Waiting for hiring manager",
  interested: "HM interested",
  passed: "HM passed",
}

async function callCompanySendAction(payload: Record<string, unknown>): Promise<CompanySend[]> {
  const { functions } = await import("./firebase.js")
  const fn = httpsCallable<Record<string, unknown>, { ok?: boolean; companySends?: CompanySend[] }>(
    functions(),
    RECRUITER_SUBMISSION_ACTION_CALLABLE,
  )
  const result = await fn(payload)
  if (result.data?.ok !== true) throw new Error("company_send_action_failed")
  return result.data.companySends ?? []
}

export async function upsertCompanySend(submissionId: string, companySend: CompanySendInput): Promise<CompanySend[]> {
  return callCompanySendAction({ submissionId, action: "company_send_upsert", companySend })
}

export async function removeCompanySend(submissionId: string, companySendId: string): Promise<CompanySend[]> {
  return callCompanySendAction({ submissionId, action: "company_send_remove", companySendId })
}

export interface RecruiterSubmissionCommentInput {
  submissionId: string
  message: string
  adminToken?: string
}

export interface RecruiterSubmissionCommentResult {
  ok: true
  submissionId: string
  commentId: string
}

export async function sendRecruiterSubmissionComment(
  input: RecruiterSubmissionCommentInput,
): Promise<RecruiterSubmissionCommentResult> {
  const { functions } = await import("./firebase.js")
  const fn = httpsCallable<
    RecruiterSubmissionCommentInput & { action: "comment" },
    Partial<RecruiterSubmissionCommentResult>
  >(functions(), RECRUITER_SUBMISSION_ACTION_CALLABLE)
  const result = await fn({ ...input, action: "comment" })
  if (result.data?.ok !== true || !result.data.commentId) {
    throw new Error("recruiter_submission_comment_failed")
  }
  return {
    ok: true,
    submissionId: result.data.submissionId ?? input.submissionId,
    commentId: result.data.commentId,
  }
}
