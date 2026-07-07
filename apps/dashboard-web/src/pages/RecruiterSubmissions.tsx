/**
 * Admin view of pa-recruiter-submissions.
 *
 * Lists every recruiter submission newest-first, with chip filters (job + status),
 * sortable columns, pagination, row drill-down. Backed by the unified DataTable
 * primitive + useTable hook.
 */
import { Fragment, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react"
import { arrayUnion, collection, doc, getDoc, getDocs, getDocsFromServer, limit, orderBy, query, serverTimestamp, updateDoc } from "firebase/firestore"
import { AdminJobLink } from "../components/AdminEntityLink.js"
import { EvalLabelForm } from "../components/prescreen/EvalLabelForm.js"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { DataTable, type Column } from "../components/console/primitives.js"
import { useTable } from "../components/console/useTable.js"
import { SUBMISSION_FEEDBACK_REASONS, feedbackReasonLabel, ReasonChips } from "../components/recruiter-reasons.js"
import { auth, db } from "../lib/firebase.js"
import { cachedLoad, readCache, writeCache } from "../lib/unified-cache.js"
import { CandidateResumePreview } from "../components/CandidateResumePreview.js"
import {
  upsertCompanySend,
  removeCompanySend,
  COMPANY_SEND_STATUS_LABEL,
  type CompanySend,
  type CompanySendStatus,
} from "../lib/recruiter-submission-actions-api.js"
import { getRecruiterSubmissionsList, type RecruiterSubmissionsListResult } from "../lib/recruiter-submissions-list-api.js"
import { replaceRecruiterInviteCode, resendRecruiterInviteCodeEmail, restoreRecruiterInviteCode, sendRecruiterInviteEmail, type CreateRecruiterInviteCodeResult } from "../lib/recruiter-platform-api.js"
import {
  buildRoleApplicationReview,
  type RoleApplicationReview,
} from "./RecruiterApplicationReview.helpers.js"
import {
  buildSubmissionAdminReviewSummary,
  buildSubmissionChecklistReview,
  type SubmissionReviewTone,
} from "./RecruiterSubmissionReview.helpers.js"
import {
  buildRecruiterRoleOpsRows,
  type RecruiterRoleEmailAudience,
  type RecruiterRoleOpsRow,
  type RecruiterRolePriorityTier,
} from "./RecruiterRoleOps.helpers.js"

interface SubmissionDoc {
  id: string
  jobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  submitter?: { name?: string; email?: string }
  candidate?: {
    name?: string
    email?: string
    link?: string
    linkedinUrl?: string
    resumeUrl?: string
    currentRole?: string
    yoe?: string
    compensationExpectation?: string
    notes?: string
  }
  candidateConsentStatus?: string
  // Recruiter self-flag of the background pillars at submit time (advisory).
  candidateBackground?: { school?: string; gpa?: string; degree?: string; company?: string }
  aiEvaluation?: {
    verdict?: "advance" | "borderline" | "reject"
    confidence?: number
    identityConflict?: boolean
    summary?: string
    reasons?: string[]
    background?: {
      school?: { verdict?: string; evidence?: string }
      gpa?: { verdict?: string; evidence?: string }
      degree?: { verdict?: string; evidence?: string }
      company?: { verdict?: string; evidence?: string }
    }
  }
  // Canonical eval-store attempt id, stamped by paRecruiterSubmissionEval (P3).
  // Lets the dashboard read the labelable attempt without recomputing the hash.
  evaluationAttemptId?: string
  candidateConfirmation?: {
    status?: string
    candidateEmail?: string
    sentAt?: { seconds?: number } | string | null
    confirmedAt?: { seconds?: number } | string | null
    lastError?: string | null
  }
  // Per-item recruiter answer. Newer submissions store a graded value
  // ("strong" | "yes" | "partial" | "no"); legacy rows stored a bare boolean.
  checklist?: Record<string, boolean | SubmissionChecklistValue>
  score?: {
    hardChecked: number
    hardTotal: number
    fitChecked: number
    fitTotal: number
    bonusChecked: number
    bonusTotal: number
    antiChecked: number
    antiTotal: number
  }
  status?: string
  adminDecision?: {
    by?: string
    at?: string
    note?: string
  }
  statusHistory?: Array<{
    status?: string
    by?: string
    atIso?: string
    note?: string
    rating?: number
    reasons?: string[]
  }>
  companySends?: CompanySend[]
  requestedInfo?: Array<{ message?: string; at?: string; by?: string }>
  inboundJobId?: string
  recruiterId?: string | null
  recruiterEmail?: string
  recruiterFeedbackNote?: string | null
  recruiterFeedbackRating?: number | null
  recruiterFeedbackReasons?: string[]
  recruiterFeedbackUpdatedByEmail?: string | null
  recruiterFeedbackUpdatedAt?: { seconds?: number } | string | null
  recruiterPayout?: {
    status?: string
    amount?: number
    currency?: string
    note?: string | null
    updatedByEmail?: string | null
    updatedAt?: { seconds?: number } | string | null
  }
  sheetSyncedAt?: { seconds: number } | null
  sheetSyncError?: string | null
  createdAt?: { seconds: number } | null
  createdAtMs?: number
  triageSortMs?: number
  hardScorePct?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Role evidence matrix — tier semantics (must match recruiter-web RoleSheetPage).
// A recruiter's answer per checklist item is a graded value; legacy rows used a
// bare boolean. Four tiers shown in order hard → fit → anti → bonus, each with a
// required/optional badge + one-line rule. The "checked vs failed" glyph+color+
// word INVERTS for the anti tier (a present anti is bad).
// ─────────────────────────────────────────────────────────────────────────────
type SubmissionChecklistValue = "strong" | "yes" | "partial" | "no"
type ChecklistTierKind = "hard" | "fit" | "anti" | "bonus"

// Map the recruiter AI verdict → the canonical proposed-outcome kind that
// pre-seeds <EvalLabelForm> (and that the mirror writes to the attempt). MUST
// match recruiterVerdictToOutcome in apps/functions recruiter-submission-eval.ts.
function recruiterVerdictToOutcomeKind(
  verdict: "advance" | "borderline" | "reject" | undefined,
): "pass" | "hold" | "reject" {
  if (verdict === "advance") return "pass"
  if (verdict === "reject") return "reject"
  return "hold"
}

// Resolve the canonical attempt id from the STORED stamp only. The sha256
// fallback (createEvaluationAttemptId) is server-only — node:crypto is shimmed
// to throw in the dashboard bundle, so computing it here white-screens the
// drawer. Legacy rows without the stamp resolve to null (eval just doesn't load).
function resolveSubmissionAttemptId(row: SubmissionDoc): string | null {
  return row.evaluationAttemptId ?? null
}

const CHECKLIST_TIER_DISPLAY_ORDER: ChecklistTierKind[] = ["hard", "fit", "anti", "bonus"]

const CHECKLIST_TIER_CHIP: Record<ChecklistTierKind, string> = {
  hard: "Hard",
  fit: "Fit",
  anti: "Anti",
  bonus: "Bonus",
}

const CHECKLIST_TIER_META: Record<
  ChecklistTierKind,
  { label: string; required: boolean; rule: string }
> = {
  hard: { label: "Hard filters", required: true, rule: "Must mostly be met to be considered a match." },
  fit: { label: "Strong fit signals", required: true, rule: "Ideal candidates hit 2 or more." },
  anti: { label: "Anti-signals", required: true, rule: "If any is present, likely NOT a match." },
  bonus: { label: "Bonuses", required: false, rule: "Nice to have — leave blank if unknown." },
}

type ChecklistMarkTone = "met" | "partial" | "notmet" | "unanswered"
interface ChecklistMark {
  glyph: string
  word: string
  tone: ChecklistMarkTone
}

// Map the stored answer (boolean legacy OR graded string) to a normalized value.
function normalizeChecklistAnswer(
  raw: boolean | SubmissionChecklistValue | "" | undefined | null,
): "" | SubmissionChecklistValue {
  if (raw === true) return "yes" // legacy boolean true → treated as a plain "yes"
  if (raw === false || raw == null || raw === "") return ""
  if (raw === "strong" || raw === "yes" || raw === "partial" || raw === "no") return raw
  return ""
}

// "checked vs failed" semantics. Anti-signals INVERT: a present anti is bad.
function checklistMark(kind: ChecklistTierKind, value: "" | SubmissionChecklistValue): ChecklistMark {
  if (!value) return { glyph: "—", word: "not answered", tone: "unanswered" }
  if (kind === "anti") {
    if (value === "yes" || value === "strong") return { glyph: "✗", word: "flag present", tone: "notmet" }
    if (value === "partial") return { glyph: "~", word: "partial", tone: "partial" }
    return { glyph: "✓", word: "clear", tone: "met" } // value === "no"
  }
  if (value === "yes" || value === "strong") return { glyph: "✓", word: "met", tone: "met" }
  if (value === "partial") return { glyph: "~", word: "partial", tone: "partial" }
  return { glyph: "✗", word: "not met", tone: "notmet" } // value === "no"
}

const CHECKLIST_MARK_COLOR: Record<ChecklistMarkTone, string> = {
  met: "var(--success)",
  partial: "var(--warning)",
  notmet: "var(--danger)",
  unanswered: "var(--ink-3)",
}

const CHECKLIST_TIER_RAIL: Record<ChecklistTierKind, string> = {
  hard: "#e0b6ab",
  fit: "#c2d0ab",
  anti: "#e3c79a",
  bonus: "#b6c4cc",
}

interface ChecklistTierItem {
  id: string
  text: string
  value: "" | SubmissionChecklistValue
  mark: ChecklistMark
}
interface ChecklistTierGroup {
  kind: ChecklistTierKind
  items: ChecklistTierItem[]
}
interface ChecklistTierReview {
  groups: ChecklistTierGroup[]
  orphanCheckedIds: string[]
  hasReadableChecklist: boolean
  score: {
    hardMet: number
    hardTotal: number
    fitMet: number
    fitTotal: number
    bonusMet: number
    bonusTotal: number
    antiFlags: number
  }
}

function isTierKind(kind: string | undefined): kind is ChecklistTierKind {
  return kind === "hard" || kind === "fit" || kind === "anti" || kind === "bonus"
}

// Group the job's checklist groups into tiers (hard → fit → anti → bonus),
// resolving each item's recruiter answer + visual + a per-tier score tally.
function buildChecklistTierReview(
  submission: Pick<SubmissionDoc, "checklist">,
  role: RecruiterBoardAdminJobDoc | null | undefined,
): ChecklistTierReview {
  const answers = submission.checklist ?? {}
  const known = new Set<string>()
  const score = { hardMet: 0, hardTotal: 0, fitMet: 0, fitTotal: 0, bonusMet: 0, bonusTotal: 0, antiFlags: 0 }
  const byKind = new Map<ChecklistTierKind, ChecklistTierItem[]>()
  for (const group of role?.recruiterBoard?.checklist?.groups ?? []) {
    const kind = isTierKind(group.kind) ? group.kind : null
    if (!kind) continue
    for (const item of group.items ?? []) {
      const id = item.id?.trim() || item.text?.trim() || ""
      const text = item.text?.trim() || item.id?.trim() || ""
      if (!id || !text) continue
      known.add(id)
      const value = normalizeChecklistAnswer(answers[id])
      const mark = checklistMark(kind, value)
      if (kind === "hard") { score.hardTotal += 1; if (mark.tone === "met") score.hardMet += 1 }
      else if (kind === "fit") { score.fitTotal += 1; if (mark.tone === "met") score.fitMet += 1 }
      else if (kind === "bonus") { score.bonusTotal += 1; if (mark.tone === "met") score.bonusMet += 1 }
      else if (kind === "anti" && mark.tone === "notmet") { score.antiFlags += 1 }
      const list = byKind.get(kind) ?? []
      list.push({ id, text, value, mark })
      byKind.set(kind, list)
    }
  }
  const groups = CHECKLIST_TIER_DISPLAY_ORDER
    .map((kind) => ({ kind, items: byKind.get(kind) ?? [] }))
    .filter((g) => g.items.length > 0)
  const orphanCheckedIds = Object.entries(answers)
    .filter(([id, v]) => v !== false && v != null && !known.has(id))
    .map(([id]) => id)
    .sort()
  return { groups, orphanCheckedIds, hasReadableChecklist: groups.length > 0, score }
}

const CHECKLIST_SCORE_LEGEND_TAIL = "A match needs most hard filters met and no anti-flags."

function checklistScoreLegend(s: ChecklistTierReview["score"]): string {
  return (
    `Hard ${s.hardMet}/${s.hardTotal} met · ` +
    `Fit ${s.fitMet}/${s.fitTotal} · ` +
    `Bonus ${s.bonusMet}/${s.bonusTotal} · ` +
    `Anti ${s.antiFlags} flag(s). ` +
    CHECKLIST_SCORE_LEGEND_TAIL
  )
}

function formatTimestamp(ts: SubmissionDoc["createdAt"]): string {
  if (!ts || typeof ts.seconds !== "number") return "—"
  return new Date(ts.seconds * 1000).toLocaleString()
}

function statusBadge(s: string | undefined): "ok" | "warn" | "info" | "muted" {
  switch (s) {
    case "submitted":
    case "new":
      return "info"
    case "advanced": return "ok"
    case "interviewing": return "ok"
    case "offer": return "ok"
    case "hired": return "ok"
    case "backburner": return "info"
    case "rejected": return "warn"
    case "reviewing": return "info"
    default: return "muted"
  }
}

function consentBadge(status: string | undefined): { label: string; tone: "ok" | "warn" | "info" | "muted" } {
  switch (status) {
    case "candidate_confirmed": return { label: "confirmed", tone: "ok" }
    case "pending_candidate_confirmation": return { label: "pending", tone: "info" }
    case "confirmation_email_failed": return { label: "email failed", tone: "warn" }
    case "confirmation_email_not_configured": return { label: "not configured", tone: "warn" }
    default: return { label: "recruiter", tone: "muted" }
  }
}

const PAYOUT_STATUS_VALUES = ["none", "eligible", "pending_start", "invoice_ready", "paid", "void"]

function payoutBadge(status: string | undefined): { label: string; tone: "ok" | "warn" | "info" | "muted" } {
  switch (status) {
    case "eligible": return { label: "eligible", tone: "info" }
    case "pending_start": return { label: "pending start", tone: "info" }
    case "invoice_ready": return { label: "invoice ready", tone: "ok" }
    case "paid": return { label: "paid", tone: "ok" }
    case "void": return { label: "void", tone: "warn" }
    default: return { label: "not set", tone: "muted" }
  }
}

function normalizePayoutAmount(input: string): number | null {
  const clean = input.replace(/[$,]/g, "").trim()
  if (!clean) return null
  const n = Number(clean)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

function payoutAmountLabel(payout?: SubmissionDoc["recruiterPayout"]): string {
  const amount = payout?.amount
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return "—"
  const currency = payout?.currency ?? "USD"
  const formatted = amount.toLocaleString("en-US")
  return currency === "USD" ? `$${formatted}` : `${currency} ${formatted}`
}

const STATUS_VALUES = ["submitted", "new", "reviewing", "advanced", "wekruit_interview", "interviewing", "backburner", "offer", "client_review", "hired", "rejected", "duplicate"]
const ACTIVE_SUBMISSION_STATUSES = ["submitted", "new", "reviewing", "advanced", "wekruit_interview", "interviewing", "backburner", "offer", "client_review"]
const PENDING_SUBMISSION_STATUSES = ["submitted", "new", "reviewing", "backburner"]
const TRIAGE_FIRST_STATUSES = ["submitted", "new", "reviewing"]
const TRIAGE_SORT_BOOST_MS = 1e15
const ADVANCED_SUBMISSION_STATUSES = ["advanced", "wekruit_interview", "interviewing", "offer", "client_review", "hired"]
const NEGATIVE_SUBMISSION_STATUSES = ["rejected", "duplicate"]
const RECRUITER_WEEKLY_SUBMISSION_TARGET = 8
const RECRUITER_INACTIVITY_WINDOW_DAYS = 14
const RECRUITER_INTERVIEW_RATE_TARGET = 50
const INITIAL_RECRUITER_SUBMISSION_STATUSES = ["submitted", "new", "reviewing", "backburner"]

// Reason taxonomy + the grouped chip UI now live in the shared component
// ../components/recruiter-reasons.js, so the Submission view and the Recruiter
// Board render the SAME candidate-review reasons (Adam 2026-06-23).

function normalizeFeedbackRating(rating: unknown): number | null {
  const n = typeof rating === "number" ? rating : Number(rating)
  if (!Number.isInteger(n) || n < 1 || n > 4) return null
  return n
}

function hasWeKruitSubmissionResponse(submission: Pick<
  SubmissionDoc,
  "adminDecision" | "companySends" | "recruiterFeedbackNote" | "recruiterFeedbackRating" | "recruiterFeedbackReasons" | "recruiterFeedbackUpdatedAt" | "requestedInfo" | "status"
>): boolean {
  const status = submission.status ?? "submitted"
  return (
    !INITIAL_RECRUITER_SUBMISSION_STATUSES.includes(status) ||
    Boolean(submission.adminDecision) ||
    Boolean(submission.recruiterFeedbackUpdatedAt) ||
    Boolean(submission.recruiterFeedbackNote?.trim()) ||
    normalizeFeedbackRating(submission.recruiterFeedbackRating) !== null ||
    Boolean(submission.recruiterFeedbackReasons?.length) ||
    Boolean(submission.requestedInfo?.length) ||
    Boolean(submission.companySends?.length)
  )
}

function isPendingWeKruitSubmissionResponse(submission: SubmissionDoc): boolean {
  return !hasWeKruitSubmissionResponse(submission)
}

function feedbackRatingLabel(rating: unknown): string {
  const n = normalizeFeedbackRating(rating)
  return n ? `${n}/4` : "unrated"
}

function feedbackRatingTone(rating: unknown): "ok" | "warn" | "info" | "muted" {
  const n = normalizeFeedbackRating(rating)
  if (n === null) return "muted"
  if (n >= 3) return "ok"
  if (n === 2) return "info"
  return "warn"
}

function reviewSummaryTone(tone: SubmissionReviewTone): Parameters<typeof Badge>[0]["tone"] {
  return tone === "ok" ? "ok" : tone === "warn" ? "warn" : tone === "info" ? "info" : "muted"
}
const SOURCE_STAGE_VALUES = ["sourced", "contacted", "screened", "ready", "submitted", "archived"]
const CALIBRATION_VALUES = ["not_rated", "calibration_requested", "good_fit", "bad_fit", "suggested"]
const PRIORITY_TIER_VALUES: RecruiterRolePriorityTier[] = ["urgent", "high", "normal", "paused"]
const PRIORITY_EMAIL_AUDIENCE_VALUES: RecruiterRoleEmailAudience[] = ["recruiters", "candidates", "both", "none"]

interface RolePriorityDraft {
  rank: string
  tier: RecruiterRolePriorityTier
  emailAudience: RecruiterRoleEmailAudience
  note: string
}

function rolePriorityDraftFromRow(row: RecruiterRoleOpsRow): RolePriorityDraft {
  return {
    rank: row.priorityRank === null ? "" : String(row.priorityRank),
    tier: row.priorityTier,
    emailAudience: row.priorityEmailAudience,
    note: row.priorityNote,
  }
}

function normalizePriorityRankInput(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  if (!Number.isInteger(n) || n < 1 || n > 999) return undefined
  return n
}

function priorityTierLabel(tier: RecruiterRolePriorityTier): string {
  switch (tier) {
    case "urgent": return "Urgent"
    case "high": return "High"
    case "paused": return "Paused"
    default: return "Normal"
  }
}

function priorityAudienceLabel(audience: RecruiterRoleEmailAudience): string {
  switch (audience) {
    case "candidates": return "Candidates"
    case "both": return "Both"
    case "none": return "None"
    default: return "Recruiters"
  }
}

interface SourcedCandidateDoc {
  id: string
  candidateId?: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  stage?: string
  candidate?: {
    name?: string
    email?: string
    link?: string
    currentRole?: string
    yoe?: string
    compensationExpectation?: string
    notes?: string
  }
  calibrationStatus?: string
  calibrationNote?: string | null
  calibrationUpdatedAt?: { seconds?: number } | string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
  updatedAtMs?: number
}

interface RecruiterProfileDoc {
  id: string
  firebaseUid?: string
  name?: string
  email?: string
  status?: string
  reviewNote?: string | null
  reviewUpdatedAt?: { seconds?: number } | string | null
  reviewUpdatedByEmail?: string | null
  registeredAt?: { seconds?: number } | string | null
  lastSeenAt?: { seconds?: number } | string | null
  notificationPreferences?: { newRolesEmail?: boolean }
}

interface RecruiterInviteCodeDoc {
  id: string
  active?: boolean
  inviteCode?: string
  codePreview?: string
  label?: string | null
  recruiterEmail?: string | null
  maxUses?: number
  usedCount?: number
  expiresAt?: string | null
  inviteEmailStatus?: string | null
  inviteEmailSentAt?: { seconds?: number } | string | null
  inviteEmailFailedAt?: { seconds?: number } | string | null
  inviteEmailLastResentAt?: { seconds?: number } | string | null
  inviteEmailResendCount?: number
  inviteEmailLastError?: string | null
  createdAt?: { seconds?: number } | string | null
  createdByEmail?: string | null
  lastUsedByEmail?: string | null
  lastUsedByUid?: string | null
}

interface RecruiterNotificationDoc {
  id: string
  status?: string
  recruiterEmail?: string
  roleTitle?: string
  createdAt?: { seconds?: number } | string | null
  sentAt?: { seconds?: number } | string | null
  lastError?: string
}

interface RecruiterRoleFeedbackDoc {
  id: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  difficulty?: string
  reasons?: string[]
  note?: string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
  updatedAtMs?: number
}

interface RecruiterRoleQuestionDoc {
  id: string
  questionId?: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  question?: string
  status?: "open" | "answered"
  answer?: string | null
  answeredByEmail?: string | null
  answeredAt?: { seconds?: number } | string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
  updatedAtMs?: number
}

interface RecruiterRoleApplicationDoc {
  id: string
  applicationId?: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  status?: "pending" | "approved" | "not_approved" | "withdrawn" | "rescinded"
  pitch?: string | null
  anonymizeCandidates?: boolean
  preparedCandidateIds?: string[]
  preparedCandidateCount?: number
  adminNote?: string | null
  reviewedByEmail?: string | null
  reviewedAt?: { seconds?: number } | string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
  updatedAtMs?: number
}

interface RecruiterBoardAdminJobDoc {
  id: string
  publicId?: string
  title?: string
  compSummary?: string
  wekruitCollaborationStatus?: string
  updatedAt?: { seconds?: number } | string | null
  recruiterBoard?: {
    active?: boolean
    sortOrder?: number
    updatedAt?: { seconds?: number } | string | null
    interviewProcess?: string
    priority?: {
      rank?: number | null
      tier?: string | null
      note?: string | null
      emailAudience?: string | null
      updatedAt?: { seconds?: number } | string | null
      updatedByEmail?: string | null
    }
    label?: {
      company?: string
      companyCode?: string
      location?: string
      pills?: Array<{ text?: string; tone?: string }>
    }
    culture?: {
      bet?: string
      bullets?: string[]
    }
    checklist?: {
      groups?: Array<{
        kind?: "hard" | "fit" | "bonus" | "anti" | string
        heading?: string
        items?: Array<{ id?: string; text?: string }>
      }>
    }
  }
}

interface RecruiterQualityRow {
  id: string
  profile: RecruiterProfileDoc
  name: string
  email: string
  status: string
  statusTone: Parameters<typeof Badge>[0]["tone"]
  reviewLabel: string
  reviewTone: Parameters<typeof Badge>[0]["tone"]
  qualityScore: number
  avgRating: number | null
  submissionsTotal: number
  submissions7d: number
  submissions14d: number
  weeklyTargetPct: number
  activeSubmissions: number
  pendingWeKruitResponse: number
  advancedCount: number
  movementRate: number
  rejectionDrag: number
  sourcedActive: number
  readyCandidates: number
  approvedRoles: number
  pendingApplications: number
  roleCoveragePct: number
  coveredApprovedRoles: number
  lastSubmissionMs: number
  lastActivityMs: number
}

function timestampToMs(raw: unknown): number {
  if (!raw) return 0
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "object" && typeof (raw as { seconds?: unknown }).seconds === "number") {
    return ((raw as { seconds: number }).seconds) * 1000
  }
  return 0
}

function toDatetimeLocalValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function defaultRecruiterCodeExpiryLocal(): string {
  const date = new Date()
  date.setFullYear(date.getFullYear() + 1)
  return toDatetimeLocalValue(date)
}

function formatOpsDate(raw: unknown): string {
  const ms = timestampToMs(raw)
  return ms ? new Date(ms).toLocaleString() : "—"
}

function formatCompactOpsDate(raw: unknown): string {
  const ms = timestampToMs(raw)
  return ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"
}

function formatOpsDay(raw: unknown): string {
  const ms = timestampToMs(raw)
  return ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—"
}

function formatCodeExpiry(raw?: string | null): string {
  if (!raw) return "—"
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? raw : new Date(ms).toLocaleString()
}

const KNOWN_RECRUITER_INVITE_CODES_KEY = "wekruit.admin.recruiterInviteCodes.v1"
const RECRUITER_INVITE_BASE_URL = "https://wekruit-recruiters.web.app/recruiters"

const recruiterAccessScrollPaneStyle: CSSProperties = {
  maxHeight: 360,
  overflow: "auto",
  scrollbarWidth: "thin",
}

const recruiterInviteHeaderCellStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  padding: "6px 6px",
  background: "#fff",
  boxShadow: "0 1px 0 #eee",
}

const recruiterInviteCellStyle: CSSProperties = {
  padding: "6px 6px",
  verticalAlign: "middle",
}

const recruiterInviteButtonStyle: CSSProperties = {
  padding: "3px 7px",
  border: "1px solid #ccc",
  borderRadius: 5,
  background: "#fff",
  fontSize: 11,
  lineHeight: 1.15,
  whiteSpace: "nowrap",
}

function isFullRecruiterInviteCode(raw?: string | null): raw is string {
  const trimmed = raw?.trim()
  return Boolean(trimmed && /^WK-[A-Z0-9-]{4,40}$/.test(trimmed))
}

function recruiterInviteUrl(inviteCode: string): string {
  const url = new URL(RECRUITER_INVITE_BASE_URL)
  url.searchParams.set("accessCode", inviteCode)
  return url.toString()
}

function readKnownRecruiterInviteCodes(): Record<string, string> {
  if (typeof window === "undefined") return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KNOWN_RECRUITER_INVITE_CODES_KEY) ?? "{}") as Record<string, unknown>
    const codes: Record<string, string> = {}
    for (const [id, code] of Object.entries(parsed)) {
      if (typeof code === "string" && isFullRecruiterInviteCode(code)) {
        codes[id] = code.trim().toUpperCase()
      }
    }
    return codes
  } catch {
    return {}
  }
}

