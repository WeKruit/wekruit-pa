/**
 * Human review queue for pa-prescreen-sessions.
 *
 * Important semantics:
 * - `terminal` is Claire's proposed terminal recommendation.
 * - `terminalActionPendingReview=true` means no final employment-impacting
 *   action has been committed; only the neutral review-pending ack is allowed.
 *
 * Rows and header totals come from the `paAdminPrescreenOpsSnapshot` callable
 * (sessions + ops modes) — never from a client-side limit-75 Firestore scan.
 * The server classifies real/test candidates; queue/jobId scope the fetch,
 * everything else filters the fetched rows in-page.
 */
import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import type {
  PrescreenOpsSessionCursor,
  PrescreenOpsSessionRow,
  PrescreenOpsSnapshotOpsResponse,
} from "@pa/core-types"
import {
  AdminJobLink,
  AdminPrescreenSessionLink,
  AdminUserLink,
} from "../components/AdminEntityLink.js"
import {
  PrescreenReviewToolbar,
  StrictReviewBadge,
  type PrescreenBulkAction,
} from "../components/prescreen/PrescreenReviewControls.js"
import {
  BulkRejectDrawer,
  PrescreenReviewDrawer,
  reviewLabel,
  terminalTone,
  type Row,
} from "../components/prescreen/PrescreenReviewDrawers.js"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import {
  getPrescreenOpsSnapshot,
  listPrescreenSessionsPage,
  type PrescreenOpsSessionsPageInput,
} from "../lib/prescreen-ops-api.js"
import {
  classifyPrescreenReviewRow,
  filterAndSortPrescreenRows,
  summarizePrescreenReviewRows,
  type StrictReviewActionFilter,
  type StrictReviewBucket,
  type StrictReviewDraftFilter,
  type StrictReviewQueueFilter,
  type StrictReviewSort,
  type StrictReviewTerminalFilter,
} from "../lib/prescreen-review-ranking.js"

const PAGE_LIMIT = 100
const MAX_PAGES_PER_LOAD = 5
const LOAD_ALL_MAX_PAGES = 20

const QUEUE_PARAM_VALUES: readonly StrictReviewQueueFilter[] = ["all", "pending", "committed"]
const BUCKET_PARAM_VALUES: readonly StrictReviewBucket[] = [
  "all",
  "batch_reject",
  "individual_review",
  "hard_stop",
  "top_five_pass",
  "paused",
]
const TERMINAL_PARAM_VALUES: readonly StrictReviewTerminalFilter[] = [
  "all",
  "PASS",
  "FAIL",
  "HARD_STOP",
  "PAUSE",
  "IN_PROGRESS",
]

function paramValue<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

function syncSearchParam(params: URLSearchParams, key: string, value: string, defaultValue: string) {
  if (!value || value === defaultValue) params.delete(key)
  else params.set(key, value)
}

/**
 * Walk server pages until the target row count is reached or the cursor runs
 * out. A page can legitimately return fewer than `limit` rows (even 0) while
 * still having a nextCursor — committed/bucket/test exclusion are applied
 * in-memory within each server page.
 */
async function loadSessionPages(
  input: Omit<PrescreenOpsSessionsPageInput, "cursor">,
  cursor?: PrescreenOpsSessionCursor,
): Promise<{ rows: PrescreenOpsSessionRow[]; nextCursor: PrescreenOpsSessionCursor | null }> {
  const rows: PrescreenOpsSessionRow[] = []
  let next = cursor
  for (let page = 0; page < MAX_PAGES_PER_LOAD; page += 1) {
    const result = await listPrescreenSessionsPage({ ...input, ...(next ? { cursor: next } : {}) })
    rows.push(...result.rows)
    next = result.nextCursor
    if (!next || rows.length >= (input.limit ?? PAGE_LIMIT)) break
  }
  return { rows, nextCursor: next ?? null }
}

