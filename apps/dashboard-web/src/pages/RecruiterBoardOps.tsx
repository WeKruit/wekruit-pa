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
import { Fragment, useEffect, useMemo, useState } from "react"
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import {
  RECRUITER_SUBMISSION_ACTION_TO_STATUS,
  runRecruiterSubmissionAction,
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
  createdAt?: { seconds?: number } | string | null
  createdAtMs?: number
}

interface BoardRecruiterDoc {
  id: string
  name?: string
  email?: string
  status?: string
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

const cellStyle = { padding: "9px 6px", verticalAlign: "top" as const }
const actionButtonStyle = {
  padding: "5px 8px",
  border: "1px solid #ccc",
  borderRadius: 6,
  background: "#fff",
  fontSize: 12,
  cursor: "pointer",
}
// P3 carry-over: while another row's action is in flight, this row's buttons
// must read as disabled (aria-disabled + dimmed), not silently no-op.
const blockedButtonStyle = {
  opacity: 0.5,
  cursor: "default" as const,
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

export default function RecruiterBoardOps() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [submissions, setSubmissions] = useState<BoardSubmissionDoc[]>([])
  const [recruiters, setRecruiters] = useState<BoardRecruiterDoc[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [overflowId, setOverflowId] = useState<string | null>(null)
  const [requestInfoId, setRequestInfoId] = useState<string | null>(null)
  const [requestMessage, setRequestMessage] = useState(DEFAULT_REQUEST_MESSAGE)
  const [inFlightId, setInFlightId] = useState<string | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [reloadKey, setReloadKey] = useState(0)

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
        setSubmissions(submissionSnap.docs.map((d) => {
          const data = d.data() as Omit<BoardSubmissionDoc, "id">
          return { id: d.id, ...data, createdAtMs: timestampToMs(data.createdAt) }
        }))
        setRecruiters(recruiterSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<BoardRecruiterDoc, "id">) })))
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

  async function applyAction(submission: BoardSubmissionDoc, action: RecruiterSubmissionAction, message?: string) {
    if (inFlightId) return
    const priorStatus = submission.status
    const optimisticStatus = RECRUITER_SUBMISSION_ACTION_TO_STATUS[action]
    setInFlightId(submission.id)
    setOverflowId(null)
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
        ...(action === "request_info" && message ? { requestMessage: message } : {}),
      })
      setSubmissions((prev) => prev.map((s) => (s.id === submission.id ? { ...s, status: result.status } : s)))
      if (action === "request_info") {
        setRequestInfoId(null)
        setRequestMessage(DEFAULT_REQUEST_MESSAGE)
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
    const expanded = expandedId === submission.id
    const actionError = actionErrors[submission.id]
    const stage = submissionStage(submission.status)
    const status = statusDisplay(submission.status)
    const othersBlocked = inFlightId !== null && !busy
    const blocked = busy || othersBlocked
    const dim = othersBlocked ? blockedButtonStyle : null
    return (
      <Fragment key={submission.id}>
        <tr
          onClick={() => setExpandedId(expanded ? null : submission.id)}
          style={{ borderBottom: "1px solid #f1f1f1", cursor: "pointer", background: expanded ? "#faf7f2" : undefined }}
        >
          <td style={cellStyle}>
            <div style={{ fontWeight: 600 }}>
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
            <Badge tone={chip.tone}>{chip.label}</Badge>
          </td>
          <td style={cellStyle}>
            <Badge tone={status.tone}>{status.label}</Badge>
          </td>
          <td style={cellStyle} onClick={(e) => e.stopPropagation()}>
            {stage === "terminal" ? (
              <span style={{ color: "#999", fontSize: 12 }}>—</span>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <button
                  type="button"
                  disabled={blocked}
                  aria-disabled={blocked}
                  onClick={() => void applyAction(submission, STAGE_PRIMARY_ACTION[stage].action)}
                  style={{ ...actionButtonStyle, border: "1px solid #9bc09b", background: "#f1f8f1", color: "#1d5c2c", ...dim }}
                >
                  {busy ? "…" : STAGE_PRIMARY_ACTION[stage].label}
                </button>
                <button
                  type="button"
                  disabled={blocked}
                  aria-disabled={blocked}
                  onClick={() => void applyAction(submission, "reject")}
                  style={{ ...actionButtonStyle, border: "1px solid #d9a8a0", background: "#fdf3f1", color: "#9c3a1d", ...dim }}
                >
                  {busy ? "…" : "Reject"}
                </button>
                {stage === "pending" && (
                  <button
                    type="button"
                    disabled={blocked}
                    aria-disabled={blocked}
                    onClick={() => {
                      setRequestInfoId(requestInfoId === submission.id ? null : submission.id)
                      setRequestMessage(DEFAULT_REQUEST_MESSAGE)
                    }}
                    style={{ ...actionButtonStyle, ...dim }}
                  >
                    Request info
                  </button>
                )}
                <button
                  type="button"
                  disabled={blocked}
                  aria-disabled={blocked}
                  aria-label="More actions"
                  onClick={() => setOverflowId(overflowId === submission.id ? null : submission.id)}
                  style={{ ...actionButtonStyle, ...dim }}
                >
                  ⋯
                </button>
                {overflowId === submission.id && (
                  <>
                    <button
                      type="button"
                      disabled={blocked}
                      aria-disabled={blocked}
                      onClick={() => void applyAction(submission, "reviewing")}
                      style={{ ...actionButtonStyle, ...dim }}
                    >
                      Mark reviewing
                    </button>
                    <button
                      type="button"
                      disabled={blocked}
                      aria-disabled={blocked}
                      onClick={() => void applyAction(submission, "duplicate")}
                      style={{ ...actionButtonStyle, ...dim }}
                    >
                      Duplicate
                    </button>
                  </>
                )}
              </div>
            )}
            {requestInfoId === submission.id && stage === "pending" && (
              <div style={{ marginTop: 8, display: "grid", gap: 6, maxWidth: 360 }}>
                <textarea
                  value={requestMessage}
                  onChange={(e) => setRequestMessage(e.target.value)}
                  rows={3}
                  style={{ width: "100%", padding: "6px 8px", border: "1px solid #ddd", borderRadius: 6, fontSize: 12 }}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    disabled={blocked || !requestMessage.trim()}
                    aria-disabled={blocked || !requestMessage.trim()}
                    onClick={() => void applyAction(submission, "request_info", requestMessage.trim())}
                    style={{ ...actionButtonStyle, ...dim }}
                  >
                    {busy ? "Sending…" : "Send request"}
                  </button>
                  <button
                    type="button"
                    disabled={blocked}
                    aria-disabled={blocked}
                    onClick={() => setRequestInfoId(null)}
                    style={{ ...actionButtonStyle, ...dim }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {actionError && (
              <div style={{ marginTop: 6, color: "#9c3a1d", fontSize: 11 }}>Action failed: {actionError}</div>
            )}
          </td>
        </tr>
        {expanded && (
          <tr style={{ borderBottom: "1px solid #f1f1f1", background: "#faf7f2" }}>
            <td colSpan={6} style={{ padding: "12px 10px" }}>
              <div style={{ display: "grid", gap: 12 }}>
                <ExtraFieldsDetail extraFields={submission.extraFields} />
                <AiDetail submission={submission} />
              </div>
            </td>
          </tr>
        )}
      </Fragment>
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
        <div style={{ display: "grid", gap: 14 }}>
          {group.jobs.map((job) => (
            <div key={job.key}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{job.title}</span>
                {job.company && <span style={{ color: "#777", fontSize: 12 }}>{job.company}</span>}
                <span style={{ color: "#999", fontSize: 11 }}>
                  {job.pendingCount} pending · {job.submissions.length} total
                </span>
              </div>
              <div className="table-shell">
                <table>
                  <thead>
                    <tr>
                      <th>Candidate</th>
                      <th>Submitted</th>
                      <th>Self-score</th>
                      <th>AI verdict</th>
                      <th>Status</th>
                      <th>Actions</th>
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
              <div style={{ display: "grid", gap: 16 }}>
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
                    <div style={{ display: "grid", gap: 14 }}>
                      {group.jobs.map((job) => (
                        <div key={job.key}>
                          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 4 }}>
                            <span style={{ fontWeight: 600, fontSize: 13 }}>{job.title}</span>
                            {job.company && <span style={{ color: "#777", fontSize: 12 }}>{job.company}</span>}
                          </div>
                          <div className="table-shell">
                            <table>
                              <thead>
                                <tr>
                                  <th>Candidate</th>
                                  <th>Submitted</th>
                                  <th>Self-score</th>
                                  <th>AI verdict</th>
                                  <th>Status</th>
                                  <th>Actions</th>
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
      )}
    </div>
  )
}