function writeKnownRecruiterInviteCodes(codes: Record<string, string>): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(KNOWN_RECRUITER_INVITE_CODES_KEY, JSON.stringify(codes))
  } catch {
    // Firestore remains source of truth; this cache only preserves same-browser visibility.
  }
}

type RecruiterAdminSection = "codes" | "roles" | "quality" | "applications" | "sourced" | "feedback" | "questions" | "submissions"

function codeStatus(code: RecruiterInviteCodeDoc): { label: string; tone: Parameters<typeof Badge>[0]["tone"] } {
  if (code.active === false) return { label: "disabled", tone: "muted" }
  if ((code.usedCount ?? 0) >= 1) return { label: "used", tone: "info" }
  if (code.expiresAt && Date.parse(code.expiresAt) <= Date.now()) return { label: "expired", tone: "warn" }
  return { label: "usable", tone: "ok" }
}

function recruiterInviteCanResend(code: RecruiterInviteCodeDoc): boolean {
  const email = code.recruiterEmail?.trim()
  return (
    codeStatus(code).label === "usable" &&
    code.inviteEmailStatus === "sent" &&
    isFullRecruiterInviteCode(code.inviteCode) &&
    Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  )
}

function inviteEmailBadge(status?: string | null): { label: string; tone: Parameters<typeof Badge>[0]["tone"] } {
  switch (status) {
    case "sent": return { label: "sent", tone: "ok" }
    case "queued": return { label: "queued", tone: "info" }
    case "failed": return { label: "failed", tone: "warn" }
    case "not_requested": return { label: "manual", tone: "muted" }
    default: return { label: "—", tone: "muted" }
  }
}

function recruiterAccountStatusTone(status?: string): Parameters<typeof Badge>[0]["tone"] {
  switch (status) {
    case "disabled": return "warn"
    case "under_review": return "info"
    case "active":
    case undefined:
    case "":
      return "ok"
    default:
      return "muted"
  }
}

function recruiterKeyMatches(row: { recruiterId?: string | null; recruiterEmail?: string }, profile: RecruiterProfileDoc): boolean {
  const email = profile.email?.trim().toLowerCase()
  return row.recruiterId === profile.id || Boolean(email && row.recruiterEmail?.trim().toLowerCase() === email)
}

function isSyntheticRecruiterProfile(profile: RecruiterProfileDoc): boolean {
  const email = profile.email?.trim().toLowerCase() ?? ""
  const name = profile.name?.trim().toLowerCase() ?? ""
  return email.endsWith("@example.com") || email.endsWith(".example.com") || name.includes("qa live") || name.includes("synthetic")
}

function rowJobKey(row: { inboundJobId?: string; jobId?: string }): string {
  return (row.inboundJobId || row.jobId || "").trim()
}

function computeRecruiterQualityRows(
  profiles: RecruiterProfileDoc[],
  submissions: SubmissionDoc[],
  sourcedCandidates: SourcedCandidateDoc[],
  applications: RecruiterRoleApplicationDoc[],
): RecruiterQualityRow[] {
  const nowMs = Date.now()
  const weekStartMs = nowMs - 7 * 86_400_000
  const inactivityStartMs = nowMs - RECRUITER_INACTIVITY_WINDOW_DAYS * 86_400_000
  return profiles.map((profile) => {
    const recruiterSubmissions = submissions.filter((s) => recruiterKeyMatches(s, profile))
    const recruiterCandidates = sourcedCandidates.filter((c) => recruiterKeyMatches(c, profile))
    const recruiterApplications = applications.filter((a) => recruiterKeyMatches(a, profile))
    const ratings = recruiterSubmissions
      .map((s) => normalizeFeedbackRating(s.recruiterFeedbackRating))
      .filter((n): n is number => n !== null)
    const avgRating = ratings.length ? ratings.reduce((sum, n) => sum + n, 0) / ratings.length : null
    const submissions7d = recruiterSubmissions.filter((s) => timestampToMs(s.createdAt) >= weekStartMs).length
    const submissions14d = recruiterSubmissions.filter((s) => timestampToMs(s.createdAt) >= inactivityStartMs).length
    const lastSubmissionMs = Math.max(0, ...recruiterSubmissions.map((s) => timestampToMs(s.createdAt)))
    const activeSubmissions = recruiterSubmissions.filter((s) => ACTIVE_SUBMISSION_STATUSES.includes(s.status ?? "submitted")).length
    const pendingWeKruitResponse = recruiterSubmissions.filter(isPendingWeKruitSubmissionResponse).length
    const advancedCount = recruiterSubmissions.filter((s) => ADVANCED_SUBMISSION_STATUSES.includes(s.status ?? "")).length
    const negativeCount = recruiterSubmissions.filter((s) => NEGATIVE_SUBMISSION_STATUSES.includes(s.status ?? "")).length
    const movementRate = recruiterSubmissions.length ? Math.round((advancedCount / recruiterSubmissions.length) * 100) : 0
    const rejectionDrag = recruiterSubmissions.length ? Math.round((negativeCount / recruiterSubmissions.length) * 100) : 0
    const approvedApplications = recruiterApplications.filter((a) => a.status === "approved")
    const pendingApplications = recruiterApplications.filter((a) => (a.status ?? "pending") === "pending").length
    const approvedRoleIds = [...new Set(approvedApplications.map(rowJobKey).filter(Boolean))]
    const activeRoleIds = new Set([
      ...recruiterSubmissions.filter((s) => [...ACTIVE_SUBMISSION_STATUSES, "hired"].includes(s.status ?? "submitted")).map(rowJobKey),
      ...recruiterCandidates.filter((c) => c.stage !== "archived").map(rowJobKey),
    ].filter(Boolean))
    const coveredApprovedRoles = approvedRoleIds.filter((id) => activeRoleIds.has(id)).length
    const roleCoveragePct = approvedRoleIds.length ? Math.round((coveredApprovedRoles / approvedRoleIds.length) * 100) : 0
    const readyCandidates = recruiterCandidates.filter((c) => c.stage === "ready").length
    const sourcedActive = recruiterCandidates.filter((c) => c.stage !== "archived").length
    const weeklyTargetPct = Math.min(100, Math.round((submissions7d / RECRUITER_WEEKLY_SUBMISSION_TARGET) * 100))
    const ratingScore = avgRating !== null ? (avgRating / 4) * 45 : 26
    const movementScore = Math.min(30, (movementRate / RECRUITER_INTERVIEW_RATE_TARGET) * 30)
    const weeklyScore = Math.min(15, (submissions7d / RECRUITER_WEEKLY_SUBMISSION_TARGET) * 15)
    const coverageScore = approvedRoleIds.length ? Math.min(10, (roleCoveragePct / 100) * 10) : 4
    const penalty = Math.min(20, rejectionDrag / 4)
    const qualityScore = Math.max(0, Math.min(100, Math.round(ratingScore + movementScore + weeklyScore + coverageScore - penalty)))
    const lastActivityMs = Math.max(
      timestampToMs(profile.lastSeenAt),
      ...recruiterSubmissions.map((s) => timestampToMs(s.recruiterFeedbackUpdatedAt ?? s.createdAt)),
      ...recruiterCandidates.map((c) => timestampToMs(c.updatedAt ?? c.createdAt)),
      ...recruiterApplications.map((a) => timestampToMs(a.updatedAt ?? a.createdAt)),
    )
    const needsReview =
      profile.status === "under_review" ||
      pendingApplications > 0 ||
      (approvedRoleIds.length > 0 && roleCoveragePct < 50) ||
      (recruiterSubmissions.length >= 3 && qualityScore < 55) ||
      (rejectionDrag >= 50 && recruiterSubmissions.length >= 3)
    const reviewLabel =
      profile.status === "disabled" ? "Disabled" :
      needsReview ? "Needs review" :
      qualityScore >= 78 && movementRate >= 30 ? "Trusted" :
      "Monitor"
    const reviewTone =
      profile.status === "disabled" ? "warn" :
      needsReview ? "info" :
      qualityScore >= 78 && movementRate >= 30 ? "ok" :
      "muted"
    return {
      id: profile.id,
      profile,
      name: profile.name || profile.email || "Recruiter",
      email: profile.email || profile.firebaseUid || profile.id,
      status: profile.status || "active",
      statusTone: recruiterAccountStatusTone(profile.status),
      reviewLabel,
      reviewTone,
      qualityScore,
      avgRating,
      submissionsTotal: recruiterSubmissions.length,
      submissions7d,
      submissions14d,
      weeklyTargetPct,
      activeSubmissions,
      pendingWeKruitResponse,
      advancedCount,
      movementRate,
      rejectionDrag,
      sourcedActive,
      readyCandidates,
      approvedRoles: approvedRoleIds.length,
      pendingApplications,
      roleCoveragePct,
      coveredApprovedRoles,
      lastSubmissionMs,
      lastActivityMs,
    }
  })
}

