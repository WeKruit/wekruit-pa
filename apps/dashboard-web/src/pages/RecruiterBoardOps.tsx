/**
 * Recruiter operations board — the founder's "one screen" view:
 * all recruiters → jobs each works on → submissions per job → AI verdict →
 * stage-aware one-click action (move to interview / send to client / hired /
 * reject / request info, overflow for reviewing / duplicate) via
 * paAdminRecruiterSubmissionAction.
 *
 * Client-side join of two small collections: pa-recruiter-users
 * (name/email/status) + pa-recruiter-submissions (latest 100 per recruiter).
 * Submitter emails with no matching recruiter profile land in an "Unclaimed
 * submitters" group from a small recent fallback.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from "firebase/firestore"
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { CandidateResumePreview } from "../components/CandidateResumePreview.js"
import { SideDrawer } from "../components/prescreen/PrescreenReviewDrawers.js"
import { DUAL_PANE_COLLAPSE_CSS, dualPaneStyle, paneHeaderStyle } from "../components/prescreen/dual-pane.js"
import { db } from "../lib/firebase.js"
import {
  RECRUITER_SUBMISSION_ACTION_TO_STATUS,
  runRecruiterSubmissionAction,
  sendRecruiterSubmissionComment,
  type ChecklistMark,
  type RecruiterChecklistMarks,
  type RecruiterCandidateRejectionCategory,
  type RecruiterCandidateTier,
  type RecruiterSubmissionRejectionInput,
  type RecruiterSubmissionAction,
} from "../lib/recruiter-submission-actions-api.js"

interface SubmissionAiChecklistTally {
  met?: number
  total?: number
  gaps?: string[]
}

interface SubmissionAiAntiTally {
  flagged?: number
  total?: number
  flags?: string[]
}

interface SubmissionAiPillar {
  verdict?: "strong" | "weak" | "unknown"
  evidence?: string
}

interface SubmissionAiEvaluation {
  verdict?: "advance" | "borderline" | "reject"
  confidence?: number
  summary?: string
  reasons?: string[]
  checklist?: {
    hard?: SubmissionAiChecklistTally
    fit?: SubmissionAiChecklistTally
    bonus?: SubmissionAiChecklistTally
    anti?: SubmissionAiAntiTally
  }
  /** Background pillars the AI evaluated from research/résumé. */
  background?: {
    school?: SubmissionAiPillar
    gpa?: SubmissionAiPillar
    degree?: SubmissionAiPillar
    company?: SubmissionAiPillar
  }
  research?: {
    source?: string
    headline?: string
    companies?: Array<{ name?: string; role?: string; years?: string }>
    signals?: string[]
    risks?: string[]
  }
  evaluatedAt?: string
  model?: string
  version?: string
  error?: string
}

interface SubmissionRequestedInfoEntry {
  message?: string
  at?: string
  by?: string
}

interface SubmissionCommentDoc {
  id: string
  message?: string
  by?: string
  authorName?: string
  authorEmail?: string
  at?: string
}

export interface ConversationEntry {
  key: string
  kind: "comment" | "request"
  side: "left" | "right"
  author: string
  at?: string
  message: string
  pending?: boolean
}

interface BoardSubmissionDoc {
  id: string
  jobId?: string
  inboundJobId?: string
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
    notes?: string
    currentCompany?: string
    location?: string
    workAuthorization?: string
    employmentStatus?: string
    compensationExpectation?: string
    noticePeriod?: string
    interviewAvailability?: string
  }
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
  extraFields?: Record<string, string>
  recruiterId?: string | null
  recruiterEmail?: string
  aiEvaluation?: SubmissionAiEvaluation
  requestedInfo?: SubmissionRequestedInfoEntry[]
  /** Operator's saved per-item checklist assessment (AI mark + override). */
  adminChecklistMarks?: { marks?: Record<string, ChecklistMark>; by?: string; at?: string }
  createdAt?: { seconds?: number } | string | null
  createdAtMs?: number
}

interface BoardRecruiterDoc {
  id: string
  name?: string
  email?: string
  status?: string
}

interface BoardJdBlock {
  heading?: string
  body?: string
  items?: string[]
  kind?: "list" | "prose"
}

interface BoardChecklistItem {
  id?: string
  text?: string
}

interface BoardChecklistGroupDoc {
  kind?: "hard" | "fit" | "bonus" | "anti"
  heading?: string
  items?: BoardChecklistItem[]
}

interface BoardJobDoc {
  id: string
  title?: string
  company?: string
  jdBlocks?: BoardJdBlock[]
  recruiterBoard?: {
    label?: { company?: string }
    checklist?: { groups?: BoardChecklistGroupDoc[] }
  }
}

interface BoardJobGroup {
  key: string
  title: string
  company: string
  submissions: BoardSubmissionDoc[]
  pendingCount: number
  totalCount: number
}

interface BoardRecruiterGroup {
  key: string
  name: string
  email: string
  accountStatus: string | null
  jobs: BoardJobGroup[]
  totalCount: number
  pendingCount: number
  latestMs: number
}

const PENDING_STATUSES = ["submitted", "new", "reviewing"]
const BOARD_SUBMISSIONS_PER_RECRUITER_LIMIT = 100
const BOARD_UNCLAIMED_SUBMISSION_LIMIT = 100
const BOARD_SUBMISSION_PAGE_SIZE = 100
const BOARD_RECRUITER_SUBMISSION_IDENTITY_FIELDS = ["recruiterId", "recruiterEmail", "submitter.email"] as const
const DEFAULT_REQUEST_MESSAGE = "Please add the candidate's resume link and LinkedIn profile."
const DEFAULT_REJECTION_CATEGORY: RecruiterCandidateRejectionCategory = "quality"
const DEFAULT_REJECTION_TIER: RecruiterCandidateTier = "tier_3"
export type BoardSubmissionFilter = "pending" | "all"
type BoardRecruiterSubmissionIdentityField = typeof BOARD_RECRUITER_SUBMISSION_IDENTITY_FIELDS[number]

export function defaultRecruiterSubmissionRejection(): RecruiterSubmissionRejectionInput {
  return {
    category: DEFAULT_REJECTION_CATEGORY,
    candidateTier: DEFAULT_REJECTION_TIER,
    reason: "",
  }
}

function timestampToMs(raw: BoardSubmissionDoc["createdAt"]): number {
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw.seconds === "number") return raw.seconds * 1000
  return 0
}

function formatSubmittedDate(ms: number): string {
  if (!ms) return "—"
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

function isPending(submission: { status?: string }): boolean {
  return PENDING_STATUSES.includes(submission.status ?? "submitted")
}

export function visibleBoardSubmissionsForFilter<T extends { status?: string }>(
  submissions: T[],
  filter: BoardSubmissionFilter,
): T[] {
  return filter === "pending" ? submissions.filter(isPending) : submissions
}

export function isBulkRejectSelectable(submission: { status?: string }): boolean {
  return submissionStage(submission.status) !== "terminal"
}

function statusTone(status: string | undefined): Parameters<typeof Badge>[0]["tone"] {
  switch (status) {
    case "submitted":
    case "new":
    case "reviewing":
    case "backburner":
      return "info"
    case "advanced":
    case "interviewing":
    case "offer":
    case "hired":
      return "ok"
    case "rejected":
      return "warn"
    default:
      return "muted"
  }
}

/** Pinned status-pipeline display vocabulary (legacy "advanced" shows as the interview stage). */
export function statusDisplay(status: string | undefined): { label: string; tone: Parameters<typeof Badge>[0]["tone"] } {
  const value = status ?? "submitted"
  switch (value) {
    case "submitted":
    case "new":
    case "reviewing":
      return { label: "Submitted", tone: "info" }
    case "wekruit_interview":
    case "advanced":
      return { label: "WeKruit interview", tone: "info" }
    case "client_review":
      return { label: "With client", tone: "info" }
    case "hired":
      return { label: "Hired", tone: "ok" }
    case "rejected":
      return { label: "Rejected", tone: "warn" }
    case "duplicate":
      return { label: "Duplicate", tone: "muted" }
    default:
      return { label: value, tone: statusTone(value) }
  }
}

export type SubmissionStage = "pending" | "wekruit_interview" | "client_review" | "terminal"

export function submissionStage(status: string | undefined): SubmissionStage {
  switch (status ?? "submitted") {
    case "wekruit_interview":
    case "advanced":
      return "wekruit_interview"
    case "client_review":
      return "client_review"
    case "hired":
    case "rejected":
    case "duplicate":
      return "terminal"
    default:
      return "pending"
  }
}

const STAGE_PRIMARY_ACTION: Record<Exclude<SubmissionStage, "terminal">, { label: string; action: RecruiterSubmissionAction }> = {
  pending: { label: "Move to interview", action: "wekruit_interview" },
  wekruit_interview: { label: "Send to client", action: "client_review" },
  client_review: { label: "Hired", action: "hired" },
}

function recruiterAccountTone(status: string | null): Parameters<typeof Badge>[0]["tone"] {
  switch (status) {
    case "disabled":
      return "warn"
    case "under_review":
      return "info"
    default:
      return "ok"
  }
}

function verdictChip(evaluation: SubmissionAiEvaluation | undefined): { label: string; tone: Parameters<typeof Badge>[0]["tone"] } {
  if (!evaluation) return { label: "evaluating…", tone: "muted" }
  if (evaluation.error) return { label: "eval failed", tone: "warn" }
  const confidence = typeof evaluation.confidence === "number"
    ? ` · ${Math.round(evaluation.confidence * 100)}%`
    : ""
  switch (evaluation.verdict) {
    case "advance":
      return { label: `advance${confidence}`, tone: "ok" }
    case "borderline":
      return { label: `borderline${confidence}`, tone: "info" }
    case "reject":
      return { label: `reject${confidence}`, tone: "warn" }
    default:
      return { label: "evaluating…", tone: "muted" }
  }
}

function selfScoreLabel(score: BoardSubmissionDoc["score"]): string {
  if (!score) return "—"
  return `H ${score.hardChecked}/${score.hardTotal} · F ${score.fitChecked}/${score.fitTotal} · A ${score.antiChecked}/${score.antiTotal}`
}

function candidateHref(submission: BoardSubmissionDoc): string | null {
  const href = submission.candidate?.linkedinUrl ?? submission.candidate?.link
  return href?.trim() ? href : null
}

export function extraFieldLabel(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim()
  return words ? words[0].toUpperCase() + words.slice(1) : id
}

export function extraFieldHref(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    return url.hostname.includes(".") ? url.href : null
  } catch {
    return null
  }
}

