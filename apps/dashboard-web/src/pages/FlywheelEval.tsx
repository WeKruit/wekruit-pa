import * as React from "react"
import { useEffect, useState, type CSSProperties, type ReactNode } from "react"

import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { AdminJobLink, AdminUserLink } from "../components/AdminEntityLink.js"
import {
  FLYWHEEL_EVAL_DEFAULT_LIMIT,
  FLYWHEEL_EVAL_ROUTE,
  buildFlywheelEvalSnapshotRequest,
  getFlywheelEvalSnapshot,
  type CountMap,
  type FlywheelEvalArtifactRow,
  type FlywheelEvalCorrectionRow,
  type FlywheelEvalFeedbackRow,
  type FlywheelEvalSnapshot,
  type FlywheelEvalSnapshotRequest,
} from "../lib/flywheel-eval-api.js"

type SnapshotLoader = (request: FlywheelEvalSnapshotRequest) => Promise<FlywheelEvalSnapshot>

export default function FlywheelEval({
  loadSnapshot = getFlywheelEvalSnapshot,
}: {
  loadSnapshot?: SnapshotLoader
}) {
  const [limit, setLimit] = useState(FLYWHEEL_EVAL_DEFAULT_LIMIT)
  const [snapshot, setSnapshot] = useState<FlywheelEvalSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function refresh(nextLimit = limit): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await loadSnapshot(buildFlywheelEvalSnapshotRequest(nextLimit)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh(FLYWHEEL_EVAL_DEFAULT_LIMIT)
    // Initial snapshot only; explicit refresh below reloads with current limit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSnapshot])

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 S8 / Admin"
        title="Flywheel Eval"
        description="Redacted correction, feedback, and eval artifact coverage for the marketplace flywheel."
        actions={
          <button type="button" onClick={() => void refresh()} disabled={loading} style={buttonStyle(loading)}>
            {loading ? "Loading" : "Refresh"}
          </button>
        }
      />

      <Panel title="Snapshot Scope" eyebrow={FLYWHEEL_EVAL_ROUTE}>
        <div style={scopeStyle}>
          <label style={labelStyle}>
            <span>Recent row limit</span>
            <input
              type="number"
              min={1}
              max={100}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              style={inputStyle}
            />
          </label>
          <Fact label="route" value={FLYWHEEL_EVAL_ROUTE} />
          <Fact label="payload policy" value="redacted summaries only" />
        </div>
      </Panel>

      {error ? (
        <Panel title="Snapshot Error" eyebrow="callable failure">
          <ErrorState message={error} />
        </Panel>
      ) : null}

      {loading && !snapshot ? (
        <Panel title="Loading Snapshot">
          <LoadingState label="Loading flywheel eval snapshot..." />
        </Panel>
      ) : null}

      {snapshot ? <FlywheelEvalSnapshotView snapshot={snapshot} /> : null}
    </div>
  )
}

export function FlywheelEvalSnapshotView({ snapshot }: { snapshot: FlywheelEvalSnapshot }) {
  return (
    <>
      <Panel title="Flywheel Overview" eyebrow={`generated ${formatTimestamp(snapshot.generatedAt)}`}>
        <div style={overviewGridStyle}>
          <CountPanel title="Artifacts by Kind" counts={snapshot.counts.artifactsByKind} />
          <CountPanel title="Artifacts by Status" counts={snapshot.counts.artifactsByStatus} />
          <CountPanel title="Feedback by Kind" counts={snapshot.counts.feedbackByKind} />
          <CountPanel title="Feedback by Outcome" counts={snapshot.counts.feedbackByOutcome} />
          <CountPanel title="Employer Intro Outcomes" counts={snapshot.counts.employerIntroByOutcome} />
          <CountPanel title="Corrections by Target" counts={snapshot.counts.correctionsByTarget} />
          <CountPanel title="Corrections by Actor" counts={snapshot.counts.correctionsByActor} />
        </div>
      </Panel>

      <Panel title="Recent Eval Artifacts" eyebrow={`${snapshot.recentArtifacts.length} row(s)`}>
        {snapshot.recentArtifacts.length === 0 ? (
          <EmptyState
            title="No eval artifacts"
            body="The snapshot returned no generated eval or regression artifacts yet."
          />
        ) : (
          <div style={rowStackStyle}>
            {snapshot.recentArtifacts.map((row) => <ArtifactCard key={row.id} row={row} />)}
          </div>
        )}
      </Panel>

      <Panel title="Recent Corrections" eyebrow={`${snapshot.recentCorrections.length} row(s)`}>
        {snapshot.recentCorrections.length === 0 ? (
          <EmptyState
            title="No correction events"
            body="No operator, system, or candidate corrections are present in this snapshot."
          />
        ) : (
          <div style={rowStackStyle}>
            {snapshot.recentCorrections.map((row) => <CorrectionCard key={row.id} row={row} />)}
          </div>
        )}
      </Panel>

      <Panel title="Recent Feedback" eyebrow={`${snapshot.recentFeedback.length} row(s)`}>
        {snapshot.recentFeedback.length === 0 ? (
          <EmptyState
            title="No feedback events"
            body="No marketplace outcome or behavior feedback events are present in this snapshot."
          />
        ) : (
          <div style={rowStackStyle}>
            {snapshot.recentFeedback.map((row) => <FeedbackCard key={row.id} row={row} />)}
          </div>
        )}
      </Panel>
    </>
  )
}

