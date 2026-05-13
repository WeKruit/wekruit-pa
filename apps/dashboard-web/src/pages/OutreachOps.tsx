import * as React from "react"
import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react"

import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import {
  OUTREACH_OPS_CALLABLE_NAME,
  OUTREACH_OPS_DEFAULT_LIMIT,
  buildOutreachOpsSnapshotRequest,
  formatCapacityUsage,
  formatCount,
  formatSafeText,
  formatScore,
  formatTimestamp,
  getBlockedRows,
  getFailureRows,
  getPendingReviewRows,
  statusTone,
  type OutreachOpsCapacitySnapshot,
  type OutreachOpsFilters,
  type OutreachOpsInviteRow,
  type OutreachOpsJobRow,
  type OutreachOpsSnapshot,
  type OutreachOpsSnapshotRequest,
} from "./OutreachOps.helpers.js"

type SnapshotLoader = (filters: OutreachOpsSnapshotRequest) => Promise<OutreachOpsSnapshot>

const STATUS_OPTIONS = [
  "",
  "draft",
  "blocked",
  "approved",
  "queued",
  "sent",
  "delivered",
  "failed",
  "dead_letter",
  "declined",
  "expired",
  "cancelled",
]

const APPROVAL_OPTIONS = ["", "not_required", "pending", "approved", "rejected"]

async function defaultSnapshotLoader(filters: OutreachOpsSnapshotRequest): Promise<OutreachOpsSnapshot> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable<OutreachOpsSnapshotRequest, OutreachOpsSnapshot>(
    firebase.functions(),
    OUTREACH_OPS_CALLABLE_NAME,
  )
  const result = await fn(filters)
  return result.data
}