export function buildConversationEntries(
  comments: Array<{ id: string; message?: string; by?: string; authorName?: string; at?: string }>,
  requestedInfo: Array<{ message?: string; at?: string; by?: string }> | undefined,
): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  ;(requestedInfo ?? []).forEach((entry, i) => {
    const message = entry?.message?.trim()
    if (!message) return
    entries.push({
      key: `request-${i}`,
      kind: "request",
      side: "right",
      author: entry.by?.trim() || "WeKruit",
      at: entry.at,
      message,
    })
  })
  for (const comment of comments) {
    const message = comment.message?.trim()
    if (!message) continue
    const fromWekruit = comment.by === "wekruit"
    entries.push({
      key: `comment-${comment.id}`,
      kind: "comment",
      side: fromWekruit ? "right" : "left",
      author: comment.authorName?.trim() || (fromWekruit ? "WeKruit" : "Recruiter"),
      at: comment.at,
      message,
    })
  }
  return entries.sort((a, b) => (Date.parse(a.at ?? "") || 0) - (Date.parse(b.at ?? "") || 0))
}

function formatMessageTime(at: string | undefined): string {
  const ms = at ? Date.parse(at) : Number.NaN
  if (!Number.isFinite(ms)) return ""
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

function recruiterMatches(submission: BoardSubmissionDoc, recruiter: BoardRecruiterDoc): boolean {
  if (submission.recruiterId && submission.recruiterId === recruiter.id) return true
  const email = recruiter.email?.trim().toLowerCase()
  if (!email) return false
  return (
    submission.recruiterEmail?.trim().toLowerCase() === email ||
    submission.submitter?.email?.trim().toLowerCase() === email
  )
}

function recruiterSubmissionLookupKeys(recruiter: BoardRecruiterDoc): Array<{ field: BoardRecruiterSubmissionIdentityField; value: string }> {
  const keys: Array<{ field: BoardRecruiterSubmissionIdentityField; value: string }> = []
  const seen = new Set<string>()
  const add = (field: BoardRecruiterSubmissionIdentityField, raw?: string | null) => {
    const value = raw?.trim()
    if (!value) return
    const key = `${field}:${value}`
    if (seen.has(key)) return
    seen.add(key)
    keys.push({ field, value })
  }

  add("recruiterId", recruiter.id)
  add("recruiterEmail", recruiter.email)
  add("submitter.email", recruiter.email)
  const normalizedEmail = recruiter.email?.trim().toLowerCase()
  if (normalizedEmail && normalizedEmail !== recruiter.email?.trim()) {
    add("recruiterEmail", normalizedEmail)
    add("submitter.email", normalizedEmail)
  }
  return keys
}

function sortSubmissionsByRecency(submissions: BoardSubmissionDoc[]): BoardSubmissionDoc[] {
  return [...submissions].sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
}

function uniqueBoardSubmissions(submissions: BoardSubmissionDoc[]): BoardSubmissionDoc[] {
  const byId = new Map<string, BoardSubmissionDoc>()
  for (const submission of sortSubmissionsByRecency(submissions)) {
    if (!byId.has(submission.id)) byId.set(submission.id, submission)
  }
  return [...byId.values()]
}

function capBoardSubmissionsPerRecruiter(
  recruiters: BoardRecruiterDoc[],
  submissions: BoardSubmissionDoc[],
  perRecruiterLimit: number,
): BoardSubmissionDoc[] {
  const sorted = uniqueBoardSubmissions(submissions)
  const includedIds = new Set<string>()
  const matchedRecruiterIds = new Set<string>()

  for (const recruiter of recruiters) {
    let count = 0
    for (const submission of sorted) {
      if (!recruiterMatches(submission, recruiter)) continue
      matchedRecruiterIds.add(submission.id)
      if (count >= perRecruiterLimit) continue
      includedIds.add(submission.id)
      count += 1
    }
  }

  return sorted.filter((submission) => includedIds.has(submission.id) || !matchedRecruiterIds.has(submission.id))
}

function submissionJobKey(submission: BoardSubmissionDoc): string {
  return (submission.inboundJobId || submission.jobId || submission.jobTitleSnapshot || "unknown-job").trim()
}

function sortSubmissions(submissions: BoardSubmissionDoc[]): BoardSubmissionDoc[] {
  return [...submissions].sort((a, b) => {
    const pendingDelta = Number(isPending(b)) - Number(isPending(a))
    if (pendingDelta !== 0) return pendingDelta
    return (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)
  })
}

function buildJobGroups(submissions: BoardSubmissionDoc[]): BoardJobGroup[] {
  const byJob = new Map<string, BoardSubmissionDoc[]>()
  for (const submission of submissions) {
    const key = submissionJobKey(submission)
    const list = byJob.get(key)
    if (list) list.push(submission)
    else byJob.set(key, [submission])
  }
  const groups: BoardJobGroup[] = [...byJob.entries()].map(([key, list]) => {
    const sorted = sortSubmissions(list)
    const labelled = sorted.find((s) => s.jobTitleSnapshot) ?? sorted[0]
    return {
      key,
      title: labelled?.jobTitleSnapshot ?? key,
      company: labelled?.companyLabelSnapshot ?? "",
      submissions: sorted,
      pendingCount: sorted.filter(isPending).length,
      totalCount: sorted.length,
    }
  })
  return groups.sort((a, b) => {
    if (b.pendingCount !== a.pendingCount) return b.pendingCount - a.pendingCount
    return (b.submissions[0]?.createdAtMs ?? 0) - (a.submissions[0]?.createdAtMs ?? 0)
  })
}

export function buildBoardGroups(
  recruiters: BoardRecruiterDoc[],
  submissions: BoardSubmissionDoc[],
): { recruiterGroups: BoardRecruiterGroup[]; unclaimedGroups: BoardRecruiterGroup[] } {
  const claimed = new Set<string>()
  const recruiterGroups = recruiters.map((recruiter) => {
    const owned = submissions.filter((s) => recruiterMatches(s, recruiter))
    for (const s of owned) claimed.add(s.id)
    return {
      key: `recruiter:${recruiter.id}`,
      name: recruiter.name || recruiter.email || recruiter.id,
      email: recruiter.email ?? "",
      accountStatus: recruiter.status || null,
      jobs: buildJobGroups(owned),
      totalCount: owned.length,
      pendingCount: owned.filter(isPending).length,
      latestMs: Math.max(0, ...owned.map((s) => s.createdAtMs ?? 0)),
    }
  })

  const unclaimed = submissions.filter((s) => !claimed.has(s.id))
  const bySubmitter = new Map<string, BoardSubmissionDoc[]>()
  for (const submission of unclaimed) {
    const email =
      submission.submitter?.email?.trim().toLowerCase() ||
      submission.recruiterEmail?.trim().toLowerCase() ||
      "unknown submitter"
    const list = bySubmitter.get(email)
    if (list) list.push(submission)
    else bySubmitter.set(email, [submission])
  }
  const unclaimedGroups: BoardRecruiterGroup[] = [...bySubmitter.entries()].map(([email, list]) => ({
    key: `unclaimed:${email}`,
    name: list.find((s) => s.submitter?.name)?.submitter?.name ?? email,
    email,
    accountStatus: null,
    jobs: buildJobGroups(list),
    totalCount: list.length,
    pendingCount: list.filter(isPending).length,
    latestMs: Math.max(0, ...list.map((s) => s.createdAtMs ?? 0)),
  }))

  const byPendingThenRecency = (a: BoardRecruiterGroup, b: BoardRecruiterGroup) => {
    if (b.pendingCount !== a.pendingCount) return b.pendingCount - a.pendingCount
    if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount
    return b.latestMs - a.latestMs
  }
  return {
    recruiterGroups: recruiterGroups.sort(byPendingThenRecency),
    unclaimedGroups: unclaimedGroups.sort(byPendingThenRecency),
  }
}

const cellStyle: CSSProperties = { padding: "6px 6px", verticalAlign: "middle" }
const actionButtonStyle: CSSProperties = {
  padding: "3px 7px",
  border: "1px solid #ccc",
  borderRadius: 5,
  background: "#fff",
  fontSize: 11,
  lineHeight: 1.15,
  whiteSpace: "nowrap",
  cursor: "pointer",
}
// P3 carry-over: while another row's action is in flight, this row's buttons
// must read as disabled (aria-disabled + dimmed), not silently no-op.
const blockedButtonStyle = {
  opacity: 0.5,
  cursor: "default" as const,
}

const boardGroupBodyStyle: CSSProperties = {
  display: "grid",
  gap: 10,
  maxHeight: 420,
  overflow: "auto",
  paddingRight: 6,
  scrollbarWidth: "thin",
}

const boardJobHeaderStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  flexWrap: "wrap",
  marginBottom: 4,
}

const boardTableShellStyle: CSSProperties = {
  maxHeight: 270,
  overflow: "auto",
  border: "1px solid #eee5d8",
  borderRadius: 10,
  scrollbarWidth: "thin",
}

const boardPaginationBarStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderBottom: "1px solid #eee5d8",
  background: "#fffdf9",
  color: "#777",
  fontSize: 11,
  fontWeight: 600,
}

function boardPaginationButtonStyle(disabled: boolean): CSSProperties {
  return {
    ...actionButtonStyle,
    ...(disabled ? blockedButtonStyle : null),
  }
}

const boardTableStyle: CSSProperties = {
  minWidth: 760,
  border: 0,
  fontSize: 11.5,
  lineHeight: 1.25,
}

const boardHeaderCellStyle: CSSProperties = {
  position: "sticky",
  top: 32,
  zIndex: 1,
  padding: "6px 6px",
  background: "#fff",
  boxShadow: "0 1px 0 #eee",
  color: "#777",
}

