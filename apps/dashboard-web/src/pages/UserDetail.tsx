import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, doc, getDoc, getDocs, limit, onSnapshot, query, updateDoc, where } from "firebase/firestore"
import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { DataTable, EmptyState, ErrorState, PageHeader, Panel, StatusBadge } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import {
  clearUserMemory,
  deleteMemoryPoint,
  listMemoryPoints,
  type MemoryPoint,
} from "../lib/memoryAdmin.js"
import { fetchWorkerHealth, getWorkerHealthBaseUrl, type WorkerHealth } from "../lib/workerHealth.js"
import { renderToolCallSummary } from "./toolCallSummary.js"

type U = { id: string; phoneE164?: string; activeAgentId?: string; onboardingStatus?: string }
type M = { id: string; role?: string; body?: string; createdAt?: string; sessionId?: string }
type EventRow = { id: string; kind?: string; message?: string; createdAt?: string; mem0UserId?: string }
type AnyRow = Record<string, unknown> & { id: string }

export function UserDetail() {
  const { id } = useParams()
  const [user, setUser] = useState<U | null>(null)
  const [messages, setMessages] = useState<M[]>([])
  const [memoryEvents, setMemoryEvents] = useState<EventRow[]>([])
  const [turns, setTurns] = useState<AnyRow[]>([])
  const [outbound, setOutbound] = useState<AnyRow[]>([])
  const [toolCalls, setToolCalls] = useState<AnyRow[]>([])
  const [auditEvents, setAuditEvents] = useState<AnyRow[]>([])
  const [abuseEvents, setAbuseEvents] = useState<AnyRow[]>([])
  const [agents, setAgents] = useState<{ id: string; name: string; memoryMode?: string }[]>([])
  const [memoryPoints, setMemoryPoints] = useState<MemoryPoint[]>([])
  const [memorySearch, setMemorySearch] = useState("")
  const [memoryLoaded, setMemoryLoaded] = useState(false)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryAction, setMemoryAction] = useState<string | null>(null)
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [workerHealth, setWorkerHealth] = useState<WorkerHealth | null>(null)
  const [workerHealthErr, setWorkerHealthErr] = useState<string | null>(null)
  const workerHealthUrl = getWorkerHealthBaseUrl()

  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      try {
        const u = await getDoc(doc(db(), PA_COLLECTIONS.users, id))
        if (cancelled) return
        if (u.exists()) setUser({ id: u.id, ...u.data() } as U)
        const ag = await getDocs(collection(db(), PA_COLLECTIONS.agents))
        if (cancelled) return
        setAgents(
          ag.docs.map((d) => {
            const raw = d.data() as { name?: string; memoryMode?: string }
            return {
              id: d.id,
              name: String(raw.name || d.id),
              memoryMode: String(raw.memoryMode || "firestore_only"),
            }
          })
        )
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      try {
        const [turnSnap, outboundSnap, auditSnap, abuseSnap, toolSnap] = await Promise.all([
          getDocs(query(collection(db(), PA_COLLECTIONS.agentTurns), where("userId", "==", id))),
          getDocs(query(collection(db(), PA_COLLECTIONS.outbound), where("userId", "==", id))),
          getDocs(query(collection(db(), PA_COLLECTIONS.auditEvents), where("userId", "==", id))),
          getDocs(query(collection(db(), PA_COLLECTIONS.abuseEvents), where("userId", "==", id))),
          getDocs(query(collection(db(), PA_COLLECTIONS.toolCalls), limit(300))),
        ])
        if (cancelled) return
        const turnRows = turnSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as AnyRow)
        const turnIds = new Set(turnRows.map((t) => t.id))
        setTurns(turnRows.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))))
        setOutbound(outboundSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as AnyRow))
        setAuditEvents(auditSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as AnyRow))
        setAbuseEvents(abuseSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as AnyRow))
        setToolCalls(toolSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as AnyRow).filter((r) => turnIds.has(String(r.turnId))))
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    if (!workerHealthUrl) {
      setWorkerHealth(null)
      setWorkerHealthErr(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { health, err: he } = await fetchWorkerHealth()
      if (cancelled) return
      setWorkerHealth(health)
      setWorkerHealthErr(he)
    })()
    return () => {
      cancelled = true
    }
  }, [workerHealthUrl])

  useEffect(() => {
    if (!id) return
    const mq = query(collection(db(), PA_COLLECTIONS.messages), where("userId", "==", id))
    return onSnapshot(
      mq,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as M[]
        list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        setMessages(list)
      },
      (e) => setErr(e.message)
    )
  }, [id])

  useEffect(() => {
    if (!id) return
    const memq = query(collection(db(), PA_COLLECTIONS.memoryEvents), where("userId", "==", id))
    return onSnapshot(
      memq,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as EventRow[]
        list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        setMemoryEvents(list.slice(0, 50))
      },
      (e) => setErr(e.message)
    )
  }, [id])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setMemoryPoints([])
    setMemoryLoaded(false)
    setMemoryNotice(null)
    setMemoryLoading(true)
    ;(async () => {
      try {
        const data = await listMemoryPoints(id, "")
        if (cancelled) return
        setMemoryPoints(data.points)
        setMemoryLoaded(true)
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setMemoryLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  async function onAssign(aid: string) {
    if (!id) return
    await updateDoc(doc(db(), PA_COLLECTIONS.users, id), { activeAgentId: aid })
    setUser((u) => (u ? { ...u, activeAgentId: aid } : u))
  }

  async function refreshSemanticMemory(q = memorySearch) {
    if (!id) return
    setMemoryLoading(true)
    setMemoryNotice(null)
    try {
      const data = await listMemoryPoints(id, q)
      setMemoryPoints(data.points)
      setMemoryLoaded(true)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setMemoryLoading(false)
    }
  }

  async function onDeleteMemoryPoint(pointId: string | number) {
    if (!id) return
    if (!window.confirm(`Delete Qdrant memory point ${pointId}?`)) return
    setMemoryAction(String(pointId))
    try {
      await deleteMemoryPoint(id, pointId)
      setMemoryPoints((points) => points.filter((p) => String(p.id) !== String(pointId)))
      setMemoryNotice(`Deleted memory point ${pointId}`)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setMemoryAction(null)
    }
  }

  async function onClearMemory() {
    if (!id) return
    if (!window.confirm("Clear all semantic memory and Firestore memory/transcript rows for this user?")) return
    setMemoryAction("clear")
    try {
      const data = await clearUserMemory(id)
      setMemoryPoints([])
      setMemoryNotice(data.summary)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setMemoryAction(null)
    }
  }

  if (err) return <ErrorState message={err} />
  if (!user) return <div className="panel">Loading…</div>

  const activeAgent = agents.find((a) => a.id === user.activeAgentId)

  return (
    <div className="page-stack">
      <p>
        <Link to="/conversations">← Conversations</Link>
      </p>
      <PageHeader
        eyebrow="Conversation detail"
        title={user.phoneE164 || user.id}
        description="Transcript, turns, outbound queue rows, connector calls, audit/safety, and memory events linked in one workbench."
      />
      <div className="action-list inline-actions">
        <a href="#transcript">Transcript</a>
        <a href="#turns">Turns</a>
        <a href="#outbound">Outbound</a>
        <a href="#connectors">Connectors</a>
        <a href="#audit">Audit/Safety</a>
        <a href="#memory-admin">Memory Admin</a>
        <a href="#memory-events">Memory Events</a>
      </div>
      <Panel title="Runtime assignment" eyebrow="Agent">
        <select
          value={user.activeAgentId || ""}
          onChange={(e) => onAssign(e.target.value)}
        >
          <option value="">—</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <p className="muted-copy">
          Onboarding: <StatusBadge value={user.onboardingStatus} /> · Messages below are the Firestore transcript (live).
        </p>
        {activeAgent && (
          <p className="muted-copy">
            Active agent <code>{activeAgent.id}</code> — memory mode: <b>{activeAgent.memoryMode}</b>
            {workerHealthUrl ? (
              workerHealthErr ? (
                <> — worker Mem0 env: <span className="danger-text">health error ({workerHealthErr})</span></>
              ) : workerHealth ? (
                <>
                  {" "}
                  — worker <code>MEM0_API_KEY</code>:{" "}
                  <b>{workerHealth.mem0ApiKeyPresent ? "present" : "absent"}</b>
                  {(activeAgent.memoryMode === "mem0" || activeAgent.memoryMode === "both") &&
                    workerHealth.mem0ApiKeyPresent === false && (
                      <span className="warning-text"> (Mem0 features will degrade)</span>
                    )}
                </>
              ) : (
                <> — worker health: loading…</>
              )
            ) : (
              <> — set <code>VITE_WORKER_HEALTH_URL</code> to see Mem0 key status on the worker</>
            )}
            .
          </p>
        )}
      </Panel>
      <Section id="transcript" title="Transcript" rows={messages as AnyRow[]} columns={["createdAt", "role", "body"]} />
      <Section id="turns" title="Turns" rows={turns} columns={["createdAt", "status", "agentId", "lastError"]} />
      <Section id="outbound" title="Outbound" rows={outbound} columns={["createdAt", "status", "toE164", "body", "error"]} />
      <Section id="connectors" title="Connector calls" rows={toolCalls} columns={["startedAt", "status", "connectorName", "policyDecision", "resultSummary", "error"]} />
      <Section id="audit" title="Audit and safety" rows={[...auditEvents, ...abuseEvents]} columns={["createdAt", "kind", "message"]} />
      <Panel
        title="Semantic memory"
        eyebrow="Memory Admin"
        actions={
          <button type="button" className="danger-button" disabled={memoryAction === "clear"} onClick={onClearMemory}>
            {memoryAction === "clear" ? "Clearing..." : "Clear user memory"}
          </button>
        }
      >
        <div id="memory-admin" />
        <div className="toolbar memory-toolbar">
          <input
            aria-label="Search semantic memory"
            placeholder="Search Qdrant payload"
            value={memorySearch}
            onChange={(e) => setMemorySearch(e.target.value)}
          />
          <button type="button" onClick={() => refreshSemanticMemory()} disabled={memoryLoading}>
            {memoryLoading ? "Loading..." : "Search"}
          </button>
          <button type="button" onClick={() => refreshSemanticMemory("")} disabled={memoryLoading}>
            Refresh
          </button>
        </div>
        {memoryNotice ? <div className="notice notice-good">{memoryNotice}</div> : null}
        <DataTable<MemoryPoint & { id: string | number }>
          rows={memoryPoints}
          empty={
            <EmptyState
              title={
                memoryLoading
                  ? "Loading semantic memories"
                  : memoryLoaded
                    ? "No semantic memories found"
                    : "Semantic memories not loaded"
              }
              body={
                memoryLoaded
                  ? "Qdrant pa_memory has no matching payloads for this user."
                  : "Semantic memories load automatically when this page opens. Use Refresh to try again."
              }
            />
          }
          columns={[
            {
              key: "id",
              header: "Point",
              render: (row) => <code>{String(row.id)}</code>,
            },
            {
              key: "payload",
              header: "Payload",
              render: (row) => <MemoryPayload payload={row.payload} />,
            },
            {
              key: "actions",
              header: "",
              render: (row) => (
                <button
                  type="button"
                  className="danger-button"
                  disabled={memoryAction === String(row.id)}
                  onClick={() => onDeleteMemoryPoint(row.id)}
                >
                  {memoryAction === String(row.id) ? "Deleting..." : "Delete"}
                </button>
              ),
            },
          ]}
        />
      </Panel>
      <Section id="memory-events" title="Memory events" rows={memoryEvents as AnyRow[]} columns={["createdAt", "kind", "mem0UserId", "message"]} />
    </div>
  )
}

function text(v: unknown, max = 240) {
  const value = v == null || v === "" ? "—" : String(v)
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function payloadSummary(payload: Record<string, unknown> | undefined) {
  if (!payload) return "—"
  for (const key of ["memory", "text", "content", "data"]) {
    const value = payload[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return JSON.stringify(payload)
}

function MemoryPayload({ payload }: { payload?: Record<string, unknown> }) {
  const summary = payloadSummary(payload)
  return (
    <div className="memory-payload">
      <strong>{text(summary, 320)}</strong>
      <small>{text(JSON.stringify(payload ?? {}), 520)}</small>
    </div>
  )
}

function Section({ id, title, rows, columns }: { id: string; title: string; rows: AnyRow[]; columns: string[] }) {
  return (
    <Panel title={title}>
      <div id={id} />
      <DataTable<AnyRow>
        rows={rows}
        empty={<EmptyState title={`No ${title.toLowerCase()} yet`} body="Nothing has been recorded for this conversation in the latest sample." />}
        columns={columns.map((column) => ({
          key: column,
          header: column,
          render: (row) =>
            column === "status" || column === "role" || column === "kind" ? (
              <StatusBadge value={String(row[column] ?? "")} />
            ) : column === "resultSummary" ? (
              text(renderToolCallSummary(row), 420)
            ) : (
              text(row[column], column === "body" || column === "message" ? 420 : 160)
            ),
        }))}
      />
    </Panel>
  )
}
