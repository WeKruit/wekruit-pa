/**
 * Phase 23 BETA-03 — Abuse events panel.
 *
 * Reads pa_abuse_events ordered by createdAt desc (last 50).
 * Filter chips: all | rate_limited | prompt_injection | allowlist_deny.
 * Mark-resolved: writes resolvedAt, resolvedBy (operator email), resolutionNote.
 * Resolved rows shown with strikethrough + "Resolved by X".
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import { getAuth } from "firebase/auth"
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  updateDoc,
} from "firebase/firestore"
import { useEffect, useState } from "react"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
  type DataTableColumn,
} from "../components/ui.js"
import { db, getFirebaseApp } from "../lib/firebase.js"

type AbuseRow = {
  id: string
  kind: string
  createdAt: string
  userId?: string
  contactHandle?: string
  channel?: string
  signals?: string[]
  message?: string
  resolvedAt?: string
  resolvedBy?: string
  resolutionNote?: string
}

type KindFilter = "all" | "rate_limited" | "prompt_injection" | "allowlist_deny"

const KIND_FILTER_LABELS: Record<KindFilter, string> = {
  all: "All",
  rate_limited: "Rate Limited",
  prompt_injection: "Injection",
  allowlist_deny: "Allowlist Deny",
}

function kindBadgeColor(kind: string): string {
  if (kind === "prompt_injection" || kind === "prompt_injection_signal") return "bad"
  if (kind === "rate_limited") return "warn"
  return "muted"
}

function truncate(value: unknown, max = 120): string {
  if (value == null) return "—"
  const s = Array.isArray(value) ? value.join(", ") : String(value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function Abuse() {
  const [rows, setRows] = useState<AbuseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<KindFilter>("all")
  const [resolving, setResolving] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const snap = await getDocs(
        query(
          collection(db(), PA_COLLECTIONS.abuseEvents),
          orderBy("createdAt", "desc"),
          limit(50)
        )
      )
      setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AbuseRow, "id">) })))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function markResolved(row: AbuseRow) {
    const note = window.prompt(`Resolution note for ${row.id} (optional):`) ?? ""
    const currentUser = getAuth(getFirebaseApp()).currentUser
    const resolvedBy = currentUser?.email ?? "unknown"
    setResolving(row.id)
    try {
      await updateDoc(doc(db(), PA_COLLECTIONS.abuseEvents, row.id), {
        resolvedAt: new Date().toISOString(),
        resolvedBy,
        resolutionNote: note || null,
      })
      await load()
    } catch (e) {
      alert(`Failed to mark resolved: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setResolving(null)
    }
  }

  const visible = filter === "all" ? rows : rows.filter((r) => r.kind === filter)

  const columns: DataTableColumn<AbuseRow>[] = [
    {
      key: "createdAt",
      header: "Created",
      render: (r) => (
        <span style={{ whiteSpace: "nowrap", fontSize: "0.85em" }}>
          {r.createdAt?.slice(0, 19).replace("T", " ") ?? "—"}
        </span>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      render: (r) => (
        <span className={`status-badge ${kindBadgeColor(r.kind)}`}>{r.kind}</span>
      ),
    },
    {
      key: "userId",
      header: "User / Handle",
      render: (r) => (
        <span style={{ fontSize: "0.85em" }}>
          {truncate(r.contactHandle ?? r.userId, 40)}
        </span>
      ),
    },
    {
      key: "channel",
      header: "Channel",
      render: (r) => <StatusBadge value={r.channel} />,
    },
    {
      key: "signals",
      header: "Signals",
      render: (r) => (
        <span style={{ fontSize: "0.8em", color: "#64748b" }}>{truncate(r.signals, 100)}</span>
      ),
    },
    {
      key: "resolved",
      header: "Status",
      render: (r) =>
        r.resolvedAt ? (
          <span style={{ textDecoration: "line-through", color: "#94a3b8", fontSize: "0.85em" }}>
            Resolved by {r.resolvedBy?.split("@")[0]}
          </span>
        ) : (
          <button
            type="button"
            disabled={resolving === r.id}
            onClick={() => void markResolved(r)}
            style={{ fontSize: "0.8em" }}
          >
            {resolving === r.id ? "Saving…" : "Mark resolved"}
          </button>
        ),
    },
  ]

  if (loading) return <LoadingState label="Loading abuse events…" />
  if (err) return <ErrorState message={err} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Beta safety"
        title="Abuse Events"
        description="Last 50 pa_abuse_events ordered by newest first. Mark resolved to annotate and track remediation."
        actions={
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        }
      />

      {/* Filter chips */}
      <div className="toolbar">
        {(Object.keys(KIND_FILTER_LABELS) as KindFilter[]).map((k) => (
          <button
            key={k}
            type="button"
            className={filter === k ? "button-active" : ""}
            onClick={() => setFilter(k)}
          >
            {KIND_FILTER_LABELS[k]}
            {k === "all" ? ` (${rows.length})` : ` (${rows.filter((r) => r.kind === k).length})`}
          </button>
        ))}
      </div>

      <Panel title={`${visible.length} event${visible.length !== 1 ? "s" : ""}`}>
        <DataTable
          rows={visible}
          columns={columns}
          empty={
            <EmptyState
              title="No events"
              body={filter === "all" ? "No abuse events recorded yet." : `No ${filter} events.`}
            />
          }
        />
      </Panel>
    </div>
  )
}
