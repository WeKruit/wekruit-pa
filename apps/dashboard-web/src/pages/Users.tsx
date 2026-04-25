import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { DataTable, EmptyState, ErrorState, PageHeader, StatusBadge } from "../components/ui.js"
import { db } from "../lib/firebase.js"

type Row = {
  id: string
  phoneE164?: string
  onboardingStatus?: string
  activeAgentId?: string
  createdAt?: string
  latestMessage?: string
  latestAt?: string
  lastError?: string
}

type AnyRow = Record<string, unknown> & { id: string }

export function Users() {
  const [rows, setRows] = useState<Row[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState("all")

  useEffect(() => {
    ;(async () => {
      try {
        const [userSnap, messageSnap, inboundSnap, outboundSnap, turnSnap] = await Promise.all([
          getDocs(query(collection(db(), PA_COLLECTIONS.users), limit(500))),
          getDocs(query(collection(db(), PA_COLLECTIONS.messages), orderBy("createdAt", "desc"), limit(500))),
          getDocs(query(collection(db(), PA_COLLECTIONS.inboundEvents), orderBy("createdAt", "desc"), limit(300))),
          getDocs(query(collection(db(), PA_COLLECTIONS.outbound), orderBy("createdAt", "desc"), limit(300))),
          getDocs(query(collection(db(), PA_COLLECTIONS.agentTurns), orderBy("createdAt", "desc"), limit(300))),
        ])
        const messages = messageSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as AnyRow[]
        const failures = [...inboundSnap.docs, ...outboundSnap.docs, ...turnSnap.docs]
          .map((d) => ({ id: d.id, ...d.data() }) as AnyRow)
          .filter((r) => r.status === "failed" || r.status === "dead_letter")
        const list = userSnap.docs.map((d) => {
          const row = { id: d.id, ...d.data() } as Row
          const latest = messages.find((m) => m.userId === row.id)
          const lastFailure = failures.find((f) => f.userId === row.id)
          return {
            ...row,
            latestMessage: typeof latest?.body === "string" ? latest.body : undefined,
            latestAt: typeof latest?.createdAt === "string" ? latest.createdAt : row.createdAt,
            lastError:
              typeof lastFailure?.lastError === "string"
                ? lastFailure.lastError
                : typeof lastFailure?.error === "string"
                  ? lastFailure.error
                  : undefined,
          }
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

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      const haystack = `${r.id} ${r.phoneE164 ?? ""} ${r.activeAgentId ?? ""} ${r.latestMessage ?? ""}`.toLowerCase()
      const matchesSearch = !q || haystack.includes(q)
      const matchesFilter =
        filter === "all" ||
        (filter === "error" && r.lastError) ||
        (filter === "active" && r.onboardingStatus === "active") ||
        (filter === "provisional" && r.onboardingStatus === "provisional")
      return matchesSearch && matchesFilter
    })
  }, [filter, rows, search])
  if (err) return <ErrorState message={err} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Conversation control"
        title="Conversations"
        description="Users and iMessage handles with their active agent and onboarding state."
      />
      <div className="toolbar">
        <input
          aria-label="Search conversations"
          placeholder="Search handle, agent, or latest message"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label="Filter conversations" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All conversations</option>
          <option value="active">Active</option>
          <option value="provisional">Provisional</option>
          <option value="error">Needs attention</option>
        </select>
      </div>
      {loading ? <div className="panel">Loading conversations...</div> : null}
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
              key: "phone",
              header: "Handle",
              render: (r) => <Link to={`/users/${r.id}`}>{r.phoneE164 || r.id}</Link>,
            },
            {
              key: "onboarding",
              header: "Onboarding",
              render: (r) => <StatusBadge value={r.onboardingStatus} />,
            },
            {
              key: "agent",
              header: "Active agent",
              render: (r) => r.activeAgentId || "default",
            },
            {
              key: "latest",
              header: "Latest",
              render: (r) => r.latestMessage || "—",
            },
            {
              key: "lastError",
              header: "Last error",
              render: (r) => r.lastError ? <span className="danger-text">{r.lastError}</span> : "—",
            },
          ]}
        />
      ) : null}
    </div>
  )
}
