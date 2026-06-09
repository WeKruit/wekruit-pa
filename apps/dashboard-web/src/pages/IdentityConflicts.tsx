import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentData,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from "firebase/firestore"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { AdminUserLink } from "../components/AdminEntityLink.js"
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
} from "../components/ui.js"
import { db } from "../lib/firebase.js"
import {
  getIdentityConflictCounts,
  resolveIdentityConflicts,
  type IdentityConflictResolveStatus,
  type IdentityConflictsCounts,
} from "../lib/identity-conflicts-api.js"
import { S2_IDENTITY_COLLECTIONS, compactValue } from "./CandidateMarketplace.helpers.js"

const PAGE_SIZE = 100
const STATUS_FILTERS = ["open", "resolved", "dismissed", "all"] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

type ConflictRow = {
  id: string
  kind?: string
  status?: string
  primaryCandidateId?: string
  competingCandidateId?: string
  handleKind?: string
  handleId?: string
  evidence?: Array<{ source?: string; summary?: string }>
  payloadRedacted?: Record<string, unknown>
  createdAt?: string
  resolvedAt?: string
  resolvedBy?: string
  resolutionNote?: string
}

type PairGroup = {
  pairKey: string
  candidateIds: string[]
  rows: ConflictRow[]
  handleKinds: Map<string, number>
  latestCreatedAt: string
  evidenceSummaries: string[]
  openCount: number
}

function rowStatus(row: ConflictRow): string {
  return row.status || "open"
}

function pairKeyFor(row: ConflictRow): string {
  const ids = [row.primaryCandidateId, row.competingCandidateId]
    .filter((id): id is string => Boolean(id))
    .sort()
  return ids.length > 0 ? ids.join("__") : "(no candidate pair)"
}

function groupByPair(rows: ConflictRow[]): PairGroup[] {
  const groups = new Map<string, PairGroup>()
  for (const row of rows) {
    const pairKey = pairKeyFor(row)
    let group = groups.get(pairKey)
    if (!group) {
      group = {
        pairKey,
        candidateIds: [row.primaryCandidateId, row.competingCandidateId]
          .filter((id): id is string => Boolean(id))
          .sort(),
        rows: [],
        handleKinds: new Map(),
        latestCreatedAt: "",
        evidenceSummaries: [],
        openCount: 0,
      }
      groups.set(pairKey, group)
    }
    group.rows.push(row)
    const handleKind = row.handleKind || "unknown"
    group.handleKinds.set(handleKind, (group.handleKinds.get(handleKind) ?? 0) + 1)
    if ((row.createdAt ?? "") > group.latestCreatedAt) group.latestCreatedAt = row.createdAt ?? ""
    for (const item of row.evidence ?? []) {
      const summary = typeof item?.summary === "string" ? item.summary.trim() : ""
      if (summary && !group.evidenceSummaries.includes(summary)) group.evidenceSummaries.push(summary)
    }
    if (rowStatus(row) === "open") group.openCount += 1
  }
  return [...groups.values()].sort((a, b) => b.latestCreatedAt.localeCompare(a.latestCreatedAt))
}

function countsHeader(counts: IdentityConflictsCounts | null): string {
  if (!counts) return "Loading counts..."
  const open = counts.byStatus.open ?? 0
  const dismissed = counts.byStatus.dismissed ?? 0
  const resolved = counts.byStatus.resolved ?? 0
  return `${open} open · ${dismissed} dismissed · ${resolved} resolved · ${counts.total} total`
}

