import * as React from "react"
import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react"

import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { AdminJobLink, AdminPrescreenSessionLink, AdminUserLink } from "../components/AdminEntityLink.js"
import {
  PASSED_CANDIDATES_CALLABLE_NAME,
  PASSED_CANDIDATE_INTRO_DECISION_CALLABLE_NAME,
  PASSED_CANDIDATES_DEFAULT_LIMIT,
  buildPassedCandidatesRequest,
  formatCount,
  formatIntroDecision,
  formatSafeJson,
  formatSafeText,
  formatTimestamp,
  type PassedCandidateIntroDecision,
  type PassedCandidateIntroDecisionRequest,
  type PassedCandidateIntroDecisionResult,
  type PassedCandidatesFilters,
  type PassedCandidatesRequest,
  type PassedCandidatesRow,
  type PassedCandidatesSnapshot,
} from "./PassedCandidates.helpers.js"

type SnapshotLoader = (filters: PassedCandidatesRequest) => Promise<PassedCandidatesSnapshot>
type IntroDecisionSubmitter = (request: PassedCandidateIntroDecisionRequest) => Promise<PassedCandidateIntroDecisionResult>

async function defaultSnapshotLoader(filters: PassedCandidatesRequest): Promise<PassedCandidatesSnapshot> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable<PassedCandidatesRequest, PassedCandidatesSnapshot>(
    firebase.functions(),
    PASSED_CANDIDATES_CALLABLE_NAME,
  )
  const result = await fn(filters)
  return result.data
}

async function defaultIntroDecisionSubmitter(request: PassedCandidateIntroDecisionRequest): Promise<PassedCandidateIntroDecisionResult> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable<PassedCandidateIntroDecisionRequest, PassedCandidateIntroDecisionResult>(
    firebase.functions(),
    PASSED_CANDIDATE_INTRO_DECISION_CALLABLE_NAME,
  )
  const result = await fn(request)
  return result.data
}

export default function PassedCandidates({
  loadSnapshot = defaultSnapshotLoader,
  submitIntroDecision = defaultIntroDecisionSubmitter,
}: {
  loadSnapshot?: SnapshotLoader
  submitIntroDecision?: IntroDecisionSubmitter
}) {
  const queryJobId = useMemo(() => readJobIdFromHref(), [])
  const [draft, setDraft] = useState<PassedCandidatesFilters>({
    jobId: queryJobId,
    limit: PASSED_CANDIDATES_DEFAULT_LIMIT,
  })
  const [snapshot, setSnapshot] = useState<PassedCandidatesSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [decisionBusyId, setDecisionBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh(nextFilters: PassedCandidatesFilters): Promise<void> {
    const request = buildPassedCandidatesRequest(nextFilters)
    if (!request.jobId) {
      setError("Job ID is required.")
      setSnapshot(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await loadSnapshot(request))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void refresh(draft)
  }

  async function recordIntroDecision(row: PassedCandidatesRow, decision: PassedCandidateIntroDecision, reason: string): Promise<void> {
    setDecisionBusyId(`${row.snapshotId}:${decision}`)
    setError(null)
    try {
      await submitIntroDecision({
        snapshotId: row.snapshotId,
        decision,
        reason,
      })
      await refresh(draft)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDecisionBusyId(null)
    }
  }

  useEffect(() => {
    if (!queryJobId) return
    const next = { jobId: queryJobId, limit: PASSED_CANDIDATES_DEFAULT_LIMIT }
    setDraft(next)
    void refresh(next)
  }, [queryJobId])

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 S7 / Admin"
        title="Passed Candidates"
        description="Job-scoped passed snapshots from the employer-visible profile boundary."
      />

      <Panel title="Job Scope" eyebrow="required">
        <form onSubmit={submit} style={filterGridStyle}>
          <label style={labelStyle}>
            <span>Job ID</span>
            <input
              value={draft.jobId}
              onChange={(event) => setDraft({ ...draft, jobId: event.target.value })}
              placeholder="job id"
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            <span>Limit</span>
            <input
              type="number"
              min={1}
              max={100}
              value={draft.limit ?? PASSED_CANDIDATES_DEFAULT_LIMIT}
              onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) })}
              style={inputStyle}
            />
          </label>
          <button type="submit" disabled={loading} style={buttonStyle(loading)}>
            {loading ? "Loading" : "Load"}
          </button>
        </form>
      </Panel>

      {error ? (
        <Panel title="Snapshot Error" eyebrow="callable failure">
          <ErrorState message={error} />
        </Panel>
      ) : null}

      {loading && !snapshot ? (
        <Panel title="Loading Snapshot">
          <LoadingState label="Loading passed candidates..." />
        </Panel>
      ) : null}

      {snapshot ? (
        <PassedCandidatesSnapshotView
          snapshot={snapshot}
          onIntroDecision={recordIntroDecision}
          decisionBusyId={decisionBusyId}
        />
      ) : null}
    </div>
  )
}

function readJobIdFromHref(): string {
  if (typeof window === "undefined") return ""
  const [, raw = ""] = window.location.href.split("?")
  const qs = raw.split("#")[0] ?? ""
  for (const part of qs.split("&")) {
    const [key, value = ""] = part.split("=")
    if (decodeURIComponent(key ?? "") === "jobId") return decodeURIComponent(value).trim()
  }
  return ""
}

