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
  onAuthStateChanged,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth"
import { Link, useSearchParams } from "react-router-dom"
import "../styles/recruiter-board.css"
import {
  fetchCollabJobs,
  fetchRecruiterRoleFeedback,
  fetchRecruiterRoleIntelligence,
  fetchRecruiterRoleApplications,
  fetchRecruiterRoleQuestions,
  fetchRecruiterSourcedCandidates,
  fetchRecruiterSubmissions,
  fetchRecruiterNotifications,
  getRecruiterProfile,
  markRecruiterNotificationsRead,
  registerRecruiterAccess,
  resendRecruiterCandidateConfirmation,
  saveRecruiterSourcedCandidate,
  saveRecruiterRoleApplication,
  updateRecruiterPreferences,
  type CollabJob,
  type RecruiterCandidateOutreachStatus,
  type RecruiterNotificationItem,
  type RecruiterRoleApplicationInput,
  type RecruiterRoleApplicationItem,
  type RecruiterRoleFeedbackItem,
  type RecruiterRoleIntelligenceItem,
  type RecruiterRoleQuestionItem,
  type RecruiterSession,
  type RecruiterSourcedCandidateInput,
  type RecruiterSourcedCandidateItem,
  type RecruiterSourcedCandidateStage,
  type RecruiterSubmissionItem,
} from "../lib/recruiter-board-api.js"
import { auth } from "../lib/firebase.js"
import { redirectResultPromise } from "../lib/auth-redirect-bootstrap.js"

type RecruiterTab = "overview" | "inbox" | "roles" | "access" | "matches" | "candidates" | "submissions" | "performance" | "earnings" | "settings"

const TABS: Array<{ id: RecruiterTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "inbox", label: "Inbox" },
  { id: "roles", label: "Roles" },
  { id: "access", label: "Role access" },
  { id: "matches", label: "Matchboard" },
  { id: "candidates", label: "Candidates" },
  { id: "submissions", label: "Submissions" },
  { id: "performance", label: "Performance" },
  { id: "earnings", label: "Earnings" },
  { id: "settings", label: "Settings" },
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
const SINGLE_SUBMISSION_WEEKLY_LIMIT = 5
const WEEKLY_SUBMISSION_TARGET = 8
const DEFAULT_SUCCESS_FEE = 10_000
const PREFERRED_INTERVIEW_RATE_TARGET = 50

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

const CALIBRATION_LABELS: Record<string, { label: string; tone: "live" | "info" | "success" | "warn" | "mute" }> = {
  not_rated: { label: "Not rated", tone: "mute" },
  calibration_requested: { label: "Needs adjustment", tone: "info" },
  good_fit: { label: "Good fit", tone: "success" },
  bad_fit: { label: "Not a fit", tone: "warn" },
  suggested: { label: "Suggested direction", tone: "info" },
}

const SUBMISSION_PROGRESS = [
  { id: "submitted", label: "Submitted" },
  { id: "reviewing", label: "WeKruit review" },
  { id: "advanced", label: "Hiring team" },
  { id: "interviewing", label: "Interviewing" },
  { id: "offer", label: "Offer" },
  { id: "hired", label: "Hired" },
] as const

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
const ADVANCED_STATUSES = ["advanced", "interviewing", "offer", "hired"]
const LATE_STAGE_STATUSES = ["interviewing", "offer", "hired"]
const CLOSED_NEGATIVE_STATUSES = ["rejected", "duplicate"]
const OPEN_SUBMISSION_STATUSES = ["submitted", "new", "reviewing", "advanced", "interviewing", "backburner", "offer"]

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

function candidateConfirmationCanResend(submission: RecruiterSubmissionItem): boolean {
  return [
    "pending_candidate_confirmation",
    "confirmation_email_failed",
    "confirmation_email_not_configured",
  ].includes(submission.candidateConsentStatus ?? "")
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

function buildSubmissionDashboard(submissions: RecruiterSubmissionItem[]) {
  const active = submissions.filter(submissionIsActiveReview)
  const advanced = submissions.filter(submissionIsAdvanced)
  const closed = submissions.filter(submissionIsClosed)
  const feedback = submissions.filter(submissionHasStructuredFeedback)
  const rated = submissions.filter((submission) => submissionFeedbackRating(submission) !== null)
  const needsAction = submissions.filter(submissionNeedsAction)
  return {
    active,
    advanced,
    closed,
    feedback,
    needsAction,
    hero: [
      { label: "Active review", value: String(active.length), body: "Submitted, queued, or under WeKruit review.", tone: active.length ? "live" : "mute" },
      { label: "Advanced", value: String(advanced.length), body: "Sent forward, interviewing, offer, or hired.", tone: advanced.length ? "success" : "mute" },
      { label: "Rated submissions", value: String(rated.length), body: "WeKruit /4 quality signal plus reasons.", tone: rated.length ? "info" : "mute" },
      { label: "Needs action", value: String(needsAction.length), body: "Aged reviews or feedback that should change sourcing.", tone: needsAction.length ? "warn" : "success" },
    ] as Array<{ label: string; value: string; body: string; tone: "live" | "info" | "success" | "warn" | "mute" }>,
  }
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

function normalizeTokens(value: string | undefined): string[] {
  if (!value) return []
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
}

function cleanRecruiterEmail(value: string): string {
  return value.trim().toLowerCase()
}

function createRecruiterGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: "select_account" })
  return provider
}

const RECRUITER_ACCESS_PENDING_KEY = "wk_recruiter_access_pending_v1"

interface PendingRecruiterAccess {
  inviteCode: string
  createdAtMs: number
}

