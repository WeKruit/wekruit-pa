/**
 * v2.0 External Supply V1 — Wave D — `/admin/external-supply/evaluations`.
 *
 * List of `pa-candidate-evaluation-runs`. Click row → EvaluationDetail.
 */
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { CandidateEvaluationRun } from "@pa/core-types"
import { AdminJobLink } from "../../components/AdminEntityLink.js"
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import { listEvaluationRuns } from "../../lib/external-supply-client.js"

export function Evaluations() {
  const [runs, setRuns] = useState<CandidateEvaluationRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listEvaluationRuns(100)
      .then((res) => {
        if (!cancelled) setRuns(res.rows)
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
  }, [refreshKey])

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V1 / Admin"
        title="Evaluation runs"
        description="Each row is one (company, job) sweep over a batch or explicit record set. Click to view per-candidate tiers + reasons."
        actions={
          <button type="button" onClick={() => setRefreshKey((n) => n + 1)} style={secondaryBtnStyle}>
            Refresh
          </button>
        }
      />

      {error && <ErrorState message={error} />}

      <Panel
        title={`Runs (${runs.length})`}
        eyebrow="pa-candidate-evaluation-runs · ordered by createdAt desc"
      >
        {loading && runs.length === 0 ? (
          <LoadingState label="Loading runs…" />
        ) : runs.length === 0 ? (
          <EmptyState
            title="No evaluation runs"
            body="Open a batch and click 'Run evaluation' to seed the first run."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                <th style={thStyle}>Run</th>
                <th style={thStyle}>Job</th>
                <th style={thStyle}>Company</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Progress</th>
                <th style={thStyle}>Rubric</th>
                <th style={thStyle}>Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={tdStyle}>
                    <Link to={`/admin/external-supply/evaluations/${r.runId}`}>
                      {r.runId.slice(0, 8)}…
                    </Link>
                  </td>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }}>
                    <AdminJobLink jobId={r.jobId} />
                  </td>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }}>{r.companyId}</td>
                  <td style={tdStyle}>
                    <span className={`status-badge ${runTone(r.status)}`}>{r.status}</span>
                  </td>
                  <td style={tdStyle}>
                    {r.completedCount}/{r.candidateCount}
                  </td>
                  <td style={{ ...tdStyle, fontSize: "0.8em", color: "#64748b" }}>{r.rubricVersion}</td>
                  <td style={{ ...tdStyle, fontSize: "0.8em", color: "#64748b" }}>
                    {r.createdAt.slice(0, 19).replace("T", " ")}
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

function runTone(status: CandidateEvaluationRun["status"]): string {
  if (status === "completed") return "good"
  if (status === "failed") return "bad"
  if (status === "running") return "warn"
  return "muted"
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "0.85em",
  borderCollapse: "collapse",
}

const thStyle: React.CSSProperties = { padding: "0.5rem 0" }
const tdStyle: React.CSSProperties = { padding: "0.4rem 0" }

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  color: "#1f2937",
  padding: "0.5rem 1rem",
  borderRadius: 4,
  cursor: "pointer",
}
