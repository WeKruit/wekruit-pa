/**
 * v2.0 External Supply V1 — Wave D — `/admin/external-supply` landing page.
 *
 * Aggregates a quick summary of the external-supply system: latest batches,
 * latest evaluation runs in flight, outreach plan counts by approval state,
 * and source-quality metrics. Each card links to the relevant sub-page.
 */
import { Link } from "react-router-dom"
import { useEffect, useState } from "react"
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import {
  listBatches,
  listEvaluationRuns,
  listInstantlySyncRecords,
  listOutreachPlans,
  listSourceQualityMetrics,
} from "../../lib/external-supply-client.js"
import type {
  CandidateEvaluationRun,
  ExternalSourcingBatch,
  InstantlySyncRecord,
  OutreachApprovalStatus,
  OutreachPlan,
  SourceQualityMetric,
} from "@pa/core-types"

interface Summary {
  batches: ExternalSourcingBatch[]
  runs: CandidateEvaluationRun[]
  planCounts: Record<OutreachApprovalStatus, number>
  recentSyncs: InstantlySyncRecord[]
  metrics: SourceQualityMetric[]
}

const ZERO_PLAN_COUNTS: Record<OutreachApprovalStatus, number> = {
  draft: 0,
  awaiting_approval: 0,
  approved: 0,
  rejected: 0,
  sent: 0,
  failed: 0,
}