export function PassedCandidatesSnapshotView({
  snapshot,
  onIntroDecision,
  decisionBusyId,
}: {
  snapshot: PassedCandidatesSnapshot
  onIntroDecision?: (row: PassedCandidatesRow, decision: PassedCandidateIntroDecision, reason: string) => Promise<void>
  decisionBusyId?: string | null
}) {
  return (
    <>
      <Panel title="Passed Candidates" eyebrow={`generated ${formatTimestamp(snapshot.generatedAt)}`}>
        <div style={metricGridStyle}>
          <Metric label="Snapshots" value={formatCount(snapshot.summary.totalPassedSnapshots)} />
          <Metric label="Consent Granted" value={formatCount(snapshot.summary.withConsent)} tone="ok" />
          <Metric label="Consent Missing" value={formatCount(snapshot.summary.missingConsent)} tone="warn" />
          <Metric label="Transcript Linked" value={formatCount(snapshot.summary.withTranscript)} tone="info" />
          <Metric label="Invalid Dropped" value={formatCount(snapshot.summary.droppedInvalidSnapshot)} tone="warn" />
          <Metric label="State Mismatch" value={formatCount(snapshot.summary.droppedStateMismatch)} tone="warn" />
        </div>
        <div style={filterSummaryStyle}>
          <Fact label="job" value={<AdminJobLink jobId={snapshot.filters.jobId} />} />
          <Fact label="limit" value={snapshot.filters.limit} />
        </div>
      </Panel>

      <Panel title="Passed Snapshot Rows" eyebrow={`${snapshot.rows.length} row(s)`}>
        {snapshot.rows.length === 0 ? (
          <EmptyState
            title="No passed snapshots"
            body="This job has no employer-visible passed candidate snapshots yet."
          />
        ) : (
          <div style={rowStackStyle}>
            {snapshot.rows.map((row) => (
              <PassedCandidateCard
                key={row.id}
                row={row}
                onIntroDecision={onIntroDecision}
                decisionBusyId={decisionBusyId}
              />
            ))}
          </div>
        )}
      </Panel>
    </>
  )
}

function PassedCandidateCard({
  row,
  onIntroDecision,
  decisionBusyId,
}: {
  row: PassedCandidatesRow
  onIntroDecision?: (row: PassedCandidatesRow, decision: PassedCandidateIntroDecision, reason: string) => Promise<void>
  decisionBusyId?: string | null
}) {
  return (
    <article style={candidateCardStyle}>
      <div style={cardHeaderStyle}>
        <div>
          <h3 style={cardTitleStyle}>{formatSafeText(row.displayName, 120)}</h3>
          <p style={mutedLineStyle}>
            <AdminUserLink userId={row.candidateId}>{formatSafeText(row.candidateId)}</AdminUserLink> · {formatTimestamp(row.createdAt)}
          </p>
        </div>
        <Badge tone={row.profile.consentStatus === "granted" ? "ok" : "warn"}>
          {row.profile.consentStatus === "granted" ? "PII consent" : "consent missing"}
        </Badge>
      </div>
      <div style={factGridStyle}>
        <Fact label="state" value={row.state} />
        <Fact label="level 1" value={row.profile.level1Status ?? "-"} />
        <Fact label="lifecycle" value={row.profile.candidateLifecycleState ?? "-"} />
        <Fact
          label="session"
          value={row.transcript.prescreenSessionId ? <AdminPrescreenSessionLink sessionId={row.transcript.prescreenSessionId} /> : "-"}
        />
      </div>
      <SummaryBlock title="Resume Summary" value={row.resumeSummary} />
      <SummaryBlock title="Level 1 Signals" value={formatSafeJson(row.level1Snapshot)} />
      <SummaryBlock title="Pass Reason" value={row.passReason} />
      <SummaryBlock title="Match Reason" value={row.matchReason} />
      <EmployerIntroDecision row={row} onIntroDecision={onIntroDecision} decisionBusyId={decisionBusyId} />
      <Transcript turns={row.transcript.turns} />
    </article>
  )
}