function readPendingRecruiterAccess(): PendingRecruiterAccess | null {
  const readStored = (storage: Storage): PendingRecruiterAccess | null => {
    const raw = storage.getItem(RECRUITER_ACCESS_PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingRecruiterAccess>
    if (!parsed.inviteCode || typeof parsed.inviteCode !== "string") return null
    if (typeof parsed.createdAtMs !== "number" || Date.now() - parsed.createdAtMs > 10 * 60 * 1000) {
      storage.removeItem(RECRUITER_ACCESS_PENDING_KEY)
      return null
    }
    return { inviteCode: parsed.inviteCode, createdAtMs: parsed.createdAtMs }
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

function writePendingRecruiterAccess(inviteCode: string) {
  const payload = JSON.stringify({
    inviteCode,
    createdAtMs: Date.now(),
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

function recruiterNameFromGoogleUser(user: User): string {
  const displayName = user.displayName?.trim()
  if (displayName) return displayName
  const emailPrefix = user.email?.split("@")[0]?.replace(/[._-]+/g, " ").trim()
  return emailPrefix || "Recruiter"
}

function authErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : ""
}

function formatRecruiterAuthError(error: unknown): string {
  const code = authErrorCode(error)
  switch (code) {
    case "auth/account-exists-with-different-credential":
      return "That email already uses another Firebase sign-in method. Use the Google account tied to this recruiter access code."
    case "auth/cancelled-popup-request":
      return "Google sign-in was interrupted. Try again."
    case "auth/unauthorized-domain":
      return "This domain is not authorized for Google sign-in in Firebase yet."
    default:
      if (error instanceof Error) {
        if (error.message === "unauthorized") {
          return "This Google account does not have recruiter access. Enter an access code first."
        }
        if (error.message === "invalid_or_expired_invite_code") {
          return "That access code is invalid, expired, already bound to another recruiter, or does not match this Google account."
        }
        if (error.message) return error.message
      }
      return code ? code.replace(/^auth\//, "").replace(/-/g, " ") : "Recruiter access failed."
  }
}

export default function RecruiterBoard() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [session, setSession] = useState<RecruiterSession | null>(null)
  const [authReady, setAuthReady] = useState(false)
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
  const [accessError, setAccessError] = useState<string | null>(null)
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const tabParam = searchParams.get("tab")
  const activeTab = TABS.some((t) => t.id === tabParam) ? tabParam as RecruiterTab : "overview"

  useEffect(() => {
    fetchCollabJobs()
      .then((list) => setJobs(list))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  useEffect(() => {
    let active = true
    let handlingUid: string | null = null

    const finishRecruiterAuth = async (user: User | null) => {
      if (!user) {
        if (!active) return
        setSession(null)
        setSourcedCandidates([])
        setSubmissions([])
        setRoleApplications([])
        setRoleFeedback([])
        setRoleQuestions([])
        setRoleIntelligence([])
        setNotifications([])
        setStatusLoaded(false)
        setAuthReady(true)
        return
      }
      if (handlingUid === user.uid) return
      handlingUid = user.uid
      const pending = readPendingRecruiterAccess()
      if (pending) {
        try {
          const email = cleanRecruiterEmail(user.email ?? "")
          if (!email) throw new Error("Google did not return an email for this account.")
          const next = await registerRecruiterAccess({
            name: recruiterNameFromGoogleUser(user),
            email,
            inviteCode: pending.inviteCode,
          })
          clearPendingRecruiterAccess()
          if (active) {
            setAccessError(null)
            setSession(next)
          }
          return
        } catch (e) {
          clearPendingRecruiterAccess()
          await signOut(auth()).catch(() => undefined)
          if (active) {
            setSession(null)
            setSourcedCandidates([])
            setSubmissions([])
            setRoleApplications([])
            setRoleFeedback([])
            setRoleQuestions([])
            setRoleIntelligence([])
            setNotifications([])
            setStatusLoaded(false)
            setAccessError(formatRecruiterAuthError(e))
          }
          return
        } finally {
          if (active) setAuthReady(true)
        }
      }

      try {
        const next = await getRecruiterProfile()
        if (active) {
          setAccessError(null)
          setSession(next)
        }
      } catch {
        await signOut(auth()).catch(() => undefined)
        if (active) {
          setSession(null)
          setSourcedCandidates([])
          setSubmissions([])
          setRoleApplications([])
          setRoleFeedback([])
          setRoleQuestions([])
          setRoleIntelligence([])
          setNotifications([])
          setStatusLoaded(false)
          setAccessError("Enter a recruiter access code before choosing a Google account. Google sign-in alone cannot open this workspace.")
        }
      } finally {
        if (active) setAuthReady(true)
      }
    }

    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      void finishRecruiterAuth(user)
    })
    void redirectResultPromise
      .then((result) => finishRecruiterAuth(result?.user ?? auth().currentUser))
      .catch((err) => {
        clearPendingRecruiterAccess()
        if (active) {
          setAccessError(formatRecruiterAuthError(err))
          setAuthReady(true)
        }
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

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

  const setTab = (tab: RecruiterTab) => setSearchParams(tab === "overview" ? {} : { tab })
  const openRoleAccess = (jobId?: string) => {
    setAccessDraftJobId(jobId ?? null)
    setTab("access")
  }
  const primaryRoleIds = recruiterApprovedRoleIds(session, roleApplications)
  const saveRoleApplication = async (input: RecruiterRoleApplicationInput) => {
    if (!session) return
    setRoleApplicationSavingId(input.jobId)
    setSubmissionError(null)
    try {
      const saved = await saveRecruiterRoleApplication(input)
      setRoleApplications((rows) => [saved, ...rows.filter((row) => row.id !== saved.id)])
    } catch (e) {
      setSubmissionError(e instanceof Error ? e.message : String(e))
    } finally {
      setRoleApplicationSavingId(null)
    }
  }
  if (!authReady) {
    return <div className="rb-access"><div className="rb-state">Loading recruiter workspace...</div></div>
  }

  if (!session) {
    return <RecruiterAccessGate initialError={accessError} />
  }

  const openJobs = jobs ?? []
  const stats = computeRecruiterStats(openJobs, submissions, sourcedCandidates)
  const operatingMetrics = computeRecruiterOperatingMetrics(
    openJobs,
    submissions,
    sourcedCandidates,
    roleFeedback,
    roleQuestions,
    roleIntelligence,
    primaryRoleIds,
  )
  const earningsMetrics = computeRecruiterEarningsMetrics(
    openJobs,
    submissions,
    sourcedCandidates,
    roleFeedback,
    roleQuestions,
    primaryRoleIds,
    operatingMetrics,
  )
  const inboxSummary = buildRecruiterInboxSummary(submissions, sourcedCandidates, roleQuestions, notifications)
  const markAllNotificationsRead = async () => {
    const unread = notifications.filter((notification) => !notification.readAt)
    if (unread.length === 0) return
    await markRecruiterNotificationsRead({ all: true })
    const readAt = new Date().toISOString()
    setNotifications((rows) => rows.map((notification) => notification.readAt ? notification : { ...notification, readAt, updatedAt: readAt }))
  }
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
        <nav className="rb-platform__tabs" aria-label="Recruiter workspace">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? "is-active" : ""}
              onClick={() => setTab(tab.id)}
            >
              {tab.label}
              {tab.id === "inbox" && inboxSummary.needsAction > 0 ? <span>{inboxSummary.needsAction}</span> : null}
              {tab.id === "candidates" && sourcedCandidates.length > 0 ? <span>{sourcedCandidates.length}</span> : null}
              {tab.id === "submissions" && submissions.length > 0 ? <span>{submissions.length}</span> : null}
            </button>
          ))}
        </nav>
        <Link to={openJobs[0] ? `/recruiters/job/${openJobs[0].jobId}` : "#"} className="rb-platform__cta">
          Submit candidate
        </Link>
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
            <p className="rb-overline">Private recruiter workspace</p>
            <h1>{activeTab === "overview" ? `Good to see you, ${session.recruiter.name.split(" ")[0]}.` : TABS.find((t) => t.id === activeTab)?.label}</h1>
          </div>
          <div className="rb-platform__top-actions">
            <button type="button" className="rb-btn" onClick={() => void reloadSubmissions()}>
              Refresh status
            </button>
            <button type="button" className="rb-btn primary" onClick={() => setTab("roles")}>
              Browse roles
            </button>
          </div>
        </header>

        {error && <div className="rb-state error">Could not load roles: {error}</div>}
        {submissionError && <div className="rb-state error">Could not load your submissions: {submissionError}</div>}

        {activeTab === "overview" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "overview" && statusLoaded && (
          <OverviewTab
            stats={stats}
            jobs={openJobs}
            submissions={submissions}
            sourcedCandidates={sourcedCandidates}
            roleQuestions={roleQuestions}
            roleIntelligence={roleIntelligence}
            roleApplications={roleApplications}
            operatingMetrics={operatingMetrics}
            primaryRoleIds={primaryRoleIds}
            onRoles={() => setTab("roles")}
            onMatches={() => setTab("matches")}
            onCandidates={() => setTab("candidates")}
            onSubmissions={() => setTab("submissions")}
            onPerformance={() => setTab("performance")}
            onAccess={openRoleAccess}
          />
        )}
        {activeTab === "inbox" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "inbox" && statusLoaded && (
          <RecruiterInboxTab
            jobs={openJobs}
            submissions={submissions}
            sourcedCandidates={sourcedCandidates}
            roleFeedback={roleFeedback}
            roleQuestions={roleQuestions}
            notifications={notifications}
            onRoles={() => setTab("roles")}
            onCandidates={() => setTab("candidates")}
            onSubmissions={() => setTab("submissions")}
            onMatches={() => setTab("matches")}
            onMarkAllNotificationsRead={() => void markAllNotificationsRead()}
          />
        )}
        {activeTab === "roles" && (
          <RolesTab
            jobs={openJobs}
            submissions={submissions}
            sourcedCandidates={sourcedCandidates}
            roleFeedback={roleFeedback}
            roleQuestions={roleQuestions}
            roleIntelligence={roleIntelligence}
            roleApplications={roleApplications}
            loading={!jobs && !error}
            primaryRoleIds={primaryRoleIds}
            roleApplicationSavingId={roleApplicationSavingId}
            onAccess={openRoleAccess}
          />
        )}
        {activeTab === "access" && statusLoaded && (
          <RoleAccessTab
            jobs={openJobs}
            submissions={submissions}
            sourcedCandidates={sourcedCandidates}
            roleFeedback={roleFeedback}
            roleQuestions={roleQuestions}
            roleIntelligence={roleIntelligence}
            roleApplications={roleApplications}
            primaryRoleIds={primaryRoleIds}
            roleApplicationSavingId={roleApplicationSavingId}
            initialApplicationJobId={accessDraftJobId}
            onRoleApplicationSave={(input) => void saveRoleApplication(input)}
            onRoles={() => setTab("roles")}
            onCandidates={() => setTab("candidates")}
          />
        )}
        {activeTab === "access" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "matches" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "matches" && statusLoaded && <MatchboardTab jobs={openJobs} candidates={sourcedCandidates} submissions={submissions} primaryRoleIds={primaryRoleIds} />}
        {activeTab === "candidates" && (
          !statusLoaded ? <RecruiterStatusLoading /> :
          <CandidatesTab
            jobs={openJobs}
            candidates={sourcedCandidates}
            onSaved={(saved) => setSourcedCandidates((rows) => sortSourcedCandidates([saved, ...rows.filter((row) => row.id !== saved.id)]))}
          />
        )}
        {activeTab === "submissions" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "submissions" && statusLoaded && <SubmissionsTab submissions={submissions} onRefresh={reloadSubmissions} />}
        {activeTab === "performance" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "performance" && statusLoaded && <PerformanceTab jobs={openJobs} candidates={sourcedCandidates} submissions={submissions} primaryRoleIds={primaryRoleIds} roleFeedback={roleFeedback} operatingMetrics={operatingMetrics} />}
        {activeTab === "earnings" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "earnings" && statusLoaded && (
          <EarningsTab
            metrics={earningsMetrics}
            onRoles={() => setTab("roles")}
            onCandidates={() => setTab("candidates")}
            onSubmissions={() => setTab("submissions")}
            onPerformance={() => setTab("performance")}
          />
        )}
        {activeTab === "settings" && <SettingsTab session={session} approvedRoleCount={primaryRoleIds.length} onSessionChange={setSession} />}
      </main>
    </div>
  )
}

function computeRecruiterStats(
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
) {
  const reviewing = submissions.filter((s) => ACTIVE_REVIEW_STATUSES.includes(s.status ?? "submitted")).length
  const advanced = submissions.filter((s) => ADVANCED_STATUSES.includes(s.status ?? "")).length
  const interviews = submissions.filter((s) => LATE_STAGE_STATUSES.includes(s.status ?? "")).length
  const feedback = submissions.filter(submissionHasStructuredFeedback).length
  const activeSource = sourcedCandidates.filter((c) => c.stage !== "archived").length
  const interviewRate = submissions.length ? Math.round((interviews / submissions.length) * 100) : 0
  return [
    { label: "Open roles", value: String(jobs.length), meta: "live WeKruit collab searches", signal: "live", tone: "live" },
    { label: "Sourced candidates", value: String(activeSource), meta: "saved before submission", signal: "+", tone: "info" },
    { label: "Pending review", value: String(reviewing), meta: "waiting on WeKruit or hiring team", signal: "wait", tone: "warn" },
    { label: "Interview rate", value: `${interviewRate}%`, meta: feedback ? `${advanced} advanced - ${feedback} rated/feedback` : `${advanced} advanced`, signal: "rate", tone: "success" },
  ]
}

type OperatingTone = "live" | "info" | "success" | "warn" | "mute"

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
  const pendingSubmissions = submissions.filter((submission) => ACTIVE_REVIEW_STATUSES.includes(submission.status ?? "submitted"))
  const advancedSubmissions = submissions.filter((submission) => ADVANCED_STATUSES.includes(submission.status ?? ""))
  const closedNegative = submissions.filter((submission) => CLOSED_NEGATIVE_STATUSES.includes(submission.status ?? ""))
  const ratedSubmissions = submissions
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
  const sourceToSubmitRate = activeCandidates.length ? Math.round((submissions.length / activeCandidates.length) * 100) : 0
  const firstRoundRate = submissions.length ? Math.round((advancedSubmissions.length / submissions.length) * 100) : 0
  const rejectionRate = submissions.length ? Math.round((closedNegative.length / submissions.length) * 100) : 0
  const hardOrBlockedRoles = roleIntelligence.length
    ? roleIntelligence.filter((item) => item.feedback.hard > 0 || item.feedback.blocked > 0).length
    : roleFeedback.filter((feedback) => feedback.difficulty === "hard" || feedback.difficulty === "blocked").length
  const remainingWeeklySubmissions = Math.min(WEEKLY_SUBMISSION_TARGET, Math.max(1, WEEKLY_SUBMISSION_TARGET - submissions.length))
  const qualityScore = submissions.length
    ? clampNumber(Math.round(
      averageRating !== null
        ? 32 + (averageRating / 4) * 60 + Math.min(8, firstRoundRate / 10) - Math.min(12, rejectionRate / 5)
        : 58 + firstRoundRate * 0.55 - rejectionRate * 0.45 + Math.min(16, feedbackNotes * 3),
    ), 24, 98)
    : activeCandidates.length
      ? clampNumber(44 + readyCandidates.length * 7 + Math.min(14, activeCandidates.length * 2), 44, 74)
      : null
  const statusLabel = submissions.length >= WEEKLY_SUBMISSION_TARGET && firstRoundRate >= 30 && rejectionRate <= 40
    ? "Preferred track"
    : submissions.length >= 3 || activeCandidates.length >= 6
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
    : submissions.length < 3
      ? "Early signal only. More submissions and feedback will make this meaningful."
      : `${firstRoundRate}% advanced/interview/offer signal with ${rejectionRate}% rejected or duplicate.`
  const reviewTone: OperatingTone = activeCandidates.length === 0 && submissions.length === 0
    ? "mute"
    : rejectionRate >= 50 && submissions.length >= 3
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
        value: `${submissions.length}/${WEEKLY_SUBMISSION_TARGET}`,
        body: `${pendingSubmissions.length} pending, ${advancedSubmissions.length} advanced, ${cleanLanes} clean lanes open.`,
        tone: submissions.length >= WEEKLY_SUBMISSION_TARGET ? "success" : submissions.length ? "info" : "mute",
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
        tone: firstRoundRate >= 30 ? "success" : submissions.length ? "info" : "mute",
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

type RecruiterChallenge = {
  title: string
  body: string
  progress: number
  target: number
  progressLabel: string
  reward: string
  tone: OperatingTone
  actionLabel: string
  action: "roles" | "candidates" | "submissions" | "performance"
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
  expectations: RecruiterOperatingMetric[]
}

function formatCurrencyShort(value: number): string {
  if (value >= 1_000_000) return `$${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`
  return `$${value}`
}

function roleRewardAmount(job: CollabJob): number {
  const text = job.compSummary?.toLowerCase() ?? ""
  const isFeeLike = /fee|reward|bounty|placement|success/.test(text)
  if (!isFeeLike) return DEFAULT_SUCCESS_FEE
  const match = job.compSummary?.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(k|m)?/i)
  if (!match) return DEFAULT_SUCCESS_FEE
  const raw = Number(match[1])
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SUCCESS_FEE
  const suffix = match[2]?.toLowerCase()
  if (suffix === "m") return Math.round(raw * 1_000_000)
  if (suffix === "k") return Math.round(raw * 1_000)
  return raw >= 1_000 ? Math.round(raw) : Math.round(raw * 1_000)
}

function submissionRoleId(submission: RecruiterSubmissionItem): string {
  return submission.inboundJobId || submission.jobId || ""
}

function submissionRewardAmount(submission: RecruiterSubmissionItem, jobsById: Map<string, CollabJob>): number {
  const job = jobsById.get(submissionRoleId(submission))
  return job ? roleRewardAmount(job) : DEFAULT_SUCCESS_FEE
}

function isSubmissionOpen(status?: string): boolean {
  return !CLOSED_NEGATIVE_STATUSES.includes(status ?? "")
}

function isSubmissionAdvanced(status?: string): boolean {
  return ADVANCED_STATUSES.includes(status ?? "")
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
  const openSubmissions = submissions.filter((submission) => isSubmissionOpen(submission.status))
  const advancedSubmissions = submissions.filter((submission) => isSubmissionAdvanced(submission.status))
  const hiredSubmissions = submissions.filter((submission) => submission.status === "hired")
  const interviewRate = submissions.length ? Math.round((advancedSubmissions.length / submissions.length) * 100) : 0
  const activePipelineValue = openSubmissions.reduce((sum, submission) => sum + submissionRewardAmount(submission, jobsById), 0)
  const wonValue = hiredSubmissions.reduce((sum, submission) => sum + submissionRewardAmount(submission, jobsById), 0)
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
    title: "Approved role activity",
    body: "Each approved role should have at least one live candidate or one active submission.",
    progress: coveredPrimaryRoles,
    target: Math.max(1, activePrimaryRoles || APPROVED_ROLE_LIMIT),
    progressLabel: `${coveredPrimaryRoles}/${activePrimaryRoles || APPROVED_ROLE_LIMIT} covered`,
    reward: "Protects role access",
    tone: activityCoverage >= 80 ? "success" : coveredPrimaryRoles > 0 ? "info" : "warn",
    actionLabel: activePrimaryRoles ? "Open roles" : "Apply for access",
    action: "roles",
  }
  const challenges: RecruiterChallenge[] = [
    openQuestions > 0 ? {
      title: "Clear calibration debt",
      body: "Resolve open role questions before sourcing through ambiguity.",
      progress: Math.max(0, openQuestions - openQuestions),
      target: openQuestions,
      progressLabel: `${openQuestions} open`,
      reward: "Cleaner approvals",
      tone: "warn",
      actionLabel: "Review performance",
      action: "performance",
    } : primaryActivityChallenge,
    readyCandidates > 0 ? {
      title: "Convert ready candidates",
      body: "Move ready prospects into the strongest role brief while consent is fresh.",
      progress: Math.min(readyCandidates, 3),
      target: 3,
      progressLabel: `${Math.min(readyCandidates, 3)}/3 ready`,
      reward: "Submission velocity",
      tone: "live",
      actionLabel: "Open candidates",
      action: "candidates",
    } : {
      title: "Build sourced pipeline",
      body: "Save candidates before submission so duplicate checks and role matching can work.",
      progress: Math.min(sourcedCandidates.filter((candidate) => candidate.stage !== "archived").length, 5),
      target: 5,
      progressLabel: `${Math.min(sourcedCandidates.filter((candidate) => candidate.stage !== "archived").length, 5)}/5 sourced`,
      reward: "Matchboard unlock",
      tone: sourcedCandidates.length ? "info" : "mute",
      actionLabel: "Add candidates",
      action: "candidates",
    },
    {
      title: "Interview-rate push",
      body: `Preferred-level recruiters should trend toward ${PREFERRED_INTERVIEW_RATE_TARGET}% interview movement.`,
      progress: Math.min(interviewRate, PREFERRED_INTERVIEW_RATE_TARGET),
      target: PREFERRED_INTERVIEW_RATE_TARGET,
      progressLabel: `${interviewRate}%/${PREFERRED_INTERVIEW_RATE_TARGET}%`,
      reward: "Preferred queue signal",
      tone: interviewRate >= PREFERRED_INTERVIEW_RATE_TARGET ? "success" : submissions.length ? "info" : "mute",
      actionLabel: "Open submissions",
      action: "submissions",
    },
  ]
  const payoutRows = sortSubmissions(submissions)
    .filter((submission) => OPEN_SUBMISSION_STATUSES.includes(submission.status ?? "submitted") || submission.status === "hired")
    .slice(0, 8)
    .map((submission): RecruiterPayoutRow => {
      const meta = statusMeta(submission.status)
      return {
        id: submission.id,
        candidate: submission.candidate?.name || "Candidate",
        role: submission.jobTitleSnapshot || jobsById.get(submissionRoleId(submission))?.title || "Role",
        status: meta.label,
        value: formatCurrencyShort(submissionRewardAmount(submission, jobsById)),
        payout: payoutTiming(submission.status),
        tone: meta.tone,
      }
    })
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
        body: `${openSubmissions.length} active submission${openSubmissions.length === 1 ? "" : "s"} with estimated success-fee exposure.`,
        tone: activePipelineValue > 0 ? "live" : "mute",
      },
      {
        label: "Won value",
        value: formatCurrencyShort(wonValue),
        body: `${hiredSubmissions.length} hired placement${hiredSubmissions.length === 1 ? "" : "s"} recorded.`,
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

function RecruiterStatusLoading() {
  return (
    <section className="rb-panel rb-panel--fill rb-loading-panel" aria-live="polite">
      <h2>Syncing recruiter workspace...</h2>
      <p>Loading your saved candidates, submissions, feedback, and role-alert settings.</p>
    </section>
  )
}

function RecruiterAccessGate({ initialError }: { initialError?: string | null }) {
  const [inviteCode, setInviteCode] = useState("")
  const [err, setErr] = useState<string | null>(initialError ?? null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setErr(initialError ?? null)
  }, [initialError])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedInviteCode = inviteCode.trim()
    if (!trimmedInviteCode) {
      setErr("Enter your recruiter access code first.")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      writePendingRecruiterAccess(trimmedInviteCode)
      if (auth().currentUser) await signOut(auth())
      await signInWithRedirect(auth(), createRecruiterGoogleProvider())
    } catch (error) {
      clearPendingRecruiterAccess()
      setErr(formatRecruiterAuthError(error))
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
      <div className="rb-access__bar">
        <Link to="/" className="rb-platform__brand">
          <span className="rb-platform__logo">W</span>
          <span><strong>WeKruit</strong><em>Recruiter</em></span>
        </Link>
        <Link to="/" className="rb-access__link">Back to WeKruit</Link>
      </div>
      <main className="rb-access__body">
        <section className="rb-access__copy">
          <p className="rb-overline">Invite only</p>
          <h1>Submit candidates into live WeKruit searches.</h1>
          <p>
            Browse collab roles, send qualified candidates with consent, and track
            WeKruit review status from one recruiter workspace.
          </p>
          <ul>
            <li>Roles are pulled from WeKruit collab `pa-jobs`.</li>
            <li>Every submission is bound to your Firebase recruiter account.</li>
            <li>New role alerts and feedback stay attached to your login.</li>
          </ul>
        </section>
        <form className="rb-access__card" onSubmit={submit}>
          <span className="rb-access__badge">Registered recruiters only</span>
          <h2>Enter access code</h2>
          <p className="rb-access__hint">
            Enter your code first, then choose the Google account it should bind to. Without a valid code, the workspace will not open.
          </p>
          <label>
            <span>Access code</span>
            <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="WK-XXXX-XXXX" autoComplete="one-time-code" required />
          </label>
          {err && <p className="rb-access__err">{err}</p>}
          <button className="rb-btn primary rb-btn--block" disabled={busy}>
            {busy ? "Opening Google..." : "Continue with Gmail"}
          </button>
          <button type="button" className="rb-access__reset" disabled={busy} onClick={() => void clearStuckGoogleState()}>
            Restart sign-in
          </button>
        </form>
      </main>
    </div>
  )
}

function OverviewTab({
  stats,
  jobs,
  submissions,
  sourcedCandidates,
  roleQuestions,
  roleIntelligence,
  roleApplications,
  operatingMetrics,
  primaryRoleIds,
  onRoles,
  onMatches,
  onCandidates,
  onSubmissions,
  onPerformance,
  onAccess,
}: {
  stats: Array<{ label: string; value: string; meta: string; signal: string; tone: string }>
  jobs: CollabJob[]
  submissions: RecruiterSubmissionItem[]
  sourcedCandidates: RecruiterSourcedCandidateItem[]
  roleQuestions: RecruiterRoleQuestionItem[]
  roleIntelligence: RecruiterRoleIntelligenceItem[]
  roleApplications: RecruiterRoleApplicationItem[]
  operatingMetrics: RecruiterOperatingMetrics
  primaryRoleIds: string[]
  onRoles: () => void
  onMatches: () => void
  onCandidates: () => void
  onSubmissions: () => void
  onPerformance: () => void
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
  return (
    <div className="rb-workspace">
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
  const dispatch = (action: RecruiterInboxAction) => {
    if (action === "roles") onRoles()
    else if (action === "submissions") onSubmissions()
    else if (action === "matches") onMatches()
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
  return (
    <article className={`rb-inbox-item is-${item.tone}`}>
      <div>
        <span>{item.bucket}</span>
        <strong>{item.title}</strong>
        <p>{item.body}</p>
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
  const pending = submissions.filter((s) => ACTIVE_REVIEW_STATUSES.includes(s.status ?? "submitted"))
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

type RecruiterInboxAction = "roles" | "submissions" | "matches" | "candidates"

type RecruiterInboxItem = {
  id: string
  bucket: string
  title: string
  body: string
  meta: string
  tone: "live" | "info" | "success" | "warn" | "mute"
  priority: number
  atMs: number
  cta: string
  action: RecruiterInboxAction
  href?: string
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
  const activeSubmissions = submissions.filter((submission) =>
    OPEN_SUBMISSION_STATUSES.includes(submission.status ?? "submitted"),
  ).length
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

  for (const notification of notifications) {
    const unread = !notification.readAt
    const roleId = notification.publicJobId || notification.jobId
    const href = roleId ? `/recruiters/job/${encodeURIComponent(roleId)}` : undefined
    const typeLabel =
      notification.type === "new_role" ? "New role alert" :
      notification.type === "role_application_decision" ? "Access decision" :
      notification.type === "submission_feedback" ? "Submission notification" :
      "Platform alert"
    const action: RecruiterInboxAction =
      notification.type === "submission_feedback" ? "submissions" :
      notification.type === "new_role" || notification.type === "role_application_decision" ? "roles" :
      "candidates"
    items.push({
      id: `notification-${notification.id}`,
      bucket: unread ? "Unread platform alert" : typeLabel,
      title: notification.title,
      body: notification.body,
      meta: [
        notification.roleTitle || notification.companyLabel || "",
        formatActivityDate(notification.createdAt ?? notification.updatedAt),
      ].filter(Boolean).join(" · "),
      tone: unread ? "live" : notification.type === "submission_feedback" ? "info" : "mute",
      priority: unread ? 98 : 38,
      atMs: notificationCreatedAtMs(notification),
      cta: notification.type === "submission_feedback" ? "Review submission" : "Open role",
      action,
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
      cta: "Open roles",
      action: "roles",
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
  if (job.compSummary) return job.compSummary.length > 18 ? "Success fee" : job.compSummary
  return "$10K+"
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
  const pendingCount = roleSubmissions.filter((submission) => ACTIVE_REVIEW_STATUSES.includes(submission.status ?? "submitted")).length
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
    if (!target || target.insight.primary || target.status === "pending" || target.status === "needs_answer") return
    setApplicationDraftJobId(initialApplicationJobId)
    setApplicationPitch((current) => current.trim() ? current : defaultRoleApplicationPitch(target))
    setAnonymizeCandidates(target.insight.application?.anonymizeCandidates ?? false)
  }, [decisions, initialApplicationJobId])

  const submitApplication = () => {
    if (!selectedApplicationDecision) return
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
          <strong>{summary.pending}/3</strong>
          <p>Role applications waiting on WeKruit review.</p>
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
                decision.status !== "needs_answer" &&
                decision.status !== "pending"
              const canWithdraw = decision.status === "pending"
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
                disabled={applicationPitch.trim().length < 20 || roleApplicationSavingId === roleKey(selectedApplicationDecision.insight.job)}
                onClick={submitApplication}
              >
                {roleApplicationSavingId === roleKey(selectedApplicationDecision.insight.job) ? "Submitting..." : "Submit application"}
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
            {selectedCandidate && (
              <section className="rb-match-profile">
                <div>
                  <span className="rb-candidate-dot">{candidateName(selectedCandidate).slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>{candidateName(selectedCandidate)}</strong>
                    <em>{selectedCandidate.candidate?.currentRole || "Candidate profile"}</em>
                  </span>
                </div>
                <p>{shortText(selectedCandidate.candidate?.notes, "No recruiter note yet. Add context in Candidate CRM to improve ranking.", 160)}</p>
              </section>
            )}
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
  onSaved,
}: {
  jobs: CollabJob[]
  candidates: RecruiterSourcedCandidateItem[]
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

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    try {
      const selectedJobId = form.jobId?.trim()
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

          <section className="rb-bulk-import" aria-label="Bulk import candidates">
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
                  onStageChange={(stage) => void updateStage(candidate, stage)}
                  onOutreachChange={(patch) => void updateOutreach(candidate, patch)}
                  onCalibrationNoteChange={(note) => setCalibrationDrafts((next) => ({ ...next, [candidate.id]: note }))}
                  onCalibrationRequest={() => void requestCalibration(candidate)}
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

function SourcedCandidateCard({
  candidate,
  disabled,
  calibrationNote,
  calibrationDisabled,
  onStageChange,
  onOutreachChange,
  onCalibrationNoteChange,
  onCalibrationRequest,
}: {
  candidate: RecruiterSourcedCandidateItem
  disabled: boolean
  calibrationNote: string
  calibrationDisabled: boolean
  onStageChange: (stage: RecruiterSourcedCandidateStage) => void
  onOutreachChange: (patch: { status?: RecruiterCandidateOutreachStatus; nextFollowUpAt?: string | null }) => void
  onCalibrationNoteChange: (note: string) => void
  onCalibrationRequest: () => void
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
    <article className="rb-source-card">
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
        {candidate.inboundJobId
          ? <Link to={`/recruiters/job/${candidate.inboundJobId}?candidateId=${encodeURIComponent(candidate.id)}`}>Submit</Link>
          : <Link to="/recruiters?tab=matches">Find role</Link>}
      </footer>
    </article>
  )
}

function SubmissionsTab({
  submissions,
  onRefresh,
}: {
  submissions: RecruiterSubmissionItem[]
  onRefresh: () => Promise<void>
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<SubmissionFilter>("all")
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [resendError, setResendError] = useState<string | null>(null)
  const dashboard = useMemo(() => buildSubmissionDashboard(submissions), [submissions])
  const visibleSubmissions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return submissions.filter((submission) => {
      if (!submissionFilterMatches(submission, filter)) return false
      return !needle || submissionSearchText(submission).includes(needle)
    })
  }, [filter, query, submissions])
  const nextActions = dashboard.needsAction.slice(0, 5)
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
        <div><h2>Submission pipeline</h2><p>Track candidate ownership, WeKruit review status, feedback, and next action from one dashboard.</p></div>
      </header>

      <section className="rb-submissions-hero">
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

      <div className="rb-submissions-layout">
        <div className="rb-submission-list rb-submission-list--full">
          {resendError && <p className="rb-state error">Could not resend candidate confirmation: {resendError}</p>}
          {visibleSubmissions.map((s) => (
            <SubmissionRow
              key={s.id}
              submission={s}
              expanded
              onResendConfirmation={() => void handleResendConfirmation(s)}
              resendingConfirmation={resendingId === s.id}
            />
          ))}
          {submissions.length === 0 && <p className="rb-empty">No submissions yet. Open a role and submit a candidate with consent.</p>}
          {submissions.length > 0 && visibleSubmissions.length === 0 && <p className="rb-empty">No submissions match the current filter.</p>}
        </div>

        <aside className="rb-submissions-side">
          <article className={nextActions.length ? "is-warn" : "is-success"}>
            <span>Next action queue</span>
            <strong>{nextActions.length ? `${nextActions.length} item${nextActions.length === 1 ? "" : "s"}` : "Clear"}</strong>
            <p>{nextActions.length ? "Act on feedback or stale reviews before sending lookalike candidates." : "No aged reviews or feedback blockers in the visible tracker."}</p>
          </article>
          <div className="rb-submissions-next-list">
            {nextActions.map((submission) => {
              const action = submissionNextAction(submission.status)
              return (
                <section className={`is-${action.tone}`} key={submission.id}>
                  <span>{statusMeta(submission.status).label}</span>
                  <strong>{submission.candidate?.name || "Candidate"}</strong>
                  <p>{submission.recruiterFeedbackNote || action.body}</p>
                  <em>{submission.jobTitleSnapshot || "Role"} · {submissionAgeDays(submission)}d old</em>
                </section>
              )
            })}
            {nextActions.length === 0 && <p>No immediate submission follow-up.</p>}
          </div>
          <article className="is-info">
            <span>Ownership rule</span>
            <strong>Consent + receipt</strong>
            <p>Every row keeps the submission id, lane, candidate link, status history, and recorded recruiter ownership.</p>
          </article>
        </aside>
      </div>
    </section>
  )
}

function PerformanceTab({
  jobs,
  candidates,
  submissions,
  primaryRoleIds,
  roleFeedback,
  operatingMetrics,
}: {
  jobs: CollabJob[]
  candidates: RecruiterSourcedCandidateItem[]
  submissions: RecruiterSubmissionItem[]
  primaryRoleIds: string[]
  roleFeedback: RecruiterRoleFeedbackItem[]
  operatingMetrics: RecruiterOperatingMetrics
}) {
  const feedbackRows = submissions.filter(submissionHasStructuredFeedback)
  const advanced = submissions.filter((s) => ADVANCED_STATUSES.includes(s.status ?? "")).length
  const pending = submissions.filter((s) => ACTIVE_REVIEW_STATUSES.includes(s.status ?? "submitted")).length
  const ready = candidates.filter((c) => c.stage === "ready").length
  const sourceToSubmit = candidates.length ? Math.round((submissions.length / candidates.length) * 100) : 0
  const singleSubmissions = submissions.filter((submission) => submission.submissionMode === "single_submission").length
  const primarySubmissions = submissions.filter((submission) => submission.submissionMode === "primary_role").length
  const blockedRoles = roleFeedback.filter((feedback) => feedback.difficulty === "blocked").length
  const hardRoles = roleFeedback.filter((feedback) => feedback.difficulty === "hard").length
  const metrics = [
    { label: "Submitted", value: String(submissions.length), meta: "formal candidates", tone: "live" },
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

function EarningsTab({
  metrics,
  onRoles,
  onCandidates,
  onSubmissions,
  onPerformance,
}: {
  metrics: RecruiterEarningsMetrics
  onRoles: () => void
  onCandidates: () => void
  onSubmissions: () => void
  onPerformance: () => void
}) {
  const runAction = (action: RecruiterChallenge["action"]) => {
    if (action === "roles") onRoles()
    else if (action === "candidates") onCandidates()
    else if (action === "submissions") onSubmissions()
    else onPerformance()
  }
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
            <p>Focused work that moves status, quality, and payout odds.</p>
          </header>
          <div className="rb-challenge-grid">
            {metrics.challenges.map((challenge) => {
              const pct = challenge.target > 0 ? Math.min(100, Math.round((challenge.progress / challenge.target) * 100)) : 0
              return (
                <article className={`is-${challenge.tone}`} key={challenge.title}>
                  <span>{challenge.reward}</span>
                  <strong>{challenge.title}</strong>
                  <p>{challenge.body}</p>
                  <div className="rb-challenge-progress" aria-label={`${challenge.title} progress`}>
                    <i style={{ width: `${pct}%` }} />
                  </div>
                  <footer>
                    <em>{challenge.progressLabel}</em>
                    <button type="button" onClick={() => runAction(challenge.action)}>{challenge.actionLabel}</button>
                  </footer>
                </article>
              )
            })}
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

function SettingsTab({
  session,
  approvedRoleCount,
  onSessionChange,
}: {
  session: RecruiterSession
  approvedRoleCount: number
  onSessionChange: (session: RecruiterSession) => void
}) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const newRolesEmail = session.recruiter.notificationPreferences?.newRolesEmail !== false
  const setNewRolesEmail = async (next: boolean) => {
    setSaving(true)
    setErr(null)
    try {
      const updated = await updateRecruiterPreferences({
        notificationPreferences: { newRolesEmail: next },
        workspacePreferences: session.recruiter.workspacePreferences ?? { primaryRoleIds: [] },
      })
      onSessionChange(updated)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <section className="rb-panel rb-panel--settings">
      <header className="rb-panel__head">
        <div><h2>Recruiter account</h2><p>Invite-gated access for partner recruiters.</p></div>
      </header>
      <dl className="rb-settings">
        <div><dt>Name</dt><dd>{session.recruiter.name}</dd></div>
        <div><dt>Email</dt><dd>{session.recruiter.email}</dd></div>
        <div><dt>Access model</dt><dd>Firebase Auth + recruiter access code</dd></div>
        <div><dt>Approved roles</dt><dd>{approvedRoleCount}/{APPROVED_ROLE_LIMIT} access limit</dd></div>
      </dl>
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
        WeKruit issues recruiter access codes manually. If the code is revoked or expires, this workspace stops loading status data.
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
        <span>{insight.urgency} · {insight.marketLoad}</span>
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
  const currentStatus = submission.status === "new" ? "submitted" : submission.status ?? "submitted"
  const timelineStatus = currentStatus === "backburner" ? "reviewing" : currentStatus
  const currentIndex = SUBMISSION_PROGRESS.findIndex((step) => step.id === timelineStatus)
  const isClosed = currentStatus === "rejected" || currentStatus === "duplicate"
  const nextAction = submissionNextAction(submission.status)
  const activity = submissionActivityEvents(submission)
  const feedbackReasons = submissionFeedbackReasonLabels(submission)
  const feedbackRating = submissionFeedbackRating(submission)
  return (
    <article className={`rb-submission ${expanded ? "is-expanded" : ""}`}>
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
      </div>
      {expanded && (
        <div className="rb-submission__detail">
          <div className={`rb-submission-timeline ${isClosed ? "is-closed" : ""}`} aria-label="Submission status timeline">
            {SUBMISSION_PROGRESS.map((step, index) => (
              <span key={step.id} className={currentIndex >= index ? "is-complete" : ""}>
                {step.label}
              </span>
            ))}
            {isClosed && <span className="is-complete">{meta.label}</span>}
          </div>
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
