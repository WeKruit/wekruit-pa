/**
 * v1.8 — index page for pa-prescreen-sessions. Lists recent sessions
 * with status / score / jobId / userId / created. Click row → drilldown
 * to /admin/prescreen-sessions/:sessionId.
 */
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { db } from "../lib/firebase.js"

type Row = {
  id: string
  userId: string
  jobId: string
  score: number
  scoreMax: number
  threshold: number
  terminal: string | null
  terminalReason?: string
  createdAt: string
  updatedAt: string
}

function tone(t: string | null): "ok" | "warn" | "info" {
  if (t === "PASS") return "ok"
  if (t === null) return "info"
  return "warn"
}

export default function PrescreenSessionsList() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const q = query(
          collection(db(), "pa-prescreen-sessions"),
          orderBy("createdAt", "desc"),
          limit(50)
        )
        const snap = await getDocs(q)
        if (cancelled) return
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Row, "id">) })))
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return <LoadingState label="Loading sessions..." />
  if (err) return <ErrorState message={err} />

  return (
    <div>
      <PageHeader
        title="Pre-Screen Sessions"
        description="Recent candidate conversations triggered by WeKruit_*_Job SMS. Click a row for full per-Q explanation."
      />
      <Panel title={`${rows.length} session(s)`}>
        {rows.length === 0 && (
          <p style={{ opacity: 0.7, fontSize: "0.9em" }}>
            No sessions yet. Trigger one: SMS{" "}
            <code>WeKruit_&lt;jobId&gt;_&lt;userId&gt;_Job</code> to the Sendblue number.
            See{" "}
            <Link to="/admin/job-prescreen">job pre-screen config</Link>{" "}
            for jobIds.
          </p>
        )}
        {rows.length > 0 && (
          <table style={{ width: "100%", fontSize: "0.85em", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(0,0,0,0.15)" }}>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Created</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Status</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Ratio</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Job</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>User</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Session</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ratio = r.scoreMax === 0 ? 0 : r.score / r.scoreMax
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
                    <td style={{ padding: "0.25rem", fontFamily: "monospace", fontSize: "0.85em" }}>
                      {r.createdAt?.slice(0, 16)}
                    </td>
                    <td style={{ padding: "0.25rem" }}>
                      <Badge tone={tone(r.terminal)}>{r.terminal ?? "IN_PROGRESS"}</Badge>
                    </td>
                    <td style={{ padding: "0.25rem" }}>
                      {r.score?.toFixed(2)}/{r.scoreMax?.toFixed(2)} ({(ratio * 100).toFixed(0)}%)
                    </td>
                    <td style={{ padding: "0.25rem", fontSize: "0.85em" }}>{r.jobId}</td>
                    <td style={{ padding: "0.25rem", fontFamily: "monospace", fontSize: "0.75em" }}>
                      {r.userId?.slice(0, 8)}…
                    </td>
                    <td style={{ padding: "0.25rem" }}>
                      <Link to={`/admin/prescreen-sessions/${r.id}`}>{r.id.slice(0, 20)}…</Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
