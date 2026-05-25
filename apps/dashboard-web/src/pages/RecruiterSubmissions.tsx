/**
 * Admin view of pa-recruiter-submissions.
 *
 * Lists every recruiter submission newest-first, with score summary +
 * drill-down. Auth-gated to @wekruit.com (AppShell).
 */
import { useEffect, useState } from "react"
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { db } from "../lib/firebase.js"

interface SubmissionDoc {
  id: string
  jobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  submitter?: { name?: string; email?: string; company?: string }
  candidate?: {
    name?: string
    link?: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  checklist?: Record<string, boolean>
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
  sheetSyncedAt?: { seconds: number } | null
  sheetSyncError?: string | null
  createdAt?: { seconds: number } | null
}

function formatTimestamp(ts: SubmissionDoc["createdAt"]): string {
  if (!ts || typeof ts.seconds !== "number") return "—"
  return new Date(ts.seconds * 1000).toLocaleString()
}

function statusBadge(s: string | undefined): "ok" | "warn" | "info" | "muted" {
  switch (s) {
    case "advanced": return "ok"
    case "rejected": return "warn"
    case "reviewing": return "info"
    default: return "muted"
  }
}

export default function RecruiterSubmissions() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<SubmissionDoc[]>([])
  const [jobFilter, setJobFilter] = useState<string>("")
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const q = query(
          collection(db(), "pa-recruiter-submissions"),
          orderBy("createdAt", "desc"),
          limit(200),
        )
        const snap = await getDocs(q)
        if (cancelled) return
        const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SubmissionDoc, "id">) }))
        setRows(all)
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

  if (loading) return <LoadingState label="Loading submissions..." />
  if (err) return <ErrorState message={err} />

  const filtered = rows.filter((r) => {
    if (jobFilter && r.jobId !== jobFilter) return false
    if (statusFilter && r.status !== statusFilter) return false
    return true
  })

  const jobIds = Array.from(new Set(rows.map((r) => r.jobId).filter(Boolean))) as string[]

  return (
    <div>
      <PageHeader
        title="Recruiter Submissions"
        description={`${rows.length} submissions across ${jobIds.length} collab roles. Filter, drill in, change status.`}
      />

      <Panel title="Filters">
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 13, color: "#444" }}>
            Job:&nbsp;
            <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)}>
              <option value="">All ({rows.length})</option>
              {jobIds.map((id) => {
                const cnt = rows.filter((r) => r.jobId === id).length
                return <option key={id} value={id}>{id} ({cnt})</option>
              })}
            </select>
          </label>
          <label style={{ fontSize: 13, color: "#444" }}>
            Status:&nbsp;
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All</option>
              <option value="new">new</option>
              <option value="reviewing">reviewing</option>
              <option value="advanced">advanced</option>
              <option value="rejected">rejected</option>
              <option value="duplicate">duplicate</option>
            </select>
          </label>
          <span style={{ color: "#777", fontSize: 12 }}>
            Showing {filtered.length} of {rows.length}
          </span>
        </div>
      </Panel>

      <Panel title="Submissions">
        {filtered.length === 0 ? (
          <p style={{ color: "#777", padding: 12 }}>No submissions match the current filters.</p>
        ) : (
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e6e6e2" }}>
                <th style={{ padding: 8 }}>Submitted</th>
                <th style={{ padding: 8 }}>Job</th>
                <th style={{ padding: 8 }}>Submitter</th>
                <th style={{ padding: 8 }}>Candidate</th>
                <th style={{ padding: 8 }}>Hard</th>
                <th style={{ padding: 8 }}>Fit</th>
                <th style={{ padding: 8 }}>Anti</th>
                <th style={{ padding: 8 }}>Sheet</th>
                <th style={{ padding: 8 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const expanded = expandedId === r.id
                return (
                  <>
                    <tr
                      key={r.id}
                      style={{ borderBottom: "1px solid #f0f0ec", cursor: "pointer" }}
                      onClick={() => setExpandedId(expanded ? null : r.id)}
                    >
                      <td style={{ padding: 8, whiteSpace: "nowrap" }}>{formatTimestamp(r.createdAt)}</td>
                      <td style={{ padding: 8 }}>
                        <div style={{ fontWeight: 500 }}>{r.jobTitleSnapshot ?? r.jobId}</div>
                        <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
                      </td>
                      <td style={{ padding: 8 }}>
                        <div>{r.submitter?.name ?? "—"}</div>
                        <div style={{ color: "#777", fontSize: 11 }}>{r.submitter?.email ?? ""}</div>
                      </td>
                      <td style={{ padding: 8 }}>
                        <div>{r.candidate?.name ?? "—"}</div>
                        {r.candidate?.link && (
                          <a
                            href={r.candidate.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ fontSize: 11, color: "#2a5fb8" }}
                          >
                            {r.candidate.link.length > 40 ? r.candidate.link.slice(0, 40) + "…" : r.candidate.link}
                          </a>
                        )}
                      </td>
                      <td style={{ padding: 8 }}>
                        {r.score ? `${r.score.hardChecked}/${r.score.hardTotal}` : "—"}
                      </td>
                      <td style={{ padding: 8 }}>
                        {r.score ? `${r.score.fitChecked}/${r.score.fitTotal}` : "—"}
                      </td>
                      <td style={{ padding: 8 }}>
                        {r.score ? `${r.score.antiChecked}/${r.score.antiTotal}` : "—"}
                      </td>
                      <td style={{ padding: 8, fontSize: 12 }}>
                        {r.sheetSyncedAt ? "✓ synced" : r.sheetSyncError ? "× error" : "—"}
                      </td>
                      <td style={{ padding: 8 }}>
                        <Badge tone={statusBadge(r.status)}>{r.status ?? "new"}</Badge>
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={r.id + ":x"}>
                        <td colSpan={9} style={{ padding: 12, background: "#fafaf6" }}>
                          <RowDetail row={r} />
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}

function RowDetail({ row }: { row: SubmissionDoc }) {
  const checks = row.checklist ?? {}
  const ticked = Object.entries(checks).filter(([_, v]) => v).map(([k]) => k)
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div>
        <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
          Submitter
        </h4>
        <p style={{ margin: 0, fontSize: 13 }}>
          {row.submitter?.name} &lt;{row.submitter?.email}&gt;
          {row.submitter?.company && <> · {row.submitter.company}</>}
        </p>

        <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
          Candidate
        </h4>
        <p style={{ margin: 0, fontSize: 13 }}>
          <strong>{row.candidate?.name}</strong>
          {row.candidate?.currentRole && <> · {row.candidate.currentRole}</>}
          {row.candidate?.yoe && <> · {row.candidate.yoe} YOE</>}
        </p>
        {row.candidate?.link && (
          <p style={{ margin: "4px 0 0", fontSize: 12 }}>
            <a href={row.candidate.link} target="_blank" rel="noopener noreferrer">{row.candidate.link}</a>
          </p>
        )}
        {row.candidate?.notes && (
          <>
            <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
              Notes
            </h4>
            <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{row.candidate.notes}</p>
          </>
        )}
      </div>

      <div>
        <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
          Score
        </h4>
        {row.score ? (
          <p style={{ margin: 0, fontSize: 13 }}>
            Hard {row.score.hardChecked}/{row.score.hardTotal} ·{" "}
            Fit {row.score.fitChecked}/{row.score.fitTotal} ·{" "}
            Bonus {row.score.bonusChecked}/{row.score.bonusTotal} ·{" "}
            Anti {row.score.antiChecked}/{row.score.antiTotal}
          </p>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: "#999" }}>No score.</p>
        )}

        <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
          Ticked items ({ticked.length})
        </h4>
        {ticked.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: "#999" }}>No items ticked.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#444" }}>
            {ticked.map((id) => <li key={id}><code>{id}</code></li>)}
          </ul>
        )}

        {row.sheetSyncError && (
          <>
            <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#a00" }}>
              Sheet sync error
            </h4>
            <p style={{ margin: 0, fontSize: 12, color: "#a00", whiteSpace: "pre-wrap" }}>
              {row.sheetSyncError}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
