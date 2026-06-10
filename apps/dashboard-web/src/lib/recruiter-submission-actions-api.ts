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

/** Client-side mirror of the callable's status writes (for optimistic UI). */
export const RECRUITER_SUBMISSION_ACTION_TO_STATUS: Record<RecruiterSubmissionAction, string> = {
  advance: "advanced",
  reject: "rejected",
  reviewing: "reviewing",
  duplicate: "duplicate",
  request_info: "reviewing",
  wekruit_interview: "wekruit_interview",
  client_review: "client_review",
  hired: "hired",
}

export interface RecruiterSubmissionActionInput {
  submissionId: string
  action: RecruiterSubmissionAction
  note?: string
  requestMessage?: string
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