export default function OutreachOps({
  loadSnapshot = defaultSnapshotLoader,
}: {
  loadSnapshot?: SnapshotLoader
}) {
  const [draft, setDraft] = useState<OutreachOpsFilters>({ limit: OUTREACH_OPS_DEFAULT_LIMIT })
  const [snapshot, setSnapshot] = useState<OutreachOpsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const request = buildOutreachOpsSnapshotRequest(draft)
    setLoading(true)
    setError(null)
    void loadSnapshot(request)
      .then((data) => {
        if (!cancelled) setSnapshot(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Initial snapshot only; filter submission below refreshes explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSnapshot])

  async function refresh(nextFilters: OutreachOpsFilters): Promise<void> {
    const request = buildOutreachOpsSnapshotRequest(nextFilters)
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
        eyebrow="v2.0 S6 / Admin"
        title="Outreach Ops"
        description="Invite readiness, review queues, Sendblue capacity, and delivery failures from the admin snapshot."
      />

      <Panel title="Filters" eyebrow="snapshot query">
        <form onSubmit={submit} style={filterGridStyle}>
          <label style={labelStyle}>
            <span>Job ID</span>
            <input
              value={draft.jobId ?? ""}
              onChange={(event) => setDraft({ ...draft, jobId: event.target.value })}
              placeholder="all jobs"
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            <span>Status</span>
            <select
              value={draft.status ?? ""}
              onChange={(event) => setDraft({ ...draft, status: event.target.value })}
              style={inputStyle}
            >
              {STATUS_OPTIONS.map((value) => (
                <option key={value || "any"} value={value}>{value || "any"}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            <span>Approval</span>
            <select
              value={draft.approvalState ?? ""}
              onChange={(event) => setDraft({ ...draft, approvalState: event.target.value })}
              style={inputStyle}
            >
              {APPROVAL_OPTIONS.map((value) => (
                <option key={value || "any"} value={value}>{value || "any"}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            <span>Limit</span>
            <input
              type="number"
              min={1}
              max={200}
              value={draft.limit ?? OUTREACH_OPS_DEFAULT_LIMIT}
              onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) })}
              style={inputStyle}
            />
          </label>
          <button type="submit" disabled={loading} style={buttonStyle(loading)}>
            {loading ? "Loading" : "Refresh"}
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
          <LoadingState label="Loading outreach ops snapshot..." />
        </Panel>
      ) : null}

      {snapshot ? <OutreachOpsSnapshotView snapshot={snapshot} /> : null}
    </div>
  )
}

export function OutreachOpsSnapshotView({ snapshot }: { snapshot: OutreachOpsSnapshot }) {
  const pendingRows = getPendingReviewRows(snapshot)
  const blockedRows = getBlockedRows(snapshot)
  const failureRows = getFailureRows(snapshot)

  return (
    <>
      <ViewPanel
        title="Outreach Ops Snapshot"
        eyebrow={`generated ${formatTimestamp(snapshot.generatedAt)}`}
      >
        <div style={metricGridStyle}>
          <Metric label="Total" value={formatCount(snapshot.summary.totalInvites)} />
          <Metric label="Pending Review" value={formatCount(snapshot.summary.pendingApproval)} tone="info" />
          <Metric label="Blocked" value={formatCount(snapshot.summary.blocked)} tone="warn" />
          <Metric label="Approved" value={formatCount(snapshot.summary.approved)} tone="ok" />
          <Metric label="Queued" value={formatCount(snapshot.summary.queued)} tone="ok" />
          <Metric label="Sent" value={formatCount(snapshot.summary.sent)} tone="ok" />
          <Metric label="Delivered" value={formatCount(snapshot.summary.delivered)} tone="ok" />
          <Metric label="Failures" value={formatCount(snapshot.summary.failed + snapshot.summary.deadLetter)} tone="warn" />
          <Metric label="Dry Run" value={formatCount(snapshot.summary.dryRun)} />
          <Metric label="Capacity Block" value={formatCount(snapshot.summary.capacityBlocked)} tone="warn" />
          <Metric label="Cooldown Block" value={formatCount(snapshot.summary.cooldownBlocked)} tone="info" />
          <Metric label="Opt-Out Block" value={formatCount(snapshot.summary.optOutBlocked)} tone="warn" />
        </div>
        <div style={filterSummaryStyle}>
          <Fact label="job" value={snapshot.filters.jobId ?? "all"} />
          <Fact label="status" value={snapshot.filters.status ?? "any"} />
          <Fact label="approval" value={snapshot.filters.approvalState ?? "any"} />
          <Fact label="limit" value={snapshot.filters.limit} />
        </div>
      </ViewPanel>

      <InviteSection
        title="Pending Review"
        eyebrow={`${pendingRows.length} invite(s)`}
        rows={pendingRows}
        emptyTitle="No pending review"
        emptyBody="No HITL approval rows in the current snapshot."
      >
        <ApprovalBatchStrip batches={snapshot.approvalBatches} />
      </InviteSection>
      <InviteSection
        title="Blocked"
        eyebrow={`${blockedRows.length} invite(s)`}
        rows={blockedRows}
        emptyTitle="No blocked invites"
        emptyBody="No policy-blocked or do-not-contact rows in the current snapshot."
      />
      <InviteSection
        title="Failures"
        eyebrow={`${failureRows.length} invite(s)`}
        rows={failureRows}
        emptyTitle="No failures"
        emptyBody="No failed or dead-letter rows in the current snapshot."
        showLastError
      />
      <CapacitySection rows={snapshot.capacity} />
      <JobsSection rows={snapshot.jobs} />
      <InviteSection
        title="Latest Invite Decisions"
        eyebrow={`${snapshot.invites.length} invite(s)`}
        rows={snapshot.invites}
        emptyTitle="No outreach decisions"
        emptyBody="The snapshot returned no invite decisions for these filters."
      />
    </>
  )
}

function InviteSection({
  title,
  eyebrow,
  rows,
  emptyTitle,
  emptyBody,
  showLastError,
  children,
}: {
  title: string
  eyebrow: string
  rows: OutreachOpsInviteRow[]
  emptyTitle: string
  emptyBody: string
  showLastError?: boolean
  children?: ReactNode
}) {
  return (
    <ViewPanel title={title} eyebrow={eyebrow}>
      {children}
      {rows.length === 0 ? (
        <ViewEmptyState title={emptyTitle} body={emptyBody} />
      ) : (
        <div style={rowStackStyle}>
          {rows.map((row) => (
            <InviteCard key={row.inviteId} row={row} showLastError={showLastError} />
          ))}
        </div>
      )}
    </ViewPanel>
  )
}

function InviteCard({ row, showLastError }: { row: OutreachOpsInviteRow; showLastError?: boolean }) {
  return (
    <article style={cardStyle}>
      <div style={cardHeaderStyle}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ overflowWrap: "anywhere" }}>
            {formatSafeText(row.candidateDisplayName || row.candidateId)} - {formatSafeText(row.jobTitle)} @ {formatSafeText(row.companyName)}
          </strong>
          <div style={mutedStyle}>
            invite {formatSafeText(row.inviteId)} - candidate {formatSafeText(row.candidateId)} - job {formatSafeText(row.jobId)}
          </div>
        </div>
        <div style={badgeRowStyle}>
          <StatusPill value={row.status} />
          <StatusPill value={row.policyDecision} />
          <StatusPill value={row.approvalState} />
          {row.dryRun ? <ViewBadge tone="muted">dry run</ViewBadge> : <ViewBadge tone="ok">live</ViewBadge>}
        </div>
      </div>
      <div style={factGridStyle}>
        <Fact label="score" value={formatScore(row.finalScore)} />
        <Fact label="recommended" value={row.recommendedAction ?? "-"} />
        <Fact label="match" value={row.matchId ?? "-"} />
        <Fact label="outbound" value={row.outboundId ?? "-"} />
        <Fact label="created" value={formatTimestamp(row.createdAt)} />
        <Fact label="updated" value={formatTimestamp(row.updatedAt)} />
        <Fact label="cooldown" value={formatTimestamp(row.cooldownUntil)} />
        <Fact label="group" value={row.stickyAccountGroupId ?? row.capacitySnapshot?.groupId ?? "-"} />
      </div>
      <div style={{ marginTop: 8 }}>
        <strong>Reason:</strong> {formatSafeText(row.decisionReason, 260)}
      </div>
      <SignalList values={row.blockedSignals} />
      {row.capacitySnapshot ? (
        <div style={mutedStyle}>
          Capacity {formatSafeText(row.capacitySnapshot.groupId)} - {formatSafeText(row.capacitySnapshot.status)} - {formatCapacityUsage(row.capacitySnapshot)}
        </div>
      ) : null}
      {showLastError && row.lastError ? (
        <div style={errorTextStyle}>
          <strong>Last error:</strong> {formatSafeText(row.lastError, 260)}
        </div>
      ) : null}
    </article>
  )
}