const boardSelectCellStyle: CSSProperties = {
  ...cellStyle,
  width: 34,
  textAlign: "center",
}

const boardBulkBarStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 140px 170px minmax(220px, 1fr) auto",
  gap: 8,
  alignItems: "center",
  margin: "0 0 12px",
  padding: 10,
  border: "1px solid #ead8d3",
  borderRadius: 10,
  background: "#fff8f6",
}

const boardStatsBarStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  margin: "0 0 12px",
  flexWrap: "wrap",
}

const boardFilterShellStyle: CSSProperties = {
  display: "inline-flex",
  gap: 4,
  padding: 3,
  border: "1px solid #e4d9cc",
  borderRadius: 8,
  background: "#fff",
}

function boardFilterButtonStyle(active: boolean): CSSProperties {
  return {
    border: 0,
    borderRadius: 6,
    padding: "5px 9px",
    background: active ? "#35291f" : "transparent",
    color: active ? "#fff" : "#6f6255",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  }
}

const reviewContextStyle: CSSProperties = {
  minHeight: 560,
  maxHeight: "min(720px, calc(100vh - 120px))",
  overflow: "auto",
  border: "1px solid #e5ded2",
  borderRadius: 12,
  background: "#fffdf9",
  padding: 16,
  scrollbarWidth: "thin",
}

const roleContextLabelStyle: CSSProperties = {
  color: "#8b7d6d",
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0,
}

const roleContextSectionTitleStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 13,
  color: "#4b3a2e",
}

const roleContextTextStyle: CSSProperties = {
  color: "#4e443a",
  fontSize: 14,
  lineHeight: 1.55,
}

const roleContextListStyle: CSSProperties = {
  ...roleContextTextStyle,
  margin: "8px 0 0",
  paddingLeft: 18,
}

const roleContextCardStyle: CSSProperties = {
  border: "1px solid #eee6da",
  borderRadius: 8,
  padding: 10,
  background: "#fff",
}

const reviewSectionStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "10px 0",
  borderTop: "1px solid #eee6da",
}

const fieldGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
}

const compactFieldStyle: CSSProperties = {
  border: "1px solid #eee6da",
  borderRadius: 8,
  padding: "7px 8px",
  background: "#fff",
  minWidth: 0,
}

function GapList({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 12, color: "#555" }}>{label}</div>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12, color: "#555" }}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function ExtraFieldsDetail({ extraFields }: { extraFields?: Record<string, string> }) {
  const entries = Object.entries(extraFields ?? {}).filter(([, value]) => typeof value === "string" && value.trim())
  if (!entries.length) return null
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ fontWeight: 600, fontSize: 12, color: "#555" }}>Submission fields</div>
      {entries.map(([id, value]) => {
        const href = extraFieldHref(value)
        return (
          <div key={id} style={{ fontSize: 12, color: "#555" }}>
            <span style={{ fontWeight: 600 }}>{extraFieldLabel(id)}: </span>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "#2a5fb8" }}>
                {value.trim()}
              </a>
            ) : (
              value.trim()
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---- Per-item checklist assessment (AI marks + operator override) ----------
// Mirrors the candidate prescreen ChecklistEvalPanel: each rubric item gets a
// ✓/✗/⚑ derived from the AI eval's gaps/flags, and the operator can override any
// item. Lives on the board review panel so recruiter submissions are reviewed the
// same way candidates are.

type ChecklistTierKind = "hard" | "fit" | "bonus" | "anti"
const CHECKLIST_TIER_ORDER: ChecklistTierKind[] = ["hard", "fit", "anti", "bonus"]
const CHECKLIST_TIER_LABEL: Record<ChecklistTierKind, string> = {
  hard: "Hard — must have",
  fit: "Fit — strong signals",
  anti: "Anti-signals",
  bonus: "Bonus — nice to have",
}

interface BoardChecklistItemRow {
  key: string
  text: string
  aiMark: ChecklistMark
  mark: ChecklistMark
  overridden: boolean
}
interface BoardChecklistGroupRow {
  kind: ChecklistTierKind
  heading: string
  items: BoardChecklistItemRow[]
  met: number
  total: number
}

const norm = (s: string): string => s.trim().toLowerCase()

function aiMarkForItem(
  kind: ChecklistTierKind,
  text: string,
  evaluation: SubmissionAiEvaluation | undefined,
): ChecklistMark {
  const checklist = evaluation?.checklist
  if (kind === "anti") {
    const flags = (checklist?.anti?.flags ?? []).map(norm)
    return flags.includes(norm(text)) ? "flag" : "clear"
  }
  const gaps = (checklist?.[kind]?.gaps ?? []).map(norm)
  return gaps.includes(norm(text)) ? "gap" : "met"
}

/** Cycle a single item's mark: good ↔ bad for its tier. */
function cycleChecklistMark(kind: ChecklistTierKind, current: ChecklistMark): ChecklistMark {
  if (kind === "anti") return current === "flag" ? "clear" : "flag"
  return current === "gap" ? "met" : "gap"
}

function buildBoardChecklist(
  groups: BoardChecklistGroupDoc[] | undefined,
  evaluation: SubmissionAiEvaluation | undefined,
  overrides: RecruiterChecklistMarks,
): BoardChecklistGroupRow[] {
  return (groups ?? [])
    .map((group): BoardChecklistGroupRow | null => {
      const kind = (group.kind ?? "hard") as ChecklistTierKind
      const items = (group.items ?? [])
        .map((item): BoardChecklistItemRow | null => {
          const text = (item.text ?? item.id ?? "").trim()
          if (!text) return null
          const key = (item.id ?? item.text ?? "").trim()
          const aiMark = aiMarkForItem(kind, text, evaluation)
          const ov = overrides[key]
          const mark = ov ?? aiMark
          return { key, text, aiMark, mark, overridden: ov != null && ov !== aiMark }
        })
        .filter((item): item is BoardChecklistItemRow => Boolean(item))
      if (items.length === 0) return null
      const good = (m: ChecklistMark) => m === "met" || m === "clear"
      return {
        kind,
        heading: group.heading?.trim() || CHECKLIST_TIER_LABEL[kind] || kind,
        items,
        met: items.filter((i) => good(i.mark)).length,
        total: items.length,
      }
    })
    .filter((group): group is BoardChecklistGroupRow => Boolean(group))
    .sort((a, b) => CHECKLIST_TIER_ORDER.indexOf(a.kind) - CHECKLIST_TIER_ORDER.indexOf(b.kind))
}

/** Quick-reject chips grouped under candidate background, mirroring the recruiter
 *  submission screening design (school / GPA / degree / company pillars). */
const BACKGROUND_REJECT_CHIPS: Array<{ id: string; label: string }> = [
  { id: "weak_school", label: "Weak / non-target school" },
  { id: "low_gpa", label: "Low GPA" },
  { id: "degree_mismatch", label: "Degree / field mismatch" },
  { id: "weak_company_pedigree", label: "Weak company pedigree" },
  { id: "no_relevant_domain", label: "No relevant domain" },
  { id: "over_leveled", label: "Over-leveled / too senior" },
  { id: "under_leveled", label: "Under-leveled" },
]

const BACKGROUND_PILLARS: Array<{ key: "school" | "gpa" | "degree" | "company"; label: string }> = [
  { key: "school", label: "School" },
  { key: "gpa", label: "GPA" },
  { key: "degree", label: "Degree" },
  { key: "company", label: "Company" },
]

function markGlyph(mark: ChecklistMark): string {
  return mark === "gap" ? "✗" : mark === "flag" ? "⚑" : "✓"
}
function markColor(mark: ChecklistMark): string {
  return mark === "gap" || mark === "flag" ? "#b91c1c" : "#15803d"
}
function pillarTone(verdict: string | undefined): { bg: string; fg: string } {
  if (verdict === "weak") return { bg: "#fcebeb", fg: "#791f1f" }
  if (verdict === "strong") return { bg: "#e1f5ee", fg: "#0f6e56" }
  return { bg: "#f1efe8", fg: "#777" }
}

function BoardChecklistPanel({
  groups,
  evaluation,
  marks,
  saved,
  saving,
  onCycle,
  onSave,
}: {
  groups: BoardChecklistGroupDoc[]
  evaluation: SubmissionAiEvaluation | undefined
  marks: RecruiterChecklistMarks
  saved: RecruiterChecklistMarks
  saving: boolean
  onCycle: (key: string, kind: ChecklistTierKind, current: ChecklistMark, aiMark: ChecklistMark) => void
  onSave: () => void
}) {
  const rows = buildBoardChecklist(groups, evaluation, marks)
  const background = evaluation?.background
  const hasBackground =
    background && BACKGROUND_PILLARS.some(({ key }) => {
      const v = background[key]?.verdict
      return v === "strong" || v === "weak"
    })
  if (rows.length === 0 && !hasBackground) return null
  const markKeys = Object.keys(marks)
  const savedKeys = Object.keys(saved)
  const dirty = markKeys.length !== savedKeys.length || markKeys.some((k) => marks[k] !== saved[k])
  const overrideCount = markKeys.length
  return (
    <div style={{ border: "1px solid #c7d2fe", borderLeft: "4px solid #6366f1", borderRadius: 8, background: "#f5f6ff", padding: "12px 14px", display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13, color: "#3730a3" }}>Checklist assessment</strong>
        <span style={{ fontSize: 11, color: "#6366f1" }}>AI marks · click an item to override</span>
        {overrideCount > 0 && <span style={{ fontSize: 11, color: "#4338ca" }}>· {overrideCount} edited</span>}
      </div>

      {hasBackground && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#6f6256", fontWeight: 700 }}>Background</span>
          {BACKGROUND_PILLARS.map(({ key, label }) => {
            const p = background?.[key]
            const v = p?.verdict
            if (v !== "strong" && v !== "weak" && v !== "unknown") return null
            const tone = pillarTone(v)
            return (
              <span key={key} title={p?.evidence} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: tone.bg, color: tone.fg }}>
                {label}: {v}
              </span>
            )
          })}
        </div>
      )}

      {rows.map((group) => (
        <div key={group.kind} style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.03em", color: "#4338ca", textTransform: "uppercase" }}>
            {group.heading} · {group.met}/{group.total}
          </div>
          {group.items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onCycle(item.key, group.kind, item.mark, item.aiMark)}
              title="Click to override the AI mark"
              style={{ display: "flex", gap: 8, alignItems: "flex-start", textAlign: "left", background: "transparent", border: "none", padding: "2px 0", cursor: "pointer", fontSize: 12.5, lineHeight: 1.4 }}
            >
              <span style={{ color: markColor(item.mark), fontWeight: 700, width: 14, flexShrink: 0 }}>{markGlyph(item.mark)}</span>
              <span style={{ color: item.mark === "gap" || item.mark === "flag" ? "#1e293b" : "#64748b" }}>
                {item.text}
                {item.overridden && <span style={{ marginLeft: 6, fontSize: 10, color: "#6366f1", fontWeight: 700 }}>edited</span>}
              </span>
            </button>
          ))}
        </div>
      ))}

      <button
        type="button"
        disabled={saving || !dirty}
        onClick={onSave}
        style={{ justifySelf: "start", padding: "5px 12px", fontSize: 12, fontWeight: 600, border: "1px solid #6366f1", borderRadius: 6, background: dirty ? "#6366f1" : "#e0e2f5", color: dirty ? "#fff" : "#9095c4", cursor: saving || !dirty ? "default" : "pointer" }}
      >
        {saving ? "Saving…" : dirty ? "Save assessment" : "Saved"}
      </button>
    </div>
  )
}

