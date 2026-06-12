/**
 * Recruiter operations board — the founder's "one screen" view:
 * all recruiters → jobs each works on → submissions per job → AI verdict →
 * stage-aware one-click action (move to interview / send to client / hired /
 * reject / request info, overflow for reviewing / duplicate) via
 * paAdminRecruiterSubmissionAction.
 *
 * Client-side join of two small collections: pa-recruiter-users
 * (name/email/status) + pa-recruiter-submissions (latest 500). Submitter
 * emails with no matching recruiter profile land in an "Unclaimed
 * submitters" group.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { collection, doc, getDoc, getDocs, limit, orderBy, query } from "firebase/firestore"
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import {
  RECRUITER_SUBMISSION_ACTION_TO_STATUS,
  runRecruiterSubmissionAction,
  sendRecruiterSubmissionComment,
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
const DEFAULT_REQUEST_MESSAGE = "Please add the candidate's resume link and LinkedIn profile."

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

function isPending(submission: BoardSubmissionDoc): boolean {
  return PENDING_STATUSES.includes(submission.status ?? "submitted")
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

const boardTableStyle: CSSProperties = {
  minWidth: 760,
  border: 0,
  fontSize: 11.5,
  lineHeight: 1.25,
}

const selectedBoardTableStyle: CSSProperties = {
  ...boardTableStyle,
  minWidth: 620,
  fontSize: 11,
}

const boardHeaderCellStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  padding: "6px 6px",
  background: "#fff",
  boxShadow: "0 1px 0 #eee",
  color: "#777",
}

const selectedReviewShellStyle: CSSProperties = {
  width: "calc(100vw - 240px - 64px)",
  maxWidth: "calc(100vw - 240px - 64px)",
  display: "grid",
  gridTemplateColumns: "minmax(620px, 1fr) minmax(520px, min(640px, 34vw))",
  gap: 16,
  alignItems: "start",
}

const reviewLeftColumnStyle: CSSProperties = {
  minWidth: 0,
  display: "grid",
  gap: 14,
}

const reviewSidePanelStyle: CSSProperties = {
  position: "sticky",
  top: 16,
  minWidth: 0,
  maxHeight: "calc(100vh - 112px)",
  overflow: "auto",
  border: "1px solid #e5ded2",
  borderRadius: 12,
  background: "#fffdf9",
  padding: 14,
  boxShadow: "0 14px 36px rgba(54, 38, 24, 0.12)",
  scrollbarWidth: "thin",
}

const reviewContextStyle: CSSProperties = {
  maxHeight: 420,
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
  fontSize: 13,
  lineHeight: 1.45,
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

function jobLookupKey(submission: BoardSubmissionDoc): string | null {
  return submission.jobId?.trim() || submission.inboundJobId?.trim() || null
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
}: {
  submission: BoardSubmissionDoc
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
  onApplyAction: (action: RecruiterSubmissionAction, options?: { requestMessage?: string; rejection?: RecruiterSubmissionRejectionInput }) => void
  onCommentCount: (submissionId: string, count: number) => void
}) {
  const stage = submissionStage(submission.status)
  const status = statusDisplay(submission.status)
  const chip = verdictChip(submission.aiEvaluation)
  const href = candidateHref(submission)
  const resumeHref = submission.candidate?.resumeUrl?.trim() ? submission.candidate.resumeUrl.trim() : null
  const email = submission.candidate?.email?.trim()
  const dim = blocked ? blockedButtonStyle : null
  const rejectDisabled = blocked || !rejectReason.trim()
  return (
    <aside style={reviewSidePanelStyle} aria-label="Candidate review panel">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
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
        <button type="button" onClick={onClose} style={{ ...actionButtonStyle, fontSize: 14, lineHeight: 1 }}>
          x
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        <Badge tone={status.tone}>{status.label}</Badge>
        <Badge tone={chip.tone}>{chip.label}</Badge>
        <span style={{ color: "#8b7d6d", fontSize: 12 }}>{formatSubmittedDate(submission.createdAtMs ?? 0)}</span>
      </div>

      <div style={reviewSectionStyle}>
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

      <div style={reviewSectionStyle}>
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
                  <option value="role_fit">Role fit</option>
                  <option value="quality">Quality</option>
                </select>
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 11, color: "#6f6256", fontWeight: 700 }}>
                Tier
                <select
                  value={rejectTier}
                  onChange={(e) => onRejectTier(e.target.value as RecruiterCandidateTier)}
                  style={{ padding: "6px 8px", border: "1px solid #d9c9bb", borderRadius: 6, fontSize: 12 }}
                >
                  <option value="tier_1">Tier 1 reusable</option>
                  <option value="tier_2">Tier 2 possible</option>
                  <option value="tier_3">Tier 3 hard reject</option>
                </select>
              </label>
            </div>
            <textarea
              value={rejectReason}
              onChange={(e) => onRejectReason(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Why this candidate is rejected"
              aria-label="Rejection reason"
              style={{ width: "100%", padding: "7px 8px", border: "1px solid #d9c9bb", borderRadius: 6, fontSize: 12 }}
            />
            <button
              type="button"
              disabled={rejectDisabled}
              aria-disabled={rejectDisabled}
              onClick={() => onApplyAction("reject", {
                rejection: { category: rejectCategory, candidateTier: rejectTier, reason: rejectReason.trim() },
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

      <div style={reviewSectionStyle}>
        <ExtraFieldsDetail extraFields={submission.extraFields} />
        <AiDetail submission={submission} />
      </div>
      <div style={reviewSectionStyle}>
        <ConversationSection submission={submission} onCommentCount={onCommentCount} />
      </div>
    </aside>
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
  const [rejectCategory, setRejectCategory] = useState<RecruiterCandidateRejectionCategory>("role_fit")
  const [rejectTier, setRejectTier] = useState<RecruiterCandidateTier>("tier_1")
  const [rejectReason, setRejectReason] = useState("")
  const [inFlightId, setInFlightId] = useState<string | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [reloadKey, setReloadKey] = useState(0)
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})

  function handleCommentCount(submissionId: string, count: number) {
    setCommentCounts((prev) => (prev[submissionId] === count ? prev : { ...prev, [submissionId]: count }))
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        setErr(null)
        const [submissionSnap, recruiterSnap] = await Promise.all([
          getDocs(query(collection(db(), "pa-recruiter-submissions"), orderBy("createdAt", "desc"), limit(500))),
          getDocs(collection(db(), "pa-recruiter-users")),
        ])
        if (cancelled) return
        const loadedSubmissions = submissionSnap.docs.map((d) => {
          const data = d.data() as Omit<BoardSubmissionDoc, "id">
          return { id: d.id, ...data, createdAtMs: timestampToMs(data.createdAt) }
        })
        const jobIds = [...new Set(loadedSubmissions.flatMap((s) => (s.jobId?.trim() ? [s.jobId.trim()] : [])))]
        const loadedJobs = await Promise.all(
          jobIds.map(async (jobId) => {
            const snap = await getDoc(doc(db(), "pa-jobs", jobId))
            return snap.exists() ? [jobId, { id: snap.id, ...(snap.data() as Omit<BoardJobDoc, "id">) }] as const : null
          }),
        )
        if (cancelled) return
        setSubmissions(loadedSubmissions)
        setRecruiters(recruiterSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<BoardRecruiterDoc, "id">) })))
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
  const pendingTotal = submissions.filter(isPending).length
  const selectedSubmission = useMemo(
    () => submissions.find((submission) => submission.id === selectedId) ?? null,
    [selectedId, submissions],
  )
  const selectedJob = selectedSubmission ? jobDocs[jobLookupKey(selectedSubmission) ?? ""] : undefined

  useEffect(() => {
    if (selectedId && !submissions.some((submission) => submission.id === selectedId)) {
      setSelectedId(null)
    }
  }, [selectedId, submissions])

  useEffect(() => {
    setRejectOpen(false)
    setRejectCategory("role_fit")
    setRejectTier("tier_1")
    setRejectReason("")
    setRequestInfoOpen(false)
    setRequestMessage(DEFAULT_REQUEST_MESSAGE)
  }, [selectedId])

  async function applyAction(
    submission: BoardSubmissionDoc,
    action: RecruiterSubmissionAction,
    options?: { requestMessage?: string; rejection?: RecruiterSubmissionRejectionInput },
  ) {
    if (inFlightId) return
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
      })
      setSubmissions((prev) =>
        prev.map((s) =>
          s.id === submission.id
            ? {
                ...s,
                status: result.status,
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
    const actionError = actionErrors[submission.id]
    const status = statusDisplay(submission.status)
    const othersBlocked = inFlightId !== null && !busy
    const blocked = busy || othersBlocked
    const dim = othersBlocked ? blockedButtonStyle : null
    return (
      <tr
        key={submission.id}
        onClick={() => setSelectedId(selected ? null : submission.id)}
        style={{ borderBottom: "1px solid #f1f1f1", cursor: "pointer", background: selected ? "#faf4ea" : undefined }}
      >
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
                  {job.pendingCount} pending · {job.submissions.length} total
                </span>
              </div>
              <div style={boardTableShellStyle}>
                <table style={selectedSubmission ? selectedBoardTableStyle : boardTableStyle}>
                  <thead>
                    <tr>
                      <th style={{ ...boardHeaderCellStyle, width: "32%" }}>Candidate</th>
                      <th style={{ ...boardHeaderCellStyle, width: "14%" }}>Submitted</th>
                      <th style={{ ...boardHeaderCellStyle, width: "16%" }}>Self-score</th>
                      <th style={{ ...boardHeaderCellStyle, width: "28%" }}>Review</th>
                      <th style={{ ...boardHeaderCellStyle, width: "10%" }}>Open</th>
                    </tr>
                  </thead>
                  <tbody>{job.submissions.map(renderSubmissionRow)}</tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )

  return (
    <div>
      {header}
      <div style={{ color: "#777", fontSize: 12, margin: "0 0 12px" }}>
        {recruiterGroups.length} recruiters · {submissions.length} submissions loaded · {pendingTotal} pending
      </div>
      {recruiterGroups.length === 0 && unclaimedGroups.length === 0 ? (
        <EmptyState
          title="No recruiter activity yet"
          body="Recruiter profiles and submissions will appear here as soon as the first one lands."
        />
      ) : (
        <div style={selectedSubmission ? selectedReviewShellStyle : { display: "grid", gap: 16 }}>
          <div style={selectedSubmission ? reviewLeftColumnStyle : { display: "grid", gap: 16 }}>
            {selectedSubmission && <JobContextPanel job={selectedJob} submission={selectedSubmission} />}
            <div style={{ display: "grid", gap: 16 }}>
              {recruiterGroups.map(renderGroup)}
              {unclaimedGroups.length > 0 && (
                <Panel
                  title="Unclaimed submitters"
                  eyebrow="No matching recruiter profile"
                  actions={
                    <Badge tone="info">
                      {unclaimedGroups.reduce((n, g) => n + g.totalCount, 0)} submissions
                    </Badge>
                  }
                >
                  <div style={boardGroupBodyStyle}>
                    {unclaimedGroups.map((group) => (
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
                              </div>
                              <div style={boardTableShellStyle}>
                                <table style={selectedSubmission ? selectedBoardTableStyle : boardTableStyle}>
                                  <thead>
                                    <tr>
                                      <th style={{ ...boardHeaderCellStyle, width: "32%" }}>Candidate</th>
                                      <th style={{ ...boardHeaderCellStyle, width: "14%" }}>Submitted</th>
                                      <th style={{ ...boardHeaderCellStyle, width: "16%" }}>Self-score</th>
                                      <th style={{ ...boardHeaderCellStyle, width: "28%" }}>Review</th>
                                      <th style={{ ...boardHeaderCellStyle, width: "10%" }}>Open</th>
                                    </tr>
                                  </thead>
                                  <tbody>{job.submissions.map(renderSubmissionRow)}</tbody>
                                </table>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
            </div>
          </div>
          {selectedSubmission && (
            <CandidateReviewPanel
              submission={selectedSubmission}
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
            />
          )}
        </div>
      )}
    </div>
  )
}