export function IdentityConflicts() {
  const [searchParams, setSearchParams] = useSearchParams()
  const statusParam = (searchParams.get("status") ?? "open").toLowerCase()
  const statusFilter: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(statusParam)
    ? (statusParam as StatusFilter)
    : "open"

  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState<ConflictRow[]>([])
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [counts, setCounts] = useState<IdentityConflictsCounts | null>(null)
  const [countsErr, setCountsErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const refreshCounts = useCallback(async () => {
    try {
      setCountsErr(null)
      setCounts(await getIdentityConflictCounts())
    } catch (e: unknown) {
      setCountsErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const fetchPage = useCallback(
    async (filter: StatusFilter, after: QueryDocumentSnapshot<DocumentData> | null) => {
      const base = collection(db(), S2_IDENTITY_COLLECTIONS.identityConflicts)
      const constraints: QueryConstraint[] = filter === "all" ? [] : [where("status", "==", filter)]
      const afterConstraints: QueryConstraint[] = after ? [startAfter(after)] : []
      try {
        const snap = await getDocs(
          query(base, ...constraints, orderBy("createdAt", "desc"), ...afterConstraints, limit(PAGE_SIZE)),
        )
        return snap
      } catch (e: unknown) {
        // Filtered orderBy needs a composite index; fall back to the bare
        // status filter and sort client-side so the page stays usable.
        if (filter === "all") throw e
        return getDocs(query(base, ...constraints, ...afterConstraints, limit(PAGE_SIZE)))
      }
    },
    [],
  )

  const loadRows = useCallback(
    async (filter: StatusFilter, mode: "reset" | "more", after: QueryDocumentSnapshot<DocumentData> | null) => {
      if (mode === "reset") {
        setLoading(true)
        setErr(null)
      } else {
        setLoadingMore(true)
      }
      try {
        const snap = await fetchPage(filter, mode === "more" ? after : null)
        const page = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }) as ConflictRow)
        setRows((prev) => {
          const merged = mode === "reset" ? page : [...prev, ...page.filter((row) => !prev.some((p) => p.id === row.id))]
          return [...merged].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
        })
        setCursor(snap.docs.length > 0 ? snap.docs[snap.docs.length - 1]! : null)
        setHasMore(snap.docs.length === PAGE_SIZE)
        if (mode === "reset") {
          setSelected(new Set())
          setExpanded(new Set())
        }
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [fetchPage],
  )

  useEffect(() => {
    void loadRows(statusFilter, "reset", null)
  }, [statusFilter, loadRows])

  useEffect(() => {
    void refreshCounts()
  }, [refreshCounts])

  const groups = useMemo(() => groupByPair(rows), [rows])
  const browserUidIds = useMemo(
    () => rows.filter((row) => row.handleKind === "browser_uid").map((row) => row.id),
    [rows],
  )
  const statusTotal = useMemo(() => {
    if (!counts) return null
    return statusFilter === "all" ? counts.total : counts.byStatus[statusFilter] ?? 0
  }, [counts, statusFilter])
  const browserUidTotal = counts?.byHandleKind.browser_uid ?? null
  const browserUidPartial =
    hasMore && browserUidTotal !== null && browserUidTotal > browserUidIds.length

  function setStatusFilter(next: StatusFilter) {
    const params = new URLSearchParams(searchParams)
    if (next === "open") params.delete("status")
    else params.set("status", next)
    setSearchParams(params, { replace: true })
  }

  function toggleSelected(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  function toggleExpanded(pairKey: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(pairKey)) next.delete(pairKey)
      else next.add(pairKey)
      return next
    })
  }

  async function act(conflictIds: string[], status: IdentityConflictResolveStatus) {
    if (conflictIds.length === 0 || busy) return
    const note = window.prompt(
      `Optional note — ${status === "dismissed" ? "dismiss" : "resolve"} ${conflictIds.length} conflict${conflictIds.length === 1 ? "" : "s"}:`,
      "",
    )
    if (note === null) return
    setBusy(true)
    setActionErr(null)
    setActionMsg(null)
    try {
      const result = await resolveIdentityConflicts(conflictIds, status, note || undefined)
      setActionMsg(`Marked ${status}: ${result.updated} updated, ${result.skipped} skipped.`)
      setSelected(new Set())
      await Promise.all([refreshCounts(), loadRows(statusFilter, "reset", null)])
    } catch (e: unknown) {
      setActionErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading && rows.length === 0 && !err) return <LoadingState label="Loading identity conflicts..." />
  if (err && rows.length === 0) return <ErrorState message={err} />

  return (
    <div>
      <PageHeader
        eyebrow="S2 identity"
        title="Identity Conflicts"
        description="Operator queue for deterministic identity review items. Status changes go through the admin callable (client writes are rules-denied)."
      />
      <Panel title={countsHeader(counts)} eyebrow="pa-candidate-identity-conflicts">
        {countsErr ? <div className="notice notice-bad">Counts unavailable: {countsErr}</div> : null}
        {actionErr ? <div className="notice notice-bad">Action failed: {actionErr}</div> : null}
        {actionMsg ? <div className="notice notice-good">{actionMsg}</div> : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className={statusFilter === filter ? "button-active" : ""}
              onClick={() => setStatusFilter(filter)}
            >
              {filter === "all" ? "All" : filter[0]!.toUpperCase() + filter.slice(1)}
              {counts ? ` (${filter === "all" ? counts.total : counts.byStatus[filter] ?? 0})` : ""}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem" }}>
          <button
            type="button"
            disabled={busy || browserUidIds.length === 0}
            onClick={() => toggleSelected(browserUidIds, true)}
          >
            {browserUidPartial
              ? `Select loaded browser_uid (${browserUidIds.length} of ${browserUidTotal})`
              : `Select all browser_uid (${browserUidIds.length})`}
          </button>
          {browserUidPartial ? (
            <span style={{ color: "#64748b", fontSize: "0.85rem" }}>
              Load more to select the rest
            </span>
          ) : null}
          <button
            type="button"
            className="danger-button"
            disabled={busy || selected.size === 0}
            onClick={() => void act([...selected], "dismissed")}
          >
            Dismiss selected ({selected.size})
          </button>
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={() => void act([...selected], "resolved")}
          >
            Resolve selected ({selected.size})
          </button>
          {selected.size > 0 ? (
            <button type="button" disabled={busy} onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          ) : null}
          <span style={{ marginLeft: "auto", color: "#64748b", fontSize: "0.85rem" }}>
            {statusTotal !== null && rows.length < statusTotal
              ? `Showing first ${rows.length} of ${statusTotal} ${statusFilter === "all" ? "" : `${statusFilter} `}conflicts`
              : `${rows.length} conflict${rows.length === 1 ? "" : "s"} · ${groups.length} candidate pair${groups.length === 1 ? "" : "s"}`}
          </span>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            title="No identity conflicts"
            body={
              statusFilter === "all"
                ? "No identity conflict records are queued."
                : `No ${statusFilter} identity conflict records match this filter.`
            }
          />
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Candidate pair</th>
                  <th>Handles</th>
                  <th>Docs</th>
                  <th>Latest</th>
                  <th>Evidence</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const groupIds = group.rows.map((row) => row.id)
                  const allSelected = groupIds.every((id) => selected.has(id))
                  const isExpanded = expanded.has(group.pairKey)
                  return (
                    <GroupRows
                      key={group.pairKey}
                      group={group}
                      busy={busy}
                      allSelected={allSelected}
                      isExpanded={isExpanded}
                      selected={selected}
                      onToggleGroupSelect={(on) => toggleSelected(groupIds, on)}
                      onToggleRowSelect={(id, on) => toggleSelected([id], on)}
                      onToggleExpand={() => toggleExpanded(group.pairKey)}
                      onAct={(ids, status) => void act(ids, status)}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {hasMore ? (
          <div style={{ marginTop: "0.75rem" }}>
            <button
              type="button"
              disabled={loadingMore || busy}
              onClick={() => void loadRows(statusFilter, "more", cursor)}
            >
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          </div>
        ) : null}
      </Panel>
    </div>
  )
}

function GroupRows({
  group,
  busy,
  allSelected,
  isExpanded,
  selected,
  onToggleGroupSelect,
  onToggleRowSelect,
  onToggleExpand,
  onAct,
}: {
  group: PairGroup
  busy: boolean
  allSelected: boolean
  isExpanded: boolean
  selected: Set<string>
  onToggleGroupSelect: (on: boolean) => void
  onToggleRowSelect: (id: string, on: boolean) => void
  onToggleExpand: () => void
  onAct: (conflictIds: string[], status: IdentityConflictResolveStatus) => void
}) {
  const openIds = group.rows.filter((row) => rowStatus(row) === "open").map((row) => row.id)
  const actionIds = openIds.length > 0 ? openIds : group.rows.map((row) => row.id)
  return (
    <>
      <tr>
        <td>
          <input
            type="checkbox"
            checked={allSelected}
            disabled={busy}
            onChange={(event) => onToggleGroupSelect(event.target.checked)}
            aria-label="Select all conflicts in this pair"
          />
        </td>
        <td>
          {group.candidateIds.length > 0 ? (
            <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
              <AdminUserLink userId={group.candidateIds[0]!} />
              {group.candidateIds.length > 1 ? (
                <>
                  <span>↔</span>
                  <AdminUserLink userId={group.candidateIds[1]!} />
                </>
              ) : null}
            </span>
          ) : (
            "(no candidate pair)"
          )}
        </td>
        <td>
          <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0.3rem" }}>
            {[...group.handleKinds.entries()].map(([kind, count]) => (
              <Badge key={kind} tone={kind === "browser_uid" ? "muted" : "info"}>
                {kind}
                {count > 1 ? ` ×${count}` : ""}
              </Badge>
            ))}
          </span>
        </td>
        <td>
          {group.rows.length}
          {group.openCount > 0 && group.openCount < group.rows.length ? ` (${group.openCount} open)` : ""}
        </td>
        <td>{compactValue(group.latestCreatedAt)}</td>
        <td>{compactValue(group.evidenceSummaries.join(" | "), 240)}</td>
        <td>
          <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0.35rem" }}>
            <button type="button" disabled={busy} onClick={() => onAct(actionIds, "dismissed")}>
              Dismiss
            </button>
            <button type="button" disabled={busy} onClick={() => onAct(actionIds, "resolved")}>
              Resolve
            </button>
            <button type="button" onClick={onToggleExpand}>
              {isExpanded ? "Hide" : `Details (${group.rows.length})`}
            </button>
          </span>
        </td>
      </tr>
      {isExpanded
        ? group.rows.map((row) => (
            <tr key={row.id} style={{ background: "#fbf8f1" }}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  disabled={busy}
                  onChange={(event) => onToggleRowSelect(row.id, event.target.checked)}
                  aria-label={`Select conflict ${row.id}`}
                />
              </td>
              <td colSpan={2}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
                  <Badge tone="muted">{row.handleKind ?? "unknown"}</Badge>
                  <StatusBadge value={rowStatus(row)} />
                  <StatusBadge value={row.kind} />
                </div>
                <div style={{ color: "#64748b", fontSize: "0.8rem", marginTop: "0.25rem", overflowWrap: "anywhere" }}>
                  {row.primaryCandidateId ?? "-"} → {row.competingCandidateId ?? "-"}
                </div>
              </td>
              <td>{compactValue(row.id, 60)}</td>
              <td>{compactValue(row.createdAt)}</td>
              <td>
                {compactValue((row.evidence ?? []).map((item) => item?.summary).filter(Boolean).join(" | "), 240)}
                {row.resolvedAt ? (
                  <div style={{ color: "#64748b", fontSize: "0.8rem", marginTop: "0.25rem" }}>
                    {rowStatus(row)} {compactValue(row.resolvedAt)} by {row.resolvedBy ?? "-"}
                    {row.resolutionNote ? ` — ${compactValue(row.resolutionNote, 120)}` : ""}
                  </div>
                ) : null}
              </td>
              <td>
                <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0.35rem" }}>
                  <button type="button" disabled={busy} onClick={() => onAct([row.id], "dismissed")}>
                    Dismiss
                  </button>
                  <button type="button" disabled={busy} onClick={() => onAct([row.id], "resolved")}>
                    Resolve
                  </button>
                </span>
              </td>
            </tr>
          ))
        : null}
    </>
  )
}
