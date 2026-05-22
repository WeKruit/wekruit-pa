/**
 * Phase 32 Wave 2a — Conversations page row redesign.
 *
 * Replaced the flat `Latest` long-text + raw `Last error` column with operator
 * columns: Handle / Status / Risk / Last active / Agent / Needs action.
 *
 * - Risk is derived from pa-abuse-events (rate_limit → medium, allowlist_deny
 *   or injection → high) so operators can triage at a glance.
 * - Latest message moved to a tooltip on the Handle (1-line summary).
 * - Last error → "Needs action" button that links to the user detail page
 *   where the engineer drawer shows the raw error.
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, getDocs, limit, orderBy, query, where } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { DataTable, EmptyState, ErrorState, PageHeader, StatusBadge } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import { normalizePhoneLookup } from "./Users.helpers.js"

type RiskLevel = "low" | "medium" | "high"
type ConversationStatus = "active" | "idle" | "blocked" | "failed" | "provisional" | "unknown"

type Row = {
  id: string
  phoneE164?: string
  displayName?: string
  email?: string
  testMode?: boolean
  onboardingStatus?: string
  activeAgentId?: string
  createdAt?: string
  latestMessage?: string
  latestAt?: string
  lastError?: string
  status: ConversationStatus
  risk: RiskLevel
  needsAction?: { label: string; reason: string } | null
}

type AnyRow = Record<string, unknown> & { id: string }

function relativeTime(iso: string | undefined): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  const diffMs = Date.now() - t
  if (diffMs < 60_000) return "just now"
  const min = Math.floor(diffMs / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 14) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  return `${weeks}w ago`
}

function deriveStatus(row: { onboardingStatus?: string; lastError?: string; latestAt?: string }): ConversationStatus {
  if (row.lastError) return "failed"
  if (row.onboardingStatus === "blocked") return "blocked"
  if (row.onboardingStatus === "active") {
    // Idle if last activity > 7d ago.
    if (row.latestAt) {
      const t = Date.parse(row.latestAt)
      if (!Number.isNaN(t) && Date.now() - t > 7 * 24 * 3600_000) return "idle"
    }
    return "active"
  }
  if (row.onboardingStatus === "provisional") return "provisional"
  return "unknown"
}

function RiskBadge({ level }: { level: RiskLevel }) {
  const tone = level === "high" ? "bad" : level === "medium" ? "warn" : "good"
  return <span className={`status-badge ${tone}`}>{level}</span>
}

export function Users() {
  const [rows, setRows] = useState<Row[]>([])
  const [lookupRows, setLookupRows] = useState<Row[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState("all")
  const [showTest, setShowTest] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const [userSnap, messageSnap, inboundSnap, outboundSnap, turnSnap, abuseSnap] = await Promise.all([
          getDocs(query(collection(db(), PA_COLLECTIONS.users), limit(500))),
          getDocs(query(collection(db(), PA_COLLECTIONS.messages), orderBy("createdAt", "desc"), limit(500))),
          getDocs(query(collection(db(), PA_COLLECTIONS.inboundEvents), orderBy("createdAt", "desc"), limit(300))),
          getDocs(query(collection(db(), PA_COLLECTIONS.outbound), orderBy("createdAt", "desc"), limit(300))),
          getDocs(query(collection(db(), PA_COLLECTIONS.agentTurns), orderBy("createdAt", "desc"), limit(300))),
          getDocs(query(collection(db(), PA_COLLECTIONS.abuseEvents), orderBy("createdAt", "desc"), limit(500))).catch(() => null),
        ])
        const messages = messageSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as AnyRow[]
        const failures = [...inboundSnap.docs, ...outboundSnap.docs, ...turnSnap.docs]
          .map((d) => ({ id: d.id, ...d.data() }) as AnyRow)
          .filter((r) => r.status === "failed" || r.status === "dead_letter")

        // Build per-user abuse signal counts.
        const abuseByUser = new Map<string, { rateLimit: number; allowlistDeny: number; injection: number }>()
        if (abuseSnap) {
          for (const d of abuseSnap.docs) {
            const data = d.data() as { userId?: string; kind?: string }
            const uid = data.userId
            if (!uid) continue
            const slot = abuseByUser.get(uid) ?? { rateLimit: 0, allowlistDeny: 0, injection: 0 }
            const k = String(data.kind ?? "")
            if (k.includes("rate_limit") || k.includes("rateLimit")) slot.rateLimit++
            else if (k.includes("allowlist") || k.includes("deny")) slot.allowlistDeny++
            else if (k.includes("injection") || k.includes("prompt_injection")) slot.injection++
            abuseByUser.set(uid, slot)
          }
        }

        const list: Row[] = userSnap.docs.map((d) => {
          const raw = { id: d.id, ...d.data() } as Omit<Row, "status" | "risk" | "needsAction">
          const latest = messages.find((m) => m.userId === raw.id)
          const lastFailure = failures.find((f) => f.userId === raw.id)
          const lastError =
            typeof lastFailure?.lastError === "string"
              ? lastFailure.lastError
              : typeof lastFailure?.error === "string"
                ? lastFailure.error
                : undefined
          const partial = {
            ...raw,
            latestMessage: typeof latest?.body === "string" ? latest.body : undefined,
            latestAt: typeof latest?.createdAt === "string" ? latest.createdAt : raw.createdAt,
            lastError,
          }
          const status = deriveStatus(partial)
          const abuse = abuseByUser.get(raw.id) ?? { rateLimit: 0, allowlistDeny: 0, injection: 0 }
          const risk: RiskLevel =
            abuse.allowlistDeny > 0 || abuse.injection > 0
              ? "high"
              : abuse.rateLimit > 0
                ? "medium"
                : "low"
          let needsAction: Row["needsAction"] = null
          if (risk === "high") {
            needsAction = { label: "Approve allowlist", reason: "abuse: allowlist deny / injection" }
          } else if (lastError) {
            needsAction = { label: "Review error", reason: lastError }
          }
          return { ...partial, status, risk, needsAction }
        })
        list.sort(
          (a, b) =>
            String(b.latestAt || b.createdAt || "").localeCompare(String(a.latestAt || a.createdAt || ""), undefined, { numeric: true })
        )
        setRows(list.slice(0, 200))
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    const phone = normalizePhoneLookup(search)
    if (!phone) {
      setLookupRows([])
      setLookupLoading(false)
      return
    }
    if (rows.some((r) => r.phoneE164 === phone)) {
      setLookupRows([])
      setLookupLoading(false)
      return
    }
    let cancelled = false
    setLookupLoading(true)
    ;(async () => {
      try {
        const snap = await getDocs(query(collection(db(), PA_COLLECTIONS.users), where("phoneE164", "==", phone), limit(10)))
        if (cancelled) return
        setLookupRows(
          snap.docs.map((d) => {
            const raw = { id: d.id, ...d.data() } as Omit<Row, "status" | "risk" | "needsAction">
            const partial = {
              ...raw,
              latestAt: raw.createdAt,
            }
            return {
              ...partial,
              status: deriveStatus(partial),
              risk: "low" as RiskLevel,
              needsAction: null,
            }
          })
        )
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLookupLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [rows, search])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const normalizedPhone = normalizePhoneLookup(search)
    const merged = [...lookupRows, ...rows].filter((row, index, all) => all.findIndex((r) => r.id === row.id) === index)
    return merged.filter((r) => {
      // Hide test users by default (toggle to show)
      if (!showTest && r.testMode === true) return false
      const haystack = `${r.id} ${r.phoneE164 ?? ""} ${r.displayName ?? ""} ${r.email ?? ""} ${r.activeAgentId ?? ""} ${r.latestMessage ?? ""}`.toLowerCase()
      const matchesSearch = !q || haystack.includes(q) || (normalizedPhone !== null && r.phoneE164 === normalizedPhone)
      const matchesFilter =
        filter === "all" ||
        (filter === "needs_action" && r.needsAction) ||
        (filter === "high_risk" && r.risk === "high") ||
        (filter === "active" && r.status === "active") ||
        (filter === "provisional" && r.status === "provisional")
      return matchesSearch && matchesFilter
    })
  }, [filter, lookupRows, rows, search, showTest])
  if (err) return <ErrorState message={err} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Conversation control"
        title="Conversations"
        description="Operator view — handle, status, risk signal, last active, active agent, and any pending action per user."
      />
      <div className="toolbar">
        <input
          aria-label="Search conversations"
          placeholder="Search phone, name, email, user id, agent, or latest message"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label="Filter conversations" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All conversations</option>
          <option value="needs_action">Needs action</option>
          <option value="high_risk">High risk</option>
          <option value="active">Active</option>
          <option value="provisional">Provisional</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem" }}>
          <input
            type="checkbox"
            checked={showTest}
            onChange={(e) => setShowTest(e.target.checked)}
          />
          Show test users
        </label>
      </div>
      {loading ? <div className="panel">Loading conversations...</div> : null}
      {!loading && lookupLoading ? <div className="panel">Looking up phone number...</div> : null}
      {!loading ? (
        <DataTable
          rows={visible}
          empty={
            <EmptyState
              title={rows.length === 0 ? "No conversations yet" : "No conversations match this filter"}
              body={rows.length === 0 ? "Send a message to the Mac worker, then refresh this page to inspect the new conversation." : "Clear search or switch the filter back to all conversations."}
            />
          }
          columns={[
            {
              key: "handle",
              header: "Handle",
              render: (r) => {
                const display = r.phoneE164 || r.id
                const tooltip = r.latestMessage
                  ? `Latest: ${r.latestMessage.slice(0, 200)}${r.latestMessage.length > 200 ? "…" : ""}`
                  : "No messages yet"
                return (
                  <div>
                    <Link to={`/users/${r.id}`} title={tooltip}>
                      {display}
                    </Link>
                    <div style={{ fontSize: "0.78em", color: "#64748b", marginTop: 2 }}>
                      {r.displayName || r.email || r.id}
                    </div>
                  </div>
                )
              },
            },
            {
              key: "status",
              header: "Status",
              render: (r) => <StatusBadge value={r.status} />,
            },
            {
              key: "risk",
              header: "Risk",
              render: (r) => <RiskBadge level={r.risk} />,
            },
            {
              key: "lastActive",
              header: "Last active",
              render: (r) => (
                <span style={{ fontSize: "0.85em", color: "#475569" }}>{relativeTime(r.latestAt)}</span>
              ),
            },
            {
              key: "agent",
              header: "Agent",
              render: (r) => (
                <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
                  {r.activeAgentId || "default"}
                </span>
              ),
            },
            {
              key: "profile",
              header: "User info",
              render: (r) => (
                <Link
                  to={`/admin/candidates/${r.id}/profile`}
                  style={{
                    display: "inline-block",
                    padding: "2px 10px",
                    border: "1px solid #cbd5e1",
                    borderRadius: 999,
                    fontSize: "0.8em",
                    textDecoration: "none",
                    color: "#334155",
                  }}
                >
                  Profile
                </Link>
              ),
            },
            {
              key: "needsAction",
              header: "Needs action",
              render: (r) =>
                r.needsAction ? (
                  <Link
                    to={`/users/${r.id}`}
                    title={r.needsAction.reason}
                    style={{
                      display: "inline-block",
                      padding: "2px 10px",
                      background: "#fef3c7",
                      border: "1px solid #fde68a",
                      color: "#92400e",
                      borderRadius: 999,
                      fontSize: "0.8em",
                      textDecoration: "none",
                    }}
                  >
                    {r.needsAction.label}
                  </Link>
                ) : (
                  <span style={{ color: "#94a3b8" }}>—</span>
                ),
            },
          ]}
        />
      ) : null}
    </div>
  )
}
