import { PA_COLLECTIONS } from "@pa/core-types"
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  updateDoc,
  where,
} from "firebase/firestore"
import { useMemo, useState, useEffect, type ReactNode } from "react"
import { ErrorState, PageHeader, StatusBadge } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import { renderToolCallSummary } from "./toolCallSummary.js"

type Row = Record<string, unknown> & { id: string }

function asText(v: unknown): string {
  if (v == null || v === "") return "—"
  if (typeof v === "string") return v
  return JSON.stringify(v)
}

function cell(v: unknown, max = 180) {
  const text = asText(v)
  return text.length > max ? `${text.slice(0, max)}…` : text
}


async function loadRows(collectionName: string, max = 50, orderField = "createdAt"): Promise<Row[]> {
  const snap = await getDocs(
    query(collection(db(), collectionName), orderBy(orderField, "desc"), limit(max))
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

async function loadQueueRows(): Promise<{ inbound: Row[]; outbound: Row[] }> {
  const [inbound, outbound] = await Promise.all([
    getDocs(query(collection(db(), PA_COLLECTIONS.inboundEvents), orderBy("createdAt", "desc"), limit(50))),
    getDocs(query(collection(db(), PA_COLLECTIONS.outbound), orderBy("createdAt", "desc"), limit(50))),
  ])
  return {
    inbound: inbound.docs.map((d) => ({ id: d.id, ...d.data() })),
    outbound: outbound.docs.map((d) => ({ id: d.id, ...d.data() })),
  }
}

export function Operations() {
  const [inbound, setInbound] = useState<Row[]>([])
  const [outbound, setOutbound] = useState<Row[]>([])
  const [turns, setTurns] = useState<Row[]>([])
  const [toolCalls, setToolCalls] = useState<Row[]>([])
  const [auditEvents, setAuditEvents] = useState<Row[]>([])
  const [abuseEvents, setAbuseEvents] = useState<Row[]>([])
  const [memoryEvents, setMemoryEvents] = useState<Row[]>([])
  const [scheduledJobs, setScheduledJobs] = useState<Row[]>([])
  const [heartbeats, setHeartbeats] = useState<Row[]>([])
  const [pipelineRuns, setPipelineRuns] = useState<Row[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState("inbound")
  const [statusFilter, setStatusFilter] = useState("all")

  async function loadAll() {
    setErr(null)
    setBusy(true)
    try {
      const [queues, t, tools, audit, abuse, memory, jobs, hb, pipeline] = await Promise.all([
        loadQueueRows(),
        loadRows(PA_COLLECTIONS.agentTurns),
        loadRows(PA_COLLECTIONS.toolCalls),
        loadRows(PA_COLLECTIONS.auditEvents),
        loadRows(PA_COLLECTIONS.abuseEvents),
        loadRows(PA_COLLECTIONS.memoryEvents),
        loadRows(PA_COLLECTIONS.scheduledJobs, 50, "dueAt"),
        loadRows(PA_COLLECTIONS.runtimeHeartbeats, 50, "lastSeenAt"),
        // v1.5 Stream-A2: Phase 47.1 — daily-update pipeline runs
        loadRows("pa-matching-pipeline-runs", 30, "createdAt"),
      ])
      setInbound(queues.inbound)
      setOutbound(queues.outbound)
      setTurns(t)
      setToolCalls(tools)
      setAuditEvents(audit)
      setAbuseEvents(abuse)
      setMemoryEvents(memory)
      setScheduledJobs(jobs)
      setHeartbeats(hb)
      setPipelineRuns(pipeline)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  async function retryInbound(id: string) {
    const reason = window.prompt("Why is this inbound safe to retry?")
    if (!reason) return
    await updateDoc(doc(db(), PA_COLLECTIONS.inboundEvents, id), {
      status: "pending",
      claimedBy: null,
      leaseUntil: null,
      operatorReason: reason,
      updatedAt: new Date().toISOString(),
    })
    await loadAll()
  }

  async function deadLetterInbound(id: string) {
    const reason = window.prompt("Why should this inbound be dead-lettered?")
    if (!reason) return
    await updateDoc(doc(db(), PA_COLLECTIONS.inboundEvents, id), {
      status: "dead_letter",
      deadLetterReason: reason,
      claimedBy: null,
      leaseUntil: null,
      updatedAt: new Date().toISOString(),
    })
    await loadAll()
  }

  async function retryOutbound(id: string) {
    const reason = window.prompt("Why is this outbound safe to retry?")
    if (!reason) return
    await updateDoc(doc(db(), PA_COLLECTIONS.outbound, id), {
      status: "pending",
      error: null,
      operatorReason: reason,
      updatedAt: new Date().toISOString(),
    })
    await loadAll()
  }

  const sections = useMemo(
    () => ({
      inbound,
      outbound,
      turns,
      connectors: toolCalls,
      audit: auditEvents,
      abuse: abuseEvents,
      memory: memoryEvents,
      jobs: scheduledJobs,
      heartbeats,
      pipelineRuns,
    }),
    [abuseEvents, auditEvents, heartbeats, inbound, memoryEvents, outbound, pipelineRuns, scheduledJobs, toolCalls, turns]
  )

  const activeRows = sections[tab as keyof typeof sections] ?? []
  const visibleRows =
    statusFilter === "all" ? activeRows : activeRows.filter((r) => String(r.status ?? r.kind) === statusFilter)

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Queue and safety"
        title="Operations"
        description="Debug queues, turns, connector calls, safety signals, and memory events without tailing logs."
        actions={<button type="button" disabled={busy} onClick={() => void loadAll()}>{busy ? "Refreshing..." : "Refresh"}</button>}
      />
      {err ? <ErrorState message={err} /> : null}
      <SafetyEventsTile abuseEvents={abuseEvents} />
      <PipelineHealthBanner runs={pipelineRuns} />
      <div className="toolbar">
        {Object.keys(sections).map((key) => (
          <button key={key} className={tab === key ? "button-active" : ""} type="button" onClick={() => setTab(key)}>
            {key} ({sections[key as keyof typeof sections].length})
          </button>
        ))}
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="pending">pending</option>
          <option value="processing">processing</option>
          <option value="failed">failed</option>
          <option value="dead_letter">dead_letter</option>
          <option value="completed">completed</option>
          <option value="sent">sent</option>
          <option value="safety_block">safety_block</option>
        </select>
      </div>

      {tab === "inbound" ? (
        <InboundTable rows={visibleRows} retryInbound={retryInbound} deadLetterInbound={deadLetterInbound} />
      ) : tab === "outbound" ? (
        <OutboundTable rows={visibleRows} retryOutbound={retryOutbound} />
      ) : (
        <Section title={tab} rows={visibleRows} columns={columnsFor(tab)} />
      )}
    </div>
  )
}

function columnsFor(tab: string) {
  if (tab === "turns") return ["createdAt", "status", "userId", "sessionId", "agentId", "lastError"]
  if (tab === "connectors") return ["startedAt", "status", "connectorName", "policyDecision", "resultSummary", "error"]
  if (tab === "audit") return ["createdAt", "kind", "actor", "userId", "message"]
  if (tab === "abuse") return ["createdAt", "kind", "userId", "channel", "message"]
  if (tab === "jobs") return ["dueAt", "status", "kind", "attemptCount", "lastError"]
  if (tab === "heartbeats") return ["lastSeenAt", "status", "kind", "runtimeId"]
  if (tab === "pipelineRuns") return ["createdAt", "status", "jobsScraped", "jobsNew", "jobsUpdated", "jobsErrored", "costUsd", "sourceRepos", "error"]
  return ["createdAt", "kind", "userId", "mem0UserId", "message"]
}

function InboundTable({
  rows,
  retryInbound,
  deadLetterInbound,
}: {
  rows: Row[]
  retryInbound: (id: string) => Promise<void>
  deadLetterInbound: (id: string) => Promise<void>
}) {
  return (
    <Section
      title="Inbound queue"
      rows={rows}
      columns={["createdAt", "status", "userId", "sessionId", "rawPayload", "lastError", "actions"]}
      actions={(r) => (
        <>
          <button type="button" onClick={() => void retryInbound(r.id)}>Retry</button>{" "}
          <button type="button" onClick={() => void deadLetterInbound(r.id)}>Dead-letter</button>
        </>
      )}
    />
  )
}

function OutboundTable({
  rows,
  retryOutbound,
}: {
  rows: Row[]
  retryOutbound: (id: string) => Promise<void>
}) {
  return (
    <Section
      title="Outbound queue"
      rows={rows}
      columns={["createdAt", "status", "userId", "toE164", "body", "error", "actions"]}
      actions={(r) => <button type="button" onClick={() => void retryOutbound(r.id)}>Retry</button>}
    />
  )
}

function Section({ title, rows, columns, actions }: { title: string; rows: Row[]; columns: string[]; actions?: (row: Row) => ReactNode }) {
  return (
    <>
      <h2>{title}</h2>
      <table>
        <thead>
          <tr>
            {columns.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {columns.map((c) => (
                <td key={c}>
                  {c === "actions" ? actions?.(r) : c === "status" || c === "kind" ? <StatusBadge value={String(r[c] ?? "")} /> : c === "resultSummary" ? cell(renderToolCallSummary(r), 360) : cell(r[c], c === "message" || c === "rawPayload" ? 360 : 120)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

// v1.5 Stream-A2 / Phase 47.1 — Mac mini daily-update health tile.
// GREEN if last success < 24h, AMBER 24-36h, RED > 36h.
function PipelineHealthBanner({ runs }: { runs: Row[] }) {
  const lastSuccess = runs.find((r) => r.status === "success")
  if (!lastSuccess) {
    return (
      <div style={{ padding: 12, borderRadius: 8, background: "#fee", color: "#900", margin: "12px 0" }}>
        Matching pipeline: <strong>no successful runs recorded</strong> (collection empty or never populated).
      </div>
    )
  }
  const tsRaw = (lastSuccess.createdAt ?? lastSuccess.scrapeFinishedAt) as string | undefined
  const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : NaN
  const ageHrs = Number.isFinite(ageMs) ? ageMs / (1000 * 60 * 60) : NaN
  let color = "#0a0"
  let bg = "#efe"
  let label = "GREEN"
  if (!Number.isFinite(ageHrs)) {
    color = "#900"; bg = "#fee"; label = "UNKNOWN"
  } else if (ageHrs > 36) {
    color = "#900"; bg = "#fee"; label = "RED"
  } else if (ageHrs > 24) {
    color = "#960"; bg = "#ffd"; label = "AMBER"
  }
  return (
    <div style={{ padding: 12, borderRadius: 8, background: bg, color, margin: "12px 0" }}>
      Matching pipeline: <strong>{label}</strong>
      {Number.isFinite(ageHrs) ? ` — last success ${ageHrs.toFixed(1)}h ago` : ""}
      {" — "}
      jobsNew={cell(lastSuccess.jobsNew)} jobsUpdated={cell(lastSuccess.jobsUpdated)} jobsErrored={cell(lastSuccess.jobsErrored)}
    </div>
  )
}

// ============================================================================
// Phase 46 (v1.5 Stream-E) — Safety events last 24h tile.
// Pure-derived from already-loaded `abuseEvents` (no extra Firestore read).
// Counts kinds by severity bucket; warns visibly when illegal_content > 0.
// ============================================================================
function SafetyEventsTile({ abuseEvents }: { abuseEvents: Row[] }) {
  const last24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return abuseEvents.filter((r) => {
      const t = typeof r["createdAt"] === "string" ? Date.parse(r["createdAt"] as string) : NaN
      return Number.isFinite(t) && t >= cutoff
    })
  }, [abuseEvents])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of last24h) {
      const k = String(r["kind"] ?? "unknown")
      c[k] = (c[k] ?? 0) + 1
    }
    return c
  }, [last24h])

  const total = last24h.length
  const critical = (counts["illegal_content"] ?? 0)
  const high =
    (counts["prompt_injection"] ?? 0) +
    (counts["rate_abuse_24h"] ?? 0) +
    (counts["rate_limited"] ?? 0)

  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: "12px 16px",
        background: critical > 0 ? "#fef2f2" : "#f8fafc",
        display: "flex",
        gap: 24,
        alignItems: "center",
        marginBottom: 12,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: "0.95em" }}>
        Safety events (24h):{" "}
        <span style={{ color: critical > 0 ? "#dc2626" : "#0f172a" }}>{total}</span>
      </div>
      <div style={{ fontSize: "0.85em", color: "#475569", display: "flex", gap: 16 }}>
        <span>critical: <b style={{ color: critical > 0 ? "#dc2626" : "#0f172a" }}>{critical}</b></span>
        <span>high: <b>{high}</b></span>
        <span>injection: {counts["prompt_injection"] ?? 0}</span>
        <span>illegal: {counts["illegal_content"] ?? 0}</span>
        <span>rate-1m: {counts["rate_limited"] ?? 0}</span>
        <span>rate-24h: {counts["rate_abuse_24h"] ?? 0}</span>
      </div>
    </div>
  )
}