function CountPanel({ title, counts }: { title: string; counts: CountMap }) {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
  return (
    <section style={countPanelStyle}>
      <h3 style={countTitleStyle}>{title}</h3>
      {entries.length === 0 ? (
        <p style={mutedStyle}>No rows</p>
      ) : (
        <div style={countListStyle}>
          {entries.map(([key, count]) => (
            <div key={key} style={countRowStyle}>
              <span>{formatSafeText(key, 80)}</span>
              <strong>{formatCount(count)}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ArtifactCard({ row }: { row: FlywheelEvalArtifactRow }) {
  return (
    <article style={cardStyle}>
      <div style={cardHeaderStyle}>
        <div>
          <h3 style={cardTitleStyle}>{formatSafeText(row.kind, 120)}</h3>
          <p style={mutedStyle}>{formatSafeText(row.artifactId ?? row.id, 160)} · {formatTimestamp(row.createdAt)}</p>
        </div>
        <Badge tone={statusTone(row.status)}>{formatSafeText(row.status, 40)}</Badge>
      </div>
      <div style={factGridStyle}>
        <Fact label="candidate" value={row.candidateId ? <AdminUserLink userId={row.candidateId} /> : "-"} />
        <Fact label="job" value={row.jobId ? <AdminJobLink jobId={row.jobId} /> : "-"} />
        <Fact label="corrections" value={row.sourceCorrectionEventIds.length} />
        <Fact label="feedback" value={row.sourceFeedbackEventIds.length} />
        <Fact label="latest run" value={row.latestRunResult?.status ?? "not_run"} />
      </div>
      <RedactedBlock title="Payload Summary" value={row.payloadRedacted} />
      <EvidenceList rows={row.evidence} />
      {row.latestRunResult?.summary ? <SummaryBlock title="Run Summary" value={row.latestRunResult.summary} /> : null}
    </article>
  )
}

function CorrectionCard({ row }: { row: FlywheelEvalCorrectionRow }) {
  return (
    <article style={cardStyle}>
      <div style={cardHeaderStyle}>
        <div>
          <h3 style={cardTitleStyle}>{formatSafeText(row.targetType, 120)}</h3>
          <p style={mutedStyle}>{formatSafeText(row.eventId ?? row.id, 160)} · {formatTimestamp(row.createdAt)}</p>
        </div>
        <Badge tone={row.actor === "candidate" ? "info" : row.actor === "operator" ? "ok" : "muted"}>
          {formatSafeText(row.actor, 40)}
        </Badge>
      </div>
      <div style={factGridStyle}>
        <Fact label="target" value={row.targetId ?? "-"} />
        <Fact label="candidate" value={row.candidateId ? <AdminUserLink userId={row.candidateId} /> : "-"} />
        <Fact label="job" value={row.jobId ? <AdminJobLink jobId={row.jobId} /> : "-"} />
      </div>
      <SummaryBlock title="Reason" value={row.reason ?? ""} />
      <RedactedBlock title="Before" value={row.beforeRedacted} />
      <RedactedBlock title="After" value={row.afterRedacted} />
      <EvidenceList rows={row.evidence} />
    </article>
  )
}

function FeedbackCard({ row }: { row: FlywheelEvalFeedbackRow }) {
  return (
    <article style={cardStyle}>
      <div style={cardHeaderStyle}>
        <div>
          <h3 style={cardTitleStyle}>{formatSafeText(row.kind, 120)}</h3>
          <p style={mutedStyle}>{formatSafeText(row.eventId ?? row.id, 160)} · {formatTimestamp(row.createdAt)}</p>
        </div>
        <Badge tone="info">{formatSafeText(row.actor, 40)}</Badge>
      </div>
      <div style={factGridStyle}>
        <Fact label="outcome" value={row.outcome ?? "-"} />
        <Fact label="candidate" value={row.candidateId ? <AdminUserLink userId={row.candidateId} /> : "-"} />
        <Fact label="job" value={row.jobId ? <AdminJobLink jobId={row.jobId} /> : "-"} />
        <Fact label="state" value={row.candidateJobStateId ?? "-"} />
      </div>
      <RedactedBlock title="Payload Summary" value={row.payloadRedacted} />
      <EvidenceList rows={row.evidence} />
    </article>
  )
}

function RedactedBlock({ title, value }: { title: string; value: Record<string, unknown> }) {
  const summary = summarizeRedactedPayload(value)
  return <SummaryBlock title={title} value={summary || "No redacted payload fields."} />
}

function EvidenceList({ rows }: { rows: { source?: string; summary: string; confidence?: number; refId?: string }[] }) {
  if (rows.length === 0) return <p style={mutedStyle}>No evidence summaries.</p>
  return (
    <div style={evidenceStyle}>
      <strong>Evidence</strong>
      {rows.map((row, index) => (
        <p key={`${row.source ?? "evidence"}-${index}`} style={evidenceRowStyle}>
          <span>{formatSafeText(row.source ?? "source", 40)}</span>
          <span>{formatSafeText(row.summary, 260)}</span>
          {typeof row.confidence === "number" ? <span style={mutedStyle}>confidence {row.confidence.toFixed(2)}</span> : null}
        </p>
      ))}
    </div>
  )
}

function SummaryBlock({ title, value }: { title: string; value: string }) {
  return (
    <div style={summaryBlockStyle}>
      <strong>{title}</strong>
      <p>{formatSafeText(value, 520)}</p>
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

export function summarizeRedactedPayload(value: Record<string, unknown>): string {
  return Object.entries(value)
    .slice(0, 8)
    .map(([key, raw]) => `${formatSafeText(key, 60)}=${formatRedactedValue(key, raw)}`)
    .join("; ")
}

export function formatRedactedValue(key: string, value: unknown): string {
  if (isUnsafeKey(key)) return "[redacted field]"
  if (typeof value === "string") return redactSensitiveText(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value == null) return "-"
  return redactSensitiveText(JSON.stringify(value, redactedJsonReplacer)).slice(0, 320)
}

export function redactSensitiveText(value: unknown): string {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted phone]")
    .replace(/https?:\/\/\S+/gi, "[redacted url]")
    .replace(/\b\S+\.(?:pdf|docx?|txt)\b/gi, "[redacted file]")
    .replace(/\b(?:raw\s*)?(?:transcript|prompt|contact|resume|linkedin)\b/gi, "[redacted field]")
}

function redactedJsonReplacer(key: string, value: unknown) {
  if (isUnsafeKey(key)) return "[redacted field]"
  return value
}

function isUnsafeKey(key: string): boolean {
  return /email|phone|contact|linkedin|resume|storage|gcs|raw|transcript|prompt/i.test(key)
}

function formatSafeText(value: ReactNode, max = 180): string {
  return redactSensitiveText(value).replace(/\s+/g, " ").trim().slice(0, max) || "-"
}

function formatTimestamp(value?: string): string {
  if (!value) return "unknown"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return formatSafeText(value, 80)
  return date.toISOString().slice(0, 16).replace("T", " ")
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value)
}

function statusTone(status: string): "ok" | "warn" | "info" | "muted" {
  if (status === "passed" || status === "ready") return "ok"
  if (status === "failed" || status === "needs_review") return "warn"
  if (status === "running" || status === "draft") return "info"
  return "muted"
}

const scopeStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end" }
const labelStyle: CSSProperties = { display: "grid", gap: 6, fontSize: 13, color: "#475569" }
const inputStyle: CSSProperties = { padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, width: 140 }
const buttonStyle = (disabled: boolean): CSSProperties => ({
  padding: "10px 14px",
  border: 0,
  borderRadius: 6,
  background: disabled ? "#94a3b8" : "#0f172a",
  color: "white",
  fontWeight: 700,
})
const overviewGridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }
const countPanelStyle: CSSProperties = { border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, display: "grid", gap: 8 }
const countTitleStyle: CSSProperties = { margin: 0, fontSize: 14 }
const countListStyle: CSSProperties = { display: "grid", gap: 6 }
const countRowStyle: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }
const rowStackStyle: CSSProperties = { display: "grid", gap: 12 }
const cardStyle: CSSProperties = { display: "grid", gap: 12, border: "1px solid #e2e8f0", borderRadius: 8, padding: 14 }
const cardHeaderStyle: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }
const cardTitleStyle: CSSProperties = { margin: 0, fontSize: 18 }
const factGridStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 }
const factStyle: CSSProperties = { display: "inline-flex", gap: 6, alignItems: "center", padding: "4px 8px", background: "#f8fafc", borderRadius: 6 }
const mutedStyle: CSSProperties = { margin: 0, color: "#64748b", fontSize: 13 }
const summaryBlockStyle: CSSProperties = { display: "grid", gap: 4 }
const evidenceStyle: CSSProperties = { display: "grid", gap: 6, padding: 10, background: "#f8fafc", borderRadius: 6 }
const evidenceRowStyle: CSSProperties = { display: "grid", gridTemplateColumns: "120px minmax(0, 1fr) auto", gap: 8, margin: 0, fontSize: 13 }