export default function RecruiterSubmissions({ section = "submissions", embedded = false }: { section?: RecruiterAdminSection; embedded?: boolean }) {
  const isSubmissions = section === "submissions"
  const [loading, setLoading] = useState(isSubmissions)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<SubmissionDoc[]>([])
  const [jobsByKey, setJobsByKey] = useState<Map<string, RecruiterBoardAdminJobDoc>>(new Map())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Full submission docs fetched on drawer-open (the list rows are trimmed).
  const [fullById, setFullById] = useState<Map<string, SubmissionDoc>>(new Map())

  useEffect(() => {
    if (!isSubmissions) {
      setLoading(false)
      setErr(null)
      setExpandedId(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        // ALL submissions (trimmed) via the admin callable — not the recent 500.
        // Loading 3.8k full docs client-side is ~19.5MB; the callable returns
        // ~2.6MB of just the table/search/filter fields so search + the state
        // filter see the whole pool. Cached (in-mem 3-min) for instant re-open.
        const [listResult, jobSnap] = await Promise.all([
          cachedLoad("recruiter-submissions:list", getRecruiterSubmissionsList),
          getDocs(query(collection(db(), "pa-jobs"), limit(500))),
        ])
        if (cancelled) return
        const all = (listResult.rows as (Omit<SubmissionDoc, "id"> & { id: string })[]).map((data) => {
          const createdAtMs = data.createdAt?.seconds ? data.createdAt.seconds * 1000 : 0
          const triageSortMs = TRIAGE_FIRST_STATUSES.includes(data.status ?? "new")
            ? createdAtMs + TRIAGE_SORT_BOOST_MS
            : createdAtMs
          const hardScorePct = data.score?.hardTotal
            ? data.score.hardChecked / data.score.hardTotal
            : 0
          return { ...data, createdAtMs, triageSortMs, hardScorePct }
        })
        const jobMap = new Map<string, RecruiterBoardAdminJobDoc>()
        for (const d of jobSnap.docs) {
          const job = { id: d.id, ...(d.data() as Omit<RecruiterBoardAdminJobDoc, "id">) }
          jobMap.set(job.id, job)
          if (job.publicId) jobMap.set(job.publicId, job)
        }
        setRows(all)
        setJobsByKey(jobMap)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isSubmissions])

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      if (r.jobId && !seen.has(r.jobId)) {
        seen.set(r.jobId, r.jobTitleSnapshot ?? r.jobId)
      }
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: SubmissionDoc) => r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<SubmissionDoc>(rows, {
    defaultSort: { key: "triageSortMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.submitter?.name?.toLowerCase().includes(q) ?? false) ||
      (r.submitter?.email?.toLowerCase().includes(q) ?? false) ||
      (r.candidate?.name?.toLowerCase().includes(q) ?? false) ||
      (r.candidate?.link?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "status",
        label: "Status",
        multi: true,
        options: STATUS_VALUES.map((s) => ({
          key: s,
          label: s,
          test: (r: SubmissionDoc) => (r.status ?? "new") === s,
        })),
      },
      {
        id: "score",
        label: "Score",
        multi: false,
        options: [
          {
            key: "hardFull",
            label: "Hard 100%",
            title: "All hard-filter boxes ticked",
            test: (r: SubmissionDoc) =>
              !!r.score && r.score.hardTotal > 0 && r.score.hardChecked === r.score.hardTotal,
          },
          {
            key: "hardPartial",
            label: "Hard < 100%",
            title: "At least one hard filter missing",
            test: (r: SubmissionDoc) =>
              !!r.score && r.score.hardTotal > 0 && r.score.hardChecked < r.score.hardTotal,
          },
          {
            key: "antiFlagged",
            label: "Anti-flag ≥ 1",
            title: "At least one anti-signal ticked",
            test: (r: SubmissionDoc) => !!r.score && r.score.antiChecked > 0,
          },
          {
            key: "sheetError",
            label: "Sheet sync error",
            test: (r: SubmissionDoc) => Boolean(r.sheetSyncError),
          },
        ],
      },
    ],
  })

  // The list is trimmed (no aiEvaluation / statusHistory / candidateBackground,
  // to keep the payload ~2.6MB instead of ~19.5MB). Fetch the FULL submission
  // doc when a row is opened so the detail drawer has everything. MUST stay
  // above the early returns below so the hook count is stable (React #310).
  useEffect(() => {
    if (!expandedId || fullById.has(expandedId)) return
    let cancel = false
    void getDoc(doc(db(), "pa-recruiter-submissions", expandedId))
      .then((s) => {
        if (!cancel && s.exists()) {
          setFullById((m) => new Map(m).set(s.id, { id: s.id, ...(s.data() as Omit<SubmissionDoc, "id">) }))
        }
      })
      .catch(() => undefined)
    return () => {
      cancel = true
    }
  }, [expandedId, fullById])

  const header = (
    <>
      <PageHeader
        title={
          section === "codes"
            ? "Recruiter Access"
            : section === "roles"
              ? "Recruiter Roles"
              : section === "quality"
                ? "Recruiter Quality"
                : section === "applications"
                  ? "Recruiter Applications"
                  : section === "sourced"
                    ? "Recruiter Sourced Candidates"
                    : section === "feedback"
                      ? "Recruiter Role Feedback"
                      : section === "questions"
                        ? "Recruiter Role Questions"
                        : "Recruiter Submissions"
        }
        description={
          section === "codes"
            ? "Create one-use recruiter access codes, review recruiter accounts, and monitor new-role alerts."
            : section === "roles"
              ? "Control which pa-jobs are marketplace-ready, where recruiters are active, and which role gaps will waste sourcing cycles."
              : section === "quality"
                ? "Review recruiter activity, rating, role coverage, and account status before granting more access."
                : section === "applications"
                  ? "Review recruiter requests to work specific roles, approve trusted coverage, and reject weak or over-capacity searches."
                  : section === "sourced"
                    ? "Review sourced prospects before formal submission, calibrate recruiters, and monitor role-level supply."
                    : section === "feedback"
                      ? "Review recruiter market feedback on role difficulty, blockers, and calibration gaps."
                      : section === "questions"
                        ? "Answer recruiter role-calibration questions before they waste sourcing cycles."
                        : "Review recruiter-submitted candidates and move each submission through the hiring-board pipeline."
        }
      />
      {!embedded && <RecruiterSectionTabs active={section} />}
    </>
  )

  if (section === "codes") {
    return (
      <div>
        {header}
        <RecruiterOpsPanel />
      </div>
    )
  }

  if (section === "roles") {
    return (
      <div>
        {header}
        <RecruiterRolesPanel />
      </div>
    )
  }

  if (section === "sourced") {
    return (
      <div>
        {header}
        <RecruiterSourcedCandidatesPanel />
      </div>
    )
  }

  if (section === "quality") {
    return (
      <div>
        {header}
        <RecruiterQualityPanel />
      </div>
    )
  }

  if (section === "applications") {
    return (
      <div>
        {header}
        <RecruiterRoleApplicationsPanel />
      </div>
    )
  }

  if (section === "feedback") {
    return (
      <div>
        {header}
        <RecruiterRoleFeedbackPanel />
      </div>
    )
  }

  if (section === "questions") {
    return (
      <div>
        {header}
        <RecruiterRoleQuestionsPanel />
      </div>
    )
  }

  if (loading) {
    return (
      <div>
        {header}
        <LoadingState label="Loading submissions..." />
      </div>
    )
  }
  if (err) {
    return (
      <div>
        {header}
        <ErrorState message={err} />
      </div>
    )
  }

  const columns: Column<SubmissionDoc>[] = [
    {
      key: "createdAtMs",
      label: "Submitted",
      sortable: true,
      width: 170,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatTimestamp(r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Job",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "-"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "submitter",
      label: "Submitter",
      render: (r) => (
        <>
          <div>{r.submitter?.name ?? "—"}</div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.submitter?.email ?? ""}</div>
        </>
      ),
    },
    {
      key: "candidate",
      label: "Candidate",
      render: (r) => (
        <>
          <div>{r.candidate?.name ?? "—"}</div>
          {r.candidate?.email && <div style={{ color: "#777", fontSize: 11 }}>{r.candidate.email}</div>}
          {r.candidate?.link && (
            <a
              href={r.candidate.link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ fontSize: 11, color: "#2a5fb8" }}
            >
              {r.candidate.link.length > 36 ? r.candidate.link.slice(0, 36) + "…" : r.candidate.link}
            </a>
          )}
        </>
      ),
    },
    {
      key: "candidateConsentStatus",
      label: "Consent",
      width: 110,
      render: (r) => {
        const meta = consentBadge(r.candidateConsentStatus)
        return <Badge tone={meta.tone}>{meta.label}</Badge>
      },
    },
    {
      key: "hardScorePct",
      label: "Hard",
      sortable: true,
      width: 70,
      render: (r) => (r.score ? `${r.score.hardChecked}/${r.score.hardTotal}` : "—"),
    },
    {
      key: "fitScore",
      label: "Fit",
      width: 70,
      render: (r) => (r.score ? `${r.score.fitChecked}/${r.score.fitTotal}` : "—"),
    },
    {
      key: "antiScore",
      label: "Anti",
      width: 70,
      render: (r) => (r.score ? `${r.score.antiChecked}/${r.score.antiTotal}` : "—"),
    },
    {
      key: "sheet",
      label: "Sheet",
      width: 80,
      render: (r) => (r.sheetSyncedAt ? "✓ synced" : r.sheetSyncError ? "× error" : "—"),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      width: 120,
      render: (r) => <Badge tone={statusBadge(r.status)}>{r.status ?? "submitted"}</Badge>,
    },
    {
      key: "recruiterPayout",
      label: "Payout",
      width: 128,
      render: (r) => {
        const meta = payoutBadge(r.recruiterPayout?.status)
        return (
          <>
            <Badge tone={meta.tone}>{meta.label}</Badge>
            <div style={{ color: "#777", fontSize: 11, marginTop: 3 }}>{payoutAmountLabel(r.recruiterPayout)}</div>
          </>
        )
      },
    },
    {
      key: "recruiterFeedbackRating",
      label: "Rating",
      width: 84,
      render: (r) => <Badge tone={feedbackRatingTone(r.recruiterFeedbackRating)}>{feedbackRatingLabel(r.recruiterFeedbackRating)}</Badge>,
    },
    {
      key: "feedback",
      label: "Feedback",
      width: 140,
      render: (r) => {
        const reasons = (r.recruiterFeedbackReasons ?? []).map(feedbackReasonLabel)
        if (r.recruiterFeedbackNote) return "note"
        if (reasons.length) return reasons.slice(0, 2).join(", ")
        return "—"
      },
    },
  ]

  const baseRow = expandedId ? rows.find((r) => r.id === expandedId) ?? null : null
  const selectedRow = baseRow ? { ...baseRow, ...(fullById.get(baseRow.id ?? "") ?? {}) } : null

  return (
    <div>
      {header}
      <div className="sub-masterdetail">
        <div className="sub-masterdetail__list">
          <Panel>
            <DataTable<SubmissionDoc>
              columns={columns}
              rows={table.visibleRows}
              chips={table.chipsForRender}
              search={table.search}
              onSearch={table.setSearch}
              searchPlaceholder="Search submitter / candidate / job…"
              sort={table.sort}
              onSort={table.toggleSort}
              page={table.page}
              pageCount={table.pageCount}
              onPageChange={table.setPage}
              onResetFilters={table.reset}
              count={table.filteredCount}
              totalCount={table.totalRows}
              selectedRowId={expandedId}
              onRowClick={(r) => setExpandedId(expandedId === r.id ? null : r.id ?? null)}
              empty={
                <div style={{ padding: 40, textAlign: "center", color: "#777" }}>
                  No submissions match the current filters.
                </div>
              }
            />
          </Panel>
        </div>
        <div className="sub-masterdetail__detail">
          {selectedRow ? (
            <RowDetailPanel
              row={selectedRow}
              role={jobsByKey.get(selectedRow.jobId ?? "") ?? jobsByKey.get(selectedRow.inboundJobId ?? "") ?? null}
              onClose={() => setExpandedId(null)}
              onUpdated={(next) => {
                setRows((prev) => prev.map((r) => r.id === next.id ? { ...r, ...next } : r))
                setFullById((m) => {
                  const cur = m.get(next.id ?? "")
                  return cur ? new Map(m).set(next.id ?? "", { ...cur, ...next }) : m
                })
                // Keep the cached list in sync so re-opening the tab shows the
                // new status immediately (server cache self-heals within 60s).
                const cached = readCache<RecruiterSubmissionsListResult>("recruiter-submissions:list", 3 * 60_000)
                if (cached) {
                  writeCache("recruiter-submissions:list", {
                    ...cached.data,
                    rows: cached.data.rows.map((rr) =>
                      (rr as { id?: string }).id === next.id ? { ...rr, ...next } : rr,
                    ),
                  })
                }
              }}
            />
          ) : (
            <Panel>
              <div style={{ padding: "48px 24px", textAlign: "center", color: "var(--ink-3)" }}>
                <div style={{ fontSize: 30, lineHeight: 1, marginBottom: 10 }} aria-hidden="true">📋</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#444" }}>Select a submission</div>
                <div style={{ fontSize: 12.5, marginTop: 6, maxWidth: 280, marginInline: "auto", lineHeight: 1.45 }}>
                  Pick a row on the left to review the recruiter packet, role evidence matrix, and set status, rating, feedback, and payout.
                </div>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}

function RecruiterSectionTabs({ active }: { active: RecruiterAdminSection }) {
  const tabs: Array<{ key: RecruiterAdminSection; label: string; to: string; detail: string }> = [
    {
      key: "codes",
      label: "Invites",
      to: "/admin/recruiter-access",
      detail: "Email invites, accounts, role alerts",
    },
    {
      key: "roles",
      label: "Role priorities",
      to: "/admin/recruiter-roles",
      detail: "Collab job rank, urgency, and email audience",
    },
    {
      key: "quality",
      label: "Quality",
      to: "/admin/recruiter-quality",
      detail: "Ratings, activity, account review",
    },
    {
      key: "applications",
      label: "Applications",
      to: "/admin/recruiter-applications",
      detail: "Approve role access",
    },
    {
      key: "sourced",
      label: "Sourced candidates",
      to: "/admin/recruiter-sourced",
      detail: "Calibration queue",
    },
    {
      key: "feedback",
      label: "Role feedback",
      to: "/admin/recruiter-feedback",
      detail: "Market blockers",
    },
    {
      key: "questions",
      label: "Role questions",
      to: "/admin/recruiter-questions",
      detail: "Calibration inbox",
    },
    {
      key: "submissions",
      label: "Submissions",
      to: "/admin/recruiter-submissions",
      detail: "Candidate review queue",
    },
  ]

  return (
    <nav
      aria-label="Recruiter admin sections"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
        gap: 12,
        margin: "0 0 16px",
      }}
    >
      {tabs.map((tab) => {
        const selected = active === tab.key
        return (
          <a
            key={tab.key}
            href={tab.to}
            aria-current={selected ? "page" : undefined}
            style={{
              display: "grid",
              gap: 4,
              padding: "14px 16px",
              border: selected ? "1px solid #2a1a10" : "1px solid #e6ded4",
              borderRadius: 8,
              background: selected ? "#fff" : "#f8f5ef",
              color: "#2a1a10",
              textDecoration: "none",
              boxShadow: selected ? "0 1px 0 rgba(42, 26, 16, 0.08)" : "none",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700 }}>{tab.label}</span>
            <span style={{ color: "#777", fontSize: 12 }}>{tab.detail}</span>
          </a>
        )
      })}
    </nav>
  )
}

function RecruiterRolesPanel() {
  const [rows, setRows] = useState<RecruiterRoleOpsRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [priorityDrafts, setPriorityDrafts] = useState<Record<string, RolePriorityDraft>>({})
  const [savingPriorityId, setSavingPriorityId] = useState<string | null>(null)
  const [priorityErr, setPriorityErr] = useState<string | null>(null)

  const reload = async (force = false) => {
    setLoading(true)
    setErr(null)
    try {
      // Cache-through (3-min TTL): mount serves the built rows from cache (the
      // ~5k-doc read is the slow part); mutations + the Refresh button pass
      // force=true to re-read.
      const built = await cachedLoad(
        "recruiter-role-ops:rows",
        async () => {
          const [jobSnap, submissionSnap, candidateSnap, applicationSnap, feedbackSnap, questionSnap] = await Promise.all([
            getDocs(query(collection(db(), "pa-jobs"), limit(500))),
            getDocs(query(collection(db(), "pa-recruiter-submissions"), limit(1000))),
            getDocs(query(collection(db(), "pa-recruiter-sourced-candidates"), limit(1000))),
            getDocs(query(collection(db(), "pa-recruiter-role-applications"), limit(1000))),
            getDocs(query(collection(db(), "pa-recruiter-role-feedback"), limit(1000))),
            getDocs(query(collection(db(), "pa-recruiter-role-questions"), limit(1000))),
          ])
          const jobs = jobSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterBoardAdminJobDoc, "id">) }))
          const submissions = submissionSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SubmissionDoc, "id">) }))
          const candidates = candidateSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SourcedCandidateDoc, "id">) }))
          const applications = applicationSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterRoleApplicationDoc, "id">) }))
          const feedback = feedbackSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterRoleFeedbackDoc, "id">) }))
          const questions = questionSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterRoleQuestionDoc, "id">) }))
          return buildRecruiterRoleOpsRows({ jobs, submissions, candidates, applications, feedback, questions })
        },
        undefined,
        force,
      )
      setRows(built)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  const priorityDraftFor = (row: RecruiterRoleOpsRow): RolePriorityDraft =>
    priorityDrafts[row.id] ?? rolePriorityDraftFromRow(row)

  const updatePriorityDraft = (row: RecruiterRoleOpsRow, patch: Partial<RolePriorityDraft>) => {
    setPriorityDrafts((prev) => ({
      ...prev,
      [row.id]: { ...priorityDraftFor(row), ...patch },
    }))
  }

  const saveRolePriority = async (row: RecruiterRoleOpsRow) => {
    const draft = priorityDraftFor(row)
    const rank = normalizePriorityRankInput(draft.rank)
    if (rank === undefined) {
      setPriorityErr("Priority rank must be blank or an integer from 1 to 999.")
      return
    }

    setSavingPriorityId(row.id)
    setPriorityErr(null)
    try {
      await updateDoc(doc(db(), "pa-jobs", row.id), {
        "recruiterBoard.priority.rank": rank,
        "recruiterBoard.priority.tier": draft.tier,
        "recruiterBoard.priority.emailAudience": draft.emailAudience,
        "recruiterBoard.priority.note": draft.note.trim() || null,
        "recruiterBoard.priority.updatedAt": serverTimestamp(),
        "recruiterBoard.priority.updatedByEmail": auth().currentUser?.email ?? "admin",
        "recruiterBoard.updatedAt": serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      setPriorityDrafts((prev) => {
        const next = { ...prev }
        delete next[row.id]
        return next
      })
      await reload(true)
    } catch (error) {
      setPriorityErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingPriorityId(null)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const table = useTable<RecruiterRoleOpsRow>(rows, {
    defaultSort: { key: "prioritySort", dir: "asc" },
    pageSize: 50,
    search: (row, q) =>
      row.title.toLowerCase().includes(q) ||
      row.company.toLowerCase().includes(q) ||
      row.location.toLowerCase().includes(q) ||
      row.priorityNote.toLowerCase().includes(q) ||
      row.id.toLowerCase().includes(q),
    chips: [
      {
        id: "priority",
        label: "Priority",
        multi: true,
        options: [
          { key: "ranked", label: "Ranked", test: (row) => row.priorityRank !== null },
          { key: "urgent", label: "Urgent", test: (row) => row.priorityTier === "urgent" },
          { key: "high", label: "High", test: (row) => row.priorityTier === "high" },
          { key: "unranked", label: "Unranked", test: (row) => row.priorityRank === null },
        ],
      },
      {
        id: "launch",
        label: "Launch",
        multi: false,
        options: [
          { key: "live", label: "Live", test: (row) => row.active && row.collaborated },
          { key: "gaps", label: "Live gaps", test: (row) => row.active && row.readinessScore < 90 },
          { key: "inactive", label: "Inactive", test: (row) => !row.active || !row.collaborated },
        ],
      },
      {
        id: "activity",
        label: "Activity",
        multi: true,
        options: [
          { key: "pending_apps", label: "Pending apps", test: (row) => row.pendingApplications > 0 },
          { key: "approved", label: "Approved recruiters", test: (row) => row.approvedRecruiters > 0 },
          { key: "sourced", label: "Has sourced", test: (row) => row.sourced > 0 },
          { key: "submitted", label: "Has submissions", test: (row) => row.submissions > 0 },
          { key: "no_motion", label: "No motion", test: (row) => row.active && row.sourced === 0 && row.submissions === 0 },
        ],
      },
      {
        id: "activation",
        label: "Activation",
        multi: true,
        options: [
          { key: "needs_recruiter_coverage", label: "Needs coverage", test: (row) => row.activationStage === "needs_recruiter_coverage" },
          { key: "needs_sourced_supply", label: "Needs supply", test: (row) => row.activationStage === "needs_sourced_supply" },
          { key: "needs_submission", label: "Needs submission", test: (row) => row.activationStage === "needs_submission" },
          { key: "needs_review", label: "Needs review", test: (row) => row.activationStage === "needs_review" },
          { key: "needs_calibration", label: "Needs calibration", test: (row) => row.activationStage === "needs_calibration" },
          { key: "moving", label: "Moving", test: (row) => row.activationStage === "moving" },
        ],
      },
      {
        id: "blockers",
        label: "Blockers",
        multi: true,
        options: [
          { key: "questions", label: "Open questions", test: (row) => row.openQuestions > 0 },
          { key: "feedback", label: "Hard feedback", test: (row) => row.hardFeedback > 0 || row.blockedFeedback > 0 },
          { key: "queue_full", label: "Review queue", test: (row) => row.pendingSubmissions >= 5 },
        ],
      },
    ],
  })

  if (loading) return <LoadingState label="Loading recruiter roles..." />
  if (err) return <ErrorState message={err} />

  const activeRows = rows.filter((row) => row.active && row.collaborated)
  const priorityRows = rows.filter((row) => row.active && row.priorityRank !== null)
  const urgentPriorityRows = rows.filter((row) => row.active && row.priorityTier === "urgent")
  const setupGaps = rows.filter((row) => row.active && row.readinessScore < 90)
  const noMotion = rows.filter((row) => row.active && row.sourced === 0 && row.submissions === 0)
  const activationGaps = rows.filter((row) =>
    row.active &&
    row.collaborated &&
    !["moving"].includes(row.activationStage)
  )
  const pendingApplications = rows.reduce((sum, row) => sum + row.pendingApplications, 0)
  const columns: Column<RecruiterRoleOpsRow>[] = [
    {
      key: "prioritySort",
      label: "Priority",
      sortable: true,
      width: 360,
      render: (row) => {
        const draft = priorityDraftFor(row)
        const saving = savingPriorityId === row.id
        return (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ display: "grid", gap: 8, minWidth: 310 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Badge tone={row.priorityTone}>
                {row.priorityRank === null ? "Unranked" : `P${row.priorityRank}`}
              </Badge>
              <span style={{ color: "#777", fontSize: 11 }}>
                {priorityTierLabel(row.priorityTier)} · email {priorityAudienceLabel(row.priorityEmailAudience).toLowerCase()}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "64px 92px 112px auto", gap: 6 }}>
              <input
                aria-label={`Priority rank for ${row.title}`}
                type="number"
                min={1}
                max={999}
                value={draft.rank}
                placeholder="rank"
                onChange={(e) => updatePriorityDraft(row, { rank: e.target.value })}
                style={{ minWidth: 0 }}
              />
              <select
                aria-label={`Priority tier for ${row.title}`}
                value={draft.tier}
                onChange={(e) => updatePriorityDraft(row, { tier: e.target.value as RecruiterRolePriorityTier })}
              >
                {PRIORITY_TIER_VALUES.map((tier) => (
                  <option key={tier} value={tier}>{priorityTierLabel(tier)}</option>
                ))}
              </select>
              <select
                aria-label={`Priority email audience for ${row.title}`}
                value={draft.emailAudience}
                onChange={(e) => updatePriorityDraft(row, { emailAudience: e.target.value as RecruiterRoleEmailAudience })}
              >
                {PRIORITY_EMAIL_AUDIENCE_VALUES.map((audience) => (
                  <option key={audience} value={audience}>{priorityAudienceLabel(audience)}</option>
                ))}
              </select>
              <button type="button" onClick={() => void saveRolePriority(row)} disabled={saving}>
                {saving ? "Saving" : "Save"}
              </button>
            </div>
            <input
              aria-label={`Priority note for ${row.title}`}
              value={draft.note}
              placeholder="Priority note / email angle"
              onChange={(e) => updatePriorityDraft(row, { note: e.target.value })}
            />
          </div>
        )
      },
    },
    {
      key: "activationStage",
      label: "Activation",
      sortable: true,
      width: 190,
      render: (row) => (
        <>
          <Badge tone={row.activationTone}>{row.activationLabel}</Badge>
          <div style={{ color: "#777", fontSize: 11, marginTop: 4, lineHeight: 1.35 }}>{row.activationReason}</div>
        </>
      ),
    },
    {
      key: "readinessScore",
      label: "Readiness",
      sortable: true,
      width: 150,
      render: (row) => (
        <>
          <Badge tone={row.readinessTone}>{row.readinessLabel}</Badge>
          <div style={{ color: "#777", fontSize: 11, marginTop: 4 }}>{row.readinessScore}% complete</div>
        </>
      ),
    },
    {
      key: "title",
      label: "Role",
      sortable: true,
      render: (row) => (
        <>
          <div style={{ fontWeight: 600 }}>
            <AdminJobLink jobId={row.id}>{row.title}</AdminJobLink>
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{row.company} · {row.location}</div>
          <a
            href={`https://wekruit-recruiters.web.app/recruiters/job/${encodeURIComponent(row.publicId)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ color: "#2a5fb8", fontSize: 11 }}
          >
            recruiter preview
          </a>
        </>
      ),
    },
    {
      key: "checks",
      label: "Scorecard",
      width: 130,
      render: (row) => (
        <span style={{ color: "#555", fontSize: 12 }}>
          H {row.hardChecks} · F {row.fitChecks} · B {row.bonusChecks} · A {row.antiChecks}
        </span>
      ),
    },
    {
      key: "approvedRecruiters",
      label: "Access",
      sortable: true,
      width: 110,
      render: (row) => (
        <>
          <div>{row.approvedRecruiters} approved</div>
          <div style={{ color: row.pendingApplications ? "#8a5b1c" : "#777", fontSize: 11 }}>{row.pendingApplications} pending</div>
        </>
      ),
    },
    {
      key: "sourced",
      label: "Supply",
      sortable: true,
      width: 105,
      render: (row) => (
        <>
          <div>{row.sourced} sourced</div>
          <div style={{ color: "#777", fontSize: 11 }}>{row.ready} ready</div>
        </>
      ),
    },
    {
      key: "submissions",
      label: "Pipeline",
      sortable: true,
      width: 130,
      render: (row) => (
        <>
          <div>{row.submissions} submitted</div>
          <div style={{ color: "#777", fontSize: 11 }}>{row.pendingSubmissions} pending · {row.advanced} advanced</div>
        </>
      ),
    },
    {
      key: "blockers",
      label: "Blockers",
      width: 170,
      render: (row) => {
        const blockers = [
          row.openQuestions ? `${row.openQuestions} open Q` : "",
          row.blockedFeedback ? `${row.blockedFeedback} blocked feedback` : "",
          row.hardFeedback ? `${row.hardFeedback} hard feedback` : "",
          row.rejectedOrDuplicate ? `${row.rejectedOrDuplicate} rejected/dup` : "",
        ].filter(Boolean)
        return blockers.length ? blockers.join(" · ") : "—"
      },
    },
    {
      key: "missingSetup",
      label: "Setup gaps",
      render: (row) => row.missingSetup.length ? row.missingSetup.slice(0, 3).join(", ") : "Ready",
    },
    {
      key: "updatedAtMs",
      label: "Updated",
      sortable: true,
      width: 130,
      render: (row) => formatCompactOpsDate(row.updatedAt),
    },
  ]

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Live roles" value={activeRows.length} />
        <OpsMetric label="Priority roles" value={priorityRows.length} meta={`${urgentPriorityRows.length} urgent`} />
        <OpsMetric label="Setup gaps" value={setupGaps.length} />
        <OpsMetric label="Pending applications" value={pendingApplications} />
        <OpsMetric label="Activation gaps" value={activationGaps.length} meta={`${noMotion.length} with no motion`} />
      </div>
      <Panel
        title="Role priorities"
        eyebrow="pa-jobs, recruiterBoard, applications, calibration"
        actions={<button type="button" onClick={() => void reload(true)} disabled={loading}>Refresh</button>}
      >
        {priorityErr && (
          <div style={{ marginBottom: 12 }}>
            <Badge tone="warn">{priorityErr}</Badge>
          </div>
        )}
        <DataTable<RecruiterRoleOpsRow>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search role / company / job id..."
          sort={table.sort}
          onSort={table.toggleSort}
          page={table.page}
          pageCount={table.pageCount}
          onPageChange={table.setPage}
          onResetFilters={table.reset}
          count={table.filteredCount}
          totalCount={table.totalRows}
          empty={
            <div style={{ padding: 40, textAlign: "center", color: "#777" }}>
              No recruiter-board roles match the current filters.
            </div>
          }
        />
      </Panel>
    </div>
  )
}

function RecruiterOpsPanel() {
  const [profiles, setProfiles] = useState<RecruiterProfileDoc[]>([])
  const [codes, setCodes] = useState<RecruiterInviteCodeDoc[]>([])
  const [notifications, setNotifications] = useState<RecruiterNotificationDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [recruiterEmail, setRecruiterEmail] = useState("")
  const [label, setLabel] = useState("")
  const [expiresAtLocal, setExpiresAtLocal] = useState(() => defaultRecruiterCodeExpiryLocal())
  const [generated, setGenerated] = useState<CreateRecruiterInviteCodeResult | null>(null)
  const [knownInviteCodes, setKnownInviteCodes] = useState<Record<string, string>>(() => readKnownRecruiterInviteCodes())
  const [creating, setCreating] = useState(false)
  const [replacingCodeId, setReplacingCodeId] = useState<string | null>(null)
  const [restoringCodeId, setRestoringCodeId] = useState<string | null>(null)
  const [resendingCodeId, setResendingCodeId] = useState<string | null>(null)
  const [resendingAll, setResendingAll] = useState(false)
  const [resendNotice, setResendNotice] = useState<string | null>(null)
  const [restoreInputs, setRestoreInputs] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    try {
      const [profileSnap, codeSnap, notificationSnap] = await Promise.all([
        getDocs(collection(db(), "pa-recruiter-users")),
        getDocsFromServer(collection(db(), "pa-recruiter-invite-codes")),
        getDocs(query(collection(db(), "pa-recruiter-notifications"), limit(100))),
      ])
      setProfiles(profileSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterProfileDoc, "id">) })))
      setCodes(codeSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterInviteCodeDoc, "id">) })))
      setNotifications(
        notificationSnap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterNotificationDoc, "id">) }))
          .sort((a, b) => timestampToMs(b.createdAt) - timestampToMs(a.createdAt)),
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const sendInvite = async (e: FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setErr(null)
    try {
      const expiresAt = expiresAtLocal ? new Date(expiresAtLocal).toISOString() : undefined
      const result = await sendRecruiterInviteEmail({
        recruiterEmail: recruiterEmail.trim(),
        label: label.trim() || undefined,
        expiresAt,
      })
      rememberGeneratedCode(result)
      setRecruiterEmail("")
      setLabel("")
      setExpiresAtLocal(defaultRecruiterCodeExpiryLocal())
      await reload()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
      await reload().catch(() => undefined)
    } finally {
      setCreating(false)
    }
  }

  const rememberGeneratedCode = (result: CreateRecruiterInviteCodeResult) => {
    setGenerated(result)
    setKnownInviteCodes((prev) => {
      const next = { ...prev, [result.inviteCodeId]: result.inviteCode }
      writeKnownRecruiterInviteCodes(next)
      return next
    })
  }

  const replaceLegacyCode = async (inviteCodeId: string) => {
    setReplacingCodeId(inviteCodeId)
    setErr(null)
    try {
      const result = await replaceRecruiterInviteCode(inviteCodeId)
      rememberGeneratedCode(result)
      await reload()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setReplacingCodeId(null)
    }
  }

  const restoreKnownCode = async (inviteCodeId: string) => {
    const inviteCode = (restoreInputs[inviteCodeId] ?? "").trim()
    if (!inviteCode) {
      setErr("Paste the full WK access code first.")
      return
    }
    setRestoringCodeId(inviteCodeId)
    setErr(null)
    try {
      const result = await restoreRecruiterInviteCode(inviteCodeId, inviteCode)
      rememberGeneratedCode(result)
      setRestoreInputs((prev) => {
        const next = { ...prev }
        delete next[inviteCodeId]
        return next
      })
      await reload()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setRestoringCodeId(null)
    }
  }

  const resendInvite = async (inviteCodeId: string) => {
    setResendingCodeId(inviteCodeId)
    setErr(null)
    setResendNotice(null)
    try {
      const result = await resendRecruiterInviteCodeEmail(inviteCodeId)
      setResendNotice(`Resent invite to ${result.recruiterEmail}.`)
      await reload()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
      await reload().catch(() => undefined)
    } finally {
      setResendingCodeId(null)
    }
  }

  const activeRecruiters = profiles.filter((p) => p.status !== "disabled").length
  const emailOn = profiles.filter((p) => p.status !== "disabled" && p.notificationPreferences?.newRolesEmail !== false).length
  const activeCodes = codes.filter((c) => c.active !== false && (c.usedCount ?? 0) < 1).length
  const sentNotifications = notifications.filter((n) => n.status === "sent").length
  const failedNotifications = notifications.filter((n) => n.status === "failed").length
  const sortedCodes = [...codes].sort((a, b) => timestampToMs(b.createdAt) - timestampToMs(a.createdAt))
  const resendableInviteCodes = sortedCodes.filter(recruiterInviteCanResend)
  const recruiterByUid = new Map<string, { name?: string; email?: string }>()
  for (const profile of profiles) {
    const entry = { name: profile.name, email: profile.email }
    recruiterByUid.set(profile.id, entry)
    if (profile.firebaseUid) recruiterByUid.set(profile.firebaseUid, entry)
  }
  const rosterRows = [...profiles].sort((a, b) => timestampToMs(b.lastSeenAt) - timestampToMs(a.lastSeenAt))
  const unrecoverableUsableCodes = sortedCodes.filter((code) => {
    const status = codeStatus(code)
    const rawInviteCode = isFullRecruiterInviteCode(code.inviteCode)
      ? code.inviteCode
      : knownInviteCodes[code.id]
    return status.label === "usable" && !isFullRecruiterInviteCode(rawInviteCode)
  }).length

  const resendPendingInvites = async () => {
    if (!resendableInviteCodes.length) return
    setResendingAll(true)
    setErr(null)
    setResendNotice(null)
    let sent = 0
    const failures: string[] = []
    try {
      for (const code of resendableInviteCodes) {
        try {
          await resendRecruiterInviteCodeEmail(code.id)
          sent += 1
        } catch (error) {
          failures.push(`${code.recruiterEmail ?? code.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failures.length) {
        setErr(`Resent ${sent}; failed ${failures.length}. ${failures.slice(0, 3).join(" | ")}`)
      } else {
        setResendNotice(`Resent ${sent} pending invite${sent === 1 ? "" : "s"}.`)
      }
      await reload()
    } finally {
      setResendingAll(false)
    }
  }

  const rosterColumns: Column<RecruiterProfileDoc>[] = [
    {
      key: "name",
      label: "Name",
      render: (p) => <span style={{ fontWeight: 600 }}>{p.name || "—"}</span>,
    },
    {
      key: "email",
      label: "Email",
      render: (p) => p.email ?? "—",
    },
    {
      key: "status",
      label: "Status",
      width: 110,
      render: (p) => <Badge tone={recruiterAccountStatusTone(p.status)}>{p.status || "active"}</Badge>,
    },
    {
      key: "newRolesEmail",
      label: "New-roles email",
      width: 130,
      render: (p) => (
        <Badge tone={p.notificationPreferences?.newRolesEmail === false ? "muted" : "info"}>
          {p.notificationPreferences?.newRolesEmail === false ? "off" : "on"}
        </Badge>
      ),
    },
    {
      key: "registeredAt",
      label: "Registered",
      width: 130,
      render: (p) => <span style={{ whiteSpace: "nowrap" }}>{formatOpsDay(p.registeredAt)}</span>,
    },
    {
      key: "lastSeenAt",
      label: "Last seen",
      width: 130,
      render: (p) => <span style={{ whiteSpace: "nowrap" }}>{formatOpsDay(p.lastSeenAt)}</span>,
    },
  ]

  return (
    <Panel
      title="Recruiter access"
      eyebrow="Codes, accounts, notifications"
      actions={
        <button type="button" onClick={() => void reload()} disabled={loading}>Refresh</button>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Active recruiters" value={activeRecruiters} />
        <OpsMetric label="New-role email on" value={emailOn} />
        <OpsMetric label="Open invites" value={activeCodes} />
        <OpsMetric label="Notifications sent" value={sentNotifications} meta={failedNotifications ? `${failedNotifications} failed` : undefined} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 320px) minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
        <form id="recruiter-code-form" onSubmit={sendInvite} style={{ display: "grid", gap: 10, border: "1px solid #eee", borderRadius: 8, padding: 14, background: "#fff" }}>
          <div>
            <div style={{ fontWeight: 700 }}>Send recruiter invite</div>
            <p style={{ color: "#666", margin: "4px 0 0", fontSize: 13, lineHeight: 1.45 }}>
              Enter the recruiter email. WeKruit creates one one-time code, emails it with the recruiter site, and binds first access to that email.
            </p>
          </div>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#666" }}>
            Recruiter email
            <input
              type="email"
              required
              value={recruiterEmail}
              onChange={(e) => setRecruiterEmail(e.target.value)}
              placeholder="recruiter@agency.com"
              style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#666" }}>
            Internal note
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Agency, contact name, or context"
              style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#666" }}>
            Expires at
            <input
              type="datetime-local"
              value={expiresAtLocal}
              onChange={(e) => setExpiresAtLocal(e.target.value)}
              style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6 }}
            />
          </label>
          <button
            disabled={creating}
            style={{ padding: "9px 12px", border: "1px solid #222", background: "#222", color: "#fff", borderRadius: 6 }}
          >
            {creating ? "Sending..." : "Send invite email"}
          </button>
          {err && <p style={{ color: "#a00", fontSize: 12, margin: 0 }}>{err}</p>}
          {generated && (
            <div style={{ background: "#f7f3ed", border: "1px solid #e1d8cc", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: ".08em" }}>
                Invite {generated.emailStatus === "sent" ? "sent" : "created"}
              </div>
              <code style={{ display: "block", marginTop: 6, fontSize: 18, fontWeight: 700 }}>{generated.inviteCode}</code>
              {generated.recruiterEmail && (
                <div style={{ color: "#49311f", fontSize: 12, marginTop: 4 }}>
                  Sent to {generated.recruiterEmail}
                </div>
              )}
              <a
                href={generated.inviteUrl ?? recruiterInviteUrl(generated.inviteCode)}
                target="_blank"
                rel="noreferrer"
                style={{ display: "block", marginTop: 6, color: "#49311f", wordBreak: "break-all" }}
              >
                {generated.inviteUrl ?? recruiterInviteUrl(generated.inviteCode)}
              </a>
              <div style={{ color: "#777", fontSize: 12, marginTop: 4 }}>
                Expires {formatCodeExpiry(generated.expiresAt)}. This full code remains visible to admins for support.
              </div>
              {generated.replacedInviteCodeId && (
                <div style={{ color: "#7a3e10", fontSize: 12, marginTop: 4 }}>
                  Replaced the unrecoverable legacy code and disabled the old row.
                </div>
              )}
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(generated.inviteCode)}
                style={{ marginTop: 8, padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, background: "#fff" }}
              >
                Copy code
              </button>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(generated.inviteUrl ?? recruiterInviteUrl(generated.inviteCode))}
                style={{ marginTop: 8, marginLeft: 8, padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, background: "#fff" }}
              >
                Copy invite link
              </button>
            </div>
          )}
        </form>
        <OpsSection title="Recruiter invites" subtitle="One email invite creates one one-time code. Legacy hash-only rows remain here only for support and recovery.">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ color: "#777", fontSize: 12 }}>
              {resendableInviteCodes.length} sent invite{resendableInviteCodes.length === 1 ? "" : "s"} still unclaimed.
            </span>
            <button
              type="button"
              onClick={() => void resendPendingInvites()}
              disabled={resendingAll || !resendableInviteCodes.length}
              style={{
                padding: "6px 9px",
                border: "1px solid #ccc",
                borderRadius: 6,
                background: resendableInviteCodes.length ? "#fff" : "#f7f7f7",
                color: resendableInviteCodes.length ? "#333" : "#999",
                fontSize: 12,
              }}
            >
              {resendingAll ? "Resending..." : `Resend all pending (${resendableInviteCodes.length})`}
            </button>
          </div>
          {resendNotice && (
            <div style={{ marginBottom: 10, padding: "8px 10px", border: "1px solid #b8dfc2", borderRadius: 8, background: "#f1fbf3", color: "#24663a", fontSize: 12 }}>
              {resendNotice}
            </div>
          )}
          {unrecoverableUsableCodes > 0 && (
            <div style={{ marginBottom: 10, padding: "10px 12px", border: "1px solid #f1c48a", borderRadius: 8, background: "#fff8ed", color: "#7a3e10", fontSize: 12, lineHeight: 1.45 }}>
              {unrecoverableUsableCodes} usable legacy code{unrecoverableUsableCodes === 1 ? "" : "s"} only exist as a hash.
              Admins can validate those codes if a recruiter enters them, but cannot reveal the original text.
              Use Replace to create a new visible code.
            </div>
          )}
          {sortedCodes.length ? (
            <div style={{ ...recruiterAccessScrollPaneStyle, overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse", fontSize: 11.5, lineHeight: 1.25 }}>
                <thead>
                  <tr style={{ color: "#777", textAlign: "left", borderBottom: "1px solid #eee" }}>
                    <th style={recruiterInviteHeaderCellStyle}>Full code</th>
                    <th style={{ ...recruiterInviteHeaderCellStyle, width: 156 }}>Action</th>
                    <th style={recruiterInviteHeaderCellStyle}>Recruiter</th>
                    <th style={recruiterInviteHeaderCellStyle}>Email</th>
                    <th style={recruiterInviteHeaderCellStyle}>Status</th>
                    <th style={recruiterInviteHeaderCellStyle}>Expires</th>
                    <th style={recruiterInviteHeaderCellStyle}>Bound to</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedCodes.map((code) => {
                    const status = codeStatus(code)
                    const rawInviteCode = isFullRecruiterInviteCode(code.inviteCode)
                      ? code.inviteCode
                      : knownInviteCodes[code.id]
                    const canCopy = isFullRecruiterInviteCode(rawInviteCode)
                    const visibleCode = canCopy ? rawInviteCode : "Legacy hash-only"
                    const rawMissing = !canCopy && status.label === "usable"
                    return (
                      <tr key={code.id} style={{ borderBottom: "1px solid #f1f1f1" }}>
                        <td style={{ ...recruiterInviteCellStyle, fontFamily: "monospace", fontWeight: 700, whiteSpace: "nowrap" }}>
                          <div style={{ userSelect: "all" }}>{visibleCode}</div>
                          {!canCopy && code.codePreview && (
                            <div style={{ marginTop: 3, color: "#999", fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, fontWeight: 500 }}>
                              Stored preview: {code.codePreview}
                            </div>
                          )}
                          {rawMissing && (
                            <div style={{ marginTop: 6, display: "grid", gap: 6, fontFamily: "Inter, system-ui, sans-serif", fontWeight: 500, color: "#7a3e10", fontSize: 11, whiteSpace: "normal", maxWidth: 260 }}>
                              <span>Legacy hash-only row. The full code cannot be revealed because it was never stored.</span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void replaceLegacyCode(code.id)
                                }}
                                disabled={replacingCodeId === code.id}
                                style={{ width: "fit-content", padding: "5px 8px", border: "1px solid #d9b892", borderRadius: 6, background: "#fff7ed", color: "#7a3e10", fontSize: 12 }}
                              >
                                {replacingCodeId === code.id ? "Replacing..." : "Replace and show new code"}
                              </button>
                            </div>
                          )}
                        </td>
                        <td style={{ ...recruiterInviteCellStyle, width: 176 }}>
                          {canCopy ? (
                            <div style={{ display: "flex", gap: 4, flexWrap: "nowrap" }}>
                              <button
                                type="button"
                                title="Copy code"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void navigator.clipboard?.writeText(rawInviteCode)
                                }}
                                style={recruiterInviteButtonStyle}
                              >
                                Code
                              </button>
                              <button
                                type="button"
                                title="Copy invite link"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void navigator.clipboard?.writeText(recruiterInviteUrl(rawInviteCode))
                                }}
                                style={recruiterInviteButtonStyle}
                              >
                                Link
                              </button>
                              {recruiterInviteCanResend(code) && (
                                <button
                                  type="button"
                                  title="Resend invite email"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void resendInvite(code.id)
                                  }}
                                  disabled={resendingAll || resendingCodeId === code.id}
                                  style={recruiterInviteButtonStyle}
                                >
                                  {resendingCodeId === code.id ? "Sending..." : "Resend email"}
                                </button>
                              )}
                            </div>
                          ) : rawMissing ? (
                            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              <input
                                value={restoreInputs[code.id] ?? ""}
                                onChange={(e) => setRestoreInputs((prev) => ({ ...prev, [code.id]: e.target.value }))}
                                placeholder="WK-XXXX-XXXX"
                                style={{ width: 132, padding: "5px 7px", border: "1px solid #ddd", borderRadius: 6, fontSize: 12 }}
                              />
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void restoreKnownCode(code.id)
                                }}
                                disabled={restoringCodeId === code.id}
                                style={{ padding: "5px 8px", border: "1px solid #ccc", borderRadius: 6, background: "#fff", fontSize: 12 }}
                              >
                                {restoringCodeId === code.id ? "Restoring..." : "Restore known code"}
                              </button>
                            </div>
                          ) : (
                            <span style={{ color: "#999" }}>—</span>
                          )}
                        </td>
                        <td style={{ ...recruiterInviteCellStyle, color: code.recruiterEmail ? "#333" : "#999", minWidth: 150 }}>
                          <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{code.recruiterEmail ?? "—"}</div>
                          {code.label && <div style={{ color: "#777", fontSize: 11, marginTop: 2 }}>{code.label}</div>}
                        </td>
                        <td style={recruiterInviteCellStyle}>
                          {(() => {
                            const emailStatus = inviteEmailBadge(code.inviteEmailStatus)
                            return (
                              <div style={{ display: "grid", gap: 4 }}>
                                <Badge tone={emailStatus.tone}>{emailStatus.label}</Badge>
                                {code.inviteEmailSentAt && (
                                  <span style={{ color: "#777", fontSize: 11 }}>{formatCompactOpsDate(code.inviteEmailSentAt)}</span>
                                )}
                                {code.inviteEmailLastError && (
                                  <span style={{ color: "#a00", fontSize: 11, maxWidth: 220, overflowWrap: "anywhere" }}>
                                    {code.inviteEmailLastError}
                                  </span>
                                )}
                              </div>
                            )
                          })()}
                        </td>
                        <td style={recruiterInviteCellStyle}><Badge tone={status.tone}>{status.label}</Badge></td>
                        <td style={{ ...recruiterInviteCellStyle, color: "#666" }}>{formatCodeExpiry(code.expiresAt)}</td>
                        <td style={{ ...recruiterInviteCellStyle, color: "#666" }}>
                          {(() => {
                            const claimedBy = code.lastUsedByUid ? recruiterByUid.get(code.lastUsedByUid) : undefined
                            if (claimedBy && (claimedBy.name || claimedBy.email)) {
                              return (
                                <div style={{ display: "grid", gap: 2 }}>
                                  <span style={{ color: "#333", fontWeight: 600 }}>{claimedBy.name || claimedBy.email}</span>
                                  {claimedBy.name && claimedBy.email && (
                                    <span style={{ color: "#999", fontSize: 11 }}>{claimedBy.email}</span>
                                  )}
                                </div>
                              )
                            }
                            return code.lastUsedByEmail ?? "—"
                          })()}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyOpsText>Send a recruiter invite to create the first one-time access code.</EmptyOpsText>
          )}
        </OpsSection>
      </div>
      <div style={{ marginTop: 18 }}>
        <Panel title="Recruiters" eyebrow={`${rosterRows.length} registered`}>
          <div style={{ ...recruiterAccessScrollPaneStyle, maxHeight: 360 }}>
            <DataTable<RecruiterProfileDoc>
              columns={rosterColumns}
              rows={rosterRows}
              toolbar={false}
              empty={<EmptyOpsText>No recruiter accounts yet. A recruiter appears here after signup.</EmptyOpsText>}
            />
          </div>
        </Panel>
      </div>
      <div style={{ marginTop: 18 }}>
        <OpsSection title="Role alerts" subtitle="One alert is created per active recruiter when a recruiter-board role is released.">
          {notifications.length ? (
            <div style={{ maxHeight: 320, overflow: "auto", paddingRight: 4, scrollbarWidth: "thin" }}>
              {notifications.map((n) => (
                <div key={n.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, padding: "6px 0", borderTop: "1px solid #eee", fontSize: 12 }}>
                  <span>
                    <b>{n.roleTitle ?? "Role"}</b>
                    <br />
                    <span style={{ color: "#777" }}>{n.recruiterEmail ?? "unknown recruiter"} · {formatOpsDate(n.createdAt)}</span>
                  </span>
                  <Badge tone={n.status === "sent" ? "ok" : n.status === "failed" ? "warn" : "muted"}>{n.status ?? "queued"}</Badge>
                </div>
              ))}
            </div>
          ) : (
            <EmptyOpsText>No role notifications yet.</EmptyOpsText>
          )}
        </OpsSection>
      </div>
    </Panel>
  )
}