function AiDetail({ submission }: { submission: BoardSubmissionDoc }) {
  const evaluation = submission.aiEvaluation
  if (!evaluation) {
    return <div style={{ color: "#777", fontSize: 12 }}>AI evaluation pending — it lands on the doc shortly after submission.</div>
  }
  const checklist = evaluation.checklist
  const research = evaluation.research
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {evaluation.error && (
        <div style={{ color: "#9c3a1d", fontSize: 12 }}>Evaluation error: {evaluation.error}</div>
      )}
      {evaluation.summary && <div style={{ fontSize: 13, lineHeight: 1.45 }}>{evaluation.summary}</div>}
      {(evaluation.reasons?.length ?? 0) > 0 && (
        <GapList label="Reasons" items={evaluation.reasons ?? []} />
      )}
      {checklist && (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12, color: "#555" }}>
            Checklist: hard {checklist.hard?.met ?? 0}/{checklist.hard?.total ?? 0} · fit {checklist.fit?.met ?? 0}/{checklist.fit?.total ?? 0} · bonus {checklist.bonus?.met ?? 0}/{checklist.bonus?.total ?? 0} · anti flagged {checklist.anti?.flagged ?? 0}/{checklist.anti?.total ?? 0}
          </div>
          <GapList label="Hard gaps" items={checklist.hard?.gaps ?? []} />
          <GapList label="Fit gaps" items={checklist.fit?.gaps ?? []} />
          <GapList label="Bonus gaps" items={checklist.bonus?.gaps ?? []} />
          <GapList label="Anti-signal flags" items={checklist.anti?.flags ?? []} />
        </div>
      )}
      {research && (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 12, color: "#555" }}>
            Research ({research.source ?? "coresignal"}){research.headline ? ` — ${research.headline}` : ""}
          </div>
          {(research.companies?.length ?? 0) > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#555" }}>
              {(research.companies ?? []).map((company, i) => (
                <li key={i}>
                  {company.name}
                  {company.role ? ` — ${company.role}` : ""}
                  {company.years ? ` (${company.years})` : ""}
                </li>
              ))}
            </ul>
          )}
          <GapList label="Signals" items={research.signals ?? []} />
          <GapList label="Risks" items={research.risks ?? []} />
        </div>
      )}
      <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#999", flexWrap: "wrap" }}>
        {evaluation.model && <span>{evaluation.model}</span>}
        {evaluation.evaluatedAt && <span>evaluated {new Date(evaluation.evaluatedAt).toLocaleString()}</span>}
        {submission.candidate?.resumeUrl && (
          <a href={submission.candidate.resumeUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#2a5fb8" }}>
            resume
          </a>
        )}
      </div>
    </div>
  )
}

function jobLookupKeys(submission: BoardSubmissionDoc): string[] {
  const keys = [submission.jobId?.trim(), submission.inboundJobId?.trim()].filter(
    (key): key is string => Boolean(key),
  )
  return [...new Set(keys)]
}

function jobLookupKey(submission: BoardSubmissionDoc): string | null {
  return jobLookupKeys(submission)[0] ?? null
}

function findSubmissionJob(
  jobDocs: Record<string, BoardJobDoc>,
  submission: BoardSubmissionDoc,
): BoardJobDoc | undefined {
  for (const key of jobLookupKeys(submission)) {
    const job = jobDocs[key]
    if (job) return job
  }
  return undefined
}

function ReviewField({ label, value, href }: { label: string; value?: string; href?: string | null }) {
  if (!value?.trim()) return null
  return (
    <div style={compactFieldStyle}>
      <div style={{ color: "#8b7d6d", fontSize: 10, textTransform: "uppercase", letterSpacing: 0 }}>{label}</div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#2a5fb8", fontSize: 12, fontWeight: 600, overflowWrap: "anywhere" }}
        >
          {value.trim()}
        </a>
      ) : (
        <div style={{ color: "#35291f", fontSize: 12, fontWeight: 600, overflowWrap: "anywhere" }}>{value.trim()}</div>
      )}
    </div>
  )
}

