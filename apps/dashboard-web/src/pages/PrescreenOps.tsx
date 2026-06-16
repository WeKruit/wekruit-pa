/**
 * Job-centric Prescreen Ops board (/admin/prescreen-ops).
 *
 * Important semantics:
 * - `terminal` is Claire's proposed terminal recommendation, not a decision.
 * - `terminalActionPendingReview=true` rows need an operator-committed final
 *   before any accept/reject outbound is queued.
 *
 * All counts come from the `paAdminPrescreenOpsSnapshot` ops-mode rollup —
 * never from client-side per-job Firestore fan-out (that recreates the
 * limit-75 lie the old queue page suffered from).
 */
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import type { CSSProperties } from "react"
import type {
  PrescreenOpsJobRollup,
  PrescreenOpsSessionRow,
  PrescreenOpsSnapshotOpsResponse,
} from "@pa/core-types"
import { AdminPrescreenSessionLink, AdminUserLink } from "../components/AdminEntityLink.js"
import {
  BulkRejectDrawer,
  EngagementBadge,
  PrescreenReviewDrawer,
  terminalTone,
  type Row,
} from "../components/prescreen/PrescreenReviewDrawers.js"
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
} from "../components/ui.js"
import { collectPrescreenSessions, getPrescreenOpsSnapshot } from "../lib/prescreen-ops-api.js"

const UNKNOWN_JOB_ID = "unknown"
const EXPANDED_PENDING_LIMIT = 10
const CLOSED_JOB_STATUSES = new Set([
  "closed",
  "archived",
  "filled",
  "paused",
  "expired",
  "inactive",
  "deleted",
])

type JobStatusSegment = "open" | "all"

function isOpenJob(job: PrescreenOpsJobRollup): boolean {
  return !CLOSED_JOB_STATUSES.has(job.jobStatus.toLowerCase())
}

function bucketTone(bucket: PrescreenOpsSessionRow["classification"]["bucket"]): "ok" | "warn" | "info" | "muted" {
  if (bucket === "top_five_pass") return "ok"
  if (bucket === "batch_reject" || bucket === "hard_stop") return "warn"
  if (bucket === "individual_review") return "info"
  return "muted"
}

function committedTotal(committed: PrescreenOpsJobRollup["committed"]): number {
  return committed.PASS + committed.FAIL + committed.HARD_STOP
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function claireTerminalSummary(job: PrescreenOpsJobRollup): string {
  const parts = [
    countLabel(job.byTerminal.PASS, "completed"),
    countLabel(job.byTerminal.FAIL, "Claire reject"),
    countLabel(job.byTerminal.HARD_STOP, "hard stop"),
  ]
  if (job.byTerminal.PAUSE > 0) parts.push(countLabel(job.byTerminal.PAUSE, "paused"))
  if (job.byTerminal.IN_PROGRESS > 0) parts.push(countLabel(job.byTerminal.IN_PROGRESS, "in progress"))
  return parts.join(" · ")
}

function committedSummary(committed: PrescreenOpsJobRollup["committed"]): string {
  const total = committedTotal(committed)
  if (total === 0) return "0 committed"
  const parts = [
    committed.PASS > 0 ? countLabel(committed.PASS, "passed") : null,
    committed.FAIL > 0 ? countLabel(committed.FAIL, "rejected") : null,
    committed.HARD_STOP > 0 ? countLabel(committed.HARD_STOP, "hard stop") : null,
  ].filter((part): part is string => part !== null)
  return `${countLabel(total, "committed")} (${parts.join(" · ")})`
}

function relativeTime(iso: string): string {
  if (!iso) return "never"
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return iso.slice(0, 16)
  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 60) return `${days}d ago`
  return iso.slice(0, 10)
}

function scorePercent(row: PrescreenOpsSessionRow): string {
  const ratio = row.scoreMax === 0 ? 0 : row.score / row.scoreMax
  return `${(ratio * 100).toFixed(0)}%`
}

/**
 * Adapt a callable session row to the drawers' `Row` shape. The drawers stay
 * untouched (the queue page imports them too); the only gaps are the
 * non-optional `threshold`/`updatedAt` and the loosely-typed review map.
 */
