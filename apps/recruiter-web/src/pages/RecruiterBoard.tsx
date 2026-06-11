/**
 * Recruiter platform — /recruiters
 *
 * Invite-gated marketplace for WeKruit partner recruiters. Roles come from
 * pa-jobs through paCollabJobsList; submissions and recruiter-visible status
 * come from pa-recruiter-submissions.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react"
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from "firebase/auth"
import { Link, useSearchParams } from "react-router-dom"
import "../styles/recruiter-board.css"
import {
  recruiterNotificationInboxMeta,
  type RecruiterInboxAction,
  type RecruiterInboxTone,
} from "../lib/recruiter-inbox.js"
import {
  buildRecruiterSubmissionDashboard,
  candidateConfirmationCanResend,
  submissionCountsTowardRecruiterMetrics,
  submissionIsConfirmedActiveReview,
  submissionIsConfirmedOpen,
} from "./RecruiterSubmissionDashboard.helpers.js"
import {
  fetchCollabJobs,
  fetchRecruiterRoleFeedback,
  fetchRecruiterRoleIntelligence,
  fetchRecruiterRoleApplications,
  fetchRecruiterRoleQuestions,
  fetchRecruiterSourcedCandidates,
  fetchRecruiterSubmissions,
  fetchRecruiterNotifications,
  markRecruiterNotificationsRead,
  registerRecruiterAccess,
  checkRecruiterCandidateIdentity,
  resendRecruiterCandidateConfirmation,
  saveRecruiterSourcedCandidate,
  saveRecruiterRoleApplication,
  updateRecruiterPreferences,
  type CollabJob,
  type RecruiterCandidateIdentityCheckResult,
  type RecruiterCandidateOutreachStatus,
  type RecruiterNotificationItem,
  type RecruiterRoleApplicationInput,
  type RecruiterRoleApplicationItem,
  type RecruiterRoleFeedbackItem,
  type RecruiterRoleFeedbackReason,
  type RecruiterRoleIntelligenceItem,
  type RecruiterRoleQuestionItem,
  type RecruiterSession,
  type RecruiterSourcedCandidateInput,
  type RecruiterSourcedCandidateItem,
  type RecruiterSourcedCandidateStage,
  type RecruiterSubmissionItem,
} from "../lib/recruiter-board-api.js"
import { auth } from "../lib/firebase.js"
import { useRecruiterSession } from "../lib/recruiter-session-context.js"
import { SubmissionStatusStepper } from "../components/SubmissionStatusStepper.js"
import { SiteHeader } from "../components/SiteHeader.js"
import { SubmissionUpdatesToggle } from "../components/SubmissionUpdatesToggle.js"

type RecruiterTab = "roles" | "submissions"

const TABS: Array<{ id: RecruiterTab; label: string }> = [
  { id: "roles", label: "Roles" },
  { id: "submissions", label: "My submissions" },
]

const ROLE_FILTERS = [
  { id: "all", label: "All roles" },
  { id: "primary", label: "Approved access" },
  { id: "new", label: "New this week" },
  { id: "clean_lane", label: "Clean lanes" },
  { id: "market_moving", label: "Market moving" },
  { id: "needs_answers", label: "Needs WeKruit answer" },
] as const

type RoleFilter = typeof ROLE_FILTERS[number]["id"]

const ROLE_SORTS = [
  { id: "recommended", label: "Recommended" },
  { id: "clean_lane", label: "Clean lane" },
  { id: "market_signal", label: "Market signal" },
  { id: "newest", label: "Newest" },
  { id: "most_ready", label: "Most ready" },
] as const

type RoleSort = typeof ROLE_SORTS[number]["id"]

const APPROVED_ROLE_LIMIT = 10
const PENDING_ROLE_APPLICATION_LIMIT = 3
const SINGLE_SUBMISSION_WEEKLY_LIMIT = 100
const ROLE_PENDING_SUBMISSION_LIMIT = 5
const WEEKLY_SUBMISSION_TARGET = 8
const CALIBRATION_SLOT_LIMIT = 3
const DEFAULT_SUCCESS_FEE = 10_000
const PREFERRED_INTERVIEW_RATE_TARGET = 50
const RECRUITER_WEEKLY_CHALLENGE_KEY = "wk-recruiter-weekly-challenge-v1"

const PAYOUT_STATUS_LABELS: Record<string, { label: string; tone: "live" | "info" | "success" | "warn" | "mute"; body: string }> = {
  eligible: { label: "Eligible", tone: "live", body: "Eligible for payout once placement requirements are cleared." },
  pending_start: { label: "Pending start", tone: "info", body: "Waiting for start-date confirmation before payout can close." },
  invoice_ready: { label: "Invoice ready", tone: "success", body: "Ready for payout processing." },
  paid: { label: "Paid", tone: "success", body: "Payout recorded as paid." },
  void: { label: "Void", tone: "warn", body: "No payout expected for this submission." },
}

const SOURCE_STAGES: Array<{ id: RecruiterSourcedCandidateStage; label: string; tone: "live" | "info" | "success" | "warn" | "mute" }> = [
  { id: "sourced", label: "Sourced", tone: "mute" },
  { id: "contacted", label: "Contacted", tone: "info" },
  { id: "screened", label: "Screened", tone: "info" },
  { id: "ready", label: "Ready", tone: "live" },
  { id: "submitted", label: "Submitted", tone: "success" },
  { id: "archived", label: "Archived", tone: "mute" },
]

const OUTREACH_STATUSES: Array<{ id: RecruiterCandidateOutreachStatus; label: string; tone: "live" | "info" | "success" | "warn" | "mute" }> = [
  { id: "not_contacted", label: "Not contacted", tone: "mute" },
  { id: "contacted", label: "Contacted", tone: "info" },
  { id: "responded", label: "Responded", tone: "success" },
  { id: "not_interested", label: "Not interested", tone: "warn" },
]

const STATUS_LABELS: Record<string, { label: string; tone: "live" | "info" | "success" | "warn" | "mute" }> = {
  new: { label: "Submitted", tone: "live" },
  submitted: { label: "Submitted", tone: "live" },
  reviewing: { label: "WeKruit review", tone: "info" },
  wekruit_interview: { label: "WeKruit interview", tone: "info" },
  client_review: { label: "With client", tone: "success" },
  advanced: { label: "Sent to hiring team", tone: "success" },
  interviewing: { label: "Interviewing", tone: "success" },
  backburner: { label: "Backburner", tone: "info" },
  offer: { label: "Offer", tone: "success" },
  hired: { label: "Hired", tone: "success" },
  rejected: { label: "Not a fit", tone: "warn" },
  duplicate: { label: "Duplicate", tone: "mute" },
}

const SUBMISSION_FEEDBACK_REASON_LABELS: Record<string, string> = {
  strong_match: "Strong match",
  clear_evidence: "Clear evidence",
  good_candidate_motivation: "Candidate motivated",
  missing_hard_filter: "Missing hard filter",
  weak_evidence: "Weak evidence",
  candidate_not_interested: "Candidate not interested",
  duplicate: "Duplicate",
  comp_mismatch: "Comp mismatch",
  location_mismatch: "Location mismatch",
  seniority_mismatch: "Seniority mismatch",
}

const ROLE_FEEDBACK_REASON_LABELS: Record<RecruiterRoleFeedbackReason, string> = {
  low_comp: "Low compensation",
  location_mismatch: "Location mismatch",
  unclear_requirements: "Unclear requirements",
  small_candidate_pool: "Small candidate pool",
  hiring_team_slow: "Hiring team slow",
  role_too_broad: "Role too broad",
  candidate_interest_low: "Candidate interest low",
  too_many_recruiters: "Too many recruiters",
  other: "Other",
}

const CALIBRATION_LABELS: Record<string, { label: string; tone: "live" | "info" | "success" | "warn" | "mute" }> = {
  not_rated: { label: "Not rated", tone: "mute" },
  calibration_requested: { label: "Needs adjustment", tone: "info" },
  good_fit: { label: "Good fit", tone: "success" },
  bad_fit: { label: "Not a fit", tone: "warn" },
  suggested: { label: "Suggested direction", tone: "info" },
}

const SUBMISSION_FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active review" },
  { id: "late_stage", label: "Late stage" },
  { id: "advanced", label: "Advanced" },
  { id: "feedback", label: "Has feedback" },
  { id: "closed", label: "Closed" },
] as const

type SubmissionFilter = typeof SUBMISSION_FILTERS[number]["id"]
const ACTIVE_REVIEW_STATUSES = ["submitted", "new", "reviewing", "backburner"]
const ADVANCED_STATUSES = ["advanced", "wekruit_interview", "client_review", "interviewing", "offer", "hired"]
const LATE_STAGE_STATUSES = ["client_review", "interviewing", "offer", "hired"]
const CLOSED_NEGATIVE_STATUSES = ["rejected", "duplicate"]
const OPEN_SUBMISSION_STATUSES = ["submitted", "new", "reviewing", "advanced", "wekruit_interview", "client_review", "interviewing", "backburner", "offer"]
const RECRUITER_INTERVIEW_REWARD_STATUSES = new Set(["wekruit_interview", "client_review", "interviewing", "offer", "hired"])

function statusMeta(status?: string) {
  return STATUS_LABELS[status ?? "submitted"] ?? { label: status ?? "Submitted", tone: "mute" as const }
}

function submissionFeedbackRatingValue(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null
}

function submissionFeedbackRating(submission: RecruiterSubmissionItem): number | null {
  return submissionFeedbackRatingValue(submission.recruiterFeedbackRating)
}

function submissionFeedbackRatingLabel(submission: RecruiterSubmissionItem): string {
  const rating = submissionFeedbackRating(submission)
  return rating ? `${rating}/4` : "Unrated"
}

function submissionFeedbackRatingTone(submission: RecruiterSubmissionItem): "live" | "info" | "success" | "warn" | "mute" {
  const rating = submissionFeedbackRating(submission)
  if (rating === null) return "mute"
  if (rating >= 3) return "success"
  if (rating === 2) return "info"
  return "warn"
}

function submissionFeedbackReasonLabels(submission: RecruiterSubmissionItem): string[] {
  return (submission.recruiterFeedbackReasons ?? [])
    .map((reason) => SUBMISSION_FEEDBACK_REASON_LABELS[reason] ?? reason.replace(/_/g, " "))
    .slice(0, 6)
}

function submissionHasStructuredFeedback(submission: RecruiterSubmissionItem): boolean {
  return Boolean(
    submission.recruiterFeedbackNote ||
    submissionFeedbackRating(submission) !== null ||
    (submission.recruiterFeedbackReasons ?? []).length,
  )
}

function candidateConsentMeta(status?: string) {
  switch (status) {
    case "candidate_confirmed": return { label: "Candidate confirmed", tone: "success" as const }
    case "pending_candidate_confirmation": return { label: "Confirmation pending", tone: "info" as const }
    case "confirmation_email_failed": return { label: "Email failed", tone: "warn" as const }
    case "confirmation_email_not_configured": return { label: "Email not configured", tone: "warn" as const }
    default: return { label: "Recruiter consent", tone: "mute" as const }
  }
}

function calibrationMeta(status?: string) {
  return CALIBRATION_LABELS[status ?? "not_rated"] ?? { label: status?.replace(/_/g, " ") ?? "Not rated", tone: "mute" as const }
}

function canRequestCandidateCalibration(candidate: RecruiterSourcedCandidateItem): boolean {
  const hasRole = Boolean(candidate.inboundJobId || candidate.jobId)
  return (
    hasRole &&
    candidate.stage !== "submitted" &&
    candidate.stage !== "archived" &&
    (!candidate.calibrationStatus ||
      candidate.calibrationStatus === "not_rated" ||
      candidate.calibrationStatus === "suggested")
  )
}

function createdAtMs(s: RecruiterSubmissionItem): number {
  return timestampValueMs(s.createdAt)
}

function updatedAtMs(s: RecruiterSourcedCandidateItem): number {
  return timestampValueMs(s.updatedAt ?? s.createdAt)
}

function timestampValueMs(raw: unknown): number {
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "object" && typeof (raw as { seconds?: unknown }).seconds === "number") {
    return (raw as { seconds: number }).seconds * 1000
  }
  return 0
}

function formatWhen(s: RecruiterSubmissionItem): string {
  const ms = createdAtMs(s)
  return ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Just now"
}

function formatActivityDate(raw: unknown): string {
  const ms = timestampValueMs(raw)
  if (!ms) return "Now"
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

function submissionNextAction(status?: string): { title: string; body: string; tone: "live" | "info" | "success" | "warn" | "mute" } {
  switch (status) {
    case "reviewing":
      return { title: "WeKruit is reviewing", body: "Hold additional lookalikes until the review note lands.", tone: "info" }
    case "wekruit_interview":
      return { title: "WeKruit interview", body: "Keep the candidate warm while WeKruit runs the first interview.", tone: "info" }
    case "client_review":
      return { title: "With client", body: "The packet is with the hiring team. Watch for client feedback.", tone: "success" }
    case "advanced":
      return { title: "Sent to hiring team", body: "Keep the candidate warm and be ready for interview logistics.", tone: "success" }
    case "interviewing":
      return { title: "Interviewing", body: "Watch for scheduling or closing feedback from WeKruit.", tone: "success" }
    case "offer":
      return { title: "Offer stage", body: "Keep the candidate warm while WeKruit confirms close process and start-date details.", tone: "success" }
    case "backburner":
      return { title: "Backburner", body: "Candidate is parked, not rejected. Wait for a clearer next step before adding lookalikes.", tone: "info" }
    case "hired":
      return { title: "Placement won", body: "This candidate reached hired status.", tone: "success" }
    case "rejected":
      return { title: "Read feedback before sourcing more", body: "Use the WeKruit note to tighten the next submission.", tone: "warn" }
    case "duplicate":
      return { title: "Duplicate candidate", body: "Do not continue outreach for this role unless WeKruit reopens it.", tone: "mute" }
    case "submitted":
    case "new":
    default:
      return { title: "Queued for triage", body: "WeKruit will move this into review or send feedback.", tone: "live" }
  }
}

type SubmissionActivityEvent = {
  id: string
  label: string
  detail: string
  at: string
  tone: "live" | "info" | "success" | "warn" | "mute"
  ms: number
}

function submissionActivityEvents(submission: RecruiterSubmissionItem): SubmissionActivityEvent[] {
  const events: SubmissionActivityEvent[] = []
  const consent = candidateConsentMeta(submission.candidateConsentStatus)
  for (const [index, item] of (submission.statusHistory ?? []).entries()) {
    const meta = statusMeta(item.status)
    const ms = item.atIso ? Date.parse(item.atIso) || 0 : 0
    const rating = submissionFeedbackRatingValue(item.rating)
    const reasons = (item.reasons ?? [])
      .map((reason) => SUBMISSION_FEEDBACK_REASON_LABELS[reason] ?? reason.replace(/_/g, " "))
      .slice(0, 4)
    const detail = [
      rating ? `Rating ${rating}/4` : "",
      item.note || (item.by === "recruiter" ? "Submitted by recruiter" : "Updated by WeKruit"),
      reasons.length ? reasons.join(", ") : "",
    ].filter(Boolean).join(" · ")
    events.push({
      id: `status-${index}-${item.status}`,
      label: meta.label,
      detail,
      at: formatActivityDate(item.atIso),
      tone: meta.tone,
      ms,
    })
  }
  if (!events.some((event) => event.label === "Submitted")) {
    events.push({
      id: "created",
      label: "Submitted",
      detail: "Submitted by recruiter",
      at: formatActivityDate(submission.createdAt),
      tone: "live",
      ms: timestampValueMs(submission.createdAt),
    })
  }
  if (submission.recruiterFeedbackNote && !events.some((event) => event.detail === submission.recruiterFeedbackNote)) {
    events.push({
      id: "feedback",
      label: "WeKruit feedback",
      detail: submission.recruiterFeedbackNote,
      at: formatActivityDate(submission.recruiterFeedbackUpdatedAt ?? submission.updatedAt),
      tone: statusMeta(submission.status).tone,
      ms: timestampValueMs(submission.recruiterFeedbackUpdatedAt ?? submission.updatedAt),
    })
  }
  const rating = submissionFeedbackRating(submission)
  if (rating !== null && !events.some((event) => event.label === "Submission rating")) {
    const reasons = submissionFeedbackReasonLabels(submission)
    events.push({
      id: "feedback-rating",
      label: "Submission rating",
      detail: [`${rating}/4`, reasons.length ? reasons.join(", ") : ""].filter(Boolean).join(" · "),
      at: formatActivityDate(submission.recruiterFeedbackUpdatedAt ?? submission.updatedAt),
      tone: submissionFeedbackRatingTone(submission),
      ms: timestampValueMs(submission.recruiterFeedbackUpdatedAt ?? submission.updatedAt),
    })
  }
  if (submission.candidateConsentStatus && submission.candidateConsentStatus !== "recruiter_asserted") {
    events.push({
      id: `candidate-consent-${submission.candidateConsentStatus}`,
      label: consent.label,
      detail: submission.candidateConfirmation?.candidateEmail || submission.candidate?.email || "Candidate confirmation status updated",
      at: formatActivityDate(submission.candidateConfirmation?.confirmedAt ?? submission.candidateConfirmation?.sentAt ?? submission.updatedAt),
      tone: consent.tone,
      ms: timestampValueMs(submission.candidateConfirmation?.confirmedAt ?? submission.candidateConfirmation?.sentAt ?? submission.updatedAt),
    })
  }
  return events
    .sort((a, b) => (a.ms || Number.MAX_SAFE_INTEGER) - (b.ms || Number.MAX_SAFE_INTEGER))
    .slice(-8)
}

function shortText(text: string | undefined, fallback = "—", max = 56): string {
  if (!text) return fallback
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function sortSubmissions(rows: RecruiterSubmissionItem[]): RecruiterSubmissionItem[] {
  return [...rows].sort((a, b) => createdAtMs(b) - createdAtMs(a))
}

function sortSourcedCandidates(rows: RecruiterSourcedCandidateItem[]): RecruiterSourcedCandidateItem[] {
  return [...rows].sort((a, b) => updatedAtMs(b) - updatedAtMs(a))
}

function notificationCreatedAtMs(notification: RecruiterNotificationItem): number {
  return timestampValueMs(notification.createdAt ?? notification.updatedAt)
}

function sortRecruiterNotifications(rows: RecruiterNotificationItem[]): RecruiterNotificationItem[] {
  return [...rows].sort((a, b) => notificationCreatedAtMs(b) - notificationCreatedAtMs(a))
}

function submissionScore(s: RecruiterSubmissionItem): string {
  if (!s.score) return "Score pending"
  return `Hard ${s.score.hardChecked}/${s.score.hardTotal} · Fit ${s.score.fitChecked}/${s.score.fitTotal}`
}

function submissionReceiptId(submission: RecruiterSubmissionItem): string {
  return submission.submissionId || submission.id
}

function submissionDomId(submissionId: string): string {
  return `submission-${submissionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

function submissionModeLabel(mode?: RecruiterSubmissionItem["submissionMode"]): string {
  switch (mode) {
    case "primary_role": return "Approved role lane"
    case "single_submission": return "Single-submit lane"
    default: return "Submission lane pending"
  }
}

function submissionIsActiveReview(submission: RecruiterSubmissionItem): boolean {
  return ACTIVE_REVIEW_STATUSES.includes(submission.status ?? "submitted")
}

function submissionIsAdvanced(submission: RecruiterSubmissionItem): boolean {
  return ADVANCED_STATUSES.includes(submission.status ?? "")
}

function submissionIsClosed(submission: RecruiterSubmissionItem): boolean {
  return CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? "")
}

function submissionAgeDays(submission: RecruiterSubmissionItem): number {
  const ms = timestampValueMs(submission.createdAt)
  if (!ms) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000))
}

function submissionNeedsAction(submission: RecruiterSubmissionItem): boolean {
  return (
    submissionHasStructuredFeedback(submission) ||
    candidateConfirmationCanResend(submission) ||
    (submissionIsActiveReview(submission) && submissionAgeDays(submission) >= 3)
  )
}

function candidateConfirmationActionBody(submission: RecruiterSubmissionItem): string {
  const email = submission.candidateConfirmation?.candidateEmail || submission.candidate?.email || "the candidate"
  if (submission.candidateConsentStatus === "confirmation_email_failed") {
    return `The confirmation email to ${email} failed. Resend it before assuming the candidate approved the submission.`
  }
  if (submission.candidateConsentStatus === "confirmation_email_not_configured") {
    return "Candidate confirmation email is not configured in the current environment."
  }
  const count = submission.candidateConfirmation?.resendCount ?? 0
  return count > 0
    ? `Confirmation is still pending for ${email}. Last resend: ${formatActivityDate(submission.candidateConfirmation?.lastResentAt ?? submission.candidateConfirmation?.sentAt)}.`
    : `Confirmation is pending for ${email}. Resend if they did not receive the email.`
}

function submissionFilterMatches(submission: RecruiterSubmissionItem, filter: SubmissionFilter): boolean {
  switch (filter) {
    case "active": return submissionIsActiveReview(submission)
    case "late_stage": return LATE_STAGE_STATUSES.includes(submission.status ?? "")
    case "advanced": return submissionIsAdvanced(submission)
    case "feedback": return submissionHasStructuredFeedback(submission)
    case "closed": return submissionIsClosed(submission)
    case "all":
    default:
      return true
  }
}

function submissionSearchText(submission: RecruiterSubmissionItem): string {
  return [
    submission.candidate?.name,
    submission.candidate?.email,
    submission.candidate?.link,
    submission.candidate?.currentRole,
    submission.candidate?.notes,
    submission.jobTitleSnapshot,
    submission.companyLabelSnapshot,
    submission.status,
    submission.submissionMode,
    submissionFeedbackRatingLabel(submission),
    submissionFeedbackReasonLabels(submission).join(" "),
    submissionReceiptId(submission),
  ].filter(Boolean).join(" ").toLowerCase()
}

function submissionFeedbackSummary(submission: RecruiterSubmissionItem): string {
  const rating = submissionFeedbackRating(submission)
  const reasons = submissionFeedbackReasonLabels(submission)
  if (submission.recruiterFeedbackNote) return shortText(submission.recruiterFeedbackNote, "—", 80)
  if (rating !== null && reasons.length) return `${rating}/4 · ${reasons.slice(0, 2).join(", ")}`
  if (rating !== null) return `${rating}/4`
  if (reasons.length) return reasons.slice(0, 2).join(", ")
  return "Waiting for WeKruit"
}

function submissionRewardLabel(submission: RecruiterSubmissionItem): string {
  const status = submission.status ?? "submitted"
  if (CLOSED_NEGATIVE_STATUSES.includes(status)) return "—"
  return RECRUITER_INTERVIEW_REWARD_STATUSES.has(status) ? "$50" : "$50 if interview"
}

type SubmissionCommandAction = "browse_roles" | "open_submission" | "open_role" | "resend_confirmation"

type SubmissionCommandModel = {
  focus?: RecruiterSubmissionItem
  label: string
  title: string
  body: string
  cta: string
  tone: "live" | "info" | "success" | "warn" | "mute"
  action: SubmissionCommandAction
  href?: string
  cards: Array<{ label: string; value: string; body: string; tone: "live" | "info" | "success" | "warn" | "mute" }>
  queue: Array<{ id: string; label: string; title: string; body: string; tone: "live" | "info" | "success" | "warn" | "mute" }>
}

type SubmissionDealRoomGate = {
  label: string
  value: string
  body: string
  tone: "live" | "info" | "success" | "warn" | "mute"
}

type SubmissionDealRoomModel = {
  focus?: RecruiterSubmissionItem
  label: string
  title: string
  body: string
  tone: "live" | "info" | "success" | "warn" | "mute"
  primaryLabel: string
  primaryAction: SubmissionCommandAction
  href?: string
  candidate: string
  role: string
  company: string
  receipt: string
  payoutValue: string
  payoutLabel: string
  payoutBody: string
  payoutTone: "live" | "info" | "success" | "warn" | "mute"
  gates: SubmissionDealRoomGate[]
  risks: SubmissionDealRoomGate[]
  timeline: SubmissionActivityEvent[]
}

type SubmissionPipelineCardModel = {
  id: string
  candidate: string
  role: string
  company: string
  meta: string
  status: string
  receipt: string
  tone: "live" | "info" | "success" | "warn" | "mute"
}

type SubmissionPipelineLaneModel = {
  id: string
  label: string
  body: string
  tone: "live" | "info" | "success" | "warn" | "mute"
  items: SubmissionPipelineCardModel[]
}

function submissionCandidateName(submission: RecruiterSubmissionItem): string {
  return submission.candidate?.name || "Candidate"
}

function submissionCommandPriority(submission: RecruiterSubmissionItem): number {
  if (candidateConfirmationCanResend(submission)) return 100
  if (submissionIsClosed(submission) && submissionHasStructuredFeedback(submission)) return 92
  if (submissionHasStructuredFeedback(submission)) return 82
  if (submissionIsActiveReview(submission) && submissionAgeDays(submission) >= 3) return 74
  if (submissionIsAdvanced(submission)) return 68
  if (submissionIsActiveReview(submission)) return 40
  return 20
}

function sortSubmissionCommands(submissions: RecruiterSubmissionItem[]): RecruiterSubmissionItem[] {
  return [...submissions].sort((a, b) =>
    submissionCommandPriority(b) - submissionCommandPriority(a) ||
    timestampValueMs(b.recruiterFeedbackUpdatedAt ?? b.updatedAt ?? b.createdAt) -
      timestampValueMs(a.recruiterFeedbackUpdatedAt ?? a.updatedAt ?? a.createdAt),
  )
}

function submissionCommandBody(submission: RecruiterSubmissionItem): string {
  const rating = submissionFeedbackRating(submission)
  const reasons = submissionFeedbackReasonLabels(submission)
  if (submission.recruiterFeedbackNote) return submission.recruiterFeedbackNote
  if (rating !== null) {
    return [`WeKruit rating ${rating}/4`, reasons.length ? reasons.join(", ") : ""].filter(Boolean).join(" · ")
  }
  return submissionNextAction(submission.status).body
}

function buildSubmissionCommand(submissions: RecruiterSubmissionItem[]): SubmissionCommandModel {
  const focus = sortSubmissionCommands(submissions)[0]
  const actionableQueue = sortSubmissionCommands(submissions)
    .filter((submission) => submissionNeedsAction(submission) || submissionIsAdvanced(submission))
    .slice(0, 4)
    .map((submission) => {
      const status = statusMeta(submission.status)
      return {
        id: submission.id,
        label: status.label,
        title: submissionCandidateName(submission),
        body: submissionCommandBody(submission),
        tone: status.tone,
      }
    })

  if (!focus) {
    return {
      label: "Submission command",
      title: "No candidate packets yet",
      body: "Open a role, save a prospect, confirm consent, then submit the strongest packet into WeKruit review.",
      cta: "Browse roles",
      tone: "info",
      action: "browse_roles",
      href: "/recruiters?tab=roles",
      cards: [
        { label: "Submitted", value: "0", body: "No formal submissions from this recruiter account.", tone: "mute" },
        { label: "Consent", value: "Required", body: "Every packet needs candidate approval before review.", tone: "info" },
        { label: "Feedback", value: "Pending", body: "WeKruit ratings appear here after review.", tone: "mute" },
      ],
      queue: actionableQueue,
    }
  }

  const candidate = submissionCandidateName(focus)
  const status = statusMeta(focus.status)
  const consent = candidateConsentMeta(focus.candidateConsentStatus)
  const nextAction = submissionNextAction(focus.status)
  const ageDays = submissionAgeDays(focus)
  const roleHref = rolePathForRow(focus)
  const feedbackRating = submissionFeedbackRating(focus)
  const feedbackReasons = submissionFeedbackReasonLabels(focus)
  let label = "Submission command"
  let title = `${candidate} is ${status.label.toLowerCase()}`
  let body = nextAction.body
  let cta = "Open packet"
  let tone = status.tone
  let action: SubmissionCommandAction = "open_submission"
  let href: string | undefined

  if (candidateConfirmationCanResend(focus)) {
    label = "Candidate confirmation"
    title = `${candidate} has not confirmed consent`
    body = candidateConfirmationActionBody(focus)
    cta = "Resend confirmation"
    tone = consent.tone
    action = "resend_confirmation"
  } else if (submissionIsClosed(focus) && submissionHasStructuredFeedback(focus)) {
    label = "Feedback command"
    title = `Use ${candidate}'s feedback before sending lookalikes`
    body = submissionCommandBody(focus)
    cta = "Review feedback"
    tone = "warn"
  } else if (submissionHasStructuredFeedback(focus)) {
    label = "Feedback landed"
    title = `Calibrate around ${candidate}`
    body = submissionCommandBody(focus)
    cta = "Read feedback"
    tone = submissionFeedbackRatingTone(focus)
  } else if (submissionIsActiveReview(focus) && ageDays >= 3) {
    label = "Review aging"
    title = `${candidate} has waited ${ageDays} days`
    body = "This review is aging. Avoid flooding lookalikes until WeKruit gives a clearer signal on this packet."
    cta = "Open packet"
    tone = "warn"
  } else if (submissionIsAdvanced(focus)) {
    label = "Candidate moving"
    title = `${candidate} is moving forward`
    body = "Keep the candidate warm and stay ready for logistics while WeKruit works the hiring team."
    cta = roleHref ? "Open role" : "Open packet"
    tone = "success"
    action = roleHref ? "open_role" : "open_submission"
    href = roleHref
  }

  return {
    focus,
    label,
    title,
    body,
    cta,
    tone,
    action,
    href,
    cards: [
      { label: "Status", value: status.label, body: nextAction.title, tone: status.tone },
      {
        label: "Consent",
        value: consent.label,
        body: focus.candidateConfirmation?.candidateEmail || focus.candidate?.email || "Candidate approval tracked on the receipt.",
        tone: consent.tone,
      },
      {
        label: "Feedback",
        value: feedbackRating === null ? "Not rated" : `${feedbackRating}/4`,
        body: feedbackReasons.length ? feedbackReasons.slice(0, 3).join(", ") : "No structured WeKruit feedback yet.",
        tone: feedbackRating === null ? "mute" : submissionFeedbackRatingTone(focus),
      },
      {
        label: "Age",
        value: `${ageDays}d`,
        body: `Submitted ${formatActivityDate(focus.createdAt)}.`,
        tone: ageDays >= 3 && submissionIsActiveReview(focus) ? "warn" : "info",
      },
      {
        label: "Lane",
        value: submissionModeLabel(focus.submissionMode),
        body: submissionReceiptId(focus),
        tone: "info",
      },
    ],
    queue: actionableQueue,
  }
}

function buildSubmissionDealRoom(submissions: RecruiterSubmissionItem[], jobs: CollabJob[]): SubmissionDealRoomModel {
  const focus = sortSubmissionCommands(submissions)[0]
  if (!focus) {
    return {
      label: "Submission deal room",
      title: "No live packet yet",
      body: "Create a consented candidate packet from a recruiter role. The active packet will show consent, review, feedback, payout, and recent movement here.",
      tone: "info",
      primaryLabel: "Browse roles",
      primaryAction: "browse_roles",
      href: "/recruiters?tab=roles",
      candidate: "No candidate",
      role: "No role",
      company: "WeKruit",
      receipt: "Pending",
      payoutValue: "$0",
      payoutLabel: "Projected",
      payoutBody: "Payout appears after a candidate packet exists.",
      payoutTone: "mute",
      gates: [
        { label: "Consent", value: "Required", body: "Candidate approval is required before WeKruit review.", tone: "info" },
        { label: "Review", value: "Waiting", body: "No submitted packet is in review yet.", tone: "mute" },
        { label: "Feedback", value: "Pending", body: "WeKruit ratings appear after review.", tone: "mute" },
        { label: "Payout", value: "$0", body: "Estimated fee appears after a role-backed packet exists.", tone: "mute" },
      ],
      risks: [{ label: "Next step", value: "Create packet", body: "Pick an approved role lane and submit one high-proof candidate.", tone: "info" }],
      timeline: [],
    }
  }

  const jobsById = new Map(jobs.map((job) => [roleKey(job), job]))
  const job = jobsById.get(submissionRoleId(focus))
  const candidate = submissionCandidateName(focus)
  const role = focus.jobTitleSnapshot || job?.title || "Role"
  const company = focus.companyLabelSnapshot || job?.recruiterBoard.label.company || "Company"
  const status = statusMeta(focus.status)
  const consent = candidateConsentMeta(focus.candidateConsentStatus)
  const nextAction = submissionNextAction(focus.status)
  const roleHref = rolePathForRow(focus)
  const feedbackRating = submissionFeedbackRating(focus)
  const feedbackReasons = submissionFeedbackReasonLabels(focus)
  const payoutMeta = recruiterPayoutStatusMeta(focus.recruiterPayout?.status)
  const payoutValue = formatCurrencyShort(recruiterPayoutAmount(focus, jobsById))
  const hasRecordedPayout = Boolean(focus.recruiterPayout?.status && focus.recruiterPayout.status !== "none")
  const ageDays = submissionAgeDays(focus)
  const receipt = submissionReceiptId(focus)
  let title = `${candidate} packet is ${status.label.toLowerCase()}`
  let body = `${role} at ${company}. ${nextAction.body}`
  let primaryLabel = "Open packet"
  let primaryAction: SubmissionCommandAction = "open_submission"
  let href: string | undefined
  let tone = status.tone

  if (candidateConfirmationCanResend(focus)) {
    title = `${candidate} needs consent confirmed`
    body = candidateConfirmationActionBody(focus)
    primaryLabel = "Resend confirmation"
    primaryAction = "resend_confirmation"
    tone = consent.tone
  } else if (submissionHasStructuredFeedback(focus)) {
    title = `Close the loop on ${candidate}`
    body = submissionCommandBody(focus)
    primaryLabel = "Read feedback"
    tone = submissionFeedbackRatingTone(focus)
  } else if (submissionIsAdvanced(focus) && roleHref) {
    title = `${candidate} is moving with the hiring team`
    body = "Keep the candidate warm and use the role room for next sourcing or logistics context."
    primaryLabel = "Open role"
    primaryAction = "open_role"
    href = roleHref
    tone = "success"
  } else if (submissionIsActiveReview(focus) && ageDays >= 3) {
    title = `${candidate} review is aging`
    body = "Do not flood lookalikes until WeKruit gives a clearer packet signal."
    tone = "warn"
  }

  const risks: SubmissionDealRoomGate[] = []
  if (candidateConfirmationCanResend(focus)) {
    risks.push({ label: "Consent risk", value: consent.label, body: candidateConfirmationActionBody(focus), tone: consent.tone })
  }
  if (submissionIsActiveReview(focus) && ageDays >= 3) {
    risks.push({ label: "Review aging", value: `${ageDays} days`, body: "Hold more lookalikes until the current review produces a signal.", tone: "warn" })
  }
  if (submissionIsClosed(focus) && submissionHasStructuredFeedback(focus)) {
    risks.push({ label: "Loop closure", value: "Feedback", body: "Apply this note before sourcing similar candidates.", tone: "warn" })
  }
  if (feedbackRating !== null && feedbackRating <= 2) {
    risks.push({ label: "Quality hold", value: `${feedbackRating}/4`, body: feedbackReasons.length ? feedbackReasons.join(", ") : "Low packet rating needs calibration.", tone: feedbackRating === 1 ? "warn" : "info" })
  }
  if (risks.length === 0) {
    risks.push({ label: "Next step", value: nextAction.title, body: nextAction.body, tone: nextAction.tone })
  }

  return {
    focus,
    label: "Submission deal room",
    title,
    body,
    tone,
    primaryLabel,
    primaryAction,
    href,
    candidate,
    role,
    company,
    receipt,
    payoutValue,
    payoutLabel: hasRecordedPayout ? payoutMeta.label : "Projected",
    payoutBody: payoutTimingForSubmission(focus),
    payoutTone: hasRecordedPayout ? payoutMeta.tone : status.tone,
    gates: [
      {
        label: "Consent",
        value: consent.label,
        body: focus.candidateConfirmation?.candidateEmail || focus.candidate?.email || "Candidate approval is recorded on this packet.",
        tone: consent.tone,
      },
      {
        label: "Review",
        value: status.label,
        body: `${nextAction.title}. Submitted ${formatActivityDate(focus.createdAt)}.`,
        tone: status.tone,
      },
      {
        label: "Feedback",
        value: feedbackRating === null ? "Not rated" : `${feedbackRating}/4`,
        body: feedbackReasons.length ? feedbackReasons.join(", ") : focus.recruiterFeedbackNote || "Waiting for WeKruit feedback.",
        tone: feedbackRating === null ? "mute" : submissionFeedbackRatingTone(focus),
      },
      {
        label: "Payout",
        value: payoutValue,
        body: hasRecordedPayout ? `${payoutMeta.label}: ${payoutTimingForSubmission(focus)}` : payoutTimingForSubmission(focus),
        tone: hasRecordedPayout ? payoutMeta.tone : status.tone,
      },
    ],
    risks,
    timeline: [...submissionActivityEvents(focus)].reverse().slice(0, 5),
  }
}

function submissionPipelineLaneId(submission: RecruiterSubmissionItem): string {
  const status = submission.status ?? "submitted"
  if (candidateConfirmationCanResend(submission)) return "consent"
  if (status === "offer" || status === "hired") return "closing"
  if (status === "advanced" || status === "interviewing") return "hiring_team"
  if (status === "reviewing" || status === "backburner") return "review"
  if (status === "rejected" || status === "duplicate") return "closed"
  return "submitted"
}

function submissionPipelineCard(submission: RecruiterSubmissionItem): SubmissionPipelineCardModel {
  const status = statusMeta(submission.status)
  const rating = submissionFeedbackRating(submission)
  const reasons = submissionFeedbackReasonLabels(submission)
  const age = `${submissionAgeDays(submission)}d`
  const feedback = rating !== null
    ? `${rating}/4${reasons.length ? ` · ${reasons.slice(0, 2).join(", ")}` : ""}`
    : status.label
  return {
    id: submission.id,
    candidate: submissionCandidateName(submission),
    role: shortText(submission.jobTitleSnapshot, "Role", 34),
    company: shortText(submission.companyLabelSnapshot, "Company", 28),
    meta: `${age} old · ${feedback}`,
    status: status.label,
    receipt: submissionReceiptId(submission),
    tone: status.tone,
  }
}

function buildSubmissionPipelineBoard(submissions: RecruiterSubmissionItem[]): SubmissionPipelineLaneModel[] {
  const laneDefs: Array<Omit<SubmissionPipelineLaneModel, "items">> = [
    {
      id: "consent",
      label: "Consent needed",
      body: "Candidate confirmation is missing or failed.",
      tone: submissions.some(candidateConfirmationCanResend) ? "warn" : "mute",
    },
    {
      id: "submitted",
      label: "Submitted",
      body: "Queued packets waiting for triage.",
      tone: "live",
    },
    {
      id: "review",
      label: "WeKruit review",
      body: "Under review, parked, or awaiting WeKruit signal.",
      tone: "info",
    },
    {
      id: "hiring_team",
      label: "Hiring team",
      body: "Advanced or interviewing with the company.",
      tone: "success",
    },
    {
      id: "closing",
      label: "Offer / hired",
      body: "Close process and payout movement.",
      tone: "success",
    },
    {
      id: "closed",
      label: "Closed feedback",
      body: "Rejected or duplicate packets to learn from.",
      tone: "warn",
    },
  ]
  const cardsByLane = new Map<string, SubmissionPipelineCardModel[]>()
  for (const submission of sortSubmissionCommands(submissions)) {
    const lane = submissionPipelineLaneId(submission)
    const cards = cardsByLane.get(lane) ?? []
    cards.push(submissionPipelineCard(submission))
    cardsByLane.set(lane, cards)
  }
  return laneDefs.map((lane) => ({
    ...lane,
    items: cardsByLane.get(lane.id) ?? [],
  }))
}

function roleKey(job: CollabJob): string {
  return job.jobId
}

function recruiterPrimaryRoleIds(session: RecruiterSession | null): string[] {
  return session?.recruiter.workspacePreferences?.primaryRoleIds ?? []
}

function roleApplicationMatches(job: CollabJob, application: RecruiterRoleApplicationItem): boolean {
  const key = roleKey(job)
  return application.inboundJobId === key || application.jobId === key
}

function latestRoleApplication(job: CollabJob, roleApplications: RecruiterRoleApplicationItem[]): RecruiterRoleApplicationItem | undefined {
  return roleApplications
    .filter((application) => roleApplicationMatches(job, application))
    .sort((a, b) => timestampValueMs(b.updatedAt ?? b.createdAt) - timestampValueMs(a.updatedAt ?? a.createdAt))[0]
}

function recruiterApprovedRoleIds(session: RecruiterSession | null, roleApplications: RecruiterRoleApplicationItem[]): string[] {
  const legacyPrimaryIds = recruiterPrimaryRoleIds(session)
  const approvedIds = roleApplications
    .filter((application) => application.status === "approved")
    .flatMap((application) => [application.inboundJobId, application.jobId])
    .filter((id): id is string => Boolean(id))
  return [...new Set([...legacyPrimaryIds, ...approvedIds])].slice(0, APPROVED_ROLE_LIMIT)
}

function roleApplicationStatusLabel(status?: RecruiterRoleApplicationItem["status"]): string {
  switch (status) {
    case "approved": return "Approved"
    case "pending": return "Pending approval"
    case "not_approved": return "Not approved"
    case "withdrawn": return "Withdrawn"
    case "rescinded": return "Rescinded"
    default: return "Not applied"
  }
}

function roleApplicationStatusTone(status?: RecruiterRoleApplicationItem["status"]): "live" | "info" | "success" | "warn" | "mute" {
  switch (status) {
    case "approved": return "success"
    case "pending": return "info"
    case "not_approved":
    case "rescinded": return "warn"
    case "withdrawn": return "mute"
    default: return "mute"
  }
}

function isPrimaryRole(job: CollabJob, primaryRoleIds: string[]): boolean {
  return primaryRoleIds.includes(roleKey(job))
}

function roleUpdatedMs(job: CollabJob): number {
  return job.updatedAt ? Date.parse(job.updatedAt) || 0 : 0
}

function isNewRole(job: CollabJob): boolean {
  const updatedMs = roleUpdatedMs(job)
  return updatedMs > 0 && Date.now() - updatedMs <= 7 * 86_400_000
}

function candidateName(c: RecruiterSourcedCandidateItem): string {
  return c.candidate?.name || "Unnamed candidate"
}

function sourceStageMeta(stage?: RecruiterSourcedCandidateStage) {
  return SOURCE_STAGES.find((s) => s.id === stage) ?? SOURCE_STAGES[0]!
}

function outreachMeta(status?: RecruiterCandidateOutreachStatus) {
  return OUTREACH_STATUSES.find((s) => s.id === (status ?? "not_contacted")) ?? OUTREACH_STATUSES[0]!
}

function dateInputToIso(value: string): string | null {
  if (!value) return null
  const parsed = new Date(`${value}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function isoToDateInput(raw?: string | null): string {
  if (!raw) return ""
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return ""
  return parsed.toISOString().slice(0, 10)
}

function formatFollowUpDate(raw?: string | null): string {
  if (!raw) return "No follow-up set"
  const ms = Date.parse(raw)
  if (!ms) return "No follow-up set"
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function candidateFollowUpState(candidate: RecruiterSourcedCandidateItem): {
  label: string
  body: string
  tone: "live" | "info" | "success" | "warn" | "mute"
  needsAction: boolean
} {
  const status = candidate.outreach?.status ?? "not_contacted"
  if (candidate.stage === "submitted" || candidate.stage === "archived") {
    return { label: "Closed loop", body: "This prospect is no longer in recruiter outreach.", tone: "mute", needsAction: false }
  }
  if (candidate.stage === "ready") {
    return { label: "Ready to submit", body: "Candidate is ready for role matching or submission.", tone: "live", needsAction: false }
  }
  if (status === "not_interested") {
    return { label: "Not interested", body: "No further outreach is expected unless the candidate re-opens.", tone: "warn", needsAction: false }
  }

  const ms = candidate.outreach?.nextFollowUpAt ? Date.parse(candidate.outreach.nextFollowUpAt) : 0
  if (!ms) {
    const body = status === "not_contacted"
      ? "No outreach attempt is logged yet."
      : "No next follow-up is scheduled."
    return { label: "No follow-up", body, tone: "mute", needsAction: status === "not_contacted" }
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrowMs = today.getTime() + 86_400_000
  if (ms < today.getTime()) {
    return { label: "Follow-up overdue", body: `Was due ${formatFollowUpDate(candidate.outreach?.nextFollowUpAt)}.`, tone: "warn", needsAction: true }
  }
  if (ms < tomorrowMs) {
    return { label: "Follow-up today", body: "This prospect needs a touch today.", tone: "live", needsAction: true }
  }
  return { label: `Follow-up ${formatFollowUpDate(candidate.outreach?.nextFollowUpAt)}`, body: "Next touch is scheduled.", tone: "info", needsAction: false }
}

const RECRUITER_MATCH_STOP_WORDS = new Set([
  "and", "are", "but", "can", "for", "from", "has", "have", "into", "our", "per", "the", "this", "that",
  "their", "they", "with", "you", "your", "candidate", "candidates", "role", "team", "work", "working",
  "experience", "years", "strong", "good", "fit", "must", "nice", "need", "needs", "build", "building",
])

function normalizeTokens(value: string | undefined): string[] {
  if (!value) return []
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !RECRUITER_MATCH_STOP_WORDS.has(token))
}

function cleanRecruiterEmail(value: string): string {
  return value.trim().toLowerCase()
}

function cleanRecruiterInviteCode(value: string): string {
  return value.trim().toUpperCase()
}

function cleanRecruiterName(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function createRecruiterGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: "select_account" })
  return provider
}

const RECRUITER_ACCESS_PENDING_KEY = "wk_recruiter_access_pending_v2"

interface PendingRecruiterAccess {
  inviteCode: string
  name: string
  createdAtMs: number
  emailHint?: string
}

export interface RecruiterInviteLink {
  code: string
  emailHint: string
}

export function readRecruiterInviteLinkFromLocation(): RecruiterInviteLink | null {
  if (typeof window === "undefined") return null
  const params = new URLSearchParams(window.location.search)
  const code = cleanRecruiterInviteCode(params.get("code") ?? "")
  const emailHint = cleanRecruiterEmail(params.get("email") ?? "")
  // `?invite=1&email=...` is the codeless email-bound invite; `?code=WK-...`
  // stays supported for legacy invite emails still in flight.
  if (!code && params.get("invite") !== "1") return null
  return { code, emailHint }
}


function readPendingRecruiterAccess(): PendingRecruiterAccess | null {
  const readStored = (storage: Storage): PendingRecruiterAccess | null => {
    const raw = storage.getItem(RECRUITER_ACCESS_PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingRecruiterAccess>
    // An empty inviteCode is a codeless email-bound claim — keep the slot.
    if (typeof parsed.inviteCode !== "string") return null
    if (typeof parsed.name !== "string") return null
    if (typeof parsed.createdAtMs !== "number" || Date.now() - parsed.createdAtMs > 10 * 60 * 1000) {
      storage.removeItem(RECRUITER_ACCESS_PENDING_KEY)
      return null
    }
    return {
      inviteCode: parsed.inviteCode,
      name: cleanRecruiterName(parsed.name),
      createdAtMs: parsed.createdAtMs,
      ...(typeof parsed.emailHint === "string" && parsed.emailHint
        ? { emailHint: cleanRecruiterEmail(parsed.emailHint) }
        : {}),
    }
  }

  try {
    const pending = readStored(window.sessionStorage)
    if (pending) return pending
  } catch {
    // sessionStorage can be unavailable in private browsing.
  }
  try {
    return readStored(window.localStorage)
  } catch {
    return null
  }
}

export function writePendingRecruiterAccess(inviteCode: string, name: string, emailHint?: string) {
  const payload = JSON.stringify({
    inviteCode,
    name,
    createdAtMs: Date.now(),
    ...(emailHint ? { emailHint } : {}),
  })
  let wrote = false
  try {
    window.sessionStorage.setItem(RECRUITER_ACCESS_PENDING_KEY, payload)
    wrote = true
  } catch {
    // sessionStorage can be unavailable in private browsing.
  }
  try {
    window.localStorage.setItem(RECRUITER_ACCESS_PENDING_KEY, payload)
    wrote = true
  } catch {
    // localStorage can be unavailable in private browsing.
  }
  if (!wrote) throw new Error("Browser storage is blocking recruiter access. Enable site storage and try again.")
}

function clearPendingRecruiterAccess() {
  try {
    window.sessionStorage.removeItem(RECRUITER_ACCESS_PENDING_KEY)
  } catch {
    // sessionStorage can be unavailable in private browsing.
  }
  try {
    window.localStorage.removeItem(RECRUITER_ACCESS_PENDING_KEY)
  } catch {
    // localStorage can be unavailable in private browsing.
  }
}

function authErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : ""
}

function formatRecruiterAuthError(
  error: unknown,
  inviteEmailHint?: string,
  claim?: { codeless?: boolean; email?: string },
): string {
  const code = authErrorCode(error)
  switch (code) {
    case "auth/account-exists-with-different-credential":
      return "That email already uses another Firebase sign-in method. Use the Google account WeKruit invited."
    case "auth/cancelled-popup-request":
      return "Google sign-in was interrupted. Try again."
    case "auth/unauthorized-domain":
      return "This domain is not authorized for Google sign-in in Firebase yet."
    default:
      if (error instanceof Error) {
        if (error.message === "unauthorized") {
          return "This Google account does not have recruiter access yet. Sign in with the email WeKruit invited."
        }
        if (error.message === "email_mismatch") {
          return inviteEmailHint
            ? `This invite is for ${inviteEmailHint}. Sign in with that Google account.`
            : "This invite is bound to a different email. Sign in with the Google account that received the invite."
        }
        if (error.message === "invalid_or_expired_invite_code") {
          if (claim?.codeless) {
            const invitedAddress = claim.email || inviteEmailHint
            return invitedAddress
              ? `No invitation found for ${invitedAddress}. Ask your WeKruit contact to invite this address, or retry with a different Google account.`
              : "No invitation found for this Google account. Ask your WeKruit contact to invite this address, or retry with a different Google account."
          }
          return "No valid invitation found for this Google account. Ask your WeKruit contact to send a new invite."
        }
        if (error.message) return error.message
      }
      return code ? code.replace(/^auth\//, "").replace(/-/g, " ") : "Recruiter access failed."
  }
}

export default function RecruiterBoard() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [inviteLink] = useState<RecruiterInviteLink | null>(readRecruiterInviteLinkFromLocation)
  const { session, authReady, profileLoadFailed, retryProfile, setSession } = useRecruiterSession()
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [sourcedCandidates, setSourcedCandidates] = useState<RecruiterSourcedCandidateItem[]>([])
  const [submissions, setSubmissions] = useState<RecruiterSubmissionItem[]>([])
  const [roleApplications, setRoleApplications] = useState<RecruiterRoleApplicationItem[]>([])
  const [roleFeedback, setRoleFeedback] = useState<RecruiterRoleFeedbackItem[]>([])
  const [roleQuestions, setRoleQuestions] = useState<RecruiterRoleQuestionItem[]>([])
  const [roleIntelligence, setRoleIntelligence] = useState<RecruiterRoleIntelligenceItem[]>([])
  const [notifications, setNotifications] = useState<RecruiterNotificationItem[]>([])
  const [statusLoaded, setStatusLoaded] = useState(false)
  const [roleApplicationSavingId, setRoleApplicationSavingId] = useState<string | null>(null)
  const [accessDraftJobId, setAccessDraftJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const tabParam = searchParams.get("tab")
  // Unknown / retired tabs (?tab=earnings, ?tab=overview, ...) fall back to Roles.
  const activeTab = TABS.some((t) => t.id === tabParam) ? tabParam as RecruiterTab : "roles"

  // Invite-link mode: persist the code (+email hint) before auth resolves so a
  // signed-in recruiter claims in zero clicks, then strip the params from the URL.
  useEffect(() => {
    if (!inviteLink) return
    try {
      writePendingRecruiterAccess(inviteLink.code, "", inviteLink.emailHint || undefined)
    } catch {
      // Storage blocked; the gate button re-writes the slot before sign-in.
    }
    if (searchParams.has("code") || searchParams.has("email") || searchParams.has("invite")) {
      const next = new URLSearchParams(searchParams)
      next.delete("code")
      next.delete("email")
      next.delete("invite")
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteLink])

  useEffect(() => {
    fetchCollabJobs()
      .then((list) => setJobs(list))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  useEffect(() => {
    if (session) return
    setSourcedCandidates([])
    setSubmissions([])
    setRoleApplications([])
    setRoleFeedback([])
    setRoleQuestions([])
    setRoleIntelligence([])
    setNotifications([])
    setStatusLoaded(false)
  }, [session])

  const reloadSubmissions = async () => {
    if (!session) return
    try {
      setSubmissionError(null)
      setStatusLoaded(false)
      const [submissionRows, sourceRows, applicationRows, feedbackRows, questionRows, intelligenceRows, notificationRows] = await Promise.all([
        fetchRecruiterSubmissions(),
        fetchRecruiterSourcedCandidates(),
        fetchRecruiterRoleApplications(),
        fetchRecruiterRoleFeedback(),
        fetchRecruiterRoleQuestions(),
        fetchRecruiterRoleIntelligence(),
        fetchRecruiterNotifications(),
      ])
      setSubmissions(sortSubmissions(submissionRows))
      setSourcedCandidates(sortSourcedCandidates(sourceRows))
      setRoleApplications(applicationRows)
      setRoleFeedback(feedbackRows)
      setRoleQuestions(questionRows)
      setRoleIntelligence(intelligenceRows)
      setNotifications(sortRecruiterNotifications(notificationRows))
      setStatusLoaded(true)
    } catch (e) {
      setSubmissionError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void reloadSubmissions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.recruiterId])

  const setTab = (tab: RecruiterTab) => setSearchParams(tab === "roles" ? {} : { tab })
  if (!authReady) {
    return <div className="rb-access"><div className="rb-state">Loading recruiter workspace...</div></div>
  }

  if (!session) {
    if (profileLoadFailed) {
      return (
        <div className="rb-access">
          <div className="rb-state error">
            Couldn't load your recruiter profile. You're still signed in.
            <button type="button" className="rb-btn" onClick={retryProfile}>Retry</button>
          </div>
        </div>
      )
    }
    return (
      <RecruiterAccessGate
        inviteLink={inviteLink}
        onSessionClaimed={setSession}
      />
    )
  }

  const openJobs = jobs ?? []
  return (
    <div className="rb-platform">
      <aside className="rb-platform__nav">
        <Link to="/" className="rb-platform__brand" aria-label="WeKruit">
          <span className="rb-platform__logo">W</span>
          <span>
            <strong>WeKruit</strong>
            <em>Recruiter</em>
          </span>
        </Link>
        <div className="rb-platform__identity">
          <span className="rb-platform__avatar">{session.recruiter.name.slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{session.recruiter.name}</strong>
            <em>{session.recruiter.email}</em>
          </span>
        </div>
        <SubmissionUpdatesToggle session={session} onSessionChange={setSession} compact />
        <nav className="rb-platform__tabs" aria-label="Recruiter workspace">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? "is-active" : ""}
              onClick={() => setTab(tab.id)}
            >
              {tab.label}
              {tab.id === "submissions" && submissions.length > 0 ? <span>{submissions.length}</span> : null}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="rb-platform__signout"
          onClick={() => {
            void signOut(auth())
            setSession(null)
            setSourcedCandidates([])
            setSubmissions([])
            setRoleApplications([])
            setRoleFeedback([])
            setRoleQuestions([])
            setRoleIntelligence([])
            setNotifications([])
            setStatusLoaded(false)
          }}
        >
          Sign out
        </button>
      </aside>

      <main className="rb-platform__main">
        <header className="rb-platform__top">
          <div>
            <h1>{TABS.find((t) => t.id === activeTab)?.label}</h1>
          </div>
          <div className="rb-platform__top-actions">
            <button type="button" className="rb-btn" onClick={() => void reloadSubmissions()}>
              Refresh status
            </button>
          </div>
        </header>

        {error && <div className="rb-state error">Could not load roles: {error}</div>}
        {submissionError && <div className="rb-state error">Could not load your submissions: {submissionError}</div>}

        {activeTab === "roles" && (
          <RolesListTab jobs={openJobs} loading={!jobs && !error} />
        )}
        {activeTab === "submissions" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "submissions" && statusLoaded && (
          <SubmissionsTab
            session={session}
            onSessionChange={setSession}
            submissions={submissions}
            onRefresh={reloadSubmissions}
            onRoles={() => setTab("roles")}
            onCandidates={() => setTab("roles")}
          />
        )}
      </main>
    </div>
  )
}

function computeRecruiterStats(
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
) {
  const metricSubmissions = submissions.filter(submissionCountsTowardRecruiterMetrics)
  const reviewing = submissions.filter(submissionIsConfirmedActiveReview).length
  const advanced = metricSubmissions.filter((s) => ADVANCED_STATUSES.includes(s.status ?? "")).length
  const interviews = metricSubmissions.filter((s) => LATE_STAGE_STATUSES.includes(s.status ?? "")).length
  const feedback = metricSubmissions.filter(submissionHasStructuredFeedback).length
  const activeSource = sourcedCandidates.filter((c) => c.stage !== "archived").length
  const interviewRate = metricSubmissions.length ? Math.round((interviews / metricSubmissions.length) * 100) : 0
  return [
    { label: "Open roles", value: String(jobs.length), meta: "live WeKruit collab searches", signal: "live", tone: "live" },
    { label: "Sourced candidates", value: String(activeSource), meta: "saved before submission", signal: "+", tone: "info" },
    { label: "Pending review", value: String(reviewing), meta: "confirmed packets waiting on WeKruit", signal: "wait", tone: "warn" },
    { label: "Interview rate", value: `${interviewRate}%`, meta: feedback ? `${advanced} advanced - ${feedback} rated/feedback` : `${advanced} advanced`, signal: "rate", tone: "success" },
  ]
}

type OperatingTone = "live" | "info" | "success" | "warn" | "mute"

type RecruiterPrimaryCta = {
  href: string
  label: string
  title: string
  body: string
  tone: OperatingTone
}

type RecruiterOperatingMetric = {
  label: string
  value: string
  body: string
  tone: OperatingTone
}

type RecruiterOperatingMetrics = {
  statusLabel: string
  statusBody: string
  statusTone: OperatingTone
  qualityScore: number | null
  qualityLabel: string
  qualityBody: string
  reviewLabel: string
  reviewBody: string
  reviewTone: OperatingTone
  challengeTitle: string
  challengeBody: string
  challengeTarget: string
  cards: RecruiterOperatingMetric[]
  targets: RecruiterOperatingMetric[]
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function computeRecruiterOperatingMetrics(
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  roleFeedback: RecruiterRoleFeedbackItem[],
  roleQuestions: RecruiterRoleQuestionItem[],
  roleIntelligence: RecruiterRoleIntelligenceItem[],
  primaryRoleIds: string[],
): RecruiterOperatingMetrics {
  const activeCandidates = sourcedCandidates.filter((candidate) => candidate.stage !== "archived")
  const readyCandidates = activeCandidates.filter((candidate) => candidate.stage === "ready")
  const metricSubmissions = submissions.filter(submissionCountsTowardRecruiterMetrics)
  const pendingSubmissions = submissions.filter(submissionIsConfirmedActiveReview)
  const advancedSubmissions = metricSubmissions.filter((submission) => ADVANCED_STATUSES.includes(submission.status ?? ""))
  const closedNegative = metricSubmissions.filter((submission) => CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? ""))
  const ratedSubmissions = metricSubmissions
    .map(submissionFeedbackRating)
    .filter((rating): rating is number => rating !== null)
  const averageRating = ratedSubmissions.length
    ? ratedSubmissions.reduce((sum, rating) => sum + rating, 0) / ratedSubmissions.length
    : null
  const feedbackNotes = submissions.filter(submissionHasStructuredFeedback).length
  const openQuestions = roleQuestions.filter((question) => (question.status ?? "open") === "open").length
  const intelligenceByJob = new Map(roleIntelligence.map((item) => [item.jobId, item]))
  const cleanLanes = jobs.filter((job) => (intelligenceByJob.get(roleKey(job))?.submissionCount ?? rowsForRole(job, submissions).length) === 0).length
  const activePrimaryRoles = primaryRoleIds.length
  const primaryRolesWithActivity = jobs.filter((job) => {
    if (!isPrimaryRole(job, primaryRoleIds)) return false
    return rowsForRole(job, submissions).length > 0 || rowsForRole(job, sourcedCandidates).some((candidate) => candidate.stage !== "archived")
  }).length
  const slotUtilization = activePrimaryRoles ? Math.round((primaryRolesWithActivity / activePrimaryRoles) * 100) : 0
  const sourceToSubmitRate = activeCandidates.length ? Math.round((metricSubmissions.length / activeCandidates.length) * 100) : 0
  const firstRoundRate = metricSubmissions.length ? Math.round((advancedSubmissions.length / metricSubmissions.length) * 100) : 0
  const rejectionRate = metricSubmissions.length ? Math.round((closedNegative.length / metricSubmissions.length) * 100) : 0
  const hardOrBlockedRoles = roleIntelligence.length
    ? roleIntelligence.filter((item) => item.feedback.hard > 0 || item.feedback.blocked > 0).length
    : roleFeedback.filter((feedback) => feedback.difficulty === "hard" || feedback.difficulty === "blocked").length
  const remainingWeeklySubmissions = Math.min(WEEKLY_SUBMISSION_TARGET, Math.max(1, WEEKLY_SUBMISSION_TARGET - metricSubmissions.length))
  const qualityScore = metricSubmissions.length
    ? clampNumber(Math.round(
      averageRating !== null
        ? 32 + (averageRating / 4) * 60 + Math.min(8, firstRoundRate / 10) - Math.min(12, rejectionRate / 5)
        : 58 + firstRoundRate * 0.55 - rejectionRate * 0.45 + Math.min(16, feedbackNotes * 3),
    ), 24, 98)
    : activeCandidates.length
      ? clampNumber(44 + readyCandidates.length * 7 + Math.min(14, activeCandidates.length * 2), 44, 74)
      : null
  const statusLabel = metricSubmissions.length >= WEEKLY_SUBMISSION_TARGET && firstRoundRate >= 30 && rejectionRate <= 40
    ? "Preferred track"
    : metricSubmissions.length >= 3 || activeCandidates.length >= 6
      ? "Standard track"
      : "Builder track"
  const statusBody = statusLabel === "Preferred track"
    ? "You have enough submission activity and interview movement to justify more role access."
    : statusLabel === "Standard track"
      ? "You have visible activity. Keep the quality bar high before asking for more lanes."
      : "Build a visible sourcing record before the platform can trust more role volume."
  const statusTone: OperatingTone = statusLabel === "Preferred track" ? "success" : statusLabel === "Standard track" ? "info" : "mute"
  const qualityLabel = qualityScore === null ? "No score yet" : `${qualityScore}/100`
  const qualityBody = qualityScore === null
    ? "Save prospects and submit with consent to start a quality signal."
    : averageRating !== null
      ? `${averageRating.toFixed(1)}/4 average submission rating across ${ratedSubmissions.length} rated submission${ratedSubmissions.length === 1 ? "" : "s"}.`
    : metricSubmissions.length < 3
      ? "Early signal only. More submissions and feedback will make this meaningful."
      : `${firstRoundRate}% advanced/interview/offer signal with ${rejectionRate}% rejected or duplicate.`
  const reviewTone: OperatingTone = activeCandidates.length === 0 && metricSubmissions.length === 0
    ? "mute"
    : rejectionRate >= 50 && metricSubmissions.length >= 3
      ? "warn"
      : hardOrBlockedRoles > 0 || openQuestions > 0
        ? "info"
        : "success"
  const reviewLabel = reviewTone === "warn"
    ? "Calibration review"
    : reviewTone === "info"
      ? "Needs calibration"
      : reviewTone === "success"
        ? "Healthy activity"
        : "No activity yet"
  const reviewBody = reviewTone === "warn"
    ? "Rejection or duplicate rate is high. Slow down and use role feedback before more submissions."
    : reviewTone === "info"
      ? "Open questions or hard-role feedback should be cleared before adding more volume."
      : reviewTone === "success"
        ? "Current activity is within the quality bar. Keep status updates moving."
        : "Start with sourced candidates tied to approved roles."
  const challengeTitle = openQuestions > 0
    ? "Clear the calibration queue"
    : readyCandidates.length > 0
      ? "Convert ready candidates"
      : cleanLanes > 0
        ? "Build first shortlists"
        : "Refresh active lanes"
  const challengeBody = openQuestions > 0
    ? "Ask precise role questions and wait for WeKruit answers before sourcing through uncertainty."
    : readyCandidates.length > 0
      ? "Move ready candidates into the strongest role briefs while consent is fresh."
      : cleanLanes > 0
        ? "Pick clean-lane roles and add sourced prospects before another recruiter gets there."
        : "Update candidate stages and use feedback to source tighter lookalikes."
  const challengeTarget = openQuestions > 0
    ? `${openQuestions} open question${openQuestions === 1 ? "" : "s"}`
    : readyCandidates.length > 0
      ? `${Math.min(readyCandidates.length, 3)} ready-to-submit`
    : cleanLanes > 0
      ? `3 prospects in ${Math.min(cleanLanes, 2)} clean lane${cleanLanes === 1 ? "" : "s"}`
      : `${remainingWeeklySubmissions} quality submission${remainingWeeklySubmissions === 1 ? "" : "s"}`
  return {
    statusLabel,
    statusBody,
    statusTone,
    qualityScore,
    qualityLabel,
    qualityBody,
    reviewLabel,
    reviewBody,
    reviewTone,
    challengeTitle,
    challengeBody,
    challengeTarget,
    cards: [
      {
        label: "Recruiter status",
        value: statusLabel,
        body: statusBody,
        tone: statusTone,
      },
      {
        label: "Quality signal",
        value: qualityLabel,
        body: qualityBody,
        tone: qualityScore === null ? "mute" : qualityScore >= 75 ? "success" : qualityScore >= 58 ? "info" : "warn",
      },
      {
        label: "Primary utilization",
        value: `${slotUtilization}%`,
        body: activePrimaryRoles
          ? `${primaryRolesWithActivity}/${activePrimaryRoles} approved roles have live candidates or submissions.`
          : "Earn approved role access before scaling submissions.",
        tone: slotUtilization >= 80 ? "success" : slotUtilization > 0 ? "info" : "mute",
      },
      {
        label: "Weekly pace",
        value: `${metricSubmissions.length}/${WEEKLY_SUBMISSION_TARGET}`,
        body: `${pendingSubmissions.length} pending, ${advancedSubmissions.length} advanced, ${cleanLanes} clean lanes open.`,
        tone: metricSubmissions.length >= WEEKLY_SUBMISSION_TARGET ? "success" : metricSubmissions.length ? "info" : "mute",
      },
    ],
    targets: [
      {
        label: "This week's challenge",
        value: challengeTarget,
        body: `${challengeTitle}. ${challengeBody}`,
        tone: openQuestions > 0 ? "warn" : readyCandidates.length > 0 ? "live" : "info",
      },
      {
        label: "Submission quality",
        value: `${firstRoundRate}%`,
        body: "Keep the advanced/interview/offer signal moving before asking for more role volume.",
        tone: firstRoundRate >= 30 ? "success" : metricSubmissions.length ? "info" : "mute",
      },
      {
        label: "Calibration debt",
        value: String(openQuestions + hardOrBlockedRoles),
        body: "Open questions plus hard or blocked role signals.",
        tone: openQuestions + hardOrBlockedRoles > 0 ? "warn" : "success",
      },
      {
        label: "Source to submit",
        value: `${sourceToSubmitRate}%`,
        body: "Saved prospects converted into formal submissions.",
        tone: sourceToSubmitRate >= 35 ? "success" : activeCandidates.length ? "info" : "mute",
      },
    ],
  }
}

type RecruiterCockpitAction = "roles" | "matches" | "candidates" | "submissions" | "performance" | "access"
type RecruiterInboxOwner = "recruiter" | "wekruit" | "hiring_team" | "candidate" | "platform"

type RecruiterCockpitModel = {
  missionLabel: string
  missionTitle: string
  missionBody: string
  missionAction: RecruiterCockpitAction
  missionCta: string
  missionTone: OperatingTone
  focusRole?: RoleInsight
  focusCandidate?: RecruiterSourcedCandidateItem
  focusCandidateRoleLabel?: string
  focusSubmission?: RecruiterSubmissionItem
  steps: Array<{
    label: string
    value: string
    body: string
    action: RecruiterCockpitAction
    tone: OperatingTone
  }>
}

type RecruiterLaunchItem = {
  label: string
  title: string
  body: string
  cta: string
  action: RecruiterCockpitAction
  complete: boolean
  tone: OperatingTone
}

type RecruiterLaunchModel = {
  completed: number
  total: number
  nextItem: RecruiterLaunchItem
  items: RecruiterLaunchItem[]
}

type RecruiterInboxOwnerMeta = {
  id: RecruiterInboxOwner
  label: string
  body: string
  tone: RecruiterInboxTone
}

type RecruiterInboxClock = {
  label: string
  tone: RecruiterInboxTone
  stale: boolean
}

type RecruiterInboxTriageLane = {
  label: string
  value: string
  body: string
  action: RecruiterInboxAction
  cta: string
  tone: RecruiterInboxTone
  item?: RecruiterInboxItem
}

function submissionActionPriority(submission: RecruiterSubmissionItem): number {
  if (candidateConfirmationCanResend(submission)) return 100
  if (CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? "") && submissionHasStructuredFeedback(submission)) return 92
  if (submissionHasStructuredFeedback(submission)) return 82
  if (ADVANCED_STATUSES.includes(submission.status ?? "")) return 70
  if (ACTIVE_REVIEW_STATUSES.includes(submission.status ?? "submitted")) {
    const createdAtMs = timestampValueMs(submission.createdAt)
    return createdAtMs && Date.now() - createdAtMs > 3 * 86_400_000 ? 66 : 44
  }
  return 20
}

function selectFocusCandidate(candidates: RecruiterSourcedCandidateItem[]): RecruiterSourcedCandidateItem | undefined {
  return [...candidates]
    .filter((candidate) => candidate.stage !== "archived" && candidate.stage !== "submitted")
    .sort((a, b) => {
      const stageRank = (candidate: RecruiterSourcedCandidateItem) =>
        candidate.stage === "ready" ? 5 :
        candidateFollowUpState(candidate).needsAction ? 4 :
        candidate.calibrationStatus === "good_fit" ? 3 :
        candidate.stage === "screened" ? 2 :
        candidate.stage === "contacted" ? 1 :
        0
      return stageRank(b) - stageRank(a) || timestampValueMs(b.updatedAt ?? b.createdAt) - timestampValueMs(a.updatedAt ?? a.createdAt)
    })[0]
}

function buildRecruiterPrimaryCta(input: {
  jobs: CollabJob[]
  submissions: RecruiterSubmissionItem[]
  sourcedCandidates: RecruiterSourcedCandidateItem[]
  roleQuestions: RecruiterRoleQuestionItem[]
  notifications: RecruiterNotificationItem[]
}): RecruiterPrimaryCta {
  const activeCandidates = [...input.sourcedCandidates]
    .filter((candidate) => candidate.stage !== "archived" && candidate.stage !== "submitted")
    .sort((a, b) => timestampValueMs(b.updatedAt ?? b.createdAt) - timestampValueMs(a.updatedAt ?? a.createdAt))
  const readyCandidates = activeCandidates.filter((candidate) => candidate.stage === "ready")
  const readyWithRole = readyCandidates.find((candidate) => Boolean(rolePathForRow(candidate, candidate.id)))
  if (readyWithRole) {
    return {
      href: rolePathForRow(readyWithRole, readyWithRole.id) ?? "/recruiters?tab=matches",
      label: "Submit ready candidate",
      title: candidateName(readyWithRole),
      body: sourcedCandidateRoleLabel(readyWithRole),
      tone: "live",
    }
  }

  const readyPrivate = readyCandidates[0]
  if (readyPrivate) {
    return {
      href: "/recruiters?tab=matches",
      label: "Match ready candidate",
      title: candidateName(readyPrivate),
      body: "Ready candidate needs a role match before submission.",
      tone: "live",
    }
  }

  const followUp = activeCandidates.find((candidate) => candidateFollowUpState(candidate).needsAction)
  if (followUp) {
    const followUpState = candidateFollowUpState(followUp)
    return {
      href: "/recruiters?tab=candidates",
      label: "Follow up candidate",
      title: candidateName(followUp),
      body: followUpState.body,
      tone: followUpState.tone,
    }
  }

  const inbox = buildRecruiterInboxSummary(input.submissions, input.sourcedCandidates, input.roleQuestions, input.notifications)
  if (inbox.needsAction > 0) {
    const details = [
      inbox.candidateConfirmationNeeds ? `${inbox.candidateConfirmationNeeds} confirmation${inbox.candidateConfirmationNeeds === 1 ? "" : "s"}` : null,
      inbox.openQuestions ? `${inbox.openQuestions} role question${inbox.openQuestions === 1 ? "" : "s"}` : null,
      inbox.unreadNotifications ? `${inbox.unreadNotifications} unread update${inbox.unreadNotifications === 1 ? "" : "s"}` : null,
      inbox.followUpDue ? `${inbox.followUpDue} follow-up${inbox.followUpDue === 1 ? "" : "s"}` : null,
    ].filter((detail): detail is string => Boolean(detail))
    return {
      href: "/recruiters?tab=inbox",
      label: "Open next move",
      title: `${inbox.needsAction} action${inbox.needsAction === 1 ? " needs" : "s need"} owner`,
      body: details.length ? details.slice(0, 2).join(" + ") : "Review the action queue before new sourcing.",
      tone: "warn",
    }
  }

  if (activeCandidates.length > 0) {
    return {
      href: "/recruiters?tab=matches",
      label: "Open matchboard",
      title: "Match candidate bench",
      body: `${activeCandidates.length} active candidate${activeCandidates.length === 1 ? "" : "s"} can be checked against live roles.`,
      tone: "info",
    }
  }

  if (input.jobs.length > 0) {
    return {
      href: "/recruiters?tab=roles",
      label: "Browse roles",
      title: "Find a role lane",
      body: `${input.jobs.length} open WeKruit role${input.jobs.length === 1 ? "" : "s"} available for focused sourcing.`,
      tone: "info",
    }
  }

  return {
    href: "/recruiters?tab=candidates",
    label: "Start sourcing",
    title: "Build candidate bench",
    body: "Save prospects with proof before the first submission.",
    tone: "mute",
  }
}

function buildRecruiterLaunchModel(
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  roleFeedback: RecruiterRoleFeedbackItem[],
  primaryRoleIds: string[],
): RecruiterLaunchModel {
  const activeCandidates = sourcedCandidates.filter((candidate) => candidate.stage !== "archived")
  const readyCandidates = activeCandidates.filter((candidate) => candidate.stage === "ready" || candidate.stage === "submitted")
  const activeSubmissions = submissions.filter(submissionIsConfirmedOpen)
  const feedbackSignals = submissions.filter(submissionHasStructuredFeedback).length + roleFeedback.length
  const hasRoleLane = primaryRoleIds.length > 0
  const hasCandidateBench = activeCandidates.length > 0
  const hasReadyShortlist = readyCandidates.length > 0 || submissions.length > 0
  const hasSubmission = submissions.length > 0
  const hasFeedback = feedbackSignals > 0
  const matchedCount = readyCandidates.length || submissions.length
  const items: RecruiterLaunchItem[] = [
    {
      label: "01",
      title: "Claim role lane",
      body: hasRoleLane
        ? `${primaryRoleIds.length}/${APPROVED_ROLE_LIMIT} approved role lane${primaryRoleIds.length === 1 ? "" : "s"} active.`
        : jobs.length
          ? "Choose a focused role lane before spending sourcing cycles."
          : "WeKruit role releases will appear here when available.",
      cta: hasRoleLane ? "Review lanes" : "Choose role",
      action: "roles",
      complete: hasRoleLane,
      tone: hasRoleLane ? "success" : jobs.length ? "live" : "mute",
    },
    {
      label: "02",
      title: "Build private bench",
      body: hasCandidateBench
        ? `${activeCandidates.length} active candidate${activeCandidates.length === 1 ? "" : "s"} saved before submission.`
        : "Save prospects with notes, links, and fit signal before sending packets.",
      cta: hasCandidateBench ? "Open bench" : "Add candidate",
      action: "candidates",
      complete: hasCandidateBench,
      tone: hasCandidateBench ? "success" : "info",
    },
    {
      label: "03",
      title: "Match shortlist",
      body: hasReadyShortlist
        ? `${matchedCount} candidate${matchedCount === 1 ? "" : "s"} reached match or submit state.`
        : "Use the matchboard to turn bench candidates into role-specific shortlists.",
      cta: hasReadyShortlist ? "Review matches" : "Open matchboard",
      action: "matches",
      complete: hasReadyShortlist,
      tone: hasReadyShortlist ? "success" : hasCandidateBench ? "live" : "mute",
    },
    {
      label: "04",
      title: "Submit with receipt",
      body: hasSubmission
        ? `${submissions.length} submission${submissions.length === 1 ? "" : "s"} tracked, ${activeSubmissions.length} active.`
        : "Submit from a role brief after candidate consent is recorded.",
      cta: hasSubmission ? "Track submissions" : "Open roles",
      action: hasSubmission ? "submissions" : "roles",
      complete: hasSubmission,
      tone: hasSubmission ? "success" : hasReadyShortlist ? "live" : "mute",
    },
    {
      label: "05",
      title: "Learn and earn",
      body: hasFeedback
        ? `${feedbackSignals} feedback signal${feedbackSignals === 1 ? "" : "s"} available for calibration.`
        : "Read status, feedback, and payout movement before sending lookalikes.",
      cta: hasFeedback ? "Open performance" : "Open tracker",
      action: hasFeedback ? "performance" : "submissions",
      complete: hasFeedback,
      tone: hasFeedback ? "success" : hasSubmission ? "info" : "mute",
    },
  ]
  return {
    completed: items.filter((item) => item.complete).length,
    total: items.length,
    nextItem: items.find((item) => !item.complete) ?? items[items.length - 1],
    items,
  }
}

function buildRecruiterCockpitModel(
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  roleFeedback: RecruiterRoleFeedbackItem[],
  roleQuestions: RecruiterRoleQuestionItem[],
  roleIntelligence: RecruiterRoleIntelligenceItem[],
  roleApplications: RecruiterRoleApplicationItem[],
  primaryRoleIds: string[],
): RecruiterCockpitModel {
  const jobsById = new Map(jobs.map((job) => [roleKey(job), job]))
  const roleInsights = sortRoleInsights(
    jobs.map((job) => buildRoleInsight(job, submissions, sourcedCandidates, primaryRoleIds, roleFeedback, roleQuestions, roleIntelligence, roleApplications)),
    "recommended",
  )
  const focusRole = roleInsights[0]
  const focusCandidate = selectFocusCandidate(sourcedCandidates)
  const focusSubmission = [...submissions]
    .sort((a, b) => submissionActionPriority(b) - submissionActionPriority(a) || timestampValueMs(b.updatedAt ?? b.createdAt) - timestampValueMs(a.updatedAt ?? a.createdAt))[0]
  const openQuestions = roleQuestions.filter((question) => (question.status ?? "open") === "open").length
  const readyCandidates = sourcedCandidates.filter((candidate) => candidate.stage === "ready").length
  const privateBenchCandidates = sourcedCandidates.filter((candidate) => !candidate.jobId && !candidate.inboundJobId && candidate.stage !== "archived").length
  const candidateConfirmationNeeds = submissions.filter(candidateConfirmationCanResend).length
  const feedbackToRead = submissions.filter(submissionHasStructuredFeedback).length
  const activeSubmissions = submissions.filter(submissionIsConfirmedOpen).length
  const approvedRoleCount = primaryRoleIds.length
  const cleanLaneCount = roleInsights.filter((insight) => insight.cleanLane).length

  let missionLabel = "Start the marketplace loop"
  let missionTitle = "Choose one role and build a shortlist"
  let missionBody = "The fastest path is role focus, candidate proof, consented submission, then feedback learning."
  let missionAction: RecruiterCockpitAction = jobs.length ? "roles" : "candidates"
  let missionCta = jobs.length ? "Pick role" : "Add candidate"
  let missionTone: OperatingTone = "info"

  if (candidateConfirmationNeeds > 0 && focusSubmission) {
    missionLabel = "Candidate confirmation"
    missionTitle = `${candidateConfirmationNeeds} submission${candidateConfirmationNeeds === 1 ? "" : "s"} ${candidateConfirmationNeeds === 1 ? "needs" : "need"} consent follow-up`
    missionBody = "Candidate confirmation protects ownership and prevents weak submissions from polluting recruiter quality."
    missionAction = "submissions"
    missionCta = "Fix confirmations"
    missionTone = "warn"
  } else if (openQuestions > 0) {
    missionLabel = "Role calibration"
    missionTitle = `${openQuestions} open WeKruit question${openQuestions === 1 ? "" : "s"}`
    missionBody = "Clear role uncertainty before asking recruiters to spend sourcing cycles."
    missionAction = "access"
    missionCta = "Open access"
    missionTone = "warn"
  } else if (readyCandidates > 0) {
    const name = focusCandidate ? candidateName(focusCandidate) : "Ready candidate"
    missionLabel = "Submit next"
    missionTitle = `${name} is ready to match`
    missionBody = "Use the matchboard to pick the strongest role, then submit from the role brief with consent."
    missionAction = "matches"
    missionCta = "Match candidate"
    missionTone = "live"
  } else if (privateBenchCandidates > 0) {
    missionLabel = "Activate private bench"
    missionTitle = `${privateBenchCandidates} unassigned candidate${privateBenchCandidates === 1 ? "" : "s"}`
    missionBody = "Move bench candidates through the matchboard so the platform feels like a marketplace, not a spreadsheet."
    missionAction = "matches"
    missionCta = "Open matchboard"
    missionTone = "live"
  } else if (focusRole && (focusRole.cleanLane || focusRole.primary)) {
    missionLabel = focusRole.primary ? "Approved role coverage" : "Clean lane"
    missionTitle = focusRole.job.title
    missionBody = focusRole.nextActionBody
    missionAction = focusRole.primary ? "candidates" : "roles"
    missionCta = focusRole.primary ? "Source candidate" : "Open role"
    missionTone = focusRole.tone === "mute" ? "info" : focusRole.tone
  } else if (feedbackToRead > 0) {
    missionLabel = "Learning loop"
    missionTitle = `${feedbackToRead} feedback signal${feedbackToRead === 1 ? "" : "s"} to read`
    missionBody = "Strong recruiter marketplaces improve when recruiters learn from outcomes before sending lookalikes."
    missionAction = "submissions"
    missionCta = "Read feedback"
    missionTone = "info"
  }

  return {
    missionLabel,
    missionTitle,
    missionBody,
    missionAction,
    missionCta,
    missionTone,
    focusRole,
    focusCandidate,
    focusCandidateRoleLabel: focusCandidate ? rowRoleLabel(focusCandidate, jobsById) : undefined,
    focusSubmission,
    steps: [
      {
        label: "Roles to work",
        value: `${approvedRoleCount}/${APPROVED_ROLE_LIMIT}`,
        body: cleanLaneCount ? `${cleanLaneCount} clean lane${cleanLaneCount === 1 ? "" : "s"} available.` : "Use role access to focus recruiter effort.",
        action: "roles",
        tone: approvedRoleCount ? "success" : cleanLaneCount ? "live" : "info",
      },
      {
        label: "Bench to match",
        value: String(sourcedCandidates.filter((candidate) => candidate.stage !== "archived").length),
        body: privateBenchCandidates
          ? `${privateBenchCandidates} private bench candidate${privateBenchCandidates === 1 ? "" : "s"} ${privateBenchCandidates === 1 ? "needs" : "need"} role fit.`
          : `${readyCandidates} ready for submission.`,
        action: privateBenchCandidates || readyCandidates ? "matches" : "candidates",
        tone: readyCandidates || privateBenchCandidates ? "live" : "mute",
      },
      {
        label: "Submissions to manage",
        value: String(activeSubmissions),
        body: candidateConfirmationNeeds ? `${candidateConfirmationNeeds} confirmation follow-up${candidateConfirmationNeeds === 1 ? "" : "s"}.` : "Track review, interview, and offer movement.",
        action: "submissions",
        tone: candidateConfirmationNeeds ? "warn" : activeSubmissions ? "info" : "mute",
      },
      {
        label: "Feedback to learn",
        value: String(feedbackToRead + openQuestions),
        body: openQuestions ? `${openQuestions} unanswered role question${openQuestions === 1 ? "" : "s"}.` : "Use WeKruit notes to tighten the next shortlist.",
        action: openQuestions ? "access" : "performance",
        tone: openQuestions ? "warn" : feedbackToRead ? "info" : "success",
      },
    ],
  }
}

type RecruiterChallenge = {
  id: string
  title: string
  body: string
  progress: number
  target: number
  progressLabel: string
  reward: string
  payoutTiming: string
  eligibility: string
  tone: OperatingTone
  actionLabel: string
  action: "roles" | "candidates" | "submissions" | "performance"
}

type RecruiterStatusBenefit = {
  label: string
  value: string
  body: string
  tone: OperatingTone
  locked: boolean
  action?: "roles" | "candidates" | "submissions" | "performance" | "settings"
  actionLabel?: string
}

type RecruiterStatusBenefitsCenter = {
  label: string
  title: string
  body: string
  tone: OperatingTone
  currentTier: string
  nextTier: string
  benefits: RecruiterStatusBenefit[]
  gates: RecruiterStatusBenefit[]
}

type RecruiterPayoutRow = {
  id: string
  candidate: string
  role: string
  status: string
  value: string
  payout: string
  tone: OperatingTone
}

type RecruiterRewardLedgerRow = {
  id: string
  category: string
  title: string
  body: string
  value: string
  status: string
  schedule: string
  tone: OperatingTone
  action?: RecruiterChallenge["action"]
  actionLabel?: string
}

type RecruiterRewardLedger = {
  headline: string
  body: string
  summary: RecruiterOperatingMetric[]
  rows: RecruiterRewardLedgerRow[]
  policies: RecruiterOperatingMetric[]
}

type RecruiterPayoutReadinessStep = {
  label: string
  value: string
  body: string
  tone: OperatingTone
  action?: "settings" | "submissions"
  actionLabel?: string
}

type RecruiterPayoutReadiness = {
  label: string
  title: string
  body: string
  tone: OperatingTone
  cards: RecruiterOperatingMetric[]
  steps: RecruiterPayoutReadinessStep[]
}

type RecruiterStatusTier = {
  label: string
  body: string
  requirement: string
  active: boolean
  tone: OperatingTone
}

type RecruiterEarningsMetrics = {
  statusLabel: string
  ratingLabel: string
  ratingBody: string
  interviewRate: number
  activePipelineValue: number
  wonValue: number
  openOpportunityValue: number
  activityCoverage: number
  activePrimaryRoles: number
  coveredPrimaryRoles: number
  summary: RecruiterOperatingMetric[]
  tiers: RecruiterStatusTier[]
  challenges: RecruiterChallenge[]
  payouts: RecruiterPayoutRow[]
  rewardLedger: RecruiterRewardLedger
  payoutReadiness: RecruiterPayoutReadiness
  statusBenefits: RecruiterStatusBenefitsCenter
  expectations: RecruiterOperatingMetric[]
}

type RecruiterBusinessStep = {
  label: string
  value: string
  body: string
  tone: OperatingTone
}

type RecruiterBusinessCenter = {
  title: string
  body: string
  value: string
  tone: OperatingTone
  cards: RecruiterOperatingMetric[]
  workflow: RecruiterBusinessStep[]
  referralBrief: string
  referralMailto: string
}

function buildRecruiterBusinessCenter(
  session: RecruiterSession,
  approvedRoleCount: number,
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  earningsMetrics: RecruiterEarningsMetrics,
): RecruiterBusinessCenter {
  const activeCandidates = sourcedCandidates.filter((candidate) => candidate.stage !== "archived").length
  const readyCandidates = sourcedCandidates.filter((candidate) => candidate.stage === "ready").length
  const recordedPayoutRows = submissions.filter((submission) => {
    const status = submission.recruiterPayout?.status
    return Boolean(status && status !== "none")
  })
  const pendingPayoutRows = submissions.filter((submission) =>
    ["eligible", "pending_start", "invoice_ready"].includes(submission.recruiterPayout?.status ?? ""),
  )
  const invoiceReadyRows = submissions.filter((submission) => submission.recruiterPayout?.status === "invoice_ready")
  const paidRows = submissions.filter((submission) => submission.recruiterPayout?.status === "paid")
  const notificationOn = session.recruiter.notificationPreferences?.newRolesEmail !== false
  const coverage = approvedRoleCount ? Math.round((earningsMetrics.coveredPrimaryRoles / approvedRoleCount) * 100) : 0
  const payoutValue = pendingPayoutRows.reduce((sum, submission) => {
    const amount = submission.recruiterPayout?.amount
    return sum + (typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? Math.round(amount) : DEFAULT_SUCCESS_FEE)
  }, 0)
  const payoutState = invoiceReadyRows.length
    ? "Invoice ready"
    : paidRows.length
      ? "Paid recorded"
      : pendingPayoutRows.length
        ? "Pending"
        : earningsMetrics.activePipelineValue > 0
          ? "Projected"
          : "Not started"
  const payoutTone: OperatingTone = invoiceReadyRows.length || paidRows.length
    ? "success"
    : pendingPayoutRows.length
      ? "live"
      : earningsMetrics.activePipelineValue > 0
        ? "info"
        : "mute"
  const agreementState = recordedPayoutRows.length || paidRows.length
    ? "Ops recorded"
    : earningsMetrics.activePipelineValue > 0
      ? "Confirm before hire"
      : "Not due"
  const title = payoutTone === "success"
    ? "Business profile is payout-aware"
    : payoutTone === "live"
      ? "Payout work is active"
      : payoutTone === "info"
        ? "Confirm business setup before the first close"
        : "Business setup starts after real activity"
  const body = payoutTone === "success"
    ? "Your account, payout tracker, and recruiter access model have enough signal for WeKruit ops to process the next step."
    : payoutTone === "live"
      ? "There is at least one payout row in motion. Keep submissions and account identity aligned before invoice processing."
      : payoutTone === "info"
        ? "Projected value exists, but payment method and agreement confirmation still need WeKruit ops handling before a hire closes."
        : "Use approved roles and consented candidates first. Payout and referral operations become relevant when the workspace has real movement."
  const referralBrief = [
    "Recruiter access request",
    "",
    `Requester: ${session.recruiter.name} <${session.recruiter.email}>`,
    `Current recruiter status: ${earningsMetrics.statusLabel}`,
    `Quality rating: ${earningsMetrics.ratingLabel}`,
    `Approved role access: ${approvedRoleCount}/${APPROVED_ROLE_LIMIT}`,
    `Active sourced candidates: ${activeCandidates}`,
    `Ready candidates: ${readyCandidates}`,
    `Tracked submissions: ${submissions.length}`,
    "",
    "Please send an email invite to the new recruiter so they can sign in with their Google account.",
  ].join("\n")
  const referralMailto = `mailto:admin1@wekruit.com?subject=${encodeURIComponent("Recruiter invite request")}&body=${encodeURIComponent(referralBrief)}`

  return {
    title,
    body,
    value: payoutState,
    tone: payoutTone,
    cards: [
      {
        label: "Payout profile",
        value: payoutState,
        body: pendingPayoutRows.length
          ? `${pendingPayoutRows.length} payout row${pendingPayoutRows.length === 1 ? "" : "s"} in motion${payoutValue > 0 ? `, ${formatCurrencyShort(payoutValue)} pending` : ""}.`
          : earningsMetrics.activePipelineValue > 0
            ? `${formatCurrencyShort(earningsMetrics.activePipelineValue)} projected pipeline value; ops setup is not self-serve yet.`
            : "No eligible payout row is recorded yet.",
        tone: payoutTone,
      },
      {
        label: "Agreement status",
        value: agreementState,
        body: recordedPayoutRows.length
          ? `${recordedPayoutRows.length} submission${recordedPayoutRows.length === 1 ? "" : "s"} include recruiter payout status.`
          : "Agreement and payment-method confirmation remain an ops step before payout.",
        tone: recordedPayoutRows.length ? "success" : earningsMetrics.activePipelineValue > 0 ? "warn" : "mute",
      },
      {
        label: "Referral access",
        value: "Admin-issued",
        body: "Each invite is sent by email and bound to the new recruiter's Google account.",
        tone: "info",
      },
      {
        label: "Role alerts",
        value: notificationOn ? "On" : "Off",
        body: notificationOn ? "New collab roles can email this recruiter account." : "New-role emails are disabled for this account.",
        tone: notificationOn ? "success" : "warn",
      },
    ],
    workflow: [
      {
        label: "Identity",
        value: session.recruiter.email,
        body: "This account is bound to Firebase Auth via an email invitation.",
        tone: "success",
      },
      {
        label: "Role coverage",
        value: approvedRoleCount ? `${coverage}%` : "No access",
        body: approvedRoleCount
          ? `${earningsMetrics.coveredPrimaryRoles}/${approvedRoleCount} approved roles have candidate or submission activity.`
          : "Apply for role access before sourcing against live collab jobs.",
        tone: coverage >= 80 ? "success" : approvedRoleCount ? "info" : "warn",
      },
      {
        label: "Payout operation",
        value: agreementState,
        body: earningsMetrics.payoutReadiness.body,
        tone: earningsMetrics.payoutReadiness.tone,
      },
      {
        label: "Invite another recruiter",
        value: "Email invite required",
        body: "Send the referral brief to WeKruit ops so the invitee gets their own email invite.",
        tone: "info",
      },
    ],
    referralBrief,
    referralMailto,
  }
}

type RecruiterTrustGate = {
  label: string
  value: string
  body: string
  tone: OperatingTone
}

type RecruiterTrustTierStep = {
  label: string
  rank: string
  requirement: string
  unlock: string
  progressLabel: string
  progressValue: string
  complete: boolean
  active: boolean
  blockedBy: string[]
  tone: OperatingTone
}

type RecruiterTrustCenter = {
  statusLabel: string
  statusBody: string
  statusTone: OperatingTone
  score: number
  tierLabel: string
  tierProgressLabel: string
  tierProgressValue: string
  nextActionLabel: string
  nextActionBody: string
  cards: RecruiterTrustGate[]
  gates: RecruiterTrustGate[]
  tiers: RecruiterTrustTierStep[]
  unlocks: RecruiterTrustGate[]
}

type RecruiterGroundRuleAction = "roles" | "candidates" | "submissions"

type RecruiterGroundRuleItem = {
  label: string
  value: string
  body: string
  tone: OperatingTone
  action: RecruiterGroundRuleAction
  actionLabel: string
}

type RecruiterGroundRulesCenter = {
  title: string
  body: string
  tone: OperatingTone
  scoreLabel: string
  cards: RecruiterGroundRuleItem[]
  rules: RecruiterGroundRuleItem[]
  risks: RecruiterGroundRuleItem[]
}

type RecruiterLearningCard = {
  label: string
  value: string
  body: string
  tone: OperatingTone
}

type RecruiterLearningRule = {
  label: string
  title: string
  body: string
  evidence: string
  tone: OperatingTone
  href?: string
}

type RecruiterLearningCenter = {
  statusLabel: string
  statusTitle: string
  statusBody: string
  statusTone: OperatingTone
  cards: RecruiterLearningCard[]
  rules: RecruiterLearningRule[]
  evidence: RecruiterLearningRule[]
}

type RecruiterCalibrationRow = {
  candidate: RecruiterSourcedCandidateItem
  label: string
  title: string
  body: string
  meta: string
  tone: OperatingTone
  canRequest: boolean
}

type RecruiterCalibrationDesk = {
  label: string
  title: string
  body: string
  tone: OperatingTone
  slotsUsed: number
  slotsLimit: number
  slotsLeft: number
  cards: RecruiterLearningCard[]
  requestQueue: RecruiterCalibrationRow[]
  waitingQueue: RecruiterCalibrationRow[]
  feedbackQueue: RecruiterCalibrationRow[]
}

function countByLabel(labels: string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

function roleFeedbackReasonLabel(reason: RecruiterRoleFeedbackReason): string {
  return ROLE_FEEDBACK_REASON_LABELS[reason] ?? reason.replace(/_/g, " ")
}

function topCountLabel(rows: Array<{ label: string; count: number }>, fallback: string): string {
  const first = rows[0]
  return first ? `${first.label} x${first.count}` : fallback
}

function sourcedCandidateRoleLabel(candidate: RecruiterSourcedCandidateItem): string {
  if (candidate.jobTitleSnapshot && candidate.companyLabelSnapshot) {
    return `${candidate.jobTitleSnapshot} · ${candidate.companyLabelSnapshot}`
  }
  return candidate.jobTitleSnapshot || candidate.companyLabelSnapshot || "Role not attached"
}

function sourcedCandidateProofLabel(candidate: RecruiterSourcedCandidateItem): string {
  const proof = [
    candidate.candidate?.email ? "email" : "",
    candidate.candidate?.link ? "profile" : "",
    candidate.candidate?.notes?.trim() ? "notes" : "",
    candidate.outreach?.status && candidate.outreach.status !== "not_contacted" ? "outreach" : "",
  ].filter(Boolean)
  return proof.length ? proof.join(" · ") : "no proof yet"
}

function buildCalibrationRow(candidate: RecruiterSourcedCandidateItem, canRequest: boolean): RecruiterCalibrationRow {
  const calibration = calibrationMeta(candidate.calibrationStatus)
  const stage = sourceStageMeta(candidate.stage)
  const requestedAt = timestampValueMs(candidate.calibrationUpdatedAt ?? candidate.updatedAt ?? candidate.createdAt)
  const roleLabel = sourcedCandidateRoleLabel(candidate)
  const note = candidate.calibrationNote || candidate.candidate?.notes
  return {
    candidate,
    label: canRequest ? "Ready to calibrate" : calibration.label,
    title: candidateName(candidate),
    body: canRequest
      ? `${roleLabel}. Ask for feedback before risking the official submission rating.`
      : note || `${roleLabel}. Waiting for WeKruit feedback to tighten the next shortlist.`,
    meta: `${stage.label} · ${sourcedCandidateProofLabel(candidate)}${requestedAt ? ` · ${new Date(requestedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`,
    tone: canRequest ? (candidate.stage === "ready" ? "live" : "info") : calibration.tone,
    canRequest,
  }
}

function buildRecruiterCalibrationDesk(candidates: RecruiterSourcedCandidateItem[]): RecruiterCalibrationDesk {
  const active = candidates.filter((candidate) => candidate.stage !== "archived")
  const waiting = active
    .filter((candidate) => candidate.calibrationStatus === "calibration_requested")
    .sort((a, b) => timestampValueMs(a.calibrationUpdatedAt ?? a.updatedAt ?? a.createdAt) - timestampValueMs(b.calibrationUpdatedAt ?? b.updatedAt ?? b.createdAt))
  const requestable = active
    .filter(canRequestCandidateCalibration)
    .sort((a, b) => {
      const readyDelta = Number(b.stage === "ready") - Number(a.stage === "ready")
      if (readyDelta) return readyDelta
      const noteDelta = Number(Boolean(b.candidate?.notes?.trim())) - Number(Boolean(a.candidate?.notes?.trim()))
      if (noteDelta) return noteDelta
      return timestampValueMs(b.updatedAt ?? b.createdAt) - timestampValueMs(a.updatedAt ?? a.createdAt)
    })
  const feedback = active
    .filter((candidate) =>
      candidate.calibrationStatus === "good_fit" ||
      candidate.calibrationStatus === "bad_fit" ||
      candidate.calibrationStatus === "suggested",
    )
    .sort((a, b) => timestampValueMs(b.calibrationUpdatedAt ?? b.updatedAt ?? b.createdAt) - timestampValueMs(a.calibrationUpdatedAt ?? a.updatedAt ?? a.createdAt))
  const goodFit = feedback.filter((candidate) => candidate.calibrationStatus === "good_fit").length
  const badFit = feedback.filter((candidate) => candidate.calibrationStatus === "bad_fit").length
  const slotsUsed = waiting.length
  const slotsLeft = Math.max(0, CALIBRATION_SLOT_LIMIT - slotsUsed)
  const tone: OperatingTone = slotsUsed > CALIBRATION_SLOT_LIMIT
    ? "warn"
    : waiting.length
      ? "info"
      : requestable.length
        ? "live"
        : feedback.length
          ? "success"
          : "mute"
  const title = slotsUsed > CALIBRATION_SLOT_LIMIT
    ? "Calibration queue is over limit"
    : requestable.length && slotsLeft > 0
      ? `${Math.min(requestable.length, slotsLeft)} candidate${Math.min(requestable.length, slotsLeft) === 1 ? "" : "s"} ready for pre-submit feedback`
      : waiting.length
        ? `${waiting.length} calibration request${waiting.length === 1 ? "" : "s"} waiting`
        : feedback.length
          ? "Calibration feedback is ready to reuse"
          : "No calibration loop yet"
  const body = requestable.length && slotsLeft > 0
    ? "Use the limited calibration slots before formal submission when role fit is uncertain or the packet needs sharper hiring-team signal."
    : waiting.length
      ? "Wait for WeKruit feedback before sending lookalike candidates or formal submissions from the same search pattern."
      : feedback.length
        ? "Turn good-fit, bad-fit, and suggested-direction notes into the next shortlist before asking for more role volume."
        : "Attach candidates to roles, collect proof, and request calibration before taking rating risk on uncertain packets."

  return {
    label: "Pre-submit calibration",
    title,
    body,
    tone,
    slotsUsed,
    slotsLimit: CALIBRATION_SLOT_LIMIT,
    slotsLeft,
    cards: [
      {
        label: "Slots used",
        value: `${Math.min(slotsUsed, CALIBRATION_SLOT_LIMIT)}/${CALIBRATION_SLOT_LIMIT}`,
        body: slotsLeft ? `${slotsLeft} calibration slot${slotsLeft === 1 ? "" : "s"} open before the queue should pause.` : "Queue is full; wait for feedback before requesting more.",
        tone: slotsUsed >= CALIBRATION_SLOT_LIMIT ? "warn" : slotsUsed ? "info" : "success",
      },
      {
        label: "Ready candidates",
        value: String(requestable.length),
        body: "Role-attached, not submitted, and eligible for a pre-submission feedback request.",
        tone: requestable.length ? "live" : "mute",
      },
      {
        label: "Returned signal",
        value: `${goodFit}/${badFit}`,
        body: "Good-fit versus bad-fit calibration rows returned by WeKruit.",
        tone: goodFit ? "success" : badFit ? "warn" : feedback.length ? "info" : "mute",
      },
      {
        label: "Noise avoided",
        value: String(waiting.length + badFit),
        body: "Candidates that should not become lookalike volume until feedback is applied.",
        tone: waiting.length + badFit ? "warn" : "success",
      },
    ],
    requestQueue: requestable.slice(0, 5).map((candidate) => buildCalibrationRow(candidate, true)),
    waitingQueue: waiting.slice(0, 5).map((candidate) => buildCalibrationRow(candidate, false)),
    feedbackQueue: feedback.slice(0, 5).map((candidate) => buildCalibrationRow(candidate, false)),
  }
}

function buildRecruiterLearningCenter(
  jobs: CollabJob[],
  candidates: RecruiterSourcedCandidateItem[],
  submissions: RecruiterSubmissionItem[],
  roleFeedback: RecruiterRoleFeedbackItem[],
): RecruiterLearningCenter {
  const jobsById = new Map(jobs.map((job) => [roleKey(job), job]))
  const feedbackSubmissions = submissions.filter(submissionHasStructuredFeedback)
  const lowRatedSubmissions = feedbackSubmissions.filter((submission) => {
    const rating = submissionFeedbackRating(submission)
    return rating !== null && rating <= 2
  })
  const positiveSubmissions = feedbackSubmissions.filter((submission) => {
    const rating = submissionFeedbackRating(submission)
    return rating !== null && rating >= 3
  })
  const closedWithFeedback = feedbackSubmissions.filter((submission) => CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? ""))
  const frictionFeedback = roleFeedback.filter((feedback) => feedback.difficulty === "hard" || feedback.difficulty === "blocked")
  const calibratedCandidates = candidates.filter((candidate) =>
    candidate.calibrationStatus === "bad_fit" ||
    candidate.calibrationStatus === "calibration_requested" ||
    Boolean(candidate.calibrationNote),
  )
  const readyCandidates = candidates.filter((candidate) => candidate.stage === "ready")
  const reasonCounts = countByLabel(feedbackSubmissions.flatMap(submissionFeedbackReasonLabels))
  const frictionReasonCounts = countByLabel(frictionFeedback.flatMap((feedback) => feedback.reasons.map(roleFeedbackReasonLabel)))
  const strongReasonCounts = countByLabel(positiveSubmissions.flatMap(submissionFeedbackReasonLabels))
  const profileProofMissing = candidates.filter((candidate) =>
    candidate.stage !== "archived" &&
    (!candidate.candidate?.email || !candidate.candidate?.link || !candidate.candidate?.notes?.trim()),
  ).length
  const feedbackCoverage = submissions.length ? Math.round((feedbackSubmissions.length / submissions.length) * 100) : 0

  const rules: RecruiterLearningRule[] = []
  if (lowRatedSubmissions.length > 0) {
    const focus = lowRatedSubmissions
      .sort((a, b) => timestampValueMs(b.recruiterFeedbackUpdatedAt ?? b.updatedAt ?? b.createdAt) - timestampValueMs(a.recruiterFeedbackUpdatedAt ?? a.updatedAt ?? a.createdAt))[0]
    rules.push({
      label: "Quality hold",
      title: "Pause lookalikes until low-rated feedback is applied",
      body: focus?.recruiterFeedbackNote || topCountLabel(reasonCounts, "Low-rated submissions need sharper hard-filter evidence."),
      evidence: `${lowRatedSubmissions.length} low-rated submission${lowRatedSubmissions.length === 1 ? "" : "s"}`,
      tone: "warn",
      href: "/recruiters?tab=submissions",
    })
  }
  if (closedWithFeedback.length > 0) {
    const reason = topCountLabel(reasonCounts, "Closed feedback")
    rules.push({
      label: "Avoid next",
      title: `Do not repeat ${reason.toLowerCase()}`,
      body: "Closed candidates should create a concrete anti-pattern before the next outreach batch.",
      evidence: `${closedWithFeedback.length} rejected or duplicate packet${closedWithFeedback.length === 1 ? "" : "s"} with feedback`,
      tone: "warn",
      href: "/recruiters?tab=submissions",
    })
  }
  if (frictionFeedback.length > 0) {
    const focus = frictionFeedback
      .sort((a, b) => timestampValueMs(b.updatedAt ?? b.createdAt) - timestampValueMs(a.updatedAt ?? a.createdAt))[0]
    rules.push({
      label: "Ask WeKruit",
      title: `Clear ${topCountLabel(frictionReasonCounts, "role friction").toLowerCase()}`,
      body: focus?.note || "Role-market friction should become a precise question before more sourcing spend.",
      evidence: `${frictionFeedback.length} hard or blocked role signal${frictionFeedback.length === 1 ? "" : "s"}`,
      tone: "info",
      href: rolePathForRow(focus ?? {}),
    })
  }
  if (positiveSubmissions.length > 0) {
    const focus = positiveSubmissions
      .sort((a, b) => timestampValueMs(b.recruiterFeedbackUpdatedAt ?? b.updatedAt ?? b.createdAt) - timestampValueMs(a.recruiterFeedbackUpdatedAt ?? a.updatedAt ?? a.createdAt))[0]
    rules.push({
      label: "Repeat next",
      title: `Source around ${topCountLabel(strongReasonCounts, "strong evidence").toLowerCase()}`,
      body: focus?.recruiterFeedbackNote || "Use high-rated feedback as the next search pattern.",
      evidence: `${positiveSubmissions.length} positive rated submission${positiveSubmissions.length === 1 ? "" : "s"}`,
      tone: "success",
      href: rolePathForRow(focus ?? {}),
    })
  }
  if (profileProofMissing > 0) {
    rules.push({
      label: "Proof gap",
      title: "Complete candidate proof before matching",
      body: "Candidates missing email, link, or notes weaken consent, duplicate checks, and submission quality.",
      evidence: `${profileProofMissing} active candidate${profileProofMissing === 1 ? "" : "s"} missing proof`,
      tone: "info",
      href: "/recruiters?tab=candidates",
    })
  }
  if (rules.length === 0) {
    rules.push({
      label: "Start learning",
      title: "Create the first feedback signal",
      body: "Save a candidate, submit with consent, then use WeKruit feedback to make the next search sharper.",
      evidence: "No recruiter feedback loop yet",
      tone: "mute",
      href: "/recruiters?tab=roles",
    })
  }

  const evidence: RecruiterLearningRule[] = [
    ...feedbackSubmissions
      .sort((a, b) => timestampValueMs(b.recruiterFeedbackUpdatedAt ?? b.updatedAt ?? b.createdAt) - timestampValueMs(a.recruiterFeedbackUpdatedAt ?? a.updatedAt ?? a.createdAt))
      .slice(0, 4)
      .map((submission): RecruiterLearningRule => ({
        label: submissionFeedbackRatingLabel(submission),
        title: submission.candidate?.name || "Candidate feedback",
        body: submission.recruiterFeedbackNote || submissionFeedbackReasonLabels(submission).join(", ") || submissionNextAction(submission.status).body,
        evidence: rowRoleLabel(submission, jobsById),
        tone: submissionFeedbackRatingTone(submission),
        href: rolePathForRow(submission),
      })),
    ...frictionFeedback
      .sort((a, b) => timestampValueMs(b.updatedAt ?? b.createdAt) - timestampValueMs(a.updatedAt ?? a.createdAt))
      .slice(0, 3)
      .map((feedback): RecruiterLearningRule => ({
        label: roleFeedbackDifficultyText(feedback.difficulty),
        title: rowRoleLabel(feedback, jobsById),
        body: feedback.note || feedback.reasons.map(roleFeedbackReasonLabel).join(", ") || "Role friction reported.",
        evidence: feedback.reasons.map(roleFeedbackReasonLabel).slice(0, 3).join(" · ") || "Market feedback",
        tone: feedback.difficulty === "blocked" ? "warn" : "info",
        href: rolePathForRow(feedback),
      })),
    ...calibratedCandidates
      .sort((a, b) => timestampValueMs(b.calibrationUpdatedAt ?? b.updatedAt ?? b.createdAt) - timestampValueMs(a.calibrationUpdatedAt ?? a.updatedAt ?? a.createdAt))
      .slice(0, 3)
      .map((candidate): RecruiterLearningRule => ({
        label: calibrationMeta(candidate.calibrationStatus).label,
        title: candidateName(candidate),
        body: candidate.calibrationNote || "Candidate calibration should change the next role match.",
        evidence: rowRoleLabel(candidate, jobsById),
        tone: calibrationMeta(candidate.calibrationStatus).tone,
        href: rolePathForRow(candidate, candidate.id),
      })),
  ].slice(0, 8)

  const statusTone: OperatingTone = lowRatedSubmissions.length || frictionFeedback.some((feedback) => feedback.difficulty === "blocked")
    ? "warn"
    : positiveSubmissions.length || feedbackCoverage >= 50
      ? "success"
      : feedbackSubmissions.length || frictionFeedback.length || calibratedCandidates.length
        ? "info"
        : "mute"
  const statusTitle = statusTone === "warn"
    ? "Tighten before more volume"
    : statusTone === "success"
      ? "Learning loop is active"
      : statusTone === "info"
        ? "Signals need translation"
        : "No feedback loop yet"
  const statusBody = statusTone === "warn"
    ? "Low ratings, closed feedback, or blocked roles should change sourcing immediately."
    : statusTone === "success"
      ? "There is enough positive or covered feedback to guide the next shortlist."
      : statusTone === "info"
        ? "Convert the available notes into one or two concrete sourcing rules."
        : "Submit consented candidates to generate WeKruit feedback and recruiter learning."

  return {
    statusLabel: "Feedback learning",
    statusTitle,
    statusBody,
    statusTone,
    cards: [
      {
        label: "Feedback coverage",
        value: `${feedbackCoverage}%`,
        body: `${feedbackSubmissions.length}/${submissions.length || 0} submissions have structured notes or ratings.`,
        tone: feedbackCoverage >= 50 ? "success" : feedbackSubmissions.length ? "info" : "mute",
      },
      {
        label: "Top anti-pattern",
        value: topCountLabel(reasonCounts, "None"),
        body: "Most repeated submission-feedback reason.",
        tone: reasonCounts.length ? "warn" : "mute",
      },
      {
        label: "Role blockers",
        value: String(frictionFeedback.length),
        body: topCountLabel(frictionReasonCounts, "No hard or blocked role feedback."),
        tone: frictionFeedback.length ? "warn" : "success",
      },
      {
        label: "Ready to apply",
        value: String(readyCandidates.length),
        body: "Ready candidates should be matched only after the current learning rules are applied.",
        tone: readyCandidates.length ? "live" : "mute",
      },
    ],
    rules: rules.slice(0, 5),
    evidence,
  }
}

function formatCurrencyShort(value: number): string {
  if (value >= 1_000_000) return `$${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`
  return `$${value}`
}

function roleCompSummaryLooksFee(summary?: string | null): boolean {
  return /fee|reward|bounty|placement|success/i.test(summary ?? "")
}

function roleRewardAmount(job: CollabJob): number {
  if (!roleCompSummaryLooksFee(job.compSummary)) return DEFAULT_SUCCESS_FEE
  const match = job.compSummary?.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(k|m)?/i)
  if (!match) return DEFAULT_SUCCESS_FEE
  const raw = Number(match[1])
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SUCCESS_FEE
  const suffix = match[2]?.toLowerCase()
  if (suffix === "m") return Math.round(raw * 1_000_000)
  if (suffix === "k") return Math.round(raw * 1_000)
  return raw >= 1_000 ? Math.round(raw) : Math.round(raw * 1_000)
}

function roleRewardLabel(job: CollabJob): string {
  return `${formatCurrencyShort(roleRewardAmount(job))}${roleCompSummaryLooksFee(job.compSummary) ? "" : "+"}`
}

function roleRewardSourceLabel(job: CollabJob): string {
  return roleCompSummaryLooksFee(job.compSummary) ? "Role reward" : "Estimated success fee"
}

function roleCandidateCompLabel(job: CollabJob): string {
  if (!job.compSummary || roleCompSummaryLooksFee(job.compSummary)) return "Not shared"
  return shortText(job.compSummary, job.compSummary, 32)
}

function submissionRoleId(submission: RecruiterSubmissionItem): string {
  return submission.inboundJobId || submission.jobId || ""
}

function submissionRewardAmount(submission: RecruiterSubmissionItem, jobsById: Map<string, CollabJob>): number {
  const job = jobsById.get(submissionRoleId(submission))
  return job ? roleRewardAmount(job) : DEFAULT_SUCCESS_FEE
}

function recruiterPayoutStatusMeta(status?: string) {
  return PAYOUT_STATUS_LABELS[status ?? ""] ?? { label: "Projected", tone: "mute" as const, body: "No payout status has been recorded yet." }
}

function recruiterPayoutAmount(submission: RecruiterSubmissionItem, jobsById: Map<string, CollabJob>): number {
  const amount = submission.recruiterPayout?.amount
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0
    ? Math.round(amount)
    : submissionRewardAmount(submission, jobsById)
}

function isSubmissionOpen(status?: string): boolean {
  return !CLOSED_NEGATIVE_STATUSES.includes(status ?? "")
}

function isSubmissionAdvanced(status?: string): boolean {
  return ADVANCED_STATUSES.includes(status ?? "")
}

function payoutTimingForSubmission(submission: RecruiterSubmissionItem): string {
  const payout = submission.recruiterPayout
  const meta = recruiterPayoutStatusMeta(payout?.status)
  if (payout?.status && payout.status !== "none") {
    return payout.note ? `${meta.label} - ${payout.note}` : meta.body
  }
  return payoutTiming(submission.status)
}

function payoutTiming(status?: string): string {
  switch (status) {
    case "hired":
      return "Payout starts after start-date confirmation"
    case "offer":
      return "Offer in motion; payout depends on accepted start"
    case "interviewing":
      return "Potential payout if candidate closes"
    case "backburner":
      return "Parked; no payout movement until reopened"
    case "advanced":
      return "Potential payout if hiring team converts"
    case "rejected":
      return "Closed - no payout"
    case "duplicate":
      return "Closed as duplicate"
    case "reviewing":
      return "Waiting for WeKruit review"
    default:
      return "Waiting for review movement"
  }
}

function tierRank(label: string): number {
  switch (label) {
    case "Preferred track": return 2
    case "Standard track": return 1
    default: return 0
  }
}

function challengeProgressPct(challenge: RecruiterChallenge): number {
  return challenge.target > 0 ? Math.min(100, Math.round((challenge.progress / challenge.target) * 100)) : 0
}

function challengeWindowLabel(now = new Date()): string {
  const start = new Date(now)
  const day = start.getDay()
  const daysSinceMonday = (day + 6) % 7
  start.setDate(start.getDate() - daysSinceMonday)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(start.getDate() + 7)
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
  return `${fmt.format(start)} - ${fmt.format(end)}`
}

function challengeDeadlineLabel(now = new Date()): string {
  const end = new Date(now)
  const day = end.getDay()
  const daysUntilMonday = (8 - day) % 7 || 7
  end.setDate(end.getDate() + daysUntilMonday)
  end.setHours(0, 0, 0, 0)
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000))
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`
}

function computeRecruiterEarningsMetrics(
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  roleFeedback: RecruiterRoleFeedbackItem[],
  roleQuestions: RecruiterRoleQuestionItem[],
  primaryRoleIds: string[],
  operatingMetrics: RecruiterOperatingMetrics,
): RecruiterEarningsMetrics {
  const jobsById = new Map(jobs.map((job) => [roleKey(job), job]))
  const openSubmissions = submissions.filter((submission) => isSubmissionOpen(submission.status) && submission.recruiterPayout?.status !== "void")
  const advancedSubmissions = submissions.filter((submission) => isSubmissionAdvanced(submission.status))
  const hiredSubmissions = submissions.filter((submission) => submission.status === "hired")
  const interviewRate = submissions.length ? Math.round((advancedSubmissions.length / submissions.length) * 100) : 0
  const activePipelineValue = openSubmissions.reduce((sum, submission) => sum + recruiterPayoutAmount(submission, jobsById), 0)
  const paidPayoutSubmissions = submissions.filter((submission) => submission.recruiterPayout?.status === "paid")
  const recordedPayoutSubmissions = submissions.filter((submission) => {
    const status = submission.recruiterPayout?.status
    return Boolean(status && status !== "none")
  })
  const invoiceReadySubmissions = submissions.filter((submission) => submission.recruiterPayout?.status === "invoice_ready")
  const pendingPayoutSubmissions = submissions.filter((submission) =>
    ["eligible", "pending_start", "invoice_ready"].includes(submission.recruiterPayout?.status ?? ""),
  )
  const wonValue = (paidPayoutSubmissions.length ? paidPayoutSubmissions : hiredSubmissions)
    .reduce((sum, submission) => sum + recruiterPayoutAmount(submission, jobsById), 0)
  const pendingPayoutValue = pendingPayoutSubmissions
    .reduce((sum, submission) => sum + recruiterPayoutAmount(submission, jobsById), 0)
  const openOpportunityValue = jobs.reduce((sum, job) => sum + roleRewardAmount(job), 0)
  const activePrimaryRoles = primaryRoleIds.length
  const coveredPrimaryRoles = jobs.filter((job) => {
    if (!isPrimaryRole(job, primaryRoleIds)) return false
    return rowsForRole(job, sourcedCandidates).some((candidate) => candidate.stage !== "archived") ||
      rowsForRole(job, submissions).some((submission) => isSubmissionOpen(submission.status))
  }).length
  const activityCoverage = activePrimaryRoles ? Math.round((coveredPrimaryRoles / activePrimaryRoles) * 100) : 0
  const openQuestions = roleQuestions.filter((question) => (question.status ?? "open") === "open").length
  const hardFeedback = roleFeedback.filter((feedback) => feedback.difficulty === "hard" || feedback.difficulty === "blocked").length
  const readyCandidates = sourcedCandidates.filter((candidate) => candidate.stage === "ready").length
  const statusRank = tierRank(operatingMetrics.statusLabel)
  const ratedSubmissions = submissions
    .map(submissionFeedbackRating)
    .filter((rating): rating is number => rating !== null)
  const averageRating = ratedSubmissions.length
    ? ratedSubmissions.reduce((sum, rating) => sum + rating, 0) / ratedSubmissions.length
    : null
  const ratingBase = operatingMetrics.qualityScore ?? 100
  const ratingNumber = averageRating ?? clampNumber(Math.round((ratingBase / 25) * 10) / 10, 2.8, 4)
  const ratingLabel = `${ratingNumber.toFixed(1)} / 4`
  const ratingBody = submissions.length
    ? averageRating !== null
      ? `${ratedSubmissions.length}/${submissions.length} submissions rated by WeKruit. ${interviewRate}% interview movement.`
      : `${interviewRate}% interview movement across ${submissions.length} submission${submissions.length === 1 ? "" : "s"}; no /4 ratings yet.`
    : "All recruiters start unrated. Submissions make the quality signal real."
  const primaryActivityChallenge: RecruiterChallenge = {
    id: "approved-role-activity",
    title: "Approved role activity",
    body: "Each approved role should have at least one live candidate or one active submission.",
    progress: coveredPrimaryRoles,
    target: Math.max(1, activePrimaryRoles || APPROVED_ROLE_LIMIT),
    progressLabel: `${coveredPrimaryRoles}/${activePrimaryRoles || APPROVED_ROLE_LIMIT} covered`,
    reward: "Protects role access",
    payoutTiming: "Status credit is reviewed at the end of the weekly window.",
    eligibility: "Counts approved roles with at least one active sourced candidate or active submission.",
    tone: activityCoverage >= 80 ? "success" : coveredPrimaryRoles > 0 ? "info" : "warn",
    actionLabel: activePrimaryRoles ? "Open roles" : "Apply for access",
    action: "roles",
  }
  const challenges: RecruiterChallenge[] = [
    openQuestions > 0 ? {
      id: "clear-calibration-debt",
      title: "Clear calibration debt",
      body: "Resolve open role questions before sourcing through ambiguity.",
      progress: Math.max(0, openQuestions - openQuestions),
      target: openQuestions,
      progressLabel: `${openQuestions} open`,
      reward: "Cleaner approvals",
      payoutTiming: "No payout attached; this protects future approval and quality review.",
      eligibility: "All open role questions must be answered or closed before the week ends.",
      tone: "warn",
      actionLabel: "Review performance",
      action: "performance",
    } : primaryActivityChallenge,
    readyCandidates > 0 ? {
      id: "convert-ready-candidates",
      title: "Convert ready candidates",
      body: "Move ready prospects into the strongest role brief while consent is fresh.",
      progress: Math.min(readyCandidates, 3),
      target: 3,
      progressLabel: `${Math.min(readyCandidates, 3)}/3 ready`,
      reward: "Submission velocity",
      payoutTiming: "Challenge credit posts after submissions have time to reach review movement.",
      eligibility: "Distinct ready candidates count once when they are moved into a consented role packet.",
      tone: "live",
      actionLabel: "Open candidates",
      action: "candidates",
    } : {
      id: "build-sourced-pipeline",
      title: "Build sourced pipeline",
      body: "Save candidates before submission so duplicate checks and role matching can work.",
      progress: Math.min(sourcedCandidates.filter((candidate) => candidate.stage !== "archived").length, 5),
      target: 5,
      progressLabel: `${Math.min(sourcedCandidates.filter((candidate) => candidate.stage !== "archived").length, 5)}/5 sourced`,
      reward: "Matchboard unlock",
      payoutTiming: "No direct payout; this unlocks better matchboard and access-review signal.",
      eligibility: "Distinct active candidates with a LinkedIn or resume link count toward this challenge.",
      tone: sourcedCandidates.length ? "info" : "mute",
      actionLabel: "Add candidates",
      action: "candidates",
    },
    {
      id: "interview-rate-push",
      title: "Interview-rate push",
      body: `Preferred-level recruiters should trend toward ${PREFERRED_INTERVIEW_RATE_TARGET}% interview movement.`,
      progress: Math.min(interviewRate, PREFERRED_INTERVIEW_RATE_TARGET),
      target: PREFERRED_INTERVIEW_RATE_TARGET,
      progressLabel: `${interviewRate}%/${PREFERRED_INTERVIEW_RATE_TARGET}%`,
      reward: "Preferred queue signal",
      payoutTiming: "Reviewed after the week closes so submitted candidates have time to advance.",
      eligibility: "Only submissions that advance, interview, offer, or hire count toward the movement rate.",
      tone: interviewRate >= PREFERRED_INTERVIEW_RATE_TARGET ? "success" : submissions.length ? "info" : "mute",
      actionLabel: "Open submissions",
      action: "submissions",
    },
  ]
  const payoutRows = sortSubmissions(submissions)
    .filter((submission) => submissionIsConfirmedOpen(submission) || submission.status === "hired" || Boolean(submission.recruiterPayout?.status && submission.recruiterPayout.status !== "none"))
    .slice(0, 8)
    .map((submission): RecruiterPayoutRow => {
      const payoutMeta = recruiterPayoutStatusMeta(submission.recruiterPayout?.status)
      const status = submission.recruiterPayout?.status && submission.recruiterPayout.status !== "none"
        ? payoutMeta.label
        : statusMeta(submission.status).label
      return {
        id: submission.id,
        candidate: submission.candidate?.name || "Candidate",
        role: submission.jobTitleSnapshot || jobsById.get(submissionRoleId(submission))?.title || "Role",
        status,
        value: formatCurrencyShort(recruiterPayoutAmount(submission, jobsById)),
        payout: payoutTimingForSubmission(submission),
        tone: submission.recruiterPayout?.status && submission.recruiterPayout.status !== "none"
          ? payoutMeta.tone
          : statusMeta(submission.status).tone,
      }
    })
  const rewardSubmissionRows = sortSubmissions(submissions)
    .filter((submission) => {
      const payoutStatus = submission.recruiterPayout?.status
      return (payoutStatus && payoutStatus !== "none") ||
        ["advanced", "interviewing", "offer", "hired"].includes(submission.status ?? "")
    })
    .slice(0, 6)
    .map((submission): RecruiterRewardLedgerRow => {
      const payoutStatus = submission.recruiterPayout?.status
      const payoutMeta = recruiterPayoutStatusMeta(payoutStatus)
      const hasRecordedPayout = Boolean(payoutStatus && payoutStatus !== "none")
      const submissionMeta = statusMeta(submission.status)
      const status = hasRecordedPayout ? payoutMeta.label : submissionMeta.label
      const tone = hasRecordedPayout ? payoutMeta.tone : submissionMeta.tone
      const role = submission.jobTitleSnapshot || jobsById.get(submissionRoleId(submission))?.title || "Role"
      const candidate = submission.candidate?.name || "Candidate"
      const category = hasRecordedPayout
        ? "Recorded payout"
        : submission.status === "hired" || submission.status === "offer"
          ? "Hire reward"
          : "Interview movement"
      return {
        id: `submission-${submission.id}`,
        category,
        title: candidate,
        body: role,
        value: hasRecordedPayout || submission.status === "hired" || submission.status === "offer"
          ? formatCurrencyShort(recruiterPayoutAmount(submission, jobsById))
          : "Projected",
        status,
        schedule: payoutTimingForSubmission(submission),
        tone,
        action: "submissions",
        actionLabel: "Open submission",
      }
    })
  const challengeLedgerRows = challenges.slice(0, 2).map((challenge): RecruiterRewardLedgerRow => ({
    id: `challenge-${challenge.id}`,
    category: "Weekly challenge",
    title: challenge.title,
    body: challenge.eligibility,
    value: challenge.reward,
    status: challenge.progressLabel,
    schedule: challenge.payoutTiming,
    tone: challenge.tone,
    action: challenge.action,
    actionLabel: challenge.actionLabel,
  }))
  const rewardLedgerRows = [...rewardSubmissionRows, ...challengeLedgerRows].slice(0, 8)
  const rewardLedger: RecruiterRewardLedger = {
    headline: activePipelineValue > 0 ? `${formatCurrencyShort(activePipelineValue)} projected` : "No projected rewards yet",
    body: activePipelineValue > 0
      ? `${openSubmissions.length} active submission${openSubmissions.length === 1 ? "" : "s"} can still convert into recorded payout.`
      : "Create consented submissions and advance them into hiring-team review to start the ledger.",
    summary: [
      {
        label: "Projected open",
        value: formatCurrencyShort(activePipelineValue),
        body: "Non-closed submissions using recorded payout amount first, role reward second.",
        tone: activePipelineValue > 0 ? "live" : "mute",
      },
      {
        label: "Recorded won",
        value: formatCurrencyShort(wonValue),
        body: paidPayoutSubmissions.length
          ? `${paidPayoutSubmissions.length} paid payout${paidPayoutSubmissions.length === 1 ? "" : "s"} in the tracker.`
          : "Hired outcomes are shown here until payout is explicitly recorded.",
        tone: wonValue > 0 ? "success" : "mute",
      },
      {
        label: "Movement rate",
        value: `${interviewRate}%`,
        body: `${advancedSubmissions.length}/${submissions.length || 0} submissions have advanced, interview, offer, or hired status.`,
        tone: interviewRate >= PREFERRED_INTERVIEW_RATE_TARGET ? "success" : submissions.length ? "info" : "mute",
      },
      {
        label: "Ledger rows",
        value: String(rewardLedgerRows.length),
        body: "Recorded payout, late-stage opportunity, and weekly challenge items visible now.",
        tone: rewardLedgerRows.length ? "info" : "mute",
      },
    ],
    rows: rewardLedgerRows,
    policies: [
      {
        label: "Projected vs recorded",
        value: "Recorded wins",
        body: "When WeKruit records recruiterPayout status or amount, the ledger uses that instead of estimates.",
        tone: "info",
      },
      {
        label: "Hire reward timing",
        value: "Start-date gated",
        body: "Offer and hire rows stay projected until start-date, eligibility, invoice, or paid status is recorded.",
        tone: "mute",
      },
      {
        label: "Challenge rewards",
        value: challengeDeadlineLabel(),
        body: "Weekly challenges explain access, status, or bonus posture; cash is only final when payout status is recorded.",
        tone: challenges.some((challenge) => challenge.tone === "live" || challenge.tone === "success") ? "success" : "info",
      },
    ],
  }
  const payoutReadinessTone: OperatingTone = invoiceReadySubmissions.length || paidPayoutSubmissions.length
    ? "success"
    : pendingPayoutSubmissions.length || hiredSubmissions.length
      ? "live"
      : activePipelineValue > 0
        ? "info"
        : "mute"
  const payoutReadiness: RecruiterPayoutReadiness = {
    label: "Payout readiness",
    title: invoiceReadySubmissions.length
      ? "Invoice-ready payout exists"
      : pendingPayoutSubmissions.length
        ? "Payout is being cleared"
        : activePipelineValue > 0
          ? "Payment setup should be confirmed before first hire"
          : "No payout setup needed yet",
    body: invoiceReadySubmissions.length
      ? `${invoiceReadySubmissions.length} payout${invoiceReadySubmissions.length === 1 ? "" : "s"} can move to processing.`
      : pendingPayoutSubmissions.length
        ? `${pendingPayoutSubmissions.length} payout${pendingPayoutSubmissions.length === 1 ? "" : "s"} need start-date or invoice readiness.`
        : activePipelineValue > 0
          ? "You have projected earning exposure. Confirm payment method before the first eligible hire."
          : "Build sourced candidates and consented submissions first; payout setup becomes relevant when value appears.",
    tone: payoutReadinessTone,
    cards: [
      {
        label: "Pending payout",
        value: formatCurrencyShort(pendingPayoutValue),
        body: pendingPayoutSubmissions.length
          ? `${pendingPayoutSubmissions.length} recorded payout${pendingPayoutSubmissions.length === 1 ? "" : "s"} not paid yet.`
          : "No eligible, pending-start, or invoice-ready payout is recorded.",
        tone: pendingPayoutValue > 0 ? "live" : "mute",
      },
      {
        label: "Invoice ready",
        value: String(invoiceReadySubmissions.length),
        body: "Rows with invoice_ready status are ready for payout processing.",
        tone: invoiceReadySubmissions.length ? "success" : "mute",
      },
      {
        label: "Payment method",
        value: "Ops-assisted",
        body: recordedPayoutSubmissions.length
          ? `${recordedPayoutSubmissions.length} payout row${recordedPayoutSubmissions.length === 1 ? "" : "s"} recorded; no connected payment-provider field is exposed in recruiter profile yet.`
          : "No connected payment-provider field is exposed in recruiter profile yet.",
        tone: activePipelineValue > 0 || pendingPayoutSubmissions.length ? "warn" : "mute",
      },
    ],
    steps: [
      {
        label: "Account identity",
        value: "Verified",
        body: "This recruiter workspace is bound to a Firebase account via email invitation.",
        tone: "success",
      },
      {
        label: "Payment method",
        value: activePipelineValue > 0 || pendingPayoutSubmissions.length ? "Confirm before hire" : "Not due",
        body: "A real Stripe or payment-method connection is not in the profile schema yet, so payout setup remains an ops-confirmed step.",
        tone: activePipelineValue > 0 || pendingPayoutSubmissions.length ? "warn" : "mute",
        action: "settings",
        actionLabel: "Open account",
      },
      {
        label: "Eligible outcome",
        value: String(pendingPayoutSubmissions.length + paidPayoutSubmissions.length),
        body: "Eligibility starts only after WeKruit records payout status on an offer, hire, or paid submission.",
        tone: pendingPayoutSubmissions.length || paidPayoutSubmissions.length ? "live" : activePipelineValue > 0 ? "info" : "mute",
        action: "submissions",
        actionLabel: "Open submissions",
      },
      {
        label: "Processing",
        value: paidPayoutSubmissions.length ? `${paidPayoutSubmissions.length} paid` : invoiceReadySubmissions.length ? `${invoiceReadySubmissions.length} ready` : "Not started",
        body: paidPayoutSubmissions.length
          ? "Paid payouts remain visible in the tracker for audit."
          : "Processing starts after invoice-ready or paid status is recorded by WeKruit.",
        tone: paidPayoutSubmissions.length || invoiceReadySubmissions.length ? "success" : "mute",
      },
    ],
  }
  const currentTier = wonValue > 0 && interviewRate >= PREFERRED_INTERVIEW_RATE_TARGET
    ? "Premier"
    : statusRank >= 2
      ? "Preferred"
      : statusRank === 1
        ? "Standard"
        : "Builder"
  const nextTier = currentTier === "Premier"
    ? "Maintain Premier"
    : currentTier === "Preferred"
      ? "Next: Premier"
      : currentTier === "Standard"
        ? "Next: Preferred"
        : "Next: Standard"
  const approvalPriorityUnlocked = statusRank >= 2 || wonValue > 0
  const submissionPriorityUnlocked = statusRank >= 2 || interviewRate >= PREFERRED_INTERVIEW_RATE_TARGET
  const payoutPriorityUnlocked = invoiceReadySubmissions.length > 0 || paidPayoutSubmissions.length > 0 || wonValue > 0
  const coverageUnlocked = activePrimaryRoles > 0 && activityCoverage >= 80
  const cleanCalibration = openQuestions + hardFeedback === 0
  const ratingGateMet = ratingNumber >= 3
  const statusBenefits: RecruiterStatusBenefitsCenter = {
    label: "Status benefits",
    title: `${currentTier} benefits posture`,
    body: currentTier === "Premier"
      ? "Premier-level signal is active: protect movement, clean calibration, and payout evidence so priority posture stays defensible."
      : currentTier === "Preferred"
        ? "Preferred signal is active. The next step is placement or payout evidence, not more low-confidence volume."
        : currentTier === "Standard"
          ? "Standard posture means the account has movement, but not enough proof for stronger priority treatment yet."
          : "Builder posture means WeKruit should see proof before promising priority review or payout handling.",
    tone: currentTier === "Premier" ? "live" : currentTier === "Preferred" ? "success" : currentTier === "Standard" ? "info" : "mute",
    currentTier,
    nextTier,
    benefits: [
      {
        label: "Submission priority",
        value: submissionPriorityUnlocked ? (currentTier === "Premier" ? "Top queue" : "Above default") : "Default queue",
        body: submissionPriorityUnlocked
          ? "Advanced movement gives WeKruit a reason to review your packets ahead of lower-signal volume."
          : `Reach ${PREFERRED_INTERVIEW_RATE_TARGET}% interview movement or Preferred status before promising priority review.`,
        tone: submissionPriorityUnlocked ? (currentTier === "Premier" ? "live" : "success") : submissions.length ? "info" : "mute",
        locked: !submissionPriorityUnlocked,
        action: "submissions",
        actionLabel: "Open submissions",
      },
      {
        label: "Role approval lane",
        value: approvalPriorityUnlocked ? "Priority review" : "Managed review",
        body: approvalPriorityUnlocked
          ? "Role applications can lean on status, quality, and candidate proof instead of starting cold."
          : "Role access still needs candidate proof, clean questions, and a focused pitch.",
        tone: approvalPriorityUnlocked ? "success" : "info",
        locked: !approvalPriorityUnlocked,
        action: "roles",
        actionLabel: "Open roles",
      },
      {
        label: "Payout handling",
        value: payoutPriorityUnlocked ? (invoiceReadySubmissions.length ? "Invoice ready" : "Ops priority") : "Standard timing",
        body: payoutPriorityUnlocked
          ? "Recorded payout or hire evidence gives ops a concrete row to process."
          : "Payment setup stays ops-assisted until eligible, invoice-ready, paid, or hired evidence exists.",
        tone: payoutPriorityUnlocked ? "live" : activePipelineValue > 0 ? "warn" : "mute",
        locked: !payoutPriorityUnlocked,
        action: payoutPriorityUnlocked ? "submissions" : "settings",
        actionLabel: payoutPriorityUnlocked ? "Open payout rows" : "Open account",
      },
      {
        label: "Challenge credit",
        value: challengeDeadlineLabel(),
        body: "Weekly challenge progress feeds access and status review; it is not cash until payout status is recorded.",
        tone: challenges.some((challenge) => challenge.tone === "success" || challenge.tone === "live") ? "success" : "info",
        locked: false,
        action: challenges[0]?.action,
        actionLabel: challenges[0]?.actionLabel,
      },
    ],
    gates: [
      {
        label: "Movement gate",
        value: `${interviewRate}%/${PREFERRED_INTERVIEW_RATE_TARGET}%`,
        body: `${advancedSubmissions.length}/${submissions.length || 0} submissions have advanced, interview, offer, or hired status.`,
        tone: interviewRate >= PREFERRED_INTERVIEW_RATE_TARGET ? "success" : submissions.length ? "info" : "mute",
        locked: interviewRate < PREFERRED_INTERVIEW_RATE_TARGET,
        action: "submissions",
        actionLabel: "Review pipeline",
      },
      {
        label: "Rating gate",
        value: ratingLabel,
        body: ratedSubmissions.length
          ? `${ratedSubmissions.length} rated submission${ratedSubmissions.length === 1 ? "" : "s"} are included in the current quality read.`
          : "No rated submissions yet; quality is inferred until feedback arrives.",
        tone: ratingGateMet ? "success" : ratedSubmissions.length ? "warn" : "mute",
        locked: !ratingGateMet,
        action: "performance",
        actionLabel: "Open feedback",
      },
      {
        label: "Coverage gate",
        value: activePrimaryRoles ? `${coveredPrimaryRoles}/${activePrimaryRoles}` : "No roles",
        body: activePrimaryRoles
          ? "Approved roles should have live sourced candidates or active submissions."
          : "Apply for role access before coverage can count toward status.",
        tone: coverageUnlocked ? "success" : activePrimaryRoles ? "warn" : "mute",
        locked: !coverageUnlocked,
        action: "roles",
        actionLabel: activePrimaryRoles ? "Cover roles" : "Apply for access",
      },
      {
        label: "Calibration gate",
        value: cleanCalibration ? "Clean" : String(openQuestions + hardFeedback),
        body: cleanCalibration
          ? "No open role questions or hard blocked market signals are dragging status review."
          : `${openQuestions} open question${openQuestions === 1 ? "" : "s"} and ${hardFeedback} hard or blocked market signal${hardFeedback === 1 ? "" : "s"} need cleanup.`,
        tone: cleanCalibration ? "success" : "warn",
        locked: !cleanCalibration,
        action: "performance",
        actionLabel: "Clear blockers",
      },
    ],
  }
  return {
    statusLabel: operatingMetrics.statusLabel,
    ratingLabel,
    ratingBody,
    interviewRate,
    activePipelineValue,
    wonValue,
    openOpportunityValue,
    activityCoverage,
    activePrimaryRoles,
    coveredPrimaryRoles,
    summary: [
      {
        label: "Status",
        value: operatingMetrics.statusLabel,
        body: operatingMetrics.statusBody,
        tone: operatingMetrics.statusTone,
      },
      {
        label: "Recruiter rating",
        value: ratingLabel,
        body: ratingBody,
        tone: averageRating === null ? (submissions.length ? "info" : "mute") : ratingNumber >= 3 ? "success" : ratingNumber >= 2 ? "info" : "warn",
      },
      {
        label: "Active pipeline value",
        value: formatCurrencyShort(activePipelineValue),
        body: `${openSubmissions.length} active submission${openSubmissions.length === 1 ? "" : "s"} using recorded payout amounts where available.`,
        tone: activePipelineValue > 0 ? "live" : "mute",
      },
      {
        label: "Won value",
        value: formatCurrencyShort(wonValue),
        body: paidPayoutSubmissions.length
          ? `${paidPayoutSubmissions.length} paid payout${paidPayoutSubmissions.length === 1 ? "" : "s"} recorded.`
          : `${hiredSubmissions.length} hired placement${hiredSubmissions.length === 1 ? "" : "s"} recorded.`,
        tone: wonValue > 0 ? "success" : "mute",
      },
    ],
    tiers: [
      {
        label: "Builder",
        body: "Create visible sourced candidates and first quality submissions.",
        requirement: "Start here",
        active: statusRank === 0,
        tone: "mute",
      },
      {
        label: "Standard",
        body: "Maintain role activity and respond to calibration quickly.",
        requirement: "3+ submissions or 6+ active sourced candidates",
        active: statusRank === 1,
        tone: "info",
      },
      {
        label: "Preferred",
        body: "Higher-trust access for recruiters with quality movement.",
        requirement: "8 weekly submissions, 30%+ advanced, low duplicate/rejection drag",
        active: statusRank >= 2,
        tone: "success",
      },
      {
        label: "Premier",
        body: "Reserved for repeat placements and consistently clean trust record.",
        requirement: "Hired outcomes plus sustained Preferred metrics",
        active: wonValue > 0 && interviewRate >= PREFERRED_INTERVIEW_RATE_TARGET,
        tone: "live",
      },
    ],
    challenges,
    payouts: payoutRows,
    rewardLedger,
    payoutReadiness,
    statusBenefits,
    expectations: [
      {
        label: "Primary coverage",
        value: `${activityCoverage}%`,
        body: activePrimaryRoles
          ? `${coveredPrimaryRoles}/${activePrimaryRoles} approved roles have a live candidate or active submission.`
          : "Apply for role access before the platform can score coverage.",
        tone: activityCoverage >= 80 ? "success" : activePrimaryRoles ? "warn" : "mute",
      },
      {
        label: "Open opportunity",
        value: formatCurrencyShort(openOpportunityValue),
        body: `${jobs.length} active WeKruit collab role${jobs.length === 1 ? "" : "s"} estimated at the default success-fee floor when no explicit bounty exists.`,
        tone: jobs.length ? "info" : "mute",
      },
      {
        label: "Calibration load",
        value: String(openQuestions + hardFeedback),
        body: `${openQuestions} open role question${openQuestions === 1 ? "" : "s"}, ${hardFeedback} hard or blocked market signal${hardFeedback === 1 ? "" : "s"}.`,
        tone: openQuestions + hardFeedback > 0 ? "warn" : "success",
      },
    ],
  }
}

function buildRecruiterGroundRulesCenter(
  candidates: RecruiterSourcedCandidateItem[],
  submissions: RecruiterSubmissionItem[],
  roleFeedback: RecruiterRoleFeedbackItem[],
  primaryRoleIds: string[],
): RecruiterGroundRulesCenter {
  const activeCandidates = candidates.filter((candidate) => candidate.stage !== "archived")
  const duplicateIds = duplicateCandidateIds(activeCandidates)
  const consentNeeds = submissions.filter(candidateConfirmationCanResend)
  const nonApprovedRoleOutreach = activeCandidates.filter((candidate) => {
    const jobId = candidate.inboundJobId || candidate.jobId
    const outreachStatus = candidate.outreach?.status ?? "not_contacted"
    return typeof jobId === "string" && jobId.length > 0 &&
      !primaryRoleIds.includes(jobId) &&
      outreachStatus !== "not_contacted" &&
      outreachStatus !== "not_interested"
  })
  const notInterestedWithFollowUp = activeCandidates.filter((candidate) =>
    candidate.outreach?.status === "not_interested" && Boolean(candidate.outreach.nextFollowUpAt),
  )
  const followUpsDue = activeCandidates.filter((candidate) => candidateFollowUpState(candidate).needsAction)
  const lowRatedSubmissions = submissions.filter((submission) => {
    const rating = submissionFeedbackRating(submission)
    return rating !== null && rating <= 2
  })
  const oneStarSubmissions = lowRatedSubmissions.filter((submission) => submissionFeedbackRating(submission) === 1)
  const closedNegative = submissions.filter((submission) => CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? ""))
  const hardOrBlockedFeedback = roleFeedback.filter((feedback) => feedback.difficulty === "hard" || feedback.difficulty === "blocked")
  const profileProofMissing = activeCandidates.filter((candidate) =>
    !candidate.candidate?.email?.trim() ||
    !candidate.candidate?.link?.trim() ||
    !candidate.candidate?.notes?.trim(),
  )
  const measurableRiskCount = duplicateIds.size +
    consentNeeds.length +
    nonApprovedRoleOutreach.length +
    notInterestedWithFollowUp.length +
    oneStarSubmissions.length +
    hardOrBlockedFeedback.length
  const scoreBase = activeCandidates.length || submissions.length ? 100 : 0
  const score = scoreBase
    ? clampNumber(
      100 -
        duplicateIds.size * 14 -
        consentNeeds.length * 12 -
        nonApprovedRoleOutreach.length * 12 -
        notInterestedWithFollowUp.length * 10 -
        oneStarSubmissions.length * 18 -
        Math.min(18, hardOrBlockedFeedback.length * 4) -
        Math.min(12, profileProofMissing.length * 2),
      0,
      100,
    )
    : 0
  const tone: OperatingTone = measurableRiskCount > 0
    ? "warn"
    : activeCandidates.length || submissions.length
      ? "success"
      : "mute"
  const title = measurableRiskCount > 0
    ? `${measurableRiskCount} ground rule risk${measurableRiskCount === 1 ? "" : "s"} need cleanup`
    : activeCandidates.length || submissions.length
      ? "Ground rules are clean on current evidence"
      : "Ground rules start with the first candidate lane"
  const body = measurableRiskCount > 0
    ? "Fix consent, duplicate ownership, approval-before-outreach, and feedback issues before scaling recruiter volume."
    : activeCandidates.length || submissions.length
      ? "Current recruiter activity has no visible breach signal. Keep every candidate tied to consent, ownership, role approval, and feedback."
      : "Use the workspace as the source of truth before contacting candidates or submitting packets."
  const riskRows: RecruiterGroundRuleItem[] = [
    duplicateIds.size > 0 ? {
      label: "Duplicate ownership",
      value: String(duplicateIds.size),
      body: "Merge or archive duplicate candidate identity records before outreach or submission continues.",
      tone: "warn",
      action: "candidates",
      actionLabel: "Clean candidates",
    } : null,
    consentNeeds.length > 0 ? {
      label: "Consent confirmation",
      value: String(consentNeeds.length),
      body: "Candidate packets need confirmation repaired before the submission can be treated as clean.",
      tone: "warn",
      action: "submissions",
      actionLabel: "Repair consent",
    } : null,
    nonApprovedRoleOutreach.length > 0 ? {
      label: "Approval-before-outreach",
      value: String(nonApprovedRoleOutreach.length),
      body: "Role-specific outreach is visible on non-approved lanes. Use role access or keep the candidate as a general prospect.",
      tone: "warn",
      action: "roles",
      actionLabel: "Review access",
    } : null,
    notInterestedWithFollowUp.length > 0 ? {
      label: "Stop-after-no",
      value: String(notInterestedWithFollowUp.length),
      body: "Candidates marked not interested should not keep scheduled follow-ups unless they re-open the conversation.",
      tone: "warn",
      action: "candidates",
      actionLabel: "Clear follow-ups",
    } : null,
    hardOrBlockedFeedback.length + closedNegative.length > 0 ? {
      label: "Feedback debt",
      value: String(hardOrBlockedFeedback.length + closedNegative.length),
      body: "Hard role feedback, rejected packets, or duplicates should change the next shortlist before more volume.",
      tone: hardOrBlockedFeedback.length || oneStarSubmissions.length ? "warn" : "info",
      action: "submissions",
      actionLabel: "Open feedback",
    } : null,
    followUpsDue.length > 0 ? {
      label: "Follow-up hygiene",
      value: String(followUpsDue.length),
      body: "Overdue candidate follow-ups should be closed, moved forward, or marked not interested.",
      tone: "info",
      action: "candidates",
      actionLabel: "Update outreach",
    } : null,
  ].filter((item): item is RecruiterGroundRuleItem => Boolean(item))

  return {
    title,
    body,
    tone,
    scoreLabel: scoreBase ? `${score}/100` : "No activity",
    cards: [
      {
        label: "Consent clean",
        value: `${Math.max(0, submissions.length - consentNeeds.length)}/${submissions.length || 0}`,
        body: consentNeeds.length
          ? `${consentNeeds.length} submission${consentNeeds.length === 1 ? "" : "s"} need candidate confirmation repair.`
          : "Every tracked submission is clean on the visible consent signal.",
        tone: consentNeeds.length ? "warn" : submissions.length ? "success" : "mute",
        action: "submissions",
        actionLabel: "Open submissions",
      },
      {
        label: "Duplicate lanes",
        value: String(duplicateIds.size),
        body: duplicateIds.size
          ? "Candidate identity collisions should be cleaned before more sourcing."
          : "No duplicate candidate identity signal in the active CRM.",
        tone: duplicateIds.size ? "warn" : activeCandidates.length ? "success" : "mute",
        action: "candidates",
        actionLabel: "Open candidates",
      },
      {
        label: "Approved outreach",
        value: String(nonApprovedRoleOutreach.length),
        body: nonApprovedRoleOutreach.length
          ? "Some contacted prospects are attached to roles without approved access."
          : "No role-specific outreach is visible outside approved role access.",
        tone: nonApprovedRoleOutreach.length ? "warn" : activeCandidates.length ? "success" : "mute",
        action: "roles",
        actionLabel: "Open roles",
      },
      {
        label: "Feedback applied",
        value: String(hardOrBlockedFeedback.length + closedNegative.length),
        body: hardOrBlockedFeedback.length + closedNegative.length
          ? "Feedback debt exists; do not source lookalikes until the pattern changes."
          : "No hard-role or closed-negative feedback debt is visible.",
        tone: hardOrBlockedFeedback.length + closedNegative.length ? "warn" : submissions.length || roleFeedback.length ? "success" : "mute",
        action: "submissions",
        actionLabel: "Open feedback",
      },
    ],
    rules: [
      {
        label: "Candidate consent",
        value: "Required",
        body: "Every formal packet needs explicit candidate permission and a repair path when confirmation is pending or failed.",
        tone: consentNeeds.length ? "warn" : "success",
        action: "submissions",
        actionLabel: "Check packets",
      },
      {
        label: "Ownership first",
        value: "One record",
        body: "Use one candidate identity record with email or profile link before any recruiter outreach scales.",
        tone: duplicateIds.size ? "warn" : "success",
        action: "candidates",
        actionLabel: "Check ownership",
      },
      {
        label: "Approval before outreach",
        value: "No cold role spam",
        body: "Searching and saving prospects is allowed, but role-specific outreach should follow approved access or a candidate-led single-submit lane.",
        tone: nonApprovedRoleOutreach.length ? "warn" : "info",
        action: "roles",
        actionLabel: "Review access",
      },
      {
        label: "Accurate representation",
        value: "Role brief only",
        body: "Represent only what the WeKruit role brief supports. Do not imply exclusivity, preferred status, or unverified compensation detail.",
        tone: "info",
        action: "roles",
        actionLabel: "Read briefs",
      },
      {
        label: "Stop after disinterest",
        value: notInterestedWithFollowUp.length ? `${notInterestedWithFollowUp.length} risk` : "Clean",
        body: "Candidates marked not interested should leave the outreach queue unless they explicitly re-open.",
        tone: notInterestedWithFollowUp.length ? "warn" : activeCandidates.length ? "success" : "mute",
        action: "candidates",
        actionLabel: "Check outreach",
      },
      {
        label: "Learn from feedback",
        value: "Required",
        body: "Hard feedback, low ratings, rejected packets, and duplicates should change the next shortlist before more submissions.",
        tone: hardOrBlockedFeedback.length || lowRatedSubmissions.length ? "warn" : "success",
        action: "submissions",
        actionLabel: "Open learning",
      },
    ],
    risks: riskRows,
  }
}

function computeRecruiterTrustCenter(
  candidates: RecruiterSourcedCandidateItem[],
  submissions: RecruiterSubmissionItem[],
  roleFeedback: RecruiterRoleFeedbackItem[],
  primaryRoleIds: string[],
  operatingMetrics: RecruiterOperatingMetrics,
): RecruiterTrustCenter {
  const activeCandidates = candidates.filter((candidate) => candidate.stage !== "archived")
  const readyCandidates = activeCandidates.filter((candidate) => candidate.stage === "ready")
  const profileCompleteCandidates = activeCandidates.filter((candidate) =>
    Boolean(candidate.candidate?.email?.trim()) &&
    Boolean(candidate.candidate?.link?.trim()) &&
    Boolean(candidate.candidate?.notes?.trim()),
  )
  const duplicateIds = duplicateCandidateIds(activeCandidates)
  const followUpsDue = activeCandidates.filter((candidate) => candidateFollowUpState(candidate).needsAction)
  const confirmationNeeds = submissions.filter(candidateConfirmationCanResend)
  const rejectedOrDuplicate = submissions.filter((submission) => CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? ""))
  const ratedSubmissions = submissions
    .map(submissionFeedbackRating)
    .filter((rating): rating is number => rating !== null)
  const oneStarRatings = ratedSubmissions.filter((rating) => rating === 1).length
  const lowRatings = ratedSubmissions.filter((rating) => rating <= 2).length
  const averageRating = ratedSubmissions.length
    ? ratedSubmissions.reduce((sum, rating) => sum + rating, 0) / ratedSubmissions.length
    : null
  const hardOrBlockedRoles = roleFeedback.filter((feedback) => feedback.difficulty === "hard" || feedback.difficulty === "blocked")
  const profileCoverage = activeCandidates.length ? Math.round((profileCompleteCandidates.length / activeCandidates.length) * 100) : 0
  const confirmationPenalty = confirmationNeeds.length * 8
  const duplicatePenalty = duplicateIds.size * 7
  const rejectionPenalty = submissions.length ? Math.round((rejectedOrDuplicate.length / submissions.length) * 18) : 0
  const lowRatingPenalty = oneStarRatings * 28 + Math.max(0, lowRatings - oneStarRatings) * 12
  const feedbackPenalty = hardOrBlockedRoles.length * 5
  const followUpPenalty = followUpsDue.length * 4
  const baseScore = operatingMetrics.qualityScore ?? (submissions.length ? 62 : activeCandidates.length ? 52 : 40)
  const score = clampNumber(
    baseScore +
      Math.min(10, readyCandidates.length * 2) +
      Math.min(8, Math.floor(profileCoverage / 14)) -
      confirmationPenalty -
      duplicatePenalty -
      rejectionPenalty -
      lowRatingPenalty -
      feedbackPenalty -
      followUpPenalty,
    0,
    100,
  )
  const statusTone: OperatingTone = oneStarRatings > 0 || score < 45
    ? "warn"
    : score >= 78 && confirmationNeeds.length === 0 && duplicateIds.size === 0
      ? "success"
      : score >= 60
        ? "info"
        : "mute"
  const statusLabel = oneStarRatings > 0
    ? "Quality hold risk"
    : statusTone === "success"
      ? "Trust-ready"
      : statusTone === "info"
        ? "Watch list"
        : "Builder trust"
  const statusBody = oneStarRatings > 0
    ? "A 1/4 rating should pause volume until feedback is understood and the next packet is visibly stronger."
    : confirmationNeeds.length > 0
      ? "Candidate confirmation debt can weaken recruiter trust even when role fit is good."
      : duplicateIds.size > 0
        ? "Duplicate identity signals should be cleaned before scaling outreach or submissions."
        : statusTone === "success"
          ? "The current account signal supports more role focus if activity stays clean."
          : "Build stronger proof, confirmation hygiene, and feedback response before asking for more role volume."
  const nextActionLabel = oneStarRatings > 0 || lowRatings > 0
    ? "Read low-rated feedback"
    : confirmationNeeds.length > 0
      ? "Fix candidate confirmations"
      : duplicateIds.size > 0
        ? "Clean duplicate candidates"
        : followUpsDue.length > 0
          ? "Clear follow-up debt"
          : readyCandidates.length > 0
            ? "Convert ready candidates"
            : "Build proof-rich bench"
  const nextActionBody = oneStarRatings > 0 || lowRatings > 0
    ? "Open the feedback rows, identify the missing hard filters, and do not send lookalikes until the scorecard is corrected."
    : confirmationNeeds.length > 0
      ? "Resend confirmation or stop treating those packets as clean submissions until the candidate confirms."
      : duplicateIds.size > 0
        ? "Keep one source-of-truth record per candidate email or profile link before outreach continues."
        : followUpsDue.length > 0
          ? "Move overdue prospects forward or archive them so the bench stays truthful."
          : readyCandidates.length > 0
            ? "Match the strongest ready candidates into role briefs and submit only with consent."
            : "Add email, LinkedIn/resume, notes, outreach status, and follow-up dates to make matching reliable."
  const advancedSubmissions = submissions.filter((submission) => ADVANCED_STATUSES.includes(submission.status ?? ""))
  const hiredSubmissions = submissions.filter((submission) => submission.status === "hired")
  const cleanSubmissions = submissions.filter((submission) => {
    if (CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? "")) return false
    if (candidateConfirmationCanResend(submission)) return false
    const rating = submissionFeedbackRating(submission)
    return rating === null || rating >= 3
  })
  const cleanSubmissionCount = cleanSubmissions.length
  const interviewRate = submissions.length ? Math.round((advancedSubmissions.length / submissions.length) * 100) : 0
  const standardBlockers = [
    ...(oneStarRatings > 0 ? ["Resolve 1-star feedback"] : []),
    ...(duplicateIds.size > 0 ? ["Merge duplicate identities"] : []),
    ...(cleanSubmissionCount < 1 && profileCompleteCandidates.length < 3 ? ["Add 3 complete candidates or 1 clean submission"] : []),
  ]
  const preferredBlockers = [
    ...(score < 75 ? ["Raise trust score to 75"] : []),
    ...(cleanSubmissionCount < 5 ? ["Reach 5 clean submissions"] : []),
    ...(advancedSubmissions.length < 2 && interviewRate < 35 ? ["Earn 2 advanced signals or 35% movement"] : []),
    ...(confirmationNeeds.length > 0 ? ["Clear candidate confirmations"] : []),
    ...(duplicateIds.size > 0 ? ["Merge duplicate identities"] : []),
    ...(oneStarRatings > 0 ? ["Resolve 1-star feedback"] : []),
  ]
  const premierBlockers = [
    ...(score < 85 ? ["Raise trust score to 85"] : []),
    ...(cleanSubmissionCount < WEEKLY_SUBMISSION_TARGET ? [`Reach ${WEEKLY_SUBMISSION_TARGET} clean submissions`] : []),
    ...(hiredSubmissions.length === 0 && (advancedSubmissions.length < 4 || interviewRate < PREFERRED_INTERVIEW_RATE_TARGET)
      ? [`Show a hire or ${PREFERRED_INTERVIEW_RATE_TARGET}% movement with 4 advanced packets`]
      : []),
    ...(lowRatings > 0 ? ["Keep low-rated packets at zero"] : []),
    ...(confirmationNeeds.length > 0 ? ["Clear candidate confirmations"] : []),
    ...(duplicateIds.size > 0 ? ["Merge duplicate identities"] : []),
  ]
  const tierRules: Array<{
    label: string
    rank: string
    requirement: string
    unlock: string
    progressLabel: string
    progressValue: string
    blockers: string[]
  }> = [
    {
      label: "Builder",
      rank: "01",
      requirement: "Create a proof-rich bench and make the first clean move.",
      unlock: "Baseline recruiter workspace access.",
      progressLabel: "Bench proof",
      progressValue: `${profileCompleteCandidates.length} complete profiles · ${cleanSubmissionCount} clean packets`,
      blockers: [],
    },
    {
      label: "Standard",
      rank: "02",
      requirement: "Three complete active candidates or one clean submission with no duplicate drag.",
      unlock: "Eligible signal for normal role-access review.",
      progressLabel: "Clean start",
      progressValue: `${profileCompleteCandidates.length}/3 profiles · ${cleanSubmissionCount}/1 packet`,
      blockers: standardBlockers,
    },
    {
      label: "Preferred",
      rank: "03",
      requirement: "Trust score 75+, five clean submissions, and real interview movement.",
      unlock: "Stronger review signal for additional role lanes and recruiter priority.",
      progressLabel: "Priority proof",
      progressValue: `${score}/75 trust · ${cleanSubmissionCount}/5 packets · ${interviewRate}% movement`,
      blockers: preferredBlockers,
    },
    {
      label: "Premier",
      rank: "04",
      requirement: "Trust score 85+, weekly-quality volume, and high movement or a hire.",
      unlock: "Top account signal for priority review and payout confidence.",
      progressLabel: "Top-tier proof",
      progressValue: `${score}/85 trust · ${cleanSubmissionCount}/${WEEKLY_SUBMISSION_TARGET} packets · ${hiredSubmissions.length} hires`,
      blockers: premierBlockers,
    },
  ]
  let currentTierIndex = 0
  tierRules.forEach((tier, index) => {
    if (tier.blockers.length === 0) currentTierIndex = index
  })
  const tiers = tierRules.map((tier, index): RecruiterTrustTierStep => {
    const complete = tier.blockers.length === 0
    const hardBlocked = tier.blockers.some((blocker) =>
      blocker.startsWith("Resolve") ||
      blocker.startsWith("Clear") ||
      blocker.startsWith("Merge") ||
      blocker.startsWith("Keep"),
    )
    const tone: OperatingTone = complete
      ? "success"
      : hardBlocked
        ? "warn"
        : index === currentTierIndex + 1
          ? "info"
          : "mute"
    return {
      label: tier.label,
      rank: tier.rank,
      requirement: tier.requirement,
      unlock: tier.unlock,
      progressLabel: tier.progressLabel,
      progressValue: tier.progressValue,
      complete,
      active: index === currentTierIndex,
      blockedBy: tier.blockers,
      tone,
    }
  })
  const currentTier = tiers[currentTierIndex] ?? tiers[0]
  const nextTier = tiers.find((tier) => !tier.complete)
  const tierProgressLabel = nextTier ? `Next: ${nextTier.label}` : "Maintain Premier"
  const tierProgressValue = nextTier?.blockedBy[0] ?? "Keep trust clean, movement high, and candidate consent current."
  const unlocks: RecruiterTrustGate[] = [
    {
      label: "Role access priority",
      value: currentTierIndex >= 2 ? "Strong signal" : currentTierIndex >= 1 ? "Eligible" : "Build proof",
      body: currentTierIndex >= 2
        ? "Use the clean account signal when requesting more approved role lanes."
        : currentTierIndex >= 1
          ? "Eligible for normal review; stronger movement unlocks a clearer priority case."
          : "Complete candidates or send one clean consented packet before asking for more lanes.",
      tone: currentTierIndex >= 2 ? "success" : currentTierIndex >= 1 ? "info" : "mute",
    },
    {
      label: "Submission queue signal",
      value: currentTierIndex >= 3 ? "Premier" : currentTierIndex >= 2 ? "Preferred" : "Default",
      body: currentTierIndex >= 2
        ? "Quality, consent, and movement now give WeKruit a stronger reason to surface your packets first."
        : "Submission order should stay conservative until quality proof is visible.",
      tone: currentTierIndex >= 3 ? "success" : currentTierIndex >= 2 ? "info" : "mute",
    },
    {
      label: "Weekly activity",
      value: `${Math.min(cleanSubmissionCount, WEEKLY_SUBMISSION_TARGET)}/${WEEKLY_SUBMISSION_TARGET}`,
      body: cleanSubmissionCount >= WEEKLY_SUBMISSION_TARGET
        ? "Weekly-quality volume is strong enough for capacity review."
        : `${Math.max(0, WEEKLY_SUBMISSION_TARGET - cleanSubmissionCount)} more clean packet${WEEKLY_SUBMISSION_TARGET - cleanSubmissionCount === 1 ? "" : "s"} to show full-week operating capacity.`,
      tone: cleanSubmissionCount >= WEEKLY_SUBMISSION_TARGET ? "success" : cleanSubmissionCount ? "info" : "mute",
    },
    {
      label: "Payout confidence",
      value: hiredSubmissions.length ? "Placement proof" : advancedSubmissions.length ? "Movement proof" : "No proof yet",
      body: hiredSubmissions.length
        ? "A hire gives the account direct payout evidence for future priority review."
        : advancedSubmissions.length
          ? "Interview movement helps prove packet quality before a placement closes."
          : "Payout confidence starts once candidates move beyond initial review.",
      tone: hiredSubmissions.length ? "success" : advancedSubmissions.length ? "info" : "mute",
    },
  ]

  return {
    statusLabel,
    statusBody,
    statusTone,
    score,
    tierLabel: currentTier.label,
    tierProgressLabel,
    tierProgressValue,
    nextActionLabel,
    nextActionBody,
    cards: [
      {
        label: "Trust score",
        value: `${score}/100`,
        body: "Composite of submission quality, confirmation hygiene, duplicate risk, and role-feedback drag.",
        tone: statusTone,
      },
      {
        label: "Rating signal",
        value: averageRating === null ? "Unrated" : `${averageRating.toFixed(1)}/4`,
        body: ratedSubmissions.length
          ? `${ratedSubmissions.length} rated submission${ratedSubmissions.length === 1 ? "" : "s"}, ${oneStarRatings} one-star risk.`
          : "No rated submissions yet.",
        tone: oneStarRatings > 0 ? "warn" : averageRating !== null && averageRating >= 3 ? "success" : ratedSubmissions.length ? "info" : "mute",
      },
      {
        label: "Ownership hygiene",
        value: `${confirmationNeeds.length + duplicateIds.size}`,
        body: `${confirmationNeeds.length} confirmation follow-up${confirmationNeeds.length === 1 ? "" : "s"}, ${duplicateIds.size} duplicate identity signal${duplicateIds.size === 1 ? "" : "s"}.`,
        tone: confirmationNeeds.length + duplicateIds.size ? "warn" : "success",
      },
      {
        label: "Profile proof",
        value: `${profileCoverage}%`,
        body: `${profileCompleteCandidates.length}/${activeCandidates.length || 0} active candidates include email, link, and notes.`,
        tone: profileCoverage >= 70 ? "success" : activeCandidates.length ? "info" : "mute",
      },
    ],
    gates: [
      {
        label: "Submission guard",
        value: oneStarRatings > 0 ? "Hold" : lowRatings > 0 ? "Review" : "Open",
        body: oneStarRatings > 0
          ? "Pause new volume until the low-rated packet is reviewed."
          : lowRatings > 0
            ? "Use low-rated feedback before sending another similar candidate."
            : "No low-rating guard detected.",
        tone: oneStarRatings > 0 || lowRatings > 0 ? "warn" : "success",
      },
      {
        label: "Approved lane coverage",
        value: `${primaryRoleIds.length}/${APPROVED_ROLE_LIMIT}`,
        body: primaryRoleIds.length
          ? "Approved roles need live candidate motion and clean packets."
          : "Apply for role access once the bench has proof.",
        tone: primaryRoleIds.length ? "info" : "mute",
      },
      {
        label: "Feedback debt",
        value: String(hardOrBlockedRoles.length + rejectedOrDuplicate.length),
        body: `${hardOrBlockedRoles.length} hard/blocked role signal${hardOrBlockedRoles.length === 1 ? "" : "s"} and ${rejectedOrDuplicate.length} rejected/duplicate submission${rejectedOrDuplicate.length === 1 ? "" : "s"}.`,
        tone: hardOrBlockedRoles.length + rejectedOrDuplicate.length ? "warn" : "success",
      },
      {
        label: "Responsiveness",
        value: String(followUpsDue.length),
        body: followUpsDue.length
          ? "Candidate follow-ups are overdue or unscheduled."
          : "No follow-up debt detected in the active bench.",
        tone: followUpsDue.length ? "warn" : "success",
      },
    ],
    tiers,
    unlocks,
  }
}

function RecruiterStatusLoading() {
  return (
    <section className="rb-panel rb-panel--fill rb-loading-panel" aria-live="polite">
      <h2>Syncing recruiter workspace...</h2>
      <p>Loading your saved candidates, submissions, feedback, and role-alert settings.</p>
    </section>
  )
}

export function RecruiterAccessGate({
  initialError,
  inviteLink,
  onSessionClaimed,
}: {
  initialError?: string | null
  inviteLink?: RecruiterInviteLink | null
  onSessionClaimed: (session: RecruiterSession) => void
}) {
  const [err, setErr] = useState<string | null>(initialError ?? null)
  const [busy, setBusy] = useState(false)
  const [legalEntityName, setLegalEntityName] = useState("")
  const [tosChecked, setTosChecked] = useState(false)
  const inviteEmailHint = inviteLink?.emailHint ?? ""

  useEffect(() => {
    setErr(initialError ?? null)
    if (initialError) setBusy(false)
  }, [initialError])

  const completeGoogleClaim = async (fallbackPending: PendingRecruiterAccess, emailHint?: string) => {
    if (!tosChecked) {
      setErr("Please accept the Terms of Service to continue.")
      return
    }
    let claimEmail = ""
    try {
      if (auth().currentUser) await signOut(auth())
      const result = await signInWithPopup(auth(), createRecruiterGoogleProvider())
      const user = result.user
      claimEmail = cleanRecruiterEmail(user.email ?? "")
      if (!claimEmail) throw new Error("Google did not return an email for this account.")
      const pending = readPendingRecruiterAccess() ?? fallbackPending
      const next = await registerRecruiterAccess({
        name: pending.name || cleanRecruiterName(user.displayName ?? "") || "Recruiter",
        email: claimEmail,
        ...(pending.inviteCode ? { inviteCode: pending.inviteCode } : {}),
        ...(legalEntityName.trim() ? { legalEntityName: legalEntityName.trim() } : {}),
        tosAccepted: true,
      })
      clearPendingRecruiterAccess()
      onSessionClaimed(next)
    } catch (error) {
      clearPendingRecruiterAccess()
      await signOut(auth()).catch(() => undefined)
      setErr(formatRecruiterAuthError(error, fallbackPending.emailHint || emailHint, { codeless: true, email: claimEmail }))
      setBusy(false)
    }
  }

  const submitSignIn = async (e: FormEvent) => {
    e.preventDefault()
    if (!tosChecked) {
      setErr("Please accept the Terms of Service to continue.")
      return
    }
    setBusy(true)
    setErr(null)
    const code = inviteLink?.code || ""
    const hint = inviteLink?.emailHint || inviteEmailHint || undefined
    try {
      writePendingRecruiterAccess(code, "", hint)
      await completeGoogleClaim({
        inviteCode: code,
        name: "",
        createdAtMs: Date.now(),
        ...(hint ? { emailHint: hint } : {}),
      }, hint)
    } catch (error) {
      clearPendingRecruiterAccess()
      setErr(formatRecruiterAuthError(error, hint))
      setBusy(false)
    }
  }

  const clearStuckGoogleState = async () => {
    setBusy(true)
    setErr(null)
    try {
      clearPendingRecruiterAccess()
      await signOut(auth()).catch(() => undefined)
      window.location.assign("/recruiters")
    } catch (error) {
      setErr(formatRecruiterAuthError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rb-access">
      <SiteHeader />
      <main className="rb-access__body">
        <section className="rb-access__copy">
          <p className="rb-overline">Invite only</p>
          <h1>A recruiter operating system, not a shared job list.</h1>
          <p>
            Work released WeKruit collab roles with a private candidate bench,
            ownership checks, submission receipts, and status feedback tied to
            the Google account we invited.
          </p>
          <ul>
            <li>Role briefs show hard filters, calibration notes, and what to avoid.</li>
            <li>Source first, submit after consent, and block duplicate candidate lanes.</li>
            <li>Track every candidate from sourced through hired with feedback and alerts.</li>
          </ul>
        </section>
        <div className="rb-access__right-rail">
          <form className="rb-access__card" onSubmit={submitSignIn}>
            <span className="rb-access__badge">Invite only</span>
            <h2>{inviteLink ? "You're invited" : "Sign in to your recruiter workspace"}</h2>
            <p className="rb-access__hint">
              {inviteEmailHint
                ? `This invite is for ${inviteEmailHint}. Sign in with that Google account.`
                : "Access is by invitation — sign in with the email we invited."}
            </p>
            <label className="rb-access__field">
              <span className="rb-access__field-label">Agency / legal entity name <span className="rb-access__optional">(optional)</span></span>
              <input
                type="text"
                className="rb-access__input"
                placeholder="e.g. Acme Recruiting LLC"
                value={legalEntityName}
                onChange={(e) => setLegalEntityName(e.target.value)}
                maxLength={300}
              />
            </label>
            <label className="rb-access__tos">
              <input
                type="checkbox"
                checked={tosChecked}
                onChange={(e) => { setTosChecked(e.target.checked); if (e.target.checked) setErr(null) }}
              />
              <span>
                I agree to the WeKruit{" "}
                <a href="https://candidate.wekruit.com/legal" target="_blank" rel="noopener noreferrer">
                  Recruiter Terms of Service
                </a>
              </span>
            </label>
            {err && <p className="rb-access__err">{err}</p>}
            <button className="rb-btn primary rb-btn--block" disabled={busy || !tosChecked}>
              {busy ? "Opening Google..." : "Continue with Google"}
            </button>
            <button type="button" className="rb-access__reset" disabled={busy} onClick={() => void clearStuckGoogleState()}>
              Try a different Google account
            </button>
          </form>
          <RecruiterAccessWorkspacePreview />
        </div>
      </main>
    </div>
  )
}

function RecruiterAccessWorkspacePreview() {
  return (
    <section className="rb-access-preview" aria-label="Recruiter workspace preview">
      <header>
        <span>Workspace preview</span>
        <strong>Released role: Founding AI Engineer</strong>
        <p>Approved recruiters see the role brief, candidate lanes, market feedback, and submission status in one workspace.</p>
      </header>
      <div className="rb-access-preview__pipeline" aria-label="Candidate pipeline">
        {["Sourced", "Screened", "Submitted", "In review", "Interviewing", "Hired"].map((stage, index) => (
          <span key={stage} className={index < 3 ? "is-active" : ""}>{stage}</span>
        ))}
      </div>
      <div className="rb-access-preview__grid">
        <article>
          <span>Role brief</span>
          <strong>Hard filters visible</strong>
          <p>Must-have checks, anti-signals, outreach angles, and role questions stay attached to the role.</p>
        </article>
        <article>
          <span>Candidate ownership</span>
          <strong>Duplicate lanes blocked</strong>
          <p>Email and LinkedIn checks protect candidates from repeated recruiter outreach.</p>
        </article>
        <article>
          <span>Feedback loop</span>
          <strong>Next search is clear</strong>
          <p>Rejected or advanced submissions return rating, reasons, and calibration notes.</p>
        </article>
        <article>
          <span>Role alerts</span>
          <strong>New releases notify you</strong>
          <p>Recruiters with alerts enabled get one notification per released collab role.</p>
        </article>
      </div>
    </section>
  )
}

function OverviewTab({
  stats,
  jobs,
  submissions,
  sourcedCandidates,
  roleFeedback,
  roleQuestions,
  roleIntelligence,
  roleApplications,
  notifications,
  operatingMetrics,
  primaryRoleIds,
  onInbox,
  onRoles,
  onMatches,
  onCandidates,
  onSubmissions,
  onPerformance,
  onEarnings,
  onAccess,
}: {
  stats: Array<{ label: string; value: string; meta: string; signal: string; tone: string }>
  jobs: CollabJob[]
  submissions: RecruiterSubmissionItem[]
  sourcedCandidates: RecruiterSourcedCandidateItem[]
  roleFeedback: RecruiterRoleFeedbackItem[]
  roleQuestions: RecruiterRoleQuestionItem[]
  roleIntelligence: RecruiterRoleIntelligenceItem[]
  roleApplications: RecruiterRoleApplicationItem[]
  notifications: RecruiterNotificationItem[]
  operatingMetrics: RecruiterOperatingMetrics
  primaryRoleIds: string[]
  onInbox: () => void
  onRoles: () => void
  onMatches: () => void
  onCandidates: () => void
  onSubmissions: () => void
  onPerformance: () => void
  onEarnings: () => void
  onAccess: (jobId?: string) => void
}) {
  const primaryJobs = jobs.filter((job) => isPrimaryRole(job, primaryRoleIds))
  const pendingApplications = roleApplications.filter((application) => application.status === "pending")
  const suggestedJobs = jobs
    .filter((job) => !isPrimaryRole(job, primaryRoleIds))
    .slice(0, Math.max(0, APPROVED_ROLE_LIMIT - primaryJobs.length))
  const priorityJobs = [...primaryJobs, ...suggestedJobs].slice(0, APPROVED_ROLE_LIMIT)
  const pipeline = buildCandidatePipeline(sourcedCandidates, submissions)
  const feedback = submissions.filter(submissionHasStructuredFeedback).slice(0, 3)
  const workItems = buildRecruiterWorkQueue(jobs, sourcedCandidates, submissions, roleQuestions, roleIntelligence)
  const marketPulse = buildMarketPulse(jobs, roleQuestions, roleIntelligence)
  const cockpit = buildRecruiterCockpitModel(jobs, submissions, sourcedCandidates, roleFeedback, roleQuestions, roleIntelligence, roleApplications, primaryRoleIds)
  const launch = buildRecruiterLaunchModel(jobs, submissions, sourcedCandidates, roleFeedback, primaryRoleIds)
  const inboxItems = buildRecruiterInboxItems(jobs, submissions, sourcedCandidates, roleFeedback, roleQuestions, notifications)
  const inboxSummary = buildRecruiterInboxSummary(submissions, sourcedCandidates, roleQuestions, notifications)
  const inboxTriage = buildRecruiterInboxTriage(inboxItems)
  const routeCockpitAction = (action: RecruiterCockpitAction) => {
    if (action === "roles") onRoles()
    else if (action === "matches") onMatches()
    else if (action === "submissions") onSubmissions()
    else if (action === "performance") onPerformance()
    else if (action === "access") onAccess(cockpit.focusRole?.job.jobId)
    else onCandidates()
  }
  const routeInboxAction = (action: RecruiterInboxAction) => {
    if (action === "roles") onRoles()
    else if (action === "submissions") onSubmissions()
    else if (action === "matches") onMatches()
    else if (action === "earnings") onEarnings()
    else onCandidates()
  }
  return (
    <div className="rb-workspace">
      <RecruiterCockpit model={cockpit} onAction={routeCockpitAction} />
      {launch.completed < launch.total && <RecruiterLaunchSequence model={launch} onAction={routeCockpitAction} />}
      <RecruiterOverviewInboxPanel
        summary={inboxSummary}
        lanes={inboxTriage}
        items={inboxItems.slice(0, 3)}
        onInbox={onInbox}
        onAction={routeInboxAction}
      />
      <section className="rb-stats">
        {stats.map((s) => (
          <article className={`rb-stat is-${s.tone}`} key={s.label}>
            <span>{s.label}<em>{s.signal}</em></span>
            <strong>{s.value}</strong>
            <em>{s.meta}</em>
          </article>
        ))}
      </section>
      <RecruiterOperatingPanel metrics={operatingMetrics} onPerformance={onPerformance} />
      <div className="rb-workbench-grid">
        <section className="rb-panel rb-priority-panel">
          <header className="rb-panel__head">
            <div><h2>Approved role access</h2><p>Work approved roles deeply; non-approved roles stay single-submit only until WeKruit reviews your application.</p></div>
            <button type="button" className="rb-panel__link" onClick={onRoles}>All roles</button>
          </header>
          <div className="rb-slot-meter">
            <strong>{primaryRoleIds.length}/{APPROVED_ROLE_LIMIT} approved roles</strong>
            <span>{pendingApplications.length}/3 pending applications · {SINGLE_SUBMISSION_WEEKLY_LIMIT} single submissions per rolling week outside approved roles.</span>
          </div>
          <div className="rb-priority-table">
            <div className="rb-priority-table__head">
              <span>Role</span>
              <span>Reward</span>
              <span>Location</span>
              <span>Checks</span>
              <span>Signal</span>
              <span>Access</span>
            </div>
            {priorityJobs.map((job) => (
              <PriorityRoleRow
                key={job.jobId}
                job={job}
                sourcedCount={sourcedCandidates.filter((c) => c.inboundJobId === roleKey(job) || c.jobId === roleKey(job)).length}
                submissionCount={submissions.filter((s) => s.inboundJobId === roleKey(job) || s.jobId === roleKey(job)).length}
                primary={isPrimaryRole(job, primaryRoleIds)}
                application={latestRoleApplication(job, roleApplications)}
                onAccess={onAccess}
              />
            ))}
            {jobs.length === 0 && <p className="rb-empty">No active collab roles right now.</p>}
          </div>
        </section>
        <section className="rb-panel rb-pipeline-panel">
          <header className="rb-panel__head">
            <div><h2>Candidate pipeline</h2><p>Sourcing through submitted status in one view.</p></div>
            <button type="button" className="rb-panel__link" onClick={onCandidates}>All candidates</button>
          </header>
          <div className="rb-pipeline">
            {pipeline.map((lane) => (
              <div className={`rb-pipeline__lane is-${lane.tone}`} key={lane.label}>
                <header><span>{lane.label}</span><strong>{lane.items.length}</strong></header>
                <div>
                  {lane.items.slice(0, 4).map((item) => <PipelineCard key={item.id} item={item} />)}
                  {lane.items.length === 0 && <p className="rb-pipeline__empty">No candidates</p>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="rb-panel rb-command-panel">
        <header className="rb-panel__head">
          <div><h2>Today&apos;s work queue</h2><p>Ranked by candidate readiness, WeKruit blockers, and role-market signal.</p></div>
          <button type="button" className="rb-panel__link" onClick={onMatches}>Open matchboard</button>
        </header>
        <div className="rb-command-list">
          {workItems.map((item) => (
            <article className={`rb-command-item is-${item.tone}`} key={item.title}>
              <span>{item.label}</span>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
              <button
                type="button"
                className="rb-panel__link"
                onClick={item.action === "roles" ? onRoles : item.action === "submissions" ? onSubmissions : item.action === "matches" ? onMatches : onCandidates}
              >
                {item.cta}
              </button>
            </article>
          ))}
        </div>
      </section>
      <section className="rb-panel rb-market-panel">
        <header className="rb-panel__head">
          <div><h2>Role market pulse</h2><p>Platform signal from recruiter activity, feedback, and unanswered role questions.</p></div>
          <button type="button" className="rb-panel__link" onClick={onRoles}>Open role command</button>
        </header>
        <div className="rb-market-grid">
          {marketPulse.map((item) => (
            <article className={`rb-market-card is-${item.tone}`} key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="rb-panel rb-feedback-panel">
        <header className="rb-panel__head">
          <div><h2>Feedback &amp; calibration</h2><p>Hiring-team notes and next actions for tighter submissions.</p></div>
          <button type="button" className="rb-panel__link" onClick={onSubmissions}>Open submissions</button>
        </header>
        <div className="rb-feedback-grid">
          <div className="rb-feedback-table">
            {feedback.map((s) => <FeedbackLine key={s.id} submission={s} />)}
            {feedback.length === 0 && <p className="rb-empty">No written feedback yet. Submit candidates and WeKruit notes will appear here.</p>}
          </div>
          <aside className="rb-next-action">
            <span>Next action</span>
            <strong>{sourcedCandidates.length ? "Move ready candidates into role briefs" : "Start a sourcing shortlist"}</strong>
            <p>
              {sourcedCandidates.length
                ? "Use the Candidates tab to keep prospects warm, then open the matching role brief when they are ready to submit."
                : "Save prospects before submission so your workbench has a real pipeline, not just final submissions."}
            </p>
            <button type="button" className="rb-btn" onClick={onCandidates}>Open candidate CRM</button>
          </aside>
        </div>
      </section>
    </div>
  )
}

function RecruiterLaunchSequence({
  model,
  onAction,
}: {
  model: RecruiterLaunchModel
  onAction: (action: RecruiterCockpitAction) => void
}) {
  return (
    <section className="rb-panel rb-launch-sequence">
      <div className={`rb-launch-sequence__mission is-${model.nextItem.tone}`}>
        <span>First marketplace loop</span>
        <strong>{model.completed}/{model.total} activated</strong>
        <p>{model.nextItem.complete ? "Your first recruiter loop is active. Keep using feedback to tighten the next shortlist." : `${model.nextItem.title}: ${model.nextItem.body}`}</p>
        <button type="button" onClick={() => onAction(model.nextItem.action)}>{model.nextItem.cta}</button>
      </div>
      <div className="rb-launch-sequence__steps">
        {model.items.map((item) => (
          <button
            type="button"
            className={`is-${item.tone}${item.complete ? " is-complete" : item === model.nextItem ? " is-next" : ""}`}
            key={item.label}
            onClick={() => onAction(item.action)}
          >
            <span>{item.label}</span>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
            <em>{item.complete ? "Complete" : item === model.nextItem ? "Next" : "Queued"}</em>
          </button>
        ))}
      </div>
    </section>
  )
}

function RecruiterOverviewInboxPanel({
  summary,
  lanes,
  items,
  onInbox,
  onAction,
}: {
  summary: ReturnType<typeof buildRecruiterInboxSummary>
  lanes: RecruiterInboxTriageLane[]
  items: RecruiterInboxItem[]
  onInbox: () => void
  onAction: (action: RecruiterInboxAction) => void
}) {
  return (
    <section className="rb-panel rb-overview-inbox" aria-label="Recruiter operating inbox">
      <header className="rb-panel__head">
        <div>
          <h2>Operating inbox</h2>
          <p>Owner, urgency, and learning signal for the next recruiter move before opening any tab.</p>
        </div>
        <button type="button" className="rb-panel__link" onClick={onInbox}>Open full inbox</button>
      </header>

      <div className="rb-overview-inbox__lead">
        <article className={summary.needsAction ? "is-warn" : "is-success"}>
          <span>Needs action</span>
          <strong>{summary.needsAction}</strong>
          <p>Recruiter-owned work, unread alerts, ready candidates, follow-ups, and open questions.</p>
        </article>
        <article className={summary.followUpDue ? "is-warn" : "is-mute"}>
          <span>Follow-ups due</span>
          <strong>{summary.followUpDue}</strong>
          <p>Prospects that need a touch before the candidate lane goes cold.</p>
        </article>
        <article className={summary.openQuestions ? "is-warn" : "is-success"}>
          <span>Open questions</span>
          <strong>{summary.openQuestions}</strong>
          <p>Role-calibration questions that should shape the next shortlist.</p>
        </article>
      </div>

      <div className="rb-overview-inbox__grid">
        <div className="rb-overview-inbox__lanes" aria-label="Inbox triage lanes">
          {lanes.map((lane) => (
            <button type="button" className={`is-${lane.tone}`} key={lane.label} onClick={() => onAction(lane.action)}>
              <span>{lane.label}</span>
              <strong>{lane.value}</strong>
              <p>{lane.body}</p>
              <em>{lane.item ? `${recruiterInboxOwner(lane.item).label} · ${recruiterInboxClock(lane.item).label}` : lane.cta}</em>
            </button>
          ))}
        </div>

        <aside className="rb-overview-inbox__feed">
          <header>
            <span>Next three</span>
            <strong>{items.length ? "Do these first" : "No live inbox work"}</strong>
          </header>
          {items.map((item) => {
            const owner = recruiterInboxOwner(item)
            const clock = recruiterInboxClock(item)
            return (
              <button type="button" className={`is-${item.tone}`} key={item.id} onClick={() => onAction(item.action)}>
                <span>{item.bucket}</span>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
                <em>{owner.label} · {clock.label} · {recruiterInboxAgeLabel(item)}</em>
              </button>
            )
          })}
          {items.length === 0 && (
            <button type="button" className="is-mute" onClick={onInbox}>
              <span>Inbox empty</span>
              <strong>Start the feedback loop</strong>
              <p>Save candidates, ask role questions, or submit a clean packet to create operating signal.</p>
              <em>Open full inbox</em>
            </button>
          )}
        </aside>
      </div>
    </section>
  )
}

function RecruiterCockpit({
  model,
  onAction,
}: {
  model: RecruiterCockpitModel
  onAction: (action: RecruiterCockpitAction) => void
}) {
  const candidate = model.focusCandidate
  const submission = model.focusSubmission
  const role = model.focusRole
  const candidateRoleLabel = model.focusCandidateRoleLabel ?? "Private bench"
  return (
    <section className="rb-panel rb-cockpit">
      <div className={`rb-cockpit__mission is-${model.missionTone}`}>
        <span>{model.missionLabel}</span>
        <strong>{model.missionTitle}</strong>
        <p>{model.missionBody}</p>
        <button type="button" onClick={() => onAction(model.missionAction)}>{model.missionCta}</button>
      </div>

      <div className="rb-cockpit__focus">
        <article className={role ? `is-${role.tone}` : "is-mute"}>
          <span>Focus role</span>
          <strong>{role?.job.title ?? "No live role selected"}</strong>
          <p>{role ? `${role.urgency} · ${role.marketLoad} · ${role.nextAction}` : "Open the role marketplace when WeKruit releases collab roles."}</p>
          {role ? <Link to={`/recruiters/job/${role.job.jobId}`}>Open brief</Link> : <button type="button" onClick={() => onAction("roles")}>Browse roles</button>}
        </article>
        <article className={candidate ? `is-${sourceStageMeta(candidate.stage).tone}` : "is-mute"}>
          <span>Focus candidate</span>
          <strong>{candidate ? candidateName(candidate) : "No bench candidate"}</strong>
          <p>
            {candidate
              ? `${sourceStageMeta(candidate.stage).label} · ${candidateRoleLabel}`
              : "Save a prospect to create a private bench before formal submission."}
          </p>
          <button type="button" onClick={() => onAction(candidate ? "matches" : "candidates")}>{candidate ? "Match candidate" : "Add candidate"}</button>
        </article>
        <article className={submission ? `is-${statusMeta(submission.status).tone}` : "is-mute"}>
          <span>Submission signal</span>
          <strong>{submission?.candidate?.name || "No submission yet"}</strong>
          <p>
            {submission
              ? `${statusMeta(submission.status).label} · ${submissionNextAction(submission.status).title}`
              : "Submit from a role brief after the candidate confirms consent."}
          </p>
          <button type="button" onClick={() => onAction("submissions")}>{submission ? "Track status" : "Open tracker"}</button>
        </article>
      </div>

      <div className="rb-cockpit__steps" aria-label="Recruiter marketplace loop">
        {model.steps.map((step) => (
          <button type="button" className={`is-${step.tone}`} key={step.label} onClick={() => onAction(step.action)}>
            <span>{step.label}</span>
            <strong>{step.value}</strong>
            <em>{step.body}</em>
          </button>
        ))}
      </div>
    </section>
  )
}

function RecruiterInboxTab({
  jobs,
  submissions,
  sourcedCandidates,
  roleFeedback,
  roleQuestions,
  notifications,
  onRoles,
  onCandidates,
  onSubmissions,
  onMatches,
  onEarnings,
  onMarkAllNotificationsRead,
}: {
  jobs: CollabJob[]
  submissions: RecruiterSubmissionItem[]
  sourcedCandidates: RecruiterSourcedCandidateItem[]
  roleFeedback: RecruiterRoleFeedbackItem[]
  roleQuestions: RecruiterRoleQuestionItem[]
  notifications: RecruiterNotificationItem[]
  onRoles: () => void
  onCandidates: () => void
  onSubmissions: () => void
  onMatches: () => void
  onEarnings: () => void
  onMarkAllNotificationsRead: () => void
}) {
  const items = useMemo(
    () => buildRecruiterInboxItems(jobs, submissions, sourcedCandidates, roleFeedback, roleQuestions, notifications),
    [jobs, notifications, roleFeedback, roleQuestions, sourcedCandidates, submissions],
  )
  const summary = buildRecruiterInboxSummary(submissions, sourcedCandidates, roleQuestions, notifications)
  const urgentItems = items.filter((item) => item.priority >= 80)
  const waitingItems = items.filter((item) => item.bucket === "Waiting on feedback" || item.bucket === "Under review" || item.bucket === "WeKruit answer needed")
  const learningItems = items.filter((item) =>
    item.bucket.includes("Feedback") ||
    item.bucket.includes("calibration") ||
    item.bucket.includes("Market") ||
    item.bucket.includes("answer"),
  )
  const unreadNotifications = notifications.filter((notification) => !notification.readAt)
  const topItem = items[0]
  const triageLanes = buildRecruiterInboxTriage(items)
  const dispatch = (action: RecruiterInboxAction) => {
    if (action === "roles") onRoles()
    else if (action === "submissions") onSubmissions()
    else if (action === "matches") onMatches()
    else if (action === "earnings") onEarnings()
    else onCandidates()
  }

  return (
    <section className="rb-panel rb-panel--fill rb-inbox">
      <header className="rb-panel__head">
        <div>
          <h2>Recruiter inbox</h2>
          <p>One operating queue for feedback, candidate calibration, role questions, and status movement.</p>
        </div>
        <button type="button" className="rb-panel__link" onClick={onSubmissions}>Submission tracker</button>
      </header>

      <section className="rb-inbox-hero">
        <article className={summary.needsAction ? "is-warn" : "is-success"}>
          <span>Needs action</span>
          <strong>{summary.needsAction}</strong>
          <p>Follow-ups, ready candidates, rejection feedback, calibration notes, and open role questions.</p>
        </article>
        <article className={summary.activeSubmissions ? "is-live" : "is-mute"}>
          <span>Active submissions</span>
          <strong>{summary.activeSubmissions}</strong>
          <p>Candidates still moving through WeKruit review or hiring-team stages.</p>
        </article>
        <article className={summary.followUpDue ? "is-warn" : "is-mute"}>
          <span>Follow-ups due</span>
          <strong>{summary.followUpDue}</strong>
          <p>Prospects needing outreach before they go cold.</p>
        </article>
        <article className={summary.openQuestions ? "is-warn" : "is-success"}>
          <span>Open questions</span>
          <strong>{summary.openQuestions}</strong>
          <p>Role-calibration questions waiting on a WeKruit answer.</p>
        </article>
        <article className={summary.unreadNotifications ? "is-live" : "is-mute"}>
          <span>Unread alerts</span>
          <strong>{summary.unreadNotifications}</strong>
          <p>New roles, application decisions, and feedback notices pushed into this workspace.</p>
        </article>
      </section>

      <section className="rb-inbox-triage" aria-label="Recruiter inbox ownership triage">
        {triageLanes.map((lane) => (
          <button type="button" className={`is-${lane.tone}`} key={lane.label} onClick={() => dispatch(lane.action)}>
            <span>{lane.label}</span>
            <strong>{lane.value}</strong>
            <p>{lane.body}</p>
            <em>{lane.item ? `${recruiterInboxOwner(lane.item).label} · ${recruiterInboxClock(lane.item).label}` : lane.cta}</em>
          </button>
        ))}
      </section>

      <section className="rb-inbox-grid">
        <div className="rb-inbox-feed">
          <header>
            <h3>Action feed</h3>
            <p>Sorted by the next move most likely to prevent wasted sourcing.</p>
          </header>
          {unreadNotifications.length > 0 && (
            <div className="rb-notification-strip">
              <div>
                <strong>{unreadNotifications.length} unread platform alert{unreadNotifications.length === 1 ? "" : "s"}</strong>
                <p>Mark them read after you review the feed.</p>
              </div>
              <button type="button" onClick={onMarkAllNotificationsRead}>Mark all read</button>
            </div>
          )}
          <div className="rb-inbox-list">
            {items.slice(0, 12).map((item) => (
              <RecruiterInboxItemCard key={item.id} item={item} onAction={dispatch} />
            ))}
            {items.length === 0 && (
              <div className="rb-inbox-empty">
                <strong>No recruiter activity yet</strong>
                <p>Save sourced candidates, ask role questions, or submit candidates to start the feedback loop.</p>
                <button type="button" onClick={onCandidates}>Open candidate CRM</button>
              </div>
            )}
          </div>
        </div>

        <aside className="rb-inbox-side">
          <article className={`rb-inbox-next ${topItem ? `is-${topItem.tone}` : "is-mute"}`}>
            <span>Next best move</span>
            <strong>{topItem?.title ?? "Build your first sourcing lane"}</strong>
            <p>{topItem?.body ?? "Create a sourced candidate record before formal submission so WeKruit can track duplicates, calibration, and status."}</p>
            <button type="button" onClick={() => topItem ? dispatch(topItem.action) : onCandidates()}>
              {topItem?.cta ?? "Open candidate CRM"}
            </button>
          </article>

          <article>
            <h3>Urgent work</h3>
            {urgentItems.slice(0, 4).map((item) => (
              <button type="button" key={item.id} onClick={() => dispatch(item.action)}>
                <strong>{item.bucket}</strong>
                <span>{item.title}</span>
              </button>
            ))}
            {urgentItems.length === 0 && <p>No urgent recruiter action right now.</p>}
          </article>

          <article>
            <h3>Waiting room</h3>
            <p>{waitingItems.length} item{waitingItems.length === 1 ? "" : "s"} currently depend on WeKruit review or answers.</p>
            <button type="button" onClick={onSubmissions}>Track submitted candidates</button>
          </article>

          <article>
            <h3>Learning loop</h3>
            <p>{learningItems.length} signal{learningItems.length === 1 ? "" : "s"} can improve your next submission.</p>
            <button type="button" onClick={onMatches}>Apply to matchboard</button>
          </article>
        </aside>
      </section>
    </section>
  )
}

function RecruiterInboxItemCard({
  item,
  onAction,
}: {
  item: RecruiterInboxItem
  onAction: (action: RecruiterInboxAction) => void
}) {
  const owner = recruiterInboxOwner(item)
  const clock = recruiterInboxClock(item)
  return (
    <article className={`rb-inbox-item is-${item.tone}`}>
      <div>
        <span>{item.bucket}</span>
        <strong>{item.title}</strong>
        <p>{item.body}</p>
        <div className="rb-inbox-item__badges" aria-label="Inbox item ownership and review clock">
          <small className={`is-${owner.tone}`}>{owner.label}</small>
          <small className={`is-${clock.tone}`}>{clock.label}</small>
          <small>{recruiterInboxAgeLabel(item)}</small>
        </div>
        <em>{item.meta}</em>
      </div>
      <footer>
        <button type="button" onClick={() => onAction(item.action)}>{item.cta}</button>
        {item.href && <Link to={item.href}>Open role</Link>}
      </footer>
    </article>
  )
}

function RecruiterOperatingPanel({
  metrics,
  onPerformance,
}: {
  metrics: RecruiterOperatingMetrics
  onPerformance: () => void
}) {
  return (
    <section className="rb-panel rb-operating-panel">
      <header className="rb-panel__head">
        <div>
          <h2>Recruiter operating scorecard</h2>
          <p>Status, quality signal, and weekly pace for earning more trusted role access.</p>
        </div>
        <button type="button" className="rb-panel__link" onClick={onPerformance}>Open performance</button>
      </header>
      <div className="rb-operating-grid">
        <article className={`rb-operating-card rb-operating-card--lead is-${metrics.statusTone}`}>
          <span>Current track</span>
          <strong>{metrics.statusLabel}</strong>
          <p>{metrics.statusBody}</p>
        </article>
        {metrics.cards.slice(1).map((card) => (
          <article className={`rb-operating-card is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
          </article>
        ))}
        <article className={`rb-operating-card rb-operating-card--challenge is-${metrics.reviewTone}`}>
          <span>Activity review</span>
          <strong>{metrics.reviewLabel}</strong>
          <p>{metrics.reviewBody}</p>
        </article>
      </div>
    </section>
  )
}

type PipelineItem = {
  id: string
  name: string
  title: string
  company: string
  age: string
  kind: "source" | "submission"
  href?: string
}

function buildCandidatePipeline(
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  submissions: RecruiterSubmissionItem[],
) {
  const sourced = sourcedCandidates
    .filter((c) => ["sourced", "contacted", "screened"].includes(c.stage))
    .map(sourceToPipelineItem)
  const ready = sourcedCandidates.filter((c) => c.stage === "ready").map(sourceToPipelineItem)
  const submitted = submissions
    .filter((s) => ["submitted", "new"].includes(s.status ?? "submitted"))
    .map(submissionToPipelineItem)
  const reviewing = submissions.filter((s) => s.status === "reviewing" || s.status === "backburner").map(submissionToPipelineItem)
  const interviewing = submissions
    .filter((s) => ADVANCED_STATUSES.includes(s.status ?? ""))
    .map(submissionToPipelineItem)
  return [
    { label: "Sourced", tone: "mute", items: sourced },
    { label: "Ready", tone: "live", items: ready },
    { label: "Submitted", tone: "info", items: submitted },
    { label: "In review", tone: "warn", items: reviewing },
    { label: "Interviewing", tone: "success", items: interviewing },
  ]
}

function buildRecruiterWorkQueue(
  jobs: CollabJob[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  submissions: RecruiterSubmissionItem[],
  roleQuestions: RecruiterRoleQuestionItem[],
  roleIntelligence: RecruiterRoleIntelligenceItem[],
) {
  const readyCandidates = sourcedCandidates.filter((c) => c.stage === "ready")
  const newRoles = jobs.filter(isNewRole)
  const feedbackRows = submissions.filter(submissionHasStructuredFeedback)
  const pending = submissions.filter(submissionIsConfirmedActiveReview)
  const openQuestions = roleQuestions.filter((q) => (q.status ?? "open") === "open")
  const blockedRoles = roleIntelligence.filter((item) => item.feedback.blocked > 0 || item.feedback.hard > 0)
  const noSubmissionRoles = jobs.filter((job) => (roleIntelligence.find((item) => item.jobId === roleKey(job))?.submissionCount ?? 0) === 0)

  const items: Array<{
    label: string
    title: string
    body: string
    cta: string
    action: "roles" | "submissions" | "matches" | "candidates"
    tone: "live" | "info" | "success" | "warn" | "mute"
  }> = []

  if (readyCandidates.length > 0) {
    items.push({
      label: "Submit next",
      title: `${readyCandidates.length} ready candidate${readyCandidates.length === 1 ? "" : "s"}`,
      body: "Use the matchboard to choose the strongest open role before sending another formal submission.",
      cta: "Match candidates",
      action: "matches",
      tone: "live",
    })
  }

  if (openQuestions.length > 0) {
    const oldest = openQuestions
      .map((q) => timestampValueMs(q.createdAt ?? q.updatedAt))
      .filter((ms) => ms > 0)
      .sort((a, b) => a - b)[0]
    const oldestLabel = oldest ? formatCandidateAge(new Date(oldest).toISOString()).toLowerCase() : null
    items.push({
      label: "WeKruit answer needed",
      title: `${openQuestions.length} open role question${openQuestions.length === 1 ? "" : "s"}`,
      body: oldestLabel
        ? `Oldest unanswered question opened ${oldestLabel}. Use role command before sourcing through uncertainty.`
        : "A role has unanswered calibration questions. Clear those before investing more sourcing cycles.",
      cta: "Open role command",
      action: "roles",
      tone: "warn",
    })
  }

  if (blockedRoles.length > 0) {
    items.push({
      label: "Market friction",
      title: `${blockedRoles.length} hard or blocked role${blockedRoles.length === 1 ? "" : "s"}`,
      body: "Recruiter feedback says these searches need sharper comp, location, or requirement calibration before more volume.",
      cta: "Review roles",
      action: "roles",
      tone: "warn",
    })
  }

  if (items.length < 3 && feedbackRows.length > 0) {
    items.push({
      label: "Calibration",
      title: `${feedbackRows.length} feedback note${feedbackRows.length === 1 ? "" : "s"}`,
      body: "Read WeKruit notes before continuing the same search or sourcing lookalikes.",
      cta: "Review submissions",
      action: "submissions",
      tone: "info",
    })
  }

  if (items.length < 3 && noSubmissionRoles.length > 0) {
    items.push({
      label: "White space",
      title: `${noSubmissionRoles.length} role${noSubmissionRoles.length === 1 ? "" : "s"} with no submissions`,
      body: "These roles still have a clean lane. Pick one with clear hard checks and build a sourced shortlist.",
      cta: "Browse roles",
      action: "roles",
      tone: "info",
    })
  }

  if (items.length < 3) {
    items.push({
      label: "Start here",
      title: sourcedCandidates.length ? "Move prospects to ready" : "Build a sourced shortlist",
      body: sourcedCandidates.length
        ? "Screen saved prospects, mark the strongest as ready, then submit from the role brief."
        : "Save LinkedIn or resume links before submitting so duplicate and status tracking can work.",
      cta: "Open candidate CRM",
      action: "candidates",
      tone: "live",
    })
  }

  if (items.length < 3) {
    items.push({
      label: "Role supply",
      title: newRoles.length ? `${newRoles.length} new role${newRoles.length === 1 ? "" : "s"} this week` : `${jobs.length} open roles`,
      body: "Filter the marketplace before sourcing so you do not waste effort on weak-fit roles.",
      cta: "Browse roles",
      action: "roles",
      tone: "info",
    })
  }

  if (items.length < 3) {
    items.push({
      label: "Review load",
      title: pending.length ? `${pending.length} pending review` : "No pending submissions",
      body: pending.length
        ? "Wait for feedback if you are close to the pending limit on a role."
        : "You have room to submit once a candidate has confirmed consent.",
      cta: "Open submissions",
      action: "submissions",
      tone: pending.length ? "warn" : "success",
    })
  }

  return items.slice(0, 3)
}

function buildMarketPulse(
  jobs: CollabJob[],
  roleQuestions: RecruiterRoleQuestionItem[],
  roleIntelligence: RecruiterRoleIntelligenceItem[],
) {
  const intelligenceByJob = new Map(roleIntelligence.map((item) => [item.jobId, item]))
  const openQuestions = roleQuestions.filter((q) => (q.status ?? "open") === "open")
  const hardOrBlocked = roleIntelligence.filter((item) => item.feedback.hard > 0 || item.feedback.blocked > 0)
  const whiteSpaceRoles = jobs.filter((job) => (intelligenceByJob.get(roleKey(job))?.submissionCount ?? 0) === 0)
  const readyAcrossMarket = roleIntelligence.reduce((sum, item) => sum + item.readyCount, 0)
  const recruiterRolePairs = roleIntelligence.reduce((sum, item) => sum + item.recruiterCount, 0)
  const hasNetworkMotion = readyAcrossMarket > 0 || recruiterRolePairs > 0
  return [
    {
      label: "Open questions",
      value: String(openQuestions.length),
      body: openQuestions.length
        ? "Role calibration is waiting on WeKruit answers."
        : "No unanswered role questions from your account.",
      tone: openQuestions.length ? "warn" : "success",
    },
    {
      label: "Hard searches",
      value: String(hardOrBlocked.length),
      body: hardOrBlocked.length
        ? "Recruiter feedback shows market friction on these roles."
        : "No hard or blocked market feedback yet.",
      tone: hardOrBlocked.length ? "warn" : "info",
    },
    {
      label: "Clean lanes",
      value: String(whiteSpaceRoles.length),
      body: whiteSpaceRoles.length
        ? "Open roles still have no recruiter-board submissions."
        : "Every open role has at least one submission signal.",
      tone: whiteSpaceRoles.length ? "live" : "info",
    },
    {
      label: "Network motion",
      value: hasNetworkMotion ? `${readyAcrossMarket}/${recruiterRolePairs}` : "0",
      body: hasNetworkMotion
        ? "Ready candidates over active recruiter-role lanes across the board."
        : "No recruiter-role lanes have market activity yet.",
      tone: readyAcrossMarket ? "live" : "mute",
    },
  ] as const
}

type RecruiterInboxItem = {
  id: string
  bucket: string
  title: string
  body: string
  meta: string
  tone: RecruiterInboxTone
  priority: number
  atMs: number
  cta: string
  action: RecruiterInboxAction
  href?: string
}

function recruiterInboxOwner(item: RecruiterInboxItem): RecruiterInboxOwnerMeta {
  const bucket = item.bucket.toLowerCase()
  if (bucket.includes("waiting on feedback") || bucket.includes("under review") || bucket.includes("answer needed")) {
    return {
      id: "wekruit",
      label: "WeKruit owns next",
      body: "Waiting on WeKruit review, answer, or status movement.",
      tone: "info",
    }
  }
  if (bucket.includes("interview motion")) {
    return {
      id: "hiring_team",
      label: "Hiring team owns next",
      body: "Candidate is moving after WeKruit handoff.",
      tone: "success",
    }
  }
  if (bucket.includes("candidate confirmation")) {
    return {
      id: "candidate",
      label: "Candidate owns next",
      body: "Candidate confirmation is required before the packet can move.",
      tone: "warn",
    }
  }
  if (bucket.includes("unread") || bucket.includes("role alert") || bucket.includes("payout update") || bucket.includes("access decision")) {
    return {
      id: "platform",
      label: "Platform signal",
      body: "A WeKruit system alert should be reviewed.",
      tone: item.tone === "live" ? "live" : "info",
    }
  }
  return {
    id: "recruiter",
    label: "Recruiter owns next",
    body: "Your action can unblock this item.",
    tone: item.priority >= 80 ? "warn" : "live",
  }
}

function recruiterInboxAgeLabel(item: RecruiterInboxItem): string {
  if (!item.atMs) return "No timestamp"
  const ageDays = Math.max(0, Math.floor((Date.now() - item.atMs) / 86_400_000))
  if (ageDays === 0) return "Today"
  if (ageDays === 1) return "1d old"
  return `${ageDays}d old`
}

function recruiterInboxClock(item: RecruiterInboxItem): RecruiterInboxClock {
  if (!item.atMs) return { label: "Review clock unknown", tone: "mute", stale: false }
  const owner = recruiterInboxOwner(item)
  const ageDays = Math.max(0, Math.floor((Date.now() - item.atMs) / 86_400_000))
  if (owner.id === "recruiter") {
    if (item.priority >= 90) return { label: "Act now", tone: "warn", stale: true }
    if (ageDays >= 2) return { label: "Getting stale", tone: "warn", stale: true }
    return { label: "Actionable", tone: "live", stale: false }
  }
  if (owner.id === "candidate") {
    if (ageDays >= 3) return { label: "Nudge candidate", tone: "warn", stale: true }
    return { label: "Awaiting candidate", tone: "info", stale: false }
  }
  if (owner.id === "wekruit") {
    if (ageDays >= 4) return { label: "Escalation watch", tone: "warn", stale: true }
    return { label: "Waiting on WeKruit", tone: "info", stale: false }
  }
  if (owner.id === "hiring_team") {
    if (ageDays >= 7) return { label: "Hiring team stale", tone: "warn", stale: true }
    return { label: "Hiring team active", tone: "success", stale: false }
  }
  return item.tone === "live"
    ? { label: "Unread", tone: "live", stale: item.priority >= 90 }
    : { label: "Logged", tone: "mute", stale: false }
}

function buildRecruiterInboxTriage(items: RecruiterInboxItem[]): RecruiterInboxTriageLane[] {
  const recruiterOwned = items.filter((item) => recruiterInboxOwner(item).id === "recruiter")
  const waiting = items.filter((item) => {
    const owner = recruiterInboxOwner(item).id
    return owner === "wekruit" || owner === "hiring_team"
  })
  const stale = items.filter((item) => recruiterInboxClock(item).stale)
  const learning = items.filter((item) => {
    const bucket = item.bucket.toLowerCase()
    return bucket.includes("feedback") || bucket.includes("calibration") || bucket.includes("answer")
  })
  const laneFor = (
    label: string,
    rows: RecruiterInboxItem[],
    emptyBody: string,
    defaultAction: RecruiterInboxAction,
    cta: string,
    tone: RecruiterInboxTone,
  ): RecruiterInboxTriageLane => {
    const item = rows[0]
    return {
      label,
      value: String(rows.length),
      body: item ? `${item.bucket}: ${item.title}` : emptyBody,
      action: item?.action ?? defaultAction,
      cta,
      tone: item ? tone : "mute",
      item,
    }
  }
  return [
    laneFor("Recruiter next", recruiterOwned, "No recruiter-owned blockers.", "candidates", "Open next task", "live"),
    laneFor("Waiting room", waiting, "No WeKruit or hiring-team waits.", "submissions", "Track waits", "info"),
    laneFor("Stale risk", stale, "No stale recruiter-board items.", "submissions", "Review risk", "warn"),
    laneFor("Learning loop", learning, "No calibration signal yet.", "matches", "Apply signal", "success"),
  ]
}

function rolePathForRow(row: { inboundJobId?: string; jobId?: string }, candidateId?: string): string | undefined {
  const id = row.inboundJobId || row.jobId
  if (!id) return undefined
  const suffix = candidateId ? `?candidateId=${encodeURIComponent(candidateId)}` : ""
  return `/recruiters/job/${encodeURIComponent(id)}${suffix}`
}

function rowRoleLabel(row: { jobTitleSnapshot?: string; companyLabelSnapshot?: string; inboundJobId?: string; jobId?: string }, jobsById: Map<string, CollabJob>): string {
  const id = row.inboundJobId || row.jobId || ""
  const job = jobsById.get(id)
  const title = row.jobTitleSnapshot || job?.title || "Private bench"
  const company = row.companyLabelSnapshot || job?.recruiterBoard.label.company
  return company ? `${title} · ${company}` : title
}

function buildRecruiterInboxSummary(
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  roleQuestions: RecruiterRoleQuestionItem[],
  notifications: RecruiterNotificationItem[],
) {
  const feedbackNotes = submissions.filter(submissionHasStructuredFeedback).length
  const rejectedWithFeedback = submissions.filter((submission) =>
    CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? "") && submissionHasStructuredFeedback(submission),
  ).length
  const candidateConfirmationNeeds = submissions.filter(candidateConfirmationCanResend).length
  const readyCandidates = sourcedCandidates.filter((candidate) => candidate.stage === "ready").length
  const calibrationNeeds = sourcedCandidates.filter((candidate) =>
    candidate.calibrationStatus === "bad_fit" ||
    candidate.calibrationStatus === "calibration_requested" ||
    Boolean(candidate.calibrationNote),
  ).length
  const followUpDue = sourcedCandidates.filter((candidate) => candidateFollowUpState(candidate).needsAction).length
  const openQuestions = roleQuestions.filter((question) => (question.status ?? "open") === "open").length
  const activeSubmissions = submissions.filter(submissionIsConfirmedOpen).length
  const unreadNotifications = notifications.filter((notification) => !notification.readAt).length
  return {
    needsAction: rejectedWithFeedback + candidateConfirmationNeeds + readyCandidates + calibrationNeeds + followUpDue + openQuestions + unreadNotifications,
    feedbackNotes,
    candidateConfirmationNeeds,
    followUpDue,
    readyCandidates,
    openQuestions,
    activeSubmissions,
    unreadNotifications,
  }
}

function buildRecruiterInboxItems(
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  roleFeedback: RecruiterRoleFeedbackItem[],
  roleQuestions: RecruiterRoleQuestionItem[],
  notifications: RecruiterNotificationItem[],
): RecruiterInboxItem[] {
  const jobsById = new Map(jobs.map((job) => [roleKey(job), job]))
  const items: RecruiterInboxItem[] = []
  const notifiedAnsweredQuestionIds = new Set(
    notifications
      .filter((notification) => notification.type === "role_question_answer")
      .flatMap((notification) => [notification.entityId, notification.notificationId, notification.id])
      .filter((id): id is string => Boolean(id)),
  )

  for (const notification of notifications) {
    const unread = !notification.readAt
    const roleId = notification.publicJobId || notification.jobId
    const href = roleId
      ? `/recruiters/job/${encodeURIComponent(roleId)}${notification.type === "candidate_calibration" && notification.entityId ? `?candidateId=${encodeURIComponent(notification.entityId)}` : ""}`
      : undefined
    const notificationMeta = recruiterNotificationInboxMeta(notification.type)
    items.push({
      id: `notification-${notification.id}`,
      bucket: unread ? notificationMeta.unreadBucket : notificationMeta.typeLabel,
      title: notification.title,
      body: notification.body,
      meta: [
        notification.roleTitle || notification.companyLabel || "",
        formatActivityDate(notification.createdAt ?? notification.updatedAt),
      ].filter(Boolean).join(" · "),
      tone: unread ? "live" : notificationMeta.readTone,
      priority: unread ? 98 : 38,
      atMs: notificationCreatedAtMs(notification),
      cta: notificationMeta.cta,
      action: notificationMeta.action,
      href,
    })
  }

  for (const submission of submissions) {
    const status = submission.status ?? "submitted"
    const meta = statusMeta(status)
    const nextAction = submissionNextAction(status)
    const atMs = timestampValueMs(submission.recruiterFeedbackUpdatedAt ?? submission.updatedAt ?? submission.createdAt)
    const candidate = submission.candidate?.name || "Submitted candidate"
    const roleLabel = rowRoleLabel(submission, jobsById)
    const closed = CLOSED_NEGATIVE_STATUSES.includes(status)
    const moving = ADVANCED_STATUSES.includes(status)
    const pending = ACTIVE_REVIEW_STATUSES.includes(status)

    if (candidateConfirmationCanResend(submission)) {
      const resendTone = submission.candidateConsentStatus === "pending_candidate_confirmation" ? "info" : "warn"
      items.push({
        id: `submission-confirmation-${submission.id}`,
        bucket: "Candidate confirmation",
        title: `${candidate} has not confirmed yet`,
        body: candidateConfirmationActionBody(submission),
        meta: `${roleLabel} · ${formatActivityDate(submission.candidateConfirmation?.sentAt ?? submission.updatedAt ?? submission.createdAt)}`,
        tone: resendTone,
        priority: resendTone === "warn" ? 96 : 84,
        atMs,
        cta: "Resend confirmation",
        action: "submissions",
      })
      continue
    }

    if (submissionHasStructuredFeedback(submission)) {
      const reasons = submissionFeedbackReasonLabels(submission)
      items.push({
        id: `submission-feedback-${submission.id}`,
        bucket: closed ? "Feedback to act on" : "Feedback landed",
        title: `${candidate} - ${meta.label}`,
        body: [
          submissionFeedbackRating(submission) ? `Rating ${submissionFeedbackRatingLabel(submission)}` : "",
          submission.recruiterFeedbackNote,
          reasons.length ? reasons.join(", ") : "",
        ].filter(Boolean).join(" · "),
        meta: `${roleLabel} · ${formatActivityDate(submission.recruiterFeedbackUpdatedAt ?? submission.updatedAt)}`,
        tone: closed ? "warn" : meta.tone,
        priority: closed ? 100 : 82,
        atMs,
        cta: "Review submission",
        action: "submissions",
        href: rolePathForRow(submission),
      })
      continue
    }

    if (closed) {
      items.push({
        id: `submission-closed-${submission.id}`,
        bucket: "Closed candidate",
        title: `${candidate} - ${meta.label}`,
        body: nextAction.body,
        meta: `${roleLabel} · ${formatActivityDate(submission.updatedAt ?? submission.createdAt)}`,
        tone: meta.tone,
        priority: 74,
        atMs,
        cta: "Review pipeline",
        action: "submissions",
      })
      continue
    }

    if (moving) {
      items.push({
        id: `submission-moving-${submission.id}`,
        bucket: "Interview motion",
        title: `${candidate} is ${meta.label.toLowerCase()}`,
        body: nextAction.body,
        meta: `${roleLabel} · ${formatActivityDate(submission.updatedAt ?? submission.createdAt)}`,
        tone: "success",
        priority: 78,
        atMs,
        cta: "Open role",
        action: "submissions",
        href: rolePathForRow(submission),
      })
      continue
    }

    if (pending) {
      const ageMs = Date.now() - (timestampValueMs(submission.createdAt) || Date.now())
      const oldPending = ageMs > 3 * 86_400_000
      items.push({
        id: `submission-pending-${submission.id}`,
        bucket: oldPending ? "Waiting on feedback" : "Under review",
        title: `${candidate} is ${meta.label.toLowerCase()}`,
        body: nextAction.body,
        meta: `${roleLabel} · submitted ${formatWhen(submission)}`,
        tone: oldPending ? "warn" : meta.tone,
        priority: oldPending ? 72 : 48,
        atMs,
        cta: "Track status",
        action: "submissions",
      })
    }
  }

  for (const candidate of sourcedCandidates) {
    if (candidate.stage === "archived" || candidate.stage === "submitted") continue
    const stage = sourceStageMeta(candidate.stage)
    const calibration = calibrationMeta(candidate.calibrationStatus)
    const atMs = timestampValueMs(candidate.calibrationUpdatedAt ?? candidate.updatedAt ?? candidate.createdAt)
    const roleLabel = rowRoleLabel(candidate, jobsById)
    const name = candidateName(candidate)
    const followUp = candidateFollowUpState(candidate)

    if (candidate.calibrationNote || candidate.calibrationStatus === "bad_fit" || candidate.calibrationStatus === "calibration_requested") {
      items.push({
        id: `candidate-calibration-${candidate.id}`,
        bucket: "Candidate calibration",
        title: `${name} - ${calibration.label}`,
        body: candidate.calibrationNote || "WeKruit marked this prospect for calibration. Adjust the profile before submitting.",
        meta: `${roleLabel} · ${formatActivityDate(candidate.calibrationUpdatedAt ?? candidate.updatedAt)}`,
        tone: calibration.tone,
        priority: candidate.calibrationStatus === "bad_fit" ? 96 : 84,
        atMs,
        cta: "Update candidate",
        action: "candidates",
        href: rolePathForRow(candidate, candidate.id),
      })
      continue
    }

    if (candidate.stage === "ready") {
      items.push({
        id: `candidate-ready-${candidate.id}`,
        bucket: "Ready to submit",
        title: `${name} is ready`,
        body: shortText(candidate.candidate?.notes, "Pick the best-fit role and submit only with candidate consent.", 140),
        meta: `${roleLabel} · ${formatActivityDate(candidate.updatedAt ?? candidate.createdAt)}`,
        tone: "live",
        priority: 90,
        atMs,
        cta: "Match role",
        action: "matches",
        href: rolePathForRow(candidate, candidate.id),
      })
      continue
    }

    if (followUp.needsAction) {
      items.push({
        id: `candidate-outreach-${candidate.id}`,
        bucket: "Follow-up due",
        title: `${name} - ${followUp.label}`,
        body: followUp.body,
        meta: `${roleLabel} · ${formatActivityDate(candidate.outreach?.nextFollowUpAt ?? candidate.updatedAt ?? candidate.createdAt)}`,
        tone: followUp.tone,
        priority: followUp.tone === "warn" ? 88 : 76,
        atMs: timestampValueMs(candidate.outreach?.nextFollowUpAt ?? candidate.updatedAt ?? candidate.createdAt),
        cta: "Open CRM",
        action: "candidates",
        href: rolePathForRow(candidate, candidate.id),
      })
      continue
    }

    if (candidate.stage === "screened" || candidate.stage === "contacted") {
      items.push({
        id: `candidate-followup-${candidate.id}`,
        bucket: "Pipeline follow-up",
        title: `${name} is ${stage.label.toLowerCase()}`,
        body: "Move this prospect to ready when compensation, interest, and hard filters are confirmed.",
        meta: `${roleLabel} · ${formatActivityDate(candidate.updatedAt ?? candidate.createdAt)}`,
        tone: stage.tone,
        priority: 42,
        atMs,
        cta: "Open CRM",
        action: "candidates",
      })
    }
  }

  for (const question of roleQuestions) {
    const open = (question.status ?? "open") === "open"
    const questionIds = [question.id, question.questionId].filter((id): id is string => Boolean(id))
    if (!open && questionIds.some((id) => notifiedAnsweredQuestionIds.has(id))) continue
    const atMs = timestampValueMs(question.answeredAt ?? question.updatedAt ?? question.createdAt)
    const roleLabel = rowRoleLabel(question, jobsById)
    items.push({
      id: `role-question-${question.id}`,
      bucket: open ? "WeKruit answer needed" : "Role answer returned",
      title: open ? "Role question is open" : "Role question answered",
      body: open
        ? question.question || "A role calibration question is waiting on WeKruit."
        : question.answer || question.question || "WeKruit answered this role calibration question.",
      meta: `${roleLabel} · ${formatActivityDate(question.updatedAt ?? question.createdAt)}`,
      tone: open ? "warn" : "info",
      priority: open ? 92 : 68,
      atMs,
      cta: open ? "Open question" : "Open answer",
      action: "roles",
      href: rolePathForRow(question),
    })
  }

  for (const feedback of roleFeedback) {
    if (feedback.difficulty !== "hard" && feedback.difficulty !== "blocked") continue
    const roleLabel = rowRoleLabel(feedback, jobsById)
    items.push({
      id: `role-feedback-${feedback.id}`,
      bucket: "Market blocker",
      title: `${roleFeedbackDifficultyText(feedback.difficulty)} role signal`,
      body: feedback.note || `${feedback.reasons.map((reason) => reason.replace(/_/g, " ")).join(", ") || "Recruiter market friction"} needs calibration before more volume.`,
      meta: `${roleLabel} · ${formatActivityDate(feedback.updatedAt ?? feedback.createdAt)}`,
      tone: feedback.difficulty === "blocked" ? "warn" : "info",
      priority: feedback.difficulty === "blocked" ? 86 : 64,
      atMs: timestampValueMs(feedback.updatedAt ?? feedback.createdAt),
      cta: "Review roles",
      action: "roles",
    })
  }

  return items.sort((a, b) => b.priority - a.priority || b.atMs - a.atMs)
}

function sourceToPipelineItem(c: RecruiterSourcedCandidateItem): PipelineItem {
  return {
    id: c.id,
    name: candidateName(c),
    title: c.candidate?.currentRole || "Candidate",
    company: c.jobTitleSnapshot || c.companyLabelSnapshot || "Saved prospect",
    age: formatCandidateAge(c.updatedAt ?? c.createdAt),
    kind: "source",
    href: c.inboundJobId ? `/recruiters/job/${encodeURIComponent(c.inboundJobId)}?candidateId=${encodeURIComponent(c.id)}` : undefined,
  }
}

function submissionToPipelineItem(s: RecruiterSubmissionItem): PipelineItem {
  return {
    id: s.id,
    name: s.candidate?.name || "Candidate",
    title: s.candidate?.currentRole || "Submitted candidate",
    company: s.jobTitleSnapshot || s.companyLabelSnapshot || "Submitted role",
    age: formatWhen(s),
    kind: "submission",
  }
}

function formatCandidateAge(raw: RecruiterSourcedCandidateItem["createdAt"]): string {
  const ms = timestampValueMs(raw)
  if (!ms) return "Today"
  const days = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000))
  if (days === 0) return "Today"
  if (days === 1) return "1d ago"
  return `${days}d ago`
}

function roleChecklistCounts(job: CollabJob) {
  const hard = job.recruiterBoard.checklist.groups.find((g) => g.kind === "hard")?.items.length ?? 0
  const fit = job.recruiterBoard.checklist.groups.find((g) => g.kind === "fit")?.items.length ?? 0
  return { hard, fit }
}

function roleFitSignal(job: CollabJob, sourcedCount: number, submissionCount: number) {
  const { hard, fit } = roleChecklistCounts(job)
  const base = Math.min(96, 52 + hard * 4 + fit * 2 + submissionCount * 8 + sourcedCount * 3)
  if (base >= 82) return { label: "High", percent: base, tone: "live" }
  if (base >= 68) return { label: "Medium", percent: base, tone: "warn" }
  return { label: "Good", percent: base, tone: "info" }
}

function roleReward(job: CollabJob): string {
  return roleRewardLabel(job)
}

type RoleInsightTone = "live" | "info" | "success" | "warn" | "mute"

type RoleInsight = {
  job: CollabJob
  score: number
  scoreLabel: string
  tone: RoleInsightTone
  urgency: string
  marketLoad: string
  nextAction: string
  nextActionBody: string
  reasons: string[]
  sourcedCount: number
  readyCount: number
  submissionCount: number
  pendingCount: number
  platformReadyCount: number
  platformSubmissionCount: number
  platformPendingCount: number
  recruiterCount: number
  openQuestionCount: number
  answeredQuestionCount: number
  marketFrictionCount: number
  cleanLane: boolean
  primary: boolean
  updatedMs: number
  application?: RecruiterRoleApplicationItem
  feedback?: RecruiterRoleFeedbackItem
  intelligence?: RecruiterRoleIntelligenceItem
}

type RoleOpportunityTerm = {
  label: string
  value: string
  body: string
  tone: RoleInsightTone
}

function roleOpportunityTerms(insight: RoleInsight): RoleOpportunityTerm[] {
  const job = insight.job
  const candidateComp = roleCandidateCompLabel(job)
  const pendingLeft = Math.max(0, ROLE_PENDING_SUBMISSION_LIMIT - insight.platformPendingCount)
  const accessValue = insight.primary
    ? "Approved"
    : insight.application?.status === "pending"
      ? "Pending"
      : "Apply"
  const accessBody = insight.primary
    ? "Trusted role lane. WeKruit expects active coverage."
    : insight.application?.status === "pending"
      ? "Access request is waiting on WeKruit review."
      : "Request access with candidate proof or use single-submit."
  return [
    {
      label: roleRewardSourceLabel(job),
      value: roleRewardLabel(job),
      body: "Estimated recruiter upside if a submitted candidate is hired.",
      tone: "live",
    },
    {
      label: "Candidate comp",
      value: candidateComp,
      body: candidateComp === "Not shared" ? "Ask WeKruit if compensation is blocking supply." : "Candidate-facing compensation context.",
      tone: candidateComp === "Not shared" ? "mute" : "info",
    },
    {
      label: "Access mode",
      value: accessValue,
      body: accessBody,
      tone: insight.primary ? "success" : insight.application?.status === "pending" ? "info" : "warn",
    },
    {
      label: "Market lane",
      value: insight.cleanLane ? "Clean" : `${insight.platformSubmissionCount} sent`,
      body: insight.cleanLane ? "No board submissions yet. First clean packet matters." : `${insight.recruiterCount} recruiter${insight.recruiterCount === 1 ? "" : "s"} active.`,
      tone: insight.cleanLane ? "success" : insight.recruiterCount > 1 ? "warn" : "info",
    },
    {
      label: "Review capacity",
      value: `${pendingLeft}/${ROLE_PENDING_SUBMISSION_LIMIT}`,
      body: pendingLeft ? "Pending submission room remains." : "Wait for feedback before more volume.",
      tone: pendingLeft ? "info" : "warn",
    },
  ]
}

function rowsForRole<T extends { inboundJobId?: string; jobId?: string }>(job: CollabJob, rows: T[]): T[] {
  const key = roleKey(job)
  return rows.filter((row) => row.inboundJobId === key || row.jobId === key)
}

function latestRoleFeedback(job: CollabJob, roleFeedback: RecruiterRoleFeedbackItem[]): RecruiterRoleFeedbackItem | undefined {
  return rowsForRole(job, roleFeedback)
    .sort((a, b) => timestampValueMs(b.updatedAt ?? b.createdAt) - timestampValueMs(a.updatedAt ?? a.createdAt))[0]
}

function feedbackDifficultyAdjustment(feedback?: RecruiterRoleFeedbackItem): number {
  switch (feedback?.difficulty) {
    case "easy": return 8
    case "hard": return -8
    case "blocked": return -22
    case "medium":
    default: return 0
  }
}

function roleFeedbackDifficultyText(difficulty?: RecruiterRoleFeedbackItem["difficulty"]): string {
  switch (difficulty) {
    case "easy": return "Easy"
    case "hard": return "Hard"
    case "blocked": return "Blocked"
    case "medium":
    default: return "Medium"
  }
}

function roleUpdatedLabel(updatedMs: number): string {
  if (!updatedMs) return "Open role"
  const days = Math.max(0, Math.floor((Date.now() - updatedMs) / 86_400_000))
  if (days === 0) return "Updated today"
  if (days === 1) return "Updated yesterday"
  if (days <= 7) return `Updated ${days}d ago`
  return "Established search"
}

function buildRoleInsight(
  job: CollabJob,
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  primaryRoleIds: string[],
  roleFeedback: RecruiterRoleFeedbackItem[],
  roleQuestions: RecruiterRoleQuestionItem[],
  roleIntelligence: RecruiterRoleIntelligenceItem[],
  roleApplications: RecruiterRoleApplicationItem[] = [],
): RoleInsight {
  const roleSubmissions = rowsForRole(job, submissions)
  const roleCandidates = rowsForRole(job, sourcedCandidates).filter((candidate) => candidate.stage !== "archived")
  const readyCount = roleCandidates.filter((candidate) => candidate.stage === "ready").length
  const pendingCount = roleSubmissions.filter(submissionIsConfirmedActiveReview).length
  const advancedCount = roleSubmissions.filter((submission) => ADVANCED_STATUSES.includes(submission.status ?? "")).length
  const rejectedCount = roleSubmissions.filter((submission) => CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? "")).length
  const feedback = latestRoleFeedback(job, roleFeedback)
  const application = latestRoleApplication(job, roleApplications)
  const intelligence = roleIntelligence.find((item) => item.jobId === roleKey(job))
  const questions = rowsForRole(job, roleQuestions)
  const openQuestionCount = intelligence?.openQuestionCount ?? questions.filter((question) => (question.status ?? "open") === "open").length
  const answeredQuestionCount = intelligence?.answeredQuestionCount ?? questions.filter((question) => question.status === "answered").length
  const platformReadyCount = intelligence?.readyCount ?? readyCount
  const platformSubmissionCount = intelligence?.submissionCount ?? roleSubmissions.length
  const platformPendingCount = intelligence?.pendingCount ?? pendingCount
  const recruiterCount = intelligence?.recruiterCount ?? (roleCandidates.length || roleSubmissions.length ? 1 : 0)
  const marketFrictionCount = (intelligence?.feedback.hard ?? (feedback?.difficulty === "hard" ? 1 : 0)) + (intelligence?.feedback.blocked ?? (feedback?.difficulty === "blocked" ? 1 : 0))
  const cleanLane = platformSubmissionCount === 0
  const { hard, fit } = roleChecklistCounts(job)
  const updatedMs = roleUpdatedMs(job)
  const primary = isPrimaryRole(job, primaryRoleIds)
  const freshBoost = isNewRole(job) ? 16 : updatedMs && Date.now() - updatedMs <= 14 * 86_400_000 ? 8 : 0
  const noSubmissionBoost = cleanLane ? 16 : -Math.min(18, platformSubmissionCount * 4)
  const marketBoost = Math.min(16, platformReadyCount * 6 + recruiterCount * 2)
  const blockerDrag = Math.min(24, openQuestionCount * 6 + marketFrictionCount * 8)
  const score = Math.max(18, Math.min(98,
    44 +
    freshBoost +
    (primary ? 12 : 0) +
    Math.min(18, readyCount * 9) +
    marketBoost +
    Math.min(10, roleCandidates.length * 2) +
    noSubmissionBoost +
    Math.min(12, hard * 2 + fit) +
    advancedCount * 8 -
    rejectedCount * 4 +
    feedbackDifficultyAdjustment(feedback) -
    blockerDrag,
  ))
  const blockedByMarket = marketFrictionCount > 0 && (intelligence?.feedback.blocked ?? 0) > 0
  const tone: RoleInsightTone = blockedByMarket || feedback?.difficulty === "blocked"
    ? "warn"
    : score >= 82
      ? "live"
      : score >= 68
        ? "success"
        : score >= 52
          ? "info"
          : "mute"
  const scoreLabel = blockedByMarket || feedback?.difficulty === "blocked"
    ? "Blocked"
    : openQuestionCount > 0
      ? "Clarify"
    : score >= 82
      ? "Work now"
      : score >= 68
        ? "Strong"
        : score >= 52
          ? "Watch"
          : "Low priority"
  const marketLoad = cleanLane
    ? "Clean lane"
    : platformPendingCount > 0
      ? `${platformPendingCount} pending across market`
      : `${platformSubmissionCount} submitted across market`
  const urgency = primary
    ? "Approved access"
    : isNewRole(job)
      ? "New role"
      : cleanLane
        ? "Open lane"
        : recruiterCount > 1
          ? "Competitive lane"
        : "Secondary"
  const nextAction = blockedByMarket || feedback?.difficulty === "blocked"
    ? "Clear market blocker"
    : openQuestionCount > 0
      ? "Get WeKruit answer"
    : readyCount > 0
      ? "Submit ready candidate"
    : roleCandidates.length > 0
        ? "Screen saved prospects"
        : cleanLane
          ? "Build first shortlist"
          : pendingCount > 0
            ? "Wait for feedback"
            : "Source lookalikes"
  const nextActionBody = blockedByMarket || feedback?.difficulty === "blocked"
    ? "Use the role brief question box before spending sourcing cycles."
    : openQuestionCount > 0
      ? "There is an unanswered role question. Clear the calibration issue before adding volume."
    : readyCount > 0
      ? "Open the brief and move the strongest ready candidate into a consented submission."
      : roleCandidates.length > 0
        ? "Advance screened prospects to Ready before submitting."
        : cleanLane
          ? "Start with two or three sourced prospects so duplicate checks and match ranking can work."
          : pendingCount > 0
            ? "Let WeKruit review the current submission before sending lookalikes."
            : "Use feedback and previous hard checks to source a tighter next candidate."
  const reasons = [
    roleUpdatedLabel(updatedMs),
    primary ? "Approved role access" : "Uses single-submit credit unless approved",
    readyCount ? `${readyCount} ready candidate${readyCount === 1 ? "" : "s"}` : "",
    cleanLane ? "Clean submission lane" : marketLoad,
    recruiterCount ? `${recruiterCount} recruiter${recruiterCount === 1 ? "" : "s"} active` : "",
    openQuestionCount ? `${openQuestionCount} open role Q` : "",
    feedback ? `${roleFeedbackDifficultyText(feedback.difficulty)} role` : "",
  ].filter(Boolean).slice(0, 4)

  return {
    job,
    score,
    scoreLabel,
    tone,
    urgency,
    marketLoad,
    nextAction,
    nextActionBody,
    reasons,
    sourcedCount: roleCandidates.length,
    readyCount,
    submissionCount: roleSubmissions.length,
    pendingCount,
    platformReadyCount,
    platformSubmissionCount,
    platformPendingCount,
    recruiterCount,
    openQuestionCount,
    answeredQuestionCount,
    marketFrictionCount,
    cleanLane,
    primary,
    updatedMs,
    application,
    feedback,
    intelligence,
  }
}

function sortRoleInsights(insights: RoleInsight[], sort: RoleSort): RoleInsight[] {
  const rows = [...insights]
  switch (sort) {
    case "newest":
      return rows.sort((a, b) => b.updatedMs - a.updatedMs || b.score - a.score)
    case "clean_lane":
      return rows.sort((a, b) => Number(b.cleanLane) - Number(a.cleanLane) || b.score - a.score)
    case "market_signal":
      return rows.sort((a, b) => (b.platformReadyCount + b.platformSubmissionCount + b.recruiterCount) - (a.platformReadyCount + a.platformSubmissionCount + a.recruiterCount) || b.score - a.score)
    case "most_ready":
      return rows.sort((a, b) => b.platformReadyCount - a.platformReadyCount || b.readyCount - a.readyCount || b.score - a.score)
    case "recommended":
    default:
      return rows.sort((a, b) => b.score - a.score || b.updatedMs - a.updatedMs)
  }
}

type RoleAccessStatus = "approved" | "pending" | "not_approved" | "candidate_proof" | "request_ready" | "single_submission" | "needs_answer"

type RoleAccessDecision = {
  insight: RoleInsight
  status: RoleAccessStatus
  label: string
  body: string
  evidence: string[]
  tone: RoleInsightTone
  actionLabel: string
}

type RoleApprovalProcessItem = {
  label: string
  value: string
  body: string
  tone: RoleInsightTone
}

type RoleApprovalProcessCenter = {
  title: string
  body: string
  tone: RoleInsightTone
  pendingCount: number
  pendingLimit: number
  pendingLeft: number
  approvedCount: number
  approvedLimit: number
  cards: RoleApprovalProcessItem[]
  criteria: RoleApprovalProcessItem[]
  statuses: RoleApprovalProcessItem[]
}

function roleAccessDecision(insight: RoleInsight, primarySlotsFull: boolean): RoleAccessDecision {
  if (insight.primary) {
    return {
      insight,
      status: "approved",
      label: "Approved to recruit",
      body: "WeKruit approved your role access. Keep at least one live candidate or active submission here.",
      evidence: [
        `${insight.sourcedCount} sourced`,
        `${insight.submissionCount} submitted`,
        `${insight.pendingCount} pending`,
      ],
      tone: "success",
      actionLabel: "Open brief",
    }
  }
  if (insight.application?.status === "pending") {
    return {
      insight,
      status: "pending",
      label: "Pending approval",
      body: "WeKruit is reviewing your role application. Build candidate proof while you wait.",
      evidence: [
        insight.application.preparedCandidateCount ? `${insight.application.preparedCandidateCount} prepared candidate${insight.application.preparedCandidateCount === 1 ? "" : "s"}` : "",
        insight.application.anonymizeCandidates ? "Candidates anonymized" : "Shared candidate context",
        roleUpdatedLabel(timestampValueMs(insight.application.updatedAt ?? insight.application.createdAt)),
      ].filter(Boolean),
      tone: "info",
      actionLabel: "Withdraw",
    }
  }
  if (insight.application?.status === "not_approved" || insight.application?.status === "rescinded") {
    return {
      insight,
      status: "not_approved",
      label: roleApplicationStatusLabel(insight.application.status),
      body: insight.application.adminNote || "WeKruit did not approve recruiting access for this role yet.",
      evidence: [
        insight.application.preparedCandidateCount ? `${insight.application.preparedCandidateCount} prepared candidate${insight.application.preparedCandidateCount === 1 ? "" : "s"}` : "",
        insight.application.reviewedByEmail ? `Reviewed by ${insight.application.reviewedByEmail}` : "",
        insight.application.reviewedAt ? formatActivityDate(insight.application.reviewedAt) : "",
      ].filter(Boolean),
      tone: "warn",
      actionLabel: "Reapply",
    }
  }
  if (insight.openQuestionCount > 0 || insight.marketFrictionCount > 0) {
    return {
      insight,
      status: "needs_answer",
      label: "Needs WeKruit answer",
      body: "Do not spend serious sourcing cycles until the calibration issue is answered.",
      evidence: [
        insight.openQuestionCount ? `${insight.openQuestionCount} open question${insight.openQuestionCount === 1 ? "" : "s"}` : "",
        insight.marketFrictionCount ? `${insight.marketFrictionCount} market friction signal${insight.marketFrictionCount === 1 ? "" : "s"}` : "",
        insight.feedback ? `${roleFeedbackDifficultyText(insight.feedback.difficulty)} role` : "",
      ].filter(Boolean),
      tone: "warn",
      actionLabel: "Open brief",
    }
  }
  if (insight.readyCount > 0) {
    return {
      insight,
      status: "candidate_proof",
      label: "Candidate proof ready",
      body: "You have a ready candidate. Use this role as a strong access request or one-off submission.",
      evidence: [
        `${insight.readyCount} ready`,
        `${insight.sourcedCount} sourced`,
        insight.cleanLane ? "Clean lane" : insight.marketLoad,
      ],
      tone: "live",
      actionLabel: primarySlotsFull ? "Open brief" : "Apply",
    }
  }
  if (insight.sourcedCount > 0) {
    return {
      insight,
      status: "request_ready",
      label: "Build proof",
      body: "Screen saved prospects before asking for focus access.",
      evidence: [
        `${insight.sourcedCount} sourced`,
        insight.cleanLane ? "Clean lane" : insight.marketLoad,
        insight.nextAction,
      ],
      tone: "info",
      actionLabel: primarySlotsFull ? "Open brief" : "Apply",
    }
  }
  if (primarySlotsFull) {
    return {
      insight,
      status: "single_submission",
      label: "Single submission only",
      body: "Approved role access is full. Work this only when you have a strong consented candidate.",
      evidence: [
        `${SINGLE_SUBMISSION_WEEKLY_LIMIT} weekly single-submit credits`,
        insight.cleanLane ? "Clean lane" : insight.marketLoad,
        roleUpdatedLabel(insight.updatedMs),
      ],
      tone: "mute",
      actionLabel: "Open brief",
    }
  }
  return {
    insight,
    status: "request_ready",
    label: "Request role access",
    body: "Available for approved access if you can commit candidate activity.",
    evidence: [
      insight.cleanLane ? "Clean lane" : insight.marketLoad,
      roleUpdatedLabel(insight.updatedMs),
      `${insight.scoreLabel} ${insight.score}`,
    ],
    tone: insight.cleanLane ? "success" : "info",
    actionLabel: "Apply",
  }
}

function sortRoleAccessDecisions(rows: RoleAccessDecision[]): RoleAccessDecision[] {
  const rank: Record<RoleAccessStatus, number> = {
    candidate_proof: 5,
    approved: 4,
    pending: 4,
    request_ready: 3,
    single_submission: 2,
    not_approved: 1,
    needs_answer: 1,
  }
  return [...rows].sort((a, b) => rank[b.status] - rank[a.status] || b.insight.score - a.insight.score)
}

function roleAccessSummary(decisions: RoleAccessDecision[]) {
  return {
    approved: decisions.filter((decision) => decision.status === "approved").length,
    pending: decisions.filter((decision) => decision.status === "pending").length,
    candidateProof: decisions.filter((decision) => decision.status === "candidate_proof").length,
    requestReady: decisions.filter((decision) => decision.status === "request_ready").length,
    needsAnswer: decisions.filter((decision) => decision.status === "needs_answer").length,
    singleOnly: decisions.filter((decision) => decision.status === "single_submission").length,
  }
}

function buildRoleApprovalProcessCenter(decisions: RoleAccessDecision[]): RoleApprovalProcessCenter {
  const summary = roleAccessSummary(decisions)
  const pendingLeft = Math.max(0, PENDING_ROLE_APPLICATION_LIMIT - summary.pending)
  const preparedCandidateCount = decisions.reduce((sum, decision) => {
    const prepared = decision.insight.application?.preparedCandidateCount ?? 0
    return sum + prepared
  }, 0)
  const readyProof = decisions.reduce((sum, decision) => sum + decision.insight.readyCount, 0)
  const overPendingLimit = summary.pending >= PENDING_ROLE_APPLICATION_LIMIT
  const overApprovedLimit = summary.approved >= APPROVED_ROLE_LIMIT
  const tone: RoleInsightTone = overPendingLimit || summary.needsAnswer > 0
    ? "warn"
    : summary.candidateProof > 0 || pendingLeft > 0
      ? "live"
      : summary.approved > 0
        ? "success"
        : "info"
  const title = overPendingLimit
    ? "Pending approval limit reached"
    : summary.candidateProof > 0
      ? `${summary.candidateProof} candidate-backed access request${summary.candidateProof === 1 ? "" : "s"} ready`
      : pendingLeft > 0
        ? `${pendingLeft} approval slot${pendingLeft === 1 ? "" : "s"} open`
        : "Role access queue is quiet"
  const body = overPendingLimit
    ? "Withdraw or wait for a pending role decision before applying to another role. This keeps the approval queue intentional."
    : "Use role access only when you can prove fit, answer blockers, and commit active coverage instead of spreading effort across too many searches."

  return {
    title,
    body,
    tone,
    pendingCount: summary.pending,
    pendingLimit: PENDING_ROLE_APPLICATION_LIMIT,
    pendingLeft,
    approvedCount: summary.approved,
    approvedLimit: APPROVED_ROLE_LIMIT,
    cards: [
      {
        label: "Pending limit",
        value: `${summary.pending}/${PENDING_ROLE_APPLICATION_LIMIT}`,
        body: overPendingLimit ? "Approval queue is full; withdraw or wait before applying again." : `${pendingLeft} pending application slot${pendingLeft === 1 ? "" : "s"} left.`,
        tone: overPendingLimit ? "warn" : summary.pending ? "info" : "success",
      },
      {
        label: "Approved role limit",
        value: `${summary.approved}/${APPROVED_ROLE_LIMIT}`,
        body: overApprovedLimit ? "Approved role capacity is full; use single-submit for exceptional one-offs." : "Approved searches should have live candidate motion.",
        tone: overApprovedLimit ? "warn" : summary.approved ? "success" : "mute",
      },
      {
        label: "Prepared proof",
        value: String(preparedCandidateCount + readyProof),
        body: "Prepared and ready candidates are the strongest signal for role approval.",
        tone: preparedCandidateCount + readyProof ? "live" : "mute",
      },
      {
        label: "Blocked access",
        value: String(summary.needsAnswer),
        body: "Open questions or hard market signals should be cleared before more sourcing.",
        tone: summary.needsAnswer ? "warn" : "success",
      },
    ],
    criteria: [
      {
        label: "Trust record",
        value: "Quality",
        body: "Submission rating, interview movement, and clean ownership affect whether more role access makes sense.",
        tone: "info",
      },
      {
        label: "Candidate proof",
        value: "Prepared",
        body: "Ready or sourced candidates attached to the role make an access request materially stronger.",
        tone: readyProof + preparedCandidateCount ? "live" : "mute",
      },
      {
        label: "Role capacity",
        value: "Not full",
        body: "WeKruit should avoid adding recruiters when a role is saturated or already has too much pending review.",
        tone: "info",
      },
      {
        label: "Calibration",
        value: "Clear",
        body: "Open role questions and hard/blocked feedback should be resolved before requesting focus access.",
        tone: summary.needsAnswer ? "warn" : "success",
      },
    ],
    statuses: [
      {
        label: "Apply now",
        value: String(summary.requestReady),
        body: "Roles where the application path is open if pending slots remain.",
        tone: summary.requestReady ? "info" : "mute",
      },
      {
        label: "Pending",
        value: String(summary.pending),
        body: "Waiting on WeKruit review. Keep building proof or withdraw if the role is no longer meaningful.",
        tone: overPendingLimit ? "warn" : summary.pending ? "info" : "mute",
      },
      {
        label: "Approved",
        value: String(summary.approved),
        body: "Approved to recruit; keep coverage active or switch focus.",
        tone: summary.approved ? "success" : "mute",
      },
      {
        label: "Not approved",
        value: String(decisions.filter((decision) => decision.status === "not_approved").length),
        body: "Improve candidate proof, trust signal, or role fit before reapplying.",
        tone: decisions.some((decision) => decision.status === "not_approved") ? "warn" : "mute",
      },
    ],
  }
}

function defaultRoleApplicationPitch(decision: RoleAccessDecision): string {
  if (decision.insight.readyCount > 0) {
    return `I have ${decision.insight.readyCount} ready candidate${decision.insight.readyCount === 1 ? "" : "s"} for this role and can actively source against the hard checks.`
  }
  if (decision.insight.sourcedCount > 0) {
    return `I have ${decision.insight.sourcedCount} sourced candidate${decision.insight.sourcedCount === 1 ? "" : "s"} for this role and can screen them against the hard checks before submission.`
  }
  return ""
}

function PriorityRoleRow({
  job,
  sourcedCount,
  submissionCount,
  primary,
  application,
  onAccess,
}: {
  job: CollabJob
  sourcedCount: number
  submissionCount: number
  primary: boolean
  application?: RecruiterRoleApplicationItem
  onAccess: (jobId?: string) => void
}) {
  const { hard, fit } = roleChecklistCounts(job)
  const signal = roleFitSignal(job, sourcedCount, submissionCount)
  return (
    <article className="rb-priority-row">
      <span>
        <Link to={`/recruiters/job/${job.jobId}`}>{job.title}</Link>
        <em>{job.recruiterBoard.label.company}</em>
      </span>
      <span>{roleReward(job)}</span>
      <span>{job.recruiterBoard.label.location}</span>
      <span>{hard} hard - {fit} fit</span>
      <span className={`rb-fit-signal is-${signal.tone}`}>{signal.label} {signal.percent}%</span>
      <button
        type="button"
        className={`rb-row-button ${primary ? "is-active" : ""}`}
        disabled={primary || application?.status === "pending"}
        onClick={() => onAccess(roleKey(job))}
      >
        {primary ? "Approved" : application?.status === "pending" ? "Pending" : "Apply"}
      </button>
    </article>
  )
}

function PipelineCard({ item }: { item: PipelineItem }) {
  const body = (
    <>
      <span className="rb-candidate-dot">{item.name.slice(0, 1).toUpperCase()}</span>
      <span>
        <strong>{item.name}</strong>
        <em>{item.title}</em>
        <small>{item.company} - {item.age}</small>
      </span>
    </>
  )
  return item.href ? (
    <Link to={item.href} className="rb-pipeline-card">{body}</Link>
  ) : (
    <div className="rb-pipeline-card">{body}</div>
  )
}

function FeedbackLine({ submission }: { submission: RecruiterSubmissionItem }) {
  const meta = statusMeta(submission.status)
  const reasons = submissionFeedbackReasonLabels(submission)
  return (
    <article className="rb-feedback-line">
      <span className={`rb-status is-${meta.tone}`}>{meta.label}</span>
      <span>
        <strong>{submission.candidate?.name || "Candidate"}</strong>
        <em>{submission.jobTitleSnapshot || "Role"}</em>
      </span>
      <p>
        <b>{submissionFeedbackRatingLabel(submission)}</b>
        {submission.recruiterFeedbackNote ? ` · ${submission.recruiterFeedbackNote}` : ""}
        {reasons.length ? ` · ${reasons.join(", ")}` : ""}
      </p>
      <small>{formatWhen(submission)}</small>
    </article>
  )
}

function RoleAccessTab({
  jobs,
  submissions,
  sourcedCandidates,
  roleFeedback,
  roleQuestions,
  roleIntelligence,
  roleApplications,
  primaryRoleIds,
  roleApplicationSavingId,
  initialApplicationJobId,
  onRoleApplicationSave,
  onRoles,
  onCandidates,
}: {
  jobs: CollabJob[]
  submissions: RecruiterSubmissionItem[]
  sourcedCandidates: RecruiterSourcedCandidateItem[]
  roleFeedback: RecruiterRoleFeedbackItem[]
  roleQuestions: RecruiterRoleQuestionItem[]
  roleIntelligence: RecruiterRoleIntelligenceItem[]
  roleApplications: RecruiterRoleApplicationItem[]
  primaryRoleIds: string[]
  roleApplicationSavingId: string | null
  initialApplicationJobId?: string | null
  onRoleApplicationSave: (input: RecruiterRoleApplicationInput) => void
  onRoles: () => void
  onCandidates: () => void
}) {
  const [applicationDraftJobId, setApplicationDraftJobId] = useState<string | null>(null)
  const [applicationPitch, setApplicationPitch] = useState("")
  const [anonymizeCandidates, setAnonymizeCandidates] = useState(false)
  const primarySlotsFull = primaryRoleIds.length >= APPROVED_ROLE_LIMIT
  const decisions = useMemo(() => {
    const insights = jobs.map((job) => buildRoleInsight(job, submissions, sourcedCandidates, primaryRoleIds, roleFeedback, roleQuestions, roleIntelligence, roleApplications))
    return sortRoleAccessDecisions(insights.map((insight) => roleAccessDecision(insight, primarySlotsFull)))
  }, [jobs, primaryRoleIds, primarySlotsFull, roleApplications, roleFeedback, roleIntelligence, roleQuestions, sourcedCandidates, submissions])
  const summary = roleAccessSummary(decisions)
  const approvalCenter = buildRoleApprovalProcessCenter(decisions)
  const pendingSlotsFull = summary.pending >= PENDING_ROLE_APPLICATION_LIMIT
  const singleSubmissions = submissions.filter((submission) => submission.submissionMode === "single_submission").length
  const singleCreditsLeft = Math.max(0, SINGLE_SUBMISSION_WEEKLY_LIMIT - singleSubmissions)
  const proofRoles = decisions
    .filter((decision) => decision.status === "candidate_proof" || (decision.status === "request_ready" && decision.insight.sourcedCount > 0))
    .slice(0, 5)
  const blockedRoles = decisions.filter((decision) => decision.status === "needs_answer").slice(0, 4)
  const selectedApplicationDecision = decisions.find((decision) => roleKey(decision.insight.job) === applicationDraftJobId)
  const selectedPreparedCandidates = selectedApplicationDecision
    ? rowsForRole(selectedApplicationDecision.insight.job, sourcedCandidates).filter((candidate) => candidate.stage !== "archived").slice(0, 10)
    : []

  useEffect(() => {
    if (!initialApplicationJobId) return
    const target = decisions.find((decision) => roleKey(decision.insight.job) === initialApplicationJobId)
    if (!target || target.insight.primary || target.status === "pending" || target.status === "needs_answer" || pendingSlotsFull) return
    setApplicationDraftJobId(initialApplicationJobId)
    setApplicationPitch((current) => current.trim() ? current : defaultRoleApplicationPitch(target))
    setAnonymizeCandidates(target.insight.application?.anonymizeCandidates ?? false)
  }, [decisions, initialApplicationJobId, pendingSlotsFull])

  const submitApplication = () => {
    if (!selectedApplicationDecision || pendingSlotsFull) return
    const jobId = roleKey(selectedApplicationDecision.insight.job)
    onRoleApplicationSave({
      jobId,
      action: "apply",
      pitch: applicationPitch,
      anonymizeCandidates,
      preparedCandidateIds: selectedPreparedCandidates.map((candidate) => candidate.id),
    })
    setApplicationDraftJobId(null)
    setApplicationPitch("")
    setAnonymizeCandidates(false)
  }

  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div>
          <h2>Role access command</h2>
          <p>Decide what you can work now, where you need candidate proof, and which roles need WeKruit calibration before more sourcing.</p>
        </div>
        <button type="button" className="rb-panel__link" onClick={onRoles}>Open marketplace</button>
      </header>

      <section className="rb-access-command-hero">
        <article className="is-success">
          <span>Approved role access</span>
          <strong>{summary.approved}/{APPROVED_ROLE_LIMIT}</strong>
          <p>Approved roles are the searches WeKruit should expect you to actively cover.</p>
        </article>
        <article className="is-info">
          <span>Pending applications</span>
          <strong>{summary.pending}/{PENDING_ROLE_APPLICATION_LIMIT}</strong>
          <p>{pendingSlotsFull ? "Withdraw or wait before applying again." : "Role applications waiting on WeKruit review."}</p>
        </article>
        <article className="is-live">
          <span>Candidate proof ready</span>
          <strong>{summary.candidateProof}</strong>
          <p>Ready candidates that can justify role focus or a one-off submission.</p>
        </article>
        <article className="is-info">
          <span>Apply-ready roles</span>
          <strong>{summary.requestReady}</strong>
          <p>Roles that can become approved access once you build enough proof.</p>
        </article>
        <article className="is-warn">
          <span>Needs answer</span>
          <strong>{summary.needsAnswer}</strong>
          <p>Blocked by open role questions or hard market feedback.</p>
        </article>
        <article className="is-mute">
          <span>Single credits left</span>
          <strong>{singleCreditsLeft}/{SINGLE_SUBMISSION_WEEKLY_LIMIT}</strong>
          <p>Use only for strong consented candidates outside approved roles.</p>
        </article>
      </section>
      <RoleApprovalProcessCenterPanel model={approvalCenter} />

      <section className="rb-access-command-grid">
        <article className="rb-access-board">
          <header>
            <h3>Access decisions</h3>
            <p>Ranked by proof, current primary access, and role blockers.</p>
          </header>
          <div className="rb-access-table">
            {decisions.slice(0, 10).map((decision) => {
              const job = decision.insight.job
              const canApply = !decision.insight.primary &&
                !primarySlotsFull &&
                !pendingSlotsFull &&
                decision.status !== "needs_answer" &&
                decision.status !== "pending"
              const canWithdraw = decision.status === "pending"
              const applyBlockedByPendingLimit = pendingSlotsFull &&
                !decision.insight.primary &&
                decision.status !== "pending" &&
                decision.status !== "needs_answer"
              return (
                <article key={job.jobId} className={`is-${decision.tone}`}>
                  <div>
                    <span className={`rb-status is-${decision.tone}`}>{decision.label}</span>
                    <strong>{job.title}</strong>
                    <p>{job.recruiterBoard.label.company} - {job.recruiterBoard.label.location}</p>
                  </div>
                  <div>
                    <strong>{decision.body}</strong>
                    <p>{decision.evidence.join(" · ")}</p>
                  </div>
                  <div>
                    {canWithdraw ? (
                      <button
                        type="button"
                        disabled={roleApplicationSavingId === roleKey(job)}
                        onClick={() => onRoleApplicationSave({ jobId: roleKey(job), action: "withdraw" })}
                      >
                        {roleApplicationSavingId === roleKey(job) ? "Withdrawing..." : "Withdraw"}
                      </button>
                    ) : canApply ? (
                      <button
                        type="button"
                        disabled={roleApplicationSavingId === roleKey(job)}
                        onClick={() => {
                          setApplicationDraftJobId(roleKey(job))
                          setApplicationPitch(defaultRoleApplicationPitch(decision))
                        }}
                      >
                        {roleApplicationSavingId === roleKey(job) ? "Saving..." : decision.status === "not_approved" ? "Reapply" : "Apply"}
                      </button>
                    ) : applyBlockedByPendingLimit ? (
                      <button type="button" disabled>Pending limit</button>
                    ) : (
                      <Link to={`/recruiters/job/${job.jobId}`}>{decision.actionLabel}</Link>
                    )}
                  </div>
                </article>
              )
            })}
            {decisions.length === 0 && <p className="rb-empty">No recruiter-board roles are active yet.</p>}
          </div>
        </article>

        {selectedApplicationDecision && (
          <article className="rb-role-application-composer">
            <header>
              <span>Apply to recruit</span>
              <strong>{selectedApplicationDecision.insight.job.title}</strong>
              <button type="button" onClick={() => setApplicationDraftJobId(null)}>Cancel</button>
            </header>
            <p>Share why WeKruit should trust you with this search. Prepared candidates from your CRM are attached automatically.</p>
            <textarea
              value={applicationPitch}
              onChange={(event) => setApplicationPitch(event.target.value)}
              placeholder="Relevant recruiting background, warm candidate proof, sourcing lane, and expected weekly coverage..."
            />
            <label>
              <input
                type="checkbox"
                checked={anonymizeCandidates}
                onChange={(event) => setAnonymizeCandidates(event.target.checked)}
              />
              <span>Anonymize prepared candidate details from other recruiters</span>
            </label>
            <div>
              <span>{selectedPreparedCandidates.length} prepared candidate{selectedPreparedCandidates.length === 1 ? "" : "s"} attached</span>
              <button
                type="button"
                disabled={pendingSlotsFull || applicationPitch.trim().length < 20 || roleApplicationSavingId === roleKey(selectedApplicationDecision.insight.job)}
                onClick={submitApplication}
              >
                {roleApplicationSavingId === roleKey(selectedApplicationDecision.insight.job) ? "Submitting..." : pendingSlotsFull ? "Pending limit reached" : "Submit application"}
              </button>
            </div>
          </article>
        )}

        <aside className="rb-access-side">
          <article>
            <h3>Access rules</h3>
            <p>Approved role access means you are committing active coverage. Single submissions are for exceptional candidate-led opportunities.</p>
            <ul>
              <li>Apply only when you can source or submit soon.</li>
              <li>Keep pending applications at {PENDING_ROLE_APPLICATION_LIMIT} or fewer.</li>
              <li>Attach candidate proof before asking for trusted access.</li>
              <li>Pause roles with open questions until WeKruit answers.</li>
            </ul>
          </article>
          <article>
            <h3>Proof queue</h3>
            {proofRoles.length ? proofRoles.map((decision) => (
              <Link key={decision.insight.job.jobId} to={`/recruiters/job/${decision.insight.job.jobId}`}>
                <strong>{decision.insight.job.title}</strong>
                <span>{decision.label} · {decision.insight.sourcedCount} sourced</span>
              </Link>
            )) : (
              <button type="button" onClick={onCandidates}>Add sourced candidates</button>
            )}
          </article>
          <article>
            <h3>Calibration blockers</h3>
            {blockedRoles.length ? blockedRoles.map((decision) => (
              <Link key={decision.insight.job.jobId} to={`/recruiters/job/${decision.insight.job.jobId}`}>
                <strong>{decision.insight.job.title}</strong>
                <span>{decision.evidence.join(" · ")}</span>
              </Link>
            )) : (
              <p>No blocked access lanes right now.</p>
            )}
          </article>
        </aside>
      </section>
    </section>
  )
}

function RoleApprovalProcessCenterPanel({ model }: { model: RoleApprovalProcessCenter }) {
  return (
    <section className={`rb-approval-center is-${model.tone}`} aria-label="Role approval process center">
      <header>
        <div>
          <span>Approval process</span>
          <strong>{model.title}</strong>
          <p>{model.body}</p>
        </div>
        <aside>
          <span>Access capacity</span>
          <strong>{model.approvedCount}/{model.approvedLimit}</strong>
          <p>{model.pendingCount}/{model.pendingLimit} pending approval slots are currently used.</p>
        </aside>
      </header>

      <div className="rb-approval-center__cards">
        {model.cards.map((card) => (
          <article className={`is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
          </article>
        ))}
      </div>

      <div className="rb-approval-center__body">
        <section>
          <div>
            <h3>What WeKruit reviews</h3>
            <p>Access should go to searches where the recruiter has proof, capacity, and a clean role signal.</p>
          </div>
          {model.criteria.map((item) => (
            <article className={`is-${item.tone}`} key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <p>{item.body}</p>
            </article>
          ))}
        </section>
        <section>
          <div>
            <h3>Status meanings</h3>
            <p>Keep the queue intentional: pending slots are scarce and approved roles require active coverage.</p>
          </div>
          {model.statuses.map((item) => (
            <article className={`is-${item.tone}`} key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <p>{item.body}</p>
            </article>
          ))}
        </section>
      </div>
    </section>
  )
}

function RolesListTab({ jobs, loading }: { jobs: CollabJob[]; loading: boolean }) {
  const [q, setQ] = useState("")
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return jobs
    return jobs.filter((job) =>
      job.title.toLowerCase().includes(needle) ||
      job.recruiterBoard.label.company.toLowerCase().includes(needle) ||
      job.recruiterBoard.label.location.toLowerCase().includes(needle),
    )
  }, [jobs, q])
  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Open roles</h2><p>Pick a role to read the job description, work the checklist, and submit a candidate.</p></div>
        <label className="rb-search">
          <span>Search roles</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, company, location..." autoComplete="off" />
        </label>
      </header>
      {loading && <div className="rb-state">Loading open roles...</div>}
      {!loading && (
        <div className="rb-role-list">
          {visible.map((job) => {
            const feeNote = roleCompSummaryLooksFee(job.compSummary) ? shortText(job.compSummary, "", 40) : ""
            const compNote = !feeNote && job.compSummary ? shortText(job.compSummary, "", 48) : ""
            return (
              <Link key={job.jobId} to={`/recruiters/job/${job.jobId}`} className="rb-role-row">
                <span className="rb-role-row__logo">{job.recruiterBoard.label.companyCode}</span>
                <span className="rb-role-row__body">
                  <strong>{job.title}</strong>
                  <em>
                    {job.recruiterBoard.label.company} · {job.recruiterBoard.label.location}
                    {compNote ? ` · ${compNote}` : ""}
                  </em>
                </span>
                <span className="rb-role-row__action">{feeNote || "Open role"}</span>
              </Link>
            )
          })}
          {visible.length === 0 && (
            <p className="rb-empty">{jobs.length === 0 ? "No open roles right now. Check back soon." : "No roles match that search."}</p>
          )}
        </div>
      )}
    </section>
  )
}

function RolesTab({
  jobs,
  submissions,
  sourcedCandidates,
  roleFeedback,
  roleQuestions,
  roleIntelligence,
  roleApplications,
  loading,
  primaryRoleIds,
  roleApplicationSavingId,
  onAccess,
}: {
  jobs: CollabJob[]
  submissions: RecruiterSubmissionItem[]
  sourcedCandidates: RecruiterSourcedCandidateItem[]
  roleFeedback: RecruiterRoleFeedbackItem[]
  roleQuestions: RecruiterRoleQuestionItem[]
  roleIntelligence: RecruiterRoleIntelligenceItem[]
  roleApplications: RecruiterRoleApplicationItem[]
  loading: boolean
  primaryRoleIds: string[]
  roleApplicationSavingId: string | null
  onAccess: (jobId?: string) => void
}) {
  const [q, setQ] = useState("")
  const [filter, setFilter] = useState<RoleFilter>("all")
  const [sort, setSort] = useState<RoleSort>("recommended")
  const insights = useMemo(
    () => jobs.map((job) => buildRoleInsight(job, submissions, sourcedCandidates, primaryRoleIds, roleFeedback, roleQuestions, roleIntelligence, roleApplications)),
    [jobs, primaryRoleIds, roleApplications, roleFeedback, roleIntelligence, roleQuestions, sourcedCandidates, submissions],
  )
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const visible = insights.filter((insight) => {
      if (filter === "primary" && !insight.primary) return false
      if (filter === "new" && !isNewRole(insight.job)) return false
      if (filter === "clean_lane" && !insight.cleanLane) return false
      if (filter === "market_moving" && insight.platformReadyCount + insight.platformSubmissionCount + insight.recruiterCount === 0) return false
      if (filter === "needs_answers" && insight.openQuestionCount + insight.marketFrictionCount === 0) return false
      return true
    })
    const searched = !needle ? visible : visible.filter(({ job }) =>
      job.title.toLowerCase().includes(needle) ||
      job.recruiterBoard.label.location.toLowerCase().includes(needle) ||
      job.recruiterBoard.label.company.toLowerCase().includes(needle) ||
      job.recruiterBoard.label.pills.some((p) => p.text.toLowerCase().includes(needle)),
    )
    return sortRoleInsights(searched, sort)
  }, [filter, insights, q, sort])
  const spotlight = filtered.slice(0, 3)
  const boardValue = filtered.reduce((sum, insight) => sum + roleRewardAmount(insight.job), 0)
  const cleanLaneCount = filtered.filter((insight) => insight.cleanLane).length
  const approvedCount = filtered.filter((insight) => insight.primary).length
  const pendingReviewCount = filtered.reduce((sum, insight) => sum + insight.platformPendingCount, 0)

  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Role marketplace</h2><p>Live WeKruit collab roles with scorecards, pipeline context, and submit paths.</p></div>
        <div className="rb-role-toolbar">
          <label className="rb-search">
            <span>Search roles</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, location, tag..." autoComplete="off" />
          </label>
          <label className="rb-role-sort">
            <span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as RoleSort)}>
              {ROLE_SORTS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        </div>
      </header>
      <div className="rb-filter-row" role="tablist" aria-label="Role filters">
        {ROLE_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={filter === option.id ? "is-active" : ""}
            onClick={() => setFilter(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {loading && <div className="rb-state">Loading open roles...</div>}
      {!loading && (
        <>
          <section className="rb-role-market-strip" aria-label="Role marketplace economics">
            <article className="is-live">
              <span>Visible reward pool</span>
              <strong>{formatCurrencyShort(boardValue)}</strong>
              <p>{filtered.length} matching role{filtered.length === 1 ? "" : "s"} using explicit or estimated success-fee value.</p>
            </article>
            <article className={approvedCount ? "is-success" : "is-info"}>
              <span>Approved lanes</span>
              <strong>{approvedCount}/{APPROVED_ROLE_LIMIT}</strong>
              <p>Trusted searches where WeKruit expects active recruiter coverage.</p>
            </article>
            <article className={cleanLaneCount ? "is-success" : "is-info"}>
              <span>Clean lanes</span>
              <strong>{cleanLaneCount}</strong>
              <p>Roles with no recruiter-board submission signal yet.</p>
            </article>
            <article className={pendingReviewCount >= ROLE_PENDING_SUBMISSION_LIMIT ? "is-warn" : "is-info"}>
              <span>Pending market load</span>
              <strong>{pendingReviewCount}</strong>
              <p>Open submission reviews across the matching board.</p>
            </article>
          </section>
          {spotlight.length > 0 && (
            <section className="rb-role-command" aria-label="Recommended role focus">
              <header>
                <span>Role command center</span>
                <strong>{spotlight[0]?.scoreLabel ?? "Recommended"} focus</strong>
                <em>{spotlight.length} role{spotlight.length === 1 ? "" : "s"} ranked from pipeline, recruiter activity, role Q&amp;A, and market friction.</em>
              </header>
              <div>
                {spotlight.map((insight) => <RoleCommandCard key={insight.job.jobId} insight={insight} />)}
              </div>
            </section>
          )}
          <div className="rb-role-grid">
            {filtered.map((insight) => (
              <RoleCard
                key={insight.job.jobId}
                insight={insight}
                primarySlotsFull={primaryRoleIds.length >= APPROVED_ROLE_LIMIT}
                disabled={roleApplicationSavingId === roleKey(insight.job)}
                onAccess={() => onAccess(roleKey(insight.job))}
              />
            ))}
            {filtered.length === 0 && <p className="rb-empty">No roles match that search.</p>}
          </div>
        </>
      )}
    </section>
  )
}

type CandidateRoleMatch = {
  job: CollabJob
  score: number
  reasons: string[]
  sourcedCount: number
  submissionCount: number
}

type CandidateMatchCommand = {
  tone: "live" | "info" | "success" | "warn" | "mute"
  label: string
  title: string
  body: string
  actionLabel: string
  actionHref: string
  cards: Array<{
    label: string
    value: string
    body: string
    tone: "live" | "info" | "success" | "warn" | "mute"
    href?: string
  }>
}

type CandidateNetworkExposureRow = {
  candidate: RecruiterSourcedCandidateItem
  tone: "live" | "info" | "success" | "warn" | "mute"
  label: string
  title: string
  body: string
  actionLabel: string
  href?: string
  matches: CandidateRoleMatch[]
}

type CandidateNetworkExposureModel = {
  tone: "live" | "info" | "success" | "warn" | "mute"
  label: string
  title: string
  body: string
  cards: Array<{ label: string; value: string; body: string; tone: "live" | "info" | "success" | "warn" | "mute" }>
  rows: CandidateNetworkExposureRow[]
}

type CandidateOutreachTouch = {
  id: string
  label: string
  channel: string
  title: string
  body: string
  tone: OperatingTone
}

type CandidateOutreachStudio = {
  label: string
  title: string
  body: string
  tone: OperatingTone
  roleHref?: string
  cards: RecruiterOperatingMetric[]
  touches: CandidateOutreachTouch[]
  screening: string[]
}

function candidateMatchText(candidate: RecruiterSourcedCandidateItem): string {
  return [
    candidate.candidate?.name,
    candidate.candidate?.currentRole,
    candidate.candidate?.yoe,
    candidate.candidate?.notes,
    candidate.jobTitleSnapshot,
    candidate.companyLabelSnapshot,
  ].filter(Boolean).join(" ")
}

function sourcedCandidateDomId(candidateId: string): string {
  return `candidate-${candidateId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

function sourcedCandidateRoleHref(candidate: RecruiterSourcedCandidateItem): string | undefined {
  const jobId = candidate.inboundJobId || candidate.jobId
  return jobId ? `/recruiters/job/${encodeURIComponent(jobId)}?candidateId=${encodeURIComponent(candidate.id)}` : undefined
}

function sourcedCandidateIdentityKeys(candidate: RecruiterSourcedCandidateItem): string[] {
  return [
    candidate.candidate?.email ? `email:${candidate.candidate.email.trim().toLowerCase()}` : "",
    candidate.candidate?.link ? `link:${normalizeBulkCandidateLink(candidate.candidate.link).toLowerCase().replace(/\/+$/, "")}` : "",
  ].filter(Boolean)
}

function duplicateCandidateIds(candidates: RecruiterSourcedCandidateItem[]): Set<string> {
  const keyToIds = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    for (const key of sourcedCandidateIdentityKeys(candidate)) {
      const ids = keyToIds.get(key) ?? new Set<string>()
      ids.add(candidate.id)
      keyToIds.set(key, ids)
    }
  }
  const duplicates = new Set<string>()
  for (const ids of keyToIds.values()) {
    if (ids.size <= 1) continue
    for (const id of ids) duplicates.add(id)
  }
  return duplicates
}

type CandidateSourcingAction = "bulk_import" | "open_candidate" | "match_candidate" | "submit_candidate"

type CandidateSourcingCommand = {
  focus?: RecruiterSourcedCandidateItem
  label: string
  title: string
  body: string
  tone: "live" | "info" | "success" | "warn" | "mute"
  action: CandidateSourcingAction
  actionLabel: string
  href?: string
  cards: Array<{ label: string; value: string; body: string; tone: "live" | "info" | "success" | "warn" | "mute" }>
  queue: Array<{
    id: string
    label: string
    title: string
    body: string
    tone: "live" | "info" | "success" | "warn" | "mute"
    action: CandidateSourcingAction
    href?: string
  }>
}

type CandidateOwnershipRule = {
  label: string
  title: string
  body: string
  tone: OperatingTone
}

type CandidateOwnershipDesk = {
  label: string
  title: string
  body: string
  tone: OperatingTone
  cards: RecruiterOperatingMetric[]
  rules: CandidateOwnershipRule[]
}

type CandidateIdentityCheckState = {
  status: "clear" | "conflict" | "error"
  title: string
  body: string
  tone: OperatingTone
}

function candidateSourcingPriority(candidate: RecruiterSourcedCandidateItem, duplicates: Set<string>): number {
  const followUp = candidateFollowUpState(candidate)
  if (duplicates.has(candidate.id)) return 98
  if (candidate.stage === "ready" && sourcedCandidateRoleHref(candidate)) return 92
  if (candidate.stage === "ready") return 86
  if (followUp.needsAction) return 78
  if (candidate.calibrationStatus === "calibration_requested" || candidate.calibrationStatus === "bad_fit") return 72
  if (candidate.stage === "screened") return 62
  if (candidate.outreach?.status === "responded") return 56
  if (candidate.outreach?.status === "not_contacted" || !candidate.outreach?.status) return 48
  if (candidate.stage === "sourced" || candidate.stage === "contacted") return 36
  return 10
}

function candidateCommandBody(candidate: RecruiterSourcedCandidateItem, duplicates: Set<string>): string {
  if (duplicates.has(candidate.id)) return "Duplicate identity signal. Keep one clean record before more outreach."
  const followUp = candidateFollowUpState(candidate)
  if (followUp.needsAction) return followUp.body
  if (candidate.stage === "ready" && sourcedCandidateRoleHref(candidate)) return "Candidate is ready and already tied to a role. Submit from the role brief with consent."
  if (candidate.stage === "ready") return "Candidate is ready. Use the matchboard to choose the strongest role before submission."
  if (candidate.calibrationStatus === "bad_fit") return candidate.calibrationNote || "Marked not a fit. Do not submit without WeKruit calibration."
  if (candidate.calibrationStatus === "calibration_requested") return candidate.calibrationNote || "Calibration has been requested. Wait for signal before submission."
  if (candidate.outreach?.status === "responded") return "Candidate responded. Screen for comp, interest, hard filters, and role fit."
  if (candidate.stage === "screened") return "Screening is done. Mark ready once candidate interest and hard checks are clear."
  return "Add outreach notes, set a follow-up, or match this candidate against open roles."
}

function identityConflictCopy(
  conflict: NonNullable<RecruiterCandidateIdentityCheckResult["conflict"]>,
): CandidateIdentityCheckState {
  if (conflict.reason === "candidate_already_submitted_for_role") {
    return {
      status: "conflict",
      title: "Already submitted for this role",
      body: "Do not contact or save this candidate for the selected company lane. Work another candidate or review the existing submission trail.",
      tone: "warn",
    }
  }
  return {
    status: "conflict",
    title: "Already sourced by another recruiter",
    body: "This candidate is already in motion for the selected role. Pick another candidate or ask WeKruit for calibration before more outreach.",
    tone: "warn",
  }
}

function buildCandidateOwnershipDesk(
  candidates: RecruiterSourcedCandidateItem[],
  submissions: RecruiterSubmissionItem[],
): CandidateOwnershipDesk {
  const activeCandidates = candidates.filter((candidate) => candidate.stage !== "archived")
  const duplicateIds = duplicateCandidateIds(activeCandidates)
  const roleTiedCandidates = activeCandidates.filter((candidate) => Boolean(candidate.inboundJobId || candidate.jobId))
  const privateBench = activeCandidates.filter((candidate) => !candidate.inboundJobId && !candidate.jobId)
  const contactedCandidates = activeCandidates.filter((candidate) => candidate.outreach?.status && candidate.outreach.status !== "not_contacted")
  const pendingConsent = submissions.filter(candidateConfirmationCanResend)
  const duplicateSubmissions = submissions.filter((submission) => submission.status === "duplicate")
  const submittedReceipts = submissions.filter((submission) => submission.status !== "duplicate")
  const title = duplicateIds.size
    ? "Clean duplicate identity before more outreach"
    : pendingConsent.length
      ? "Candidate confirmation needs follow-up"
      : submittedReceipts.length || contactedCandidates.length
        ? "Ownership trail is visible"
        : "Start every candidate with an ownership trail"
  const tone: OperatingTone = duplicateIds.size || duplicateSubmissions.length
    ? "warn"
    : pendingConsent.length
      ? "info"
      : submittedReceipts.length || contactedCandidates.length
        ? "success"
        : "mute"
  const body = duplicateIds.size
    ? "Local duplicate emails or links weaken candidate experience and can turn clean submissions into conflicts."
    : pendingConsent.length
      ? "A submitted candidate still needs confirmation before the submission has a clean consent trail."
      : submittedReceipts.length || contactedCandidates.length
        ? "Candidate activity is tied to outreach status, role lane, consent, and submission receipts."
        : "Save candidates with role, email, profile link, outreach status, and notes before any formal submission."

  return {
    label: "Ownership desk",
    title,
    body,
    tone,
    cards: [
      {
        label: "Role-tied candidates",
        value: String(roleTiedCandidates.length),
        body: `${privateBench.length} candidate${privateBench.length === 1 ? "" : "s"} remain in private bench for matchboard routing.`,
        tone: roleTiedCandidates.length ? "live" : "mute",
      },
      {
        label: "Contacted trail",
        value: `${activeCandidates.length ? Math.round((contactedCandidates.length / activeCandidates.length) * 100) : 0}%`,
        body: `${contactedCandidates.length}/${activeCandidates.length || 0} active candidates have outreach status beyond not contacted.`,
        tone: contactedCandidates.length ? "info" : "warn",
      },
      {
        label: "Consent follow-up",
        value: String(pendingConsent.length),
        body: pendingConsent.length ? "Submission confirmation is still pending or failed." : "No submitted candidate needs confirmation follow-up.",
        tone: pendingConsent.length ? "warn" : "success",
      },
      {
        label: "Conflict signals",
        value: String(duplicateIds.size + duplicateSubmissions.length),
        body: `${duplicateIds.size} local duplicate candidate${duplicateIds.size === 1 ? "" : "s"}, ${duplicateSubmissions.length} duplicate submission${duplicateSubmissions.length === 1 ? "" : "s"}.`,
        tone: duplicateIds.size + duplicateSubmissions.length ? "warn" : "success",
      },
    ],
    rules: [
      {
        label: "Source first",
        title: "Sourcing saves a private candidate record",
        body: "It does not notify the candidate and it does not create payout ownership by itself.",
        tone: "info",
      },
      {
        label: "Check lane",
        title: "Role-tied saves run a company-lane identity check",
        body: "When a role is selected, WeKruit checks candidate email and profile link against existing sourced and submitted records for that role.",
        tone: "live",
      },
      {
        label: "Consent",
        title: "Submission requires candidate consent",
        body: "The candidate confirmation trail protects ownership and prevents weak packets from entering review.",
        tone: pendingConsent.length ? "warn" : "success",
      },
      {
        label: "No duplicate outreach",
        title: "Already submitted candidates are off-limits for that company",
        body: "If the identity check finds a conflict, pick another candidate or get explicit WeKruit calibration first.",
        tone: duplicateIds.size + duplicateSubmissions.length ? "warn" : "info",
      },
    ],
  }
}

function buildCandidateSourcingCommand(candidates: RecruiterSourcedCandidateItem[]): CandidateSourcingCommand {
  const active = candidates.filter((candidate) => candidate.stage !== "archived")
  const duplicates = duplicateCandidateIds(active)
  const ready = active.filter((candidate) => candidate.stage === "ready")
  const privateBench = active.filter((candidate) => !candidate.inboundJobId && !candidate.jobId && candidate.stage !== "submitted")
  const followUps = active.filter((candidate) => candidateFollowUpState(candidate).needsAction)
  const contacted = active.filter((candidate) => candidate.outreach?.status && candidate.outreach.status !== "not_contacted")
  const submitted = candidates.filter((candidate) => candidate.stage === "submitted")
  const focus = [...active]
    .sort((a, b) => candidateSourcingPriority(b, duplicates) - candidateSourcingPriority(a, duplicates) || updatedAtMs(b) - updatedAtMs(a))[0]
  const queue = [...active]
    .filter((candidate) =>
      duplicates.has(candidate.id) ||
      candidate.stage === "ready" ||
      candidateFollowUpState(candidate).needsAction ||
      candidate.calibrationStatus === "calibration_requested" ||
      candidate.calibrationStatus === "bad_fit",
    )
    .sort((a, b) => candidateSourcingPriority(b, duplicates) - candidateSourcingPriority(a, duplicates) || updatedAtMs(b) - updatedAtMs(a))
    .slice(0, 5)
    .map((candidate) => {
      const href = candidate.stage === "ready" ? sourcedCandidateRoleHref(candidate) : undefined
      const action: CandidateSourcingAction = href ? "submit_candidate" : candidate.stage === "ready" ? "match_candidate" : "open_candidate"
      return {
        id: candidate.id,
        label: sourceStageMeta(candidate.stage).label,
        title: candidateName(candidate),
        body: candidateCommandBody(candidate, duplicates),
        tone: duplicates.has(candidate.id) ? "warn" as const : candidateFollowUpState(candidate).tone,
        action,
        ...(href ? { href } : {}),
      }
    })

  const baseCards = [
    {
      label: "Active bench",
      value: String(active.length),
      body: `${privateBench.length} private bench, ${ready.length} ready, ${submitted.length} submitted.`,
      tone: active.length ? "live" as const : "mute" as const,
    },
    {
      label: "Follow-ups due",
      value: String(followUps.length),
      body: followUps.length ? "Candidates need outreach movement." : "No stale follow-up dates.",
      tone: followUps.length ? "warn" as const : "success" as const,
    },
    {
      label: "Outreach coverage",
      value: `${active.length ? Math.round((contacted.length / active.length) * 100) : 0}%`,
      body: `${contacted.length}/${active.length || 0} active candidates have outreach status.`,
      tone: contacted.length ? "info" as const : "mute" as const,
    },
    {
      label: "Duplicate risk",
      value: String(duplicates.size),
      body: duplicates.size ? "Duplicate emails or links need cleanup before scale." : "No duplicate identity signal in this bench.",
      tone: duplicates.size ? "warn" as const : "success" as const,
    },
  ]

  if (!focus) {
    return {
      label: "Sourcing command",
      title: "Build the first candidate bench",
      body: "Paste LinkedIn profiles, attach notes, and let the matchboard rank candidates before formal submission.",
      tone: "info",
      action: "bulk_import",
      actionLabel: "Open bulk import",
      cards: baseCards,
      queue,
    }
  }

  const href = sourcedCandidateRoleHref(focus)
  let label = "Sourcing command"
  let title = `${candidateName(focus)} needs the next move`
  let body = candidateCommandBody(focus, duplicates)
  let tone: CandidateSourcingCommand["tone"] = sourceStageMeta(focus.stage).tone
  let action: CandidateSourcingAction = "open_candidate"
  let actionLabel = "Open candidate"

  if (duplicates.has(focus.id)) {
    label = "Duplicate risk"
    title = `${candidateName(focus)} may be duplicated`
    tone = "warn"
  } else if (focus.stage === "ready" && href) {
    label = "Submit next"
    title = `${candidateName(focus)} is ready for ${focus.jobTitleSnapshot || "the role"}`
    tone = "success"
    action = "submit_candidate"
    actionLabel = "Open role brief"
  } else if (focus.stage === "ready") {
    label = "Match next"
    title = `${candidateName(focus)} is ready to match`
    tone = "live"
    action = "match_candidate"
    actionLabel = "Open matchboard"
  } else if (candidateFollowUpState(focus).needsAction) {
    label = "Follow-up due"
    title = `${candidateName(focus)} needs outreach`
    tone = "warn"
  } else if (focus.outreach?.status === "responded") {
    label = "Screen next"
    title = `${candidateName(focus)} responded`
    tone = "live"
  }

  return {
    focus,
    label,
    title,
    body,
    tone,
    action,
    actionLabel,
    ...(href && action === "submit_candidate" ? { href } : {}),
    cards: baseCards,
    queue,
  }
}

type BulkCandidateDraft = {
  rowNumber: number
  raw: string
  name: string
  email?: string
  link: string
  currentRole?: string
  notes?: string
}

type BulkCandidateParseResult =
  | { ok: true; candidate: BulkCandidateDraft }
  | { ok: false; rowNumber: number; raw: string; reason: string }

type BulkCandidateImportResult = {
  rowNumber: number
  name: string
  status: "saved" | "duplicate" | "error"
  message: string
}

function cleanBulkCell(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "").trim()
}

function normalizeBulkCandidateLink(value: string): string {
  const cleaned = value.trim().replace(/[),.;]+$/g, "")
  if (/^https?:\/\//i.test(cleaned)) return cleaned
  if (/^(?:www\.|linkedin\.com\/)/i.test(cleaned)) return `https://${cleaned}`
  return cleaned
}

function inferCandidateNameFromLink(link: string): string {
  const withoutQuery = link.split(/[?#]/)[0] ?? link
  const slug = withoutQuery.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "Candidate"
  return slug
    .replace(/[-_+.]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim() || "Candidate"
}

function parseBulkCandidateLine(line: string, rowNumber: number): BulkCandidateParseResult {
  const raw = line.trim()
  if (!raw) return { ok: false, rowNumber, raw: line, reason: "Empty row" }
  const delimiter = raw.includes("\t") ? "\t" : raw.includes("|") ? "|" : raw.includes(",") ? "," : null
  const parts = delimiter
    ? raw.split(delimiter).map(cleanBulkCell).filter(Boolean)
    : [raw]
  const linkPattern = /(?:https?:\/\/|www\.|linkedin\.com\/)\S+/i
  const emailPattern = /[^\s,|;<>]+@[^\s,|;<>]+\.[^\s,|;<>]+/i
  const email = raw.match(emailPattern)?.[0]?.toLowerCase()
  const linkIndex = parts.findIndex((part) => linkPattern.test(part))
  if (linkIndex >= 0) {
    const linkMatch = parts[linkIndex]?.match(linkPattern)?.[0]
    const link = linkMatch ? normalizeBulkCandidateLink(linkMatch) : ""
    const name = cleanBulkCell(parts.slice(0, linkIndex).join(" ").replace(email ?? "", "")) || inferCandidateNameFromLink(link)
    if (!link) return { ok: false, rowNumber, raw: line, reason: "Missing LinkedIn or resume link" }
    const currentRole = cleanBulkCell(parts[linkIndex + 1] ?? "")
    const notes = parts.slice(linkIndex + 2).map(cleanBulkCell).filter((part) => part.toLowerCase() !== email).filter(Boolean).join(" · ")
    return {
      ok: true,
      candidate: {
        rowNumber,
        raw: line,
        name,
        ...(email ? { email } : {}),
        link,
        ...(currentRole ? { currentRole } : {}),
        ...(notes ? { notes } : {}),
      },
    }
  }

  const linkMatch = raw.match(linkPattern)?.[0]
  if (!linkMatch) return { ok: false, rowNumber, raw: line, reason: "Missing LinkedIn or resume link" }
  const link = normalizeBulkCandidateLink(linkMatch)
  const beforeLink = cleanBulkCell(raw.slice(0, raw.indexOf(linkMatch)).replace(email ?? "", "").replace(/[-–—|,]+$/g, ""))
  const afterLink = cleanBulkCell(raw.slice(raw.indexOf(linkMatch) + linkMatch.length).replace(/^[-–—|,]+/g, ""))
  return {
    ok: true,
    candidate: {
      rowNumber,
      raw: line,
      name: beforeLink || inferCandidateNameFromLink(link),
      ...(email ? { email } : {}),
      link,
      ...(afterLink ? { notes: afterLink } : {}),
    },
  }
}

function parseBulkCandidates(text: string): BulkCandidateParseResult[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => parseBulkCandidateLine(line, index + 1))
    .filter((row) => row.ok || row.raw.trim())
}

function jobMatchText(job: CollabJob): string {
  return [
    job.title,
    job.recruiterBoard.label.location,
    job.recruiterBoard.label.pills.map((p) => p.text).join(" "),
    job.recruiterBoard.checklist.groups.flatMap((g) => [g.heading, ...g.items.map((item) => item.text)]).join(" "),
    job.jdBlocks.map((block) => `${block.heading} ${block.body}`).join(" "),
  ].filter(Boolean).join(" ")
}

function scoreCandidateAgainstJob(
  candidate: RecruiterSourcedCandidateItem,
  job: CollabJob,
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
): CandidateRoleMatch {
  const candidateTokens = new Set(normalizeTokens(candidateMatchText(candidate)))
  const jobTokens = normalizeTokens(jobMatchText(job))
  const overlap = Array.from(new Set(jobTokens.filter((token) => candidateTokens.has(token)))).slice(0, 5)
  const stageBoost: Record<RecruiterSourcedCandidateStage, number> = {
    sourced: 3,
    contacted: 6,
    screened: 10,
    ready: 16,
    submitted: 6,
    archived: -16,
  }
  const calibrationBoost = candidate.calibrationStatus === "good_fit"
    ? 8
    : candidate.calibrationStatus === "bad_fit"
      ? -14
      : candidate.calibrationStatus === "calibration_requested"
        ? -4
        : 0
  const titleTokens = normalizeTokens(job.title)
  const titleOverlap = titleTokens.filter((token) => candidateTokens.has(token)).length
  const sourcedCount = sourcedCandidates.filter((c) => c.inboundJobId === roleKey(job) || c.jobId === roleKey(job)).length
  const submissionCount = submissions.filter((s) => s.inboundJobId === roleKey(job) || s.jobId === roleKey(job)).length
  const score = Math.max(20, Math.min(98, 42 + overlap.length * 7 + titleOverlap * 8 + (stageBoost[candidate.stage] ?? 0) + calibrationBoost - submissionCount * 3))
  const reasons = [
    ...overlap.slice(0, 3).map((token) => `Keyword: ${token}`),
    sourceStageMeta(candidate.stage).label,
    candidate.calibrationStatus ? calibrationMeta(candidate.calibrationStatus).label : "",
    submissionCount === 0 ? "No submissions yet" : "",
  ].filter(Boolean).slice(0, 4)
  return { job, score, reasons, sourcedCount, submissionCount }
}

function buildCandidateRoleMatches(
  candidate: RecruiterSourcedCandidateItem,
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
): CandidateRoleMatch[] {
  return jobs
    .map((job) => scoreCandidateAgainstJob(candidate, job, submissions, sourcedCandidates))
    .sort((a, b) => b.score - a.score)
}

function candidateSubmittedRoleIds(candidate: RecruiterSourcedCandidateItem, submissions: RecruiterSubmissionItem[]): Set<string> {
  return new Set(candidateMatchedSubmissions(candidate, submissions).map((submission) => submission.inboundJobId || submission.jobId).filter((id): id is string => Boolean(id)))
}

function buildCandidateNetworkExposure(
  jobs: CollabJob[],
  candidates: RecruiterSourcedCandidateItem[],
  submissions: RecruiterSubmissionItem[],
): CandidateNetworkExposureModel {
  const activeCandidates = candidates.filter((candidate) => candidate.stage !== "archived")
  const rows = activeCandidates.map((candidate): CandidateNetworkExposureRow => {
    const submittedRoleIds = candidateSubmittedRoleIds(candidate, submissions)
    const matches = buildCandidateRoleMatches(candidate, jobs, submissions, candidates)
      .filter((match) => !submittedRoleIds.has(roleKey(match.job)))
      .slice(0, 3)
    const topMatch = matches[0]
    const matchedSubmissions = candidateMatchedSubmissions(candidate, submissions)
    const hasIdentity = Boolean(candidate.candidate?.email && candidate.candidate?.link)
    const profileProofCount = [
      candidate.candidate?.email,
      candidate.candidate?.link,
      candidate.candidate?.currentRole,
      candidate.candidate?.yoe,
      candidate.candidate?.notes,
    ].filter(Boolean).length
    const followUp = candidateFollowUpState(candidate)
    const submitted = matchedSubmissions.length > 0 || candidate.stage === "submitted"
    let tone: CandidateNetworkExposureRow["tone"] = "info"
    let label = "Network candidate"
    let title = topMatch ? `${candidateName(candidate)} → ${topMatch.job.title}` : candidateName(candidate)
    let body = topMatch
      ? `${topMatch.score}% match for ${topMatch.job.recruiterBoard.label.company}; ${topMatch.reasons.slice(0, 2).join(" · ") || "role match"}`
      : "No strong open-role match yet. Keep the candidate warm for the next release."
    let actionLabel = topMatch ? "Open best role" : "Open candidate"
    let href = topMatch ? `/recruiters/job/${topMatch.job.jobId}?candidateId=${encodeURIComponent(candidate.id)}` : undefined

    if (!hasIdentity) {
      tone = "warn"
      label = "Proof missing"
      title = `${candidateName(candidate)} needs identity proof`
      body = `${profileProofCount}/5 profile signals captured. Add email and LinkedIn/resume before wider matching.`
      actionLabel = "Complete profile"
      href = undefined
    } else if (candidate.calibrationStatus === "bad_fit") {
      tone = "warn"
      label = "Hold exposure"
      title = `${candidateName(candidate)} needs calibration`
      body = candidate.calibrationNote || "Marked not a fit. Do not rematch this candidate until the calibration issue is resolved."
      actionLabel = "Open candidate"
      href = undefined
    } else if (submitted && topMatch) {
      tone = topMatch.score >= 70 ? "success" : "info"
      label = "Reusable pipeline"
      title = `${candidateName(candidate)} can be reused`
      body = `Already has ${matchedSubmissions.length} submission signal${matchedSubmissions.length === 1 ? "" : "s"}; next best role is ${topMatch.job.title}.`
      actionLabel = "Review next role"
    } else if (candidate.stage === "ready" && topMatch) {
      tone = topMatch.score >= 70 ? "live" : "info"
      label = "Ready for network"
      title = `${candidateName(candidate)} is ready for ${topMatch.job.title}`
      body = `Candidate has identity proof and is ready for a candidate-led role match.`
      actionLabel = "Submit from role"
    } else if (followUp.needsAction) {
      tone = followUp.tone
      label = "Warmth risk"
      title = `${candidateName(candidate)} needs follow-up`
      body = `${followUp.body} Best available role: ${topMatch?.job.title ?? "none yet"}.`
      actionLabel = topMatch ? "Open role match" : "Open candidate"
    } else if (topMatch && topMatch.score >= 72) {
      tone = "live"
      label = "Strong suggested fit"
      title = `${candidateName(candidate)} has a ${topMatch.score}% network match`
      actionLabel = "Open match"
    } else if (!topMatch) {
      tone = "mute"
      label = "No role yet"
    }

    return {
      candidate,
      tone,
      label,
      title,
      body,
      actionLabel,
      ...(href ? { href } : {}),
      matches,
    }
  })
  const sortedRows = rows
    .sort((a, b) => {
      const score = (row: CandidateNetworkExposureRow) => (
        row.tone === "live" ? 100 :
        row.tone === "success" ? 86 :
        row.tone === "warn" ? 76 :
        row.tone === "info" ? 58 :
        20
      ) + (row.matches[0]?.score ?? 0)
      return score(b) - score(a) || updatedAtMs(b.candidate) - updatedAtMs(a.candidate)
    })
    .slice(0, 6)
  const readyForNetwork = rows.filter((row) => row.tone === "live" || row.tone === "success").length
  const suggestedMatches = rows.reduce((sum, row) => sum + row.matches.filter((match) => match.score >= 64).length, 0)
  const proofMissing = rows.filter((row) => row.label === "Proof missing").length
  const reusablePipeline = rows.filter((row) => row.label === "Reusable pipeline").length
  const title = readyForNetwork
    ? `${readyForNetwork} candidate${readyForNetwork === 1 ? "" : "s"} ready for wider role exposure`
    : proofMissing
      ? "Complete candidate proof before network exposure"
      : "Build candidate inventory for future role releases"
  const body = readyForNetwork
    ? "Use saved candidates across WeKruit collab roles instead of treating every role as a cold-start search."
    : proofMissing
      ? "Email, LinkedIn/resume, and notes are what make a candidate reusable across the recruiter marketplace."
      : "Save prospects into the private bench so new roles can be matched against existing recruiter supply."
  return {
    tone: readyForNetwork ? "live" : proofMissing ? "warn" : activeCandidates.length ? "info" : "mute",
    label: "Candidate network",
    title,
    body,
    cards: [
      {
        label: "Exposure ready",
        value: String(readyForNetwork),
        body: "Candidates with proof and strong role-match signal.",
        tone: readyForNetwork ? "live" : "mute",
      },
      {
        label: "Suggested role fits",
        value: String(suggestedMatches),
        body: "Open-role matches at 64%+ across your candidate bench.",
        tone: suggestedMatches ? "success" : "mute",
      },
      {
        label: "Needs proof",
        value: String(proofMissing),
        body: "Candidates missing email or LinkedIn/resume before wider matching.",
        tone: proofMissing ? "warn" : "success",
      },
      {
        label: "Reusable pipeline",
        value: String(reusablePipeline),
        body: "Submitted candidates with possible next role matches.",
        tone: reusablePipeline ? "info" : "mute",
      },
    ],
    rows: sortedRows,
  }
}

function buildCandidateOutreachStudio(
  candidate: RecruiterSourcedCandidateItem,
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
): CandidateOutreachStudio {
  const matches = buildCandidateRoleMatches(candidate, jobs, submissions, sourcedCandidates)
  const topMatch = matches[0]
  const job = topMatch?.job
  const name = candidateName(candidate)
  const firstName = name.split(/\s+/)[0] || "there"
  const currentRole = candidate.candidate?.currentRole || "your work"
  const company = job?.recruiterBoard.label.company || "a WeKruit partner company"
  const roleTitle = job?.title || "a role I think could fit"
  const location = job?.recruiterBoard.label.location || "the right location"
  const roleHook = job?.recruiterBoard.culture.bet || "a team with a serious hiring need and clear ownership"
  const comp = job ? roleCandidateCompLabel(job) : "Compensation can be calibrated before a formal submission."
  const reasons = topMatch?.reasons.filter((reason) => !/sourced|submitted/i.test(reason)).slice(0, 2) ?? []
  const personalization = [
    candidate.candidate?.notes ? shortText(candidate.candidate.notes, "", 140) : "",
    candidate.candidate?.yoe ? `${candidate.candidate.yoe} YOE` : "",
    currentRole !== "your work" ? currentRole : "",
    ...reasons,
  ].filter(Boolean).slice(0, 3)
  const followUp = candidateFollowUpState(candidate)
  const hasIdentity = Boolean(candidate.candidate?.email && candidate.candidate?.link)
  const matchLabel = topMatch ? `${topMatch.score}%` : "No match"
  const title = job
    ? `${name} outreach for ${roleTitle}`
    : `${name} needs a role before outreach`
  const body = job
    ? `Use a three-touch sequence that sells ${company}, keeps the candidate warm, and leaves room for other WeKruit roles.`
    : "Match this candidate to an active role before sending specific outreach."
  const tone: OperatingTone = !hasIdentity
    ? "warn"
    : topMatch && topMatch.score >= 72
      ? "live"
      : topMatch
        ? "info"
        : "mute"
  const subject = job
    ? `${firstName}, ${company} ${roleTitle}`
    : `${firstName}, quick WeKruit role check`
  const introProof = personalization.length
    ? `I noticed ${personalization.join(", ")}.`
    : `Your background around ${currentRole} looked relevant.`
  const fitLine = job
    ? `${company} is hiring ${roleTitle} in ${location}. ${roleHook}`
    : "I am mapping a few WeKruit searches and wanted to check what would actually be interesting before sending anything formal."
  const optionLine = job
    ? "If this role is not the right fit, I can keep you in mind for other WeKruit partner roles instead of forcing one search."
    : "If there is a better direction, I can keep this broader and only send roles that match your actual preferences."
  const touches: CandidateOutreachTouch[] = [
    {
      id: "email-1",
      label: "Touch 1",
      channel: "Email",
      title: subject,
      body: [
        `Hi ${firstName},`,
        "",
        introProof,
        fitLine,
        comp !== "Not shared" ? `Comp signal: ${comp}.` : "",
        "",
        "Worth a quick 10 minutes to compare this against what you would actually leave for?",
      ].filter(Boolean).join("\n"),
      tone: topMatch && topMatch.score >= 72 ? "live" : "info",
    },
    {
      id: "follow-up",
      label: "Touch 2",
      channel: "Follow-up",
      title: `Re: ${subject}`,
      body: [
        `Hi ${firstName}, quick follow-up.`,
        "",
        `The reason I flagged ${roleTitle} is the combination of ${roleHook.toLowerCase()} and your background in ${currentRole}.`,
        optionLine,
        "",
        "Open to me sending the cleaner brief?",
      ].join("\n"),
      tone: "info",
    },
    {
      id: "linkedin",
      label: "Touch 3",
      channel: "LinkedIn",
      title: `${roleTitle} / WeKruit`,
      body: `Hi ${firstName}, I am working on ${roleTitle} for ${company}. Your ${currentRole} background stood out. Open to a quick exchange? If not this one, I can route you to better-fit WeKruit roles.`,
      tone: "mute",
    },
  ]

  return {
    label: "Outreach studio",
    title,
    body,
    tone,
    ...(job ? { roleHref: `/recruiters/job/${job.jobId}?candidateId=${encodeURIComponent(candidate.id)}` } : {}),
    cards: [
      {
        label: "Best role",
        value: job ? roleTitle : "Match first",
        body: job ? `${company} · ${location}` : "Use Matchboard before sending role-specific outreach.",
        tone: job ? "live" : "mute",
      },
      {
        label: "Fit score",
        value: matchLabel,
        body: reasons.length ? reasons.join(" · ") : "No strong role proof yet.",
        tone: topMatch && topMatch.score >= 72 ? "success" : topMatch ? "info" : "mute",
      },
      {
        label: "Personalization",
        value: `${personalization.length}/3`,
        body: personalization.length ? personalization.join(" · ") : "Add notes, YOE, or current role before outreach.",
        tone: personalization.length >= 2 ? "success" : personalization.length ? "info" : "warn",
      },
      {
        label: "Follow-up state",
        value: followUp.label,
        body: followUp.body,
        tone: followUp.tone,
      },
    ],
    touches,
    screening: [
      `What would make ${roleTitle} worth exploring right now?`,
      "What compensation, location, or work-model constraint should I not ignore?",
      `Which current projects map closest to ${job?.recruiterBoard.checklist.groups.find((group) => group.kind === "hard")?.items[0]?.text || "the hard requirements"}?`,
      "Do I have your permission to submit your profile if the role is a fit after the screen?",
    ],
  }
}

function candidateMatchedSubmissions(candidate: RecruiterSourcedCandidateItem, submissions: RecruiterSubmissionItem[]): RecruiterSubmissionItem[] {
  const email = candidate.candidate?.email?.trim().toLowerCase()
  const link = candidate.candidate?.link?.trim().toLowerCase()
  return submissions.filter((submission) => {
    if (submission.sourcedCandidateId && (submission.sourcedCandidateId === candidate.id || submission.sourcedCandidateId === candidate.candidateId)) return true
    if (email && submission.candidate?.email?.trim().toLowerCase() === email) return true
    if (link && submission.candidate?.link?.trim().toLowerCase() === link) return true
    return false
  })
}

function buildCandidateMatchCommand(
  candidate: RecruiterSourcedCandidateItem,
  matches: CandidateRoleMatch[],
  submissions: RecruiterSubmissionItem[],
  primaryRoleIds: string[],
): CandidateMatchCommand {
  const topMatch = matches[0]
  const matchedSubmissions = candidateMatchedSubmissions(candidate, submissions)
  const stage = sourceStageMeta(candidate.stage)
  const profileItems = [
    candidate.candidate?.email,
    candidate.candidate?.link,
    candidate.candidate?.currentRole,
    candidate.candidate?.yoe,
    candidate.candidate?.notes,
  ].filter(Boolean).length
  const hasCandidateIdentity = Boolean(candidate.candidate?.email && candidate.candidate?.link)
  const topRoleHref = topMatch ? `/recruiters/job/${topMatch.job.jobId}?candidateId=${encodeURIComponent(candidate.id)}` : "/recruiters?tab=roles"
  const topRolePrimary = topMatch ? isPrimaryRole(topMatch.job, primaryRoleIds) : false
  let tone: CandidateMatchCommand["tone"] = "info"
  let label = "Candidate command"
  let title = topMatch ? `Best role: ${topMatch.job.title}` : "No open role match yet"
  let body = topMatch
    ? "Open the strongest role brief, verify hard checks, then submit with candidate consent."
    : "Save richer candidate notes or wait for a matching WeKruit collab role."
  let actionLabel = topMatch ? "Open best brief" : "Browse roles"
  let actionHref = topRoleHref

  if (matchedSubmissions.length > 0 || candidate.stage === "submitted") {
    tone = "success"
    label = "Already in pipeline"
    title = `${candidateName(candidate)} has an active submission signal`
    body = "Track status, consent confirmation, and feedback before sending lookalike candidates."
    actionLabel = "Track submission"
    actionHref = "/recruiters?tab=submissions"
  } else if (!hasCandidateIdentity) {
    tone = "warn"
    label = "Profile proof missing"
    title = "Add email and LinkedIn before submission"
    body = "WeKruit needs candidate identity and consent confirmation before this can become a clean submission."
    actionLabel = "Open candidate CRM"
    actionHref = "/recruiters?tab=candidates"
  } else if (candidate.stage === "ready" && topMatch) {
    tone = topMatch.score >= 70 ? "live" : "info"
    label = "Submit next"
    title = `${candidateName(candidate)} is ready for ${topMatch.job.title}`
    body = topRolePrimary
      ? "Approved role access is available. Verify hard checks and submit from the role brief."
      : "This is a candidate-led opportunity. Use a single-submit credit only if the hard checks are strong."
    actionLabel = "Submit from brief"
  } else if (topMatch && topMatch.score >= 72) {
    tone = "live"
    label = "Strong match"
    title = `${topMatch.score}% fit for ${topMatch.job.title}`
    body = "Screen the candidate against hard checks, mark ready, then submit from the role brief."
    actionLabel = "Open role fit"
  } else if (topMatch) {
    tone = "info"
    label = "Needs screening"
    title = `${candidateName(candidate)} needs more proof`
    body = "The match is plausible, but recruiter notes and hard-check evidence need to improve before submission."
    actionLabel = "Review best role"
  }

  return {
    tone,
    label,
    title,
    body,
    actionLabel,
    actionHref,
    cards: [
      {
        label: "Candidate stage",
        value: stage.label,
        body: candidate.outreach?.status ? `${outreachMeta(candidate.outreach.status).label} outreach` : "No outreach status captured yet.",
        tone: stage.tone,
        href: "/recruiters?tab=candidates",
      },
      {
        label: "Best role",
        value: topMatch ? `${topMatch.score}%` : "None",
        body: topMatch ? `${topMatch.job.title} · ${topMatch.job.recruiterBoard.label.company}` : "No live role can be ranked yet.",
        tone: topMatch ? topMatch.score >= 72 ? "live" : topMatch.score >= 58 ? "info" : "mute" : "mute",
        href: topMatch ? topRoleHref : "/recruiters?tab=roles",
      },
      {
        label: "Access lane",
        value: topMatch ? topRolePrimary ? "Approved" : "Single-submit" : "No lane",
        body: topMatch
          ? topRolePrimary
            ? "Trusted role access is available for this candidate."
            : "Submit only when the candidate-led proof is strong."
          : "Browse roles or wait for a better market fit.",
        tone: topRolePrimary ? "success" : topMatch ? "warn" : "mute",
        href: topMatch ? topRoleHref : "/recruiters?tab=access",
      },
      {
        label: "Profile proof",
        value: `${profileItems}/5`,
        body: hasCandidateIdentity ? "Email and link are present for consent workflow." : "Email and LinkedIn/resume are required.",
        tone: hasCandidateIdentity ? profileItems >= 4 ? "success" : "info" : "warn",
        href: "/recruiters?tab=candidates",
      },
    ],
  }
}

function MatchboardTab({
  jobs,
  candidates,
  submissions,
  primaryRoleIds,
}: {
  jobs: CollabJob[]
  candidates: RecruiterSourcedCandidateItem[]
  submissions: RecruiterSubmissionItem[]
  primaryRoleIds: string[]
}) {
  const activeCandidates = useMemo(
    () => sortSourcedCandidates(candidates.filter((candidate) => candidate.stage !== "archived")),
    [candidates],
  )
  const [selectedId, setSelectedId] = useState<string>("")
  const selectedCandidate = activeCandidates.find((candidate) => candidate.id === selectedId) ?? activeCandidates[0]
  const matches = useMemo(
    () => selectedCandidate ? buildCandidateRoleMatches(selectedCandidate, jobs, submissions, candidates).slice(0, 8) : [],
    [candidates, jobs, selectedCandidate, submissions],
  )
  const command = useMemo(
    () => selectedCandidate ? buildCandidateMatchCommand(selectedCandidate, matches, submissions, primaryRoleIds) : null,
    [matches, primaryRoleIds, selectedCandidate, submissions],
  )

  useEffect(() => {
    if (!selectedId && activeCandidates[0]) setSelectedId(activeCandidates[0].id)
    if (selectedId && !activeCandidates.some((candidate) => candidate.id === selectedId)) {
      setSelectedId(activeCandidates[0]?.id ?? "")
    }
  }, [activeCandidates, selectedId])

  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Candidate-to-role matchboard</h2><p>Pick a saved prospect, compare open roles, then submit from the strongest brief.</p></div>
      </header>
      {activeCandidates.length === 0 ? (
        <p className="rb-empty">Save sourced candidates first. The matchboard needs candidate notes or a LinkedIn/resume link to rank open roles.</p>
      ) : (
        <div className="rb-matchboard">
          <aside className="rb-matchboard__candidates" aria-label="Saved candidates">
            {activeCandidates.map((candidate) => {
              const stage = sourceStageMeta(candidate.stage)
              const topMatch = buildCandidateRoleMatches(candidate, jobs, submissions, candidates)[0]
              return (
                <button
                  key={candidate.id}
                  type="button"
                  className={selectedCandidate?.id === candidate.id ? "is-active" : ""}
                  onClick={() => setSelectedId(candidate.id)}
                >
                  <span className="rb-candidate-dot">{candidateName(candidate).slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>{candidateName(candidate)}</strong>
                    <em>{candidate.candidate?.currentRole || candidate.jobTitleSnapshot || "Candidate"}</em>
                    <small>{stage.label}{topMatch ? ` - ${topMatch.score}% top match` : ""}</small>
                  </span>
                </button>
              )
            })}
          </aside>
          <div className="rb-matchboard__main">
            {selectedCandidate && command && <CandidateMatchCommandPanel candidate={selectedCandidate} command={command} matches={matches} />}
            <div className="rb-match-list">
              {matches.map((match) => (
                <CandidateRoleMatchRow
                  key={match.job.jobId}
                  match={match}
                  candidate={selectedCandidate}
                  primary={isPrimaryRole(match.job, primaryRoleIds)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function CandidateMatchCommandPanel({
  candidate,
  command,
  matches,
}: {
  candidate: RecruiterSourcedCandidateItem
  command: CandidateMatchCommand
  matches: CandidateRoleMatch[]
}) {
  return (
    <section className={`rb-match-command is-${command.tone}`} aria-label="Candidate match command">
      <div className="rb-match-command__mission">
        <div>
          <span className="rb-candidate-dot">{candidateName(candidate).slice(0, 1).toUpperCase()}</span>
          <span>
            <em>{command.label}</em>
            <strong>{command.title}</strong>
          </span>
        </div>
        <p>{command.body}</p>
        <Link to={command.actionHref}>{command.actionLabel}</Link>
      </div>

      <div className="rb-match-command__cards">
        {command.cards.map((card) => {
          const body = (
            <>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <em>{card.body}</em>
            </>
          )
          return card.href ? (
            <Link className={`is-${card.tone}`} to={card.href} key={card.label}>{body}</Link>
          ) : (
            <article className={`is-${card.tone}`} key={card.label}>{body}</article>
          )
        })}
      </div>

      <div className="rb-match-command__shortlist">
        <span>Top role shortlist</span>
        <div>
          {matches.slice(0, 3).map((match) => (
            <Link key={match.job.jobId} to={`/recruiters/job/${match.job.jobId}?candidateId=${encodeURIComponent(candidate.id)}`}>
              <strong>{match.job.title}</strong>
              <em>{match.score}% · {match.reasons.slice(0, 2).join(" · ") || "Role match"}</em>
            </Link>
          ))}
          {matches.length === 0 && <p>No live roles can be ranked for this candidate.</p>}
        </div>
      </div>
    </section>
  )
}

function CandidateRoleMatchRow({
  match,
  candidate,
  primary,
}: {
  match: CandidateRoleMatch
  candidate?: RecruiterSourcedCandidateItem
  primary: boolean
}) {
  return (
    <article className="rb-match-row">
      <div className="rb-match-row__score">
        <strong>{match.score}%</strong>
        <span>fit</span>
      </div>
      <div className="rb-match-row__body">
        <h3>{match.job.title}</h3>
        <p>{match.job.recruiterBoard.label.company} - {match.job.recruiterBoard.label.location}</p>
        <div>
          {match.reasons.map((reason) => <span key={reason}>{reason}</span>)}
        </div>
      </div>
      <div className="rb-match-row__meta">
        <strong>{primary ? "Approved access" : "Single submission"}</strong>
        <span>{match.sourcedCount} sourced</span>
        <span>{match.submissionCount} submitted</span>
        <Link to={`/recruiters/job/${match.job.jobId}${candidate ? `?candidateId=${encodeURIComponent(candidate.id)}` : ""}`}>
          Open brief
        </Link>
      </div>
    </article>
  )
}

function CandidatesTab({
  jobs,
  candidates,
  submissions,
  onSaved,
}: {
  jobs: CollabJob[]
  candidates: RecruiterSourcedCandidateItem[]
  submissions: RecruiterSubmissionItem[]
  onSaved: (candidate: RecruiterSourcedCandidateItem) => void
}) {
  const [form, setForm] = useState<RecruiterSourcedCandidateInput>(() => ({
    jobId: "",
    stage: "sourced",
    candidate: { name: "", email: "", link: "", currentRole: "", yoe: "", notes: "" },
    outreach: { status: "not_contacted" },
  }))
  const [saving, setSaving] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [calibratingId, setCalibratingId] = useState<string | null>(null)
  const [calibrationDrafts, setCalibrationDrafts] = useState<Record<string, string>>({})
  const [bulkText, setBulkText] = useState("")
  const [bulkImporting, setBulkImporting] = useState(false)
  const [bulkResults, setBulkResults] = useState<BulkCandidateImportResult[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [identityChecking, setIdentityChecking] = useState(false)
  const [identityCheck, setIdentityCheck] = useState<CandidateIdentityCheckState | null>(null)
  const command = useMemo(() => buildCandidateSourcingCommand(candidates), [candidates])
  const ownershipDesk = useMemo(
    () => buildCandidateOwnershipDesk(candidates, submissions),
    [candidates, submissions],
  )
  const networkExposure = useMemo(
    () => buildCandidateNetworkExposure(jobs, candidates, submissions),
    [candidates, jobs, submissions],
  )
  const activeCandidates = useMemo(
    () => sortSourcedCandidates(candidates.filter((candidate) => candidate.stage !== "archived")),
    [candidates],
  )
  const [selectedCandidateId, setSelectedCandidateId] = useState("")
  const selectedCandidate = activeCandidates.find((candidate) => candidate.id === selectedCandidateId) ?? command.focus ?? activeCandidates[0]
  const selectedFormJob = jobs.find((job) => job.jobId === form.jobId)

  useEffect(() => {
    const nextCandidate = command.focus ?? activeCandidates[0]
    if (!selectedCandidateId && nextCandidate) setSelectedCandidateId(nextCandidate.id)
    if (selectedCandidateId && !activeCandidates.some((candidate) => candidate.id === selectedCandidateId)) {
      setSelectedCandidateId(nextCandidate?.id ?? "")
    }
  }, [activeCandidates, command.focus, selectedCandidateId])

  useEffect(() => {
    setIdentityCheck(null)
  }, [form.jobId, form.candidate.email, form.candidate.link])

  const runIdentityCheck = async (): Promise<CandidateIdentityCheckState | null> => {
    const selectedJobId = form.jobId?.trim()
    const link = form.candidate.link.trim()
    const email = form.candidate.email?.trim().toLowerCase() || undefined
    if (!selectedJobId) {
      const state: CandidateIdentityCheckState = {
        status: "error",
        title: "Select a role first",
        body: "Role-specific ownership checks only run when this candidate is tied to a WeKruit collab role.",
        tone: "info",
      }
      setIdentityCheck(state)
      return null
    }
    if (!link) {
      const state: CandidateIdentityCheckState = {
        status: "error",
        title: "Profile link required",
        body: "Add a LinkedIn or resume link before checking candidate ownership.",
        tone: "warn",
      }
      setIdentityCheck(state)
      return null
    }
    setIdentityChecking(true)
    setErr(null)
    try {
      const result = await checkRecruiterCandidateIdentity({
        jobId: selectedJobId,
        candidate: {
          ...(email ? { email } : {}),
          link,
        },
      })
      const state: CandidateIdentityCheckState = result.conflict
        ? identityConflictCopy(result.conflict)
        : {
            status: "clear",
            title: "No role conflict found",
            body: "No existing sourced or submitted candidate matched this email/link for the selected role. You still need consent before formal submission.",
            tone: "success",
          }
      setIdentityCheck(state)
      return state
    } catch (error) {
      const state: CandidateIdentityCheckState = {
        status: "error",
        title: "Ownership check failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "warn",
      }
      setIdentityCheck(state)
      return null
    } finally {
      setIdentityChecking(false)
    }
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    try {
      const selectedJobId = form.jobId?.trim()
      if (selectedJobId) {
        const check = await runIdentityCheck()
        if (!check || check.status !== "clear") {
          setErr(check?.body ?? "Resolve the ownership check before saving this candidate to a role lane.")
          return
        }
      }
      const saved = await saveRecruiterSourcedCandidate({
        ...(selectedJobId ? { jobId: selectedJobId } : {}),
        stage: form.stage,
        ...(form.outreach ? { outreach: form.outreach } : {}),
        candidate: {
          name: form.candidate.name.trim(),
          email: form.candidate.email?.trim().toLowerCase() || undefined,
          link: form.candidate.link.trim(),
          currentRole: form.candidate.currentRole?.trim() || undefined,
          yoe: form.candidate.yoe?.trim() || undefined,
          notes: form.candidate.notes?.trim() || undefined,
        },
      })
      onSaved(saved)
      setForm({
        jobId: selectedJobId || "",
        stage: "sourced",
        candidate: { name: "", email: "", link: "", currentRole: "", yoe: "", notes: "" },
        outreach: { status: "not_contacted" },
      })
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const grouped = SOURCE_STAGES.map((stage) => ({
    ...stage,
    candidates: candidates.filter((c) => c.stage === stage.id),
  }))

  const bulkParsedRows = useMemo(() => parseBulkCandidates(bulkText), [bulkText])
  const bulkValidRows = bulkParsedRows.filter((row): row is { ok: true; candidate: BulkCandidateDraft } => row.ok)
  const bulkInvalidRows = bulkParsedRows.filter((row): row is { ok: false; rowNumber: number; raw: string; reason: string } => !row.ok)

  const openCandidate = (candidateId: string) => {
    setSelectedCandidateId(candidateId)
    document.getElementById(sourcedCandidateDomId(candidateId))?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  const openBulkImport = () => {
    document.getElementById("bulk-import-candidates")?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const updateStage = async (candidate: RecruiterSourcedCandidateItem, stage: RecruiterSourcedCandidateStage) => {
    const jobId = candidate.inboundJobId || candidate.jobId || ""
    const link = candidate.candidate?.link?.trim()
    if (!link) {
      setErr("This saved candidate is missing the link needed to update it.")
      return
    }
    setUpdatingId(candidate.id)
    setErr(null)
    try {
      const saved = await saveRecruiterSourcedCandidate({
        candidateId: candidate.candidateId || candidate.id,
        ...(jobId ? { jobId } : {}),
        stage,
        candidate: {
          name: candidate.candidate?.name || candidateName(candidate),
          email: candidate.candidate?.email,
          link,
          currentRole: candidate.candidate?.currentRole,
          yoe: candidate.candidate?.yoe,
          notes: candidate.candidate?.notes,
        },
        outreach: candidate.outreach,
      })
      onSaved(saved)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setUpdatingId(null)
    }
  }

  const importBulkCandidates = async () => {
    if (bulkValidRows.length === 0) {
      setBulkResults(bulkInvalidRows.map((row) => ({
        rowNumber: row.rowNumber,
        name: `Row ${row.rowNumber}`,
        status: "error",
        message: row.reason,
      })))
      return
    }
    const rowsToImport = bulkValidRows.slice(0, 25)
    const nextResults: BulkCandidateImportResult[] = bulkInvalidRows.map((row) => ({
      rowNumber: row.rowNumber,
      name: `Row ${row.rowNumber}`,
      status: "error",
      message: row.reason,
    }))
    setBulkImporting(true)
    setErr(null)
    setBulkResults([])
    try {
      const selectedJobId = form.jobId?.trim()
      for (const row of rowsToImport) {
        try {
          const saved = await saveRecruiterSourcedCandidate({
            ...(selectedJobId ? { jobId: selectedJobId } : {}),
            stage: "sourced",
            candidate: {
              name: row.candidate.name,
              email: row.candidate.email,
              link: row.candidate.link,
              currentRole: row.candidate.currentRole,
              notes: row.candidate.notes,
            },
          })
          onSaved(saved)
          nextResults.push({
            rowNumber: row.candidate.rowNumber,
            name: row.candidate.name,
            status: "saved",
            message: selectedJobId ? "Saved to role pipeline" : "Saved to candidate bench",
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          nextResults.push({
            rowNumber: row.candidate.rowNumber,
            name: row.candidate.name,
            status: message.includes("already sourced") ? "duplicate" : "error",
            message,
          })
        }
        setBulkResults([...nextResults].sort((a, b) => a.rowNumber - b.rowNumber))
      }
      if (nextResults.every((result) => result.status === "saved")) {
        if (bulkValidRows.length > rowsToImport.length) {
          const importedRows = new Set(rowsToImport.map((row) => row.candidate.rowNumber))
          setBulkText(bulkParsedRows
            .filter((row) => !row.ok || !importedRows.has(row.candidate.rowNumber))
            .map((row) => row.ok ? row.candidate.raw : row.raw)
            .join("\n"))
        } else {
          setBulkText("")
        }
      }
    } finally {
      setBulkImporting(false)
    }
  }

  const requestCalibration = async (candidate: RecruiterSourcedCandidateItem) => {
    const jobId = candidate.inboundJobId || candidate.jobId || ""
    const link = candidate.candidate?.link?.trim()
    if (!jobId || !link) {
      setErr("This saved candidate is missing the role or link needed for calibration.")
      return
    }
    setCalibratingId(candidate.id)
    setErr(null)
    try {
      const note = calibrationDrafts[candidate.id]?.trim()
      const saved = await saveRecruiterSourcedCandidate({
        candidateId: candidate.candidateId || candidate.id,
        jobId,
        stage: candidate.stage,
        candidate: {
          name: candidate.candidate?.name || candidateName(candidate),
          email: candidate.candidate?.email,
          link,
          currentRole: candidate.candidate?.currentRole,
          yoe: candidate.candidate?.yoe,
          notes: candidate.candidate?.notes,
        },
        outreach: candidate.outreach,
        calibrationRequest: {
          note: note || undefined,
        },
      })
      onSaved(saved)
      setCalibrationDrafts((next) => {
        const copy = { ...next }
        delete copy[candidate.id]
        return copy
      })
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setCalibratingId(null)
    }
  }

  const updateOutreach = async (
    candidate: RecruiterSourcedCandidateItem,
    patch: { status?: RecruiterCandidateOutreachStatus; nextFollowUpAt?: string | null },
  ) => {
    const jobId = candidate.inboundJobId || candidate.jobId || ""
    const link = candidate.candidate?.link?.trim()
    if (!link) {
      setErr("This saved candidate is missing the link needed to update outreach.")
      return
    }
    setUpdatingId(candidate.id)
    setErr(null)
    try {
      const outreach = {
        status: patch.status ?? candidate.outreach?.status ?? "not_contacted",
        nextFollowUpAt: patch.nextFollowUpAt !== undefined ? patch.nextFollowUpAt : candidate.outreach?.nextFollowUpAt ?? null,
      }
      const saved = await saveRecruiterSourcedCandidate({
        candidateId: candidate.candidateId || candidate.id,
        ...(jobId ? { jobId } : {}),
        stage: candidate.stage,
        candidate: {
          name: candidate.candidate?.name || candidateName(candidate),
          email: candidate.candidate?.email,
          link,
          currentRole: candidate.candidate?.currentRole,
          yoe: candidate.candidate?.yoe,
          notes: candidate.candidate?.notes,
        },
        outreach,
      })
      onSaved(saved)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Candidate CRM</h2><p>Build a private candidate bench first. Attach a role now only when you already know the best brief.</p></div>
      </header>
      <CandidateSourcingCommandPanel
        command={command}
        onOpenCandidate={openCandidate}
        onOpenBulkImport={openBulkImport}
      />
      <CandidateNetworkExposurePanel
        model={networkExposure}
        onOpenCandidate={openCandidate}
      />
      <CandidateOwnershipDeskPanel model={ownershipDesk} />
      {selectedCandidate && (
        <>
          <CandidateDossierPanel
            candidate={selectedCandidate}
            jobs={jobs}
            candidates={candidates}
            submissions={submissions}
          />
          <CandidateOutreachStudioPanel
            candidate={selectedCandidate}
            jobs={jobs}
            candidates={candidates}
            submissions={submissions}
          />
        </>
      )}
      <div className="rb-candidate-crm">
        <div className="rb-candidate-tools">
          <form className="rb-source-form" onSubmit={save}>
            <h3>Save sourced candidate</h3>
            <label>
              <span>Role</span>
              <select value={form.jobId ?? ""} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
                <option value="">Private bench - match later</option>
                {jobs.map((job) => (
                  <option key={job.jobId} value={job.jobId}>{job.title} · {job.recruiterBoard.label.company}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Candidate name</span>
              <input
                value={form.candidate.name}
                onChange={(e) => setForm({ ...form, candidate: { ...form.candidate, name: e.target.value } })}
                required
              />
            </label>
            <label>
              <span>Candidate email</span>
              <input
                type="email"
                value={form.candidate.email ?? ""}
                onChange={(e) => setForm({ ...form, candidate: { ...form.candidate, email: e.target.value } })}
                placeholder="candidate@company.com"
              />
            </label>
            <label>
              <span>LinkedIn / resume</span>
              <input
                value={form.candidate.link}
                onChange={(e) => setForm({ ...form, candidate: { ...form.candidate, link: e.target.value } })}
                placeholder="https://linkedin.com/in/..."
                required
              />
            </label>
            <section className={`rb-identity-check${identityCheck ? ` is-${identityCheck.tone}` : ""}`} aria-label="Candidate ownership check">
              <div>
                <span>Ownership check</span>
                <strong>{identityCheck?.title ?? (selectedFormJob ? "Check before saving to role" : "Private bench has no company claim")}</strong>
                <p>
                  {identityCheck?.body ??
                    (selectedFormJob
                      ? `${selectedFormJob.title} · ${selectedFormJob.recruiterBoard.label.company}. Check email/link against existing sourced and submitted records for this role.`
                      : "Select a role when you are claiming a specific company lane. Private bench candidates can be matched later.")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void runIdentityCheck()}
                disabled={identityChecking || !form.jobId || !form.candidate.link.trim()}
              >
                {identityChecking ? "Checking..." : identityCheck?.status === "clear" ? "Recheck ownership" : "Check ownership"}
              </button>
            </section>
            <div className="rb-source-form__split">
              <label>
                <span>Current role</span>
                <input
                  value={form.candidate.currentRole ?? ""}
                  onChange={(e) => setForm({ ...form, candidate: { ...form.candidate, currentRole: e.target.value } })}
                />
              </label>
              <label>
                <span>Stage</span>
                <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as RecruiterSourcedCandidateStage })}>
                  {SOURCE_STAGES.filter((s) => s.id !== "submitted").map((stage) => (
                    <option key={stage.id} value={stage.id}>{stage.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="rb-source-form__split">
              <label>
                <span>Outreach status</span>
                <select
                  value={form.outreach?.status ?? "not_contacted"}
                  onChange={(e) => setForm({
                    ...form,
                    outreach: { ...form.outreach, status: e.target.value as RecruiterCandidateOutreachStatus },
                  })}
                >
                  {OUTREACH_STATUSES.map((status) => (
                    <option key={status.id} value={status.id}>{status.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Next follow-up</span>
                <input
                  type="date"
                  value={isoToDateInput(form.outreach?.nextFollowUpAt)}
                  onChange={(e) => setForm({
                    ...form,
                    outreach: { ...form.outreach, nextFollowUpAt: dateInputToIso(e.target.value) },
                  })}
                />
              </label>
            </div>
            <label>
              <span>Recruiter note</span>
              <textarea
                value={form.candidate.notes ?? ""}
                onChange={(e) => setForm({ ...form, candidate: { ...form.candidate, notes: e.target.value } })}
                placeholder="Why this person fits, warm intro status, compensation notes..."
              />
            </label>
            {err && <p className="rb-access__err">{err}</p>}
            <button className="rb-btn primary rb-btn--block" disabled={saving}>
              {saving ? "Saving..." : "Save to candidate bench"}
            </button>
          </form>

          <section id="bulk-import-candidates" className="rb-bulk-import" aria-label="Bulk import candidates">
            <div>
              <h3>Bulk import</h3>
              <p>Paste one candidate per line. Leave role on Private bench to rank them on the matchboard later.</p>
            </div>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={"Ada Lovelace, https://linkedin.com/in/ada, Staff Engineer, Strong backend fit\nGrace Hopper | linkedin.com/in/grace | Platform lead"}
            />
            <div className="rb-bulk-import__meta">
              <span>{bulkValidRows.length} valid</span>
              <span>{bulkInvalidRows.length} needs fix</span>
              {bulkValidRows.length > 25 && <span>Only first 25 import at once</span>}
            </div>
            <button
              type="button"
              className="rb-btn rb-btn--block"
              onClick={() => void importBulkCandidates()}
              disabled={bulkImporting || !bulkText.trim()}
            >
              {bulkImporting ? "Importing..." : "Import to bench"}
            </button>
            {bulkResults.length > 0 && (
              <div className="rb-bulk-import__results">
                {bulkResults.slice(0, 30).map((result) => (
                  <div key={`${result.rowNumber}-${result.name}`} className={`is-${result.status}`}>
                    <strong>Row {result.rowNumber}: {result.name}</strong>
                    <span>{result.message}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="rb-candidate-board">
          {grouped.map((group) => (
            <section className={`rb-candidate-stage is-${group.tone}`} key={group.id}>
              <header><strong>{group.label}</strong><span>{group.candidates.length}</span></header>
              {group.candidates.slice(0, 8).map((candidate) => (
                <SourcedCandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  disabled={updatingId === candidate.id || calibratingId === candidate.id}
                  calibrationNote={calibrationDrafts[candidate.id] ?? ""}
                  calibrationDisabled={calibratingId === candidate.id}
                  selected={selectedCandidate?.id === candidate.id}
                  onStageChange={(stage) => void updateStage(candidate, stage)}
                  onOutreachChange={(patch) => void updateOutreach(candidate, patch)}
                  onCalibrationNoteChange={(note) => setCalibrationDrafts((next) => ({ ...next, [candidate.id]: note }))}
                  onCalibrationRequest={() => void requestCalibration(candidate)}
                  onOpenDossier={() => setSelectedCandidateId(candidate.id)}
                />
              ))}
              {group.candidates.length === 0 && <p>No candidates</p>}
            </section>
          ))}
        </div>
      </div>
    </section>
  )
}

function CandidateDossierPanel({
  candidate,
  jobs,
  candidates,
  submissions,
}: {
  candidate: RecruiterSourcedCandidateItem
  jobs: CollabJob[]
  candidates: RecruiterSourcedCandidateItem[]
  submissions: RecruiterSubmissionItem[]
}) {
  const matches = buildCandidateRoleMatches(candidate, jobs, submissions, candidates).slice(0, 3)
  const matchedSubmissions = candidateMatchedSubmissions(candidate, submissions)
  const topMatch = matches[0]
  const stage = sourceStageMeta(candidate.stage)
  const outreach = outreachMeta(candidate.outreach?.status)
  const followUp = candidateFollowUpState(candidate)
  const hasEmail = Boolean(candidate.candidate?.email)
  const hasLink = Boolean(candidate.candidate?.link)
  const hasNote = Boolean(candidate.candidate?.notes?.trim())
  const profileProofCount = [hasEmail, hasLink, hasNote, candidate.outreach?.status && candidate.outreach.status !== "not_contacted", candidate.stage === "ready" || candidate.stage === "submitted"].filter(Boolean).length
  const latestSubmission = [...matchedSubmissions].sort((a, b) => timestampValueMs(b.updatedAt ?? b.createdAt) - timestampValueMs(a.updatedAt ?? a.createdAt))[0]
  const latestStatus = latestSubmission ? statusMeta(latestSubmission.status) : null
  const checklist = [
    {
      label: "Identity",
      value: hasEmail && hasLink ? "Ready" : `${Number(hasEmail) + Number(hasLink)}/2`,
      body: hasEmail && hasLink ? "Email and LinkedIn/resume are ready for duplicate checks." : "Add email and LinkedIn/resume before submission.",
      tone: hasEmail && hasLink ? "success" as const : "warn" as const,
    },
    {
      label: "Outreach",
      value: outreach.label,
      body: followUp.body,
      tone: followUp.tone,
    },
    {
      label: "Role match",
      value: topMatch ? `${topMatch.score}%` : "None",
      body: topMatch ? `${topMatch.job.title} · ${topMatch.job.recruiterBoard.label.company}` : "No active role can be ranked yet.",
      tone: topMatch ? topMatch.score >= 72 ? "live" as const : "info" as const : "mute" as const,
    },
    {
      label: "Submission trail",
      value: matchedSubmissions.length ? String(matchedSubmissions.length) : "0",
      body: latestSubmission ? `${latestStatus?.label ?? "Submitted"} · ${submissionNextAction(latestSubmission.status).title}` : "Not submitted to a role yet.",
      tone: latestStatus?.tone ?? "mute" as const,
    },
  ]
  const nextAction = latestSubmission
    ? submissionNextAction(latestSubmission.status)
    : candidate.stage === "ready" && topMatch
      ? { title: "Submit from best role", body: "Open the top role brief, verify hard filters, then submit with consent.", tone: "live" as const }
      : !hasEmail || !hasLink
        ? { title: "Complete identity proof", body: "Candidate needs email and profile link before clean ownership and consent checks.", tone: "warn" as const }
        : topMatch
          ? { title: "Screen against best role", body: "Use the top match to collect hard-filter evidence and mark ready.", tone: "info" as const }
          : { title: "Keep in private bench", body: "Wait for a stronger WeKruit role or add richer notes for matching.", tone: "mute" as const }

  return (
    <section className="rb-candidate-dossier" aria-label={`${candidateName(candidate)} candidate dossier`}>
      <div className={`rb-candidate-dossier__lead is-${nextAction.tone}`}>
        <span>{stage.label} dossier</span>
        <strong>{candidateName(candidate)}</strong>
        <p>{candidate.candidate?.currentRole || candidate.jobTitleSnapshot || "Candidate"} · {profileProofCount}/5 profile proof signals</p>
        <div>
          {candidate.candidate?.link && <a href={candidate.candidate.link} target="_blank" rel="noopener noreferrer">Open profile</a>}
          {topMatch && <Link to={`/recruiters/job/${topMatch.job.jobId}?candidateId=${encodeURIComponent(candidate.id)}`}>{candidate.stage === "ready" ? "Submit best match" : "Open best role"}</Link>}
          <Link to="/recruiters?tab=matches">Matchboard</Link>
        </div>
      </div>

      <div className="rb-candidate-dossier__checks">
        {checklist.map((item) => (
          <article className={`is-${item.tone}`} key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <p>{item.body}</p>
          </article>
        ))}
      </div>

      <div className="rb-candidate-dossier__body">
        <article className={`rb-candidate-dossier__next is-${nextAction.tone}`}>
          <span>Next move</span>
          <strong>{nextAction.title}</strong>
          <p>{nextAction.body}</p>
        </article>
        <article>
          <span>Top role matches</span>
          <div className="rb-candidate-dossier__matches">
            {matches.map((match) => (
              <Link key={match.job.jobId} to={`/recruiters/job/${match.job.jobId}?candidateId=${encodeURIComponent(candidate.id)}`}>
                <strong>{match.score}% · {match.job.title}</strong>
                <em>{match.reasons.slice(0, 2).join(" · ") || match.job.recruiterBoard.label.company}</em>
              </Link>
            ))}
            {matches.length === 0 && <p>No ranked roles yet.</p>}
          </div>
        </article>
        <article>
          <span>Submission receipts</span>
          <div className="rb-candidate-dossier__receipts">
            {matchedSubmissions.slice(0, 3).map((submission) => {
              const status = statusMeta(submission.status)
              return (
                <Link key={submission.id} to="/recruiters?tab=submissions">
                  <strong>{status.label} · {submissionReceiptId(submission)}</strong>
                  <em>{submission.jobTitleSnapshot || "Role"} · {submissionFeedbackRatingLabel(submission)}</em>
                </Link>
              )
            })}
            {matchedSubmissions.length === 0 && <p>No submission receipt yet.</p>}
          </div>
        </article>
      </div>
    </section>
  )
}

function CandidateOutreachStudioPanel({
  candidate,
  jobs,
  candidates,
  submissions,
}: {
  candidate: RecruiterSourcedCandidateItem
  jobs: CollabJob[]
  candidates: RecruiterSourcedCandidateItem[]
  submissions: RecruiterSubmissionItem[]
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const studio = useMemo(
    () => buildCandidateOutreachStudio(candidate, jobs, submissions, candidates),
    [candidate, candidates, jobs, submissions],
  )
  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      window.setTimeout(() => setCopied(null), 1600)
    } catch {
      setCopied("Copy failed")
      window.setTimeout(() => setCopied(null), 1600)
    }
  }
  const fullSequence = studio.touches
    .map((touch) => `${touch.channel}: ${touch.title}\n\n${touch.body}`)
    .join("\n\n---\n\n")

  return (
    <section className={`rb-outreach-studio is-${studio.tone}`} aria-label={`${candidateName(candidate)} outreach studio`}>
      <header>
        <div>
          <span>{studio.label}</span>
          <strong>{studio.title}</strong>
          <p>{studio.body}</p>
        </div>
        <div>
          {studio.roleHref && <Link to={studio.roleHref}>Open role</Link>}
          <button type="button" onClick={() => void copyText("All", fullSequence)}>
            {copied === "All" ? "Copied sequence" : copied === "Copy failed" ? "Copy failed" : "Copy sequence"}
          </button>
        </div>
      </header>

      <div className="rb-outreach-studio__cards">
        {studio.cards.map((card) => (
          <article className={`is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
          </article>
        ))}
      </div>

      <div className="rb-outreach-studio__touches">
        {studio.touches.map((touch) => (
          <article className={`is-${touch.tone}`} key={touch.id}>
            <header>
              <div>
                <span>{touch.label} · {touch.channel}</span>
                <strong>{touch.title}</strong>
              </div>
              <button type="button" onClick={() => void copyText(touch.id, `${touch.title}\n\n${touch.body}`)}>
                {copied === touch.id ? "Copied" : "Copy"}
              </button>
            </header>
            <pre>{touch.body}</pre>
          </article>
        ))}
      </div>

      <aside className="rb-outreach-studio__screen">
        <span>Screen before submit</span>
        <ol>
          {studio.screening.map((question) => <li key={question}>{question}</li>)}
        </ol>
      </aside>
    </section>
  )
}

function CandidateSourcingCommandPanel({
  command,
  onOpenCandidate,
  onOpenBulkImport,
}: {
  command: CandidateSourcingCommand
  onOpenCandidate: (candidateId: string) => void
  onOpenBulkImport: () => void
}) {
  const primaryAction = () => {
    if (command.href) return <Link to={command.href}>{command.actionLabel}</Link>
    if (command.action === "bulk_import") return <button type="button" onClick={onOpenBulkImport}>{command.actionLabel}</button>
    if (command.action === "match_candidate") return <Link to="/recruiters?tab=matches">{command.actionLabel}</Link>
    const focus = command.focus
    if (focus) return <button type="button" onClick={() => onOpenCandidate(focus.id)}>{command.actionLabel}</button>
    return null
  }

  const queueAction = (item: CandidateSourcingCommand["queue"][number]) => {
    if (item.href) return <Link to={item.href}>Open brief</Link>
    if (item.action === "match_candidate") return <Link to="/recruiters?tab=matches">Match</Link>
    return <button type="button" onClick={() => onOpenCandidate(item.id)}>Open</button>
  }

  return (
    <section className={`rb-candidate-command is-${command.tone}`} aria-label="Candidate sourcing command">
      <div className="rb-candidate-command__mission">
        <span>{command.label}</span>
        <h3>{command.title}</h3>
        <p>{command.body}</p>
        <div>{primaryAction()}</div>
      </div>

      <div className="rb-candidate-command__cards">
        {command.cards.map((card) => (
          <article className={`is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
          </article>
        ))}
      </div>

      <aside className="rb-candidate-command__queue">
        <span>Sourcing queue</span>
        <div>
          {command.queue.map((item) => (
            <article className={`is-${item.tone}`} key={item.id}>
              <div>
                <span>{item.label}</span>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
              </div>
              {queueAction(item)}
            </article>
          ))}
          {command.queue.length === 0 && <p>No candidate needs immediate action.</p>}
        </div>
      </aside>
    </section>
  )
}

function CandidateNetworkExposurePanel({
  model,
  onOpenCandidate,
}: {
  model: CandidateNetworkExposureModel
  onOpenCandidate: (candidateId: string) => void
}) {
  return (
    <section className={`rb-candidate-network is-${model.tone}`} aria-label="Candidate network exposure">
      <header>
        <div>
          <span>{model.label}</span>
          <strong>{model.title}</strong>
          <p>{model.body}</p>
        </div>
        <Link to="/recruiters?tab=matches">Open matchboard</Link>
      </header>

      <div className="rb-candidate-network__cards">
        {model.cards.map((card) => (
          <article className={`is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
          </article>
        ))}
      </div>

      <div className="rb-candidate-network__rows">
        {model.rows.map((row) => (
          <article className={`is-${row.tone}`} key={row.candidate.id}>
            <div>
              <span>{row.label}</span>
              <strong>{row.title}</strong>
              <p>{row.body}</p>
              {row.matches.length > 0 && (
                <em>
                  {row.matches.slice(0, 2).map((match) => `${match.score}% ${match.job.title}`).join(" · ")}
                </em>
              )}
            </div>
            <footer>
              {row.href ? (
                <Link to={row.href}>{row.actionLabel}</Link>
              ) : (
                <button type="button" onClick={() => onOpenCandidate(row.candidate.id)}>{row.actionLabel}</button>
              )}
              <button type="button" onClick={() => onOpenCandidate(row.candidate.id)}>Dossier</button>
            </footer>
          </article>
        ))}
        {model.rows.length === 0 && (
          <div className="rb-candidate-network__empty">
            <strong>No reusable candidate supply yet</strong>
            <p>Save candidates with email, LinkedIn or resume, and notes so future WeKruit roles can match against your bench.</p>
          </div>
        )}
      </div>
    </section>
  )
}

function CandidateOwnershipDeskPanel({ model }: { model: CandidateOwnershipDesk }) {
  return (
    <section className={`rb-ownership-desk is-${model.tone}`} aria-label="Candidate ownership desk">
      <header>
        <div>
          <span>{model.label}</span>
          <strong>{model.title}</strong>
          <p>{model.body}</p>
        </div>
      </header>
      <div className="rb-ownership-desk__cards">
        {model.cards.map((card) => (
          <article className={`is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
          </article>
        ))}
      </div>
      <div className="rb-ownership-desk__rules">
        {model.rules.map((rule) => (
          <article className={`is-${rule.tone}`} key={rule.label}>
            <span>{rule.label}</span>
            <strong>{rule.title}</strong>
            <p>{rule.body}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function SourcedCandidateCard({
  candidate,
  disabled,
  calibrationNote,
  calibrationDisabled,
  selected,
  onStageChange,
  onOutreachChange,
  onCalibrationNoteChange,
  onCalibrationRequest,
  onOpenDossier,
}: {
  candidate: RecruiterSourcedCandidateItem
  disabled: boolean
  calibrationNote: string
  calibrationDisabled: boolean
  selected: boolean
  onStageChange: (stage: RecruiterSourcedCandidateStage) => void
  onOutreachChange: (patch: { status?: RecruiterCandidateOutreachStatus; nextFollowUpAt?: string | null }) => void
  onCalibrationNoteChange: (note: string) => void
  onCalibrationRequest: () => void
  onOpenDossier: () => void
}) {
  const stage = sourceStageMeta(candidate.stage)
  const outreach = outreachMeta(candidate.outreach?.status)
  const followUp = candidateFollowUpState(candidate)
  const calibration = calibrationMeta(candidate.calibrationStatus)
  const calibrationOpen = canRequestCandidateCalibration(candidate)
  const hasRole = Boolean(candidate.inboundJobId || candidate.jobId)
  const roleLabel = candidate.jobTitleSnapshot && candidate.companyLabelSnapshot
    ? `${candidate.jobTitleSnapshot} · ${candidate.companyLabelSnapshot}`
    : candidate.jobTitleSnapshot || "Private bench"
  return (
    <article id={sourcedCandidateDomId(candidate.id)} className={`rb-source-card${selected ? " is-selected" : ""}`}>
      <div>
        <span className="rb-candidate-dot">{candidateName(candidate).slice(0, 1).toUpperCase()}</span>
        <span>
          <strong>{candidateName(candidate)}</strong>
          <em>{candidate.candidate?.currentRole || candidate.jobTitleSnapshot || "Candidate"}</em>
          {candidate.candidate?.email && <em>{candidate.candidate.email}</em>}
        </span>
      </div>
      <p>{shortText(candidate.candidate?.notes, "No note yet", 96)}</p>
      <div className="rb-source-card__outreach">
        <div>
          <span className={`rb-status is-${outreach.tone}`}>{outreach.label}</span>
          <small className={`is-${followUp.tone}`}>{followUp.label}</small>
        </div>
        <p>{followUp.body}</p>
        <div className="rb-source-card__outreach-controls">
          <label>
            <span>Outreach status</span>
            <select
              aria-label={`Update ${candidateName(candidate)} outreach status`}
              value={candidate.outreach?.status ?? "not_contacted"}
              disabled={disabled}
              onChange={(e) => onOutreachChange({ status: e.target.value as RecruiterCandidateOutreachStatus })}
            >
              {OUTREACH_STATUSES.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Next follow-up</span>
            <input
              aria-label={`Update ${candidateName(candidate)} next follow-up`}
              type="date"
              value={isoToDateInput(candidate.outreach?.nextFollowUpAt)}
              disabled={disabled}
              onChange={(e) => onOutreachChange({ nextFollowUpAt: dateInputToIso(e.target.value) })}
            />
          </label>
        </div>
      </div>
      {(candidate.calibrationStatus || candidate.calibrationNote) && (
        <div className="rb-source-card__calibration">
          <span className={`rb-status is-${calibration.tone}`}>{calibration.label}</span>
          {candidate.calibrationNote && <p>{shortText(candidate.calibrationNote, "", 120)}</p>}
        </div>
      )}
      {calibrationOpen && (
        <div className="rb-source-card__request">
          <label>
            <span>Pre-submission calibration</span>
            <textarea
              value={calibrationNote}
              onChange={(e) => onCalibrationNoteChange(e.target.value)}
              placeholder="Ask what you need calibrated before an official submission."
              disabled={calibrationDisabled}
            />
          </label>
          <button
            type="button"
            className="rb-btn"
            onClick={onCalibrationRequest}
            disabled={disabled || calibrationDisabled}
          >
            {calibrationDisabled ? "Requesting..." : "Request calibration"}
          </button>
        </div>
      )}
      <footer>
        <span className={`rb-status is-${hasRole ? "info" : "mute"}`}>{roleLabel}</span>
        <span className={`rb-status is-${stage.tone}`}>{stage.label}</span>
        <select
          aria-label={`Update ${candidateName(candidate)} stage`}
          value={candidate.stage}
          disabled={disabled}
          onChange={(e) => onStageChange(e.target.value as RecruiterSourcedCandidateStage)}
        >
          {SOURCE_STAGES.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        <button type="button" onClick={onOpenDossier}>Dossier</button>
        {candidate.inboundJobId
          ? <Link to={`/recruiters/job/${candidate.inboundJobId}?candidateId=${encodeURIComponent(candidate.id)}`}>Submit</Link>
          : <Link to="/recruiters?tab=matches">Find role</Link>}
      </footer>
    </article>
  )
}

function SubmissionsTab({
  session,
  onSessionChange,
  submissions,
  onRefresh,
  onRoles,
  onCandidates,
}: {
  session: RecruiterSession
  onSessionChange: (session: RecruiterSession) => void
  submissions: RecruiterSubmissionItem[]
  onRefresh: () => Promise<void>
  onRoles: () => void
  onCandidates: () => void
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<SubmissionFilter>("all")
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [resendError, setResendError] = useState<string | null>(null)
  const dashboard = useMemo(() => buildRecruiterSubmissionDashboard(submissions), [submissions])
  const visibleSubmissions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return submissions.filter((submission) => {
      if (!submissionFilterMatches(submission, filter)) return false
      return !needle || submissionSearchText(submission).includes(needle)
    })
  }, [filter, query, submissions])
  const handleResendConfirmation = async (submission: RecruiterSubmissionItem) => {
    const submissionId = submissionReceiptId(submission)
    setResendingId(submission.id)
    setResendError(null)
    try {
      await resendRecruiterCandidateConfirmation(submissionId)
      await onRefresh()
    } catch (error) {
      setResendError(error instanceof Error ? error.message : String(error))
    } finally {
      setResendingId(null)
    }
  }

  return (
    <section className="rb-panel rb-panel--fill rb-submissions-dashboard">
      <header className="rb-panel__head">
        <div><h2>Submitted candidates</h2><p>One table for candidate ownership, WeKruit status, feedback, and recruiter follow-up.</p></div>
        <SubmissionUpdatesToggle session={session} onSessionChange={onSessionChange} />
      </header>

      <section className="rb-submissions-summary" aria-label="Submission summary">
        {dashboard.hero.map((item) => (
          <article className={`is-${item.tone}`} key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <p>{item.body}</p>
          </article>
        ))}
      </section>

      <div className="rb-submissions-controls">
        <label className="rb-search">
          <span>Search submissions</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Candidate, role, company, receipt..." autoComplete="off" />
        </label>
        <div className="rb-submissions-filter" role="tablist" aria-label="Submission filters">
          {SUBMISSION_FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={filter === option.id ? "is-active" : ""}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {resendError && <p className="rb-state error">Could not resend candidate confirmation: {resendError}</p>}
      <SubmissionTable
        submissions={visibleSubmissions}
        emptyMessage={submissions.length > 0 ? "No submissions match the current filter." : "No submitted candidates yet. Open a role sheet and add the first candidate row."}
        onResendConfirmation={(submission) => void handleResendConfirmation(submission)}
        resendingSubmissionId={resendingId}
      />
      {submissions.length === 0 && <SubmissionEmptyState onRoles={onRoles} onCandidates={onCandidates} />}
    </section>
  )
}

function SubmissionTable({
  submissions,
  emptyMessage,
  onResendConfirmation,
  resendingSubmissionId,
}: {
  submissions: RecruiterSubmissionItem[]
  emptyMessage: string
  onResendConfirmation: (submission: RecruiterSubmissionItem) => void
  resendingSubmissionId: string | null
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copyLink = (id: string) => {
    const url = `${window.location.origin}/recruiters/submission/${encodeURIComponent(id)}`
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    }).catch(() => {})
  }
  return (
    <div className="rb-submissions-table-wrap">
      <table className="rb-submissions-table">
        <thead>
          <tr>
            <th>Candidate</th>
            <th>Role</th>
            <th>Status</th>
            <th>Consent</th>
            <th>Feedback</th>
            <th>Reward</th>
            <th>Last update</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {submissions.map((submission) => {
            const status = statusMeta(submission.status)
            const consent = candidateConsentMeta(submission.candidateConsentStatus)
            return (
              <tr id={submissionDomId(submission.id)} key={submission.id}>
                <td data-label="Candidate">
                  <strong>{submission.candidate?.name ?? "Candidate"}</strong>
                  <span>{submission.candidate?.email || shortText(submission.candidate?.link, "No email/link", 48)}</span>
                </td>
                <td data-label="Role">
                  <strong>{shortText(submission.jobTitleSnapshot, "Role", 48)}</strong>
                  <span>{shortText(submission.companyLabelSnapshot, "Company", 40)}</span>
                </td>
                <td data-label="Status">
                  <span className={`rb-status is-${status.tone}`}>{status.label}</span>
                </td>
                <td data-label="Consent">
                  <span className={`rb-status is-${consent.tone}`}>{consent.label}</span>
                </td>
                <td data-label="Feedback">{submissionFeedbackSummary(submission)}</td>
                <td data-label="Reward">{submissionRewardLabel(submission)}</td>
                <td data-label="Last update">{formatActivityDate(submission.updatedAt ?? submission.createdAt)}</td>
                <td data-label="Action">
                  <div className="rb-submissions-table__actions">
                    <Link to={`/recruiters/submission/${submissionReceiptId(submission)}`}>View</Link>
                    <button type="button" onClick={() => copyLink(submissionReceiptId(submission))}>
                      {copiedId === submissionReceiptId(submission) ? "Copied!" : "Copy link"}
                    </button>
                    {(submission.inboundJobId || submission.jobId) && (
                      <Link to={`/recruiters/job/${submission.inboundJobId || submission.jobId}`}>Open sheet</Link>
                    )}
                    {candidateConfirmationCanResend(submission) && (
                      <button
                        type="button"
                        onClick={() => onResendConfirmation(submission)}
                        disabled={resendingSubmissionId === submission.id}
                      >
                        {resendingSubmissionId === submission.id ? "Sending..." : "Resend consent"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
          {submissions.length === 0 && (
            <tr>
              <td colSpan={8} className="rb-submissions-table__empty">{emptyMessage}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function SubmissionCommandPanel({
  model,
  onReviewSubmission,
  onResendConfirmation,
  resendingSubmissionId,
}: {
  model: SubmissionCommandModel
  onReviewSubmission: (submissionId: string) => void
  onResendConfirmation: (submission: RecruiterSubmissionItem) => void
  resendingSubmissionId: string | null
}) {
  const focus = model.focus
  const renderPrimaryAction = () => {
    if (model.action === "browse_roles" && model.href) {
      return <Link to={model.href}>{model.cta}</Link>
    }
    if (model.action === "open_role" && model.href) {
      return <Link to={model.href}>{model.cta}</Link>
    }
    if (model.action === "resend_confirmation" && focus) {
      return (
        <button type="button" onClick={() => onResendConfirmation(focus)} disabled={resendingSubmissionId === focus.id}>
          {resendingSubmissionId === focus.id ? "Sending..." : model.cta}
        </button>
      )
    }
    if (focus) {
      return <button type="button" onClick={() => onReviewSubmission(focus.id)}>{model.cta}</button>
    }
    return null
  }

  return (
    <section className={`rb-submission-command is-${model.tone}`}>
      <div className="rb-submission-command__mission">
        <span>{model.label}</span>
        <h3>{model.title}</h3>
        <p>{model.body}</p>
        <div className="rb-submission-command__actions">
          {renderPrimaryAction()}
          {focus && model.action !== "open_submission" && (
            <button type="button" className="is-secondary" onClick={() => onReviewSubmission(focus.id)}>
              Open packet
            </button>
          )}
        </div>
      </div>

      <div className="rb-submission-command__cards">
        {model.cards.map((card) => (
          <article className={`is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
          </article>
        ))}
      </div>

      <aside className="rb-submission-command__queue">
        <span>Action queue</span>
        <div>
          {model.queue.map((item) => (
            <button type="button" className={`is-${item.tone}`} key={item.id} onClick={() => onReviewSubmission(item.id)}>
              <em>{item.label}</em>
              <strong>{item.title}</strong>
              <small>{item.body}</small>
            </button>
          ))}
          {model.queue.length === 0 && <p>No submission needs immediate follow-up.</p>}
        </div>
      </aside>
    </section>
  )
}

function SubmissionDealRoomPanel({
  model,
  onReviewSubmission,
  onResendConfirmation,
  resendingSubmissionId,
}: {
  model: SubmissionDealRoomModel
  onReviewSubmission: (submissionId: string) => void
  onResendConfirmation: (submission: RecruiterSubmissionItem) => void
  resendingSubmissionId: string | null
}) {
  const focus = model.focus
  const renderPrimaryAction = () => {
    if (model.primaryAction === "browse_roles" && model.href) {
      return <Link to={model.href}>{model.primaryLabel}</Link>
    }
    if (model.primaryAction === "open_role" && model.href) {
      return <Link to={model.href}>{model.primaryLabel}</Link>
    }
    if (model.primaryAction === "resend_confirmation" && focus) {
      return (
        <button type="button" onClick={() => onResendConfirmation(focus)} disabled={resendingSubmissionId === focus.id}>
          {resendingSubmissionId === focus.id ? "Sending..." : model.primaryLabel}
        </button>
      )
    }
    if (focus) {
      return <button type="button" onClick={() => onReviewSubmission(focus.id)}>{model.primaryLabel}</button>
    }
    return null
  }

  return (
    <section className={`rb-submission-deal-room is-${model.tone}`}>
      <div className="rb-submission-deal-room__lead">
        <span>{model.label}</span>
        <h3>{model.title}</h3>
        <p>{model.body}</p>
        <div className="rb-submission-deal-room__facts">
          <em>{model.candidate}</em>
          <em>{model.role}</em>
          <em>{model.company}</em>
          <em>{model.receipt}</em>
        </div>
        <div className="rb-submission-deal-room__actions">
          {renderPrimaryAction()}
          {focus && model.primaryAction !== "open_submission" && (
            <button type="button" className="is-secondary" onClick={() => onReviewSubmission(focus.id)}>
              Open packet
            </button>
          )}
          {focus && rolePathForRow(focus) && model.primaryAction !== "open_role" && (
            <Link className="is-secondary" to={rolePathForRow(focus)!}>
              Open role
            </Link>
          )}
        </div>
      </div>

      <div className="rb-submission-deal-room__gates">
        {model.gates.map((gate) => (
          <article className={`is-${gate.tone}`} key={gate.label}>
            <span>{gate.label}</span>
            <strong>{gate.value}</strong>
            <p>{gate.body}</p>
          </article>
        ))}
      </div>

      <aside className="rb-submission-deal-room__side">
        <article className={`rb-submission-deal-room__payout is-${model.payoutTone}`}>
          <span>{model.payoutLabel}</span>
          <strong>{model.payoutValue}</strong>
          <p>{model.payoutBody}</p>
        </article>
        <div className="rb-submission-deal-room__risks">
          {model.risks.map((risk) => (
            <article className={`is-${risk.tone}`} key={`${risk.label}-${risk.value}`}>
              <span>{risk.label}</span>
              <strong>{risk.value}</strong>
              <p>{risk.body}</p>
            </article>
          ))}
        </div>
        <div className="rb-submission-deal-room__timeline">
          <span>Recent movement</span>
          {model.timeline.map((event) => (
            <div className={`is-${event.tone}`} key={event.id}>
              <i />
              <section>
                <strong>{event.label}</strong>
                <p>{event.detail}</p>
                <em>{event.at}</em>
              </section>
            </div>
          ))}
          {model.timeline.length === 0 && <p>No packet activity yet.</p>}
        </div>
      </aside>
    </section>
  )
}

function SubmissionPipelineBoard({
  lanes,
  onReviewSubmission,
}: {
  lanes: SubmissionPipelineLaneModel[]
  onReviewSubmission: (submissionId: string) => void
}) {
  return (
    <section className="rb-submission-status-board" aria-label="Submission status board">
      <header>
        <div>
          <span>Status board</span>
          <strong>Your submitted candidates by pipeline stage</strong>
        </div>
        <p>Click any card to open the full receipt, feedback, consent state, and activity trail below.</p>
      </header>
      <div className="rb-submission-status-board__lanes">
        {lanes.map((lane) => (
          <section className={`rb-submission-status-lane is-${lane.tone}`} key={lane.id}>
            <header>
              <div>
                <span>{lane.label}</span>
                <strong>{lane.items.length}</strong>
              </div>
              <p>{lane.body}</p>
            </header>
            <div>
              {lane.items.slice(0, 5).map((item) => (
                <button
                  type="button"
                  className={`rb-submission-status-card is-${item.tone}`}
                  key={item.id}
                  onClick={() => onReviewSubmission(item.id)}
                >
                  <span>{item.status}</span>
                  <strong>{item.candidate}</strong>
                  <em>{item.role} · {item.company}</em>
                  <small>{item.meta}</small>
                </button>
              ))}
              {lane.items.length > 5 && <p className="rb-submission-status-more">+{lane.items.length - 5} more in full tracker</p>}
              {lane.items.length === 0 && <p className="rb-submission-status-empty">No candidates</p>}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}

function SubmissionEmptyState({
  onRoles,
  onCandidates,
}: {
  onRoles: () => void
  onCandidates: () => void
}) {
  return (
    <div className="rb-submissions-empty">
      <div className="rb-submissions-empty__copy">
        <span>No submissions yet</span>
        <strong>Start with a role lane and a consented candidate.</strong>
        <p>Submission rows appear here after a candidate is sent from a role sheet. Each row carries ownership, consent, WeKruit status, feedback, and reward progress.</p>
      </div>
      <div className="rb-submissions-empty__steps">
        <article>
          <span>01</span>
          <strong>Choose role</strong>
          <p>Pick the role you can actually cover.</p>
        </article>
        <article>
          <span>02</span>
          <strong>Save candidate</strong>
          <p>Add links, notes, and fit proof before submit.</p>
        </article>
        <article>
          <span>03</span>
          <strong>Submit candidate</strong>
          <p>Candidate consent creates the tracked submission.</p>
        </article>
      </div>
      <div className="rb-submissions-empty__actions">
        <button type="button" className="rb-btn primary" onClick={onRoles}>Browse roles</button>
        <button type="button" className="rb-btn" onClick={onCandidates}>Add candidate</button>
      </div>
    </div>
  )
}

function PerformanceTab({
  jobs,
  candidates,
  submissions,
  primaryRoleIds,
  roleFeedback,
  operatingMetrics,
  onRoles,
  onCandidates,
  onSubmissions,
  onCandidateSaved,
}: {
  jobs: CollabJob[]
  candidates: RecruiterSourcedCandidateItem[]
  submissions: RecruiterSubmissionItem[]
  primaryRoleIds: string[]
  roleFeedback: RecruiterRoleFeedbackItem[]
  operatingMetrics: RecruiterOperatingMetrics
  onRoles: () => void
  onCandidates: () => void
  onSubmissions: () => void
  onCandidateSaved: (candidate: RecruiterSourcedCandidateItem) => void
}) {
  const [calibrationDrafts, setCalibrationDrafts] = useState<Record<string, string>>({})
  const [calibratingId, setCalibratingId] = useState<string | null>(null)
  const [calibrationError, setCalibrationError] = useState<string | null>(null)
  const metricSubmissions = submissions.filter(submissionCountsTowardRecruiterMetrics)
  const feedbackRows = metricSubmissions.filter(submissionHasStructuredFeedback)
  const advanced = metricSubmissions.filter((s) => ADVANCED_STATUSES.includes(s.status ?? "")).length
  const pending = submissions.filter(submissionIsConfirmedActiveReview).length
  const ready = candidates.filter((c) => c.stage === "ready").length
  const sourceToSubmit = candidates.length ? Math.round((metricSubmissions.length / candidates.length) * 100) : 0
  const singleSubmissions = metricSubmissions.filter((submission) => submission.submissionMode === "single_submission").length
  const primarySubmissions = metricSubmissions.filter((submission) => submission.submissionMode === "primary_role").length
  const blockedRoles = roleFeedback.filter((feedback) => feedback.difficulty === "blocked").length
  const hardRoles = roleFeedback.filter((feedback) => feedback.difficulty === "hard").length
  const trustCenter = computeRecruiterTrustCenter(candidates, submissions, roleFeedback, primaryRoleIds, operatingMetrics)
  const groundRules = buildRecruiterGroundRulesCenter(candidates, submissions, roleFeedback, primaryRoleIds)
  const learningCenter = buildRecruiterLearningCenter(jobs, candidates, submissions, roleFeedback)
  const calibrationDesk = buildRecruiterCalibrationDesk(candidates)
  const runGroundRuleAction = (action: RecruiterGroundRuleAction) => {
    if (action === "roles") onRoles()
    else if (action === "candidates") onCandidates()
    else if (action === "submissions") onSubmissions()
  }
  const requestCalibration = async (candidate: RecruiterSourcedCandidateItem) => {
    const jobId = candidate.inboundJobId || candidate.jobId || ""
    const link = candidate.candidate?.link?.trim()
    if (!jobId || !link) {
      setCalibrationError("This saved candidate is missing the role or link needed for calibration.")
      return
    }
    if (calibrationDesk.slotsLeft <= 0) {
      setCalibrationError("Calibration slots are full. Wait for WeKruit feedback before requesting another candidate.")
      return
    }
    setCalibratingId(candidate.id)
    setCalibrationError(null)
    try {
      const note = calibrationDrafts[candidate.id]?.trim()
      const saved = await saveRecruiterSourcedCandidate({
        candidateId: candidate.candidateId || candidate.id,
        jobId,
        stage: candidate.stage,
        candidate: {
          name: candidate.candidate?.name || candidateName(candidate),
          email: candidate.candidate?.email,
          link,
          currentRole: candidate.candidate?.currentRole,
          yoe: candidate.candidate?.yoe,
          notes: candidate.candidate?.notes,
        },
        outreach: candidate.outreach,
        calibrationRequest: {
          note: note || undefined,
        },
      })
      onCandidateSaved(saved)
      setCalibrationDrafts((next) => {
        const copy = { ...next }
        delete copy[candidate.id]
        return copy
      })
    } catch (error) {
      setCalibrationError(error instanceof Error ? error.message : String(error))
    } finally {
      setCalibratingId(null)
    }
  }
  const metrics = [
    { label: "Submitted", value: String(metricSubmissions.length), meta: "confirmed formal candidates", tone: "live" },
    { label: "Pending review", value: String(pending), meta: "awaiting feedback", tone: "warn" },
    { label: "Advanced", value: String(advanced), meta: "sent forward / interview / offer", tone: "success" },
    { label: "Source to submit", value: `${sourceToSubmit}%`, meta: `${ready} ready now`, tone: "info" },
  ]
  const stageRows = SOURCE_STAGES.map((stage) => ({
    ...stage,
    count: candidates.filter((candidate) => candidate.stage === stage.id).length,
  }))
  const statusRows = Object.entries(STATUS_LABELS).map(([status, meta]) => ({
    status,
    ...meta,
    count: submissions.filter((submission) => (submission.status ?? "submitted") === status).length,
  })).filter((row) => row.count > 0)

  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Performance &amp; calibration</h2><p>Source quality, review velocity, and feedback from WeKruit in one operating view.</p></div>
      </header>
      <section className="rb-stats rb-stats--inside">
        {metrics.map((metric) => (
          <article className={`rb-stat is-${metric.tone}`} key={metric.label}>
            <span>{metric.label}<em>{metric.tone}</em></span>
            <strong>{metric.value}</strong>
            <em>{metric.meta}</em>
          </article>
        ))}
      </section>
      <section className="rb-performance-status">
        <div className="rb-performance-status__lead">
          <span>Recruiter status</span>
          <strong>{operatingMetrics.statusLabel}</strong>
          <p>{operatingMetrics.statusBody}</p>
        </div>
        <div className="rb-performance-targets">
          {operatingMetrics.targets.map((target) => (
            <article className={`is-${target.tone}`} key={target.label}>
              <span>{target.label}</span>
              <strong>{target.value}</strong>
              <p>{target.body}</p>
            </article>
          ))}
        </div>
      </section>
      <RecruiterGroundRulesPanel model={groundRules} onAction={runGroundRuleAction} />
      <RecruiterTrustCenterPanel model={trustCenter} />
      <RecruiterCalibrationDeskPanel
        model={calibrationDesk}
        calibrationDrafts={calibrationDrafts}
        calibratingId={calibratingId}
        error={calibrationError}
        onDraftChange={(candidateId, note) => setCalibrationDrafts((next) => ({ ...next, [candidateId]: note }))}
        onRequest={(candidate) => void requestCalibration(candidate)}
      />
      <RecruiterLearningCenterPanel model={learningCenter} />
      <div className="rb-performance-grid">
        <section className="rb-performance-card">
          <h3>Pipeline funnel</h3>
          <div className="rb-funnel">
            {stageRows.map((row) => (
              <div key={row.id}>
                <span>{row.label}</span>
                <strong>{row.count}</strong>
                <i style={{ width: `${Math.max(8, Math.min(100, candidates.length ? (row.count / candidates.length) * 100 : 8))}%` }} />
              </div>
            ))}
          </div>
        </section>
        <section className="rb-performance-card">
          <h3>Submission status</h3>
          <div className="rb-funnel">
            {statusRows.length > 0 ? statusRows.map((row) => (
              <div key={row.status}>
                <span>{row.label}</span>
                <strong>{row.count}</strong>
                <i style={{ width: `${Math.max(8, Math.min(100, submissions.length ? (row.count / submissions.length) * 100 : 8))}%` }} />
              </div>
            )) : <p>No submissions yet.</p>}
          </div>
        </section>
        <section className="rb-performance-card rb-performance-card--wide">
          <h3>Feedback loop</h3>
          <div className="rb-submission-list">
            {feedbackRows.map((s) => <SubmissionRow key={s.id} submission={s} expanded />)}
            {feedbackRows.length === 0 && <p className="rb-empty">No rated feedback yet. Status changes will still appear in Submissions.</p>}
          </div>
        </section>
        <section className="rb-performance-card">
          <h3>Role coverage</h3>
          <p>{primaryRoleIds.length}/{APPROVED_ROLE_LIMIT} approved roles are active.</p>
          <p>{primarySubmissions} submissions came from approved roles.</p>
          <p>{singleSubmissions}/{SINGLE_SUBMISSION_WEEKLY_LIMIT} single submissions used in the tracked window.</p>
          <p>{jobs.filter((job) => !submissions.some((s) => s.inboundJobId === roleKey(job) || s.jobId === roleKey(job))).length} open roles have no submissions from this account yet.</p>
        </section>
        <section className="rb-performance-card">
          <h3>Market feedback</h3>
          <p>{roleFeedback.length} role feedback reports submitted.</p>
          <p>{hardRoles} hard roles and {blockedRoles} blocked roles flagged.</p>
          <p>{roleFeedback.filter((feedback) => feedback.note).length} reports include recruiter notes.</p>
        </section>
      </div>
    </section>
  )
}

function RecruiterGroundRulesPanel({
  model,
  onAction,
}: {
  model: RecruiterGroundRulesCenter
  onAction: (action: RecruiterGroundRuleAction) => void
}) {
  return (
    <section className={`rb-ground-rules is-${model.tone}`} aria-label="Recruiter ground rules center">
      <header>
        <div>
          <span>Ground rules center</span>
          <strong>{model.title}</strong>
          <p>{model.body}</p>
        </div>
        <aside>
          <span>Compliance score</span>
          <strong>{model.scoreLabel}</strong>
          <p>Visible workspace evidence only. Manual representation and compensation discipline still matter.</p>
        </aside>
      </header>

      <div className="rb-ground-rules__cards">
        {model.cards.map((card) => (
          <article className={`is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
            <button type="button" onClick={() => onAction(card.action)}>{card.actionLabel}</button>
          </article>
        ))}
      </div>

      <div className="rb-ground-rules__body">
        <section>
          <div>
            <h3>Non-negotiable rules</h3>
            <p>These are the operating standards before more access, volume, or payout confidence.</p>
          </div>
          {model.rules.map((rule) => (
            <article className={`is-${rule.tone}`} key={rule.label}>
              <div>
                <span>{rule.label}</span>
                <strong>{rule.value}</strong>
                <p>{rule.body}</p>
              </div>
              <button type="button" onClick={() => onAction(rule.action)}>{rule.actionLabel}</button>
            </article>
          ))}
        </section>

        <section>
          <div>
            <h3>Visible risk queue</h3>
            <p>Fix these before scaling sourcing or asking for more trusted role access.</p>
          </div>
          {model.risks.map((risk) => (
            <article className={`is-${risk.tone}`} key={risk.label}>
              <div>
                <span>{risk.label}</span>
                <strong>{risk.value}</strong>
                <p>{risk.body}</p>
              </div>
              <button type="button" onClick={() => onAction(risk.action)}>{risk.actionLabel}</button>
            </article>
          ))}
          {model.risks.length === 0 && (
            <p className="rb-empty">No visible ground-rule risks in the current recruiter workspace.</p>
          )}
        </section>
      </div>
    </section>
  )
}

function RecruiterCalibrationDeskPanel({
  model,
  calibrationDrafts,
  calibratingId,
  error,
  onDraftChange,
  onRequest,
}: {
  model: RecruiterCalibrationDesk
  calibrationDrafts: Record<string, string>
  calibratingId: string | null
  error: string | null
  onDraftChange: (candidateId: string, note: string) => void
  onRequest: (candidate: RecruiterSourcedCandidateItem) => void
}) {
  const slotsFull = model.slotsLeft <= 0
  return (
    <section className={`rb-calibration-desk is-${model.tone}`} aria-label="Pre-submission calibration desk">
      <header>
        <div>
          <span>{model.label}</span>
          <strong>{model.title}</strong>
          <p>{model.body}</p>
        </div>
        <aside>
          <span>Calibration slots</span>
          <strong>{model.slotsUsed}/{model.slotsLimit}</strong>
          <p>{slotsFull ? "Wait for returned feedback before requesting another candidate." : `${model.slotsLeft} slot${model.slotsLeft === 1 ? "" : "s"} open for pre-submit feedback.`}</p>
        </aside>
      </header>

      <div className="rb-calibration-desk__cards">
        {model.cards.map((card) => (
          <article className={`is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
          </article>
        ))}
      </div>

      <div className="rb-calibration-desk__body">
        <section className="rb-calibration-desk__queue">
          <div>
            <h3>Request pre-submit feedback</h3>
            <p>Use this before a formal submission when the candidate is promising but the fit signal is not sharp enough yet.</p>
          </div>
          {error && <p className="rb-access__err">{error}</p>}
          {model.requestQueue.map((row) => (
            <article className={`is-${row.tone}`} key={row.candidate.id}>
              <div>
                <span>{row.label}</span>
                <strong>{row.title}</strong>
                <p>{row.body}</p>
                <em>{row.meta}</em>
              </div>
              <label>
                <span>Question for WeKruit</span>
                <textarea
                  value={calibrationDrafts[row.candidate.id] ?? ""}
                  onChange={(event) => onDraftChange(row.candidate.id, event.target.value)}
                  placeholder="Ask what to validate before formal submission."
                  disabled={calibratingId === row.candidate.id || slotsFull}
                />
              </label>
              <footer>
                <button
                  type="button"
                  onClick={() => onRequest(row.candidate)}
                  disabled={calibratingId === row.candidate.id || slotsFull}
                >
                  {calibratingId === row.candidate.id ? "Requesting..." : slotsFull ? "Slots full" : "Request calibration"}
                </button>
                <Link to={`/recruiters/job/${row.candidate.inboundJobId || row.candidate.jobId}?candidateId=${encodeURIComponent(row.candidate.id)}`}>
                  Open role
                </Link>
              </footer>
            </article>
          ))}
          {model.requestQueue.length === 0 && (
            <p className="rb-empty">No candidate is ready for calibration. Attach a sourced candidate to a role before asking for pre-submit feedback.</p>
          )}
        </section>

        <aside className="rb-calibration-desk__side">
          <section>
            <div>
              <h3>Waiting on feedback</h3>
              <p>Do not turn these into lookalike volume until the note returns.</p>
            </div>
            {model.waitingQueue.map((row) => (
              <article className={`is-${row.tone}`} key={row.candidate.id}>
                <span>{row.label}</span>
                <strong>{row.title}</strong>
                <p>{row.body}</p>
                <em>{row.meta}</em>
              </article>
            ))}
            {model.waitingQueue.length === 0 && <p className="rb-empty">No open calibration requests.</p>}
          </section>
          <section>
            <div>
              <h3>Returned signal</h3>
              <p>Reuse this before requesting more role access or submitting lookalikes.</p>
            </div>
            {model.feedbackQueue.map((row) => (
              <article className={`is-${row.tone}`} key={row.candidate.id}>
                <span>{row.label}</span>
                <strong>{row.title}</strong>
                <p>{row.body}</p>
                <em>{row.meta}</em>
              </article>
            ))}
            {model.feedbackQueue.length === 0 && <p className="rb-empty">No returned calibration notes yet.</p>}
          </section>
        </aside>
      </div>
    </section>
  )
}

function RecruiterTrustCenterPanel({ model }: { model: RecruiterTrustCenter }) {
  return (
    <section className={`rb-trust-center is-${model.statusTone}`} aria-label="Recruiter trust center">
      <header>
        <div>
          <span>Trust command</span>
          <strong>{model.statusLabel}</strong>
          <p>{model.statusBody}</p>
        </div>
        <aside>
          <span>Next trust action</span>
          <strong>{model.nextActionLabel}</strong>
          <p>{model.nextActionBody}</p>
        </aside>
      </header>
      <div className="rb-trust-center__ladder" aria-label="Recruiter status ladder">
        <div className="rb-trust-center__section-head">
          <span>Status ladder</span>
          <strong>{model.tierLabel}</strong>
          <p>{model.tierProgressLabel}: {model.tierProgressValue}</p>
        </div>
        <div className="rb-trust-center__tiers">
          {model.tiers.map((tier) => (
            <article
              className={`rb-trust-center__tier is-${tier.tone}${tier.active ? " is-active" : ""}${tier.complete ? " is-complete" : ""}`}
              key={tier.label}
            >
              <header>
                <span>{tier.rank}</span>
                <strong>{tier.label}</strong>
              </header>
              <p>{tier.requirement}</p>
              <small>{tier.unlock}</small>
              <footer>
                <b>{tier.progressLabel}</b>
                <span>{tier.progressValue}</span>
              </footer>
              {tier.blockedBy.length > 0 && (
                <div className="rb-trust-center__blockers">
                  {tier.blockedBy.slice(0, 3).map((blocker) => (
                    <span key={blocker}>{blocker}</span>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
      <div className="rb-trust-center__cards">
        {model.cards.map((card) => (
          <article className={`is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
          </article>
        ))}
      </div>
      <div className="rb-trust-center__gates">
        {model.gates.map((gate) => (
          <article className={`is-${gate.tone}`} key={gate.label}>
            <span>{gate.label}</span>
            <strong>{gate.value}</strong>
            <p>{gate.body}</p>
          </article>
        ))}
      </div>
      <div className="rb-trust-center__unlocks" aria-label="Priority unlocks">
        <div className="rb-trust-center__section-head">
          <span>Priority unlocks</span>
          <strong>Marketplace signal</strong>
          <p>What the current account record can support in WeKruit review.</p>
        </div>
        <div className="rb-trust-center__unlock-grid">
          {model.unlocks.map((unlock) => (
            <article className={`is-${unlock.tone}`} key={unlock.label}>
              <span>{unlock.label}</span>
              <strong>{unlock.value}</strong>
              <p>{unlock.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function RecruiterLearningCenterPanel({ model }: { model: RecruiterLearningCenter }) {
  const renderRuleAction = (rule: RecruiterLearningRule) => {
    if (!rule.href) return null
    return <Link to={rule.href}>Open signal</Link>
  }

  return (
    <section className={`rb-learning-center is-${model.statusTone}`} aria-label="Feedback learning center">
      <header>
        <div>
          <span>{model.statusLabel}</span>
          <strong>{model.statusTitle}</strong>
          <p>{model.statusBody}</p>
        </div>
        <aside>
          {model.cards.map((card) => (
            <article className={`is-${card.tone}`} key={card.label}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <p>{card.body}</p>
            </article>
          ))}
        </aside>
      </header>

      <div className="rb-learning-center__body">
        <section className="rb-learning-center__rules">
          <div>
            <h3>Next sourcing rules</h3>
            <p>What the next shortlist should do differently.</p>
          </div>
          {model.rules.map((rule) => (
            <article className={`is-${rule.tone}`} key={`${rule.label}-${rule.title}`}>
              <span>{rule.label}</span>
              <strong>{rule.title}</strong>
              <p>{rule.body}</p>
              <footer>
                <em>{rule.evidence}</em>
                {renderRuleAction(rule)}
              </footer>
            </article>
          ))}
        </section>

        <section className="rb-learning-center__evidence">
          <div>
            <h3>Evidence feed</h3>
            <p>Recent feedback, role blockers, and candidate calibration that created the rules.</p>
          </div>
          {model.evidence.map((item) => (
            <article className={`is-${item.tone}`} key={`${item.label}-${item.title}-${item.evidence}`}>
              <span>{item.label}</span>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
              <footer>
                <em>{item.evidence}</em>
                {renderRuleAction(item)}
              </footer>
            </article>
          ))}
          {model.evidence.length === 0 && (
            <p className="rb-empty">No feedback evidence yet. Submit consented candidates to start the learning feed.</p>
          )}
        </section>
      </div>
    </section>
  )
}

function EarningsTab({
  metrics,
  onRoles,
  onCandidates,
  onSubmissions,
  onPerformance,
  onSettings,
}: {
  metrics: RecruiterEarningsMetrics
  onRoles: () => void
  onCandidates: () => void
  onSubmissions: () => void
  onPerformance: () => void
  onSettings: () => void
}) {
  const runAction = (action: RecruiterStatusBenefit["action"]) => {
    if (!action) return
    if (action === "roles") onRoles()
    else if (action === "candidates") onCandidates()
    else if (action === "submissions") onSubmissions()
    else if (action === "settings") onSettings()
    else onPerformance()
  }
  const recommendedChallenge = metrics.challenges[0]
  const [selectedChallengeId, setSelectedChallengeId] = useState(() => {
    try {
      return window.localStorage.getItem(RECRUITER_WEEKLY_CHALLENGE_KEY) || recommendedChallenge?.id || ""
    } catch {
      return recommendedChallenge?.id || ""
    }
  })
  const selectedChallenge = metrics.challenges.find((challenge) => challenge.id === selectedChallengeId) ?? recommendedChallenge
  const selectChallenge = (challenge: RecruiterChallenge) => {
    setSelectedChallengeId(challenge.id)
    try {
      window.localStorage.setItem(RECRUITER_WEEKLY_CHALLENGE_KEY, challenge.id)
    } catch {
      // Browser storage can be unavailable in private browsing.
    }
  }
  const challengeWindow = challengeWindowLabel()
  const challengeDeadline = challengeDeadlineLabel()
  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div>
          <h2>Earnings, status &amp; challenges</h2>
          <p>Recruiter business view: estimated payout exposure, status tier, weekly challenges, and role-activity expectations.</p>
        </div>
        <button type="button" className="rb-panel__link" onClick={onPerformance}>Open performance</button>
      </header>

      <section className="rb-earnings-hero">
        <div>
          <span>Current status</span>
          <strong>{metrics.statusLabel}</strong>
          <p>{metrics.ratingLabel} recruiter rating. {metrics.ratingBody}</p>
        </div>
        <div>
          <span>Active pipeline value</span>
          <strong>{formatCurrencyShort(metrics.activePipelineValue)}</strong>
          <p>Estimated success-fee value across active, non-closed submissions.</p>
        </div>
        <div>
          <span>Won value</span>
          <strong>{formatCurrencyShort(metrics.wonValue)}</strong>
          <p>Recorded hired outcomes in your recruiter tracker.</p>
        </div>
        <div>
          <span>Interview movement</span>
          <strong>{metrics.interviewRate}%</strong>
          <p>Preferred target is {PREFERRED_INTERVIEW_RATE_TARGET}%+ advanced, interviewing, offer, or hired.</p>
        </div>
      </section>

      <StatusBenefitsPanel benefits={metrics.statusBenefits} onAction={runAction} />

      <RewardLedgerPanel ledger={metrics.rewardLedger} onAction={runAction} />

      <PayoutReadinessPanel
        readiness={metrics.payoutReadiness}
        onSettings={onSettings}
        onSubmissions={onSubmissions}
      />

      <section className="rb-earnings-grid">
        <article className="rb-earnings-card rb-earnings-card--wide">
          <header>
            <h3>Status ladder</h3>
            <p>How WeKruit should decide who earns more trusted role access.</p>
          </header>
          <div className="rb-status-ladder">
            {metrics.tiers.map((tier) => (
              <article className={`is-${tier.tone} ${tier.active ? "is-active" : ""}`} key={tier.label}>
                <span>{tier.label}</span>
                <strong>{tier.requirement}</strong>
                <p>{tier.body}</p>
              </article>
            ))}
          </div>
        </article>

        <article className="rb-earnings-card">
          <header>
            <h3>Activity expectations</h3>
            <p>Approved roles need live motion, not shelf space.</p>
          </header>
          <div className="rb-expectation-list">
            {metrics.expectations.map((item) => (
              <div className={`is-${item.tone}`} key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="rb-earnings-card rb-earnings-card--wide">
          <header>
            <h3>Weekly challenges</h3>
            <p>Elect one focus for the current window, then work the dashboard like a recruiter business.</p>
          </header>
          <div className="rb-weekly-challenge">
            <aside className={`rb-weekly-challenge__selected is-${selectedChallenge?.tone ?? "mute"}`}>
              <span>{selectedChallenge ? "Selected challenge" : "No challenge selected"}</span>
              <strong>{selectedChallenge?.title ?? "Choose a weekly focus"}</strong>
              <p>{selectedChallenge?.body ?? "Pick the challenge that best matches your current recruiting capacity."}</p>
              {selectedChallenge && (
                <>
                  <div className="rb-challenge-progress" aria-label={`${selectedChallenge.title} progress`}>
                    <i style={{ width: `${challengeProgressPct(selectedChallenge)}%` }} />
                  </div>
                  <dl>
                    <div><dt>Window</dt><dd>{challengeWindow}</dd></div>
                    <div><dt>Deadline</dt><dd>{challengeDeadline}</dd></div>
                    <div><dt>Progress</dt><dd>{selectedChallenge.progressLabel}</dd></div>
                    <div><dt>Reward</dt><dd>{selectedChallenge.reward}</dd></div>
                  </dl>
                  <p>{selectedChallenge.eligibility}</p>
                  <p>{selectedChallenge.payoutTiming}</p>
                  <button type="button" onClick={() => runAction(selectedChallenge.action)}>{selectedChallenge.actionLabel}</button>
                </>
              )}
            </aside>
            <div className="rb-challenge-grid">
              {metrics.challenges.map((challenge) => {
                const selected = selectedChallenge?.id === challenge.id
                return (
                  <article className={`is-${challenge.tone} ${selected ? "is-selected" : ""}`} key={challenge.id}>
                    <span>{challenge.reward}</span>
                    <strong>{challenge.title}</strong>
                    <p>{challenge.body}</p>
                    <div className="rb-challenge-progress" aria-label={`${challenge.title} progress`}>
                      <i style={{ width: `${challengeProgressPct(challenge)}%` }} />
                    </div>
                    <footer>
                      <em>{challenge.progressLabel}</em>
                      <button type="button" onClick={() => selectChallenge(challenge)}>
                        {selected ? "Selected" : "Select"}
                      </button>
                    </footer>
                  </article>
                )
              })}
            </div>
          </div>
        </article>

        <article className="rb-earnings-card rb-earnings-card--payouts">
          <header>
            <h3>Payout tracker</h3>
            <p>Submissions with potential value and the current payout posture.</p>
          </header>
          <div className="rb-payout-list">
            {metrics.payouts.map((row) => (
              <article key={row.id}>
                <span className={`rb-status is-${row.tone}`}>{row.status}</span>
                <div>
                  <strong>{row.candidate}</strong>
                  <p>{row.role}</p>
                  <em>{row.payout}</em>
                </div>
                <b>{row.value}</b>
              </article>
            ))}
            {metrics.payouts.length === 0 && (
              <p className="rb-empty">No active payout exposure yet. Submit consented candidates to start an earnings tracker.</p>
            )}
          </div>
        </article>
      </section>
    </section>
  )
}

function StatusBenefitsPanel({
  benefits,
  onAction,
}: {
  benefits: RecruiterStatusBenefitsCenter
  onAction: (action: RecruiterStatusBenefit["action"]) => void
}) {
  return (
    <section className={`rb-status-benefits is-${benefits.tone}`} aria-label="Status benefits">
      <header>
        <div>
          <span>{benefits.label}</span>
          <strong>{benefits.title}</strong>
          <p>{benefits.body}</p>
        </div>
        <aside>
          <span>Tier path</span>
          <strong>{benefits.currentTier}</strong>
          <p>{benefits.nextTier}</p>
        </aside>
      </header>

      <div className="rb-status-benefits__body">
        <section>
          <h3>Unlocked benefits</h3>
          {benefits.benefits.map((benefit) => (
            <article className={`is-${benefit.tone}${benefit.locked ? " is-locked" : ""}`} key={benefit.label}>
              <div>
                <span>{benefit.label}</span>
                <strong>{benefit.value}</strong>
                <p>{benefit.body}</p>
              </div>
              {benefit.action && benefit.actionLabel && (
                <button type="button" onClick={() => onAction(benefit.action)}>{benefit.actionLabel}</button>
              )}
            </article>
          ))}
        </section>

        <section>
          <h3>Qualification gates</h3>
          {benefits.gates.map((gate) => (
            <article className={`is-${gate.tone}${gate.locked ? " is-locked" : ""}`} key={gate.label}>
              <div>
                <span>{gate.label}</span>
                <strong>{gate.value}</strong>
                <p>{gate.body}</p>
              </div>
              {gate.action && gate.actionLabel && (
                <button type="button" onClick={() => onAction(gate.action)}>{gate.actionLabel}</button>
              )}
            </article>
          ))}
        </section>
      </div>
    </section>
  )
}

function RewardLedgerPanel({
  ledger,
  onAction,
}: {
  ledger: RecruiterRewardLedger
  onAction: (action: RecruiterStatusBenefit["action"]) => void
}) {
  return (
    <section className="rb-reward-ledger">
      <header>
        <div>
          <span>Reward ledger</span>
          <strong>{ledger.headline}</strong>
          <p>{ledger.body}</p>
        </div>
        <div className="rb-reward-ledger__summary">
          {ledger.summary.map((item) => (
            <article className={`is-${item.tone}`} key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </header>

      <div className="rb-reward-ledger__body">
        <div className="rb-reward-ledger__rows">
          {ledger.rows.map((row) => {
            const action = row.action
            return (
              <article className={`is-${row.tone}`} key={row.id}>
                <div>
                  <span>{row.category}</span>
                  <strong>{row.title}</strong>
                  <p>{row.body}</p>
                </div>
                <dl>
                  <div><dt>Status</dt><dd>{row.status}</dd></div>
                  <div><dt>Schedule</dt><dd>{row.schedule}</dd></div>
                </dl>
                <footer>
                  <b>{row.value}</b>
                  {action && row.actionLabel && (
                    <button type="button" onClick={() => onAction(action)}>{row.actionLabel}</button>
                  )}
                </footer>
              </article>
            )
          })}
          {ledger.rows.length === 0 && (
            <p className="rb-empty">No reward ledger rows yet. Advance a submission or select a weekly challenge to start tracking money movement.</p>
          )}
        </div>

        <aside className="rb-reward-ledger__policy">
          {ledger.policies.map((policy) => (
            <article className={`is-${policy.tone}`} key={policy.label}>
              <span>{policy.label}</span>
              <strong>{policy.value}</strong>
              <p>{policy.body}</p>
            </article>
          ))}
        </aside>
      </div>
    </section>
  )
}

function PayoutReadinessPanel({
  readiness,
  onSettings,
  onSubmissions,
}: {
  readiness: RecruiterPayoutReadiness
  onSettings: () => void
  onSubmissions: () => void
}) {
  const runAction = (action?: RecruiterPayoutReadinessStep["action"]) => {
    if (action === "settings") onSettings()
    if (action === "submissions") onSubmissions()
  }
  return (
    <section className={`rb-payout-readiness is-${readiness.tone}`} aria-label="Payout readiness">
      <header>
        <div>
          <span>{readiness.label}</span>
          <strong>{readiness.title}</strong>
          <p>{readiness.body}</p>
        </div>
        <div className="rb-payout-readiness__cards">
          {readiness.cards.map((card) => (
            <article className={`is-${card.tone}`} key={card.label}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </header>

      <div className="rb-payout-readiness__steps">
        {readiness.steps.map((step) => (
          <article className={`is-${step.tone}`} key={step.label}>
            <div>
              <span>{step.label}</span>
              <strong>{step.value}</strong>
              <p>{step.body}</p>
            </div>
            {step.action && step.actionLabel && (
              <button type="button" onClick={() => runAction(step.action)}>{step.actionLabel}</button>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

function SettingsTab({
  session,
  approvedRoleCount,
  submissions,
  sourcedCandidates,
  earningsMetrics,
  onSessionChange,
}: {
  session: RecruiterSession
  approvedRoleCount: number
  submissions: RecruiterSubmissionItem[]
  sourcedCandidates: RecruiterSourcedCandidateItem[]
  earningsMetrics: RecruiterEarningsMetrics
  onSessionChange: (session: RecruiterSession) => void
}) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const newRolesEmail = session.recruiter.notificationPreferences?.newRolesEmail !== false
  const businessCenter = buildRecruiterBusinessCenter(session, approvedRoleCount, submissions, sourcedCandidates, earningsMetrics)
  const setNewRolesEmail = async (next: boolean) => {
    setSaving(true)
    setErr(null)
    try {
      const updated = await updateRecruiterPreferences({
        notificationPreferences: { ...session.recruiter.notificationPreferences, newRolesEmail: next },
        workspacePreferences: session.recruiter.workspacePreferences ?? { primaryRoleIds: [] },
      })
      onSessionChange(updated)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  const copyReferralBrief = async () => {
    setCopyState("idle")
    try {
      await navigator.clipboard.writeText(businessCenter.referralBrief)
      setCopyState("copied")
      window.setTimeout(() => setCopyState("idle"), 1800)
    } catch {
      setCopyState("failed")
    }
  }
  return (
    <section className="rb-panel rb-panel--settings">
      <header className="rb-panel__head">
        <div><h2>Recruiter business center</h2><p>Account identity, payout readiness, referrals, and role alerts.</p></div>
      </header>
      <div className={`rb-account-center__hero is-${businessCenter.tone}`}>
        <div>
          <span>Business status</span>
          <h3>{businessCenter.title}</h3>
          <p>{businessCenter.body}</p>
        </div>
        <strong>{businessCenter.value}</strong>
      </div>
      <div className="rb-account-center__cards">
        {businessCenter.cards.map((card) => (
          <article className={`is-${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.body}</p>
          </article>
        ))}
      </div>
      <dl className="rb-settings">
        <div><dt>Name</dt><dd>{session.recruiter.name}</dd></div>
        <div><dt>Email</dt><dd>{session.recruiter.email}</dd></div>
        <div><dt>Access model</dt><dd>Firebase Auth + one-use recruiter code</dd></div>
        <div><dt>Approved roles</dt><dd>{approvedRoleCount}/{APPROVED_ROLE_LIMIT} access limit</dd></div>
      </dl>
      <div className="rb-account-center__grid">
        <article className="rb-account-workflow">
          <header>
            <span>Operating workflow</span>
            <strong>What has to be true</strong>
          </header>
          <div>
            {businessCenter.workflow.map((step) => (
              <section className={`is-${step.tone}`} key={step.label}>
                <span>{step.label}</span>
                <strong>{step.value}</strong>
                <p>{step.body}</p>
              </section>
            ))}
          </div>
        </article>
        <article className="rb-referral-brief">
          <header>
            <div>
              <span>Recruiter referral</span>
              <strong>Request a new one-use code</strong>
            </div>
            <a href={businessCenter.referralMailto}>Email ops</a>
          </header>
          <pre>{businessCenter.referralBrief}</pre>
          <button type="button" onClick={() => void copyReferralBrief()}>
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy referral brief"}
          </button>
        </article>
      </div>
      <label className="rb-settings-toggle">
        <span>
          <strong>New role email notifications</strong>
          <em>WeKruit will email you when a new collab role opens for submissions.</em>
        </span>
        <input
          type="checkbox"
          checked={newRolesEmail}
          disabled={saving}
          onChange={(e) => void setNewRolesEmail(e.target.checked)}
        />
      </label>
      {err && <p className="rb-access__err">{err}</p>}
      <p className="rb-settings__note">
        WeKruit sends recruiter invitations by email. Each invite binds to exactly one Google account.
      </p>
    </section>
  )
}

function RoleCommandCard({ insight }: { insight: RoleInsight }) {
  const { job } = insight
  return (
    <article className={`rb-role-command-card is-${insight.tone}`}>
      <div className="rb-role-command-card__score">
        <strong>{insight.score}</strong>
        <span>{insight.scoreLabel}</span>
      </div>
      <div className="rb-role-command-card__body">
        <span>{insight.urgency} · {insight.marketLoad} · {roleRewardLabel(job)} reward</span>
        <h3><Link to={`/recruiters/job/${job.jobId}`}>{job.title}</Link></h3>
        <p>{job.recruiterBoard.label.company} · {job.recruiterBoard.label.location}</p>
        <div>
          {insight.reasons.map((reason) => <em key={reason}>{reason}</em>)}
        </div>
      </div>
      <Link className="rb-role-command-card__action" to={`/recruiters/job/${job.jobId}`}>
        {insight.nextAction}
      </Link>
    </article>
  )
}

function RoleCard({
  insight,
  primarySlotsFull,
  disabled,
  onAccess,
}: {
  insight: RoleInsight
  primarySlotsFull: boolean
  disabled: boolean
  onAccess: () => void
}) {
  const { job, primary } = insight
  const { hard, fit } = roleChecklistCounts(job)
  const opportunityTerms = roleOpportunityTerms(insight)
  const marketChips = [
    `${insight.recruiterCount} recruiter${insight.recruiterCount === 1 ? "" : "s"} active`,
    `${insight.platformReadyCount} ready`,
    `${insight.platformSubmissionCount} total submitted`,
    insight.openQuestionCount ? `${insight.openQuestionCount} open Q` : "",
    insight.marketFrictionCount ? `${insight.marketFrictionCount} friction signal${insight.marketFrictionCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean).slice(0, 4)
  const application = insight.application
  const slotDisabled = disabled || (!primary && primarySlotsFull)
  const accessTone = primary ? "success" : roleApplicationStatusTone(application?.status)
  return (
    <article className={`rb-role-card ${primary ? "is-primary" : ""}`}>
      <div className="rb-role-card__topline">
        <span className="rb-role-card__code">Co. {job.recruiterBoard.label.companyCode}</span>
        {isNewRole(job) && <span className="rb-role-card__new">New</span>}
      </div>
      <h3><Link to={`/recruiters/job/${job.jobId}`}>{job.title}</Link></h3>
      <p>{job.recruiterBoard.label.company} - {job.recruiterBoard.label.location}</p>
      <div className="rb-role-card__intelligence">
        <span className={`rb-fit-signal is-${insight.tone}`}>{insight.scoreLabel} {insight.score}</span>
        <strong>{insight.nextAction}</strong>
        <em>{insight.nextActionBody}</em>
      </div>
      <div className="rb-role-card__economics" aria-label="Role opportunity economics">
        {opportunityTerms.slice(0, 4).map((term) => (
          <div className={`is-${term.tone}`} key={term.label}>
            <span>{term.label}</span>
            <strong>{term.value}</strong>
            <em>{term.body}</em>
          </div>
        ))}
      </div>
      <div className="rb-role-card__pills">
        {job.recruiterBoard.label.pills.map((p, i) => <span key={i} className={`rb-pill ${p.tone ?? ""}`}>{p.text}</span>)}
      </div>
      <div className="rb-role-card__signal">
        <span>{insight.urgency}</span>
        <em>{insight.sourcedCount} sourced by you - {insight.readyCount} ready - {insight.submissionCount} submitted by you</em>
      </div>
      <div className="rb-role-card__market" aria-label="Platform market signal">
        {marketChips.map((chip) => <span key={chip}>{chip}</span>)}
      </div>
      <footer>
        <span>{hard} hard checks</span>
        <span>{fit} fit checks</span>
        <span className={`rb-status is-${accessTone}`}>{primary ? "Approved" : roleApplicationStatusLabel(application?.status)}</span>
        {primary ? (
          <Link className="rb-role-card__footer-action" to={`/recruiters/job/${job.jobId}`}>Open brief</Link>
        ) : (
          <button
            type="button"
            disabled={slotDisabled || application?.status === "pending"}
            onClick={onAccess}
          >
            {application?.status === "pending" ? "Pending" : primarySlotsFull ? "Limit full" : "Apply"}
          </button>
        )}
      </footer>
    </article>
  )
}

function RoleRow({ job }: { job: CollabJob }) {
  return (
    <Link to={`/recruiters/job/${job.jobId}`} className="rb-role-row">
      <span className="rb-role-row__logo">{job.recruiterBoard.label.companyCode}</span>
      <span className="rb-role-row__body">
        <strong>{job.title}</strong>
        <em>{job.recruiterBoard.label.company} · {job.recruiterBoard.label.location}</em>
      </span>
      <span className="rb-role-row__action">Open role</span>
    </Link>
  )
}

function SubmissionRow({
  submission,
  expanded = false,
  onResendConfirmation,
  resendingConfirmation = false,
}: {
  submission: RecruiterSubmissionItem
  expanded?: boolean
  onResendConfirmation?: () => void
  resendingConfirmation?: boolean
}) {
  const meta = statusMeta(submission.status)
  const consent = candidateConsentMeta(submission.candidateConsentStatus)
  const nextAction = submissionNextAction(submission.status)
  const activity = submissionActivityEvents(submission)
  const feedbackReasons = submissionFeedbackReasonLabels(submission)
  const feedbackRating = submissionFeedbackRating(submission)
  return (
    <article id={submissionDomId(submission.id)} className={`rb-submission ${expanded ? "is-expanded" : ""}`}>
      <div className="rb-submission__main">
        <span className={`rb-status is-${meta.tone}`}>{meta.label}</span>
        <div>
          <h3>{submission.candidate?.name ?? "Candidate"}</h3>
          <p>{shortText(submission.jobTitleSnapshot, "Role")} · {shortText(submission.companyLabelSnapshot, "Company")}</p>
        </div>
      </div>
      <div className="rb-submission__side">
        <span>{formatWhen(submission)}</span>
        <strong>{submissionScore(submission)}</strong>
        <em>{submissionModeLabel(submission.submissionMode)}</em>
        {(submission.inboundJobId || submission.jobId) && (
          <Link to={`/recruiters/job/${submission.inboundJobId || submission.jobId}`}>Open sheet</Link>
        )}
      </div>
      {expanded && (
        <div className="rb-submission__detail">
          <SubmissionStatusStepper status={submission.status} requestedInfo={submission.requestedInfo} />
          <p><strong>Candidate:</strong> {submission.candidate?.currentRole || "Role not provided"}{submission.candidate?.yoe ? ` · ${submission.candidate.yoe} YOE` : ""}</p>
          {submission.candidate?.email && <p><strong>Email:</strong> {submission.candidate.email}</p>}
          {submission.candidate?.link && <a href={submission.candidate.link} target="_blank" rel="noopener noreferrer">{shortText(submission.candidate.link, submission.candidate.link, 80)}</a>}
          {submissionHasStructuredFeedback(submission) && (
            <blockquote>
              {feedbackRating !== null && <strong>WeKruit rating {feedbackRating}/4</strong>}
              {submission.recruiterFeedbackNote && <span>{submission.recruiterFeedbackNote}</span>}
              {feedbackReasons.length > 0 && (
                <em>{feedbackReasons.join(" · ")}</em>
              )}
            </blockquote>
          )}
          <div className="rb-submission-receipt" aria-label="Submission ownership receipt">
            <div>
              <span>Ownership receipt</span>
              <strong>{submissionReceiptId(submission)}</strong>
            </div>
            <div>
              <span>Submission lane</span>
              <strong>{submissionModeLabel(submission.submissionMode)}</strong>
            </div>
            <div>
              <span>Candidate consent</span>
              <strong>{consent.label}</strong>
            </div>
            <div>
              <span>Submitted</span>
              <strong>{formatActivityDate(submission.createdAt)}</strong>
            </div>
            <div>
              <span>WeKruit rating</span>
              <strong>{submissionFeedbackRatingLabel(submission)}</strong>
            </div>
          </div>
          <div className={`rb-next-step is-${nextAction.tone}`}>
            <strong>{nextAction.title}</strong>
            <span>{nextAction.body}</span>
          </div>
          {candidateConfirmationCanResend(submission) && (
            <div className={`rb-confirmation-action is-${consent.tone}`}>
              <div>
                <strong>Candidate confirmation</strong>
                <span>{candidateConfirmationActionBody(submission)}</span>
              </div>
              {onResendConfirmation && (
                <button type="button" onClick={onResendConfirmation} disabled={resendingConfirmation}>
                  {resendingConfirmation ? "Sending..." : "Resend confirmation"}
                </button>
              )}
            </div>
          )}
          <div className="rb-activity-log" aria-label="Submission activity">
            {activity.map((event) => (
              <div className={`rb-activity-log__item is-${event.tone}`} key={event.id}>
                <span />
                <div>
                  <strong>{event.label}</strong>
                  <p>{event.detail}</p>
                  <em>{event.at}</em>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  )
}