function SignalList({ values }: { values: string[] }) {
  if (!values || values.length === 0) return null
  return (
    <div style={mutedStyle}>
      <strong>Signals:</strong> {formatSafeText(values, 260)}
    </div>
  )
}

function CapacitySection({ rows }: { rows: OutreachOpsCapacitySnapshot[] }) {
  return (
    <ViewPanel title="Capacity" eyebrow={`${rows.length} group(s)`}>
      {rows.length === 0 ? (
        <ViewEmptyState title="No capacity snapshot" body="No Sendblue capacity evidence in the current invite window." />
      ) : (
        <div style={capacityGridStyle}>
          {rows.map((row) => (
            <article key={row.groupId} style={cardStyle}>
              <div style={cardHeaderStyle}>
                <strong>{formatSafeText(row.groupId)}</strong>
                <StatusPill value={row.status} />
              </div>
              <div style={factGridStyle}>
                <Fact label="usage" value={formatCapacityUsage(row)} />
                <Fact label="rolling 24h" value={row.rolling24hUsed ?? "-"} />
                <Fact label="checked" value={formatTimestamp(row.checkedAt)} />
              </div>
              {row.reason ? <div style={mutedStyle}>{formatSafeText(row.reason, 220)}</div> : null}
            </article>
          ))}
        </div>
      )}
    </ViewPanel>
  )
}

type JobTableRow = OutreachOpsJobRow & { id: string }

const jobColumns: Array<{ key: string; header: string; render: (row: JobTableRow) => ReactNode }> = [
  { key: "job", header: "Job", render: (row) => formatSafeText(row.jobTitle) },
  { key: "company", header: "Company", render: (row) => formatSafeText(row.companyName) },
  { key: "jobId", header: "Job ID", render: (row) => formatSafeText(row.jobId) },
  { key: "pending", header: "Pending", render: (row) => formatCount(row.pendingInvites) },
  { key: "blocked", header: "Blocked", render: (row) => formatCount(row.blockedInvites) },
  { key: "queued", header: "Queued", render: (row) => formatCount(row.queuedInvites) },
]

function JobsSection({ rows }: { rows: OutreachOpsJobRow[] }) {
  return (
    <ViewPanel title="Jobs" eyebrow={`${rows.length} job(s)`}>
      <ViewTable<JobTableRow>
        rows={rows.map((row) => ({ ...row, id: row.jobId }))}
        columns={jobColumns}
        empty={<ViewEmptyState title="No job rows" body="The snapshot returned no grouped job rows for these filters." />}
      />
    </ViewPanel>
  )
}

