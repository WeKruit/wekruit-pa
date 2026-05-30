/**
 * Admin view of pa-recruiter-submissions.
 *
 * Lists every recruiter submission newest-first, with chip filters (job + status),
 * sortable columns, pagination, row drill-down. Backed by the unified DataTable
 * primitive + useTable hook.
 */
import { Fragment, useEffect, useMemo, useState } from "react"
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { AdminJobLink } from "../components/AdminEntityLink.js"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { DataTable, type Column } from "../components/console/primitives.js"
import { useTable } from "../components/console/useTable.js"
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
  createdAtMs?: number
  hardScorePct?: number
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

const STATUS_VALUES = ["new", "reviewing", "advanced", "rejected", "duplicate"]

export default function RecruiterSubmissions() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<SubmissionDoc[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const q = query(
          collection(db(), "pa-recruiter-submissions"),
          orderBy("createdAt", "desc"),
          limit(500),
        )
        const snap = await getDocs(q)
        if (cancelled) return
        const all = snap.docs.map((d) => {
          const data = d.data() as Omit<SubmissionDoc, "id">
          const createdAtMs = data.createdAt?.seconds ? data.createdAt.seconds * 1000 : 0
          const hardScorePct = data.score?.hardTotal
            ? data.score.hardChecked / data.score.hardTotal
            : 0
          return { id: d.id, ...data, createdAtMs, hardScorePct }
        })
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

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      if (r.jobId && !seen.has(r.jobId)) {
        seen.set(r.jobId, r.jobTitleSnapshot ?? r.jobId)
      }
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: SubmissionDoc) => r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<SubmissionDoc>(rows, {
    defaultSort: { key: "createdAtMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.submitter?.name?.toLowerCase().includes(q) ?? false) ||
      (r.submitter?.email?.toLowerCase().includes(q) ?? false) ||
      (r.candidate?.name?.toLowerCase().includes(q) ?? false) ||
      (r.candidate?.link?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "status",
        label: "Status",
        multi: true,
        options: STATUS_VALUES.map((s) => ({
          key: s,
          label: s,
          test: (r: SubmissionDoc) => (r.status ?? "new") === s,
        })),
      },
      {
        id: "score",
        label: "Score",
        multi: false,
        options: [
          {
            key: "hardFull",
            label: "Hard 100%",
            title: "All hard-filter boxes ticked",
            test: (r: SubmissionDoc) =>
              !!r.score && r.score.hardTotal > 0 && r.score.hardChecked === r.score.hardTotal,
          },
          {
            key: "hardPartial",
            label: "Hard < 100%",
            title: "At least one hard filter missing",
            test: (r: SubmissionDoc) =>
              !!r.score && r.score.hardTotal > 0 && r.score.hardChecked < r.score.hardTotal,
          },
          {
            key: "antiFlagged",
            label: "Anti-flag ≥ 1",
            title: "At least one anti-signal ticked",
            test: (r: SubmissionDoc) => !!r.score && r.score.antiChecked > 0,
          },
          {
            key: "sheetError",
            label: "Sheet sync error",
            test: (r: SubmissionDoc) => Boolean(r.sheetSyncError),
          },
        ],
      },
    ],
  })

  if (loading) return <LoadingState label="Loading submissions..." />
  if (err) return <ErrorState message={err} />

  const columns: Column<SubmissionDoc>[] = [
    {
      key: "createdAtMs",
      label: "Submitted",
      sortable: true,
      width: 170,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatTimestamp(r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Job",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "-"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "submitter",
      label: "Submitter",
      render: (r) => (
        <>
          <div>{r.submitter?.name ?? "—"}</div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.submitter?.email ?? ""}</div>
        </>
      ),
    },
    {
      key: "candidate",
      label: "Candidate",
      render: (r) => (
        <>
          <div>{r.candidate?.name ?? "—"}</div>
          {r.candidate?.link && (
            <a
              href={r.candidate.link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ fontSize: 11, color: "#2a5fb8" }}
            >
              {r.candidate.link.length > 36 ? r.candidate.link.slice(0, 36) + "…" : r.candidate.link}
            </a>
          )}
        </>
      ),
    },
    {
      key: "hardScorePct",
      label: "Hard",
      sortable: true,
      width: 70,
      render: (r) => (r.score ? `${r.score.hardChecked}/${r.score.hardTotal}` : "—"),
    },
    {
      key: "fitScore",
      label: "Fit",
      width: 70,
      render: (r) => (r.score ? `${r.score.fitChecked}/${r.score.fitTotal}` : "—"),
    },
    {
      key: "antiScore",
      label: "Anti",
      width: 70,
      render: (r) => (r.score ? `${r.score.antiChecked}/${r.score.antiTotal}` : "—"),
    },
    {
      key: "sheet",
      label: "Sheet",
      width: 80,
      render: (r) => (r.sheetSyncedAt ? "✓ synced" : r.sheetSyncError ? "× error" : "—"),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      width: 100,
      render: (r) => <Badge tone={statusBadge(r.status)}>{r.status ?? "new"}</Badge>,
    },
  ]

  return (
    <div>
      <PageHeader
        title="Recruiter Submissions"
        description="Submissions from the WeKruit recruiter board. Click a row to expand the full checklist."
      />
      <Panel>
        <DataTable<SubmissionDoc>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search submitter / candidate / job…"
          sort={table.sort}
          onSort={table.toggleSort}
          page={table.page}
          pageCount={table.pageCount}
          onPageChange={table.setPage}
          onResetFilters={table.reset}
          count={table.filteredCount}
          totalCount={table.totalRows}
          onRowClick={(r) => setExpandedId(expandedId === r.id ? null : r.id ?? null)}
          empty={
            <div style={{ padding: 40, textAlign: "center", color: "#777" }}>
              No submissions match the current filters.
            </div>
          }
        />
      </Panel>

      {expandedId && (() => {
        const row = rows.find((r) => r.id === expandedId)
        if (!row) return null
        return <RowDetailPanel row={row} onClose={() => setExpandedId(null)} />
      })()}
    </div>
  )
}

function RowDetailPanel({ row, onClose }: { row: SubmissionDoc; onClose: () => void }) {
  const checks = row.checklist ?? {}
  const ticked = Object.entries(checks).filter(([, v]) => v).map(([k]) => k)
  return (
    <Panel
      title="Submission detail"
      actions={
        <button
          onClick={onClose}
          style={{ border: "none", background: "none", cursor: "pointer", color: "#888", fontSize: 16 }}
          aria-label="Close"
        >
          ✕
        </button>
      }
    >
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
              <a href={row.candidate.link} target="_blank" rel="noopener noreferrer">
                {row.candidate.link}
              </a>
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
              {ticked.map((id) => (
                <li key={id}><code>{id}</code></li>
              ))}
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
    </Panel>
  )
}
