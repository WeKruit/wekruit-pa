/**
 * Recruiter board single-role view — /recruiters/job/:jobId
 *
 * JD primary, checklist + submission form secondary. POSTs to
 * paRecruiterSubmission CF on submit; checklist + form state persisted in
 * localStorage so a recruiter can come back later.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { onAuthStateChanged } from "firebase/auth"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import "../styles/recruiter-board.css"
import {
  checkRecruiterCandidateIdentity,
  createRecruiterRoleQuestion,
  fetchCollabJobs,
  fetchRecruiterRoleApplications,
  fetchRecruiterRoleFeedback,
  fetchRecruiterRoleIntelligence,
  fetchRecruiterRoleQuestions,
  fetchRecruiterSourcedCandidates,
  fetchRecruiterSubmissions,
  getRecruiterProfile,
  resendRecruiterCandidateConfirmation,
  saveRecruiterRoleApplication,
  saveRecruiterRoleFeedback,
  submitRecruiterCandidate,
  type CollabJob,
  type RecruiterRoleApplicationInput,
  type RecruiterRoleApplicationItem,
  type RecruiterRoleApplicationStatus,
  type RecruiterRoleFeedbackDifficulty,
  type RecruiterRoleFeedbackItem,
  type RecruiterRoleFeedbackReason,
  type RecruiterRoleIntelligenceItem,
  type RecruiterRoleQuestionItem,
  type RecruiterSession,
  type RecruiterSourcedCandidateItem,
  type RecruiterSubmissionItem,
  type RecruiterCandidateIdentityCheckResult,
  type SubmissionResponse,
} from "../lib/recruiter-board-api.js"
import { auth } from "../lib/firebase.js"

const STORAGE_KEY_PREFIX = "rb-state-v1:"
const ROLE_PENDING_SUBMISSION_LIMIT = 5

const ROLE_FEEDBACK_DIFFICULTIES: Array<{ id: RecruiterRoleFeedbackDifficulty; label: string; detail: string }> = [
  { id: "easy", label: "Easy", detail: "Candidate supply is strong" },
  { id: "medium", label: "Medium", detail: "Workable with normal sourcing" },
  { id: "hard", label: "Hard", detail: "Needs tighter calibration" },
  { id: "blocked", label: "Blocked", detail: "Cannot make progress without changes" },
]

const ROLE_FEEDBACK_REASONS: Array<{ id: RecruiterRoleFeedbackReason; label: string }> = [
  { id: "low_comp", label: "Comp too low" },
  { id: "location_mismatch", label: "Location blocks supply" },
  { id: "unclear_requirements", label: "Requirements unclear" },
  { id: "small_candidate_pool", label: "Small candidate pool" },
  { id: "hiring_team_slow", label: "Feedback too slow" },
  { id: "role_too_broad", label: "Role too broad" },
  { id: "candidate_interest_low", label: "Low candidate interest" },
  { id: "too_many_recruiters", label: "Too many recruiters" },
  { id: "other", label: "Other" },
]

const ROLE_PENDING_SUBMISSION_STATUSES = ["submitted", "new", "reviewing", "backburner"]
const ROLE_ADVANCED_SUBMISSION_STATUSES = ["advanced", "interviewing", "offer", "hired"]
const ROLE_NEGATIVE_SUBMISSION_STATUSES = ["rejected", "duplicate"]

interface FormState {
  submitterName: string
  submitterEmail: string
  candidateName: string
  candidateEmail: string
  candidateLink: string
  candidateCurrentRole: string
  candidateYoe: string
  candidateNotes: string
  candidateConsent: boolean
  checklist: Record<string, boolean>
}

function emptyForm(): FormState {
  return {
    submitterName: "",
    submitterEmail: "",
    candidateName: "",
    candidateEmail: "",
    candidateLink: "",
    candidateCurrentRole: "",
    candidateYoe: "",
    candidateNotes: "",
    candidateConsent: false,
    checklist: {},
  }
}

function loadFormState(jobId: string): FormState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + jobId)
    if (raw) return { ...emptyForm(), ...JSON.parse(raw) }
  } catch (e) {
    // ignore
  }
  return emptyForm()
}

function saveFormState(jobId: string, state: FormState): void {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + jobId, JSON.stringify(state))
  } catch (e) {
    // ignore
  }
}

function withRecruiterDefaults(state: FormState, session: RecruiterSession | null): FormState {
  if (!session) return state
  return {
    ...state,
    submitterName: state.submitterName || session.recruiter.name,
    submitterEmail: state.submitterEmail || session.recruiter.email,
  }
}

function timestampMs(raw: unknown): number {
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "object" && typeof (raw as { seconds?: unknown }).seconds === "number") {
    return (raw as { seconds: number }).seconds * 1000
  }
  return 0
}

function shortText(text: string | undefined | null, fallback = "—", max = 64): string {
  if (!text) return fallback
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function submissionTimeMs(raw: unknown): number {
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "object" && typeof (raw as { seconds?: unknown }).seconds === "number") {
    return (raw as { seconds: number }).seconds * 1000
  }
  return 0
}

function roleMatches(job: CollabJob, row: { jobId?: string; inboundJobId?: string }): boolean {
  return row.inboundJobId === job.jobId || row.jobId === job.jobId
}

function latestRoleApplication(job: CollabJob, applications: RecruiterRoleApplicationItem[]): RecruiterRoleApplicationItem | null {
  return applications
    .filter((application) => roleMatches(job, application))
    .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))[0] ?? null
}

function roleApplicationStatusLabel(status?: RecruiterRoleApplicationStatus): string {
  switch (status) {
    case "approved": return "Approved access"
    case "pending": return "Pending approval"
    case "not_approved": return "Not approved"
    case "withdrawn": return "Withdrawn"
    case "rescinded": return "Rescinded"
    default: return "Not applied"
  }
}

function roleApplicationStatusTone(status?: RecruiterRoleApplicationStatus): "success" | "info" | "warn" | "mute" {
  switch (status) {
    case "approved": return "success"
    case "pending": return "info"
    case "not_approved":
    case "rescinded": return "warn"
    case "withdrawn":
    default:
      return "mute"
  }
}

function roleSubmissionStatusLabel(status?: string): string {
  switch (status) {
    case "reviewing": return "WeKruit review"
    case "advanced": return "Sent to team"
    case "interviewing": return "Interviewing"
    case "backburner": return "Backburner"
    case "offer": return "Offer"
    case "hired": return "Hired"
    case "rejected": return "Rejected"
    case "duplicate": return "Duplicate"
    case "submitted":
    case "new":
    default:
      return "Submitted"
  }
}

function roleSubmissionNextAction(status?: string): string {
  switch (status) {
    case "reviewing": return "Wait for WeKruit calibration before sending lookalikes."
    case "advanced": return "Keep the candidate warm for hiring-team review."
    case "interviewing": return "Watch for scheduling and close-process updates."
    case "backburner": return "Candidate is parked, not rejected. Wait for a clearer next step before sending lookalikes."
    case "offer": return "Offer is in motion. Keep the candidate warm while WeKruit confirms closing details."
    case "hired": return "Placement reached hired status."
    case "rejected": return "Read feedback before sourcing another candidate."
    case "duplicate": return "Candidate already exists for this search."
    default: return "Queued for WeKruit triage."
  }
}

function roleSubmissionLastActivity(row: RecruiterSubmissionItem): string {
  const ms = submissionTimeMs(row.recruiterFeedbackUpdatedAt ?? row.updatedAt ?? row.createdAt)
  return ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Today"
}

function roleSubmissionConsentLabel(row: RecruiterSubmissionItem): string {
  switch (row.candidateConsentStatus) {
    case "candidate_confirmed": return "Candidate confirmed"
    case "pending_candidate_confirmation": return "Confirmation pending"
    case "confirmation_email_failed": return "Confirmation email failed"
    case "confirmation_email_not_configured": return "Confirmation email not configured"
    default: return "Recruiter consent recorded"
  }
}

function roleSubmissionReceiptId(row: RecruiterSubmissionItem): string {
  return row.submissionId || row.id
}

function roleCandidateConfirmationCanResend(row: RecruiterSubmissionItem): boolean {
  return [
    "pending_candidate_confirmation",
    "confirmation_email_failed",
    "confirmation_email_not_configured",
  ].includes(row.candidateConsentStatus ?? "")
}

function roleCandidateConfirmationBody(row: RecruiterSubmissionItem): string {
  const email = row.candidateConfirmation?.candidateEmail || row.candidate?.email || "the candidate"
  if (row.candidateConsentStatus === "confirmation_email_failed") {
    return `Confirmation email to ${email} failed. Resend before assuming the candidate approved this packet.`
  }
  if (row.candidateConsentStatus === "confirmation_email_not_configured") {
    return "Candidate confirmation email is not configured in the current environment."
  }
  const count = row.candidateConfirmation?.resendCount ?? 0
  return count > 0
    ? `Confirmation is still pending for ${email}. Last resend: ${roleQuestionTime(row.candidateConfirmation?.lastResentAt ?? row.candidateConfirmation?.sentAt)}.`
    : `Confirmation is pending for ${email}. Resend if the candidate did not receive the email.`
}

function sourcedStageLabel(stage?: string): string {
  switch (stage) {
    case "contacted": return "Contacted"
    case "screened": return "Screened"
    case "ready": return "Ready"
    case "submitted": return "Submitted"
    case "archived": return "Archived"
    default: return "Sourced"
  }
}

function sourcedCalibrationLabel(status?: string): string {
  switch (status) {
    case "calibration_requested": return "Needs adjustment"
    case "good_fit": return "Good fit"
    case "bad_fit": return "Not a fit"
    case "suggested": return "Suggested direction"
    default: return "Not rated"
  }
}

function formatSubmissionFailure(reason?: string): string {
  if (reason === "single_submission_limit_reached") {
    return "This role is outside your approved role access and your weekly single-submission limit is used. Apply for role access from the recruiter dashboard or wait for the rolling window to reset."
  }
  if (reason === "candidate_already_submitted_for_role") {
    return "This candidate is already submitted for this role. Do not submit the same email or LinkedIn again; track the existing pipeline instead."
  }
  if (reason === "candidate_already_sourced_for_role") {
    return "Another recruiter already has this candidate in motion for this role. Choose a different candidate or ask WeKruit for calibration before proceeding."
  }
  if (reason === "missing_candidate_email") return "Add the candidate email so WeKruit can confirm consent."
  if (reason === "invalid_candidate_email") return "Enter a valid candidate email."
  if (reason === "candidate_consent_required") return "Confirm candidate consent before submitting."
  return reason ?? "submission_failed"
}

type RoleChecklistKind = CollabJob["recruiterBoard"]["checklist"]["groups"][number]["kind"]

type RoleSubmissionPacketGate = {
  label: string
  value: string
  detail: string
  tone: "ready" | "watch" | "blocked"
}

type RoleSubmissionPacket = {
  score: number
  label: string
  tone: "ready" | "watch" | "blocked"
  summary: string
  blockers: string[]
  warnings: string[]
  proof: string[]
  nextAction: string
  missingHard: string[]
  antiFlags: string[]
  gates: RoleSubmissionPacketGate[]
  canSubmit: boolean
  submitLabel: string
}

type CandidateIdentityCheckStatus = "missing" | "checking" | "clear" | "conflict" | "error"

type CandidateIdentityCheckState = {
  status: CandidateIdentityCheckStatus
  result: RecruiterCandidateIdentityCheckResult | null
  error: string | null
  inputKey: string | null
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

type RoleCalibrationBrief = {
  tone: "good" | "watch" | "blocked" | "quiet"
  headline: string
  body: string
  nextMove: string
  marketFacts: Array<{ label: string; value: string; detail: string }>
  pipeline: Array<{ label: string; count: number; total: number; tone: "good" | "watch" | "blocked" | "quiet" }>
  rejectionReasons: Array<{ label: string; count: number; detail: string }>
  guardrails: {
    prove: string[]
    avoid: string[]
    calibrate: string[]
  }
}

type RoleSourcingKit = {
  searchStrings: Array<{ label: string; value: string; detail: string }>
  targetSignals: string[]
  outreach: {
    subject: string
    body: string
  }
  screenQuestions: string[]
  proofPlan: string[]
  doNotPitch: string[]
}

type RoleWorkroomAction = "submit" | "candidate" | "candidates" | "questions" | "feedback" | "access"

type RoleCandidateRecommendation = {
  candidate: RecruiterSourcedCandidateItem
  score: number
  tone: "good" | "watch" | "blocked" | "quiet"
  label: string
  source: "role" | "bench"
  reasons: string[]
}

type RoleWorkroomModel = {
  tone: "good" | "watch" | "blocked" | "quiet"
  label: string
  title: string
  body: string
  action: RoleWorkroomAction
  actionLabel: string
  actionCandidate?: RecruiterSourcedCandidateItem
  cards: Array<{
    label: string
    value: string
    body: string
    tone: "good" | "watch" | "blocked" | "quiet"
    action: RoleWorkroomAction
  }>
}

type RoleDealDeskModel = {
  tone: "good" | "watch" | "blocked" | "quiet"
  mode: string
  title: string
  body: string
  primaryAction: RoleWorkroomAction
  primaryLabel: string
  primaryCandidate?: RecruiterSourcedCandidateItem
  lanes: Array<{
    label: string
    value: string
    detail: string
    tone: "good" | "watch" | "blocked" | "quiet"
    action: RoleWorkroomAction
    actionCandidate?: RecruiterSourcedCandidateItem
  }>
  proofPlan: Array<{
    label: string
    detail: string
    tone: "good" | "watch" | "blocked" | "quiet"
  }>
  risks: Array<{
    label: string
    detail: string
    tone: "good" | "watch" | "blocked" | "quiet"
    action: RoleWorkroomAction
  }>
}

type RoleIntakeMemo = {
  tone: "good" | "watch" | "blocked" | "quiet"
  label: string
  title: string
  body: string
  action: RoleWorkroomAction
  actionLabel: string
  facts: Array<{
    label: string
    value: string
    detail: string
    tone: "good" | "watch" | "blocked" | "quiet"
    action: RoleWorkroomAction
  }>
  talkTrack: string[]
  assumptions: Array<{
    label: string
    detail: string
    tone: "good" | "watch" | "blocked" | "quiet"
    action: RoleWorkroomAction
  }>
}

type RoleRewardCenter = {
  tone: "good" | "watch" | "blocked" | "quiet"
  title: string
  body: string
  primaryAction: RoleWorkroomAction
  primaryLabel: string
  cards: Array<{
    label: string
    value: string
    detail: string
    tone: "good" | "watch" | "blocked" | "quiet"
    action: RoleWorkroomAction
  }>
  steps: Array<{
    label: string
    detail: string
    tone: "good" | "watch" | "blocked" | "quiet"
    action: RoleWorkroomAction
  }>
}

type RoleQuestionPrompt = {
  id: string
  label: string
  question: string
  body: string
  tone: "good" | "watch" | "blocked" | "quiet"
}

function roleChecklistItems(job: CollabJob, kind: RoleChecklistKind) {
  return job.recruiterBoard.checklist.groups.find((group) => group.kind === kind)?.items ?? []
}

const SOURCING_STOP_WORDS = new Set([
  "and", "the", "for", "with", "from", "that", "this", "have", "has", "are", "you", "your",
  "will", "must", "able", "role", "team", "work", "years", "experience", "candidate", "candidates",
])

function sourcingTokens(text: string, max = 8): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !SOURCING_STOP_WORDS.has(token))
  return [...new Set(tokens)].slice(0, max)
}

function titleVariants(title: string): string[] {
  const base = title.replace(/\s+/g, " ").trim()
  const withoutSeniority = base.replace(/^(senior|sr\.?|staff|principal|lead|founding)\s+/i, "").trim()
  return [...new Set([base, withoutSeniority].filter(Boolean))].slice(0, 3)
}

function quotedOrGroup(values: string[]): string {
  const cleanValues = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
  return cleanValues.length ? `(${cleanValues.map((value) => `"${value}"`).join(" OR ")})` : ""
}

function buildRoleSourcingKit(job: CollabJob, brief: RoleCalibrationBrief): RoleSourcingKit {
  const hardItems = roleChecklistItems(job, "hard").map((item) => item.text)
  const fitItems = roleChecklistItems(job, "fit").map((item) => item.text)
  const bonusItems = roleChecklistItems(job, "bonus").map((item) => item.text)
  const antiItems = roleChecklistItems(job, "anti").map((item) => item.text)
  const jdText = `${job.title} ${job.jdBlocks.map((block) => `${block.heading} ${block.body}`).join(" ")} ${hardItems.join(" ")} ${fitItems.join(" ")}`
  const skillTokens = sourcingTokens(jdText, 10)
  const coreSignals = [...hardItems, ...fitItems, ...bonusItems]
    .map((item) => shortText(item, item, 88))
    .slice(0, 8)
  const titleGroup = quotedOrGroup(titleVariants(job.title))
  const skillGroup = quotedOrGroup(skillTokens.slice(0, 5))
  const locationGroup = quotedOrGroup([job.recruiterBoard.label.location, ...job.recruiterBoard.label.pills.map((pill) => pill.text).filter((text) => /remote|hybrid|onsite|us|canada|uk|europe/i.test(text))].slice(0, 4))
  const company = job.recruiterBoard.label.company
  const searchStrings = [
    {
      label: "LinkedIn recruiter",
      value: [titleGroup, skillGroup, locationGroup, "-intern", "-student"].filter(Boolean).join(" "),
      detail: "Start broad, then add company-stage or domain filters once the first 30 profiles look noisy.",
    },
    {
      label: "Google X-ray",
      value: `site:linkedin.com/in ${titleGroup} ${skillTokens.slice(0, 4).map((token) => `"${token}"`).join(" ")} ${job.recruiterBoard.label.location}`,
      detail: "Use when LinkedIn search is saturated or you need fresh public profiles.",
    },
    {
      label: "Warm referral prompt",
      value: `Who do you know who has done ${skillTokens.slice(0, 3).join(", ")} for a ${job.title} search?`,
      detail: "Send to trusted operators before cold outreach.",
    },
  ]
  const firstSignal = coreSignals[0] ?? job.title
  const secondSignal = coreSignals[1] ?? job.recruiterBoard.culture.bet
  const outreachBody = [
    `Hi {{first_name}}, I am working with WeKruit on a ${job.title} search for ${company}.`,
    `Your background around ${firstSignal.toLowerCase()} stood out, especially for a team where ${shortText(job.recruiterBoard.culture.bet, "the role has clear ownership", 110).toLowerCase()}.`,
    `If ${job.recruiterBoard.label.location} and ${job.compSummary || "a success-fee-backed search"} are in range, are you open to a quick screen this week?`,
  ].join("\n\n")
  const screenQuestions = [
    ...hardItems.slice(0, 4).map((item) => `Can you walk through a concrete example of ${item.toLowerCase()}?`),
    `What would make ${job.recruiterBoard.label.location} workable or not workable for you?`,
    `What compensation range would make this worth a serious conversation?`,
  ].slice(0, 6)
  const proofPlan = [
    "Confirm candidate consent before submitting.",
    "Save LinkedIn or resume link in Candidate CRM before formal submission.",
    `Capture proof for: ${firstSignal}.`,
    `Capture proof for: ${secondSignal}.`,
    brief.nextMove,
  ].filter(Boolean).slice(0, 6)
  const doNotPitch = antiItems.length
    ? antiItems.map((item) => shortText(item, item, 90)).slice(0, 6)
    : [
      "Do not submit candidates without explicit consent.",
      "Do not submit weak matches just to claim role activity.",
      "Do not ignore open WeKruit calibration questions.",
    ]
  return {
    searchStrings,
    targetSignals: coreSignals.length ? coreSignals : [`Relevant ${job.title} ownership`, job.recruiterBoard.culture.bet],
    outreach: {
      subject: `${job.title} at ${company}`,
      body: outreachBody,
    },
    screenQuestions,
    proofPlan,
    doNotPitch,
  }
}

function normalizeQuestionText(text?: string | null): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function promptWasAsked(prompt: string, questions: RecruiterRoleQuestionItem[]): boolean {
  const normalized = normalizeQuestionText(prompt)
  if (!normalized) return false
  return questions.some((question) => {
    const asked = normalizeQuestionText(question.question)
    if (!asked) return false
    return asked === normalized || asked.includes(normalized.slice(0, 48)) || normalized.includes(asked.slice(0, 48))
  })
}

function buildRoleQuestionPrompts(
  job: CollabJob,
  questions: RecruiterRoleQuestionItem[],
  feedback: RecruiterRoleFeedbackItem | null,
  intelligence: RecruiterRoleIntelligenceItem | null,
): RoleQuestionPrompt[] {
  const prompts: RoleQuestionPrompt[] = []
  const add = (prompt: RoleQuestionPrompt) => {
    if (prompts.some((item) => item.id === prompt.id) || promptWasAsked(prompt.question, questions)) return
    prompts.push(prompt)
  }
  const hardItems = roleChecklistItems(job, "hard").map((item) => item.text)
  const antiItems = roleChecklistItems(job, "anti").map((item) => item.text)
  const reasons = new Set(feedback?.reasons ?? [])
  const company = job.recruiterBoard.label.company
  const location = job.recruiterBoard.label.location

  if (!job.compSummary || reasons.has("low_comp")) {
    add({
      id: "comp",
      label: "Comp calibration",
      question: `What compensation range or flexibility should I use when candidates push back on ${job.title} at ${company}?`,
      body: "Use this before low-comp objections keep repeating.",
      tone: reasons.has("low_comp") ? "blocked" : "watch",
    })
  }
  if (reasons.has("location_mismatch") || /remote|hybrid|onsite/i.test(location)) {
    add({
      id: "location",
      label: "Location boundary",
      question: `For ${job.title}, are there location, timezone, or visa exceptions beyond ${location}?`,
      body: "Clarifies whether adjacent candidates are worth screening.",
      tone: reasons.has("location_mismatch") ? "blocked" : "watch",
    })
  }
  if (reasons.has("unclear_requirements") || reasons.has("role_too_broad")) {
    add({
      id: "must-have",
      label: "Must-have cutline",
      question: `Which 2-3 requirements are true must-haves for ${job.title}, and which can be traded off for stronger overall talent?`,
      body: "Turns vague role pressure into a usable sourcing rule.",
      tone: "blocked",
    })
  }
  if (reasons.has("small_candidate_pool") || (intelligence?.readyCount ?? 0) === 0) {
    add({
      id: "adjacent-backgrounds",
      label: "Adjacent backgrounds",
      question: `Which adjacent company types, titles, or backgrounds would still count as credible for ${job.title}?`,
      body: "Helps widen search without lowering the bar.",
      tone: reasons.has("small_candidate_pool") ? "watch" : "quiet",
    })
  }
  if (reasons.has("candidate_interest_low")) {
    add({
      id: "candidate-hook",
      label: "Candidate hook",
      question: `What is the strongest candidate-facing hook for ${job.title} when people are not responding?`,
      body: "Improves outreach before more sourcing volume.",
      tone: "watch",
    })
  }
  if (reasons.has("hiring_team_slow")) {
    add({
      id: "feedback-sla",
      label: "Feedback SLA",
      question: `What review timeline should I promise candidates for ${job.title}, and when should I stop sending lookalikes?`,
      body: "Prevents candidate warmth from decaying in slow review loops.",
      tone: "watch",
    })
  }
  if (reasons.has("too_many_recruiters")) {
    add({
      id: "undercovered-lane",
      label: "Under-covered lane",
      question: `Which candidate lane is still under-covered for ${job.title} so I do not duplicate other recruiters?`,
      body: "Focuses effort when the market is crowded.",
      tone: "watch",
    })
  }
  if (hardItems[0]) {
    add({
      id: "hard-proof",
      label: "Proof standard",
      question: `What evidence is strong enough to prove "${hardItems[0]}" before I submit a candidate?`,
      body: "Sets the bar for the most important hard check.",
      tone: "quiet",
    })
  }
  if (antiItems[0]) {
    add({
      id: "anti-signal",
      label: "Anti-signal",
      question: `If a candidate partly matches "${antiItems[0]}", what context would still make them worth reviewing?`,
      body: "Prevents borderline candidates from becoming noisy submissions.",
      tone: "quiet",
    })
  }
  return prompts.slice(0, 5)
}

function buildRoleSubmissionPacket(input: {
  job: CollabJob
  form: FormState
  pendingSlots: number
  selectedCandidate: RecruiterSourcedCandidateItem | null
  roleCandidates: RecruiterSourcedCandidateItem[]
  roleSubmissions: RecruiterSubmissionItem[]
  roleFeedback: RecruiterRoleFeedbackItem | null
  roleQuestions: RecruiterRoleQuestionItem[]
  intelligence: RecruiterRoleIntelligenceItem | null
  identityCheck: CandidateIdentityCheckState
  approvedForRole: boolean
  application: RecruiterRoleApplicationItem | null
}): RoleSubmissionPacket {
  const { job, form, pendingSlots, selectedCandidate, roleCandidates, roleSubmissions, roleFeedback, roleQuestions, intelligence, identityCheck, approvedForRole, application } = input
  const hardItems = roleChecklistItems(job, "hard")
  const fitItems = roleChecklistItems(job, "fit")
  const bonusItems = roleChecklistItems(job, "bonus")
  const antiItems = roleChecklistItems(job, "anti")
  const checked = (kind: RoleChecklistKind) => roleChecklistItems(job, kind).filter((item) => form.checklist[item.id]).length
  const hardChecked = checked("hard")
  const fitChecked = checked("fit")
  const bonusChecked = checked("bonus")
  const antiChecked = checked("anti")
  const missingHard = hardItems.filter((item) => !form.checklist[item.id]).map((item) => item.text)
  const antiFlags = antiItems.filter((item) => form.checklist[item.id]).map((item) => item.text)
  const blockers: string[] = []
  const warnings: string[] = []
  const proof: string[] = []
  const gates: RoleSubmissionPacketGate[] = []
  const submitterName = form.submitterName.trim()
  const submitterEmail = form.submitterEmail.trim()
  const candidateName = form.candidateName.trim()
  const candidateEmail = form.candidateEmail.trim().toLowerCase()
  const candidateLink = form.candidateLink.trim()
  const candidateNotes = form.candidateNotes.trim()
  const candidateEmailValid = candidateEmail ? isValidEmail(candidateEmail) : false
  const submitterEmailValid = submitterEmail ? isValidEmail(submitterEmail) : false
  const identityInputKey = `${job.jobId}|${candidateEmail}|${candidateLink}`
  const identityMatchesPacket = identityCheck.inputKey === identityInputKey
  if (!submitterName) blockers.push("Recruiter name is missing.")
  if (!submitterEmail) blockers.push("Recruiter email is missing.")
  else if (!submitterEmailValid) blockers.push("Recruiter email is invalid.")
  if (!candidateName) blockers.push("Candidate name is missing.")
  if (!candidateEmail) blockers.push("Candidate email is missing.")
  else if (!candidateEmailValid) blockers.push("Candidate email is invalid.")
  if (!candidateLink) blockers.push("LinkedIn or resume link is missing.")
  if (!form.candidateConsent) blockers.push("Candidate consent is not confirmed.")
  if (pendingSlots <= 0) blockers.push("This role has no pending submission slots left.")
  if (hardItems.length > 0 && hardChecked < hardItems.length) blockers.push(`${hardItems.length - hardChecked} hard check${hardItems.length - hardChecked === 1 ? "" : "s"} still need proof.`)
  if (antiFlags.length > 0) blockers.push(`${antiFlags.length} anti-signal${antiFlags.length === 1 ? "" : "s"} marked. Clear the candidate or remove the packet before submitting.`)
  if (!candidateNotes) blockers.push("Add a fit note explaining why this candidate should enter WeKruit review.")
  if (application?.status === "not_approved" || application?.status === "rescinded") {
    blockers.push("Role access was not approved. Reapply with stronger candidate proof before submitting this role.")
  }
  if (fitItems.length > 0 && fitChecked === 0) warnings.push("No fit checks are verified yet.")
  if (roleFeedback?.difficulty === "blocked") warnings.push("You marked this role blocked. Ask WeKruit for calibration before adding volume.")
  if (roleQuestions.some((question) => (question.status ?? "open") === "open")) warnings.push("There is an open role question waiting on WeKruit.")

  const roleLaneValue = approvedForRole
    ? "Approved role"
    : application?.status === "pending"
      ? "Access pending"
      : "Single-submit"
  const roleLaneDetail = approvedForRole
    ? "This recruiter account has trusted access for the role."
    : application?.status === "pending"
      ? "Role access is under review; this packet is still treated as single-submit until approved."
      : application?.status === "not_approved" || application?.status === "rescinded"
        ? "Role access must be repaired before a packet can be sent."
        : "Allowed only for one exceptional candidate with a complete packet."
  gates.push({
    label: "Role lane",
    value: roleLaneValue,
    detail: roleLaneDetail,
    tone: approvedForRole ? "ready" : application?.status === "not_approved" || application?.status === "rescinded" ? "blocked" : "watch",
  })

  let identityGate: RoleSubmissionPacketGate
  if (!candidateEmail || !candidateLink || !candidateEmailValid) {
    identityGate = {
      label: "Candidate identity",
      value: !candidateEmail || !candidateLink ? "Incomplete" : "Invalid email",
      detail: !candidateEmail || !candidateLink
        ? "Candidate email and LinkedIn or resume link are required before ownership can be checked."
        : "Fix the candidate email before running the ownership check.",
      tone: "blocked",
    }
  } else if (identityCheck.status === "clear" && identityMatchesPacket) {
    identityGate = {
      label: "Candidate identity",
      value: "Clear",
      detail: "Email and profile link passed the role ownership preflight.",
      tone: "ready",
    }
  } else if (identityCheck.status === "conflict" && identityMatchesPacket) {
    const reason = identityCheck.result?.conflict?.reason
    blockers.push(formatSubmissionFailure(reason))
    identityGate = {
      label: "Candidate identity",
      value: "Conflict",
      detail: formatSubmissionFailure(reason),
      tone: "blocked",
    }
  } else if (identityCheck.status === "checking" && identityMatchesPacket) {
    blockers.push("Candidate ownership check is still running.")
    identityGate = {
      label: "Candidate identity",
      value: "Checking",
      detail: "Wait for the duplicate ownership preflight to finish.",
      tone: "blocked",
    }
  } else if (identityCheck.status === "error" && identityMatchesPacket) {
    blockers.push(`Candidate ownership preflight failed: ${identityCheck.error || "check unavailable"}`)
    identityGate = {
      label: "Candidate identity",
      value: "Check failed",
      detail: identityCheck.error || "Run the ownership preflight again before submitting.",
      tone: "blocked",
    }
  } else {
    blockers.push("Candidate ownership check has not cleared.")
    identityGate = {
      label: "Candidate identity",
      value: "Not cleared",
      detail: "Complete candidate identity and wait for a clear ownership preflight.",
      tone: "blocked",
    }
  }
  gates.push(identityGate)

  gates.push({
    label: "Candidate consent",
    value: form.candidateConsent ? "Confirmed" : "Missing",
    detail: form.candidateConsent
      ? "Recruiter confirmed role-specific candidate consent; WeKruit still sends confirmation."
      : "Explicit candidate permission is required before every submission.",
    tone: form.candidateConsent ? "ready" : "blocked",
  })
  gates.push({
    label: "Hard proof",
    value: hardItems.length ? `${hardChecked}/${hardItems.length}` : "No hard list",
    detail: missingHard.length
      ? "Every hard requirement must be verified before this packet can enter review."
      : "All hard requirements are marked as verified.",
    tone: missingHard.length ? "blocked" : "ready",
  })
  gates.push({
    label: "Fit note",
    value: candidateNotes ? "Included" : "Missing",
    detail: candidateNotes
      ? "Submission includes recruiter-written role-fit context."
      : "Add the screening evidence, motivation, compensation, or risk context WeKruit should review.",
    tone: candidateNotes ? "ready" : "blocked",
  })
  gates.push({
    label: "Review capacity",
    value: `${pendingSlots}/${ROLE_PENDING_SUBMISSION_LIMIT}`,
    detail: pendingSlots > 0
      ? "There is capacity for another open submission in this role lane."
      : "Wait for WeKruit feedback before adding another pending packet.",
    tone: pendingSlots > 0 ? "ready" : "blocked",
  })
  gates.push({
    label: "Anti-signal",
    value: antiFlags.length ? `${antiFlags.length} flagged` : "Clean",
    detail: antiFlags.length
      ? "A candidate with anti-signal flags should not be submitted as a clean packet."
      : "No anti-signal checks are marked.",
    tone: antiFlags.length ? "blocked" : "ready",
  })

  if (selectedCandidate) proof.push("Pulled from saved candidate queue")
  if (form.candidateCurrentRole.trim()) proof.push(form.candidateCurrentRole.trim())
  if (form.candidateYoe.trim()) proof.push(`${form.candidateYoe.trim()} experience`)
  if (hardChecked === hardItems.length && hardItems.length > 0) proof.push("All hard checks verified")
  if (fitChecked > 0) proof.push(`${fitChecked}/${fitItems.length} fit checks`)
  if (bonusChecked > 0) proof.push(`${bonusChecked}/${bonusItems.length} bonus signals`)
  if ((intelligence?.readyCount ?? 0) > 0) proof.push(`${intelligence?.readyCount} ready candidate${intelligence?.readyCount === 1 ? "" : "s"} across board`)
  if (roleCandidates.length > 0) proof.push(`${roleCandidates.length} sourced in your CRM`)
  if (roleSubmissions.length > 0) proof.push(`${roleSubmissions.length} prior submission${roleSubmissions.length === 1 ? "" : "s"}`)

  const basicsScore = (form.candidateName.trim() ? 8 : 0) + (form.candidateEmail.trim() ? 10 : 0) + (form.candidateLink.trim() ? 8 : 0) + (form.candidateConsent ? 12 : 0)
  const hardScore = hardItems.length ? Math.round((hardChecked / hardItems.length) * 34) : 22
  const fitScore = fitItems.length ? Math.round((fitChecked / fitItems.length) * 18) : 10
  const bonusScore = bonusItems.length ? Math.min(10, Math.round((bonusChecked / bonusItems.length) * 10)) : 4
  const notesScore = form.candidateNotes.trim() ? 8 : 0
  const queueScore = selectedCandidate ? 5 : roleCandidates.length ? 3 : 0
  const penalty = antiChecked * 12 + (pendingSlots <= 0 ? 30 : 0) + (roleFeedback?.difficulty === "blocked" ? 10 : 0)
  const score = Math.max(0, Math.min(100, basicsScore + hardScore + fitScore + bonusScore + notesScore + queueScore - penalty))
  const tone: RoleSubmissionPacket["tone"] = blockers.length ? "blocked" : score >= 82 && warnings.length === 0 ? "ready" : "watch"
  const label = tone === "blocked" ? "Blocked" : tone === "ready" ? "Ready to submit" : "Needs proof"
  const summary = tone === "ready"
    ? "This packet has consent, candidate identity, and enough checklist proof to submit cleanly."
    : tone === "blocked"
      ? "Fix the blocking items before this submission can move cleanly through WeKruit review."
      : "This candidate can become a strong submission once the missing proof is filled in."
  const nextAction = blockers[0] ?? warnings[0] ?? "Submit the candidate, then track review status from the recruiter inbox."
  const canSubmit = blockers.length === 0
  return {
    score,
    label,
    tone,
    summary,
    blockers,
    warnings,
    proof: proof.slice(0, 6),
    nextAction,
    missingHard: missingHard.slice(0, 4),
    antiFlags: antiFlags.slice(0, 4),
    gates,
    canSubmit,
    submitLabel: canSubmit ? "Submit candidate" : "Complete packet first",
  }
}

function buildRoleCalibrationBrief(input: {
  job: CollabJob
  pendingSlots: number
  roleCandidates: RecruiterSourcedCandidateItem[]
  roleSubmissions: RecruiterSubmissionItem[]
  roleFeedback: RecruiterRoleFeedbackItem | null
  roleQuestions: RecruiterRoleQuestionItem[]
  intelligence: RecruiterRoleIntelligenceItem | null
}): RoleCalibrationBrief {
  const { job, pendingSlots, roleCandidates, roleSubmissions, roleFeedback, roleQuestions, intelligence } = input
  const hardItems = roleChecklistItems(job, "hard").map((item) => item.text)
  const fitItems = roleChecklistItems(job, "fit").map((item) => item.text)
  const antiItems = roleChecklistItems(job, "anti").map((item) => item.text)
  const openQuestions = roleQuestions.filter((question) => (question.status ?? "open") === "open")
  const answeredQuestions = roleQuestions.filter((question) => question.status === "answered")
  const negative = roleSubmissions.filter((row) => ROLE_NEGATIVE_SUBMISSION_STATUSES.includes(row.status ?? ""))
  const rejected = negative.filter((row) => row.status === "rejected")
  const duplicate = negative.filter((row) => row.status === "duplicate")
  const advanced = roleSubmissions.filter((row) => ROLE_ADVANCED_SUBMISSION_STATUSES.includes(row.status ?? ""))
  const readyLocal = roleCandidates.filter((candidate) => candidate.stage === "ready").length
  const sourced = intelligence?.sourcedCount ?? roleCandidates.length
  const ready = intelligence?.readyCount ?? readyLocal
  const submitted = intelligence?.submissionCount ?? roleSubmissions.length
  const pending = intelligence?.pendingCount ?? roleSubmissions.filter((row) => ROLE_PENDING_SUBMISSION_STATUSES.includes(row.status ?? "submitted")).length
  const advancedCount = intelligence?.advancedCount ?? advanced.length
  const rejectedCount = intelligence?.rejectedCount ?? rejected.length
  const duplicateCount = intelligence?.duplicateCount ?? duplicate.length
  const totalPipeline = Math.max(1, sourced, submitted, pending + advancedCount + rejectedCount + duplicateCount)
  const friction = (intelligence?.feedback.hard ?? 0) + (intelligence?.feedback.blocked ?? 0) + (roleFeedback?.difficulty === "hard" ? 1 : 0) + (roleFeedback?.difficulty === "blocked" ? 1 : 0)
  const blocked = (intelligence?.feedback.blocked ?? 0) > 0 || roleFeedback?.difficulty === "blocked"
  const tone: RoleCalibrationBrief["tone"] = blocked
    ? "blocked"
    : openQuestions.length || friction > 0 || pendingSlots === 0
      ? "watch"
      : advancedCount > 0 || ready > 0
        ? "good"
        : "quiet"
  const headline = blocked
    ? "Calibration blocked"
    : openQuestions.length
      ? "Answer needed before more volume"
      : pendingSlots === 0
        ? "Review queue is full"
        : ready > 0
          ? "Ready candidates exist"
          : sourced > 0
            ? "Build proof before submitting"
            : "Start with sourced proof"
  const body = blocked
    ? "Market signal says this role needs a clearer search lane before more candidate volume."
    : openQuestions.length
      ? "A role question is open. Use the answer to tighten outreach and submission proof."
      : pendingSlots === 0
        ? "There are already five pending submissions. Wait for feedback before adding another candidate."
        : ready > 0
          ? "There is candidate inventory ready for a submission packet."
          : sourced > 0
            ? "Move the best prospects through screened and ready before submission."
            : "Save candidates first so duplicate checks, calibration, and status tracking can work."
  const nextMove = blocked
    ? "Ask a precise calibration question or update the role feedback before sourcing."
    : openQuestions.length
      ? `Wait on: ${openQuestions[0]?.question ?? "open role question"}`
      : pendingSlots === 0
        ? "Hold new submissions until WeKruit moves a pending candidate."
        : ready > 0
          ? "Open the strongest ready candidate and complete the submission packet."
          : sourced > 0
            ? "Screen saved prospects and mark the strongest one ready."
            : "Source three prospects before making a submission."
  const topReasonRows = intelligence?.feedback.topReasons.length
    ? intelligence.feedback.topReasons.map((item) => ({
      label: roleFeedbackReasonLabel(item.reason),
      count: item.count,
      detail: "Shared market signal",
    }))
    : (roleFeedback?.reasons ?? []).map((reason) => ({
      label: roleFeedbackReasonLabel(reason),
      count: 1,
      detail: roleFeedbackDifficultyLabel(roleFeedback?.difficulty),
    }))
  const feedbackReasons = rejected
    .filter((row) => row.recruiterFeedbackNote)
    .slice(0, 2)
    .map((row) => ({
      label: "Submission feedback",
      count: 1,
      detail: row.recruiterFeedbackNote ?? "Rejected candidate feedback",
    }))
  const rejectionReasons = [...topReasonRows, ...feedbackReasons].slice(0, 5)
  const prove = hardItems.slice(0, 4)
  const avoid = antiItems.slice(0, 4)
  const calibrate = [
    ...openQuestions.slice(0, 2).map((question) => question.question || "Open role question"),
    ...answeredQuestions.slice(0, 1).map((question) => question.answer || question.question || "Recent WeKruit answer"),
    ...(roleFeedback?.note ? [roleFeedback.note] : []),
  ].slice(0, 4)
  const marketFacts = [
    { label: "Pending capacity", value: `${pendingSlots}/5`, detail: pendingSlots ? "Submission lane open" : "Wait for feedback" },
    { label: "Market activity", value: `${intelligence?.recruiterCount ?? 1}`, detail: `${roleIntelligenceActivityLabel(intelligence?.lastActivityAt ?? null)}` },
    { label: "Fit direction", value: `${fitItems.length}`, detail: fitItems.slice(0, 2).join(" · ") || "No fit checks listed" },
  ]
  const pipeline = [
    { label: "Sourced", count: sourced, total: totalPipeline, tone: "quiet" as const },
    { label: "Ready", count: ready, total: totalPipeline, tone: ready ? "good" as const : "quiet" as const },
    { label: "Submitted", count: submitted, total: totalPipeline, tone: "watch" as const },
    { label: "Pending", count: pending, total: totalPipeline, tone: pending >= 5 ? "blocked" as const : "watch" as const },
    { label: "Advanced", count: advancedCount, total: totalPipeline, tone: advancedCount ? "good" as const : "quiet" as const },
    { label: "Rejected/dup", count: rejectedCount + duplicateCount, total: totalPipeline, tone: rejectedCount + duplicateCount ? "blocked" as const : "quiet" as const },
  ]
  return {
    tone,
    headline,
    body,
    nextMove,
    marketFacts,
    pipeline,
    rejectionReasons,
    guardrails: {
      prove,
      avoid,
      calibrate,
    },
  }
}

function candidateDisplayName(candidate: RecruiterSourcedCandidateItem): string {
  return candidate.candidate?.name || "Candidate"
}

function candidateHeadline(candidate: RecruiterSourcedCandidateItem): string {
  return [
    candidate.candidate?.currentRole,
    candidate.candidate?.yoe,
    candidate.jobTitleSnapshot,
    candidate.companyLabelSnapshot,
  ].filter(Boolean).join(" · ") || sourcedStageLabel(candidate.stage)
}

function roleCandidateText(candidate: RecruiterSourcedCandidateItem): string {
  return [
    candidate.candidate?.name,
    candidate.candidate?.currentRole,
    candidate.candidate?.yoe,
    candidate.candidate?.notes,
    candidate.jobTitleSnapshot,
    candidate.companyLabelSnapshot,
  ].filter(Boolean).join(" ")
}

function scoreRoleCandidate(job: CollabJob, candidate: RecruiterSourcedCandidateItem): RoleCandidateRecommendation {
  const roleText = [
    job.title,
    job.recruiterBoard.label.location,
    job.recruiterBoard.label.pills.map((pill) => pill.text).join(" "),
    job.jdBlocks.map((block) => `${block.heading} ${block.body}`).join(" "),
    roleChecklistItems(job, "hard").map((item) => item.text).join(" "),
    roleChecklistItems(job, "fit").map((item) => item.text).join(" "),
  ].join(" ")
  const roleTokens = sourcingTokens(roleText, 28)
  const candidateTokens = new Set(sourcingTokens(roleCandidateText(candidate), 36))
  const overlap = roleTokens.filter((token) => candidateTokens.has(token)).slice(0, 5)
  const stageBoost: Record<string, number> = {
    ready: 22,
    screened: 15,
    contacted: 9,
    sourced: 5,
    submitted: -12,
    archived: -24,
  }
  const calibrationBoost = candidate.calibrationStatus === "good_fit"
    ? 12
    : candidate.calibrationStatus === "bad_fit"
      ? -22
      : candidate.calibrationStatus === "calibration_requested"
        ? -6
        : 0
  const roleBound = roleMatches(job, candidate) ? 10 : 0
  const profileProof = (candidate.candidate?.link ? 4 : 0) + (candidate.candidate?.email ? 4 : 0) + (candidate.candidate?.notes ? 6 : 0)
  const score = Math.max(18, Math.min(98, 34 + overlap.length * 8 + (stageBoost[candidate.stage] ?? 0) + calibrationBoost + roleBound + profileProof))
  const tone: RoleCandidateRecommendation["tone"] = candidate.stage === "archived" || candidate.calibrationStatus === "bad_fit"
    ? "blocked"
    : score >= 78
      ? "good"
      : score >= 58
        ? "watch"
        : "quiet"
  const label = candidate.stage === "ready"
    ? "Ready candidate"
    : roleMatches(job, candidate)
      ? "Role candidate"
      : "Private bench"
  const reasons = [
    sourcedStageLabel(candidate.stage),
    candidate.calibrationStatus ? sourcedCalibrationLabel(candidate.calibrationStatus) : "",
    ...overlap.slice(0, 3).map((token) => `Matches ${token}`),
    candidate.candidate?.email ? "Email present" : "",
    candidate.candidate?.notes ? "Recruiter notes present" : "",
  ].filter(Boolean).slice(0, 5)
  return {
    candidate,
    score,
    tone,
    label,
    source: roleMatches(job, candidate) ? "role" : "bench",
    reasons,
  }
}

function buildRoleCandidateRecommendations(job: CollabJob, candidates: RecruiterSourcedCandidateItem[]): RoleCandidateRecommendation[] {
  const byId = new Map<string, RecruiterSourcedCandidateItem>()
  for (const candidate of candidates) {
    if (candidate.stage === "archived" || candidate.stage === "submitted") continue
    byId.set(candidate.id, candidate)
  }
  return [...byId.values()]
    .map((candidate) => scoreRoleCandidate(job, candidate))
    .sort((a, b) => b.score - a.score || timestampMs(b.candidate.updatedAt ?? b.candidate.createdAt) - timestampMs(a.candidate.updatedAt ?? a.candidate.createdAt))
}

function buildRoleWorkroomModel(input: {
  approvedForRole: boolean
  application: RecruiterRoleApplicationItem | null
  pendingSlots: number
  roleCandidates: RecruiterSourcedCandidateItem[]
  roleSubmissions: RecruiterSubmissionItem[]
  roleQuestions: RecruiterRoleQuestionItem[]
  roleFeedback: RecruiterRoleFeedbackItem | null
  selectedCandidate: RecruiterSourcedCandidateItem | null
  candidateRecommendations: RoleCandidateRecommendation[]
  packet: RoleSubmissionPacket
  brief: RoleCalibrationBrief
}): RoleWorkroomModel {
  const {
    approvedForRole,
    application,
    pendingSlots,
    roleCandidates,
    roleSubmissions,
    roleQuestions,
    roleFeedback,
    selectedCandidate,
    candidateRecommendations,
    packet,
    brief,
  } = input
  const openQuestions = roleQuestions.filter((question) => (question.status ?? "open") === "open").length
  const pendingSubmissions = roleSubmissions.filter((row) => ROLE_PENDING_SUBMISSION_STATUSES.includes(row.status ?? "submitted")).length
  const negativeSubmissions = roleSubmissions.filter((row) => ROLE_NEGATIVE_SUBMISSION_STATUSES.includes(row.status ?? "")).length
  const readyRecommendation = candidateRecommendations.find((item) => item.candidate.stage === "ready")
  const topRecommendation = candidateRecommendations[0]

  let tone: RoleWorkroomModel["tone"] = "quiet"
  let label = "Role workroom"
  let title = "Build the first shortlist"
  let body = "Start by saving candidates into the role or private bench, then submit only when the packet has proof and consent."
  let action: RoleWorkroomAction = "candidates"
  let actionLabel = "Open candidate CRM"
  let actionCandidate: RecruiterSourcedCandidateItem | undefined

  if (pendingSlots <= 0) {
    tone = "blocked"
    label = "Hold submissions"
    title = "This role has no pending slots left"
    body = "Wait for WeKruit feedback before adding more volume. Use the feedback panel to capture what the market is telling you."
    action = "feedback"
    actionLabel = "Open feedback"
  } else if (roleFeedback?.difficulty === "blocked" || brief.tone === "blocked") {
    tone = "blocked"
    label = "Calibration blocked"
    title = "Do not source through uncertainty"
    body = "The role needs a sharper search lane before more recruiter time goes into it."
    action = "questions"
    actionLabel = "Ask WeKruit"
  } else if (openQuestions > 0) {
    tone = "watch"
    label = "Question pending"
    title = `${openQuestions} role question${openQuestions === 1 ? "" : "s"} ${openQuestions === 1 ? "needs" : "need"} answer`
    body = "Use the answer before adding candidates, otherwise the role will create noisy submissions."
    action = "questions"
    actionLabel = "Open questions"
  } else if (selectedCandidate && packet.tone === "ready") {
    tone = "good"
    label = "Submit packet ready"
    title = `${candidateDisplayName(selectedCandidate)} is ready for review`
    body = "The packet has the core candidate proof. Review the final form and submit with consent."
    action = "submit"
    actionLabel = "Open submit packet"
  } else if (selectedCandidate) {
    tone = packet.tone === "blocked" ? "blocked" : "watch"
    label = "Complete packet"
    title = `Finish ${candidateDisplayName(selectedCandidate)}`
    body = packet.nextAction
    action = "submit"
    actionLabel = "Open submit packet"
  } else if (readyRecommendation) {
    tone = "good"
    label = "Submit next"
    title = `${candidateDisplayName(readyRecommendation.candidate)} is ready`
    body = "Prefill this candidate, verify hard checks, and submit while the candidate is warm."
    action = "candidate"
    actionLabel = "Use candidate"
    actionCandidate = readyRecommendation.candidate
  } else if (topRecommendation) {
    tone = topRecommendation.tone === "good" ? "good" : "watch"
    label = topRecommendation.source === "bench" ? "Bench match" : "Screen next"
    title = `${candidateDisplayName(topRecommendation.candidate)} is the best next candidate`
    body = topRecommendation.source === "bench"
      ? "This private bench candidate has enough signal to test against the role brief."
      : "Move this role candidate to ready or fill the missing proof before submission."
    action = "candidate"
    actionLabel = "Use candidate"
    actionCandidate = topRecommendation.candidate
  } else if (application?.status === "pending") {
    tone = "watch"
    label = "Access pending"
    title = "Build candidate proof while WeKruit reviews access"
    body = "A pending role application should not stall sourcing. Build a short list so the role is ready when approved."
    action = "candidates"
    actionLabel = "Add candidates"
  } else if (!approvedForRole) {
    tone = "quiet"
    label = "Single-submit lane"
    title = "Work this only with a strong candidate"
    body = "Apply for trusted access once you have candidate proof, or use a single-submit credit for an exceptional consented candidate."
    action = "access"
    actionLabel = "Open access"
  }

  return {
    tone,
    label,
    title,
    body,
    action,
    actionLabel,
    actionCandidate,
    cards: [
      {
        label: "Access lane",
        value: approvedForRole ? "Approved" : application?.status === "pending" ? "Pending" : "Single-submit",
        body: approvedForRole
          ? "Expected active coverage for this role."
          : application?.status === "pending"
            ? "WeKruit is reviewing your request."
            : "Use for exceptional candidates or apply with proof.",
        tone: approvedForRole ? "good" : application?.status === "pending" ? "watch" : "quiet",
        action: "access",
      },
      {
        label: "Candidate fit",
        value: candidateRecommendations.length ? `${topRecommendation?.score ?? 0}%` : "No bench",
        body: topRecommendation
          ? `${candidateDisplayName(topRecommendation.candidate)} · ${topRecommendation.label}`
          : `${roleCandidates.length} role candidate${roleCandidates.length === 1 ? "" : "s"} saved.`,
        tone: topRecommendation?.tone ?? (roleCandidates.length ? "watch" : "quiet"),
        action: topRecommendation ? "candidate" : "candidates",
      },
      {
        label: "Submission packet",
        value: `${packet.score}/100`,
        body: packet.nextAction,
        tone: packet.tone === "ready" ? "good" : packet.tone === "blocked" ? "blocked" : "watch",
        action: "submit",
      },
      {
        label: "Feedback loop",
        value: openQuestions ? `${openQuestions} Q` : negativeSubmissions ? `${negativeSubmissions} risk` : `${pendingSubmissions} pending`,
        body: openQuestions
          ? "Resolve role questions before adding volume."
          : negativeSubmissions
            ? "Use rejection or duplicate signal before more sourcing."
            : "Track review movement and keep candidates warm.",
        tone: openQuestions || negativeSubmissions ? "watch" : pendingSubmissions ? "quiet" : "good",
        action: openQuestions ? "questions" : "feedback",
      },
    ],
  }
}

function buildRoleDealDeskModel(input: {
  approvedForRole: boolean
  application: RecruiterRoleApplicationItem | null
  pendingSlots: number
  roleCandidates: RecruiterSourcedCandidateItem[]
  roleSubmissions: RecruiterSubmissionItem[]
  roleQuestions: RecruiterRoleQuestionItem[]
  roleFeedback: RecruiterRoleFeedbackItem | null
  selectedCandidate: RecruiterSourcedCandidateItem | null
  candidateRecommendations: RoleCandidateRecommendation[]
  packet: RoleSubmissionPacket
  brief: RoleCalibrationBrief
}): RoleDealDeskModel {
  const {
    approvedForRole,
    application,
    pendingSlots,
    roleCandidates,
    roleSubmissions,
    roleQuestions,
    roleFeedback,
    selectedCandidate,
    candidateRecommendations,
    packet,
    brief,
  } = input
  const openQuestions = roleQuestions.filter((question) => (question.status ?? "open") === "open")
  const readyCount = roleCandidates.filter((candidate) => candidate.stage === "ready").length
  const screenedCount = roleCandidates.filter((candidate) => candidate.stage === "screened" || candidate.stage === "ready").length
  const pendingCount = roleSubmissions.filter((row) => ROLE_PENDING_SUBMISSION_STATUSES.includes(row.status ?? "submitted")).length
  const advancedCount = roleSubmissions.filter((row) => ROLE_ADVANCED_SUBMISSION_STATUSES.includes(row.status ?? "")).length
  const negativeCount = roleSubmissions.filter((row) => ROLE_NEGATIVE_SUBMISSION_STATUSES.includes(row.status ?? "")).length
  const topCandidate = candidateRecommendations[0]
  const readyCandidate = candidateRecommendations.find((item) => item.candidate.stage === "ready")
  const blocked = pendingSlots <= 0 || roleFeedback?.difficulty === "blocked" || brief.tone === "blocked"
  const watch = openQuestions.length > 0 || packet.tone !== "ready" || negativeCount > 0

  let tone: RoleDealDeskModel["tone"] = blocked ? "blocked" : watch ? "watch" : topCandidate ? "good" : "quiet"
  let mode = approvedForRole ? "Trusted role lane" : application?.status === "pending" ? "Access pending" : "Single-submit lane"
  let title = "Run this role from evidence, not guesses"
  let body = "Work the role as a sequence: build candidate inventory, screen to proof, submit only clean packets, then adjust from WeKruit feedback."
  let primaryAction: RoleWorkroomAction = "candidates"
  let primaryLabel = "Open candidate CRM"
  let primaryCandidate: RecruiterSourcedCandidateItem | undefined

  if (pendingSlots <= 0) {
    title = "Submission lane is full"
    body = "Pause new submissions until WeKruit moves the review queue. Use feedback and questions to prepare the next sourcing pass."
    primaryAction = "feedback"
    primaryLabel = "Review feedback"
  } else if (roleFeedback?.difficulty === "blocked" || brief.tone === "blocked") {
    title = "Calibration is blocked"
    body = "Do not keep adding profiles until the role has a sharper target. Ask WeKruit the blocking question and update the market signal."
    primaryAction = "questions"
    primaryLabel = "Ask WeKruit"
  } else if (openQuestions.length > 0) {
    title = "Resolve calibration before more volume"
    body = openQuestions[0]?.question || "A role question is open. Get the answer into the workflow before submitting more candidates."
    primaryAction = "questions"
    primaryLabel = "Open questions"
  } else if (selectedCandidate && packet.tone === "ready") {
    mode = "Packet ready"
    tone = "good"
    title = `${candidateDisplayName(selectedCandidate)} can be submitted now`
    body = "The selected candidate has the required identity, consent, and proof. Submit, then watch the status loop."
    primaryAction = "submit"
    primaryLabel = "Submit packet"
  } else if (selectedCandidate) {
    title = `Finish ${candidateDisplayName(selectedCandidate)} before submit`
    body = packet.nextAction
    primaryAction = "submit"
    primaryLabel = "Complete packet"
  } else if (readyCandidate) {
    tone = "good"
    title = `${candidateDisplayName(readyCandidate.candidate)} is the next best move`
    body = "Use this ready candidate, complete the packet, and avoid burning the pending lane on weaker profiles."
    primaryAction = "candidate"
    primaryLabel = "Use candidate"
    primaryCandidate = readyCandidate.candidate
  } else if (topCandidate) {
    title = `${candidateDisplayName(topCandidate.candidate)} should be screened next`
    body = "There is candidate signal, but the packet still needs proof before WeKruit review."
    primaryAction = "candidate"
    primaryLabel = "Use candidate"
    primaryCandidate = topCandidate.candidate
  } else if (!approvedForRole && application?.status !== "pending") {
    title = "Earn access with candidate proof"
    body = "This role is in single-submit mode. Build proof in the CRM, then apply for trusted role access or submit one exceptional candidate."
    primaryAction = "access"
    primaryLabel = "Open access"
  }

  const proofBacklog = [
    ...packet.blockers.map((item) => ({ label: "Blocking item", detail: item, tone: "blocked" as const })),
    ...packet.warnings.map((item) => ({ label: "Needs proof", detail: item, tone: "watch" as const })),
    ...packet.missingHard.map((item) => ({ label: "Hard requirement", detail: item, tone: "watch" as const })),
    ...brief.guardrails.prove.slice(0, 2).map((item) => ({ label: "Evidence to capture", detail: item, tone: "quiet" as const })),
  ].slice(0, 5)

  const risks = [
    ...(openQuestions.length
      ? [{
        label: `${openQuestions.length} open question${openQuestions.length === 1 ? "" : "s"}`,
        detail: openQuestions[0]?.question || "Resolve open role questions before adding volume.",
        tone: "watch" as const,
        action: "questions" as const,
      }]
      : []),
    ...(pendingSlots <= 0
      ? [{
        label: "No pending slots",
        detail: "The role already has five pending submissions. Wait for movement before adding another.",
        tone: "blocked" as const,
        action: "feedback" as const,
      }]
      : []),
    ...(negativeCount > 0
      ? [{
        label: `${negativeCount} rejection or duplicate signal${negativeCount === 1 ? "" : "s"}`,
        detail: "Read the status feedback before sourcing lookalikes.",
        tone: "watch" as const,
        action: "feedback" as const,
      }]
      : []),
    ...(roleFeedback?.note
      ? [{
        label: "Your market note",
        detail: shortText(roleFeedback.note, roleFeedback.note, 120),
        tone: roleFeedback.difficulty === "blocked" ? "blocked" as const : "quiet" as const,
        action: "feedback" as const,
      }]
      : []),
  ].slice(0, 4)

  return {
    tone,
    mode,
    title,
    body,
    primaryAction,
    primaryLabel,
    primaryCandidate,
    lanes: [
      {
        label: "Source",
        value: `${roleCandidates.length}`,
        detail: roleCandidates.length ? "Candidates saved against this role." : "Start by saving candidates into the CRM.",
        tone: roleCandidates.length ? "good" : "quiet",
        action: "candidates",
      },
      {
        label: "Screen",
        value: `${screenedCount}`,
        detail: readyCount ? `${readyCount} ready for packet work.` : "Move prospects to screened or ready with notes.",
        tone: readyCount ? "good" : screenedCount ? "watch" : "quiet",
        action: topCandidate ? "candidate" : "candidates",
        actionCandidate: topCandidate?.candidate,
      },
      {
        label: "Submit",
        value: `${pendingSlots}/5`,
        detail: pendingSlots ? `${pendingCount} pending in review.` : "Submission lane is full.",
        tone: pendingSlots ? "good" : "blocked",
        action: "submit",
      },
      {
        label: "Close loop",
        value: advancedCount ? `${advancedCount} advanced` : negativeCount ? `${negativeCount} risk` : `${openQuestions.length} Q`,
        detail: advancedCount ? "Keep warm candidates moving." : negativeCount ? "Update sourcing from feedback." : "Ask and answer role questions.",
        tone: advancedCount ? "good" : negativeCount || openQuestions.length ? "watch" : "quiet",
        action: openQuestions.length ? "questions" : "feedback",
      },
    ],
    proofPlan: proofBacklog.length
      ? proofBacklog
      : [{
        label: "Packet standard",
        detail: packet.nextAction,
        tone: packet.tone === "ready" ? "good" : packet.tone === "blocked" ? "blocked" : "watch",
      }],
    risks: risks.length
      ? risks
      : [{
        label: "No blocker detected",
        detail: "Use the scorecard and candidate consent gate before submitting.",
        tone: "good",
        action: "submit",
      }],
  }
}

function buildRoleIntakeMemo(input: {
  job: CollabJob
  approvedForRole: boolean
  application: RecruiterRoleApplicationItem | null
  pendingSlots: number
  roleCandidates: RecruiterSourcedCandidateItem[]
  roleSubmissions: RecruiterSubmissionItem[]
  roleQuestions: RecruiterRoleQuestionItem[]
  roleFeedback: RecruiterRoleFeedbackItem | null
  intelligence: RecruiterRoleIntelligenceItem | null
  brief: RoleCalibrationBrief
}): RoleIntakeMemo {
  const { job, approvedForRole, application, pendingSlots, roleCandidates, roleSubmissions, roleQuestions, roleFeedback, intelligence, brief } = input
  const hardItems = roleChecklistItems(job, "hard").map((item) => item.text)
  const fitItems = roleChecklistItems(job, "fit").map((item) => item.text)
  const antiItems = roleChecklistItems(job, "anti").map((item) => item.text)
  const openQuestions = roleQuestions.filter((question) => (question.status ?? "open") === "open")
  const answeredQuestions = roleQuestions.filter((question) => question.status === "answered")
  const rejectedOrDuplicate = roleSubmissions.filter((row) => ROLE_NEGATIVE_SUBMISSION_STATUSES.includes(row.status ?? ""))
  const advanced = roleSubmissions.filter((row) => ROLE_ADVANCED_SUBMISSION_STATUSES.includes(row.status ?? ""))
  const readyCandidates = roleCandidates.filter((candidate) => candidate.stage === "ready")
  const blocked = brief.tone === "blocked" || roleFeedback?.difficulty === "blocked" || pendingSlots === 0
  const watch = openQuestions.length > 0 || roleFeedback?.difficulty === "hard" || rejectedOrDuplicate.length > 0
  const tone: RoleIntakeMemo["tone"] = blocked
    ? "blocked"
    : watch
      ? "watch"
      : readyCandidates.length || advanced.length
        ? "good"
        : "quiet"
  const company = job.recruiterBoard.label.company
  const roleStory = job.recruiterBoard.culture.bet || job.recruiterBoard.culture.bullets[0] || `${company} is actively hiring for ${job.title}.`
  const firstHard = hardItems[0] ?? "candidate consent, identity proof, and role-specific evidence"
  const firstFit = fitItems[0] ?? roleStory
  const firstAnti = antiItems[0] ?? "weak-fit submissions without hard-check proof"
  const accessLabel = approvedForRole
    ? "Approved lane"
    : application?.status === "pending"
      ? "Access pending"
      : "Single-submit"
  const reviewLabel = pendingSlots === 0
    ? "Queue full"
    : openQuestions.length
      ? "Answer needed"
      : `${pendingSlots}/5 open`
  const title = blocked
    ? "Resolve role intake risk before sending more candidates"
    : openQuestions.length
      ? "Use WeKruit answers before sourcing through uncertainty"
      : readyCandidates.length
        ? "Turn the ready candidate into a clean packet"
        : roleCandidates.length
          ? "Screen the bench against the intake memo"
          : "Source against the intake memo before submitting"
  const body = blocked
    ? "This search has a capacity or calibration blocker. Recruiters should tighten the role lane before adding volume."
    : openQuestions.length
      ? "A recruiter question is waiting on WeKruit. Treat the answer as intake context before making more outreach promises."
      : "Use this memo as the private role-intake brief: what to sell, what to prove, what to avoid, and when to ask WeKruit."
  const action: RoleWorkroomAction = blocked || openQuestions.length
    ? "questions"
    : readyCandidates.length
      ? "submit"
      : !approvedForRole && roleCandidates.length > 0
        ? "access"
        : "candidates"
  const facts: RoleIntakeMemo["facts"] = [
    {
      label: "Client story",
      value: company,
      detail: shortText(roleStory, roleStory, 140),
      tone: "good",
      action: "candidates",
    },
    {
      label: "Must prove",
      value: `${hardItems.length || 1} check${hardItems.length === 1 ? "" : "s"}`,
      detail: shortText(firstHard, firstHard, 140),
      tone: hardItems.length ? "watch" : "quiet",
      action: "submit",
    },
    {
      label: "Review lane",
      value: reviewLabel,
      detail: job.recruiterBoard.interviewProcess || (pendingSlots ? "WeKruit review capacity is open." : "Wait for review movement before adding volume."),
      tone: pendingSlots === 0 ? "blocked" : openQuestions.length ? "watch" : "good",
      action: openQuestions.length ? "questions" : "feedback",
    },
    {
      label: "Access posture",
      value: accessLabel,
      detail: approvedForRole
        ? "Expected to actively cover this lane."
        : application?.status === "pending"
          ? "Access request is waiting on WeKruit."
          : "Use candidate-led proof before asking for trusted access.",
      tone: approvedForRole ? "good" : application?.status === "pending" ? "watch" : "quiet",
      action: "access",
    },
  ]
  const assumptions: RoleIntakeMemo["assumptions"] = []
  const addAssumption = (item: RoleIntakeMemo["assumptions"][number]) => {
    if (!assumptions.some((row) => row.label === item.label)) assumptions.push(item)
  }
  if (!job.compSummary || roleFeedback?.reasons.includes("low_comp")) {
    addAssumption({
      label: "Compensation story",
      detail: job.compSummary ? `Candidate comp pushback exists despite ${job.compSummary}.` : "Compensation is not specific enough for high-intent outreach.",
      tone: roleFeedback?.reasons.includes("low_comp") ? "blocked" : "watch",
      action: "questions",
    })
  }
  if (roleFeedback?.reasons.includes("location_mismatch") || /remote|hybrid|onsite/i.test(job.recruiterBoard.label.location)) {
    addAssumption({
      label: "Location boundary",
      detail: `Clarify exceptions around ${job.recruiterBoard.label.location} before widening the search.`,
      tone: roleFeedback?.reasons.includes("location_mismatch") ? "blocked" : "watch",
      action: "questions",
    })
  }
  if (roleFeedback?.reasons.includes("unclear_requirements") || hardItems.length === 0) {
    addAssumption({
      label: "Must-have cutline",
      detail: "The role needs a clearer line between true hard filters and nice-to-have fit.",
      tone: "blocked",
      action: "questions",
    })
  }
  if (rejectedOrDuplicate.length > 0) {
    addAssumption({
      label: "Rejected packet lesson",
      detail: `${rejectedOrDuplicate.length} rejected or duplicate packet${rejectedOrDuplicate.length === 1 ? "" : "s"} should shape the next shortlist.`,
      tone: "watch",
      action: "feedback",
    })
  }
  if (openQuestions[0]) {
    addAssumption({
      label: "Open WeKruit answer",
      detail: openQuestions[0].question || "A role question is still open.",
      tone: "watch",
      action: "questions",
    })
  }
  if (answeredQuestions[0]) {
    addAssumption({
      label: "Latest answer",
      detail: answeredQuestions[0].answer || answeredQuestions[0].question || "WeKruit answered a role question.",
      tone: "good",
      action: "questions",
    })
  }
  if (assumptions.length === 0) {
    addAssumption({
      label: "No unresolved intake blocker",
      detail: "Proceed with hard-filter proof, candidate consent, and clean ownership checks.",
      tone: "good",
      action: "submit",
    })
  }
  const talkTrack = [
    `${company}: ${shortText(roleStory, roleStory, 160)}`,
    `Lead with ${shortText(firstFit, firstFit, 130)}.`,
    `Validate proof for ${shortText(firstHard, firstHard, 130)} before submission.`,
    `Do not pitch ${shortText(firstAnti, firstAnti, 130)}.`,
    intelligence?.recruiterCount && intelligence.recruiterCount > 1
      ? `${intelligence.recruiterCount} recruiters have market signal here; avoid duplicate lanes.`
      : "Keep the candidate paper trail in WeKruit before formal submission.",
  ]
  return {
    tone,
    label: "Private intake memo",
    title,
    body,
    action,
    actionLabel: action === "questions"
      ? "Ask WeKruit"
      : action === "submit"
        ? "Complete packet"
        : action === "access"
          ? "Review access"
          : "Open candidate CRM",
    facts,
    talkTrack,
    assumptions: assumptions.slice(0, 4),
  }
}

function roleRewardSummaryLooksFee(summary?: string | null): boolean {
  return /fee|reward|bounty|placement|success/i.test(summary ?? "")
}

function roleRewardValue(job: CollabJob): string {
  if (roleRewardSummaryLooksFee(job.compSummary)) return shortText(job.compSummary, "$10K+ success fee", 42)
  return "$10K+ estimated"
}

function payoutStatusLabel(status?: string): string {
  switch (status) {
    case "paid": return "Paid"
    case "processing": return "Processing"
    case "invoice_ready": return "Invoice ready"
    case "eligible": return "Eligible"
    case "pending_start": return "Pending start"
    case "pending": return "Pending"
    default: return "Not recorded"
  }
}

function payoutAmount(row: RecruiterSubmissionItem): string | null {
  const amount = row.recruiterPayout?.amount
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null
  const currency = row.recruiterPayout?.currency || "USD"
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount)
  } catch {
    return `$${Math.round(amount).toLocaleString("en-US")}`
  }
}

function buildRoleRewardCenter(input: {
  job: CollabJob
  approvedForRole: boolean
  application: RecruiterRoleApplicationItem | null
  pendingSlots: number
  roleCandidates: RecruiterSourcedCandidateItem[]
  roleSubmissions: RecruiterSubmissionItem[]
  roleFeedback: RecruiterRoleFeedbackItem | null
  candidateRecommendations: RoleCandidateRecommendation[]
}): RoleRewardCenter {
  const { job, approvedForRole, application, pendingSlots, roleCandidates, roleSubmissions, roleFeedback, candidateRecommendations } = input
  const readyCandidates = roleCandidates.filter((candidate) => candidate.stage === "ready")
  const screenedCandidates = roleCandidates.filter((candidate) => candidate.stage === "screened" || candidate.stage === "ready")
  const pendingSubmissions = roleSubmissions.filter((row) => ROLE_PENDING_SUBMISSION_STATUSES.includes(row.status ?? "submitted"))
  const advancedSubmissions = roleSubmissions.filter((row) => ROLE_ADVANCED_SUBMISSION_STATUSES.includes(row.status ?? ""))
  const negativeSubmissions = roleSubmissions.filter((row) => ROLE_NEGATIVE_SUBMISSION_STATUSES.includes(row.status ?? ""))
  const recordedPayouts = roleSubmissions.filter((row) => {
    const status = row.recruiterPayout?.status
    return Boolean(status && status !== "none")
  })
  const paidPayouts = recordedPayouts.filter((row) => row.recruiterPayout?.status === "paid")
  const actionablePayout = recordedPayouts.find((row) => row.recruiterPayout?.status === "invoice_ready" || row.recruiterPayout?.status === "eligible" || row.recruiterPayout?.status === "pending_start") ?? recordedPayouts[0]
  const payoutLabel = paidPayouts.length
    ? `${paidPayouts.length} paid`
    : actionablePayout
      ? payoutStatusLabel(actionablePayout.recruiterPayout?.status)
      : advancedSubmissions.length
        ? "Conversion path"
        : "Hire-triggered"
  const payoutDetail = actionablePayout
    ? `${payoutAmount(actionablePayout) ?? "Recorded payout"}: ${actionablePayout.recruiterPayout?.note || payoutStatusLabel(actionablePayout.recruiterPayout?.status).toLowerCase()}.`
    : advancedSubmissions.length
      ? `${advancedSubmissions.length} advanced candidate${advancedSubmissions.length === 1 ? "" : "s"} can still convert into payout.`
      : "Payout becomes real after a submitted candidate reaches a hire or recorded reward milestone."
  const qualityCandidates = candidateRecommendations.filter((item) => item.tone === "good" || item.tone === "watch")
  const eligibleValue = readyCandidates.length
    ? `${readyCandidates.length} ready`
    : screenedCandidates.length
      ? `${screenedCandidates.length} screened`
      : qualityCandidates.length
        ? `${qualityCandidates.length} suggested`
        : "0 ready"
  const rewardKnown = roleRewardSummaryLooksFee(job.compSummary)
  const rewardDetail = rewardKnown
    ? "Listed role reward; submit only consented candidates with hard-filter proof."
    : job.compSummary
      ? `Candidate comp is ${shortText(job.compSummary, job.compSummary, 74)}; recruiter reward is tracked after hire.`
      : "No exact role reward is stored yet; treat this as estimated until WeKruit records payout status."
  const accessDetail = approvedForRole
    ? "Trusted access approved for active coverage."
    : application?.status === "pending"
      ? "Access request is waiting on WeKruit."
      : "Single-submit route is open when you have a consented candidate with proof."
  const title = pendingSlots === 0
    ? "Reward lane is full until review moves"
    : readyCandidates.length
      ? "Turn ready candidates into reward exposure"
      : qualityCandidates.length
        ? "Prioritize suggested candidates before more cold sourcing"
        : "Build candidate proof before this role has earning value"
  const body = pendingSlots === 0
    ? "This role has hit the pending submission limit. Wait for review feedback before creating more candidate risk."
    : "A recruiter marketplace needs visible upside and exact next actions. This role view ties the reward story to candidates, review capacity, and payout movement."
  const tone: RoleRewardCenter["tone"] = pendingSlots === 0
    ? "blocked"
    : readyCandidates.length || advancedSubmissions.length || recordedPayouts.length
      ? "good"
      : qualityCandidates.length || roleFeedback?.difficulty === "hard"
        ? "watch"
        : "quiet"

  return {
    tone,
    title,
    body,
    primaryAction: pendingSlots === 0 ? "feedback" : readyCandidates.length ? "submit" : "candidates",
    primaryLabel: pendingSlots === 0 ? "Check feedback" : readyCandidates.length ? "Submit ready candidate" : "Build candidate proof",
    cards: [
      {
        label: "Success fee",
        value: roleRewardValue(job),
        detail: rewardDetail,
        tone: rewardKnown ? "good" : "watch",
        action: rewardKnown ? "submit" : "questions",
      },
      {
        label: "Eligible candidates",
        value: eligibleValue,
        detail: readyCandidates.length
          ? "Ready candidates can be converted into clean packets."
          : qualityCandidates.length
            ? "Suggested candidates still need screening and consent."
            : "Save and screen candidates before expecting payout movement.",
        tone: readyCandidates.length ? "good" : qualityCandidates.length ? "watch" : "quiet",
        action: "candidates",
      },
      {
        label: "Review capacity",
        value: `${pendingSlots}/${ROLE_PENDING_SUBMISSION_LIMIT} open`,
        detail: pendingSlots ? `${pendingSubmissions.length} pending submission${pendingSubmissions.length === 1 ? "" : "s"} in review.` : "Wait for WeKruit feedback before submitting more.",
        tone: pendingSlots ? "good" : "blocked",
        action: pendingSlots ? "submit" : "feedback",
      },
      {
        label: "Payout path",
        value: payoutLabel,
        detail: payoutDetail,
        tone: paidPayouts.length || actionablePayout ? "good" : advancedSubmissions.length ? "watch" : "quiet",
        action: "feedback",
      },
    ],
    steps: [
      {
        label: "Get the right to work the lane",
        detail: accessDetail,
        tone: approvedForRole ? "good" : application?.status === "pending" ? "watch" : "quiet",
        action: "access",
      },
      {
        label: "Create a clean submission packet",
        detail: readyCandidates.length
          ? `${readyCandidates.length} ready candidate${readyCandidates.length === 1 ? "" : "s"} need consent, evidence, and ownership checks.`
          : "Screen saved candidates against hard filters before sending anything to WeKruit.",
        tone: readyCandidates.length ? "good" : screenedCandidates.length ? "watch" : "quiet",
        action: readyCandidates.length ? "submit" : "candidates",
      },
      {
        label: "Let feedback calibrate the next batch",
        detail: negativeSubmissions.length
          ? `${negativeSubmissions.length} rejected or duplicate outcome${negativeSubmissions.length === 1 ? "" : "s"} should change sourcing.`
          : pendingSubmissions.length
            ? "Wait for review movement before copying the same candidate lane."
            : "No review signal yet; first packet creates the learning loop.",
        tone: negativeSubmissions.length ? "watch" : pendingSubmissions.length ? "watch" : "quiet",
        action: "feedback",
      },
      {
        label: "Track hire and payout movement",
        detail: payoutDetail,
        tone: paidPayouts.length || recordedPayouts.length ? "good" : advancedSubmissions.length ? "watch" : "quiet",
        action: "feedback",
      },
    ],
  }
}

// Minimal Markdown → React renderer for jdBlocks.body. Supports `-` bullet
// lists, blank-line paragraphs, and inline `**bold**` / `*em*` / `` `code` ``.
function renderMarkdown(text: string): ReactNode[] {
  const lines = text.split("\n")
  const out: ReactNode[] = []
  let listBuffer: string[] = []
  let key = 0
  const flushList = () => {
    if (listBuffer.length) {
      out.push(
        <ul key={key++}>
          {listBuffer.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      )
      listBuffer = []
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith("- ")) {
      listBuffer.push(line.slice(2))
    } else if (line === "") {
      flushList()
    } else {
      flushList()
      out.push(<p key={key++}>{renderInline(line)}</p>)
    }
  }
  flushList()
  return out
}

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  // Tokenize on **bold**, *em*, `code`
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[1]
    if (tok.startsWith("**")) parts.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith("`")) parts.push(<code key={key++}>{tok.slice(1, -1)}</code>)
    else parts.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    last = regex.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export default function RecruiterRole() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [session, setSession] = useState<RecruiterSession | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [sourcedCandidates, setSourcedCandidates] = useState<RecruiterSourcedCandidateItem[]>([])
  const [submissions, setSubmissions] = useState<RecruiterSubmissionItem[]>([])
  const [roleApplications, setRoleApplications] = useState<RecruiterRoleApplicationItem[]>([])
  const [roleFeedback, setRoleFeedback] = useState<RecruiterRoleFeedbackItem[]>([])
  const [roleIntelligence, setRoleIntelligence] = useState<RecruiterRoleIntelligenceItem[]>([])
  const [roleQuestions, setRoleQuestions] = useState<RecruiterRoleQuestionItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [trackerError, setTrackerError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [submission, setSubmission] = useState<SubmissionResponse | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [identityCheck, setIdentityCheck] = useState<CandidateIdentityCheckState>({
    status: "missing",
    result: null,
    error: null,
    inputKey: null,
  })
  const [prefilledCandidateId, setPrefilledCandidateId] = useState<string | null>(null)
  const [roleApplicationSaving, setRoleApplicationSaving] = useState(false)
  const [roleApplicationError, setRoleApplicationError] = useState<string | null>(null)
  const [resendingConfirmationId, setResendingConfirmationId] = useState<string | null>(null)
  const [confirmationError, setConfirmationError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      void (async () => {
        if (!user) {
          if (!active) return
          setSession(null)
          setAuthReady(true)
          return
        }
        try {
          const next = await getRecruiterProfile()
          if (active) setSession(next)
        } catch {
          if (active) setSession(null)
        } finally {
          if (active) setAuthReady(true)
        }
      })()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  // Restore persisted form once we know the jobId.
  useEffect(() => {
    if (jobId) setForm(withRecruiterDefaults(loadFormState(jobId), session))
  }, [jobId, session])

  // Fetch list once; pull out the role this page renders.
  useEffect(() => {
    fetchCollabJobs()
      .then((list) => setJobs(list))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  useEffect(() => {
    if (!session) return
    let active = true
    const roleIntelligenceRequest = fetchRecruiterRoleIntelligence().catch(() => [] as RecruiterRoleIntelligenceItem[])
    Promise.all([
      fetchRecruiterSourcedCandidates(),
      fetchRecruiterSubmissions(),
      fetchRecruiterRoleApplications(),
      fetchRecruiterRoleFeedback(),
      fetchRecruiterRoleQuestions(),
      roleIntelligenceRequest,
    ])
      .then(([candidates, rows, applications, feedback, questions, intelligence]) => {
        if (!active) return
        setSourcedCandidates(candidates)
        setSubmissions(rows)
        setRoleApplications(applications)
        setRoleFeedback(feedback)
        setRoleQuestions(questions)
        setRoleIntelligence(intelligence)
        setTrackerError(null)
      })
      .catch((e) => {
        if (active) setTrackerError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      active = false
    }
  }, [session?.recruiterId])

  // Persist form on every change.
  useEffect(() => {
    if (jobId) saveFormState(jobId, form)
  }, [jobId, form])

  useEffect(() => {
    const link = form.candidateLink.trim()
    const email = form.candidateEmail.trim().toLowerCase()
    const emailReady = !email || isValidEmail(email)
    if (!session || !jobId || !link || !emailReady) {
      setIdentityCheck({ status: "missing", result: null, error: null, inputKey: null })
      return
    }
    const inputKey = `${jobId}|${email}|${link}`

    let active = true
    setIdentityCheck({ status: "checking", result: null, error: null, inputKey })
    const timer = window.setTimeout(() => {
      void checkRecruiterCandidateIdentity({
        jobId,
        candidate: {
          link,
          ...(email ? { email } : {}),
        },
      })
        .then((result) => {
          if (!active) return
          setIdentityCheck({
            status: result.conflict ? "conflict" : "clear",
            result,
            error: null,
            inputKey,
          })
        })
        .catch((error) => {
          if (!active) return
          setIdentityCheck({
            status: "error",
            result: null,
            error: error instanceof Error ? error.message : String(error),
            inputKey,
          })
        })
    }, 550)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [form.candidateEmail, form.candidateLink, jobId, session])

  const job = useMemo(() => jobs?.find((j) => j.jobId === jobId) ?? null, [jobs, jobId])

  useEffect(() => {
    const candidateParam = searchParams.get("candidateId")
    if (!candidateParam || prefilledCandidateId === candidateParam) return
    const candidate = sourcedCandidates.find((c) => c.id === candidateParam || c.candidateId === candidateParam)
    if (!candidate) return
    setForm((next) => withRecruiterDefaults({
      ...next,
      candidateName: candidate.candidate?.name || "",
      candidateEmail: candidate.candidate?.email || "",
      candidateLink: candidate.candidate?.link || "",
      candidateCurrentRole: candidate.candidate?.currentRole || "",
      candidateYoe: candidate.candidate?.yoe || "",
      candidateNotes: candidate.candidate?.notes || "",
    }, session))
    setPrefilledCandidateId(candidateParam)
  }, [prefilledCandidateId, searchParams, session, sourcedCandidates])

  if (error) return <div className="rb-page"><div className="rb-state error">Could not load: {error}</div></div>
  if (!authReady) return <div className="rb-page"><div className="rb-state">Loading recruiter account...</div></div>
  if (!session) {
    return (
      <div className="rb-page rb-page--access-required">
        <main className="rb-main">
          <Link to="/recruiters" className="rb-back">Back to recruiter access</Link>
          <div className="rb-access-required">
            <p className="rb-overline">Invite required</p>
            <h1>Recruiter access is required before submitting candidates.</h1>
            <p>Enter your WeKruit recruiter code first. After that, role pages can submit and track candidates under your account.</p>
            <Link to="/recruiters" className="rb-btn primary">Enter access code</Link>
          </div>
        </main>
      </div>
    )
  }
  if (!jobs) return <div className="rb-page"><div className="rb-state">Loading…</div></div>
  if (!job) {
    return (
      <div className="rb-page">
        <main className="rb-main">
          <Link to="/recruiters" className="rb-back">← All roles</Link>
          <div className="rb-state error">
            Role <code>{jobId}</code> not found or no longer active.
          </div>
        </main>
      </div>
    )
  }

  const groups = job.recruiterBoard.checklist.groups
  const totals = {
    hard: groups.find((g) => g.kind === "hard")?.items.length ?? 0,
    fit: groups.find((g) => g.kind === "fit")?.items.length ?? 0,
    bonus: groups.find((g) => g.kind === "bonus")?.items.length ?? 0,
    anti: groups.find((g) => g.kind === "anti")?.items.length ?? 0,
  }
  const checkedCounts = {
    hard: (groups.find((g) => g.kind === "hard")?.items ?? []).filter((i) => form.checklist[i.id]).length,
    fit: (groups.find((g) => g.kind === "fit")?.items ?? []).filter((i) => form.checklist[i.id]).length,
    bonus: (groups.find((g) => g.kind === "bonus")?.items ?? []).filter((i) => form.checklist[i.id]).length,
    anti: (groups.find((g) => g.kind === "anti")?.items ?? []).filter((i) => form.checklist[i.id]).length,
  }
  const totalChecked = Object.values(checkedCounts).reduce((s, n) => s + n, 0)
  const totalItems = Object.values(totals).reduce((s, n) => s + n, 0)
  const roleCandidates = sourcedCandidates
    .filter((candidate) => roleMatches(job, candidate))
    .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))
  const unassignedCandidates = sourcedCandidates
    .filter((candidate) => !candidate.jobId && !candidate.inboundJobId && candidate.stage !== "archived")
    .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))
  const roleSubmissions = submissions
    .filter((row) => roleMatches(job, row))
    .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt))
  const currentRoleApplication = latestRoleApplication(job, roleApplications)
  const legacyApprovedRole = session.recruiter.workspacePreferences?.primaryRoleIds?.includes(job.jobId) ?? false
  const approvedForRole = legacyApprovedRole || currentRoleApplication?.status === "approved"
  const preparedApplicationCandidates = [...roleCandidates, ...unassignedCandidates]
    .filter((candidate) => candidate.stage !== "archived")
    .slice(0, 10)
  const currentRoleFeedback = roleFeedback.find((feedback) => roleMatches(job, feedback)) ?? null
  const currentRoleIntelligence = roleIntelligence.find((item) => item.jobId === job.jobId) ?? null
  const currentRoleQuestions = roleQuestions
    .filter((question) => roleMatches(job, question))
    .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))
  const pendingCount = roleSubmissions.filter((row) => ROLE_PENDING_SUBMISSION_STATUSES.includes(row.status ?? "submitted")).length
  const pendingSlots = Math.max(0, ROLE_PENDING_SUBMISSION_LIMIT - pendingCount)
  const selectedCandidate = prefilledCandidateId
    ? sourcedCandidates.find((candidate) => candidate.id === prefilledCandidateId || candidate.candidateId === prefilledCandidateId) ?? null
    : null
  const submissionPacket = buildRoleSubmissionPacket({
    job,
    form,
    pendingSlots,
    selectedCandidate,
    roleCandidates,
    roleSubmissions,
    roleFeedback: currentRoleFeedback,
    roleQuestions: currentRoleQuestions,
    intelligence: currentRoleIntelligence,
    identityCheck,
    approvedForRole,
    application: currentRoleApplication,
  })
  const calibrationBrief = buildRoleCalibrationBrief({
    job,
    pendingSlots,
    roleCandidates,
    roleSubmissions,
    roleFeedback: currentRoleFeedback,
    roleQuestions: currentRoleQuestions,
    intelligence: currentRoleIntelligence,
  })
  const sourcingKit = buildRoleSourcingKit(job, calibrationBrief)
  const candidateRecommendations = buildRoleCandidateRecommendations(job, [...roleCandidates, ...unassignedCandidates])
  const roleWorkroom = buildRoleWorkroomModel({
    approvedForRole,
    application: currentRoleApplication,
    pendingSlots,
    roleCandidates,
    roleSubmissions,
    roleQuestions: currentRoleQuestions,
    roleFeedback: currentRoleFeedback,
    selectedCandidate,
    candidateRecommendations,
    packet: submissionPacket,
    brief: calibrationBrief,
  })
  const roleDealDesk = buildRoleDealDeskModel({
    approvedForRole,
    application: currentRoleApplication,
    pendingSlots,
    roleCandidates,
    roleSubmissions,
    roleQuestions: currentRoleQuestions,
    roleFeedback: currentRoleFeedback,
    selectedCandidate,
    candidateRecommendations,
    packet: submissionPacket,
    brief: calibrationBrief,
  })
  const roleIntakeMemo = buildRoleIntakeMemo({
    job,
    approvedForRole,
    application: currentRoleApplication,
    pendingSlots,
    roleCandidates,
    roleSubmissions,
    roleQuestions: currentRoleQuestions,
    roleFeedback: currentRoleFeedback,
    intelligence: currentRoleIntelligence,
    brief: calibrationBrief,
  })
  const roleRewardCenter = buildRoleRewardCenter({
    job,
    approvedForRole,
    application: currentRoleApplication,
    pendingSlots,
    roleCandidates,
    roleSubmissions,
    roleFeedback: currentRoleFeedback,
    candidateRecommendations,
  })
  const packetBlocksSubmit = !submissionPacket.canSubmit

  const useSourcedCandidate = (candidate: RecruiterSourcedCandidateItem) => {
    setForm((next) => withRecruiterDefaults({
      ...next,
      candidateName: candidate.candidate?.name || "",
      candidateEmail: candidate.candidate?.email || "",
      candidateLink: candidate.candidate?.link || "",
      candidateCurrentRole: candidate.candidate?.currentRole || "",
      candidateYoe: candidate.candidate?.yoe || "",
      candidateNotes: candidate.candidate?.notes || "",
    }, session))
    setPrefilledCandidateId(candidate.id)
    setSearchParams({ candidateId: candidate.id })
    requestAnimationFrame(() => document.getElementById("submit-candidate")?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }

  const runRoleWorkroomAction = (action: RoleWorkroomAction, candidate?: RecruiterSourcedCandidateItem) => {
    if (action === "candidate" && candidate) {
      useSourcedCandidate(candidate)
      return
    }
    if (action === "candidates") {
      navigate("/recruiters?tab=candidates")
      return
    }
    if (action === "access") {
      document.querySelector(".rb-role-access-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })
      return
    }
    if (action === "questions") {
      document.querySelector(".rb-role-questions")?.scrollIntoView({ behavior: "smooth", block: "start" })
      return
    }
    if (action === "feedback") {
      document.querySelector(".rb-role-feedback")?.scrollIntoView({ behavior: "smooth", block: "start" })
      return
    }
    document.getElementById("submit-candidate")?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const saveRoleApplication = async (input: RecruiterRoleApplicationInput) => {
    setRoleApplicationSaving(true)
    setRoleApplicationError(null)
    try {
      const saved = await saveRecruiterRoleApplication(input)
      setRoleApplications((rows) => [saved, ...rows.filter((row) => row.id !== saved.id)])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setRoleApplicationError(message)
      throw new Error(message)
    } finally {
      setRoleApplicationSaving(false)
    }
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!session) {
      setSubmitError("recruiter_access_required")
      return
    }
    if (packetBlocksSubmit) {
      setSubmitError(submissionPacket.nextAction)
      return
    }
    setSubmitError(null)
    setSubmitting(true)
    const result = await submitRecruiterCandidate({
      jobId: job.jobId,
      sourcedCandidateId: selectedCandidate?.id,
      submitter: {
        name: form.submitterName.trim(),
        email: form.submitterEmail.trim(),
      },
      candidate: {
        name: form.candidateName.trim(),
        email: form.candidateEmail.trim().toLowerCase(),
        link: form.candidateLink.trim(),
        currentRole: form.candidateCurrentRole.trim() || undefined,
        yoe: form.candidateYoe.trim() || undefined,
        notes: form.candidateNotes.trim() || undefined,
      },
      checklist: form.checklist,
      candidateConsent: true,
    })
    setSubmitting(false)
    if (result.ok) {
      setSubmission(result)
      if (selectedCandidate) {
        const submittedCandidate = {
          name: form.candidateName.trim(),
          email: form.candidateEmail.trim().toLowerCase(),
          link: form.candidateLink.trim(),
          currentRole: form.candidateCurrentRole.trim() || undefined,
          yoe: form.candidateYoe.trim() || undefined,
          notes: form.candidateNotes.trim() || undefined,
        }
        const submittedAt = new Date().toISOString()
        setSourcedCandidates((rows) => rows.map((row) => (
          row.id === selectedCandidate.id
            ? {
                ...row,
                stage: "submitted",
                jobId: job.jobId,
                inboundJobId: job.jobId,
                jobTitleSnapshot: job.title,
                companyLabelSnapshot: job.recruiterBoard.label.company,
                linkedSubmissionId: result.submissionId ?? row.linkedSubmissionId,
                submittedAt,
                candidate: submittedCandidate,
              }
            : row
        )))
      }
      saveFormState(job.jobId, withRecruiterDefaults(emptyForm(), session))
      window.scrollTo({ top: 0, behavior: "smooth" })
    } else {
      setSubmitError(formatSubmissionFailure(result.reason))
    }
  }

  const resetChecklist = () => {
    if (!confirm("Clear this role's checklist and candidate fields?")) return
    setForm(withRecruiterDefaults(emptyForm(), session))
  }

  const submitAnother = () => {
    setSubmission(null)
  }

  const resendCandidateConfirmation = async (row: RecruiterSubmissionItem) => {
    const receiptId = roleSubmissionReceiptId(row)
    setResendingConfirmationId(row.id)
    setConfirmationError(null)
    try {
      await resendRecruiterCandidateConfirmation(receiptId)
      const updatedSubmissions = await fetchRecruiterSubmissions()
      setSubmissions(updatedSubmissions)
    } catch (error) {
      setConfirmationError(error instanceof Error ? error.message : String(error))
    } finally {
      setResendingConfirmationId(null)
    }
  }

  return (
    <div className="rb-page">
      <main className="rb-main">
        <Link to="/recruiters" className="rb-back">← All roles</Link>

        <div className="rb-role-header">
          <div>
            <h2>{job.title}</h2>
            <div className="meta">
              <span>{job.recruiterBoard.label.company}</span>
              <span>{job.recruiterBoard.label.location}</span>
              <span>
                {job.recruiterBoard.label.pills.map((p, i) => (
                  <span key={i} className={`rb-pill ${p.tone ?? ""}`}>{p.text}</span>
                ))}
              </span>
            </div>
          </div>
        </div>

        <section className="rb-role-cockpit" aria-label="Role recruiting cockpit">
          <article>
            <span>Reward</span>
            <strong>{job.compSummary || "$10K+ placement fee"}</strong>
            <em>Paid on successful hire.</em>
          </article>
          <article>
            <span>Pending slots</span>
            <strong>{pendingSlots}/{ROLE_PENDING_SUBMISSION_LIMIT}</strong>
            <em>Wait for feedback when full.</em>
          </article>
          <article>
            <span>My role pipeline</span>
            <strong>{roleCandidates.length} sourced</strong>
            <em>{roleSubmissions.length} submitted.</em>
          </article>
          <article>
            <span>Scorecard</span>
            <strong>{totals.hard} hard / {totals.fit} fit</strong>
            <em>{totals.anti} anti-signal checks.</em>
          </article>
        </section>

        <RoleWorkroomPanel
          model={roleWorkroom}
          candidates={candidateRecommendations}
          onAction={runRoleWorkroomAction}
        />

        <RoleDealDeskPanel
          model={roleDealDesk}
          onAction={runRoleWorkroomAction}
        />

        <RoleIntakeMemoPanel
          memo={roleIntakeMemo}
          onAction={runRoleWorkroomAction}
        />

        <RoleRewardCenterPanel
          center={roleRewardCenter}
          onAction={runRoleWorkroomAction}
        />

        <RoleAccessPanel
          job={job}
          application={currentRoleApplication}
          approvedByLegacySlot={legacyApprovedRole}
          preparedCandidates={preparedApplicationCandidates}
          saving={roleApplicationSaving}
          error={roleApplicationError}
          onSave={saveRoleApplication}
          onOpenCandidates={() => navigate("/recruiters?tab=candidates")}
        />

        <RoleIntelligencePanel
          intelligence={currentRoleIntelligence}
          fallback={{
            candidates: roleCandidates.length,
            submissions: roleSubmissions.length,
            pending: pendingCount,
            questions: currentRoleQuestions.length,
            feedback: currentRoleFeedback,
          }}
        />

        <RoleCalibrationBriefPanel brief={calibrationBrief} />

        <RoleSourcingKitPanel kit={sourcingKit} onOpenCandidates={() => navigate("/recruiters?tab=candidates")} />

        {submission && submission.ok && (
          <div className="rb-success">
            <strong>Candidate submitted.</strong> We&apos;ll review and update your tracker.
            {submission.score && (
              <div style={{ marginTop: 6, color: "#1a1a1a" }}>
                Score: Hard {submission.score.hardChecked}/{submission.score.hardTotal}{" "}
                · Fit {submission.score.fitChecked}/{submission.score.fitTotal}{" "}
                · Bonus {submission.score.bonusChecked}/{submission.score.bonusTotal}{" "}
                · Anti {submission.score.antiChecked}/{submission.score.antiTotal}
              </div>
            )}
            {submission.submissionMode && (
              <div style={{ marginTop: 6, color: "#1a1a1a" }}>
                Submission mode: {submission.submissionMode === "primary_role" ? "Approved role" : "Single submission"}
              </div>
            )}
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button className="rb-btn" onClick={submitAnother}>Submit another for this role</button>
              <button className="rb-btn" onClick={() => navigate("/recruiters?tab=submissions")}>Track status</button>
            </div>
          </div>
        )}

        {trackerError && <div className="rb-error">Could not load role tracker: {trackerError}</div>}

        <div className="rb-role-dashboard">
          <section className="rb-role-main">
            <div className="rb-jd">
              {job.compSummary && <div className="rb-comp"><strong>Comp:</strong> {job.compSummary}</div>}
              {job.jdBlocks.map((block, i) => (
                <section className="block" key={i}>
                  <h3>{block.heading}</h3>
                  {renderMarkdown(block.body)}
                </section>
              ))}
              {job.recruiterBoard.interviewProcess && (
                <section className="block">
                  <h3>Interview process</h3>
                  <p>{job.recruiterBoard.interviewProcess}</p>
                </section>
              )}
            </div>

            <div className="rb-culture">
              <h3>Culture &amp; what they're building</h3>
              <p><strong>The bet:</strong> {job.recruiterBoard.culture.bet}</p>
              <ul>
                {job.recruiterBoard.culture.bullets.map((b, i) => (
                  <li key={i}>{renderInline(b)}</li>
                ))}
              </ul>
            </div>

            <div className="rb-banner">
              <strong>{approvedForRole ? "Approved role lane: submit qualified candidates with proof." : "Single-submit lane: use this only for exceptional candidate-led opportunities."}</strong>
              <span className="small">
                Use the role queue to prefill a sourced candidate, tick every verified requirement, then submit.
                The role allows up to {ROLE_PENDING_SUBMISSION_LIMIT} pending submissions before waiting for feedback.
              </span>
              <span className="chip">{approvedForRole ? "Approved access" : "Single-submit credit"}</span>
              <span className="chip">{pendingSlots} pending slots open</span>
            </div>

            <CandidateOwnershipGuardPanel
              state={identityCheck}
              candidateEmail={form.candidateEmail}
              candidateLink={form.candidateLink}
              onOpenCandidates={() => navigate("/recruiters?tab=candidates")}
              onOpenSubmissions={() => navigate("/recruiters?tab=submissions")}
            />

            <SubmissionPacketPanel packet={submissionPacket} />

            <form id="submit-candidate" className="rb-form-section rb-form" onSubmit={onSubmit}>
              <h3 className="section-title">Your contact (for follow-up)</h3>
              <p className="rb-form-note">Submitting as {session.recruiter.email}. WeKruit status updates will appear in your recruiter tracker.</p>
              {selectedCandidate && (
                <p className="rb-form-note rb-form-note--active">
                  Prefilled from your sourced candidate queue: {selectedCandidate.candidate?.name || "Candidate"}.
                </p>
              )}
              <div className="field">
                <label>Your name *</label>
                <input
                  type="text"
                  required
                  value={form.submitterName}
                  onChange={(e) => setForm({ ...form, submitterName: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Your email *</label>
                <input
                  type="email"
                  required
                  value={form.submitterEmail}
                  onChange={(e) => setForm({ ...form, submitterEmail: e.target.value })}
                />
              </div>

          <h3 className="section-title" style={{ marginTop: 24 }}>Candidate</h3>
          <div className="field">
            <label>Candidate name *</label>
            <input
              type="text"
              required
              value={form.candidateName}
              onChange={(e) => setForm({ ...form, candidateName: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Candidate email *</label>
            <input
              type="email"
              required
              placeholder="candidate@company.com"
              value={form.candidateEmail}
              onChange={(e) => setForm({ ...form, candidateEmail: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Resume / LinkedIn *</label>
            <input
              type="text"
              required
              placeholder="https://linkedin.com/in/…"
              value={form.candidateLink}
              onChange={(e) => setForm({ ...form, candidateLink: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Current role</label>
            <input
              type="text"
              value={form.candidateCurrentRole}
              onChange={(e) => setForm({ ...form, candidateCurrentRole: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Years of experience</label>
            <input
              type="text"
              value={form.candidateYoe}
              onChange={(e) => setForm({ ...form, candidateYoe: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Notes for us</label>
            <textarea
              value={form.candidateNotes}
              onChange={(e) => setForm({ ...form, candidateNotes: e.target.value })}
            />
          </div>
          <label className="rb-consent">
            <input
              type="checkbox"
              required
              checked={form.candidateConsent}
              onChange={(e) => setForm({ ...form, candidateConsent: e.target.checked })}
            />
            <span>I confirm this candidate gave consent to be submitted to WeKruit for this role. WeKruit will email them to confirm interest.</span>
          </label>

          <h3 className="section-title" style={{ marginTop: 24 }}>Fit checklist</h3>
          {groups.map((group) => (
            <div className={`rb-group ${group.kind}`} key={group.kind}>
              <h4>
                {group.heading}
                <span className="count">
                  {checkedCounts[group.kind]} / {group.items.length}
                </span>
              </h4>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!form.checklist[item.id]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            checklist: { ...form.checklist, [item.id]: e.target.checked },
                          })
                        }
                      />
                      <span className="item-text">{item.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {submitError && <div className="rb-error">Submission failed: {submitError}</div>}

          <div className="rb-actions">
            <button type="submit" className="rb-btn primary" disabled={submitting || packetBlocksSubmit}>
              {submitting ? "Submitting…" : identityCheck.status === "checking" ? "Checking candidate..." : submissionPacket.submitLabel}
            </button>
            <button type="button" className="rb-btn" onClick={resetChecklist} disabled={submitting}>
              Reset checklist
            </button>
            <div className="rb-progress">
              <strong>{totalChecked}</strong> of {totalItems} boxes checked
            </div>
          </div>
        </form>
          </section>

          <aside className="rb-role-side">
            <section className="rb-side-panel">
              <h3>Candidate queue</h3>
              <p>Prospects saved in your CRM for this role. Use one to prefill the submit form.</p>
              <div className="rb-role-candidate-list">
                {roleCandidates.slice(0, 8).map((candidate) => (
                  <article key={candidate.id}>
                    <span>
                      <strong>{candidate.candidate?.name || "Candidate"}</strong>
                      <em>{candidate.candidate?.currentRole || sourcedStageLabel(candidate.stage)}</em>
                      {(candidate.calibrationStatus || candidate.calibrationNote) && (
                        <em>
                          {sourcedCalibrationLabel(candidate.calibrationStatus)}
                          {candidate.calibrationNote ? ` - ${candidate.calibrationNote}` : ""}
                        </em>
                      )}
                      {candidate.linkedSubmissionId && <em>Linked to submission {shortText(candidate.linkedSubmissionId, "submission", 18)}</em>}
                    </span>
                    <small>{sourcedStageLabel(candidate.stage)}</small>
                    <button type="button" className="rb-btn" onClick={() => useSourcedCandidate(candidate)}>
                      Use
                    </button>
                  </article>
                ))}
                {roleCandidates.length === 0 && <p className="rb-side-empty">No sourced candidates for this role yet.</p>}
              </div>
              <button type="button" className="rb-btn rb-btn--block" onClick={() => navigate("/recruiters?tab=candidates")}>
                Add sourced candidate
              </button>
            </section>

            <section className="rb-side-panel">
              <h3>Calibration</h3>
              <div className="rb-calibration-stack">
                {groups.filter((group) => group.kind === "hard" || group.kind === "anti").map((group) => (
                  <div key={group.kind}>
                    <strong>{group.heading}</strong>
                    <ul>
                      {group.items.slice(0, 4).map((item) => <li key={item.id}>{item.text}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            </section>

            <RoleFeedbackPanel
              job={job}
              feedback={currentRoleFeedback}
              onSaved={(saved) => {
                setRoleFeedback((rows) => [saved, ...rows.filter((row) => row.id !== saved.id)])
              }}
            />

            <RoleQuestionsPanel
              job={job}
              questions={currentRoleQuestions}
              feedback={currentRoleFeedback}
              intelligence={currentRoleIntelligence}
              onCreated={(question) => {
                setRoleQuestions((rows) => [question, ...rows.filter((row) => row.id !== question.id)])
              }}
            />

            <section className="rb-side-panel">
              <h3>My submissions</h3>
              <div className="rb-role-submission-list">
                {roleSubmissions.slice(0, 6).map((row) => {
                  const canResendConfirmation = roleCandidateConfirmationCanResend(row)
                  return (
                    <article key={row.id}>
                      <span>
                        <strong>{row.candidate?.name || "Candidate"}</strong>
                        <em>{roleSubmissionStatusLabel(row.status)}</em>
                        <em>{roleSubmissionConsentLabel(row)}</em>
                        {row.sourcedCandidateId && <em>From CRM candidate {shortText(row.sourcedCandidateId, "candidate", 18)}</em>}
                        <em>{roleSubmissionNextAction(row.status)}</em>
                        {canResendConfirmation && <em className="rb-role-submission-note">{roleCandidateConfirmationBody(row)}</em>}
                        {row.recruiterFeedbackNote && <em className="rb-role-submission-note">{row.recruiterFeedbackNote}</em>}
                      </span>
                      <aside>
                        <small>{roleSubmissionLastActivity(row)}</small>
                        {canResendConfirmation && (
                          <button
                            type="button"
                            onClick={() => void resendCandidateConfirmation(row)}
                            disabled={resendingConfirmationId === row.id}
                          >
                            {resendingConfirmationId === row.id ? "Sending..." : "Resend"}
                          </button>
                        )}
                      </aside>
                    </article>
                  )
                })}
                {roleSubmissions.length === 0 && <p className="rb-side-empty">No submitted candidates yet.</p>}
              </div>
              {confirmationError && <p className="rb-error">Candidate confirmation failed: {confirmationError}</p>}
            </section>
          </aside>
        </div>
      </main>
    </div>
  )
}

function candidateIdentityConflictCopy(reason?: string): { title: string; body: string; action: "candidates" | "submissions" } {
  if (reason === "candidate_already_submitted_for_role") {
    return {
      title: "Already submitted for this role",
      body: "This candidate is already in the submission tracker. Open the existing receipt instead of creating a duplicate packet.",
      action: "submissions",
    }
  }
  if (reason === "candidate_already_sourced_for_role") {
    return {
      title: "Already owned in another recruiter lane",
      body: "Another recruiter already has this candidate sourced for the role. Do not continue without WeKruit calibration.",
      action: "candidates",
    }
  }
  return {
    title: "Candidate ownership conflict",
    body: "This candidate cannot be submitted as a new packet for this role.",
    action: "submissions",
  }
}

function CandidateOwnershipGuardPanel({
  state,
  candidateEmail,
  candidateLink,
  onOpenCandidates,
  onOpenSubmissions,
}: {
  state: CandidateIdentityCheckState
  candidateEmail: string
  candidateLink: string
  onOpenCandidates: () => void
  onOpenSubmissions: () => void
}) {
  const hasLink = candidateLink.trim().length > 0
  const hasEmail = candidateEmail.trim().length > 0
  if (state.status === "conflict") {
    const copy = candidateIdentityConflictCopy(state.result?.conflict?.reason)
    return (
      <section className="rb-ownership-guard is-blocked" aria-label="Candidate ownership check">
        <div>
          <span>Candidate ownership</span>
          <strong>{copy.title}</strong>
          <p>{copy.body}</p>
        </div>
        <button type="button" className="rb-btn" onClick={copy.action === "submissions" ? onOpenSubmissions : onOpenCandidates}>
          {copy.action === "submissions" ? "Open tracker" : "Open candidates"}
        </button>
      </section>
    )
  }

  if (state.status === "checking") {
    return (
      <section className="rb-ownership-guard is-watch" aria-label="Candidate ownership check">
        <div>
          <span>Candidate ownership</span>
          <strong>Checking candidate lane...</strong>
          <p>We are checking this email and profile link against existing sourced candidates and submissions for the role.</p>
        </div>
      </section>
    )
  }

  if (state.status === "clear") {
    return (
      <section className="rb-ownership-guard is-good" aria-label="Candidate ownership check">
        <div>
          <span>Candidate ownership</span>
          <strong>No role duplicate found</strong>
          <p>This candidate can move forward as a new packet. Candidate consent is still required before WeKruit review.</p>
        </div>
      </section>
    )
  }

  if (state.status === "error") {
    return (
      <section className="rb-ownership-guard is-watch" aria-label="Candidate ownership check">
        <div>
          <span>Candidate ownership</span>
          <strong>Preflight check unavailable</strong>
          <p>{state.error || "The submit API still blocks duplicate ownership if this packet conflicts."}</p>
        </div>
      </section>
    )
  }

  return (
    <section className="rb-ownership-guard is-quiet" aria-label="Candidate ownership check">
      <div>
        <span>Candidate ownership</span>
        <strong>Add candidate identity to verify the lane</strong>
        <p>{hasLink || hasEmail ? "Finish the candidate email and profile link to check for duplicate ownership." : "Enter a candidate email and LinkedIn or resume link before submitting."}</p>
      </div>
    </section>
  )
}

function RoleWorkroomPanel({
  model,
  candidates,
  onAction,
}: {
  model: RoleWorkroomModel
  candidates: RoleCandidateRecommendation[]
  onAction: (action: RoleWorkroomAction, candidate?: RecruiterSourcedCandidateItem) => void
}) {
  const visibleCandidates = candidates.slice(0, 4)
  return (
    <section className={`rb-role-workroom is-${model.tone}`} aria-label="Role workroom">
      <div className="rb-role-workroom__mission">
        <span>{model.label}</span>
        <strong>{model.title}</strong>
        <p>{model.body}</p>
        <button
          type="button"
          className="rb-btn primary"
          onClick={() => onAction(model.action, model.actionCandidate)}
        >
          {model.actionLabel}
        </button>
      </div>

      <div className="rb-role-workroom__cards">
        {model.cards.map((card) => (
          <button
            type="button"
            key={card.label}
            className={`is-${card.tone}`}
            onClick={() => onAction(card.action, card.action === "candidate" ? model.actionCandidate ?? candidates[0]?.candidate : undefined)}
          >
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <em>{card.body}</em>
          </button>
        ))}
      </div>

      <div className="rb-role-workroom__bench">
        <header>
          <span>Best candidates to work now</span>
          <strong>{visibleCandidates.length ? `${visibleCandidates.length} ranked` : "No candidate signal yet"}</strong>
        </header>
        <div>
          {visibleCandidates.map((item) => (
            <article key={item.candidate.id} className={`is-${item.tone}`}>
              <div>
                <span>{item.label}</span>
                <strong>{candidateDisplayName(item.candidate)}</strong>
                <p>{candidateHeadline(item.candidate)}</p>
                <em>{item.reasons.join(" · ")}</em>
              </div>
              <aside>
                <b>{item.score}%</b>
                <button type="button" onClick={() => onAction("candidate", item.candidate)}>Use</button>
              </aside>
            </article>
          ))}
          {visibleCandidates.length === 0 && (
            <article className="is-quiet">
              <div>
                <span>Shortlist empty</span>
                <strong>Save candidates before submitting</strong>
                <p>Use Candidate CRM or the sourcing kit to create role-specific proof.</p>
                <em>No private bench or role candidates are available for this role.</em>
              </div>
              <aside>
                <b>0%</b>
                <button type="button" onClick={() => onAction("candidates")}>Add</button>
              </aside>
            </article>
          )}
        </div>
      </div>
    </section>
  )
}

function RoleDealDeskPanel({
  model,
  onAction,
}: {
  model: RoleDealDeskModel
  onAction: (action: RoleWorkroomAction, candidate?: RecruiterSourcedCandidateItem) => void
}) {
  return (
    <section className={`rb-role-deal-desk is-${model.tone}`} aria-label="Recruiting deal desk">
      <header>
        <div>
          <span>{model.mode}</span>
          <strong>{model.title}</strong>
          <p>{model.body}</p>
        </div>
        <button type="button" className="rb-btn primary" onClick={() => onAction(model.primaryAction, model.primaryCandidate)}>
          {model.primaryLabel}
        </button>
      </header>

      <div className="rb-role-deal-desk__grid">
        <article className="rb-role-deal-desk__lanes">
          <h3>Operating lanes</h3>
          <div>
            {model.lanes.map((lane) => (
              <button
                type="button"
                key={lane.label}
                className={`is-${lane.tone}`}
                onClick={() => onAction(lane.action, lane.actionCandidate)}
              >
                <span>{lane.label}</span>
                <strong>{lane.value}</strong>
                <em>{lane.detail}</em>
              </button>
            ))}
          </div>
        </article>

        <article className="rb-role-deal-desk__proof">
          <h3>Proof to close</h3>
          <div>
            {model.proofPlan.map((item, index) => (
              <section key={`${item.label}-${index}`} className={`is-${item.tone}`}>
                <span>{item.label}</span>
                <p>{item.detail}</p>
              </section>
            ))}
          </div>
        </article>

        <article className="rb-role-deal-desk__risks">
          <h3>Risk and feedback</h3>
          <div>
            {model.risks.map((risk, index) => (
              <button
                type="button"
                key={`${risk.label}-${index}`}
                className={`is-${risk.tone}`}
                onClick={() => onAction(risk.action)}
              >
                <span>{risk.label}</span>
                <em>{risk.detail}</em>
              </button>
            ))}
          </div>
        </article>
      </div>
    </section>
  )
}

function RoleIntakeMemoPanel({
  memo,
  onAction,
}: {
  memo: RoleIntakeMemo
  onAction: (action: RoleWorkroomAction) => void
}) {
  return (
    <section className={`rb-role-intake is-${memo.tone}`} aria-label="Private role intake memo">
      <header>
        <div>
          <span>{memo.label}</span>
          <strong>{memo.title}</strong>
          <p>{memo.body}</p>
        </div>
        <button type="button" className="rb-btn primary" onClick={() => onAction(memo.action)}>
          {memo.actionLabel}
        </button>
      </header>

      <div className="rb-role-intake__facts">
        {memo.facts.map((fact) => (
          <button type="button" className={`is-${fact.tone}`} key={fact.label} onClick={() => onAction(fact.action)}>
            <span>{fact.label}</span>
            <strong>{fact.value}</strong>
            <em>{fact.detail}</em>
          </button>
        ))}
      </div>

      <div className="rb-role-intake__body">
        <article className="rb-role-intake__talk">
          <h3>Recruiter talk track</h3>
          <ol>
            {memo.talkTrack.map((line) => <li key={line}>{line}</li>)}
          </ol>
        </article>

        <article className="rb-role-intake__assumptions">
          <h3>Open assumptions</h3>
          <div>
            {memo.assumptions.map((item) => (
              <button type="button" className={`is-${item.tone}`} key={item.label} onClick={() => onAction(item.action)}>
                <span>{item.label}</span>
                <em>{item.detail}</em>
              </button>
            ))}
          </div>
        </article>
      </div>
    </section>
  )
}

function RoleRewardCenterPanel({
  center,
  onAction,
}: {
  center: RoleRewardCenter
  onAction: (action: RoleWorkroomAction) => void
}) {
  return (
    <section className={`rb-role-reward-center is-${center.tone}`} aria-label="Role reward center">
      <header>
        <div>
          <span>Role reward center</span>
          <strong>{center.title}</strong>
          <p>{center.body}</p>
        </div>
        <button type="button" className="rb-btn primary" onClick={() => onAction(center.primaryAction)}>
          {center.primaryLabel}
        </button>
      </header>

      <div className="rb-role-reward-center__cards">
        {center.cards.map((card) => (
          <button type="button" key={card.label} className={`is-${card.tone}`} onClick={() => onAction(card.action)}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <em>{card.detail}</em>
          </button>
        ))}
      </div>

      <div className="rb-role-reward-center__steps">
        {center.steps.map((step, index) => (
          <button type="button" key={step.label} className={`is-${step.tone}`} onClick={() => onAction(step.action)}>
            <b>{index + 1}</b>
            <div>
              <strong>{step.label}</strong>
              <em>{step.detail}</em>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

function SubmissionPacketPanel({ packet }: { packet: RoleSubmissionPacket }) {
  return (
    <section className={`rb-submission-packet is-${packet.tone}`} aria-label="Submission packet readiness">
      <header>
        <div>
          <span>Submission packet</span>
          <strong>{packet.label}</strong>
          <p>{packet.summary}</p>
        </div>
        <div className="rb-submission-packet__score">
          <b>{packet.score}</b>
          <em>quality score</em>
        </div>
      </header>
      <div className="rb-submission-packet__gates" aria-label="Submission readiness gates">
        {packet.gates.map((gate) => (
          <article className={`is-${gate.tone}`} key={gate.label}>
            <span>{gate.label}</span>
            <strong>{gate.value}</strong>
            <p>{gate.detail}</p>
          </article>
        ))}
      </div>
      <div className="rb-submission-packet__grid">
        <article>
          <span>Next required move</span>
          <strong>{packet.nextAction}</strong>
        </article>
        <article>
          <span>Proof captured</span>
          {packet.proof.length ? (
            <ul>
              {packet.proof.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p>No candidate proof captured yet.</p>
          )}
        </article>
        <article>
          <span>Review risks</span>
          {packet.blockers.length || packet.warnings.length ? (
            <ul>
              {[...packet.blockers, ...packet.warnings].slice(0, 6).map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p>No major review risks detected.</p>
          )}
        </article>
      </div>
      {(packet.missingHard.length > 0 || packet.antiFlags.length > 0) && (
        <div className="rb-submission-packet__checks">
          {packet.missingHard.length > 0 && (
            <div>
              <strong>Missing hard proof</strong>
              {packet.missingHard.map((item) => <span key={item}>{item}</span>)}
            </div>
          )}
          {packet.antiFlags.length > 0 && (
            <div>
              <strong>Anti-signal context needed</strong>
              {packet.antiFlags.map((item) => <span key={item}>{item}</span>)}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function RoleAccessPanel({
  job,
  application,
  approvedByLegacySlot,
  preparedCandidates,
  saving,
  error,
  onSave,
  onOpenCandidates,
}: {
  job: CollabJob
  application: RecruiterRoleApplicationItem | null
  approvedByLegacySlot: boolean
  preparedCandidates: RecruiterSourcedCandidateItem[]
  saving: boolean
  error: string | null
  onSave: (input: RecruiterRoleApplicationInput) => Promise<void>
  onOpenCandidates: () => void
}) {
  const applicationStatus = approvedByLegacySlot ? "approved" : application?.status
  const tone = roleApplicationStatusTone(applicationStatus)
  const [composerOpen, setComposerOpen] = useState(false)
  const [pitch, setPitch] = useState("")
  const [anonymizeCandidates, setAnonymizeCandidates] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    setComposerOpen(false)
    setPitch("")
    setAnonymizeCandidates(false)
    setLocalError(null)
  }, [job.jobId, application?.id, application?.status])

  const preparedCandidateIds = preparedCandidates.map((candidate) => candidate.id)
  const canWithdraw = application?.status === "pending" && !approvedByLegacySlot
  const canApply = !approvedByLegacySlot && applicationStatus !== "approved" && applicationStatus !== "pending"
  const lastTouched = application ? roleQuestionTime(application.updatedAt ?? application.createdAt) : "Not requested"
  const headline = applicationStatus === "approved"
    ? "You can work this role as an approved recruiter."
    : applicationStatus === "pending"
      ? "WeKruit is reviewing your role access request."
      : applicationStatus === "not_approved"
        ? "This request was not approved. Reapply only with stronger proof."
        : applicationStatus === "rescinded"
          ? "Access was rescinded. Reapply after the role lane is fixed."
          : "Apply for trusted access before treating this as an approved role."

  const openComposer = () => {
    setComposerOpen(true)
    setLocalError(null)
    if (!pitch.trim()) {
      setPitch(preparedCandidates.length
        ? `I have ${preparedCandidates.length} prepared candidate${preparedCandidates.length === 1 ? "" : "s"} for this role and can actively source against the hard checks.`
        : "")
    }
  }

  const submitApplication = async () => {
    const trimmed = pitch.trim()
    if (trimmed.length < 20) {
      setLocalError("Add a specific pitch before applying.")
      return
    }
    setLocalError(null)
    try {
      await onSave({
        jobId: job.jobId,
        action: "apply",
        pitch: trimmed,
        anonymizeCandidates,
        preparedCandidateIds,
      })
      setComposerOpen(false)
      setPitch("")
      setAnonymizeCandidates(false)
    } catch {
      // Parent state renders the backend error.
    }
  }

  const withdrawApplication = async () => {
    try {
      await onSave({ jobId: job.jobId, action: "withdraw" })
    } catch {
      // Parent state renders the backend error.
    }
  }

  return (
    <section className={`rb-role-access-panel is-${tone}`} aria-label="Role access state">
      <header>
        <div>
          <span>Role access</span>
          <strong>{roleApplicationStatusLabel(applicationStatus)}</strong>
          <p>{headline}</p>
        </div>
        <div className="rb-role-access-panel__actions">
          {canWithdraw && (
            <button type="button" className="rb-btn" disabled={saving} onClick={() => void withdrawApplication()}>
              {saving ? "Withdrawing..." : "Withdraw request"}
            </button>
          )}
          {canApply && (
            <button type="button" className="rb-btn primary" disabled={saving} onClick={openComposer}>
              {application?.status === "not_approved" || application?.status === "rescinded" ? "Reapply" : "Apply to recruit"}
            </button>
          )}
          <button type="button" className="rb-btn" onClick={onOpenCandidates}>Candidate CRM</button>
        </div>
      </header>

      <div className="rb-role-access-panel__facts">
        <article>
          <span>Prepared proof</span>
          <strong>{preparedCandidates.length}</strong>
          <em>{preparedCandidates.length ? "Attached when you apply" : "Save candidates first"}</em>
        </article>
        <article>
          <span>Submission lane</span>
          <strong>{applicationStatus === "approved" ? "Approved role" : "Single-submit"}</strong>
          <em>{applicationStatus === "approved" ? "Expected active coverage" : "Candidate-led only"}</em>
        </article>
        <article>
          <span>Last decision</span>
          <strong>{lastTouched}</strong>
          <em>{application?.adminNote || application?.reviewedByEmail || "No admin note"}</em>
        </article>
      </div>

      {composerOpen && (
        <article className="rb-role-application-composer">
          <header>
            <span>Apply to recruit</span>
            <strong>{job.title}</strong>
            <button type="button" onClick={() => setComposerOpen(false)}>Cancel</button>
          </header>
          <p>Share why WeKruit should trust you with this search. Prepared candidates from your CRM are attached automatically.</p>
          <textarea
            value={pitch}
            onChange={(event) => setPitch(event.target.value)}
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
            <span>{preparedCandidates.length} prepared candidate{preparedCandidates.length === 1 ? "" : "s"} attached</span>
            <button
              type="button"
              disabled={saving || pitch.trim().length < 20}
              onClick={() => void submitApplication()}
            >
              {saving ? "Submitting..." : "Submit application"}
            </button>
          </div>
        </article>
      )}

      {(localError || error) && <p className="rb-error">{localError || error}</p>}
    </section>
  )
}

function roleFeedbackDifficultyLabel(difficulty?: RecruiterRoleFeedbackDifficulty): string {
  return ROLE_FEEDBACK_DIFFICULTIES.find((item) => item.id === difficulty)?.label ?? "Not shared"
}

function roleFeedbackReasonLabel(reason: RecruiterRoleFeedbackReason): string {
  return ROLE_FEEDBACK_REASONS.find((item) => item.id === reason)?.label ?? reason
}

function roleIntelligenceActivityLabel(iso: string | null | undefined): string {
  if (!iso) return "No activity yet"
  const ms = Date.parse(iso)
  if (!ms) return "No activity yet"
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function roleIntelligenceDiagnosis(
  intelligence: RecruiterRoleIntelligenceItem | null,
  feedback: RecruiterRoleFeedbackItem | null,
): { label: string; detail: string; tone: "good" | "watch" | "blocked" | "quiet" } {
  if (intelligence?.feedback.blocked) {
    return { label: "Blocked market", detail: "Recruiters are reporting a hard stop.", tone: "blocked" }
  }
  if (intelligence && intelligence.feedback.hard > intelligence.feedback.easy) {
    return { label: "Hard search", detail: "Tighten calibration before adding volume.", tone: "watch" }
  }
  if (feedback?.difficulty === "blocked") {
    return { label: "You marked blocked", detail: "This role needs WeKruit calibration.", tone: "blocked" }
  }
  if (feedback?.difficulty === "hard") {
    return { label: "You marked hard", detail: "Your market signal says this needs focus.", tone: "watch" }
  }
  if (intelligence && (intelligence.readyCount > 0 || intelligence.advancedCount > 0)) {
    return { label: "Market moving", detail: "Candidate signal is reaching the queue.", tone: "good" }
  }
  return { label: "Signal forming", detail: "Early role data; source carefully.", tone: "quiet" }
}

function RoleIntelligencePanel({
  intelligence,
  fallback,
}: {
  intelligence: RecruiterRoleIntelligenceItem | null
  fallback: {
    candidates: number
    submissions: number
    pending: number
    questions: number
    feedback: RecruiterRoleFeedbackItem | null
  }
}) {
  const diagnosis = roleIntelligenceDiagnosis(intelligence, fallback.feedback)
  const topReasons = intelligence?.feedback.topReasons.length
    ? intelligence.feedback.topReasons
    : (fallback.feedback?.reasons ?? []).map((reason) => ({ reason, count: 1 }))
  const sourced = intelligence?.sourcedCount ?? fallback.candidates
  const ready = intelligence?.readyCount ?? 0
  const submissions = intelligence?.submissionCount ?? fallback.submissions
  const pending = intelligence?.pendingCount ?? fallback.pending
  const recruiters = intelligence?.recruiterCount ?? 1
  const openQuestions = intelligence?.openQuestionCount ?? fallback.questions
  const answeredQuestions = intelligence?.answeredQuestionCount ?? 0
  const feedbackTotal = intelligence?.feedback.total ?? (fallback.feedback ? 1 : 0)
  const activity = intelligence ? roleIntelligenceActivityLabel(intelligence.lastActivityAt) : "Self data only"
  const pipelinePreview = intelligence?.pipelinePreview ?? []

  return (
    <section className={`rb-role-intel is-${diagnosis.tone}`} aria-label="Role intelligence">
      <div className="rb-role-intel__lead">
        <span>Role intelligence</span>
        <strong>{diagnosis.label}</strong>
        <em>{diagnosis.detail}</em>
      </div>
      <div className="rb-role-intel__metrics">
        <div>
          <span>Recruiters active</span>
          <strong>{recruiters}</strong>
          <em>{activity}</em>
        </div>
        <div>
          <span>Sourced / ready</span>
          <strong>{sourced} / {ready}</strong>
          <em>{submissions} submitted, {pending} pending.</em>
        </div>
        <div>
          <span>Calibration</span>
          <strong>{feedbackTotal} signal{feedbackTotal === 1 ? "" : "s"}</strong>
          <em>{openQuestions} open Q, {answeredQuestions} answered.</em>
        </div>
      </div>
      <div className="rb-role-intel__reasons">
        {topReasons.length ? (
          topReasons.slice(0, 4).map((item) => (
            <span key={item.reason}>{roleFeedbackReasonLabel(item.reason)}{item.count > 1 ? ` ×${item.count}` : ""}</span>
          ))
        ) : (
          <span>No blocker reason yet</span>
        )}
      </div>
      {pipelinePreview.length > 0 && (
        <div className="rb-role-intel__pipeline-preview">
          <header>
            <div>
              <span>Candidate pipeline preview</span>
              <strong>{pipelinePreview.length} latest signal{pipelinePreview.length === 1 ? "" : "s"}</strong>
            </div>
            <em>Identity stays hidden for market candidates.</em>
          </header>
          <div>
            {pipelinePreview.map((row) => (
              <article key={row.id}>
                <div>
                  <strong>{row.candidateLabel}</strong>
                  <p>{row.candidateHeadline ?? "No background shared yet."}</p>
                  {row.candidateSignal && <em>{row.candidateSignal}</em>}
                </div>
                <aside>
                  <span>{row.recruiterScope === "mine" ? "Your candidate" : row.anonymized ? "Anonymized market" : "Market background"}</span>
                  <b>{row.status ?? row.stage}</b>
                  <small>{roleIntelligenceActivityLabel(row.updatedAt)}</small>
                </aside>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function RoleCalibrationBriefPanel({ brief }: { brief: RoleCalibrationBrief }) {
  return (
    <section className={`rb-calibration-brief is-${brief.tone}`} aria-label="Role calibration brief">
      <header>
        <div>
          <span>Role calibration brief</span>
          <strong>{brief.headline}</strong>
          <p>{brief.body}</p>
        </div>
        <aside>
          <span>Next move</span>
          <strong>{brief.nextMove}</strong>
        </aside>
      </header>

      <div className="rb-calibration-brief__facts">
        {brief.marketFacts.map((fact) => (
          <article key={fact.label}>
            <span>{fact.label}</span>
            <strong>{fact.value}</strong>
            <em>{fact.detail}</em>
          </article>
        ))}
      </div>

      <div className="rb-calibration-brief__body">
        <article className="rb-calibration-brief__pipeline">
          <h3>Anonymized pipeline</h3>
          <div>
            {brief.pipeline.map((row) => {
              const width = row.total > 0 ? Math.max(4, Math.round((row.count / row.total) * 100)) : 0
              return (
                <label key={row.label} className={`is-${row.tone}`}>
                  <span>{row.label}</span>
                  <b>{row.count}</b>
                  <i><em style={{ width: `${width}%` }} /></i>
                </label>
              )
            })}
          </div>
        </article>

        <article className="rb-calibration-brief__reasons">
          <h3>Common rejection reasons</h3>
          {brief.rejectionReasons.length ? (
            <div>
              {brief.rejectionReasons.map((reason, index) => (
                <section key={`${reason.label}-${index}`}>
                  <strong>{reason.label}{reason.count > 1 ? ` ×${reason.count}` : ""}</strong>
                  <p>{shortText(reason.detail, "Market feedback", 120)}</p>
                </section>
              ))}
            </div>
          ) : (
            <p>No rejection pattern yet. First submissions should lean on hard-check proof.</p>
          )}
        </article>

        <article className="rb-calibration-brief__guardrails">
          <h3>Search guardrails</h3>
          <div>
            <section>
              <span>Prove</span>
              {brief.guardrails.prove.length ? brief.guardrails.prove.map((item) => <p key={item}>{item}</p>) : <p>Role hard checks are light.</p>}
            </section>
            <section>
              <span>Avoid</span>
              {brief.guardrails.avoid.length ? brief.guardrails.avoid.map((item) => <p key={item}>{item}</p>) : <p>No explicit anti-signal listed.</p>}
            </section>
            <section>
              <span>Calibrate</span>
              {brief.guardrails.calibrate.length ? brief.guardrails.calibrate.map((item) => <p key={item}>{shortText(item, item, 120)}</p>) : <p>No open calibration note.</p>}
            </section>
          </div>
        </article>
      </div>
    </section>
  )
}

function RoleSourcingKitPanel({
  kit,
  onOpenCandidates,
}: {
  kit: RoleSourcingKit
  onOpenCandidates: () => void
}) {
  const [copied, setCopied] = useState<string | null>(null)

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

  return (
    <section className="rb-sourcing-kit" aria-label="Recruiter sourcing kit">
      <header>
        <div>
          <span>Sourcing kit</span>
          <strong>Search, screen, and submit with proof</strong>
          <p>Use these assets to build a shortlist before spending a single-submit credit or asking for trusted role access.</p>
        </div>
        <button type="button" className="rb-btn" onClick={onOpenCandidates}>Open candidate CRM</button>
      </header>

      <div className="rb-sourcing-kit__grid">
        <article className="rb-sourcing-kit__search">
          <h3>Search strings</h3>
          {kit.searchStrings.map((search) => (
            <section key={search.label}>
              <div>
                <span>{search.label}</span>
                <button type="button" onClick={() => void copyText(search.label, search.value)}>
                  {copied === search.label ? "Copied" : "Copy"}
                </button>
              </div>
              <code>{search.value}</code>
              <p>{search.detail}</p>
            </section>
          ))}
        </article>

        <article className="rb-sourcing-kit__outreach">
          <h3>Outreach copy</h3>
          <div>
            <span>Subject</span>
            <strong>{kit.outreach.subject}</strong>
          </div>
          <pre>{kit.outreach.body}</pre>
          <button type="button" onClick={() => void copyText("Outreach", `${kit.outreach.subject}\n\n${kit.outreach.body}`)}>
            {copied === "Outreach" ? "Copied outreach" : "Copy outreach"}
          </button>
        </article>

        <article>
          <h3>Target signals</h3>
          <ul>
            {kit.targetSignals.slice(0, 7).map((signal) => <li key={signal}>{signal}</li>)}
          </ul>
        </article>

        <article>
          <h3>Screening questions</h3>
          <ol>
            {kit.screenQuestions.map((question) => <li key={question}>{question}</li>)}
          </ol>
        </article>

        <article>
          <h3>Submission proof plan</h3>
          <ul>
            {kit.proofPlan.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </article>

        <article className="rb-sourcing-kit__anti">
          <h3>Do not pitch</h3>
          <ul>
            {kit.doNotPitch.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </article>
      </div>

      {copied && <p className="rb-sourcing-kit__copied" aria-live="polite">{copied}</p>}
    </section>
  )
}

function RoleFeedbackPanel({
  job,
  feedback,
  onSaved,
}: {
  job: CollabJob
  feedback: RecruiterRoleFeedbackItem | null
  onSaved: (feedback: RecruiterRoleFeedbackItem) => void
}) {
  const [difficulty, setDifficulty] = useState<RecruiterRoleFeedbackDifficulty>(feedback?.difficulty ?? "medium")
  const [reasons, setReasons] = useState<RecruiterRoleFeedbackReason[]>(feedback?.reasons ?? [])
  const [note, setNote] = useState(feedback?.note ?? "")
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setDifficulty(feedback?.difficulty ?? "medium")
    setReasons(feedback?.reasons ?? [])
    setNote(feedback?.note ?? "")
    setSavedAt(null)
    setErr(null)
  }, [feedback?.id])

  const toggleReason = (reason: RecruiterRoleFeedbackReason) => {
    setReasons((current) => current.includes(reason)
      ? current.filter((item) => item !== reason)
      : [...current, reason].slice(0, 6))
  }

  const save = async () => {
    setSaving(true)
    setErr(null)
    try {
      const saved = await saveRecruiterRoleFeedback({
        jobId: job.jobId,
        difficulty,
        reasons,
        note: note.trim() || undefined,
      })
      onSaved(saved)
      setSavedAt(new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rb-side-panel rb-role-feedback">
      <h3>Role feedback</h3>
      <p>Share market signal before the search drifts.</p>
      <div className="rb-feedback-difficulty" role="radiogroup" aria-label="Role difficulty">
        {ROLE_FEEDBACK_DIFFICULTIES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={difficulty === item.id ? "is-active" : ""}
            onClick={() => setDifficulty(item.id)}
          >
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </button>
        ))}
      </div>
      <div className="rb-feedback-reasons" aria-label="Role feedback reasons">
        {ROLE_FEEDBACK_REASONS.map((reason) => (
          <button
            key={reason.id}
            type="button"
            className={reasons.includes(reason.id) ? "is-active" : ""}
            onClick={() => toggleReason(reason.id)}
          >
            {reason.label}
          </button>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Comp signal, market objection, missing calibration, or why this role is blocked..."
        rows={4}
      />
      <div className="rb-role-feedback__footer">
        <span>{feedback ? `${roleFeedbackDifficultyLabel(feedback.difficulty)} last saved` : "No role feedback yet"}</span>
        <button type="button" className="rb-btn" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving..." : "Save feedback"}
        </button>
      </div>
      {savedAt && <p className="rb-form-note rb-form-note--active">Saved at {savedAt}.</p>}
      {err && <p className="rb-error">{err}</p>}
    </section>
  )
}

function roleQuestionTime(raw: unknown): string {
  const ms = timestampMs(raw)
  return ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Just now"
}

function RoleQuestionsPanel({
  job,
  questions,
  feedback,
  intelligence,
  onCreated,
}: {
  job: CollabJob
  questions: RecruiterRoleQuestionItem[]
  feedback: RecruiterRoleFeedbackItem | null
  intelligence: RecruiterRoleIntelligenceItem | null
  onCreated: (question: RecruiterRoleQuestionItem) => void
}) {
  const [question, setQuestion] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const openQuestions = questions.filter((item) => (item.status ?? "open") === "open")
  const answeredQuestions = questions.filter((item) => item.status === "answered")
  const prompts = useMemo(
    () => buildRoleQuestionPrompts(job, questions, feedback, intelligence),
    [feedback, intelligence, job, questions],
  )
  const oldestOpen = [...openQuestions].sort((a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt))[0]
  const latestAnswer = answeredQuestions[0]
  const cockpitTone = openQuestions.length
    ? "watch"
    : answeredQuestions.length
      ? "good"
      : prompts.length
        ? "quiet"
        : "good"
  const cockpitTitle = openQuestions.length
    ? `${openQuestions.length} open answer${openQuestions.length === 1 ? "" : "s"}`
    : latestAnswer
      ? "Use latest answer before sourcing"
      : prompts.length
        ? "Ask before sourcing through ambiguity"
        : "No question pressure"
  const cockpitBody = openQuestions.length
    ? `Oldest question opened ${roleQuestionTime(oldestOpen?.createdAt)}. Wait for answer before adding volume if this blocks proof.`
    : latestAnswer?.answer
      ? shortText(latestAnswer.answer, "WeKruit answered the latest calibration question.", 132)
      : prompts.length
        ? "Pick one suggested question, edit it, then send it to WeKruit for role-specific calibration."
        : "The current role signal is clear enough to keep sourcing from the brief and guardrails."

  const createQuestion = async () => {
    const trimmed = question.trim()
    if (trimmed.length < 8) {
      setErr("Ask a specific role question.")
      return
    }
    setSubmitting(true)
    setErr(null)
    try {
      const saved = await createRecruiterRoleQuestion({
        jobId: job.jobId,
        question: trimmed,
      })
      onCreated(saved)
      setQuestion("")
      setSavedAt(new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="rb-side-panel rb-role-questions">
      <h3>Questions for WeKruit</h3>
      <p>Ask role-specific calibration questions before spending sourcing cycles.</p>
      <div className={`rb-role-question-cockpit is-${cockpitTone}`}>
        <span>Calibration cockpit</span>
        <strong>{cockpitTitle}</strong>
        <p>{cockpitBody}</p>
        <div>
          <em>{openQuestions.length} open</em>
          <em>{answeredQuestions.length} answered</em>
          <em>{prompts.length} suggested</em>
        </div>
      </div>

      {prompts.length > 0 && (
        <div className="rb-role-question-prompts">
          <span>Suggested asks</span>
          {prompts.map((prompt) => (
            <button
              type="button"
              className={`is-${prompt.tone}`}
              key={prompt.id}
              onClick={() => setQuestion(prompt.question)}
            >
              <strong>{prompt.label}</strong>
              <small>{prompt.body}</small>
            </button>
          ))}
        </div>
      )}

      <div className="rb-role-question-list">
        {questions.slice(0, 5).map((item) => (
          <article key={item.id} className={item.status === "answered" ? "is-answered" : ""}>
            <div>
              <strong>{item.question || "Question"}</strong>
              <small>{item.status === "answered" ? "Answered" : "Open"} · {roleQuestionTime(item.updatedAt ?? item.createdAt)}</small>
            </div>
            {item.answer && <p>{item.answer}</p>}
          </article>
        ))}
        {questions.length === 0 && <p className="rb-side-empty">No questions for this role yet.</p>}
      </div>
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Example: Are Canada-based candidates acceptable if they overlap US hours?"
        rows={4}
      />
      <div className="rb-role-feedback__footer">
        <span>{savedAt ? `Sent at ${savedAt}` : "WeKruit answers appear here"}</span>
        <button type="button" className="rb-btn" onClick={() => void createQuestion()} disabled={submitting || question.trim().length < 8}>
          {submitting ? "Sending..." : "Ask question"}
        </button>
      </div>
      {err && <p className="rb-error">{err}</p>}
    </section>
  )
}