function RecruiterQualityPanel() {
  const [profiles, setProfiles] = useState<RecruiterProfileDoc[]>([])
  const [submissions, setSubmissions] = useState<SubmissionDoc[]>([])
  const [candidates, setCandidates] = useState<SourcedCandidateDoc[]>([])
  const [applications, setApplications] = useState<RecruiterRoleApplicationDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setErr(null)
    try {
      const [profileSnap, submissionList, candidateSnap, applicationSnap] = await Promise.all([
        getDocs(collection(db(), "pa-recruiter-users")),
        cachedLoad("recruiter-submissions:list", getRecruiterSubmissionsList),
        getDocs(query(collection(db(), "pa-recruiter-sourced-candidates"), limit(1000))),
        getDocs(query(collection(db(), "pa-recruiter-role-applications"), limit(1000))),
      ])
      setProfiles(profileSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterProfileDoc, "id">) })))
      setSubmissions(submissionList.rows as unknown as SubmissionDoc[])
      setCandidates(candidateSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SourcedCandidateDoc, "id">) })))
      setApplications(applicationSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterRoleApplicationDoc, "id">) })))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const managementProfiles = useMemo(
    () => profiles.filter((profile) => !isSyntheticRecruiterProfile(profile)),
    [profiles],
  )

  const rows = useMemo(
    () => computeRecruiterQualityRows(managementProfiles, submissions, candidates, applications),
    [applications, candidates, managementProfiles, submissions],
  )

  const table = useTable<RecruiterQualityRow>(rows, {
    defaultSort: { key: "qualityScore", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      r.name.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q) ||
      (r.profile.reviewNote?.toLowerCase().includes(q) ?? false),
    chips: [
      {
        id: "pace",
        label: "Pace",
        multi: true,
        options: [
          {
            key: "no_work_7d",
            label: "No work 7d",
            title: "Recruiters with no submissions in the last 7 days and no submissions waiting on WeKruit.",
            test: (r: RecruiterQualityRow) => r.submissions7d === 0 && r.pendingWeKruitResponse === 0,
          },
          {
            key: "no_work_14d",
            label: "No work 14d",
            title: "Recruiters with no submissions in the last 14 days and no submissions waiting on WeKruit.",
            test: (r: RecruiterQualityRow) => r.submissions14d === 0 && r.pendingWeKruitResponse === 0,
          },
          {
            key: "needs_wekruit_feedback",
            label: "Needs WK feedback",
            title: "Recruiters with at least one submitted candidate that has no WeKruit response or feedback yet.",
            test: (r: RecruiterQualityRow) => r.pendingWeKruitResponse > 0,
          },
        ],
      },
      {
        id: "status",
        label: "Account",
        multi: true,
        options: ["active", "under_review", "disabled"].map((status) => ({
          key: status,
          label: prettyKey(status),
          test: (r: RecruiterQualityRow) => r.status === status,
        })),
      },
      {
        id: "review",
        label: "Review",
        multi: true,
        options: ["Needs review", "Trusted", "Monitor", "Disabled"].map((label) => ({
          key: label,
          label,
          test: (r: RecruiterQualityRow) => r.reviewLabel === label,
        })),
      },
    ],
  })

  const metrics = {
    total: rows.length,
    needsReview: rows.filter((r) => r.reviewLabel === "Needs review").length,
    avgRating: rows.length
      ? rows
        .filter((r) => r.avgRating !== null)
        .reduce((sum, r, _, ratedRows) => sum + (r.avgRating ?? 0) / Math.max(1, ratedRows.length), 0)
      : 0,
    weeklySubmissions: rows.reduce((sum, r) => sum + r.submissions7d, 0),
    noWork14d: rows.filter((r) => r.submissions14d === 0 && r.pendingWeKruitResponse === 0).length,
    pendingResponse: rows.filter((r) => r.pendingWeKruitResponse > 0).length,
  }

  if (loading) return <LoadingState label="Loading recruiter quality..." />
  if (err) return <ErrorState message={err} />

  const columns: Column<RecruiterQualityRow>[] = [
    {
      key: "name",
      label: "Recruiter",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 600 }}>{r.name}</div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.email}</div>
          {r.profile.reviewNote && <div style={{ color: "#7a3e10", fontSize: 11, marginTop: 2 }}>{r.profile.reviewNote.slice(0, 80)}</div>}
        </>
      ),
    },
    {
      key: "status",
      label: "Account",
      sortable: true,
      width: 130,
      render: (r) => <Badge tone={r.statusTone}>{prettyKey(r.status)}</Badge>,
    },
    {
      key: "reviewLabel",
      label: "Review",
      sortable: true,
      width: 130,
      render: (r) => <Badge tone={r.reviewTone}>{r.reviewLabel}</Badge>,
    },
    {
      key: "qualityScore",
      label: "Quality",
      sortable: true,
      width: 105,
      render: (r) => <b>{r.qualityScore}</b>,
    },
    {
      key: "avgRating",
      label: "Rating",
      sortable: true,
      width: 105,
      render: (r) => r.avgRating === null ? "unrated" : `${r.avgRating.toFixed(1)}/4`,
    },
    {
      key: "pendingWeKruitResponse",
      label: "WK pending",
      sortable: true,
      width: 105,
      render: (r) => r.pendingWeKruitResponse || "—",
    },
    {
      key: "submissions7d",
      label: "7d pace",
      sortable: true,
      width: 105,
      render: (r) => `${r.submissions7d}/${RECRUITER_WEEKLY_SUBMISSION_TARGET}`,
    },
    {
      key: "submissions14d",
      label: "14d",
      sortable: true,
      width: 90,
      render: (r) => r.submissions14d,
    },
    {
      key: "roleCoveragePct",
      label: "Coverage",
      sortable: true,
      width: 110,
      render: (r) => r.approvedRoles ? `${r.coveredApprovedRoles}/${r.approvedRoles} · ${r.roleCoveragePct}%` : "no approved roles",
    },
    {
      key: "movementRate",
      label: "Movement",
      sortable: true,
      width: 105,
      render: (r) => `${r.movementRate}%`,
    },
    {
      key: "lastSubmissionMs",
      label: "Last submission",
      sortable: true,
      width: 130,
      render: (r) => formatCompactOpsDate(r.lastSubmissionMs),
    },
    {
      key: "lastActivityMs",
      label: "Last activity",
      sortable: true,
      width: 130,
      render: (r) => formatCompactOpsDate(r.lastActivityMs),
    },
  ]

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Recruiters" value={metrics.total} />
        <OpsMetric label="Needs review" value={metrics.needsReview} />
        <OpsMetric label="Pending response" value={metrics.pendingResponse} />
        <OpsMetric label="No work 14d" value={metrics.noWork14d} />
        <OpsMetric label="Avg rating" value={metrics.avgRating ? `${metrics.avgRating.toFixed(1)}/4` : "unrated"} />
        <OpsMetric label="7d submissions" value={metrics.weeklySubmissions} meta={`Target ${rows.length * RECRUITER_WEEKLY_SUBMISSION_TARGET}`} />
      </div>
      <Panel actions={<button type="button" onClick={() => void reload()}>Refresh</button>}>
        <DataTable<RecruiterQualityRow>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search recruiter / review note..."
          sort={table.sort}
          onSort={table.toggleSort}
          page={table.page}
          pageCount={table.pageCount}
          onPageChange={table.setPage}
          onResetFilters={table.reset}
          count={table.filteredCount}
          totalCount={table.totalRows}
          onRowClick={(r) => setExpandedId(expandedId === r.id ? null : r.id)}
          empty={
            <div style={{ padding: 40, textAlign: "center", color: "#777" }}>
              No recruiter accounts yet.
            </div>
          }
        />
      </Panel>
      {expandedId && (() => {
        const row = rows.find((r) => r.id === expandedId)
        if (!row) return null
        return (
          <RecruiterQualityDetailPanel
            row={row}
            onClose={() => setExpandedId(null)}
            onUpdated={(profile) => {
              setProfiles((prev) => prev.map((p) => p.id === profile.id ? { ...p, ...profile } : p))
            }}
          />
        )
      })()}
    </div>
  )
}