/**
 * Adapt a callable session row to the drawers' `Row` shape. The drawers stay
 * untouched; the only gaps are the non-optional `threshold`/`updatedAt` and
 * the loosely-typed review map.
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

function committedTotal(committed: { PASS: number; FAIL: number; HARD_STOP: number }): number {
  return committed.PASS + committed.FAIL + committed.HARD_STOP
}

export default function PrescreenSessionsList() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingAll, setLoadingAll] = useState(false)
  const [loadAllProgress, setLoadAllProgress] = useState<number | null>(null)
  const [loadAllCapped, setLoadAllCapped] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<PrescreenOpsSessionRow[]>([])
  const [nextCursor, setNextCursor] = useState<PrescreenOpsSessionCursor | null>(null)
  const [snapshot, setSnapshot] = useState<PrescreenOpsSnapshotOpsResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawerSessionId, setDrawerSessionId] = useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [bucketFilter, setBucketFilter] = useState<StrictReviewBucket>(
    () => paramValue(searchParams.get("bucket"), BUCKET_PARAM_VALUES, "all"),
  )
  const [queueFilter, setQueueFilter] = useState<StrictReviewQueueFilter>(
    () => paramValue(searchParams.get("queue"), QUEUE_PARAM_VALUES, "pending"),
  )
  const [terminalFilter, setTerminalFilter] = useState<StrictReviewTerminalFilter>(
    () => paramValue(searchParams.get("terminal"), TERMINAL_PARAM_VALUES, "all"),
  )
  const [actionFilter, setActionFilter] = useState<StrictReviewActionFilter>("all")
  const [draftFilter, setDraftFilter] = useState<StrictReviewDraftFilter>("all")
  const [sortMode, setSortMode] = useState<StrictReviewSort>("strict_priority")
  const [search, setSearch] = useState(() => searchParams.get("search") ?? "")
  const [includeTest, setIncludeTest] = useState(() => searchParams.get("includeTest") === "1")
  const [bulkAction, setBulkAction] = useState<PrescreenBulkAction>("reject")
  const jobIdParam = searchParams.get("jobId")?.trim() ?? ""

  useEffect(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      syncSearchParam(next, "queue", queueFilter, "pending")
      syncSearchParam(next, "bucket", bucketFilter, "all")
      syncSearchParam(next, "terminal", terminalFilter, "all")
      syncSearchParam(next, "search", search, "")
      syncSearchParam(next, "includeTest", includeTest ? "1" : "", "")
      return next
    }, { replace: true })
  }, [bucketFilter, includeTest, queueFilter, search, setSearchParams, terminalFilter])

  const sessionsInput = useMemo<Omit<PrescreenOpsSessionsPageInput, "cursor">>(
    () => ({
      ...(jobIdParam ? { jobId: jobIdParam } : {}),
      ...(includeTest ? { includeTest: true } : {}),
      queue: queueFilter,
      limit: PAGE_LIMIT,
    }),
    [includeTest, jobIdParam, queueFilter],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loaded = await getPrescreenOpsSnapshot(includeTest)
        if (!cancelled) setSnapshot(loaded)
      } catch {
        if (!cancelled) setSnapshot(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [includeTest, reloadKey])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        setErr(null)
        const result = await loadSessionPages(sessionsInput)
        if (cancelled) return
        setRows(result.rows)
        setNextCursor(result.nextCursor)
        setLoadAllCapped(false)
        setSelected((prev) => {
          const pendingIds = new Set(
            result.rows.filter((row) => row.terminalActionPendingReview === true).map((row) => row.id),
          )
          return new Set(Array.from(prev).filter((id) => pendingIds.has(id)))
        })
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey, sessionsInput])

  const pendingRows = useMemo(() => rows.filter((r) => r.terminalActionPendingReview === true), [rows])
  const reviewSummary = useMemo(() => summarizePrescreenReviewRows(rows), [rows])
  const visibleRows = useMemo(
    () => {
      const filtered = filterAndSortPrescreenRows(rows, {
        bucket: bucketFilter,
        sort: sortMode,
        search,
        queue: queueFilter,
        terminal: terminalFilter,
        action: actionFilter,
        draft: draftFilter,
      })
      return jobIdParam ? filtered.filter((r) => r.jobId === jobIdParam) : filtered
    },
    [actionFilter, bucketFilter, draftFilter, jobIdParam, queueFilter, rows, search, sortMode, terminalFilter],
  )
  const selectableVisibleRows = useMemo(
    () => visibleRows.filter((r) => r.terminalActionPendingReview === true),
    [visibleRows],
  )
  const selectedPendingRows = useMemo(
    () => pendingRows.filter((r) => selected.has(r.id)),
    [pendingRows, selected],
  )
  const allPendingSelected = selectableVisibleRows.length > 0 && selectableVisibleRows.every((r) => selected.has(r.id))
  const somePendingSelected = !allPendingSelected && selectableVisibleRows.some((r) => selected.has(r.id))

  const jobRollup = useMemo(
    () => (jobIdParam ? snapshot?.jobs.find((job) => job.jobId === jobIdParam) ?? null : null),
    [jobIdParam, snapshot],
  )
  const matchingTotal = useMemo(() => {
    if (jobIdParam) {
      if (!jobRollup) return null
      if (queueFilter === "pending") return jobRollup.pendingReview
      if (queueFilter === "committed") return committedTotal(jobRollup.committed)
      return includeTest ? jobRollup.sessionCount : jobRollup.realSessionCount
    }
    if (!snapshot) return null
    if (queueFilter === "pending") return snapshot.totals.pendingHumanReview
    if (queueFilter === "committed") return committedTotal(snapshot.totals.committed)
    return includeTest
      ? snapshot.totals.realSessions + snapshot.totals.testSessions
      : snapshot.totals.realSessions
  }, [includeTest, jobIdParam, jobRollup, queueFilter, snapshot])
  const panelCount = matchingTotal ?? (queueFilter === "pending" ? pendingRows.length : rows.length)
  const panelTitle = queueFilter === "pending"
    ? `${panelCount} pending review`
    : queueFilter === "committed"
      ? `${panelCount} committed`
      : `${panelCount} sessions`
  const panelEyebrow = [
    snapshot
      ? `${snapshot.totals.sessions} total sessions · ${snapshot.totals.realSessions} real`
      : `${rows.length} loaded`,
    nextCursor
      ? `showing first ${rows.length}${matchingTotal !== null ? ` of ${matchingTotal}` : ""} matching`
      : null,
  ].filter(Boolean).join(" · ")

  function toggleSelected(sessionId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  function refresh() {
    setReloadKey((key) => key + 1)
  }

  function clearJobIdParam() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete("jobId")
      return next
    }, { replace: true })
  }

  function selectVisible() {
    setSelected(new Set(selectableVisibleRows.map((row) => row.id)))
  }

  async function loadMore() {
    if (!nextCursor || loadingMore || loadingAll) return
    setLoadingMore(true)
    setErr(null)
    try {
      const result = await loadSessionPages(sessionsInput, nextCursor)
      setRows((prev) => [...prev, ...result.rows])
      setNextCursor(result.nextCursor)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  async function loadAll() {
    if (!nextCursor || loadingMore || loadingAll) return
    setLoadingAll(true)
    setErr(null)
    setLoadAllCapped(false)
    setLoadAllProgress(rows.length)
    try {
      let cursor: PrescreenOpsSessionCursor | null = nextCursor
      let total = rows.length
      let pages = 0
      while (cursor && pages < LOAD_ALL_MAX_PAGES) {
        const result = await listPrescreenSessionsPage({ ...sessionsInput, cursor })
        total += result.rows.length
        setRows((prev) => [...prev, ...result.rows])
        setLoadAllProgress(total)
        cursor = result.nextCursor ?? null
        pages += 1
      }
      setNextCursor(cursor)
      if (cursor) setLoadAllCapped(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingAll(false)
      setLoadAllProgress(null)
    }
  }

  function runBulkAction() {
    if (selectedPendingRows.length === 0) return
    if (bulkAction === "review") {
      setDrawerSessionId(selectedPendingRows[0]!.id)
      return
    }
    setBulkOpen(true)
  }

  function clearSelected() {
    setSelected(new Set())
  }

  if (loading && rows.length === 0 && !snapshot) return <LoadingState label="Loading sessions..." />
  if (err && rows.length === 0) return <ErrorState message={err} />

  return (
    <div>
      <PageHeader
        title="Prescreen Review Queue"
        description="Claire terminal is not a final candidate decision. PAUSE means low confidence to proceed; pending HITL rows require an operator-approved final message before any accept/reject outbound is queued."
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "#64748b", fontSize: "0.85em" }}>
              {selectedPendingRows.length} pending selected
            </span>
            <button type="button" onClick={refresh} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        }
      />
      {err ? <ErrorState message={err} /> : null}
      {jobIdParam ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "0 0 12px" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              border: "1px solid #cbd5e1",
              borderRadius: 999,
              padding: "0.2rem 0.6rem",
              fontSize: "0.85em",
              fontFamily: "monospace",
            }}
          >
            Job: {jobIdParam}
            <button
              type="button"
              onClick={clearJobIdParam}
              aria-label="Clear job filter"
              style={{ border: "none", background: "none", cursor: "pointer", padding: 0, fontSize: "1em" }}
            >
              ×
            </button>
          </span>
          {jobRollup ? (
            <span style={{ color: "#64748b", fontSize: "0.85em" }}>
              expected {jobRollup.sessionCount} session{jobRollup.sessionCount === 1 ? "" : "s"} (
              {jobRollup.realSessionCount} real · {jobRollup.testSessionCount} test)
            </span>
          ) : null}
        </div>
      ) : null}
      <Panel title={panelTitle} eyebrow={panelEyebrow}>
        <PrescreenReviewToolbar
          bucket={bucketFilter}
          queue={queueFilter}
          terminal={terminalFilter}
          action={actionFilter}
          draft={draftFilter}
          sort={sortMode}
          search={search}
          bulkAction={bulkAction}
          includeTest={includeTest}
          summary={reviewSummary}
          hasMore={nextCursor != null}
          visibleCount={visibleRows.length}
          selectedCount={selectedPendingRows.length}
          pendingVisibleCount={selectableVisibleRows.length}
          onBucketChange={setBucketFilter}
          onQueueChange={setQueueFilter}
          onIncludeTestChange={setIncludeTest}
          onTerminalChange={setTerminalFilter}
          onActionChange={setActionFilter}
          onDraftChange={setDraftFilter}
          onSortChange={setSortMode}
          onSearchChange={setSearch}
          onSelectVisible={selectVisible}
          onClearSelected={clearSelected}
          onBulkActionChange={setBulkAction}
          onRunBulkAction={runBulkAction}
        />
        {!loading && rows.length === 0 && (
          <p style={{ opacity: 0.7, fontSize: "0.9em" }}>
            No sessions yet. Trigger one: SMS{" "}
            <code>WeKruit_&lt;jobId&gt;_&lt;userId&gt;_Job</code> to the Sendblue number.
            See <Link to="/admin/job-prescreen">job prescreen config</Link> for jobIds.
          </p>
        )}
        {rows.length > 0 && visibleRows.length === 0 ? (
          <p style={{ opacity: 0.7, fontSize: "0.9em" }}>
            No review sessions match the current filter.
          </p>
        ) : null}
        {visibleRows.length > 0 && (
          <table style={{ width: "100%", fontSize: "0.85em", borderCollapse: "collapse", opacity: loading ? 0.5 : 1 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(0,0,0,0.15)" }}>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>
                  <input
                    type="checkbox"
                    aria-label="Select all pending review sessions"
                    checked={allPendingSelected}
                    ref={(node) => {
                      if (node) node.indeterminate = somePendingSelected
                    }}
                    onChange={(e) => {
                      setSelected(e.target.checked ? new Set(selectableVisibleRows.map((r) => r.id)) : new Set())
                    }}
                  />
                </th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Created</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Claire terminal</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Review recommendation</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Committed final</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Score</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Job</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>User</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Review</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                const ratio = r.scoreMax === 0 ? 0 : r.score / r.scoreMax
                const pending = r.terminalActionPendingReview === true
                const classification = classifyPrescreenReviewRow(r)
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
                    <td style={{ padding: "0.35rem" }}>
                      {pending ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.id}`}
                          checked={selected.has(r.id)}
                          onChange={() => toggleSelected(r.id)}
                        />
                      ) : null}
                    </td>
                    <td style={{ padding: "0.35rem", fontFamily: "monospace", fontSize: "0.85em" }}>
                      {r.createdAt?.slice(0, 16)}
                    </td>
                    <td style={{ padding: "0.35rem" }}>
                      <Badge tone={terminalTone(r.terminal)}>{r.terminal ? `Claire ${r.terminal}` : "IN_PROGRESS"}</Badge>
                    </td>
                    <td style={{ padding: "0.35rem" }}>
                      <div style={{ display: "grid", gap: 4 }}>
                        <StrictReviewBadge classification={classification} />
                        <span style={{ color: "#64748b", fontSize: "0.78em" }}>
                          {classification.reasons[0]}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "0.35rem" }}>
                      <Badge tone={pending ? "warn" : r.review?.finalTerminal ? terminalTone(r.review.finalTerminal) : "muted"}>
                        {reviewLabel(toDrawerRow(r))}
                      </Badge>
                    </td>
                    <td style={{ padding: "0.35rem" }}>
                      {r.score?.toFixed(2)}/{r.scoreMax?.toFixed(2)} ({(ratio * 100).toFixed(0)}%)
                    </td>
                    <td style={{ padding: "0.35rem", fontSize: "0.85em" }}>
                      <AdminJobLink jobId={r.jobId}>
                        {r.jobTitle ? `${r.jobTitle}${r.jobCompany ? ` · ${r.jobCompany}` : ""}` : r.jobId}
                      </AdminJobLink>
                    </td>
                    <td style={{ padding: "0.35rem", fontFamily: "monospace", fontSize: "0.75em" }}>
                      <AdminUserLink userId={r.userId}>{r.userId?.slice(0, 8)}...</AdminUserLink>
                      {includeTest && r.candidateClass !== "candidate_account" ? (
                        <>
                          {" "}
                          <Badge tone="muted">test</Badge>
                        </>
                      ) : null}
                    </td>
                    <td style={{ padding: "0.35rem" }}>
                      <button type="button" onClick={() => setDrawerSessionId(r.id)}>
                        Quick review
                      </button>{" "}
                      <AdminPrescreenSessionLink sessionId={r.id}>detail</AdminPrescreenSessionLink>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {nextCursor ? (
          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore || loadingAll}>
              {loadingMore ? "Loading more..." : "Load more"}
            </button>
            <button type="button" onClick={() => void loadAll()} disabled={loadingMore || loadingAll}>
              {loadingAll ? `loaded ${loadAllProgress ?? rows.length}…` : "Load all"}
            </button>
          </div>
        ) : null}
        {loadAllCapped ? (
          <p style={{ color: "#b45309", fontSize: "0.85em", marginTop: 8 }}>
            Load all stopped at the {LOAD_ALL_MAX_PAGES}-page safety cap with {rows.length} rows loaded — more
            sessions may remain. Click Load all again to continue.
          </p>
        ) : null}
      </Panel>

      {drawerSessionId ? (
        <PrescreenReviewDrawer
          sessionId={drawerSessionId}
          onClose={() => setDrawerSessionId(null)}
          onReviewed={() => {
            setDrawerSessionId(null)
            refresh()
          }}
        />
      ) : null}
      {bulkOpen ? (
        <BulkRejectDrawer
          rows={selectedPendingRows.map(toDrawerRow)}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false)
            setSelected(new Set())
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}