function ApprovalBatchStrip({
  batches,
}: {
  batches: Array<{ batchId: string; pendingInvites: number; createdAt: string }>
}) {
  if (batches.length === 0) return null
  return (
    <div style={batchStripStyle}>
      {batches.map((batch) => (
        <div key={batch.batchId} style={batchItemStyle}>
          <strong>{formatSafeText(batch.batchId)}</strong>
          <span>{formatCount(batch.pendingInvites)} pending</span>
          <span>{formatTimestamp(batch.createdAt)}</span>
        </div>
      ))}
    </div>
  )
}

function Metric({
  label,
  value,
  tone = "muted",
}: {
  label: string
  value: string
  tone?: "ok" | "warn" | "info" | "muted"
}) {
  const accent = {
    ok: "#15803d",
    warn: "#b91c1c",
    info: "#0369a1",
    muted: "#64748b",
  }[tone]
  return (
    <div style={{ ...metricStyle, borderTopColor: accent }}>
      <div style={metricLabelStyle}>{label}</div>
      <div style={metricValueStyle}>{value}</div>
    </div>
  )
}

function StatusPill({ value }: { value?: string }) {
  return <ViewBadge tone={statusTone(value)}>{formatSafeText(value)}</ViewBadge>
}

function Fact({ label, value }: { label: string; value: unknown }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={factLabelStyle}>{label}</div>
      <div style={factValueStyle}>{formatSafeText(value, 180)}</div>
    </div>
  )
}

function ViewPanel({
  title,
  eyebrow,
  children,
}: {
  title: string
  eyebrow?: string
  children: ReactNode
}) {
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h2>{title}</h2>
        </div>
      </div>
      {children}
    </section>
  )
}

function ViewEmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  )
}

function ViewBadge({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "info" | "muted"
  children: ReactNode
}) {
  const cls = tone === "ok" ? "good" : tone === "warn" ? "bad" : tone === "info" ? "warn" : "muted"
  return <span className={`status-badge ${cls}`}>{children}</span>
}

function ViewTable<T extends { id: string | number }>({
  rows,
  columns,
  empty,
}: {
  rows: T[]
  columns: Array<{ key: string; header: string; render: (row: T) => ReactNode }>
  empty: ReactNode
}) {
  if (rows.length === 0) return <>{empty}</>
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function buttonStyle(disabled: boolean): CSSProperties {
  return {
    alignSelf: "end",
    padding: "0.5rem 0.9rem",
    border: "none",
    borderRadius: 6,
    background: disabled ? "#94a3b8" : "#1a73e8",
    color: "white",
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
  }
}

const filterGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 1.5fr) repeat(3, minmax(130px, 1fr)) auto",
  gap: 10,
  alignItems: "end",
}

const labelStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  color: "#475569",
  fontSize: "0.82em",
  fontWeight: 700,
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.65rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  color: "#0f172a",
  background: "white",
  fontFamily: "inherit",
}

const metricGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(125px, 1fr))",
  gap: 10,
}

const metricStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderTop: "3px solid #64748b",
  borderRadius: 6,
  padding: "0.7rem 0.75rem",
  background: "#fff",
}

const metricLabelStyle: CSSProperties = {
  color: "#64748b",
  fontSize: "0.72em",
  textTransform: "uppercase",
}

const metricValueStyle: CSSProperties = {
  color: "#0f172a",
  fontSize: "1.22em",
  fontWeight: 750,
  marginTop: 3,
}

const filterSummaryStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
  gap: 10,
  marginTop: 14,
}

const rowStackStyle: CSSProperties = {
  display: "grid",
  gap: 10,
}

const capacityGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 10,
}

const cardStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: 12,
  background: "#fff",
  fontSize: "0.9em",
}

const cardHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 10,
}

const badgeRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  flexWrap: "wrap",
  gap: 6,
}

const factGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
  gap: 8,
  marginTop: 10,
}

const factLabelStyle: CSSProperties = {
  color: "#64748b",
  fontSize: "0.72em",
  textTransform: "uppercase",
}

const factValueStyle: CSSProperties = {
  color: "#0f172a",
  fontSize: "0.92em",
  overflowWrap: "anywhere",
}

const mutedStyle: CSSProperties = {
  color: "#64748b",
  marginTop: 5,
}

const errorTextStyle: CSSProperties = {
  color: "#991b1b",
  marginTop: 8,
}

const batchStripStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 10,
}

const batchItemStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: "0.45rem 0.6rem",
  background: "#f8fafc",
  color: "#334155",
  fontSize: "0.86em",
}