function RecruiterQualityDetailPanel({
  row,
  onClose,
  onUpdated,
}: {
  row: RecruiterQualityRow
  onClose: () => void
  onUpdated: (profile: RecruiterProfileDoc) => void
}) {
  const [status, setStatus] = useState(row.status)
  const [reviewNote, setReviewNote] = useState(row.profile.reviewNote ?? "")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const saveReview = async () => {
    setSaving(true)
    setErr(null)
    try {
      const reviewUpdatedByEmail = auth().currentUser?.email ?? "operator"
      const cleanNote = reviewNote.trim()
      await updateDoc(doc(db(), "pa-recruiter-users", row.profile.id), {
        status,
        reviewNote: cleanNote || null,
        reviewUpdatedByEmail,
        reviewUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        accountReviewHistory: arrayUnion({
          status,
          by: "admin",
          adminEmail: reviewUpdatedByEmail,
          atIso: new Date().toISOString(),
          ...(cleanNote ? { note: cleanNote } : {}),
        }),
      })
      onUpdated({
        ...row.profile,
        status,
        reviewNote: cleanNote || null,
        reviewUpdatedByEmail,
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel title="Recruiter account review" eyebrow={row.email}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Quality score" value={row.qualityScore} meta={row.reviewLabel} />
        <OpsMetric label="Rating" value={row.avgRating === null ? "unrated" : `${row.avgRating.toFixed(1)}/4`} />
        <OpsMetric label="WK pending" value={row.pendingWeKruitResponse} meta={row.pendingWeKruitResponse ? "needs our response" : "clear"} />
        <OpsMetric label="7d pace" value={`${row.submissions7d}/${RECRUITER_WEEKLY_SUBMISSION_TARGET}`} meta={`${row.weeklyTargetPct}% of target`} />
        <OpsMetric label="14d submissions" value={row.submissions14d} meta={row.lastSubmissionMs ? `Last ${formatCompactOpsDate(row.lastSubmissionMs)}` : "never submitted"} />
        <OpsMetric label="Coverage" value={row.approvedRoles ? `${row.coveredApprovedRoles}/${row.approvedRoles}` : "0"} meta={row.approvedRoles ? `${row.roleCoveragePct}% approved roles active` : "no approved roles"} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
          <div><b>Recruiter:</b> {row.name}</div>
          <div><b>Email:</b> {row.email}</div>
          <div><b>Total submissions:</b> {row.submissionsTotal}</div>
          <div><b>Last submission:</b> {formatOpsDate(row.lastSubmissionMs)}</div>
          <div><b>Pending WeKruit response:</b> {row.pendingWeKruitResponse}</div>
          <div><b>Active submissions:</b> {row.activeSubmissions}</div>
          <div><b>Advanced/interview/offer/hired:</b> {row.advancedCount} ({row.movementRate}%)</div>
          <div><b>Rejected/duplicate drag:</b> {row.rejectionDrag}%</div>
          <div><b>Sourced candidates:</b> {row.sourcedActive} active · {row.readyCandidates} ready</div>
          <div><b>Role applications:</b> {row.approvedRoles} approved · {row.pendingApplications} pending</div>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#555" }}>
            Account status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 8, font: "inherit", color: "#222" }}
            >
              {["active", "under_review", "disabled"].map((s) => <option key={s} value={s}>{prettyKey(s)}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#555" }}>
            Admin review note
            <textarea
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              rows={6}
              placeholder="Why this recruiter should get more access, be monitored, or be disabled..."
              style={{ resize: "vertical", padding: 10, border: "1px solid #ddd", borderRadius: 8, font: "inherit", color: "#222" }}
            />
          </label>
        </div>
      </div>
      {status === "disabled" && (
        <div style={{ marginTop: 14, border: "1px solid #efc56f", borderRadius: 8, background: "#fffaf1", padding: 12, color: "#5c3b05", fontSize: 13 }}>
          Disabling a recruiter blocks the recruiter-board functions from loading this account.
        </div>
      )}
      {err && <div style={{ color: "#a00", fontSize: 13, marginTop: 10 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        <button type="button" onClick={() => void saveReview()} disabled={saving}>
          {saving ? "Saving..." : "Save account review"}
        </button>
        <button type="button" onClick={onClose} disabled={saving}>Close</button>
      </div>
    </Panel>
  )
}

function calibrationTone(status?: string): Parameters<typeof Badge>[0]["tone"] {
  switch (status) {
    case "good_fit": return "ok"
    case "bad_fit": return "warn"
    case "calibration_requested": return "info"
    case "suggested": return "info"
    default: return "muted"
  }
}

function stageTone(stage?: string): Parameters<typeof Badge>[0]["tone"] {
  switch (stage) {
    case "ready": return "ok"
    case "submitted": return "info"
    case "archived": return "muted"
    case "screened": return "info"
    case "contacted": return "info"
    default: return "muted"
  }
}

function difficultyTone(difficulty?: string): Parameters<typeof Badge>[0]["tone"] {
  switch (difficulty) {
    case "blocked": return "warn"
    case "hard": return "info"
    case "easy": return "ok"
    default: return "muted"
  }
}

function prettyKey(value?: string | null): string {
  return value ? value.replace(/_/g, " ") : "not rated"
}

function RecruiterSourcedCandidatesPanel() {
  const [rows, setRows] = useState<SourcedCandidateDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setErr(null)
    try {
      const snap = await getDocs(query(
        collection(db(), "pa-recruiter-sourced-candidates"),
        orderBy("updatedAt", "desc"),
        limit(500),
      ))
      setRows(snap.docs.map((d) => {
        const data = d.data() as Omit<SourcedCandidateDoc, "id">
        return { id: d.id, ...data, updatedAtMs: timestampToMs(data.updatedAt ?? data.createdAt) }
      }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      const id = r.inboundJobId ?? r.jobId
      if (id && !seen.has(id)) seen.set(id, r.jobTitleSnapshot ?? id)
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: SourcedCandidateDoc) => r.inboundJobId === jobId || r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<SourcedCandidateDoc>(rows, {
    defaultSort: { key: "updatedAtMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.recruiterEmail?.toLowerCase().includes(q) ?? false) ||
      (r.candidate?.name?.toLowerCase().includes(q) ?? false) ||
      (r.candidate?.link?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.companyLabelSnapshot?.toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "stage",
        label: "Stage",
        multi: true,
        options: SOURCE_STAGE_VALUES.map((s) => ({
          key: s,
          label: s,
          test: (r: SourcedCandidateDoc) => (r.stage ?? "sourced") === s,
        })),
      },
      {
        id: "calibration",
        label: "Calibration",
        multi: true,
        options: CALIBRATION_VALUES.map((s) => ({
          key: s,
          label: prettyKey(s),
          test: (r: SourcedCandidateDoc) => (r.calibrationStatus ?? "not_rated") === s,
        })),
      },
    ],
  })

  const metrics = {
    total: rows.length,
    ready: rows.filter((r) => r.stage === "ready").length,
    submitted: rows.filter((r) => r.stage === "submitted").length,
    needsReview: rows.filter((r) => !r.calibrationStatus || r.calibrationStatus === "not_rated" || r.calibrationStatus === "calibration_requested").length,
  }

  if (loading) return <LoadingState label="Loading sourced candidates..." />
  if (err) return <ErrorState message={err} />

  const columns: Column<SourcedCandidateDoc>[] = [
    {
      key: "updatedAtMs",
      label: "Updated",
      sortable: true,
      width: 160,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatOpsDate(r.updatedAt ?? r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Role",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "—"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "recruiterEmail",
      label: "Recruiter",
      sortable: true,
      render: (r) => r.recruiterEmail ?? r.recruiterId ?? "—",
    },
    {
      key: "candidate",
      label: "Candidate",
      render: (r) => (
        <>
          <div>{r.candidate?.name ?? "—"}</div>
          {r.candidate?.link && (
            <a
              href={r.candidate.link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ fontSize: 11, color: "#2a5fb8" }}
            >
              {r.candidate.link.length > 42 ? r.candidate.link.slice(0, 42) + "..." : r.candidate.link}
            </a>
          )}
        </>
      ),
    },
    {
      key: "stage",
      label: "Stage",
      sortable: true,
      width: 120,
      render: (r) => <Badge tone={stageTone(r.stage)}>{r.stage ?? "sourced"}</Badge>,
    },
    {
      key: "calibrationStatus",
      label: "Calibration",
      sortable: true,
      width: 140,
      render: (r) => <Badge tone={calibrationTone(r.calibrationStatus)}>{prettyKey(r.calibrationStatus)}</Badge>,
    },
    {
      key: "calibrationNote",
      label: "Feedback",
      width: 180,
      render: (r) => r.calibrationNote ? (r.calibrationNote.length > 44 ? r.calibrationNote.slice(0, 44) + "..." : r.calibrationNote) : "—",
    },
  ]

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Sourced" value={metrics.total} />
        <OpsMetric label="Ready" value={metrics.ready} />
        <OpsMetric label="Submitted" value={metrics.submitted} />
        <OpsMetric label="Needs calibration" value={metrics.needsReview} />
      </div>
      <Panel>
        <DataTable<SourcedCandidateDoc>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search recruiter / candidate / role..."
          sort={table.sort}
          onSort={table.toggleSort}
          page={table.page}
          pageCount={table.pageCount}
          onPageChange={table.setPage}
          onResetFilters={table.reset}
          count={table.filteredCount}
          totalCount={table.totalRows}
          onRowClick={(r) => setExpandedId(expandedId === r.id ? null : r.id ?? null)}
          empty={
            <div style={{ padding: 40, textAlign: "center", color: "#777" }}>
              No sourced candidates match the current filters.
            </div>
          }
        />
      </Panel>
      {expandedId && (() => {
        const row = rows.find((r) => r.id === expandedId)
        if (!row) return null
        return (
          <SourcedCandidateDetailPanel
            row={row}
            onClose={() => setExpandedId(null)}
            onUpdated={(next) => {
              setRows((prev) => prev.map((r) => r.id === next.id ? { ...r, ...next, updatedAtMs: Date.now() } : r))
            }}
          />
        )
      })()}
    </div>
  )
}

function RecruiterRoleFeedbackPanel() {
  const [rows, setRows] = useState<RecruiterRoleFeedbackDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setErr(null)
    try {
      const snap = await getDocs(query(
        collection(db(), "pa-recruiter-role-feedback"),
        orderBy("updatedAt", "desc"),
        limit(500),
      ))
      setRows(snap.docs.map((d) => {
        const data = d.data() as Omit<RecruiterRoleFeedbackDoc, "id">
        return { id: d.id, ...data, updatedAtMs: timestampToMs(data.updatedAt ?? data.createdAt) }
      }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      const id = r.inboundJobId ?? r.jobId
      if (id && !seen.has(id)) seen.set(id, r.jobTitleSnapshot ?? id)
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: RecruiterRoleFeedbackDoc) => r.inboundJobId === jobId || r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<RecruiterRoleFeedbackDoc>(rows, {
    defaultSort: { key: "updatedAtMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.recruiterEmail?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.companyLabelSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.note?.toLowerCase().includes(q) ?? false) ||
      (r.reasons?.join(" ").toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "difficulty",
        label: "Difficulty",
        multi: true,
        options: ["easy", "medium", "hard", "blocked"].map((s) => ({
          key: s,
          label: s,
          test: (r: RecruiterRoleFeedbackDoc) => (r.difficulty ?? "medium") === s,
        })),
      },
      {
        id: "reason",
        label: "Reason",
        multi: true,
        options: [
          "low_comp",
          "location_mismatch",
          "unclear_requirements",
          "small_candidate_pool",
          "hiring_team_slow",
          "role_too_broad",
          "candidate_interest_low",
          "too_many_recruiters",
          "other",
        ].map((s) => ({
          key: s,
          label: prettyKey(s),
          test: (r: RecruiterRoleFeedbackDoc) => r.reasons?.includes(s) ?? false,
        })),
      },
    ],
  })

  const metrics = {
    total: rows.length,
    hard: rows.filter((r) => r.difficulty === "hard").length,
    blocked: rows.filter((r) => r.difficulty === "blocked").length,
    noted: rows.filter((r) => Boolean(r.note)).length,
  }

  if (loading) return <LoadingState label="Loading role feedback..." />
  if (err) return <ErrorState message={err} />

  const columns: Column<RecruiterRoleFeedbackDoc>[] = [
    {
      key: "updatedAtMs",
      label: "Updated",
      sortable: true,
      width: 160,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatOpsDate(r.updatedAt ?? r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Role",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "—"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "recruiterEmail",
      label: "Recruiter",
      sortable: true,
      render: (r) => r.recruiterEmail ?? r.recruiterId ?? "—",
    },
    {
      key: "difficulty",
      label: "Difficulty",
      sortable: true,
      width: 120,
      render: (r) => <Badge tone={difficultyTone(r.difficulty)}>{r.difficulty ?? "medium"}</Badge>,
    },
    {
      key: "reasons",
      label: "Reasons",
      render: (r) => (r.reasons?.length ? r.reasons.map(prettyKey).join(", ") : "—"),
    },
    {
      key: "note",
      label: "Note",
      render: (r) => r.note ? (r.note.length > 92 ? r.note.slice(0, 92) + "..." : r.note) : "—",
    },
  ]

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Feedback rows" value={metrics.total} />
        <OpsMetric label="Hard roles" value={metrics.hard} />
        <OpsMetric label="Blocked roles" value={metrics.blocked} />
        <OpsMetric label="With notes" value={metrics.noted} />
      </div>
      <Panel actions={<button type="button" onClick={() => void reload()}>Refresh</button>}>
        <DataTable<RecruiterRoleFeedbackDoc>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search recruiter / role / blocker..."
          sort={table.sort}
          onSort={table.toggleSort}
          page={table.page}
          pageCount={table.pageCount}
          onPageChange={table.setPage}
          onResetFilters={table.reset}
          count={table.filteredCount}
          totalCount={table.totalRows}
          empty={
            <div style={{ padding: 40, textAlign: "center", color: "#777" }}>
              No recruiter role feedback yet.
            </div>
          }
        />
      </Panel>
    </div>
  )
}

function applicationStatusTone(status?: string): Parameters<typeof Badge>[0]["tone"] {
  switch (status) {
    case "approved": return "ok"
    case "pending": return "info"
    case "not_approved":
    case "rescinded": return "warn"
    default: return "muted"
  }
}

function RecruiterRoleApplicationsPanel() {
  const [rows, setRows] = useState<RecruiterRoleApplicationDoc[]>([])
  const [profiles, setProfiles] = useState<RecruiterProfileDoc[]>([])
  const [submissions, setSubmissions] = useState<SubmissionDoc[]>([])
  const [sourcedCandidates, setSourcedCandidates] = useState<SourcedCandidateDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setErr(null)
    try {
      const [applicationSnap, profileSnap, submissionSnap, sourcedSnap] = await Promise.all([
        getDocs(query(
          collection(db(), "pa-recruiter-role-applications"),
          orderBy("updatedAt", "desc"),
          limit(500),
        )),
        getDocs(collection(db(), "pa-recruiter-users")),
        getDocs(query(collection(db(), "pa-recruiter-submissions"), limit(1000))),
        getDocs(query(collection(db(), "pa-recruiter-sourced-candidates"), limit(1000))),
      ])
      setRows(applicationSnap.docs.map((d) => {
        const data = d.data() as Omit<RecruiterRoleApplicationDoc, "id">
        return { id: d.id, ...data, updatedAtMs: timestampToMs(data.updatedAt ?? data.createdAt) }
      }))
      setProfiles(profileSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterProfileDoc, "id">) })))
      setSubmissions(submissionSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SubmissionDoc, "id">) })))
      setSourcedCandidates(sourcedSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SourcedCandidateDoc, "id">) })))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      const id = r.inboundJobId ?? r.jobId
      if (id && !seen.has(id)) seen.set(id, r.jobTitleSnapshot ?? id)
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: RecruiterRoleApplicationDoc) => r.inboundJobId === jobId || r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<RecruiterRoleApplicationDoc>(rows, {
    defaultSort: { key: "updatedAtMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.recruiterEmail?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.companyLabelSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.pitch?.toLowerCase().includes(q) ?? false) ||
      (r.adminNote?.toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "status",
        label: "Status",
        multi: true,
        options: ["pending", "approved", "not_approved", "withdrawn", "rescinded"].map((s) => ({
          key: s,
          label: prettyKey(s),
          test: (r: RecruiterRoleApplicationDoc) => (r.status ?? "pending") === s,
        })),
      },
    ],
  })

  const metrics = {
    total: rows.length,
    pending: rows.filter((r) => r.status === "pending").length,
    approved: rows.filter((r) => r.status === "approved").length,
    withProof: rows.filter((r) => (r.preparedCandidateCount ?? 0) > 0).length,
  }
  const reviewsById = useMemo(() => {
    const map = new Map<string, RoleApplicationReview>()
    for (const row of rows) {
      map.set(row.id, buildRoleApplicationReview({
        application: row,
        profiles,
        submissions,
        candidates: sourcedCandidates,
        applications: rows,
      }))
    }
    return map
  }, [profiles, rows, sourcedCandidates, submissions])
  const recommendationMetrics = {
    approve: [...reviewsById.values()].filter((review) => review.recommendation === "approve").length,
    review: [...reviewsById.values()].filter((review) => review.recommendation === "review").length,
    decline: [...reviewsById.values()].filter((review) => review.recommendation === "decline").length,
  }

  if (loading) return <LoadingState label="Loading recruiter applications..." />
  if (err) return <ErrorState message={err} />

  const columns: Column<RecruiterRoleApplicationDoc>[] = [
    {
      key: "updatedAtMs",
      label: "Updated",
      sortable: true,
      width: 160,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatOpsDate(r.updatedAt ?? r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Role",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "—"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "recruiterEmail",
      label: "Recruiter",
      sortable: true,
      render: (r) => r.recruiterEmail ?? r.recruiterId ?? "—",
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      width: 130,
      render: (r) => <Badge tone={applicationStatusTone(r.status)}>{prettyKey(r.status ?? "pending")}</Badge>,
    },
    {
      key: "recommendation",
      label: "Decision signal",
      width: 170,
      render: (r) => {
        const review = reviewsById.get(r.id)
        if (!review) return "—"
        return (
          <>
            <Badge tone={review.tone}>{prettyKey(review.recommendation)}</Badge>
            <div style={{ marginTop: 4, color: "#777", fontSize: 11 }}>{review.metrics.qualityScore}/100 · {review.metrics.interviewRate}% interview</div>
          </>
        )
      },
    },
    {
      key: "preparedCandidateCount",
      label: "Proof",
      sortable: true,
      width: 90,
      render: (r) => `${r.preparedCandidateCount ?? r.preparedCandidateIds?.length ?? 0}`,
    },
    {
      key: "pitch",
      label: "Pitch",
      render: (r) => r.pitch ? (r.pitch.length > 96 ? `${r.pitch.slice(0, 96)}...` : r.pitch) : "—",
    },
  ]

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Applications" value={metrics.total} />
        <OpsMetric label="Pending review" value={metrics.pending} />
        <OpsMetric label="Approved" value={metrics.approved} />
        <OpsMetric label="With candidate proof" value={metrics.withProof} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, margin: "-4px 0 16px" }}>
        <OpsMetric label="Approve-ready" value={recommendationMetrics.approve} />
        <OpsMetric label="Needs operator review" value={recommendationMetrics.review} />
        <OpsMetric label="Decline signal" value={recommendationMetrics.decline} />
      </div>
      <Panel actions={<button type="button" onClick={() => void reload()}>Refresh</button>}>
        <DataTable<RecruiterRoleApplicationDoc>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search recruiter / role / pitch..."
          sort={table.sort}
          onSort={table.toggleSort}
          page={table.page}
          pageCount={table.pageCount}
          onPageChange={table.setPage}
          onResetFilters={table.reset}
          count={table.filteredCount}
          totalCount={table.totalRows}
          onRowClick={(r) => setExpandedId(expandedId === r.id ? null : r.id ?? null)}
          empty={
            <div style={{ padding: 40, textAlign: "center", color: "#777" }}>
              No recruiter role applications yet.
            </div>
          }
        />
      </Panel>
      {expandedId && (() => {
        const row = rows.find((r) => r.id === expandedId)
        if (!row) return null
        return (
          <RoleApplicationDetailPanel
            row={row}
            review={reviewsById.get(row.id) ?? buildRoleApplicationReview({
              application: row,
              profiles,
              submissions,
              candidates: sourcedCandidates,
              applications: rows,
            })}
            onClose={() => setExpandedId(null)}
            onUpdated={(next) => {
              setRows((prev) => prev.map((r) => r.id === next.id ? { ...r, ...next, updatedAtMs: Date.now() } : r))
            }}
          />
        )
      })()}
    </div>
  )
}

