import * as React from "react"
import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react"

import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import {
  PASSED_CANDIDATES_CALLABLE_NAME,
  PASSED_CANDIDATES_DEFAULT_LIMIT,
  buildPassedCandidatesRequest,
  formatCount,
  formatSafeJson,
  formatSafeText,
  formatTimestamp,
  type PassedCandidatesFilters,
  type PassedCandidatesRequest,
  type PassedCandidatesRow,
  type PassedCandidatesSnapshot,
} from "./PassedCandidates.helpers.js"

type SnapshotLoader = (filters: PassedCandidatesRequest) => Promise<PassedCandidatesSnapshot>

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

export default function PassedCandidates({
  loadSnapshot = defaultSnapshotLoader,
}: {
  loadSnapshot?: SnapshotLoader
}) {
  const [draft, setDraft] = useState<PassedCandidatesFilters>({ jobId: "", limit: PASSED_CANDIDATES_DEFAULT_LIMIT })
  const [snapshot, setSnapshot] = useState<PassedCandidatesSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
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

      {snapshot ? <PassedCandidatesSnapshotView snapshot={snapshot} /> : null}
    </div>
  )
}

export function PassedCandidatesSnapshotView({ snapshot }: { snapshot: PassedCandidatesSnapshot }) {
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
          <Fact label="job" value={snapshot.filters.jobId} />
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
            {snapshot.rows.map((row) => <PassedCandidateCard key={row.id} row={row} />)}
          </div>
        )}
      </Panel>
    </>
  )
}

function PassedCandidateCard({ row }: { row: PassedCandidatesRow }) {
  return (
    <article style={candidateCardStyle}>
      <div style={cardHeaderStyle}>
        <div>
          <h3 style={cardTitleStyle}>{formatSafeText(row.displayName, 120)}</h3>
          <p style={mutedLineStyle}>{formatSafeText(row.candidateId)} · {formatTimestamp(row.createdAt)}</p>
        </div>
        <Badge tone={row.profile.consentStatus === "granted" ? "ok" : "warn"}>
          {row.profile.consentStatus === "granted" ? "PII consent" : "consent missing"}
        </Badge>
      </div>
      <div style={factGridStyle}>
        <Fact label="state" value={row.state} />
        <Fact label="level 1" value={row.profile.level1Status ?? "-"} />
        <Fact label="lifecycle" value={row.profile.candidateLifecycleState ?? "-"} />
        <Fact label="session" value={row.transcript.prescreenSessionId ?? "-"} />
      </div>
      <SummaryBlock title="Resume Summary" value={row.resumeSummary} />
      <SummaryBlock title="Level 1 Signals" value={formatSafeJson(row.level1Snapshot)} />
      <SummaryBlock title="Pass Reason" value={row.passReason} />
      <SummaryBlock title="Match Reason" value={row.matchReason} />
      <Transcript turns={row.transcript.turns} />
    </article>
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
  return (
    <span style={factStyle}>
      <strong>{label}</strong>
      <span>{formatSafeText(value, 180)}</span>
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
const transcriptStyle: CSSProperties = { display: "grid", gap: 8, padding: 10, background: "#f8fafc", borderRadius: 6 }
const turnStyle: CSSProperties = { display: "grid", gap: 4 }