function EmployerIntroDecision({
  row,
  onIntroDecision,
  decisionBusyId,
}: {
  row: PassedCandidatesRow
  onIntroDecision?: (row: PassedCandidatesRow, decision: PassedCandidateIntroDecision, reason: string) => Promise<void>
  decisionBusyId?: string | null
}) {
  const [reason, setReason] = useState("")
  const action = row.latestEmployerAction
  const hasDecision = Boolean(action)
  const busyAccepted = decisionBusyId === `${row.snapshotId}:accepted`
  const busyRejected = decisionBusyId === `${row.snapshotId}:rejected`
  const canSubmit = Boolean(onIntroDecision) && reason.trim().length > 0 && !hasDecision && !busyAccepted && !busyRejected

  async function submit(decision: PassedCandidateIntroDecision): Promise<void> {
    if (!onIntroDecision || !canSubmit) return
    await onIntroDecision(row, decision, reason)
    setReason("")
  }

  return (
    <div style={decisionStyle}>
      <div style={decisionHeaderStyle}>
        <strong>Employer feedback</strong>
        <Badge tone={action?.status === "accepted" ? "ok" : action?.status === "rejected" ? "warn" : "info"}>
          {formatIntroDecision(action?.status)}
        </Badge>
      </div>
      {action ? (
        <p style={mutedLineStyle}>
          {formatTimestamp(action.decidedAt)} · {formatSafeText(action.reason, 420)}
        </p>
      ) : onIntroDecision ? (
        <div style={decisionFormStyle}>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Employer reason"
            rows={3}
            style={textareaStyle}
          />
          <div style={decisionButtonRowStyle}>
            <button type="button" disabled={!canSubmit} onClick={() => void submit("accepted")} style={buttonStyle(!canSubmit)}>
              {busyAccepted ? "Saving" : "Accept intro"}
            </button>
            <button type="button" disabled={!canSubmit} onClick={() => void submit("rejected")} style={secondaryButtonStyle(!canSubmit)}>
              {busyRejected ? "Saving" : "Reject intro"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Transcript({ turns }: { turns: PassedCandidatesRow["transcript"]["turns"] }) {
  if (turns.length === 0) {
    return <p style={mutedLineStyle}>No transcript turns linked.</p>
  }
  return (
    <div style={transcriptStyle}>
      {turns.map((turn) => (
        <div key={turn.id} style={turnStyle}>
          <strong>{turn.role}</strong>
          {turn.qId ? <span style={mutedLineStyle}>{formatSafeText(turn.qId, 80)}</span> : null}
          <span>{formatSafeText(turn.body, 420)}</span>
          {turn.scoreSummary ? <span style={mutedLineStyle}>score {formatSafeText(turn.scoreSummary, 40)}</span> : null}
        </div>
      ))}
    </div>
  )
}

function SummaryBlock({ title, value }: { title: string; value?: string }) {
  return (
    <div style={summaryBlockStyle}>
      <strong>{title}</strong>
      <p>{formatSafeText(value, 520)}</p>
    </div>
  )
}

function Metric({ label, value, tone = "muted" }: { label: string; value: string; tone?: "ok" | "warn" | "info" | "muted" }) {
  return (
    <div style={metricStyle}>
      <span style={metricLabelStyle}>{label}</span>
      <strong>{value}</strong>
      <Badge tone={tone}>{tone}</Badge>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  const renderedValue = typeof value === "string" || typeof value === "number" ? formatSafeText(value, 180) : value
  return (
    <span style={factStyle}>
      <strong>{label}</strong>
      <span>{renderedValue}</span>
    </span>
  )
}

const filterGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(240px, 1fr) minmax(120px, 160px) auto",
  gap: 12,
  alignItems: "end",
}

const labelStyle: CSSProperties = { display: "grid", gap: 6, fontSize: 13, color: "#475569" }
const inputStyle: CSSProperties = { padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14 }
const buttonStyle = (disabled: boolean): CSSProperties => ({
  padding: "10px 14px",
  border: 0,
  borderRadius: 6,
  background: disabled ? "#94a3b8" : "#0f172a",
  color: "white",
  fontWeight: 700,
})
const metricGridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }
const metricStyle: CSSProperties = { display: "grid", gap: 6, padding: 12, border: "1px solid #e2e8f0", borderRadius: 6 }
const metricLabelStyle: CSSProperties = { color: "#64748b", fontSize: 12, textTransform: "uppercase" }
const filterSummaryStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }
const factStyle: CSSProperties = { display: "inline-flex", gap: 6, alignItems: "center", padding: "4px 8px", background: "#f8fafc", borderRadius: 6 }
const rowStackStyle: CSSProperties = { display: "grid", gap: 12 }
const candidateCardStyle: CSSProperties = { display: "grid", gap: 12, border: "1px solid #e2e8f0", borderRadius: 8, padding: 14 }
const cardHeaderStyle: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }
const cardTitleStyle: CSSProperties = { margin: 0, fontSize: 18 }
const mutedLineStyle: CSSProperties = { margin: 0, color: "#64748b", fontSize: 13 }
const factGridStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 }
const summaryBlockStyle: CSSProperties = { display: "grid", gap: 4 }
const decisionStyle: CSSProperties = { display: "grid", gap: 8, padding: 10, border: "1px solid #e2e8f0", borderRadius: 6 }
const decisionHeaderStyle: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }
const decisionFormStyle: CSSProperties = { display: "grid", gap: 8 }
const textareaStyle: CSSProperties = {
  width: "100%",
  minHeight: 76,
  padding: "10px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  resize: "vertical",
  font: "inherit",
}
const decisionButtonRowStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 }
const secondaryButtonStyle = (disabled: boolean): CSSProperties => ({
  ...buttonStyle(disabled),
  background: disabled ? "#94a3b8" : "#7f1d1d",
})
const transcriptStyle: CSSProperties = { display: "grid", gap: 8, padding: 10, background: "#f8fafc", borderRadius: 6 }
const turnStyle: CSSProperties = { display: "grid", gap: 4 }