function RoleApplicationDetailPanel({
  row,
  review,
  onClose,
  onUpdated,
}: {
  row: RecruiterRoleApplicationDoc
  review: RoleApplicationReview
  onClose: () => void
  onUpdated: (next: RecruiterRoleApplicationDoc) => void
}) {
  const [status, setStatus] = useState(row.status ?? "pending")
  const [adminNote, setAdminNote] = useState(row.adminNote ?? "")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const saveReview = async () => {
    setSaving(true)
    setErr(null)
    try {
      const reviewedByEmail = auth().currentUser?.email ?? "operator"
      const cleanNote = adminNote.trim()
      await updateDoc(doc(db(), "pa-recruiter-role-applications", row.id), {
        status,
        adminNote: cleanNote || null,
        adminReviewRecommendation: review.recommendation,
        adminReviewQualityScore: review.metrics.qualityScore,
        adminReviewEvidence: review.evidence.slice(0, 8),
        adminReviewRisks: review.risks.slice(0, 8),
        reviewedByEmail,
        reviewedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        statusHistory: arrayUnion({
          status,
          by: "admin",
          adminEmail: reviewedByEmail,
          atIso: new Date().toISOString(),
          ...(cleanNote ? { note: cleanNote } : {}),
        }),
      })
      onUpdated({
        ...row,
        status,
        adminNote: cleanNote || null,
        reviewedByEmail,
        updatedAtMs: Date.now(),
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel title="Review role application" eyebrow={row.jobTitleSnapshot ?? row.jobId ?? "Role application"}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
          <div><b>Recruiter:</b> {row.recruiterEmail ?? row.recruiterId ?? "—"}</div>
          <div><b>Role:</b> {row.jobId ? <AdminJobLink jobId={row.jobId}>{row.jobTitleSnapshot ?? row.jobId}</AdminJobLink> : row.jobTitleSnapshot ?? "—"}</div>
          <div><b>Prepared candidates:</b> {row.preparedCandidateCount ?? row.preparedCandidateIds?.length ?? 0}</div>
          <div><b>Anonymized:</b> {row.anonymizeCandidates ? "yes" : "no"}</div>
        </div>
        <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 8, background: "#faf8f4", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
          <b>Recruiter pitch:</b>
          <br />
          {row.pitch ?? "—"}
        </div>
      </div>
      <section style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(260px, .78fr) minmax(0, 1.22fr)", gap: 14 }}>
        <article style={{ display: "grid", gap: 10, alignContent: "start", border: "1px solid #eee", borderLeft: `4px solid ${review.tone === "ok" ? "#2f7d32" : review.tone === "warn" ? "#a33a2d" : "#b77c2f"}`, borderRadius: 8, background: "#fff", padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ color: "#777", fontSize: 11, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase" }}>Decision signal</span>
            <Badge tone={review.tone}>{prettyKey(review.recommendation)}</Badge>
          </div>
          <strong style={{ color: "#1a1a1a", fontSize: 16 }}>{review.headline}</strong>
          <p style={{ margin: 0, color: "#555", fontSize: 13, lineHeight: 1.45 }}>{review.rationale}</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            <OpsMiniStat label="Quality" value={`${review.metrics.qualityScore}/100`} />
            <OpsMiniStat label="Avg rating" value={review.metrics.avgRating === null ? "unrated" : `${review.metrics.avgRating.toFixed(1)}/4`} />
            <OpsMiniStat label="Interview" value={`${review.metrics.interviewRate}%`} />
            <OpsMiniStat label="Role load" value={`${review.metrics.approvedRoles}/10`} />
          </div>
        </article>
        <article style={{ display: "grid", gap: 12, border: "1px solid #eee", borderRadius: 8, background: "#fff", padding: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Evidence</h4>
              <ul style={{ margin: 0, paddingLeft: 18, color: "#444", fontSize: 12.5, lineHeight: 1.45 }}>
                {review.evidence.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
            <div>
              <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Risks</h4>
              {review.risks.length ? (
                <ul style={{ margin: 0, paddingLeft: 18, color: "#6f2d24", fontSize: 12.5, lineHeight: 1.45 }}>
                  {review.risks.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : (
                <p style={{ margin: 0, color: "#777", fontSize: 12.5 }}>No hard approval risk detected.</p>
              )}
            </div>
          </div>
          <div>
            <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Prepared candidates</h4>
            {review.preparedCandidates.length ? (
              <div style={{ display: "grid", gap: 7 }}>
                {review.preparedCandidates.map((candidate) => (
                  <div key={candidate.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center", border: "1px solid #eee", borderRadius: 8, background: "#faf8f4", padding: 9 }}>
                    <span style={{ minWidth: 0 }}>
                      <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#222", fontSize: 12.5 }}>{candidate.label}</b>
                      <em style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#777", fontSize: 11.5, fontStyle: "normal" }}>{candidate.headline}</em>
                    </span>
                    <Badge tone={candidate.stage === "ready" || candidate.stage === "submitted" ? "ok" : "muted"}>{prettyKey(candidate.stage)}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ margin: 0, color: "#777", fontSize: 12.5 }}>No prepared candidate proof attached to this application.</p>
            )}
          </div>
        </article>
      </section>
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid #eee", display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#555" }}>
          Review status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as NonNullable<RecruiterRoleApplicationDoc["status"]>)}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 8, font: "inherit", color: "#222" }}
          >
            {["pending", "approved", "not_approved", "rescinded"].map((s) => <option key={s} value={s}>{prettyKey(s)}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#555" }}>
          Recruiter-visible note
          <textarea
            value={adminNote}
            onChange={(e) => setAdminNote(e.target.value)}
            rows={5}
            placeholder="Why approved, what proof is missing, or what to improve before reapplying..."
            style={{ resize: "vertical", padding: 10, border: "1px solid #ddd", borderRadius: 8, font: "inherit", color: "#222" }}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setAdminNote(review.noteTemplate)
            setStatus(review.recommendation === "approve" ? "approved" : review.recommendation === "decline" ? "not_approved" : "pending")
          }}
          disabled={saving}
          style={{ justifySelf: "start" }}
        >
          Use decision template
        </button>
        {err && <div style={{ color: "#a00", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => void saveReview()} disabled={saving}>
            {saving ? "Saving..." : "Save review"}
          </button>
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
      </div>
    </Panel>
  )
}

function questionStatusTone(status?: string): Parameters<typeof Badge>[0]["tone"] {
  return status === "answered" ? "ok" : "info"
}

function RecruiterRoleQuestionsPanel() {
  const [rows, setRows] = useState<RecruiterRoleQuestionDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setErr(null)
    try {
      const snap = await getDocs(query(
        collection(db(), "pa-recruiter-role-questions"),
        orderBy("updatedAt", "desc"),
        limit(500),
      ))
      setRows(snap.docs.map((d) => {
        const data = d.data() as Omit<RecruiterRoleQuestionDoc, "id">
        return { id: d.id, ...data, updatedAtMs: timestampToMs(data.updatedAt ?? data.createdAt) }
      }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      const id = r.inboundJobId ?? r.jobId
      if (id && !seen.has(id)) seen.set(id, r.jobTitleSnapshot ?? id)
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: RecruiterRoleQuestionDoc) => r.inboundJobId === jobId || r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<RecruiterRoleQuestionDoc>(rows, {
    defaultSort: { key: "updatedAtMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.recruiterEmail?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.companyLabelSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.question?.toLowerCase().includes(q) ?? false) ||
      (r.answer?.toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "status",
        label: "Status",
        multi: true,
        options: ["open", "answered"].map((s) => ({
          key: s,
          label: s,
          test: (r: RecruiterRoleQuestionDoc) => (r.status ?? "open") === s,
        })),
      },
    ],
  })

  const metrics = {
    total: rows.length,
    open: rows.filter((r) => (r.status ?? "open") === "open").length,
    answered: rows.filter((r) => r.status === "answered").length,
    recruiters: new Set(rows.map((r) => r.recruiterEmail ?? r.recruiterId).filter(Boolean)).size,
  }

  if (loading) return <LoadingState label="Loading recruiter questions..." />
  if (err) return <ErrorState message={err} />

  const columns: Column<RecruiterRoleQuestionDoc>[] = [
    {
      key: "updatedAtMs",
      label: "Updated",
      sortable: true,
      width: 160,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatOpsDate(r.updatedAt ?? r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Role",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "—"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "recruiterEmail",
      label: "Recruiter",
      sortable: true,
      render: (r) => r.recruiterEmail ?? r.recruiterId ?? "—",
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      width: 110,
      render: (r) => <Badge tone={questionStatusTone(r.status)}>{r.status ?? "open"}</Badge>,
    },
    {
      key: "question",
      label: "Question",
      render: (r) => r.question ? (r.question.length > 96 ? r.question.slice(0, 96) + "..." : r.question) : "—",
    },
    {
      key: "answer",
      label: "Answer",
      render: (r) => r.answer ? (r.answer.length > 80 ? r.answer.slice(0, 80) + "..." : r.answer) : "—",
    },
  ]

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Questions" value={metrics.total} />
        <OpsMetric label="Open" value={metrics.open} />
        <OpsMetric label="Answered" value={metrics.answered} />
        <OpsMetric label="Recruiters" value={metrics.recruiters} />
      </div>
      <Panel actions={<button type="button" onClick={() => void reload()}>Refresh</button>}>
        <DataTable<RecruiterRoleQuestionDoc>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search recruiter / role / question..."
          sort={table.sort}
          onSort={table.toggleSort}
          page={table.page}
          pageCount={table.pageCount}
          onPageChange={table.setPage}
          onResetFilters={table.reset}
          count={table.filteredCount}
          totalCount={table.totalRows}
          onRowClick={(r) => setExpandedId(expandedId === r.id ? null : r.id ?? null)}
          empty={
            <div style={{ padding: 40, textAlign: "center", color: "#777" }}>
              No recruiter role questions yet.
            </div>
          }
        />
      </Panel>
      {expandedId && (() => {
        const row = rows.find((r) => r.id === expandedId)
        if (!row) return null
        return (
          <RoleQuestionDetailPanel
            row={row}
            onClose={() => setExpandedId(null)}
            onUpdated={(next) => {
              setRows((prev) => prev.map((r) => r.id === next.id ? { ...r, ...next, updatedAtMs: Date.now() } : r))
            }}
          />
        )
      })()}
    </div>
  )
}

function RoleQuestionDetailPanel({
  row,
  onClose,
  onUpdated,
}: {
  row: RecruiterRoleQuestionDoc
  onClose: () => void
  onUpdated: (next: RecruiterRoleQuestionDoc) => void
}) {
  const [answer, setAnswer] = useState(row.answer ?? "")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const saveAnswer = async () => {
    const trimmed = answer.trim()
    if (!trimmed) {
      setErr("Answer is required.")
      return
    }
    setSaving(true)
    setErr(null)
    try {
      const answeredByEmail = auth().currentUser?.email ?? "operator"
      await updateDoc(doc(db(), "pa-recruiter-role-questions", row.id), {
        answer: trimmed,
        status: "answered",
        answeredByEmail,
        answeredAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      onUpdated({
        ...row,
        answer: trimmed,
        status: "answered",
        answeredByEmail,
        updatedAtMs: Date.now(),
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel title="Answer recruiter question" eyebrow={row.jobTitleSnapshot ?? row.jobId ?? "Role question"}>
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
          <div><b>Recruiter:</b> {row.recruiterEmail ?? row.recruiterId ?? "—"}</div>
          <div><b>Role:</b> {row.jobId ? <AdminJobLink jobId={row.jobId}>{row.jobTitleSnapshot ?? row.jobId}</AdminJobLink> : row.jobTitleSnapshot ?? "—"}</div>
          <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 8, background: "#faf8f4", lineHeight: 1.5 }}>
            <b>Question:</b> {row.question ?? "—"}
          </div>
        </div>
        <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#555" }}>
          Recruiter-visible answer
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={5}
            style={{ resize: "vertical", padding: 10, border: "1px solid #ddd", borderRadius: 8, font: "inherit", color: "#222" }}
          />
        </label>
        {err && <div style={{ color: "#a00", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => void saveAnswer()} disabled={saving || !answer.trim()}>
            {saving ? "Saving..." : "Save answer"}
          </button>
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
      </div>
    </Panel>
  )
}

function SourcedCandidateDetailPanel({
  row,
  onClose,
  onUpdated,
}: {
  row: SourcedCandidateDoc
  onClose: () => void
  onUpdated: (row: Partial<SourcedCandidateDoc> & { id: string }) => void
}) {
  const [draftStage, setDraftStage] = useState(row.stage ?? "sourced")
  const [draftCalibration, setDraftCalibration] = useState(row.calibrationStatus ?? "not_rated")
  const [draftNote, setDraftNote] = useState(row.calibrationNote ?? "")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await updateDoc(doc(db(), "pa-recruiter-sourced-candidates", row.id), {
        stage: draftStage,
        calibrationStatus: draftCalibration,
        calibrationNote: draftNote.trim() || null,
        calibrationUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        calibrationHistory: arrayUnion({
          stage: draftStage,
          calibrationStatus: draftCalibration,
          note: draftNote.trim() || null,
          by: "admin",
          atIso: new Date().toISOString(),
        }),
      })
      onUpdated({
        id: row.id,
        stage: draftStage,
        calibrationStatus: draftCalibration,
        calibrationNote: draftNote.trim() || null,
        calibrationUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      title="Sourced candidate calibration"
      actions={
        <button
          onClick={onClose}
          style={{ border: "none", background: "none", cursor: "pointer", color: "#888", fontSize: 16 }}
          aria-label="Close"
        >
          x
        </button>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>Candidate</h4>
          <p style={{ margin: 0, fontSize: 13 }}>
            <strong>{row.candidate?.name ?? "Candidate"}</strong>
            {row.candidate?.currentRole && <> - {row.candidate.currentRole}</>}
            {row.candidate?.yoe && <> - {row.candidate.yoe} YOE</>}
          </p>
          {row.candidate?.link && (
            <p style={{ margin: "4px 0 0", fontSize: 12 }}>
              <a href={row.candidate.link} target="_blank" rel="noopener noreferrer">{row.candidate.link}</a>
            </p>
          )}
          {row.candidate?.compensationExpectation && (
            <p style={{ margin: "8px 0 0", fontSize: 12.5 }}>
              <strong>Expected salary:</strong> {row.candidate.compensationExpectation}
            </p>
          )}
          {row.candidate?.notes && (
            <>
              <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>Recruiter note</h4>
              <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{row.candidate.notes}</p>
            </>
          )}
        </div>
        <div>
          <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>Role</h4>
          <p style={{ margin: 0, fontSize: 13 }}>
            <strong>{row.jobTitleSnapshot ?? row.jobId ?? "Role"}</strong>
            <br />
            <span style={{ color: "#777" }}>{row.companyLabelSnapshot ?? ""}</span>
          </p>
          <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>Recruiter</h4>
          <p style={{ margin: 0, fontSize: 13 }}>{row.recruiterEmail ?? row.recruiterId ?? "—"}</p>
        </div>
      </div>
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid #eee" }}>
        <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
          Recruiter-visible calibration
        </h4>
        <div style={{ display: "grid", gridTemplateColumns: "160px 190px 1fr auto", gap: 10, alignItems: "start" }}>
          <select
            value={draftStage}
            onChange={(e) => setDraftStage(e.target.value)}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
          >
            {SOURCE_STAGE_VALUES.map((s) => <option value={s} key={s}>{s}</option>)}
          </select>
          <select
            value={draftCalibration}
            onChange={(e) => setDraftCalibration(e.target.value)}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
          >
            {CALIBRATION_VALUES.map((s) => <option value={s} key={s}>{prettyKey(s)}</option>)}
          </select>
          <textarea
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="Feedback visible to recruiter, e.g. why good fit or what to adjust..."
            rows={3}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13, resize: "vertical" }}
          />
          <button
            onClick={save}
            disabled={saving}
            style={{ padding: "8px 12px", border: "1px solid #222", background: "#222", color: "#fff", borderRadius: 6, cursor: saving ? "default" : "pointer" }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
        {saveError && <p style={{ color: "#a00", fontSize: 12, margin: "8px 0 0" }}>{saveError}</p>}
      </div>
    </Panel>
  )
}

function OpsSection({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section style={{ border: "1px solid #eee", borderRadius: 8, padding: 14, background: "#fff", minHeight: 168 }}>
      <div style={{ display: "grid", gap: 3, marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ color: "#777", fontSize: 12, lineHeight: 1.4 }}>{subtitle}</div>}
      </div>
      {children}
    </section>
  )
}

function EmptyOpsText({ children }: { children: ReactNode }) {
  return <p style={{ color: "#777", fontSize: 12, margin: 0 }}>{children}</p>
}

function OpsMetric({ label, value, meta }: { label: string; value: number | string; meta?: string }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, background: "#fff" }}>
      <div style={{ color: "#777", fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {meta && <div style={{ color: "#a60", fontSize: 12 }}>{meta}</div>}
    </div>
  )
}

function OpsMiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, background: "#faf8f4", padding: 9 }}>
      <div style={{ color: "#777", fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".08em" }}>{label}</div>
      <div style={{ color: "#222", fontSize: 15, fontWeight: 800, marginTop: 3 }}>{value}</div>
    </div>
  )
}

// Renders the four checklist tiers (hard → fit → anti → bonus) with the
// recruiter's actual graded answers, using the contract glyph+color+word
// (anti tier inverted). Mirrors recruiter-web's read-only ChecklistTiers.
function ChecklistTierMatrix({ review }: { review: ChecklistTierReview }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {review.groups.map((group) => {
        const meta = CHECKLIST_TIER_META[group.kind]
        return (
          <section
            key={group.kind}
            style={{
              border: "1px solid #eee",
              borderLeft: `3px solid ${CHECKLIST_TIER_RAIL[group.kind]}`,
              borderRadius: 8,
              background: "#fff",
              padding: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Badge tone="muted">{CHECKLIST_TIER_CHIP[group.kind]}</Badge>
              <strong style={{ color: "#222", fontSize: 13 }}>{meta.label}</strong>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: ".05em",
                  padding: "2px 7px",
                  borderRadius: 999,
                  background: meta.required ? "var(--danger-bg)" : "#e7e7e2",
                  color: meta.required ? "var(--danger)" : "#7a7a72",
                }}
              >
                {meta.required ? "required" : "optional"}
              </span>
            </div>
            <p style={{ margin: "5px 0 8px", fontSize: 11, color: "#8a8a82", lineHeight: 1.35 }}>{meta.rule}</p>
            <div style={{ display: "grid", gap: 6 }}>
              {group.items.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "6px 0",
                    borderBottom: "1px solid #f4efe7",
                    fontSize: 12,
                    lineHeight: 1.35,
                  }}
                >
                  <span style={{ color: item.value ? "#3a3a36" : "#777" }}>{item.text}</span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                      fontWeight: 600,
                      color: CHECKLIST_MARK_COLOR[item.mark.tone],
                    }}
                  >
                    <span aria-hidden="true" style={{ fontSize: 13, fontWeight: 800 }}>{item.mark.glyph}</span>
                    <span style={{ fontSize: 11.5 }}>{item.mark.word}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )
      })}
      {review.orphanCheckedIds.length > 0 && (
        <section style={{ border: "1px solid #f1c48a", borderRadius: 8, background: "#fff8ed", padding: 10, fontSize: 12, color: "#7a3e10" }}>
          <strong>Answered ids no longer in role checklist</strong>
          <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {review.orphanCheckedIds.map((id) => <code key={id}>{id}</code>)}
          </div>
        </section>
      )}
    </div>
  )
}

const COMPANY_SEND_STATUS_OPTIONS: CompanySendStatus[] = ["sent", "waiting_hm", "interested", "passed"]
const companySendTone = (s: CompanySendStatus): Parameters<typeof Badge>[0]["tone"] =>
  s === "interested" ? "ok" : s === "passed" ? "warn" : s === "waiting_hm" ? "info" : "muted"

/**
 * Per-company "waiting for hiring manager" tracker. Lets ops mark which companies
 * a candidate was sent to, each with its own status (sent → waiting HM →
 * interested/passed) + hiring-manager feedback. Writes via the admin action
 * callable; the FSM submission status flips to "with client" on the first send.
 */
function CompanySendsPanel({ submissionId, initial }: { submissionId: string; initial?: CompanySend[] }) {
  const [sends, setSends] = useState<CompanySend[]>(initial ?? [])
  const [newCompany, setNewCompany] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = async (fn: () => Promise<CompanySend[]>) => {
    setBusy(true)
    setErr(null)
    try {
      setSends(await fn())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const add = () => {
    const c = newCompany.trim()
    if (!c) return
    setNewCompany("")
    void run(() => upsertCompanySend(submissionId, { company: c, status: "sent" }))
  }
  return (
    <>
      <h4 style={{ margin: "16px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
        Company sends — waiting for hiring manager
      </h4>
      {err && <p style={{ color: "#c0392b", fontSize: 12, margin: "0 0 6px" }}>{err}</p>}
      <div style={{ display: "grid", gap: 10 }}>
        {sends.length === 0 && (
          <p style={{ margin: 0, fontSize: 13, color: "#999" }}>
            No companies yet. Add each company you send this candidate to, then track the hiring-manager response.
          </p>
        )}
        {sends.map((s) => (
          <div key={s.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
              <strong style={{ fontSize: 14 }}>{s.company}</strong>
              <Badge tone={companySendTone(s.status)}>{COMPANY_SEND_STATUS_LABEL[s.status]}</Badge>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select
                disabled={busy}
                value={s.status}
                onChange={(e) => void run(() => upsertCompanySend(submissionId, { id: s.id, company: s.company, status: e.target.value as CompanySendStatus }))}
              >
                {COMPANY_SEND_STATUS_OPTIONS.map((o) => (
                  <option key={o} value={o}>{COMPANY_SEND_STATUS_LABEL[o]}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => removeCompanySend(submissionId, s.id))}
                style={{ marginLeft: "auto", fontSize: 12, color: "#c0392b", background: "none", border: "none", cursor: "pointer" }}
              >
                Remove
              </button>
            </div>
            <textarea
              defaultValue={s.feedback ?? ""}
              placeholder="Hiring manager feedback…"
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v !== (s.feedback ?? "")) void run(() => upsertCompanySend(submissionId, { id: s.id, company: s.company, feedback: v }))
              }}
              style={{ width: "100%", minHeight: 44, fontSize: 13, padding: 6, borderRadius: 6, border: "1px solid #ddd", boxSizing: "border-box" }}
            />
            <span style={{ fontSize: 11, color: "#999" }}>
              Updated {formatOpsDate(s.updatedAt)}{s.by ? ` · ${s.by}` : ""}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          type="text"
          value={newCompany}
          placeholder="Company name…"
          disabled={busy}
          onChange={(e) => setNewCompany(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add() }}
          style={{ flex: 1, fontSize: 13, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd" }}
        />
        <button type="button" disabled={busy || !newCompany.trim()} onClick={add} style={{ fontSize: 13, padding: "6px 12px" }}>
          Add company
        </button>
      </div>
    </>
  )
}

function RowDetailPanel({
  row,
  role,
  onClose,
  onUpdated,
}: {
  row: SubmissionDoc
  role?: RecruiterBoardAdminJobDoc | null
  onClose: () => void
  onUpdated: (row: Partial<SubmissionDoc> & { id: string }) => void
}) {
  const tierReview = buildChecklistTierReview(row, role)
  // Feed the admin verdict banner from the tier-aware review so graded answers
  // (strong/yes/partial/no) are scored correctly. A "hard" item only counts as
  // missing if it isn't met; an "anti" item is a flag only when present.
  const checklistReview = tierReview.hasReadableChecklist
    ? {
        ...buildSubmissionChecklistReview(row, role),
        missingHard: tierReview.groups
          .filter((g) => g.kind === "hard")
          .flatMap((g) => g.items.filter((it) => it.mark.tone !== "met").map((it) => ({ id: it.id, text: it.text, checked: false }))),
        antiFlags: tierReview.groups
          .filter((g) => g.kind === "anti")
          .flatMap((g) => g.items.filter((it) => it.mark.tone === "notmet").map((it) => ({ id: it.id, text: it.text, checked: true }))),
      }
    : buildSubmissionChecklistReview(row, role)
  const reviewSummary = buildSubmissionAdminReviewSummary(row, checklistReview)
  const fallbackTickedIds = Object.entries(row.checklist ?? {}).filter(([, v]) => v !== false && v != null).map(([k]) => k).sort()
  const [draftStatus, setDraftStatus] = useState(row.status ?? "submitted")
  const [draftNote, setDraftNote] = useState(row.recruiterFeedbackNote ?? "")
  const [draftRating, setDraftRating] = useState<string>(
    normalizeFeedbackRating(row.recruiterFeedbackRating)?.toString() ?? "",
  )
  const [draftReasons, setDraftReasons] = useState<string[]>(row.recruiterFeedbackReasons ?? [])
  const [draftPayoutStatus, setDraftPayoutStatus] = useState(row.recruiterPayout?.status ?? "none")
  const [draftPayoutAmount, setDraftPayoutAmount] = useState(
    typeof row.recruiterPayout?.amount === "number" ? String(row.recruiterPayout.amount) : "",
  )
  const [draftPayoutNote, setDraftPayoutNote] = useState(row.recruiterPayout?.note ?? "")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const toggleReason = (reason: string) => {
    setDraftReasons((prev) => (
      prev.includes(reason)
        ? prev.filter((item) => item !== reason)
        : [...prev, reason]
    ))
  }

  const saveFeedback = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const cleanNote = draftNote.trim()
      const rating = normalizeFeedbackRating(draftRating)
      const reasons = SUBMISSION_FEEDBACK_REASONS
        .map((reason) => reason.id)
        .filter((reason) => draftReasons.includes(reason))
      const adminEmail = auth().currentUser?.email ?? null
      const payoutStatus = PAYOUT_STATUS_VALUES.includes(draftPayoutStatus) ? draftPayoutStatus : "none"
      const payoutAmount = normalizePayoutAmount(draftPayoutAmount)
      const payoutNote = draftPayoutNote.trim()
      const recruiterPayout = {
        status: payoutStatus,
        ...(payoutAmount ? { amount: payoutAmount } : {}),
        currency: "USD",
        note: payoutNote || null,
        updatedByEmail: adminEmail,
        updatedAt: serverTimestamp(),
      }
      await updateDoc(doc(db(), "pa-recruiter-submissions", row.id), {
        status: draftStatus,
        recruiterFeedbackNote: cleanNote || null,
        recruiterFeedbackRating: rating,
        recruiterFeedbackReasons: reasons,
        recruiterFeedbackUpdatedByEmail: adminEmail,
        recruiterFeedbackUpdatedAt: serverTimestamp(),
        recruiterPayout,
        statusHistory: arrayUnion({
          status: draftStatus,
          by: "admin",
          atIso: new Date().toISOString(),
          ...(cleanNote ? { note: cleanNote } : {}),
          ...(rating ? { rating } : {}),
          ...(reasons.length ? { reasons } : {}),
          ...(payoutStatus !== "none" ? { payoutStatus } : {}),
          ...(payoutStatus !== "none" && payoutAmount ? { payoutAmount } : {}),
        }),
        updatedAt: serverTimestamp(),
      })
      onUpdated({
        id: row.id,
        status: draftStatus,
        recruiterFeedbackNote: cleanNote || null,
        recruiterFeedbackRating: rating,
        recruiterFeedbackReasons: reasons,
        recruiterFeedbackUpdatedByEmail: adminEmail,
        recruiterFeedbackUpdatedAt: new Date().toISOString(),
        recruiterPayout: {
          status: payoutStatus,
          ...(payoutAmount ? { amount: payoutAmount } : {}),
          currency: "USD",
          note: payoutNote || null,
          updatedByEmail: adminEmail,
          updatedAt: new Date().toISOString(),
        },
      })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      title="Submission detail"
      actions={
        <button
          onClick={onClose}
          style={{ border: "none", background: "none", cursor: "pointer", color: "#888", fontSize: 16 }}
          aria-label="Close"
        >
          ✕
        </button>
      }
    >
      {row.aiEvaluation?.identityConflict && (
        <div
          style={{
            margin: "0 0 12px",
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #f0b429",
            background: "#fffaf0",
            color: "#8a5800",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          <strong>⚠️ Possible wrong-identity research.</strong> The LinkedIn profile pulled for this
          candidate appears to be a <strong>different person</strong> (or stale Coresignal data) than the
          submitted résumé — so the AI verdict was set to <strong>review</strong> and the research was{" "}
          <strong>not</strong> used to reject. Verify against the résumé below before deciding.
        </div>
      )}
      <div className="sub-detail__metrics">
        <OpsMetric label="Review verdict" value={reviewSummary.title} />
        <OpsMetric
          label="Hard met"
          value={tierReview.hasReadableChecklist ? `${tierReview.score.hardMet}/${tierReview.score.hardTotal}` : "—"}
        />
        <OpsMetric label="Anti-flags" value={tierReview.hasReadableChecklist ? tierReview.score.antiFlags : "—"} />
        <OpsMetric
          label="Fit · Bonus"
          value={tierReview.hasReadableChecklist
            ? `${tierReview.score.fitMet}/${tierReview.score.fitTotal} · ${tierReview.score.bonusMet}/${tierReview.score.bonusTotal}`
            : "—"}
        />
      </div>
      <div style={{ marginBottom: 18, border: "1px solid #eadfce", borderRadius: 10, background: "#fffaf3", padding: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Badge tone={reviewSummaryTone(reviewSummary.tone)}>{reviewSummary.title}</Badge>
          <span style={{ color: "#555", fontSize: 13 }}>{reviewSummary.body}</span>
        </div>
      </div>
      {(() => {
        const rec = row.candidateBackground
        const ai = row.aiEvaluation?.background
        const hasRec = rec && Object.values(rec).some(Boolean)
        const hasAi = ai && Object.values(ai).some((p) => p?.verdict === "strong" || p?.verdict === "weak")
        if (!hasRec && !hasAi) return null
        const pillars = [["school", "School"], ["gpa", "GPA"], ["degree", "Degree"], ["company", "Company"]] as const
        const pill = (tone: "strong" | "weak" | "unknown", text: string) => {
          const bg = tone === "weak" ? "#fcebeb" : tone === "strong" ? "#e1f5ee" : "#f1efe8"
          const fg = tone === "weak" ? "#791f1f" : tone === "strong" ? "#0f6e56" : "#777"
          return <span style={{ fontSize: 12, padding: "3px 9px", borderRadius: 999, background: bg, color: fg }}>{text}</span>
        }
        return (
          <div style={{ marginBottom: 18 }}>
            <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>Candidate background</h4>
            {hasRec && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: hasAi ? 6 : 0 }}>
                <span style={{ fontSize: 11, color: "#999", minWidth: 78 }}>recruiter</span>
                {pillars.map(([k, label]) => {
                  const v = rec?.[k]
                  if (v !== "strong" && v !== "weak") return null
                  return <span key={k}>{pill(v, `${label}: ${v}`)}</span>
                })}
              </div>
            )}
            {hasAi && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#999", minWidth: 78 }}>AI found</span>
                {pillars.map(([k, label]) => {
                  const p = ai?.[k]
                  const v = p?.verdict
                  if (v !== "strong" && v !== "weak" && v !== "unknown") return null
                  return <span key={k} title={p?.evidence || undefined}>{pill(v, `${label}: ${v}`)}</span>
                })}
              </div>
            )}
          </div>
        )
      })()}
      <div className="sub-detail__cols">
        <div>
          <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
            Submitter
          </h4>
          <p style={{ margin: 0, fontSize: 13 }}>
            {row.submitter?.name} &lt;{row.submitter?.email}&gt;
          </p>

          <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
            Candidate
          </h4>
          <p style={{ margin: 0, fontSize: 13 }}>
            <strong>{row.candidate?.name}</strong>
            {row.candidate?.currentRole && <> · {row.candidate.currentRole}</>}
            {row.candidate?.yoe && <> · {row.candidate.yoe} YOE</>}
          </p>
          {row.candidate?.email && (
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "#555" }}>
              {row.candidate.email}
            </p>
          )}
          {row.candidate?.link && (
            <p style={{ margin: "4px 0 0", fontSize: 12 }}>
              <a href={row.candidate.link} target="_blank" rel="noopener noreferrer">
                {row.candidate.link}
              </a>
            </p>
          )}
          {row.candidate?.compensationExpectation && (
            <p style={{ margin: "8px 0 0", fontSize: 12.5 }}>
              <strong>Expected salary:</strong> {row.candidate.compensationExpectation}
            </p>
          )}
          <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
            Candidate confirmation
          </h4>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Badge tone={consentBadge(row.candidateConsentStatus).tone}>{consentBadge(row.candidateConsentStatus).label}</Badge>
            {row.candidateConfirmation?.status && <span style={{ marginLeft: 8, color: "#777" }}>{row.candidateConfirmation.status}</span>}
          </p>
          {row.candidateConfirmation?.lastError && (
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "#a00" }}>{row.candidateConfirmation.lastError}</p>
          )}
          {row.candidate?.notes && (
            <>
              <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
                Notes
              </h4>
              <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{row.candidate.notes}</p>
            </>
          )}
          {(row.candidate?.resumeUrl || row.candidate?.linkedinUrl || row.candidate?.link) && (
            <>
              <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
                Résumé
              </h4>
              <CandidateResumePreview
                resumeUrl={row.candidate?.resumeUrl}
                linkedinUrl={row.candidate?.linkedinUrl ?? row.candidate?.link}
                height="60vh"
              />
            </>
          )}
        </div>

        <div>
          <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
            Score
          </h4>
          {tierReview.hasReadableChecklist ? (
            <p style={{ margin: 0, fontSize: 12.5, color: "#444", lineHeight: 1.45 }}>
              {checklistScoreLegend(tierReview.score)}
            </p>
          ) : row.score ? (
            <p style={{ margin: 0, fontSize: 12.5, color: "#444", lineHeight: 1.45 }}>
              Hard {row.score.hardChecked}/{row.score.hardTotal} met ·{" "}
              Fit {row.score.fitChecked}/{row.score.fitTotal} ·{" "}
              Bonus {row.score.bonusChecked}/{row.score.bonusTotal} ·{" "}
              Anti {row.score.antiChecked} flag(s). A match needs most hard filters met and no anti-flags.
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: "#999" }}>No score.</p>
          )}

          <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
            Status history
          </h4>
          {row.statusHistory?.length ? (
            <div style={{ display: "grid", gap: 6 }}>
              {row.statusHistory.slice(-6).map((event, index) => (
                <div key={`${event.status ?? "status"}-${event.atIso ?? index}`} style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: 8, fontSize: 12, color: "#444" }}>
                  <Badge tone={statusBadge(event.status)}>{event.status ?? "updated"}</Badge>
                  <span>
                    {event.note || event.by || "Status updated"}
                    {event.rating ? ` · ${event.rating}/4` : ""}
                    {event.reasons?.length ? ` · ${event.reasons.map(feedbackReasonLabel).join(", ")}` : ""}
                    <br />
                    <span style={{ color: "#888" }}>{formatOpsDate(event.atIso)}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: "#999" }}>No status history stored.</p>
          )}

          <CompanySendsPanel submissionId={row.id} initial={row.companySends} />

          <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
            Role evidence matrix
          </h4>
          {!tierReview.hasReadableChecklist ? (
            <>
              <p style={{ margin: 0, fontSize: 13, color: "#999" }}>
                No readable role checklist found. Showing raw answered ids from the recruiter packet.
              </p>
              {fallbackTickedIds.length > 0 && (
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "#444" }}>
                  {fallbackTickedIds.map((id) => (
                    <li key={id}><code>{id}</code></li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 8px", fontSize: 11.5, color: "#8a8a82", lineHeight: 1.4 }}>
                {checklistScoreLegend(tierReview.score)}
              </p>
              <ChecklistTierMatrix review={tierReview} />
            </>
          )}

          {row.sheetSyncError && (
            <>
              <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#a00" }}>
                Sheet sync error
              </h4>
              <p style={{ margin: 0, fontSize: 12, color: "#a00", whiteSpace: "pre-wrap" }}>
                {row.sheetSyncError}
              </p>
            </>
          )}
        </div>
      </div>
      {(() => {
        const attemptId = resolveSubmissionAttemptId(row)
        if (!attemptId) return null
        const ai = row.aiEvaluation
        const outcomeKind = recruiterVerdictToOutcomeKind(ai?.verdict)
        const verdictLabel = ai?.verdict ?? "not evaluated"
        const verdictTone: "strong" | "weak" | "unknown" =
          ai?.verdict === "advance" ? "strong" : ai?.verdict === "reject" ? "weak" : "unknown"
        const verdictBg = verdictTone === "weak" ? "#fcebeb" : verdictTone === "strong" ? "#e1f5ee" : "#f1efe8"
        const verdictFg = verdictTone === "weak" ? "#791f1f" : verdictTone === "strong" ? "#0f6e56" : "#777"
        return (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid #eee" }}>
            <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
              Eval label (data labeling)
            </h4>
            <p style={{ margin: "0 0 10px", fontSize: 12, color: "#888", lineHeight: 1.45 }}>
              Grade the AI evaluation itself. This is label-only — it records your gold label next to the AI verdict
              and never messages the candidate or changes the recruiter-visible status.
            </p>
            <div className="sub-detail__cols">
              {/* LEFT — read-only AI evaluation. */}
              <div style={{ border: "1px solid #eee", borderRadius: 8, background: "#faf8f4", padding: 12, alignSelf: "start" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                  <span style={{ fontSize: 11, textTransform: "uppercase", color: "#999" }}>AI verdict</span>
                  <span style={{ fontSize: 12, padding: "3px 9px", borderRadius: 999, background: verdictBg, color: verdictFg }}>
                    {verdictLabel}
                  </span>
                  {typeof ai?.confidence === "number" && (
                    <span
                      style={{ fontSize: 12, color: "#777" }}
                      title="How sure the AI is about THIS verdict — not a candidate score. e.g. 'reject · 92% sure' = 92% confident in rejecting, not a 92% rating."
                    >
                      {(ai.confidence * 100).toFixed(0)}% sure in this verdict
                    </span>
                  )}
                </div>
                {ai?.summary && (
                  <p style={{ margin: "0 0 8px", fontSize: 13, color: "#444", lineHeight: 1.45 }}>{ai.summary}</p>
                )}
                {ai?.reasons?.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "#555", lineHeight: 1.5 }}>
                    {ai.reasons.slice(0, 8).map((reason, index) => (
                      <li key={index}>{reason}</li>
                    ))}
                  </ul>
                ) : (
                  !ai?.summary && (
                    <p style={{ margin: 0, fontSize: 12.5, color: "#999" }}>
                      No AI evaluation text on this row yet. You can still label the attempt.
                    </p>
                  )
                )}
              </div>
              {/* RIGHT — the shared human label form (label-only, never messages). */}
              <div style={{ alignSelf: "start" }}>
                <EvalLabelForm attemptId={attemptId} aiProposedOutcomeKind={outcomeKind} />
              </div>
            </div>
          </div>
        )
      })()}
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid #eee" }}>
        <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
          Recruiter-visible status and feedback
        </h4>
        <div className="sub-detail__feedbackgrid">
          <select
            value={draftStatus}
            onChange={(e) => setDraftStatus(e.target.value)}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
          >
            {STATUS_VALUES.map((s) => <option value={s} key={s}>{s}</option>)}
          </select>
          <select
            value={draftRating}
            onChange={(e) => setDraftRating(e.target.value)}
            aria-label="Submission rating"
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
          >
            <option value="">Unrated</option>
            <option value="4">4/4 excellent</option>
            <option value="3">3/4 solid</option>
            <option value="2">2/4 low signal</option>
            <option value="1">1/4 poor fit</option>
          </select>
          <textarea
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="Visible to recruiter: why this candidate did or did not work..."
            rows={3}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13, resize: "vertical" }}
          />
          <button
            onClick={saveFeedback}
            disabled={saving}
            style={{ padding: "8px 12px", border: "1px solid #222", background: "#222", color: "#fff", borderRadius: 6, cursor: saving ? "default" : "pointer" }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
        <div style={{ marginTop: 10 }}>
          <ReasonChips selected={draftReasons} onToggle={toggleReason} />
        </div>
        <div style={{ marginTop: 14, border: "1px solid #eadfce", borderRadius: 10, background: "#fffaf3", padding: 12 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", color: "#7a4a16" }}>
            Recruiter payout tracker
          </h4>
          <div className="sub-detail__payoutgrid">
            <select
              value={draftPayoutStatus}
              onChange={(e) => setDraftPayoutStatus(e.target.value)}
              aria-label="Recruiter payout status"
              style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
            >
              {PAYOUT_STATUS_VALUES.map((status) => <option value={status} key={status}>{payoutBadge(status).label}</option>)}
            </select>
            <input
              value={draftPayoutAmount}
              onChange={(e) => setDraftPayoutAmount(e.target.value)}
              placeholder="USD amount"
              inputMode="numeric"
              style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
            />
            <textarea
              value={draftPayoutNote}
              onChange={(e) => setDraftPayoutNote(e.target.value)}
              placeholder="Visible to recruiter: payout condition, invoice note, or why void..."
              rows={2}
              style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13, resize: "vertical" }}
            />
          </div>
          <p style={{ margin: "8px 0 0", color: "#7a4a16", fontSize: 12 }}>
            Status and amount are visible in the recruiter earnings tab and create a recruiter inbox alert when changed.
          </p>
        </div>
        {saveError && <p style={{ color: "#a00", fontSize: 12, margin: "8px 0 0" }}>{saveError}</p>}
      </div>
    </Panel>
  )
}
