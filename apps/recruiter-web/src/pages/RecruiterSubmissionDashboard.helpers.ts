import type { RecruiterSubmissionItem } from "../lib/recruiter-board-api.js"

type DashboardTone = "live" | "info" | "success" | "warn" | "mute"

export type RecruiterSubmissionDashboardHero = {
  label: string
  value: string
  body: string
  tone: DashboardTone
}

export type RecruiterSubmissionDashboard = {
  consentBlocked: RecruiterSubmissionItem[]
  active: RecruiterSubmissionItem[]
  advanced: RecruiterSubmissionItem[]
  closed: RecruiterSubmissionItem[]
  feedback: RecruiterSubmissionItem[]
  needsAction: RecruiterSubmissionItem[]
  hero: RecruiterSubmissionDashboardHero[]
}

const ACTIVE_REVIEW_STATUSES = ["submitted", "new", "reviewing", "backburner"]
const ADVANCED_STATUSES = ["advanced", "interviewing", "offer", "hired"]
const CLOSED_NEGATIVE_STATUSES = ["rejected", "duplicate"]
const OPEN_SUBMISSION_STATUSES = ["submitted", "new", "reviewing", "advanced", "interviewing", "backburner", "offer"]
const CANDIDATE_CONFIRMATION_RESEND_STATUSES = [
  "pending_candidate_confirmation",
  "confirmation_email_failed",
  "confirmation_email_not_configured",
]

export function candidateConfirmationCanResend(submission: Pick<RecruiterSubmissionItem, "candidateConsentStatus">): boolean {
  return CANDIDATE_CONFIRMATION_RESEND_STATUSES.includes(submission.candidateConsentStatus ?? "")
}

export function submissionIsConfirmedActiveReview(
  submission: Pick<RecruiterSubmissionItem, "status" | "candidateConsentStatus">,
): boolean {
  return submissionIsActiveReview(submission) && !candidateConfirmationCanResend(submission)
}

export function submissionIsConfirmedOpen(
  submission: Pick<RecruiterSubmissionItem, "status" | "candidateConsentStatus">,
): boolean {
  return OPEN_SUBMISSION_STATUSES.includes(submission.status ?? "submitted") && !candidateConfirmationCanResend(submission)
}

export function buildRecruiterSubmissionDashboard(
  submissions: RecruiterSubmissionItem[],
): RecruiterSubmissionDashboard {
  const consentBlocked = submissions.filter(candidateConfirmationCanResend)
  const active = submissions.filter(submissionIsConfirmedActiveReview)
  const advanced = submissions.filter(submissionIsAdvanced)
  const closed = submissions.filter(submissionIsClosed)
  const feedback = submissions.filter(submissionHasStructuredFeedback)
  const needsAction = submissions.filter(submissionNeedsAction)

  return {
    consentBlocked,
    active,
    advanced,
    closed,
    feedback,
    needsAction,
    hero: [
      {
        label: "Consent blocked",
        value: String(consentBlocked.length),
        body: "Candidate confirmation is missing or failed before review.",
        tone: consentBlocked.length ? "warn" : "mute",
      },
      {
        label: "Active review",
        value: String(active.length),
        body: "Confirmed packets submitted, queued, or under WeKruit review.",
        tone: active.length ? "live" : "mute",
      },
      {
        label: "Advanced",
        value: String(advanced.length),
        body: "Sent forward, interviewing, offer, or hired.",
        tone: advanced.length ? "success" : "mute",
      },
      {
        label: "Needs action",
        value: String(needsAction.length),
        body: "Consent blockers, aged reviews, or feedback that should change sourcing.",
        tone: needsAction.length ? "warn" : "success",
      },
    ],
  }
}

function submissionIsActiveReview(submission: Pick<RecruiterSubmissionItem, "status">): boolean {
  return ACTIVE_REVIEW_STATUSES.includes(submission.status ?? "submitted")
}

function submissionIsAdvanced(submission: Pick<RecruiterSubmissionItem, "status">): boolean {
  return ADVANCED_STATUSES.includes(submission.status ?? "")
}

function submissionIsClosed(submission: Pick<RecruiterSubmissionItem, "status">): boolean {
  return CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? "")
}

function submissionHasStructuredFeedback(
  submission: Pick<RecruiterSubmissionItem, "recruiterFeedbackNote" | "recruiterFeedbackRating" | "recruiterFeedbackReasons">,
): boolean {
  return Boolean(
    submission.recruiterFeedbackNote ||
    submissionFeedbackRating(submission) !== null ||
    (submission.recruiterFeedbackReasons ?? []).length,
  )
}

function submissionFeedbackRating(
  submission: Pick<RecruiterSubmissionItem, "recruiterFeedbackRating">,
): number | null {
  const n = typeof submission.recruiterFeedbackRating === "number"
    ? submission.recruiterFeedbackRating
    : Number(submission.recruiterFeedbackRating)
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null
}

function submissionNeedsAction(submission: RecruiterSubmissionItem): boolean {
  return (
    candidateConfirmationCanResend(submission) ||
    submissionHasStructuredFeedback(submission) ||
    (submissionIsActiveReview(submission) && !candidateConfirmationCanResend(submission) && submissionAgeDays(submission) >= 3)
  )
}

function submissionAgeDays(submission: Pick<RecruiterSubmissionItem, "createdAt">): number {
  const ms = timestampValueMs(submission.createdAt)
  if (!ms) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000))
}

function timestampValueMs(value: unknown): number {
  if (!value) return 0
  if (typeof value === "string") {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? 0 : ms
  }
  if (typeof value === "object" && "seconds" in value) {
    const seconds = Number((value as { seconds?: unknown }).seconds)
    return Number.isFinite(seconds) ? seconds * 1000 : 0
  }
  return 0
}