export function Landing() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      listBatches({ limit: 10 }),
      listEvaluationRuns(10),
      listOutreachPlans({ limit: 500 }),
      listInstantlySyncRecords({ limit: 10 }),
      listSourceQualityMetrics(20),
    ])
      .then(([batches, runs, plans, syncs, metrics]) => {
        if (cancelled) return
        const counts = { ...ZERO_PLAN_COUNTS }
        for (const p of plans.rows) counts[p.approvalStatus] += 1
        setSummary({
          batches: batches.rows,
          runs: runs.rows,
          planCounts: counts,
          recentSyncs: syncs.rows,
          metrics: metrics.rows,
        })
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

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V1"
        title="External Supply"
        description="Bulk-import external sourcing exports (Juicebox / Lessie / Coresignal) and walk them through identity resolution, evaluation, outreach, and sync — all without leaving the admin console."
        actions={
          <Link to="/admin/external-supply/batches/new">
            <button type="button" style={primaryBtnStyle}>
              New batch
            </button>
          </Link>
        }
      />

      {error && <ErrorState message={error} />}
      {loading && !summary ? (
        <LoadingState label="Loading summary…" />
      ) : !summary ? null : (
        <>
          <Panel title="Recent batches" eyebrow="pa-external-sourcing-batches">
            {summary.batches.length === 0 ? (
              <EmptyState
                title="No batches yet"
                body="Upload your first sourcing export to start the pipeline."
                action={
                  <Link to="/admin/external-supply/batches/new">
                    <button type="button" style={primaryBtnStyle}>
                      Create batch
                    </button>
                  </Link>
                }
              />
            ) : (
              <ul style={cardListStyle}>
                {summary.batches.map((b) => (
                  <li key={b.batchId} style={cardItemStyle}>
                    <Link to={`/admin/external-supply/batches/${b.batchId}`} style={cardLinkStyle}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <strong>{b.source}</strong>
                        <span style={{ color: "#64748b", fontSize: "0.85em" }}>{fmtTime(b.createdAt)}</span>
                      </div>
                      <div style={{ fontSize: "0.85em" }}>
                        {b.status} · {b.rowCount} rows · {b.validLinkedInCount} LI · {b.validEmailCount} email · {b.needsReviewCount} review
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Evaluation runs" eyebrow="pa-candidate-evaluation-runs">
            {summary.runs.length === 0 ? (
              <EmptyState
                title="No evaluations yet"
                body="Open a batch and trigger an evaluation against a target job."
              />
            ) : (
              <ul style={cardListStyle}>
                {summary.runs.map((r) => (
                  <li key={r.runId} style={cardItemStyle}>
                    <Link to={`/admin/external-supply/evaluations/${r.runId}`} style={cardLinkStyle}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <strong>{r.jobId}</strong>
                        <span className={`status-badge ${runTone(r.status)}`}>{r.status}</span>
                      </div>
                      <div style={{ fontSize: "0.85em" }}>
                        {r.completedCount}/{r.candidateCount} · {fmtTime(r.createdAt)} · {r.rubricVersion}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Outreach plans" eyebrow="pa-outreach-plans · by approval state">
            <div style={statGridStyle}>
              {(Object.keys(summary.planCounts) as OutreachApprovalStatus[]).map((k) => (
                <Link
                  to={`/admin/external-supply/outreach?status=${k}`}
                  key={k}
                  style={statCardLinkStyle}
                >
                  <div style={{ fontSize: "1.4em", fontWeight: 600 }}>{summary.planCounts[k]}</div>
                  <div style={{ fontSize: "0.8em", color: "#64748b" }}>{k}</div>
                </Link>
              ))}
            </div>
          </Panel>

          <Panel title="Recent Instantly syncs" eyebrow="pa-instantly-sync-records">
            {summary.recentSyncs.length === 0 ? (
              <EmptyState
                title="No syncs"
                body="Approved plans appear here once dry-run or live sync runs."
              />
            ) : (
              <ul style={cardListStyle}>
                {summary.recentSyncs.map((s) => (
                  <li key={s.syncId} style={cardItemStyle}>
                    <Link to="/admin/external-supply/sync" style={cardLinkStyle}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <strong>{s.mode}</strong>
                        <span className={`status-badge ${syncTone(s.syncStatus)}`}>{s.syncStatus}</span>
                      </div>
                      <div style={{ fontSize: "0.85em" }}>
                        plan {s.planId.slice(0, 8)}… · {fmtTime(s.createdAt)}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {summary.metrics.length > 0 && (
            <Panel title="Source quality" eyebrow="pa-source-quality-metrics · recent windows">
              <ul style={cardListStyle}>
                {summary.metrics.slice(0, 6).map((m) => (
                  <li key={m.metricId} style={cardItemStyle}>
                    <Link to="/admin/external-supply/audit" style={cardLinkStyle}>
                      <strong>
                        {m.source} · {m.windowStart.slice(0, 7)}
                      </strong>
                      <div style={{ fontSize: "0.85em" }}>
                        valid {pct(m.validRate)} · dup {pct(m.duplicateRate)} · reply {pct(m.replyRate)} · bounce {pct(m.bounceRate)}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </div>
  )
}

function runTone(status: CandidateEvaluationRun["status"]): string {
  if (status === "completed") return "good"
  if (status === "failed") return "bad"
  if (status === "running") return "warn"
  return "muted"
}

function syncTone(status: InstantlySyncRecord["syncStatus"]): string {
  if (status === "synced") return "good"
  if (status === "sync_failed" || status === "suppressed") return "bad"
  if (status === "dry_run_planned" || status === "queued") return "warn"
  return "muted"
}

function pct(value: number): string {
  if (!Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(1)}%`
}

function fmtTime(iso: string | undefined): string {
  if (!iso) return "—"
  return iso.slice(0, 19).replace("T", " ")
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

const cardListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: 8,
}

const cardItemStyle: React.CSSProperties = {
  margin: 0,
}

const cardLinkStyle: React.CSSProperties = {
  display: "block",
  padding: "0.6rem 0.75rem",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  textDecoration: "none",
  color: "inherit",
  background: "#fff",
}

const statGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
  gap: 8,
}

const statCardLinkStyle: React.CSSProperties = {
  display: "block",
  padding: "0.5rem 0.75rem",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  textAlign: "center",
  textDecoration: "none",
  color: "inherit",
  background: "#fff",
}