function toDrawerRow(row: PrescreenOpsSessionRow): Row {
  return {
    id: row.id,
    userId: row.userId,
    jobId: row.jobId,
    score: row.score,
    scoreMax: row.scoreMax,
    threshold: row.threshold ?? 0,
    terminal: row.terminal,
    terminalReason: row.terminalReason,
    terminalActionPendingReview: row.terminalActionPendingReview,
    evaluationAttemptId: row.evaluationAttemptId,
    questions: row.questions,
    review: row.review as Row["review"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  }
}

export default function PrescreenOps() {
  const navigate = useNavigate()
  const [snapshot, setSnapshot] = useState<PrescreenOpsSnapshotOpsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [statusSegment, setStatusSegment] = useState<JobStatusSegment>("open")
  const [search, setSearch] = useState("")
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  const [expandedRows, setExpandedRows] = useState<PrescreenOpsSessionRow[]>([])
  const [expandedLoading, setExpandedLoading] = useState(false)
  const [expandedErr, setExpandedErr] = useState<string | null>(null)
  const [expandedReloadKey, setExpandedReloadKey] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawerSessionId, setDrawerSessionId] = useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        setErr(null)
        const loaded = await getPrescreenOpsSnapshot()
        if (!cancelled) setSnapshot(loaded)
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

  useEffect(() => {
    if (!expandedJobId || expandedJobId === UNKNOWN_JOB_ID) return
    let cancelled = false
    void (async () => {
      try {
        setExpandedLoading(true)
        setExpandedErr(null)
        const rows = await collectPrescreenSessions(
          { jobId: expandedJobId, queue: "pending", limit: EXPANDED_PENDING_LIMIT },
          EXPANDED_PENDING_LIMIT,
        )
        if (cancelled) return
        setExpandedRows(rows)
        setSelected((prev) => {
          const ids = new Set(rows.map((row) => row.id))
          return new Set(Array.from(prev).filter((id) => ids.has(id)))
        })
      } catch (e) {
        if (!cancelled) setExpandedErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setExpandedLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [expandedJobId, expandedReloadKey])

  const visibleJobs = useMemo(() => {
    const term = search.trim().toLowerCase()
    return [...(snapshot?.jobs ?? [])]
      .filter((job) => statusSegment === "all" || isOpenJob(job))
      .filter(
        (job) =>
          !term ||
          job.title.toLowerCase().includes(term) ||
          job.company.toLowerCase().includes(term) ||
          job.jobId.toLowerCase().includes(term),
      )
      .sort(
        (a, b) =>
          b.pendingReview - a.pendingReview || b.lastSessionAt.localeCompare(a.lastSessionAt),
      )
  }, [snapshot, statusSegment, search])

  const selectedRows = useMemo(
    () => expandedRows.filter((row) => selected.has(row.id)),
    [expandedRows, selected],
  )

  function refreshSnapshot() {
    setReloadKey((key) => key + 1)
  }

  function refreshAfterReview() {
    refreshSnapshot()
    setExpandedReloadKey((key) => key + 1)
  }

  function toggleExpanded(jobId: string) {
    if (expandedJobId === jobId) {
      setExpandedJobId(null)
      setExpandedRows([])
      setExpandedErr(null)
      setSelected(new Set())
      return
    }
    setExpandedJobId(jobId)
    setExpandedRows([])
    setExpandedErr(null)
    setSelected(new Set())
  }

  function toggleSelected(sessionId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  function goToQueue(params: Record<string, string>) {
    const query = new URLSearchParams(params)
    navigate(`/admin/prescreen-sessions?${query.toString()}`)
  }

  if (loading && !snapshot) return <LoadingState label="Loading prescreen ops snapshot..." />
  if (err && !snapshot) return <ErrorState message={err} />
  if (!snapshot) return <ErrorState message="Snapshot unavailable." />

  const totals = snapshot.totals

  return (
    <div className="page-stack">
      <PageHeader
        title="Prescreen Ops"
        description="Claire terminal is a proposal, not a decision. Pending rows need an operator-committed final before any candidate-facing accept/reject is queued."
        actions={
          <button type="button" onClick={refreshSnapshot} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        }
      />
      {err ? <ErrorState message={err} /> : null}
      <Panel
        title="Totals"
        eyebrow={`generated ${relativeTime(snapshot.generatedAt)}`}
        actions={
          snapshot.truncated ? (
            <span style={{ color: "#64748b", fontSize: "0.82em" }}>
              scanned {snapshot.scanned} of {totals.sessions} sessions
            </span>
          ) : undefined
        }
      >
        <div style={statGridStyle}>
          <Stat label="Total sessions" value={totals.sessions} tone="muted" />
          <Stat label="Pending review" value={totals.pendingHumanReview} tone="warn" />
          <Stat label="Likely reject" value={totals.byBucket.batch_reject} tone="warn" />
          <Stat label="Top 5%" value={totals.byBucket.top_five_pass} tone="ok" />
          <Stat label="Hard stop" value={totals.byBucket.hard_stop} tone="warn" />
          <Stat label="Paused" value={totals.byBucket.paused} tone="info" />
        </div>
        <div style={{ color: "#64748b", fontSize: "0.82em", marginTop: 8 }}>
          {totals.realSessions} real / {totals.testSessions} test in the scanned window. KPIs count
          real sessions only.
        </div>
      </Panel>
      <Panel
        title="Jobs"
        eyebrow={`${visibleJobs.length} of ${snapshot.jobs.length} job(s)`}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "inline-flex", gap: 0 }}>
              <button
                type="button"
                aria-pressed={statusSegment === "open"}
                onClick={() => setStatusSegment("open")}
                style={segmentStyle(statusSegment === "open", "left")}
              >
                Open
              </button>
              <button
                type="button"
                aria-pressed={statusSegment === "all"}
                onClick={() => setStatusSegment("all")}
                style={segmentStyle(statusSegment === "all", "right")}
              >
                All jobs
              </button>
            </div>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or company"
              style={searchStyle}
            />
          </div>
        }
      >
        {snapshot.jobs.length === 0 ? (
          <EmptyState
            title="No prescreen sessions yet"
            body="Job rollups appear once at least one prescreen session exists."
          />
        ) : visibleJobs.length === 0 ? (
          <p style={{ opacity: 0.7, fontSize: "0.9em" }}>
            No jobs match the current filter.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {visibleJobs.map((job) => {
              const expanded = expandedJobId === job.jobId
              const expandable = job.jobId !== UNKNOWN_JOB_ID
              return (
                <div key={job.jobId} style={jobCardStyle}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (expandable) toggleExpanded(job.jobId)
                    }}
                    onKeyDown={(e) => {
                      if (expandable && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault()
                        toggleExpanded(job.jobId)
                      }
                    }}
                    style={{ cursor: expandable ? "pointer" : "default", display: "grid", gap: 6 }}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "1em" }}>
                        {job.title}
                        {job.company ? (
                          <span style={{ color: "#64748b", fontWeight: 400 }}> · {job.company}</span>
                        ) : null}
                      </strong>
                      <StatusBadge value={job.jobStatus} />
                      {job.pendingReview > 0 ? (
                        <Badge tone="warn">{job.pendingReview} pending HITL</Badge>
                      ) : null}
                      {job.testSessionCount > 0 ? (
                        <Badge tone="muted">{job.testSessionCount} test</Badge>
                      ) : null}
                      <span style={{ color: "#64748b", fontSize: "0.82em", marginLeft: "auto" }}>
                        last session {relativeTime(job.lastSessionAt)}
                      </span>
                    </div>
                    <div style={{ color: "#334155", fontSize: "0.86em" }}>
                      {job.realSessionCount} real session{job.realSessionCount === 1 ? "" : "s"} →{" "}
                      Claire status: {claireTerminalSummary(job)} → {job.pendingReview} pending HITL ·{" "}
                      {committedSummary(job.committed)}
                      {job.testSessionCount > 0 ? (
                        <span style={{ color: "#94a3b8" }}> · +{job.testSessionCount} test</span>
                      ) : null}
                    </div>
                  </div>
                  {expandable ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        disabled={job.pendingReview === 0}
                        onClick={() => goToQueue({ jobId: job.jobId, queue: "pending" })}
                      >
                        Review pending ({job.pendingReview})
                      </button>
                      <button
                        type="button"
                        onClick={() => goToQueue({ jobId: job.jobId, terminal: "PASS", queue: "all" })}
                      >
                        Claire completed
                      </button>
                      <button type="button" onClick={() => goToQueue({ jobId: job.jobId, queue: "all" })}>
                        All sessions →
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate(`/admin/jobs/${encodeURIComponent(job.jobId)}/prescreen`)}
                      >
                        Job config
                      </button>
                    </div>
                  ) : null}
                  {expanded ? (
                    <div style={expandedShellStyle}>
                      {expandedLoading ? <LoadingState label="Loading pending sessions..." /> : null}
                      {expandedErr ? <ErrorState message={expandedErr} /> : null}
                      {!expandedLoading && !expandedErr && expandedRows.length === 0 ? (
                        <p style={{ opacity: 0.7, fontSize: "0.88em", margin: 0 }}>
                          No pending-review sessions for this job.
                        </p>
                      ) : null}
                      {expandedRows.length > 0 ? (
                        <>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <span style={{ color: "#64748b", fontSize: "0.84em" }}>
                              Top {expandedRows.length} pending session(s) · {selectedRows.length} selected
                            </span>
                            <button
                              type="button"
                              disabled={selectedRows.length === 0}
                              onClick={() => setBulkOpen(true)}
                            >
                              Bulk reject selected ({selectedRows.length})
                            </button>
                          </div>
                          <table style={{ width: "100%", fontSize: "0.85em", borderCollapse: "collapse" }}>
                            <thead>
                              <tr style={{ borderBottom: "1px solid rgba(0,0,0,0.15)" }}>
                                <th style={cellStyle}>
                                  <input
                                    type="checkbox"
                                    aria-label="Select all pending sessions"
                                    checked={expandedRows.length > 0 && selectedRows.length === expandedRows.length}
                                    onChange={(e) => {
                                      setSelected(
                                        e.target.checked
                                          ? new Set(expandedRows.map((row) => row.id))
                                          : new Set(),
                                      )
                                    }}
                                  />
                                </th>
                                <th style={cellStyle}>User</th>
                                <th style={cellStyle}>Claire terminal</th>
                                <th style={cellStyle}>Classification</th>
                                <th style={cellStyle}>Score</th>
                                <th style={cellStyle}>Review</th>
                              </tr>
                            </thead>
                            <tbody>
                              {expandedRows.map((row) => (
                                <tr key={row.id} style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
                                  <td style={cellStyle}>
                                    <input
                                      type="checkbox"
                                      aria-label={`Select ${row.id}`}
                                      checked={selected.has(row.id)}
                                      onChange={() => toggleSelected(row.id)}
                                    />
                                  </td>
                                  <td style={{ ...cellStyle, fontFamily: "monospace", fontSize: "0.85em" }}>
                                    <AdminUserLink userId={row.userId}>
                                      {row.userId?.slice(0, 8)}...
                                    </AdminUserLink>
                                  </td>
                                  <td style={cellStyle}>
                                    <Badge tone={terminalTone(row.terminal)}>
                                      {row.terminal ? `Claire ${row.terminal}` : "IN_PROGRESS"}
                                    </Badge>
                                  </td>
                                  <td style={cellStyle}>
                                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                                      <Badge tone={bucketTone(row.classification.bucket)}>
                                        {row.classification.label}
                                      </Badge>
                                      <EngagementBadge signal={row.review?.engagementSignal} />
                                    </div>
                                  </td>
                                  <td style={cellStyle}>{scorePercent(row)}</td>
                                  <td style={cellStyle}>
                                    <button type="button" onClick={() => setDrawerSessionId(row.id)}>
                                      Quick review
                                    </button>{" "}
                                    <AdminPrescreenSessionLink sessionId={row.id}>
                                      detail
                                    </AdminPrescreenSessionLink>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </Panel>

      {drawerSessionId ? (() => {
        // Queue = the expanded job's pending rows, in display order, so ← / →
        // and A=agree+next walk that job's review list.
        const queue = expandedRows.map((r) => ({ sessionId: r.id }))
        const queueIndex = queue.findIndex((q) => q.sessionId === drawerSessionId)
        return (
          <PrescreenReviewDrawer
            sessionId={drawerSessionId}
            queue={queue}
            index={queueIndex}
            onNavigate={(nextIndex) => {
              const next = queue[nextIndex]
              if (next) setDrawerSessionId(next.sessionId)
            }}
            onClose={() => setDrawerSessionId(null)}
            onReviewed={() => {
              setDrawerSessionId(null)
              refreshAfterReview()
            }}
          />
        )
      })() : null}
      {bulkOpen ? (
        <BulkRejectDrawer
          rows={selectedRows.map(toDrawerRow)}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false)
            setSelected(new Set())
            refreshAfterReview()
          }}
        />
      ) : null}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: "ok" | "warn" | "info" | "muted"
}) {
  const accent = {
    ok: "#15803d",
    warn: "#b91c1c",
    info: "#0369a1",
    muted: "#64748b",
  }[tone]
  return (
    <div style={{ ...statStyle, borderTopColor: accent }}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value.toLocaleString()}</div>
    </div>
  )
}

function segmentStyle(active: boolean, side: "left" | "right"): CSSProperties {
  return {
    padding: "0.35rem 0.8rem",
    fontSize: "0.85em",
    border: "1px solid #cbd5e1",
    borderRadius: side === "left" ? "6px 0 0 6px" : "0 6px 6px 0",
    marginLeft: side === "right" ? -1 : 0,
    background: active ? "#1e293b" : "transparent",
    color: active ? "#fff" : "inherit",
    cursor: "pointer",
  }
}

const statGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(125px, 1fr))",
  gap: 10,
}

const statStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderTop: "3px solid #64748b",
  borderRadius: 6,
  padding: "0.5rem 0.65rem",
  background: "#fff",
}

const statLabelStyle: CSSProperties = {
  color: "#64748b",
  fontSize: "0.75em",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
}

const statValueStyle: CSSProperties = {
  fontSize: "1.3em",
  fontWeight: 600,
}

const searchStyle: CSSProperties = {
  padding: "0.35rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.85em",
  minWidth: 200,
}

const jobCardStyle: CSSProperties = {
  border: "1px solid rgba(0,0,0,0.1)",
  borderRadius: 8,
  padding: 12,
  background: "#fff",
  display: "grid",
  gap: 10,
}

const expandedShellStyle: CSSProperties = {
  borderTop: "1px solid rgba(0,0,0,0.08)",
  paddingTop: 10,
  display: "grid",
  gap: 10,
}

const cellStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.35rem",
}
