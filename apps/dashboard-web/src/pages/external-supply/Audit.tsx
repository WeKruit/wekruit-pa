/**
 * v2.0 External Supply V1 — Wave D — `/admin/external-supply/audit`.
 *
 * Source quality metrics cards + a "Why this tier?" lookup that joins
 * record → identity resolution → evaluation → outreach plan → events for a
 * (candidate, job) pair. Plus a feed of recent `pa-correction-events` that
 * target external-supply objects (we filter client-side because the
 * collection is global).
 */
import { useEffect, useMemo, useState } from "react"
import type { CandidateCompanyJobEvaluation, OutreachEvent, SourceQualityMetric } from "@pa/core-types"
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import { EvaluationTierBadge } from "../../components/external-supply/EvaluationTierBadge.js"
import {
  findEvaluationByCandidateAndJob,
  listCorrectionEvents,
  listOutreachEvents,
  listSourceQualityMetrics,
  type CorrectionEventRow,
} from "../../lib/external-supply-client.js"

export function Audit() {
  const [metrics, setMetrics] = useState<SourceQualityMetric[]>([])
  const [corrections, setCorrections] = useState<CorrectionEventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lookupCandidateId, setLookupCandidateId] = useState("")
  const [lookupJobId, setLookupJobId] = useState("")
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupEvals, setLookupEvals] = useState<CandidateCompanyJobEvaluation[] | null>(null)
  const [lookupEvents, setLookupEvents] = useState<OutreachEvent[]>([])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([listSourceQualityMetrics(50), listCorrectionEvents({ limit: 100 })])
      .then(([m, c]) => {
        if (cancelled) return
        setMetrics(m.rows)
        setCorrections(
          c.rows.filter((r) =>
            r.targetType === "feedback_event" || r.targetType === "candidate_job_match",
          ),
        )
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const sourceCards = useMemo(() => {
    // Group by source — show the most-recent window's metric per source.
    const bySource = new Map<string, SourceQualityMetric>()
    for (const m of metrics) {
      const existing = bySource.get(m.source)
      if (!existing || m.windowStart > existing.windowStart) {
        bySource.set(m.source, m)
      }
    }
    return Array.from(bySource.values())
  }, [metrics])

  async function doLookup() {
    if (!lookupCandidateId.trim() || !lookupJobId.trim()) {
      setError("candidateId and jobId required")
      return
    }
    setLookupBusy(true)
    setError(null)
    setLookupEvals(null)
    setLookupEvents([])
    try {
      const [evals, events] = await Promise.all([
        findEvaluationByCandidateAndJob(lookupCandidateId.trim(), lookupJobId.trim()),
        listOutreachEvents({ candidateId: lookupCandidateId.trim(), limit: 50 }),
      ])
      setLookupEvals(evals)
      setLookupEvents(events.rows.filter((e) => e.jobId === lookupJobId.trim()))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLookupBusy(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V1 / Admin"
        title="Audit"
        description="Source-quality rollups + per-candidate traceback. Source metrics roll up validRate / duplicateRate / replyRate / bounceRate per source window."
      />

      {error && <ErrorState message={error} />}

      <Panel title="Source quality" eyebrow="pa-source-quality-metrics · most recent window per source">
        {loading && sourceCards.length === 0 ? (
          <LoadingState label="Loading metrics…" />
        ) : sourceCards.length === 0 ? (
          <EmptyState
            title="No metrics"
            body="paSourceQualityMetricsRollup hasn't produced data yet. Run the rollup job, or wait for the next cron tick."
          />
        ) : (
          <div style={cardGridStyle}>
            {sourceCards.map((m) => (
              <div key={m.metricId} style={cardStyle}>
                <div style={{ fontSize: "0.95em", fontWeight: 600 }}>{m.source}</div>
                <div style={{ fontSize: "0.8em", color: "#64748b" }}>
                  {m.windowStart.slice(0, 10)} → {m.windowEnd.slice(0, 10)}
                </div>
                <div style={{ marginTop: 8, fontSize: "0.85em" }}>
                  rows: <strong>{m.rowsIngested}</strong>
                </div>
                <div style={{ fontSize: "0.8em" }}>valid: {pct(m.validRate)}</div>
                <div style={{ fontSize: "0.8em" }}>dup: {pct(m.duplicateRate)}</div>
                <div style={{ fontSize: "0.8em" }}>conflict: {pct(m.identityConflictRate)}</div>
                <div style={{ fontSize: "0.8em" }}>reply: {pct(m.replyRate)}</div>
                <div style={{ fontSize: "0.8em" }}>bounce: {pct(m.bounceRate)}</div>
                <div style={{ fontSize: "0.8em" }}>conv: {pct(m.conversionToFirstInterview)}</div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Why this tier?" eyebrow="candidate × job traceback">
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 8, flexWrap: "wrap" }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>candidateId</span>
            <input
              type="text"
              value={lookupCandidateId}
              onChange={(e) => setLookupCandidateId(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>jobId</span>
            <input
              type="text"
              value={lookupJobId}
              onChange={(e) => setLookupJobId(e.target.value)}
              style={inputStyle}
            />
          </label>
          <button type="button" onClick={doLookup} disabled={lookupBusy} style={primaryBtnStyle}>
            {lookupBusy ? "Looking up…" : "Lookup"}
          </button>
        </div>

        {lookupEvals && lookupEvals.length === 0 && (
          <EmptyState title="No evaluations" body="No (candidate, job) evaluation found." />
        )}

        {lookupEvals && lookupEvals.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <table style={tableStyle}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                  <th style={thStyle}>Run</th>
                  <th style={thStyle}>Proposed</th>
                  <th style={thStyle}>Final</th>
                  <th style={thStyle}>Soft score</th>
                  <th style={thStyle}>Hard gate</th>
                  <th style={thStyle}>Missing</th>
                  <th style={thStyle}>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {lookupEvals.map((e) => (
                  <tr key={e.evaluationId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }}>
                      {e.evaluationRunId.slice(0, 8)}…
                    </td>
                    <td style={tdStyle}>
                      <EvaluationTierBadge tier={e.proposedTier} />
                    </td>
                    <td style={tdStyle}>
                      {e.reviewerDecision ? (
                        <EvaluationTierBadge tier={e.reviewerDecision.finalTier} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={tdStyle}>{e.softScore.toFixed(3)}</td>
                    <td style={tdStyle}>{e.hardGateResult}</td>
                    <td style={tdStyle}>{e.missingInfo.length}</td>
                    <td style={{ ...tdStyle, fontSize: "0.8em", maxWidth: 320 }}>{e.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {lookupEvents.length > 0 && (
              <Panel title={`Outreach events (${lookupEvents.length})`} eyebrow="filtered to this job">
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {lookupEvents.map((ev) => (
                    <li key={ev.eventId} style={{ fontSize: "0.85em", padding: "4px 0", borderBottom: "1px solid #f1f5f9" }}>
                      <span className="status-badge muted">{ev.kind}</span>{" "}
                      <span style={{ color: "#64748b" }}>
                        @ {ev.occurredAt.slice(0, 19).replace("T", " ")} via {ev.provider}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title={`Correction events (${corrections.length})`}
        eyebrow="pa-correction-events · external-supply targets"
      >
        {loading && corrections.length === 0 ? (
          <LoadingState label="Loading correction events…" />
        ) : corrections.length === 0 ? (
          <EmptyState
            title="No corrections"
            body="HITL tier overrides and outreach copy edits show up here for audit."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Target</th>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>Before</th>
                <th style={thStyle}>After</th>
              </tr>
            </thead>
            <tbody>
              {corrections.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ ...tdStyle, fontSize: "0.8em", color: "#64748b" }}>
                    {c.createdAt?.slice(0, 19).replace("T", " ") ?? "—"}
                  </td>
                  <td style={tdStyle}>
                    <span className="status-badge muted">{c.targetType}</span>
                  </td>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.75em" }}>
                    {c.targetId?.slice(0, 12)}…
                  </td>
                  <td style={{ ...tdStyle, fontSize: "0.85em" }}>{c.reason ?? "—"}</td>
                  <td style={{ ...tdStyle, fontSize: "0.75em", maxWidth: 200 }}>
                    {jsonPreview(c.beforeRedacted)}
                  </td>
                  <td style={{ ...tdStyle, fontSize: "0.75em", maxWidth: 200 }}>
                    {jsonPreview(c.afterRedacted)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}

function pct(value: number): string {
  if (!Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(1)}%`
}

function jsonPreview(value: unknown): string {
  if (value === null || value === undefined) return "—"
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value)
    return s.length > 120 ? `${s.slice(0, 119)}…` : s
  } catch {
    return String(value)
  }
}

const cardGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: 8,
}

const cardStyle: React.CSSProperties = {
  padding: "0.6rem 0.85rem",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#fff",
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "0.85em",
  borderCollapse: "collapse",
}
const thStyle: React.CSSProperties = { padding: "0.5rem 0" }
const tdStyle: React.CSSProperties = { padding: "0.4rem 0" }

const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 }
const labelStyle: React.CSSProperties = { fontSize: "0.8em", fontWeight: 600 }

const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.85em",
  minWidth: 240,
}

const primaryBtnStyle: React.CSSProperties = {
  background: "#1a73e8",
  color: "white",
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: 4,
  fontWeight: 500,
  cursor: "pointer",
}