function JobContextPanel({ job, submission }: { job?: BoardJobDoc; submission: BoardSubmissionDoc }) {
  const title = job?.title ?? submission.jobTitleSnapshot ?? submission.jobId ?? "Selected role"
  const company = job?.recruiterBoard?.label?.company ?? job?.company ?? submission.companyLabelSnapshot
  const groups = job?.recruiterBoard?.checklist?.groups ?? []
  const blocks = job?.jdBlocks ?? []
  return (
    <div style={reviewContextStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div>
          <div style={roleContextLabelStyle}>Role context</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#2b2119", lineHeight: 1.2 }}>{title}</div>
          {company && <div style={{ color: "#7b6f61", fontSize: 13, marginTop: 2 }}>{company}</div>}
        </div>
        <Badge tone="info">{selfScoreLabel(submission.score)}</Badge>
      </div>
      {groups.length > 0 && (
        <div style={reviewSectionStyle}>
          <div style={roleContextSectionTitleStyle}>Checklist</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
            {groups.map((group, index) => (
              <div key={`${group.kind ?? "group"}-${index}`} style={roleContextCardStyle}>
                <div style={roleContextLabelStyle}>{group.heading ?? group.kind ?? "Checklist"}</div>
                <ul style={roleContextListStyle}>
                  {(group.items ?? []).slice(0, 8).map((item, i) => (
                    <li key={item.id ?? i}>{item.text ?? item.id}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
      {blocks.length > 0 && (
        <div style={reviewSectionStyle}>
          <div style={roleContextSectionTitleStyle}>Job description</div>
          {blocks.slice(0, 6).map((block, index) => (
            <div key={`${block.heading ?? "block"}-${index}`}>
              {block.heading && <div style={roleContextSectionTitleStyle}>{block.heading}</div>}
              {block.body && (
                <div style={{ ...roleContextTextStyle, whiteSpace: "pre-wrap" }}>{block.body}</div>
              )}
              {Array.isArray(block.items) && block.items.length > 0 && (
                <ul style={roleContextListStyle}>
                  {block.items.slice(0, 10).map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{item}</li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CandidateReviewPanel({
  submission,
  job,
  busy,
  blocked,
  actionError,
  rejectOpen,
  rejectCategory,
  rejectTier,
  rejectReason,
  requestInfoOpen,
  requestMessage,
  onClose,
  onOpenReject,
  onRejectCategory,
  onRejectTier,
  onRejectReason,
  onRequestInfoOpen,
  onRequestMessage,
  onApplyAction,
  onCommentCount,
  checklistGroups,
  onSaveMarks,
  marksSaving,
}: {
  submission: BoardSubmissionDoc
  job?: BoardJobDoc
  busy: boolean
  blocked: boolean
  actionError?: string
  rejectOpen: boolean
  rejectCategory: RecruiterCandidateRejectionCategory
  rejectTier: RecruiterCandidateTier
  rejectReason: string
  requestInfoOpen: boolean
  requestMessage: string
  onClose: () => void
  onOpenReject: (open: boolean) => void
  onRejectCategory: (value: RecruiterCandidateRejectionCategory) => void
  onRejectTier: (value: RecruiterCandidateTier) => void
  onRejectReason: (value: string) => void
  onRequestInfoOpen: (open: boolean) => void
  onRequestMessage: (value: string) => void
  onApplyAction: (action: RecruiterSubmissionAction, options?: { requestMessage?: string; rejection?: RecruiterSubmissionRejectionInput; checklistMarks?: RecruiterChecklistMarks }) => void
  onCommentCount: (submissionId: string, count: number) => void
  checklistGroups: BoardChecklistGroupDoc[]
  onSaveMarks: (marks: RecruiterChecklistMarks) => void
  marksSaving: boolean
}) {
  // Local per-item checklist override marks (seeded from the saved assessment)
  // and quick-reject chip selections. Reset per submission via `key` at the render site.
  const savedMarks = submission.adminChecklistMarks?.marks ?? {}
  const [marks, setMarks] = useState<RecruiterChecklistMarks>(() => ({ ...savedMarks }))
  const [reasonChips, setReasonChips] = useState<Set<string>>(() => new Set())
  function cycleMark(key: string, kind: ChecklistTierKind, current: ChecklistMark, aiMark: ChecklistMark) {
    const next = cycleChecklistMark(kind, current)
    setMarks((prev) => {
      const copy = { ...prev }
      if (next === aiMark) delete copy[key]
      else copy[key] = next
      return copy
    })
  }
  function toggleReasonChip(id: string) {
    setReasonChips((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const stage = submissionStage(submission.status)
  const status = statusDisplay(submission.status)
  const chip = verdictChip(submission.aiEvaluation)
  const href = candidateHref(submission)
  const resumeHref = submission.candidate?.resumeUrl?.trim() ? submission.candidate.resumeUrl.trim() : null
  const email = submission.candidate?.email?.trim()
  const dim = blocked ? blockedButtonStyle : null
  const rejectDisabled = blocked
  return (
    <SideDrawer
      title={submission.candidate?.name ?? "Candidate"}
      subtitle={submission.jobTitleSnapshot ?? submission.jobId ?? submission.id}
      onClose={onClose}
      xl
    >
      <style>{DUAL_PANE_COLLAPSE_CSS}</style>
      <div className="pa-eval-dualpane" style={dualPaneStyle} aria-label="Candidate review panel">
        {/* LEFT — candidate info + AI evaluation, read-only */}
        <div style={{ display: "grid", gap: 14, alignContent: "start", minWidth: 0 }}>
          <div style={paneHeaderStyle}>Candidate · AI evaluation — read-only</div>
          <div>
            <div style={{ color: "#8b7d6d", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0 }}>
              Candidate
            </div>
            <div style={{ fontSize: 20, fontWeight: 750, color: "#2b2119", lineHeight: 1.15, overflowWrap: "anywhere" }}>
              {submission.candidate?.name ?? "Candidate"}
            </div>
            {submission.candidate?.currentRole && (
              <div style={{ color: "#73695d", fontSize: 12, marginTop: 3 }}>{submission.candidate.currentRole}</div>
            )}
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Badge tone={status.tone}>{status.label}</Badge>
            <Badge tone={chip.tone}>{chip.label}</Badge>
            <span style={{ color: "#8b7d6d", fontSize: 12 }}>{formatSubmittedDate(submission.createdAtMs ?? 0)}</span>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {href && (
                <a href={href} target="_blank" rel="noopener noreferrer" style={actionButtonStyle}>
                  LinkedIn
                </a>
              )}
              {resumeHref && (
                <a href={resumeHref} target="_blank" rel="noopener noreferrer" style={actionButtonStyle}>
                  Resume
                </a>
              )}
              {email && (
                <a href={`mailto:${email}`} style={actionButtonStyle}>
                  Email
                </a>
              )}
            </div>
            <div style={fieldGridStyle}>
              <ReviewField label="Email" value={submission.candidate?.email} />
              <ReviewField label="YoE" value={submission.candidate?.yoe} />
              <ReviewField label="Company" value={submission.candidate?.currentCompany} />
              <ReviewField label="Location" value={submission.candidate?.location} />
              <ReviewField label="Work auth" value={submission.candidate?.workAuthorization} />
              <ReviewField label="Employment" value={submission.candidate?.employmentStatus} />
              <ReviewField label="Comp" value={submission.candidate?.compensationExpectation} />
              <ReviewField label="Notice" value={submission.candidate?.noticePeriod} />
            </div>
            {submission.candidate?.notes && (
              <div style={{ color: "#4e443a", fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                {submission.candidate.notes}
              </div>
            )}
          </div>

          <CandidateResumePreview
            resumeUrl={submission.candidate?.resumeUrl}
            linkedinUrl={submission.candidate?.linkedinUrl}
            height="74vh"
          />

          {/* AI evaluation verdict/confidence/summary/reasons + background pillars */}
          <div style={{ display: "grid", gap: 8 }}>
            <ExtraFieldsDetail extraFields={submission.extraFields} />
            <AiDetail submission={submission} />
          </div>

          {/* Role checklist (read-only role context — checklist + JD) */}
          <JobContextPanel job={job} submission={submission} />
        </div>

        {/* RIGHT — human review: recruiter status/feedback actions + checklist assessment + conversation */}
        <div style={{ display: "grid", gap: 16, alignContent: "start", minWidth: 0 }}>
          <div style={paneHeaderStyle}>Human review</div>

          <BoardChecklistPanel
            groups={checklistGroups}
            evaluation={submission.aiEvaluation}
            marks={marks}
            saved={savedMarks}
            saving={marksSaving}
            onCycle={cycleMark}
            onSave={() => onSaveMarks(marks)}
          />

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: "#4b3a2e" }}>Decision</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {stage !== "terminal" && (
            <button
              type="button"
              disabled={blocked}
              aria-disabled={blocked}
              onClick={() => onApplyAction(STAGE_PRIMARY_ACTION[stage].action)}
              style={{ ...actionButtonStyle, border: "1px solid #9bc09b", background: "#f1f8f1", color: "#1d5c2c", ...dim }}
            >
              {busy ? "Working..." : STAGE_PRIMARY_ACTION[stage].label}
            </button>
          )}
          <button
            type="button"
            disabled={blocked}
            aria-disabled={blocked}
            onClick={() => onOpenReject(!rejectOpen)}
            style={{ ...actionButtonStyle, border: "1px solid #d9a8a0", background: "#fdf3f1", color: "#9c3a1d", ...dim }}
          >
            Reject
          </button>
          {stage === "pending" && (
            <button
              type="button"
              disabled={blocked}
              aria-disabled={blocked}
              onClick={() => onRequestInfoOpen(!requestInfoOpen)}
              style={{ ...actionButtonStyle, ...dim }}
            >
              Request info
            </button>
          )}
          <button
            type="button"
            disabled={blocked}
            aria-disabled={blocked}
            onClick={() => onApplyAction("reviewing")}
            style={{ ...actionButtonStyle, ...dim }}
          >
            Reviewing
          </button>
          <button
            type="button"
            disabled={blocked}
            aria-disabled={blocked}
            onClick={() => onApplyAction("duplicate")}
            style={{ ...actionButtonStyle, ...dim }}
          >
            Duplicate
          </button>
        </div>

        {rejectOpen && (
          <div style={{ display: "grid", gap: 8, border: "1px solid #ead8d3", borderRadius: 8, padding: 10, background: "#fff8f6" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <label style={{ display: "grid", gap: 4, fontSize: 11, color: "#6f6256", fontWeight: 700 }}>
                Type
                <select
                  value={rejectCategory}
                  onChange={(e) => onRejectCategory(e.target.value as RecruiterCandidateRejectionCategory)}
                  style={{ padding: "6px 8px", border: "1px solid #d9c9bb", borderRadius: 6, fontSize: 12 }}
                >
                  <option value="quality">Quality</option>
                  <option value="role_fit">Role fit</option>
                </select>
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 11, color: "#6f6256", fontWeight: 700 }}>
                Tier
                <select
                  value={rejectTier}
                  onChange={(e) => onRejectTier(e.target.value as RecruiterCandidateTier)}
                  style={{ padding: "6px 8px", border: "1px solid #d9c9bb", borderRadius: 6, fontSize: 12 }}
                >
                  <option value="tier_3">Tier 3 hard reject</option>
                  <option value="tier_2">Tier 2 possible</option>
                  <option value="tier_1">Tier 1 reusable</option>
                </select>
              </label>
            </div>
            <div style={{ display: "grid", gap: 5 }}>
              <div style={{ fontSize: 11, color: "#6f6256", fontWeight: 700 }}>Background quick-reject</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {BACKGROUND_REJECT_CHIPS.map((chip) => {
                  const active = reasonChips.has(chip.id)
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => toggleReasonChip(chip.id)}
                      style={{
                        padding: "3px 10px",
                        fontSize: 11,
                        borderRadius: 999,
                        cursor: "pointer",
                        border: active ? "1px solid #d9a8a0" : "1px solid #e2d6cc",
                        background: active ? "#fdeceA" : "#fff",
                        color: active ? "#9c3a1d" : "#6f6256",
                        fontWeight: active ? 700 : 500,
                      }}
                    >
                      {active ? "✓ " : ""}{chip.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <textarea
              value={rejectReason}
              onChange={(e) => onRejectReason(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Why this candidate is rejected (the quick-reject chips above are saved too)"
              aria-label="Rejection reason"
              style={{ width: "100%", padding: "7px 8px", border: "1px solid #d9c9bb", borderRadius: 6, fontSize: 12 }}
            />
            <button
              type="button"
              disabled={rejectDisabled}
              aria-disabled={rejectDisabled}
              onClick={() => onApplyAction("reject", {
                rejection: {
                  category: rejectCategory,
                  candidateTier: rejectTier,
                  reason: rejectReason.trim(),
                  ...(reasonChips.size > 0 ? { reasons: [...reasonChips] } : {}),
                },
                ...(Object.keys(marks).length > 0 ? { checklistMarks: marks } : {}),
              })}
              style={{ ...actionButtonStyle, justifySelf: "start", border: "1px solid #d9a8a0", background: "#fdf3f1", color: "#9c3a1d", ...dim }}
            >
              {busy ? "Rejecting..." : "Save rejection"}
            </button>
          </div>
        )}

        {requestInfoOpen && stage === "pending" && (
          <div style={{ display: "grid", gap: 8, border: "1px solid #e7dccb", borderRadius: 8, padding: 10, background: "#fffaf0" }}>
            <textarea
              value={requestMessage}
              onChange={(e) => onRequestMessage(e.target.value)}
              rows={3}
              style={{ width: "100%", padding: "7px 8px", border: "1px solid #d9c9bb", borderRadius: 6, fontSize: 12 }}
            />
            <button
              type="button"
              disabled={blocked || !requestMessage.trim()}
              aria-disabled={blocked || !requestMessage.trim()}
              onClick={() => onApplyAction("request_info", { requestMessage: requestMessage.trim() })}
              style={{ ...actionButtonStyle, justifySelf: "start", ...dim }}
            >
              {busy ? "Sending..." : "Send request"}
            </button>
          </div>
        )}
            {actionError && <div style={{ color: "#9c3a1d", fontSize: 11 }}>Action failed: {actionError}</div>}
          </div>

          <ConversationSection submission={submission} onCommentCount={onCommentCount} />
        </div>
      </div>
    </SideDrawer>
  )
}

function ConversationSection({
  submission,
  onCommentCount,
}: {
  submission: BoardSubmissionDoc
  onCommentCount: (submissionId: string, count: number) => void
}) {
  const [comments, setComments] = useState<SubmissionCommentDoc[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [pendingComment, setPendingComment] = useState<SubmissionCommentDoc | null>(null)

  async function fetchComments(): Promise<SubmissionCommentDoc[]> {
    const snap = await getDocs(
      query(collection(db(), "pa-recruiter-submissions", submission.id, "comments"), orderBy("at", "asc")),
    )
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SubmissionCommentDoc, "id">) }))
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows = await fetchComments()
        if (cancelled) return
        setComments(rows)
        setLoadError(null)
        onCommentCount(submission.id, rows.length)
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [submission.id])

  async function handleSend() {
    const message = draft.trim()
    if (!message || sending) return
    setSending(true)
    setSendError(null)
    setPendingComment({
      id: `pending-${Date.now()}`,
      message,
      by: "wekruit",
      authorName: "you",
      at: new Date().toISOString(),
    })
    setDraft("")
    try {
      await sendRecruiterSubmissionComment({ submissionId: submission.id, message })
      const rows = await fetchComments()
      setComments(rows)
      onCommentCount(submission.id, rows.length)
      setPendingComment(null)
    } catch (e) {
      setPendingComment(null)
      setDraft(message)
      setSendError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const entries = buildConversationEntries(comments ?? [], submission.requestedInfo)
  if (pendingComment) {
    entries.push({
      key: pendingComment.id,
      kind: "comment",
      side: "right",
      author: pendingComment.authorName ?? "you",
      at: pendingComment.at,
      message: pendingComment.message ?? "",
      pending: true,
    })
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 12, color: "#555" }}>Conversation</div>
      {loadError && <div style={{ color: "#9c3a1d", fontSize: 12 }}>Failed to load comments: {loadError}</div>}
      {comments === null && !loadError ? (
        <div style={{ color: "#777", fontSize: 12 }}>Loading conversation…</div>
      ) : entries.length === 0 ? (
        <div style={{ color: "#777", fontSize: 12 }}>No messages yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {entries.map((entry) => (
            <div
              key={entry.key}
              style={{ display: "flex", justifyContent: entry.side === "right" ? "flex-end" : "flex-start" }}
            >
              <div
                style={{
                  maxWidth: 420,
                  padding: "6px 10px",
                  borderRadius: 10,
                  border: `1px solid ${entry.side === "right" ? "#d7e3f6" : "#e6e2d8"}`,
                  background: entry.side === "right" ? "#eef3fb" : "#fdfcf8",
                  opacity: entry.pending ? 0.6 : 1,
                }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: "#777", marginBottom: 2 }}>
                  <span style={{ fontWeight: 600 }}>{entry.author}</span>
                  {entry.kind === "request" && (
                    <span
                      style={{
                        border: "1px solid #d8c9a8",
                        background: "#fbf4e3",
                        color: "#7a5c1e",
                        borderRadius: 999,
                        padding: "0 6px",
                        fontSize: 10,
                      }}
                    >
                      request
                    </span>
                  )}
                  <span>{entry.pending ? "sending…" : formatMessageTime(entry.at)}</span>
                </div>
                <div style={{ fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{entry.message}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start", maxWidth: 560 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          maxLength={4000}
          placeholder="Message the recruiter…"
          aria-label="Message the recruiter"
          style={{ flex: 1, padding: "6px 8px", border: "1px solid #ddd", borderRadius: 6, fontSize: 12 }}
        />
        <button
          type="button"
          disabled={sending || !draft.trim()}
          aria-disabled={sending || !draft.trim()}
          onClick={() => void handleSend()}
          style={actionButtonStyle}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {sendError && <div style={{ color: "#9c3a1d", fontSize: 11 }}>Send failed: {sendError}</div>}
    </div>
  )
}

export default function RecruiterBoardOps() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [submissions, setSubmissions] = useState<BoardSubmissionDoc[]>([])
  const [recruiters, setRecruiters] = useState<BoardRecruiterDoc[]>([])
  const [jobDocs, setJobDocs] = useState<Record<string, BoardJobDoc>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [requestInfoOpen, setRequestInfoOpen] = useState(false)
  const [requestMessage, setRequestMessage] = useState(DEFAULT_REQUEST_MESSAGE)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectCategory, setRejectCategory] = useState<RecruiterCandidateRejectionCategory>(DEFAULT_REJECTION_CATEGORY)
  const [rejectTier, setRejectTier] = useState<RecruiterCandidateTier>(DEFAULT_REJECTION_TIER)
  const [rejectReason, setRejectReason] = useState("")
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkRejectCategory, setBulkRejectCategory] = useState<RecruiterCandidateRejectionCategory>(DEFAULT_REJECTION_CATEGORY)
  const [bulkRejectTier, setBulkRejectTier] = useState<RecruiterCandidateTier>(DEFAULT_REJECTION_TIER)
  const [bulkRejectReason, setBulkRejectReason] = useState("")
  const [bulkRejecting, setBulkRejecting] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [submissionFilter, setSubmissionFilter] = useState<BoardSubmissionFilter>("pending")
  const [inFlightId, setInFlightId] = useState<string | null>(null)
  const [marksSavingId, setMarksSavingId] = useState<string | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [reloadKey, setReloadKey] = useState(0)
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})
  const [jobPageByKey, setJobPageByKey] = useState<Record<string, number>>({})

  function handleCommentCount(submissionId: string, count: number) {
    setCommentCounts((prev) => (prev[submissionId] === count ? prev : { ...prev, [submissionId]: count }))
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        setErr(null)
        const recruiterSnap = await getDocs(collection(db(), "pa-recruiter-users"))
        if (cancelled) return
        const loadedRecruiters = recruiterSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<BoardRecruiterDoc, "id">) }))
        const submissionQueries = [
          getDocs(query(
            collection(db(), "pa-recruiter-submissions"),
            orderBy("createdAt", "desc"),
            limit(BOARD_UNCLAIMED_SUBMISSION_LIMIT),
          )),
          ...loadedRecruiters.flatMap((recruiter) =>
            recruiterSubmissionLookupKeys(recruiter).map(({ field, value }) =>
              getDocs(query(
                collection(db(), "pa-recruiter-submissions"),
                where(field, "==", value),
                orderBy("createdAt", "desc"),
                limit(BOARD_SUBMISSIONS_PER_RECRUITER_LIMIT),
              )),
            ),
          ),
        ]
        const submissionSnaps = await Promise.all(submissionQueries)
        if (cancelled) return
        const loadedSubmissions = capBoardSubmissionsPerRecruiter(loadedRecruiters, submissionSnaps.flatMap((snap) => snap.docs).map((d) => {
          const data = d.data() as Omit<BoardSubmissionDoc, "id">
          return { id: d.id, ...data, createdAtMs: timestampToMs(data.createdAt) }
        }), BOARD_SUBMISSIONS_PER_RECRUITER_LIMIT)
        const jobIds = [...new Set(loadedSubmissions.flatMap(jobLookupKeys))]
        const loadedJobs = await Promise.all(
          jobIds.map(async (jobId) => {
            const snap = await getDoc(doc(db(), "pa-jobs", jobId))
            return snap.exists() ? [jobId, { id: snap.id, ...(snap.data() as Omit<BoardJobDoc, "id">) }] as const : null
          }),
        )
        if (cancelled) return
        setSubmissions(loadedSubmissions)
        setRecruiters(loadedRecruiters)
        setJobDocs(Object.fromEntries(loadedJobs.filter((entry): entry is readonly [string, BoardJobDoc] => entry !== null)))
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const { recruiterGroups, unclaimedGroups } = useMemo(
    () => buildBoardGroups(recruiters, submissions),
    [recruiters, submissions],
  )
  const visibleRecruiterGroups = useMemo(
    () =>
      recruiterGroups
        .map((group) => ({
          ...group,
          jobs: group.jobs
            .map((job) => ({ ...job, submissions: visibleBoardSubmissionsForFilter(job.submissions, submissionFilter) }))
            .filter((job) => job.submissions.length > 0),
        }))
        .filter((group) => group.jobs.length > 0),
    [recruiterGroups, submissionFilter],
  )
  const visibleUnclaimedGroups = useMemo(
    () =>
      unclaimedGroups
        .map((group) => ({
          ...group,
          jobs: group.jobs
            .map((job) => ({ ...job, submissions: visibleBoardSubmissionsForFilter(job.submissions, submissionFilter) }))
            .filter((job) => job.submissions.length > 0),
        }))
        .filter((group) => group.jobs.length > 0),
    [unclaimedGroups, submissionFilter],
  )
  const boardJobPageKey = (groupKey: string, jobKey: string) => `${submissionFilter}:${groupKey}:${jobKey}`

  useEffect(() => {
    const maxPageByKey = new Map<string, number>()
    for (const group of [...visibleRecruiterGroups, ...visibleUnclaimedGroups]) {
      for (const job of group.jobs) {
        maxPageByKey.set(
          boardJobPageKey(group.key, job.key),
          Math.max(0, Math.ceil(job.submissions.length / BOARD_SUBMISSION_PAGE_SIZE) - 1),
        )
      }
    }
    setJobPageByKey((prev) => {
      let changed = false
      const next: Record<string, number> = {}
      for (const [key, maxPage] of maxPageByKey.entries()) {
        const page = Math.min(Math.max(0, prev[key] ?? 0), maxPage)
        next[key] = page
        if (prev[key] !== page) changed = true
      }
      if (Object.keys(prev).length !== Object.keys(next).length) changed = true
      return changed ? next : prev
    })
  }, [visibleRecruiterGroups, visibleUnclaimedGroups, submissionFilter])

  const pendingTotal = submissions.filter(isPending).length
  const selectedBulkCount = bulkSelectedIds.size
  const selectedSubmission = useMemo(
    () => submissions.find((submission) => submission.id === selectedId) ?? null,
    [selectedId, submissions],
  )
  const selectedJob = selectedSubmission ? findSubmissionJob(jobDocs, selectedSubmission) : undefined

  useEffect(() => {
    if (selectedId && !submissions.some((submission) => submission.id === selectedId)) {
      setSelectedId(null)
    }
  }, [selectedId, submissions])

  useEffect(() => {
    setRejectOpen(false)
    setRejectCategory(DEFAULT_REJECTION_CATEGORY)
    setRejectTier(DEFAULT_REJECTION_TIER)
    setRejectReason("")
    setRequestInfoOpen(false)
    setRequestMessage(DEFAULT_REQUEST_MESSAGE)
  }, [selectedId])

  useEffect(() => {
    const validIds = new Set(
      visibleBoardSubmissionsForFilter(submissions, submissionFilter)
        .filter(isBulkRejectSelectable)
        .map((submission) => submission.id),
    )
    setBulkSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => validIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [submissions, submissionFilter])

  function toggleBulkSelection(submission: BoardSubmissionDoc, selected: boolean) {
    if (!isBulkRejectSelectable(submission)) return
    setBulkSelectedIds((prev) => {
      const next = new Set(prev)
      if (selected) next.add(submission.id)
      else next.delete(submission.id)
      return next
    })
    setBulkError(null)
  }

  function setBulkSelectionForSubmissions(rows: BoardSubmissionDoc[], selected: boolean) {
    const selectable = rows.filter(isBulkRejectSelectable)
    setBulkSelectedIds((prev) => {
      const next = new Set(prev)
      for (const submission of selectable) {
        if (selected) next.add(submission.id)
        else next.delete(submission.id)
      }
      return next
    })
    setBulkError(null)
  }

  async function applyBulkReject() {
    if (inFlightId || bulkRejecting || bulkSelectedIds.size === 0) return
    const selected = submissions.filter((submission) => bulkSelectedIds.has(submission.id) && isBulkRejectSelectable(submission))
    if (selected.length === 0) return
    const rejection = {
      category: bulkRejectCategory,
      candidateTier: bulkRejectTier,
      reason: bulkRejectReason.trim(),
    }
    const succeeded = new Set<string>()
    let failureCount = 0
    setBulkRejecting(true)
    setBulkError(null)
    setActionErrors((prev) => {
      const next = { ...prev }
      for (const submission of selected) delete next[submission.id]
      return next
    })
    try {
      for (const submission of selected) {
        const priorStatus = submission.status
        setInFlightId(submission.id)
        setSubmissions((prev) => prev.map((s) => (s.id === submission.id ? { ...s, status: "rejected" } : s)))
        try {
          const result = await runRecruiterSubmissionAction({
            submissionId: submission.id,
            action: "reject",
            rejection,
          })
          succeeded.add(submission.id)
          setSubmissions((prev) =>
            prev.map((s) => (s.id === submission.id ? { ...s, status: result.status } : s)),
          )
        } catch (error) {
          failureCount += 1
          setSubmissions((prev) => prev.map((s) => (s.id === submission.id ? { ...s, status: priorStatus } : s)))
          setActionErrors((prev) => ({
            ...prev,
            [submission.id]: error instanceof Error ? error.message : String(error),
          }))
        }
      }
    } finally {
      setInFlightId(null)
      setBulkRejecting(false)
      setBulkSelectedIds((prev) => {
        const next = new Set(prev)
        for (const id of succeeded) next.delete(id)
        return next
      })
      if (failureCount > 0) {
        setBulkError(`${failureCount} rejection${failureCount === 1 ? "" : "s"} failed. Failed rows remain selected.`)
      } else {
        setBulkRejectReason("")
      }
    }
  }

  async function saveChecklistMarks(submission: BoardSubmissionDoc, marks: RecruiterChecklistMarks) {
    if (inFlightId || bulkRejecting || marksSavingId) return
    setMarksSavingId(submission.id)
    setActionErrors((prev) => {
      const next = { ...prev }
      delete next[submission.id]
      return next
    })
    try {
      await runRecruiterSubmissionAction({ submissionId: submission.id, action: "save_marks", checklistMarks: marks })
      setSubmissions((prev) =>
        prev.map((s) =>
          s.id === submission.id ? { ...s, adminChecklistMarks: { marks, at: new Date().toISOString() } } : s,
        ),
      )
    } catch (error) {
      setActionErrors((prev) => ({ ...prev, [submission.id]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setMarksSavingId(null)
    }
  }

  async function applyAction(
    submission: BoardSubmissionDoc,
    action: RecruiterSubmissionAction,
    options?: { requestMessage?: string; rejection?: RecruiterSubmissionRejectionInput; checklistMarks?: RecruiterChecklistMarks },
  ) {
    if (inFlightId || bulkRejecting) return
    const priorStatus = submission.status
    const optimisticStatus = RECRUITER_SUBMISSION_ACTION_TO_STATUS[action]
    setInFlightId(submission.id)
    setActionErrors((prev) => {
      const next = { ...prev }
      delete next[submission.id]
      return next
    })
    setSubmissions((prev) => prev.map((s) => (s.id === submission.id ? { ...s, status: optimisticStatus } : s)))
    try {
      const result = await runRecruiterSubmissionAction({
        submissionId: submission.id,
        action,
        ...(action === "request_info" && options?.requestMessage ? { requestMessage: options.requestMessage } : {}),
        ...(action === "reject" && options?.rejection ? { rejection: options.rejection } : {}),
        ...(options?.checklistMarks ? { checklistMarks: options.checklistMarks } : {}),
      })
      setSubmissions((prev) =>
        prev.map((s) =>
          s.id === submission.id
            ? {
                ...s,
                status: result.status,
                ...(options?.checklistMarks
                  ? { adminChecklistMarks: { marks: options.checklistMarks, at: new Date().toISOString() } }
                  : {}),
                ...(action === "request_info" && options?.requestMessage
                  ? { requestedInfo: [...(s.requestedInfo ?? []), { message: options.requestMessage, at: new Date().toISOString(), by: "WeKruit" }] }
                  : {}),
              }
            : s,
        ),
      )
      if (action === "request_info") {
        setRequestInfoOpen(false)
        setRequestMessage(DEFAULT_REQUEST_MESSAGE)
      }
      if (action === "reject") {
        setRejectOpen(false)
        setRejectReason("")
      }
    } catch (e) {
      setSubmissions((prev) => prev.map((s) => (s.id === submission.id ? { ...s, status: priorStatus } : s)))
      setActionErrors((prev) => ({ ...prev, [submission.id]: e instanceof Error ? e.message : String(e) }))
    } finally {
      setInFlightId(null)
    }
  }

  const header = (
    <PageHeader
      title="Recruiter Board"
      description="Every recruiter, the jobs they work, each submission with its AI verdict, and a one-click decision."
      actions={
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
          Refresh
        </button>
      }
    />
  )

  if (loading) {
    return (
      <div>
        {header}
        <LoadingState label="Loading recruiter board..." />
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

  const renderSubmissionRow = (submission: BoardSubmissionDoc) => {
    const href = candidateHref(submission)
    const chip = verdictChip(submission.aiEvaluation)
    const busy = inFlightId === submission.id
    const selected = selectedId === submission.id
    const bulkSelected = bulkSelectedIds.has(submission.id)
    const bulkSelectable = isBulkRejectSelectable(submission)
    const actionError = actionErrors[submission.id]
    const status = statusDisplay(submission.status)
    const othersBlocked = (inFlightId !== null || bulkRejecting) && !busy
    const blocked = busy || othersBlocked
    const dim = othersBlocked ? blockedButtonStyle : null
    return (
      <tr
        key={submission.id}
        onClick={() => setSelectedId(selected ? null : submission.id)}
        style={{ borderBottom: "1px solid #f1f1f1", cursor: "pointer", background: selected ? "#faf4ea" : undefined }}
      >
        <td style={boardSelectCellStyle} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Select ${submission.candidate?.name ?? "candidate"} for bulk rejection`}
            checked={bulkSelected}
            disabled={!bulkSelectable || bulkRejecting}
            onChange={(e) => toggleBulkSelection(submission, e.target.checked)}
          />
        </td>
        <td style={cellStyle}>
          <div style={{ fontWeight: 700, overflowWrap: "anywhere" }}>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ color: "#2a5fb8" }}
              >
                {submission.candidate?.name ?? "Candidate"}
              </a>
            ) : (
              submission.candidate?.name ?? "—"
            )}
          </div>
          {submission.candidate?.currentRole && (
            <div style={{ color: "#777", fontSize: 11 }}>{submission.candidate.currentRole}</div>
          )}
        </td>
        <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>{formatSubmittedDate(submission.createdAtMs ?? 0)}</td>
        <td style={{ ...cellStyle, whiteSpace: "nowrap", color: "#555", fontSize: 12 }}>
          {selfScoreLabel(submission.score)}
        </td>
        <td style={cellStyle}>
          <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
            <Badge tone={chip.tone}>{chip.label}</Badge>
            <Badge tone={status.tone}>{status.label}</Badge>
            {(commentCounts[submission.id] ?? 0) > 0 && (
              <span
                title={`${commentCounts[submission.id]} comment${commentCounts[submission.id] === 1 ? "" : "s"}`}
                style={{
                  fontSize: 11,
                  color: "#555",
                  border: "1px solid #e2ddd4",
                  borderRadius: 999,
                  padding: "1px 7px",
                  background: "#fff",
                  whiteSpace: "nowrap",
                }}
              >
                {commentCounts[submission.id]} msg
              </span>
            )}
          </div>
        </td>
        <td style={cellStyle} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            disabled={blocked}
            aria-disabled={blocked}
            onClick={() => setSelectedId(submission.id)}
            style={{ ...actionButtonStyle, ...dim }}
          >
            {busy ? "Working..." : selected ? "Open" : "Review"}
          </button>
          {actionError && (
            <div style={{ marginTop: 6, color: "#9c3a1d", fontSize: 11 }}>Action failed: {actionError}</div>
          )}
        </td>
      </tr>
    )
  }

  const renderSubmissionTable = (groupKey: string, job: BoardJobGroup) => {
    const pageKey = boardJobPageKey(groupKey, job.key)
    const totalPages = Math.max(1, Math.ceil(job.submissions.length / BOARD_SUBMISSION_PAGE_SIZE))
    const pageIndex = Math.min(Math.max(0, jobPageByKey[pageKey] ?? 0), totalPages - 1)
    const start = pageIndex * BOARD_SUBMISSION_PAGE_SIZE
    const pageRows = job.submissions.slice(start, start + BOARD_SUBMISSION_PAGE_SIZE)
    const first = job.submissions.length === 0 ? 0 : start + 1
    const last = Math.min(start + pageRows.length, job.submissions.length)
    const rejectablePageRows = pageRows.filter(isBulkRejectSelectable)
    const pageHasRejectable = rejectablePageRows.length > 0
    const pageAllSelected = pageHasRejectable && rejectablePageRows.every((s) => bulkSelectedIds.has(s.id))
    const setPage = (nextPage: number) => {
      setJobPageByKey((prev) => ({
        ...prev,
        [pageKey]: Math.min(Math.max(0, nextPage), totalPages - 1),
      }))
    }

    return (
      <div style={boardTableShellStyle}>
        <div style={boardPaginationBarStyle}>
          <span>
            Showing {first}-{last} of {job.submissions.length}
          </span>
          {totalPages > 1 && (
            <div style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <button
                type="button"
                disabled={pageIndex === 0}
                aria-disabled={pageIndex === 0}
                onClick={() => setPage(pageIndex - 1)}
                style={boardPaginationButtonStyle(pageIndex === 0)}
              >
                Prev
              </button>
              <span>Page {pageIndex + 1} / {totalPages}</span>
              <button
                type="button"
                disabled={pageIndex >= totalPages - 1}
                aria-disabled={pageIndex >= totalPages - 1}
                onClick={() => setPage(pageIndex + 1)}
                style={boardPaginationButtonStyle(pageIndex >= totalPages - 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
        <table style={boardTableStyle}>
          <thead>
            <tr>
              <th style={{ ...boardHeaderCellStyle, width: 34, textAlign: "center" }}>
                <input
                  type="checkbox"
                  aria-label={`Select visible rejectable submissions for ${job.title}`}
                  checked={pageAllSelected}
                  disabled={!pageHasRejectable || bulkRejecting}
                  onChange={(e) => setBulkSelectionForSubmissions(pageRows, e.target.checked)}
                />
              </th>
              <th style={{ ...boardHeaderCellStyle, width: "32%" }}>Candidate</th>
              <th style={{ ...boardHeaderCellStyle, width: "14%" }}>Submitted</th>
              <th style={{ ...boardHeaderCellStyle, width: "16%" }}>Self-score</th>
              <th style={{ ...boardHeaderCellStyle, width: "28%" }}>Review</th>
              <th style={{ ...boardHeaderCellStyle, width: "10%" }}>Open</th>
            </tr>
          </thead>
          <tbody>{pageRows.map(renderSubmissionRow)}</tbody>
        </table>
      </div>
    )
  }

  const renderGroup = (group: BoardRecruiterGroup) => (
    <Panel
      key={group.key}
      title={group.name}
      eyebrow={group.email || undefined}
      actions={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {group.accountStatus && (
            <Badge tone={recruiterAccountTone(group.accountStatus)}>{group.accountStatus}</Badge>
          )}
          <Badge tone={group.pendingCount ? "info" : "muted"}>
            {group.pendingCount} pending · {group.totalCount} total
          </Badge>
        </div>
      }
    >
      {group.jobs.length === 0 ? (
        <div style={{ color: "#777", fontSize: 12, padding: "4px 0" }}>No submissions yet.</div>
      ) : (
        <div style={boardGroupBodyStyle}>
          {group.jobs.map((job) => (
            <div key={job.key}>
              <div style={boardJobHeaderStyle}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{job.title}</span>
                {job.company && <span style={{ color: "#777", fontSize: 12 }}>{job.company}</span>}
                <span style={{ color: "#999", fontSize: 11 }}>
                  {job.pendingCount} pending · {job.totalCount} total
                </span>
              </div>
              {renderSubmissionTable(group.key, job)}
            </div>
          ))}
        </div>
      )}
    </Panel>
  )

  return (
    <div>
      {header}
      <div style={boardStatsBarStyle}>
        <div style={{ color: "#777", fontSize: 12 }}>
          {recruiterGroups.length} recruiters · {submissions.length} submissions loaded · {pendingTotal} pending
        </div>
        <div style={boardFilterShellStyle} aria-label="Submission table filter">
          <button
            type="button"
            aria-pressed={submissionFilter === "pending"}
            onClick={() => setSubmissionFilter("pending")}
            style={boardFilterButtonStyle(submissionFilter === "pending")}
          >
            Pending {pendingTotal}
          </button>
          <button
            type="button"
            aria-pressed={submissionFilter === "all"}
            onClick={() => setSubmissionFilter("all")}
            style={boardFilterButtonStyle(submissionFilter === "all")}
          >
            All {submissions.length}
          </button>
        </div>
      </div>
      {selectedBulkCount > 0 && (
        <div style={boardBulkBarStyle} aria-label="Bulk reject selected recruiter submissions">
          <strong style={{ color: "#4b3a2e", fontSize: 12 }}>
            {selectedBulkCount} selected
          </strong>
          <select
            value={bulkRejectCategory}
            onChange={(e) => setBulkRejectCategory(e.target.value as RecruiterCandidateRejectionCategory)}
            disabled={bulkRejecting}
            aria-label="Bulk rejection type"
            style={{ padding: "6px 8px", border: "1px solid #d9c9bb", borderRadius: 6, fontSize: 12 }}
          >
            <option value="quality">Quality</option>
            <option value="role_fit">Role fit</option>
          </select>
          <select
            value={bulkRejectTier}
            onChange={(e) => setBulkRejectTier(e.target.value as RecruiterCandidateTier)}
            disabled={bulkRejecting}
            aria-label="Bulk rejection tier"
            style={{ padding: "6px 8px", border: "1px solid #d9c9bb", borderRadius: 6, fontSize: 12 }}
          >
            <option value="tier_3">Tier 3 hard reject</option>
            <option value="tier_2">Tier 2 possible</option>
            <option value="tier_1">Tier 1 reusable</option>
          </select>
          <textarea
            value={bulkRejectReason}
            onChange={(e) => setBulkRejectReason(e.target.value)}
            rows={1}
            maxLength={4000}
            disabled={bulkRejecting}
            placeholder="Optional rejection response"
            aria-label="Bulk rejection reason"
            style={{ minHeight: 32, padding: "6px 8px", border: "1px solid #d9c9bb", borderRadius: 6, fontSize: 12, resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={bulkRejecting || inFlightId !== null}
              aria-disabled={bulkRejecting || inFlightId !== null}
              onClick={() => void applyBulkReject()}
              style={{ ...actionButtonStyle, border: "1px solid #d9a8a0", background: "#fdf3f1", color: "#9c3a1d" }}
            >
              {bulkRejecting ? "Rejecting..." : "Reject selected"}
            </button>
            <button
              type="button"
              disabled={bulkRejecting}
              onClick={() => setBulkSelectedIds(new Set())}
              style={actionButtonStyle}
            >
              Clear
            </button>
          </div>
          {bulkError && <div style={{ gridColumn: "1 / -1", color: "#9c3a1d", fontSize: 11 }}>{bulkError}</div>}
        </div>
      )}
      {visibleRecruiterGroups.length === 0 && visibleUnclaimedGroups.length === 0 ? (
        <EmptyState
          title={submissions.length === 0 ? "No recruiter activity yet" : "No pending submissions"}
          body={
            submissions.length === 0
              ? "Recruiter profiles and submissions will appear here as soon as the first one lands."
              : "Switch to All to review completed or non-pending submissions."
          }
        />
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gap: 16 }}>
            {visibleRecruiterGroups.map(renderGroup)}
            {visibleUnclaimedGroups.length > 0 && (
                <Panel
                  title="Unclaimed submitters"
                  eyebrow="No matching recruiter profile"
                  actions={
                    <Badge tone="info">
                      {visibleUnclaimedGroups.reduce((n, g) => n + g.jobs.reduce((m, job) => m + job.submissions.length, 0), 0)} shown
                    </Badge>
                  }
                >
                  <div style={boardGroupBodyStyle}>
                    {visibleUnclaimedGroups.map((group) => (
                      <div key={group.key}>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
                          <span style={{ fontWeight: 700, fontSize: 13 }}>{group.name}</span>
                          {group.email && group.email !== group.name && (
                            <span style={{ color: "#777", fontSize: 12 }}>{group.email}</span>
                          )}
                          <Badge tone={group.pendingCount ? "info" : "muted"}>
                            {group.pendingCount} pending · {group.totalCount} total
                          </Badge>
                        </div>
                        <div style={{ display: "grid", gap: 10 }}>
                          {group.jobs.map((job) => (
                            <div key={job.key}>
                              <div style={boardJobHeaderStyle}>
                                <span style={{ fontWeight: 600, fontSize: 13 }}>{job.title}</span>
                                {job.company && <span style={{ color: "#777", fontSize: 12 }}>{job.company}</span>}
                                <span style={{ color: "#999", fontSize: 11 }}>
                                  {job.pendingCount} pending · {job.totalCount} total
                                </span>
                              </div>
                              {renderSubmissionTable(group.key, job)}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
          </div>
          {selectedSubmission && (
            <CandidateReviewPanel
              key={selectedSubmission.id}
              submission={selectedSubmission}
              job={selectedJob}
              busy={inFlightId === selectedSubmission.id}
              blocked={inFlightId !== null}
              actionError={actionErrors[selectedSubmission.id]}
              rejectOpen={rejectOpen}
              rejectCategory={rejectCategory}
              rejectTier={rejectTier}
              rejectReason={rejectReason}
              requestInfoOpen={requestInfoOpen}
              requestMessage={requestMessage}
              onClose={() => setSelectedId(null)}
              onOpenReject={setRejectOpen}
              onRejectCategory={setRejectCategory}
              onRejectTier={setRejectTier}
              onRejectReason={setRejectReason}
              onRequestInfoOpen={setRequestInfoOpen}
              onRequestMessage={setRequestMessage}
              onApplyAction={(action, options) => void applyAction(selectedSubmission, action, options)}
              onCommentCount={handleCommentCount}
              checklistGroups={selectedJob?.recruiterBoard?.checklist?.groups ?? []}
              onSaveMarks={(marks) => void saveChecklistMarks(selectedSubmission, marks)}
              marksSaving={marksSavingId === selectedSubmission.id}
            />
          )}
        </div>
      )}
    </div>
  )
}
