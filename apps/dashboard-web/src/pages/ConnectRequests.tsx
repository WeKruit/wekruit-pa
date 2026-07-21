/**
 * /admin/connect-requests — the employer "Connect ATS / Slack / Import Pool"
 * fulfillment inbox (pa-employer-connect-requests).
 *
 * Each row is a managed-setup demand event from the employer onboarding wizard
 * (kind/provider/org/requester) OR a self-serve public-board preview audit
 * (status:"reqs_pulled", org, reqCount). The status dropdown advances the
 * fulfillment lifecycle requested → contacted → connected (or declined) via
 * paAdminConnectRequestSetStatus.
 *
 * Data: paAdminConnectRequestsList. Mutation: paAdminConnectRequestSetStatus.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"

const LIST_CALLABLE = "paAdminConnectRequestsList"
const SET_STATUS_CALLABLE = "paAdminConnectRequestSetStatus"

type ConnectRequestRow = {
  id: string
  kind?: string
  provider?: string
  orgName?: string
  requesterEmail?: string
  details?: string
  status?: string
  source?: string
  reqCount?: number
  statusBy?: string
  statusAt?: string
  statusNote?: string
  requestedAt?: string
}

type ListResult = {
  rows: ConnectRequestRow[]
  total: number
  truncated: boolean
  generatedAt: string
}

// Operator-settable fulfillment statuses. "reqs_pulled" (the self-serve board
// audit) is a read-only system status, not operator-settable, but is shown.
const SETTABLE_STATUSES = ["requested", "contacted", "connected", "declined"] as const
type SettableStatus = (typeof SETTABLE_STATUSES)[number]

const STATUS_FILTERS = ["all", "requested", "contacted", "connected", "declined", "reqs_pulled"] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

async function loadRequests(): Promise<ListResult> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable<Record<string, never>, ListResult>(firebase.functions(), LIST_CALLABLE)
  const result = await fn({})
  return result.data
}

async function setStatus(id: string, status: SettableStatus, note?: string): Promise<void> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable(firebase.functions(), SET_STATUS_CALLABLE)
  await fn({ id, status, ...(note ? { note } : {}) })
}

function statusTone(status?: string): "ok" | "warn" | "info" | "muted" {
  switch (status) {
    case "connected":
      return "ok"
    case "declined":
      return "warn"
    case "contacted":
    case "reqs_pulled":
      return "info"
    default:
      return "muted"
  }
}

function formatWhen(iso?: string): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export default function ConnectRequests() {
  const [data, setData] = useState<ListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>("all")

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    void loadRequests()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleSetStatus = useCallback(
    async (row: ConnectRequestRow, status: SettableStatus) => {
      const note =
        window.prompt(`Optional note for marking this request "${status}":`)?.trim() || undefined
      setBusyId(row.id)
      try {
        await setStatus(row.id, status, note)
        load()
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

  const rows = useMemo(() => {
    const all = data?.rows ?? []
    const filtered = filter === "all" ? all : all.filter((r) => (r.status ?? "requested") === filter)
    return [...filtered].sort((a, b) => (b.requestedAt ?? "").localeCompare(a.requestedAt ?? ""))
  }, [data, filter])

  if (loading) return <LoadingState label="Loading connect requests…" />
  if (error) return <ErrorState message={error} />

  return (
    <div className="page-stack">
      <PageHeader
        title="Connect requests"
        description="Employer onboarding 'Connect ATS / Slack / Import Pool' fulfillment inbox. Advance each managed-setup request requested → contacted → connected. 'reqs_pulled' rows are self-serve public-board previews (audit only)."
        actions={
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as StatusFilter)}
              style={{ padding: "0.3rem 0.6rem", borderRadius: 6, border: "1px solid var(--ink-6, #ccc)", fontSize: "0.85rem" }}
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "All statuses" : s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn--sm" onClick={load}>
              Refresh
            </button>
          </div>
        }
      />

      <Panel title={`${rows.length} request(s)${data?.truncated ? " · truncated (scan cap hit)" : ""}`}>
        {rows.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", opacity: 0.6 }}>No connect requests in this filter.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Provider</th>
                  <th>Org</th>
                  <th>Requester</th>
                  <th>Status</th>
                  <th>Requested</th>
                  <th>Set status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{row.kind ?? "—"}</div>
                      {row.reqCount !== undefined && (
                        <div style={{ fontSize: "0.75rem", opacity: 0.65 }}>{row.reqCount} reqs pulled</div>
                      )}
                    </td>
                    <td>{row.provider ?? "—"}</td>
                    <td>
                      <div>{row.orgName ?? "—"}</div>
                      {row.details && (
                        <div
                          style={{ fontSize: "0.75rem", opacity: 0.7, maxWidth: 280, whiteSpace: "pre-wrap" }}
                          title={row.details}
                        >
                          {row.details.length > 120 ? `${row.details.slice(0, 120)}…` : row.details}
                        </div>
                      )}
                    </td>
                    <td>{row.requesterEmail ?? "—"}</td>
                    <td>
                      <Badge tone={statusTone(row.status)}>{(row.status ?? "requested").replace(/_/g, " ")}</Badge>
                      {row.statusAt && (
                        <div style={{ fontSize: "0.72rem", opacity: 0.65 }}>
                          {formatWhen(row.statusAt)}
                          {row.statusBy ? ` · ${row.statusBy}` : ""}
                          {row.statusNote ? ` · ${row.statusNote}` : ""}
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatWhen(row.requestedAt)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <select
                        value=""
                        disabled={busyId === row.id}
                        onChange={(e) => {
                          const next = e.target.value as SettableStatus
                          if (next) void handleSetStatus(row, next)
                        }}
                        style={{ padding: "0.3rem 0.5rem", borderRadius: 6, border: "1px solid var(--ink-6, #ccc)", fontSize: "0.85rem" }}
                      >
                        <option value="">{busyId === row.id ? "Saving…" : "Set status…"}</option>
                        {SETTABLE_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
