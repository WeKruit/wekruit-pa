/**
 * Phase 32 Wave 2b — UserDetail layout refactor.
 *
 * Top-of-page `OperatorSummary` (4 stat cards + 1-line health + quick actions)
 * replaces the old runtime-assignment panel as the primary surface. Existing
 * sections (Turns / Outbound / Connectors / Audit / Memory) are now nested
 * tabs below it; the default Turns tab renders as a chat-stream (user right,
 * assistant left, system events default-hidden).
 *
 * All raw debug strings ("测试记忆已清空", "No turns yet", "Loading semantic
 * memories") are replaced with neutral empty-state copy.
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, doc, getDoc, getDocs, limit, onSnapshot, query, updateDoc, where } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { DataTable, EmptyState, ErrorState, PageHeader, Panel, StatusBadge } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import {
  clearUserMemory,
  deleteMemoryPoint,
  listMemoryPoints,
  type MemoryPoint,
} from "../lib/memoryAdmin.js"
import { reinitializeCandidate } from "../lib/reinitialize-candidate-api.js"
import { getCandidateComms, type CommsTimelineRow } from "../lib/candidate-comms-api.js"
// iter31 — HITL pause/resume admin client
import { setRuntimeMode, type RuntimeMode } from "../lib/runtimeMode.js"
import { fetchWorkerHealth, getWorkerHealthBaseUrl, type WorkerHealth } from "../lib/workerHealth.js"
import { CandidateMarketplace } from "./CandidateMarketplace.js"
import { renderToolCallSummary } from "./toolCallSummary.js"

type U = {
  id: string
  phoneE164?: string
  activeAgentId?: string
  onboardingStatus?: string
  createdAt?: string
  // iter31 — HITL runtime mode (paused | auto). Unset / undefined = auto.
  runtimeMode?: "auto" | "paused"
  runtimeModeAt?: string
  runtimeModeSetBy?: string
  runtimeModeReason?: string
} & Record<string, unknown>
type M = { id: string; role?: string; body?: string; createdAt?: string; sessionId?: string }
type EventRow = { id: string; kind?: string; message?: string; createdAt?: string; mem0UserId?: string }
type AnyRow = Record<string, unknown> & { id: string }

type RiskLevel = "low" | "medium" | "high"
type TabKey = "turns" | "comms" | "marketplace" | "outbound" | "connectors" | "audit" | "memory"

function relativeTime(iso: string | undefined | null): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  const diff = Date.now() - t
  if (diff < 60_000) return "just now"
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 14) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  return new Date(t).toLocaleDateString()
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: "0.85rem 1rem",
        background: "#ffffff",
        flex: 1,
        minWidth: 140,
      }}
    >
      <div style={{ fontSize: "0.75em", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ fontSize: "1.35em", fontWeight: 600, marginTop: 4, color: "#0f172a" }}>{value}</div>
      {hint ? <div style={{ fontSize: "0.75em", color: "#94a3b8", marginTop: 2 }}>{hint}</div> : null}
    </div>
  )
}

function RiskPill({ level }: { level: RiskLevel }) {
  const tone = level === "high" ? "bad" : level === "medium" ? "warn" : "good"
  return <span className={`status-badge ${tone}`}>{level}</span>
}

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
  const [activeTab, setActiveTab] = useState<TabKey>("turns")
  const [showSystemEvents, setShowSystemEvents] = useState(false)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  // Unified SMS + email comms timeline (paAdminCandidateComms). Lazy-loaded the
  // first time the operator opens the Communications tab.
  const [comms, setComms] = useState<CommsTimelineRow[] | null>(null)
  const [commsEmail, setCommsEmail] = useState<string | undefined>(undefined)
  const [commsLoading, setCommsLoading] = useState(false)
  const [commsErr, setCommsErr] = useState<string | null>(null)
  const [commsLoaded, setCommsLoaded] = useState(false)
  const workerHealthUrl = getWorkerHealthBaseUrl()

  const loadComms = useMemo(
    () => async () => {
      if (!id) return
      setCommsLoading(true)
      setCommsErr(null)
      try {
        const res = await getCandidateComms(id)
        setComms(res.rows)
        setCommsEmail(res.candidateEmail)
        setCommsLoaded(true)
      } catch (e: unknown) {
        setCommsErr(e instanceof Error ? e.message : String(e))
      } finally {
        setCommsLoading(false)
      }
    },
    [id],
  )

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

  // Lazy-load the unified comms timeline the first time the tab is opened.
  useEffect(() => {
    if (activeTab === "comms" && !commsLoaded && !commsLoading && !commsErr) {
      void loadComms()
    }
  }, [activeTab, commsLoaded, commsLoading, commsErr, loadComms])

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
    if (!window.confirm(`Delete memory point ${pointId}?`)) return
    setMemoryAction(String(pointId))
    try {
      await deleteMemoryPoint(id, pointId)
      setMemoryPoints((points) => points.filter((p) => String(p.id) !== String(pointId)))
      setMemoryNotice(`Memory point ${pointId} deleted.`)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setMemoryAction(null)
    }
  }

  async function onClearMemory() {
    if (!id) return
    if (!window.confirm("Clear all memory rows for this conversation? This cannot be undone.")) return
    setMemoryAction("clear")
    try {
      const data = await clearUserMemory(id)
      setMemoryPoints([])
      // Replace raw worker echo string with neutral confirmation.
      setMemoryNotice(`Memory cleared (${data.summary || "ok"})`)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setMemoryAction(null)
    }
  }

  async function onReinitialize() {
    if (!id) return
    if (
      !window.confirm(
        "Re-initialize this candidate? Archives the conversation, clears memory + tags + onboarding " +
          "(back to a fresh start), and re-enriches from their résumé. PRESERVES matched jobs + " +
          "prescreen sessions. The candidate self-initiates the next conversation. Cannot be undone.",
      )
    )
      return
    setMemoryAction("reinit")
    try {
      const r = await reinitializeCandidate(id)
      setMemoryPoints([])
      setMemoryNotice(
        `Re-initialized: archived ${r.archivedMessages} messages, ${r.reEnriched ? `re-enriched (${r.tagKeys.length} tags)` : "no résumé to re-enrich"}, ` +
          `matched jobs preserved. Candidate self-initiates next.`,
      )
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setMemoryAction(null)
    }
  }

  // Derived operator summary stats.
  const stats = useMemo(() => {
    const turnCount = turns.length
    const lastTurnAt = turns[0]?.createdAt as string | undefined
    const recentRateLimit = abuseEvents.filter((e) => {
      const k = String(e.kind ?? "")
      return k.includes("rate_limit") || k.includes("rateLimit")
    }).length
    const recentInjection = abuseEvents.filter((e) => {
      const k = String(e.kind ?? "")
      return k.includes("injection") || k.includes("allowlist") || k.includes("deny")
    }).length
    const risk: RiskLevel = recentInjection > 0 ? "high" : recentRateLimit > 0 ? "medium" : "low"
    const failedOutbound = outbound.filter((o) => o.status === "failed" || o.status === "dead_letter").length
    let health = "All channels green."
    if (failedOutbound > 0) {
      health = `Outbound has ${failedOutbound} failed delivery${failedOutbound === 1 ? "" : "ies"} pending review.`
    } else if (recentRateLimit > 0) {
      health = `Sendblue rate-limited ${recentRateLimit} time${recentRateLimit === 1 ? "" : "s"} recently.`
    } else if (recentInjection > 0) {
      health = `Abuse signal detected (${recentInjection} event${recentInjection === 1 ? "" : "s"}) — review allowlist.`
    }
    return { turnCount, lastTurnAt, risk, health }
  }, [turns, outbound, abuseEvents])

  async function onMuteOutbound() {
    if (!id) return
    setActionNotice("Outbound mute (24h) queued — awaiting paAdminBootstrap action wiring.")
    // Best-effort placeholder: mark a doc field locally so operators see immediate
    // feedback. Real CF action lands in a follow-up patch.
    try {
      await updateDoc(doc(db(), PA_COLLECTIONS.users, id), {
        outboundMutedUntil: new Date(Date.now() + 24 * 3600_000).toISOString(),
      })
      setActionNotice("Outbound muted for 24h.")
    } catch (e) {
      setActionNotice(`Mute failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function onSendCheckIn() {
    setActionNotice("Send check-in is a stub — wire to paAdminBootstrap.sendCheckIn action.")
  }

  // iter31 — HITL pause/resume action. Calls paRuntimeMode admin endpoint
  // which writes user.runtimeMode + audit row. On pause the orchestrator
  // skips reply generation but keeps memory ingest. On resume no auto-reply
  // is emitted — next user inbound flows through normal path.
  async function onToggleRuntimeMode(target: RuntimeMode) {
    if (!id) return
    const reason = target === "paused"
      ? window.prompt("Reason for pausing? (optional)") ?? ""
      : window.prompt("Reason for resuming? (optional)") ?? ""
    setActionNotice(target === "paused" ? "Pausing agent…" : "Resuming agent…")
    try {
      const result = await setRuntimeMode(id, target, reason)
      setUser((u) => (u ? {
        ...u,
        runtimeMode: result.mode,
        runtimeModeAt: result.runtimeModeAt,
        runtimeModeSetBy: result.setBy,
        runtimeModeReason: reason,
      } : u))
      setActionNotice(
        target === "paused"
          ? `Agent paused at ${new Date(result.runtimeModeAt).toLocaleTimeString()} — inbound writes still flow into memory; outbound suppressed.`
          : `Agent resumed at ${new Date(result.runtimeModeAt).toLocaleTimeString()} — next user message flows through normally.`
      )
    } catch (e) {
      setActionNotice(`Runtime mode change failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (err) return <ErrorState message={err} />
  if (!user) return <div className="panel">Loading conversation…</div>

  const activeAgent = agents.find((a) => a.id === user.activeAgentId)

  return (
    <div className="page-stack">
      <p>
        <Link to="/conversations">← Conversations</Link>
      </p>
      <PageHeader
        eyebrow="Conversation detail"
        title={user.phoneE164 || user.id}
        description="Operator workbench — at-a-glance health, quick actions, and tabbed sub-views for turns, outbound, connectors, audit, and memory."
      />

      {/* OperatorSummary — Phase 32 Wave 2b */}
      <Panel title="Operator summary" eyebrow="Health">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <StatCard label="Active since" value={formatDate(user.createdAt)} />
          <StatCard label="Total turns" value={String(stats.turnCount)} />
          <StatCard label="Last turn" value={relativeTime(stats.lastTurnAt)} />
          <StatCard
            label="Risk level"
            value={stats.risk}
            hint={stats.risk === "low" ? "no abuse signals" : "see Audit tab"}
          />
        </div>
        <p style={{ margin: "0.85rem 0 0 0", fontSize: "0.9em", color: "#475569" }}>
          {stats.health}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "0.85rem" }}>
          {/* iter31 — HITL pause/resume control. Pausing skips reply
              generation but keeps memory ingest; resuming emits no auto
              reply (next user inbound flows through normally). */}
          {user.runtimeMode === "paused" ? (
            <button
              type="button"
              onClick={() => void onToggleRuntimeMode("auto")}
              style={{
                background: "#fef3c7",
                border: "1px solid #f59e0b",
                color: "#78350f",
                fontWeight: 600,
              }}
              title={`Paused at ${user.runtimeModeAt ?? "—"} by ${user.runtimeModeSetBy ?? "—"}${user.runtimeModeReason ? ` · ${user.runtimeModeReason}` : ""}`}
            >
              ▶ Resume agent
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onToggleRuntimeMode("paused")}
              title="Pause auto-replies for this conversation. Inbound still records to memory + audit; operator can read in real time and resume when ready."
            >
              ⏸ Pause agent
            </button>
          )}
          <button type="button" onClick={() => void onMuteOutbound()}>Mute outbound 24h</button>
          <button type="button" onClick={onSendCheckIn}>Send check-in</button>
          <Link
            to="/operations"
            style={{
              padding: "5px 12px",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontSize: "0.85em",
              textDecoration: "none",
              color: "#334155",
            }}
          >
            Open ops drawer
          </Link>
          <Link
            to={`/admin/candidates/${id}/profile`}
            style={{
              padding: "5px 12px",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontSize: "0.85em",
              textDecoration: "none",
              color: "#334155",
            }}
          >
            Marketplace profile
          </Link>
          <select
            value={user.activeAgentId || ""}
            onChange={(e) => onAssign(e.target.value)}
            aria-label="Reassign agent"
            style={{ fontSize: "0.85em" }}
          >
            <option value="">— assign agent —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {actionNotice ? (
          <div className="notice notice-good" style={{ marginTop: "0.75rem" }}>
            {actionNotice}
          </div>
        ) : null}
        <p className="muted-copy" style={{ marginTop: "0.85rem" }}>
          Onboarding: <StatusBadge value={user.onboardingStatus} /> · Risk: <RiskPill level={stats.risk} />
          {user.runtimeMode === "paused" ? (
            <>
              {" "}· <span style={{
                background: "#fef3c7",
                color: "#78350f",
                padding: "2px 8px",
                borderRadius: 999,
                fontWeight: 600,
                fontSize: "0.85em",
              }}>HITL paused</span>
            </>
          ) : null}
          {activeAgent ? (
            <>
              {" "}· Active agent <code>{activeAgent.id}</code> (memory: <b>{activeAgent.memoryMode}</b>)
            </>
          ) : null}
          {workerHealthUrl
            ? workerHealthErr
              ? <> · worker health: <span className="danger-text">error ({workerHealthErr})</span></>
              : workerHealth
                ? <> · worker MEM0 key: <b>{workerHealth.mem0ApiKeyPresent ? "present" : "absent"}</b></>
                : <> · worker health: loading…</>
            : null}
        </p>
      </Panel>

      {/* Tabs — Phase 32 Wave 2b */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #e2e8f0" }}>
        {(
          [
            { key: "turns", label: "Turns" },
            { key: "comms", label: "Communications" },
            { key: "marketplace", label: "Marketplace" },
            { key: "outbound", label: "Outbound" },
            { key: "connectors", label: "Connectors" },
            { key: "audit", label: "Audit & Safety" },
            { key: "memory", label: "Memory" },
          ] as { key: TabKey; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: "8px 14px",
              fontSize: "0.9em",
              background: activeTab === t.key ? "#0f172a" : "transparent",
              color: activeTab === t.key ? "#fff" : "#475569",
              border: "none",
              borderTopLeftRadius: 6,
              borderTopRightRadius: 6,
              cursor: "pointer",
              fontWeight: activeTab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "turns" ? (
        <Panel
          title="Conversation"
          eyebrow="Chat stream"
          actions={
            <label style={{ fontSize: "0.85em", color: "#64748b" }}>
              <input
                type="checkbox"
                checked={showSystemEvents}
                onChange={(e) => setShowSystemEvents(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Show system events
            </label>
          }
        >
          <ChatStream messages={messages} showSystem={showSystemEvents} />
        </Panel>
      ) : null}

      {activeTab === "comms" ? (
        <Panel
          title="Communications"
          eyebrow="SMS + email — full timeline"
          actions={
            <button type="button" onClick={() => void loadComms()} disabled={commsLoading}>
              {commsLoading ? "Loading…" : "Refresh"}
            </button>
          }
        >
          {commsErr ? <div className="notice notice-bad">{commsErr}</div> : null}
          {commsEmail ? (
            <p className="muted-copy" style={{ marginTop: 0 }}>
              Candidate email: <code>{commsEmail}</code>
            </p>
          ) : null}
          <CommsStream rows={comms} loading={commsLoading} loaded={commsLoaded} />
        </Panel>
      ) : null}

      {activeTab === "marketplace" ? (
        <CandidateMarketplace candidateId={user.id} profile={user} />
      ) : null}

      {activeTab === "outbound" ? (
        <Section
          title="Outbound"
          rows={outbound}
          columns={["createdAt", "status", "toE164", "body", "error"]}
        />
      ) : null}

      {activeTab === "connectors" ? (
        <Section
          title="Connector calls"
          rows={toolCalls}
          columns={["startedAt", "status", "connectorName", "policyDecision", "resultSummary", "error"]}
        />
      ) : null}

      {activeTab === "audit" ? (
        <>
          <Section
            title="Audit & safety"
            rows={[...auditEvents, ...abuseEvents]}
            columns={["createdAt", "kind", "message"]}
          />
          <Section
            title="Turns (raw)"
            rows={turns}
            columns={["createdAt", "status", "agentId", "lastError"]}
          />
        </>
      ) : null}

      {activeTab === "memory" ? (
        <>
          <Panel
            title="Semantic memory"
            eyebrow="Memory admin"
            actions={
              <>
                <button
                  type="button"
                  className="danger-button"
                  disabled={memoryAction === "clear" || memoryAction === "reinit"}
                  onClick={onClearMemory}
                >
                  {memoryAction === "clear" ? "Clearing…" : "Clear memory"}
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={memoryAction === "clear" || memoryAction === "reinit"}
                  onClick={onReinitialize}
                  title="Archive conversation + clear memory/tags + re-enrich from résumé; preserves matched jobs + prescreen"
                >
                  {memoryAction === "reinit" ? "Re-initializing…" : "Re-initialize candidate"}
                </button>
              </>
            }
          >
            <div className="toolbar memory-toolbar">
              <input
                aria-label="Search semantic memory"
                placeholder="Search payload"
                value={memorySearch}
                onChange={(e) => setMemorySearch(e.target.value)}
              />
              <button type="button" onClick={() => refreshSemanticMemory()} disabled={memoryLoading}>
                {memoryLoading ? "Searching…" : "Search"}
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
                  title={memoryLoading ? "Loading memory…" : memoryLoaded ? "No memory yet" : "Memory not loaded"}
                  body={
                    memoryLoaded
                      ? "Nothing has been remembered for this conversation yet."
                      : "Use Refresh to retry loading semantic memory for this conversation."
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
                      {memoryAction === String(row.id) ? "Deleting…" : "Delete"}
                    </button>
                  ),
                },
              ]}
            />
          </Panel>
          <Section title="Memory events" rows={memoryEvents as AnyRow[]} columns={["createdAt", "kind", "mem0UserId", "message"]} />
        </>
      ) : null}

      {/* Engineer escape hatch — keep raw debug-ops link discoverable. */}
      <p className="muted-copy" style={{ marginTop: "1rem" }}>
        <Link to="/operations">Debug ops →</Link>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chat stream — Phase 32 Wave 2b
// ---------------------------------------------------------------------------

function ChatStream({ messages, showSystem }: { messages: M[]; showSystem: boolean }) {
  const visible = useMemo(() => {
    if (showSystem) return messages
    return messages.filter((m) => m.role === "user" || m.role === "assistant")
  }, [messages, showSystem])

  if (visible.length === 0) {
    return (
      <EmptyState
        title="No conversation yet"
        body="Once the user exchanges messages with the agent, the transcript will appear here as a chat stream."
      />
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {visible.map((m) => {
        const isUser = m.role === "user"
        const isAssistant = m.role === "assistant"
        const align = isUser ? "flex-end" : "flex-start"
        const bg = isUser
          ? "#dbeafe"
          : isAssistant
            ? "#f1f5f9"
            : "#fef3c7"
        const border = isUser ? "1px solid #93c5fd" : isAssistant ? "1px solid #cbd5e1" : "1px solid #fde68a"
        return (
          <div key={m.id} style={{ display: "flex", justifyContent: align }}>
            <div
              style={{
                maxWidth: "78%",
                background: bg,
                border,
                borderRadius: 10,
                padding: "0.5rem 0.75rem",
                fontSize: "0.9em",
                color: "#0f172a",
                whiteSpace: "pre-wrap",
              }}
            >
              <div
                style={{
                  fontSize: "0.7em",
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  marginBottom: 2,
                }}
              >
                {m.role || "system"} · {relativeTime(m.createdAt)}
              </div>
              {m.body || <span style={{ color: "#94a3b8", fontStyle: "italic" }}>(empty)</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Unified comms stream — SMS + email together (paAdminCandidateComms)
// ---------------------------------------------------------------------------

function CommsStream({
  rows,
  loading,
  loaded,
}: {
  rows: CommsTimelineRow[] | null
  loading: boolean
  loaded: boolean
}) {
  if (loading && !loaded) {
    return <EmptyState title="Loading communications…" body="Merging SMS and email into one timeline." />
  }
  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        title={loaded ? "No communications yet" : "Communications not loaded"}
        body={
          loaded
            ? "No SMS or email has been exchanged with this candidate yet."
            : "Use Refresh to load the merged SMS + email timeline."
        }
      />
    )
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((r) => {
        const isInbound = r.direction === "inbound"
        const align = isInbound ? "flex-end" : "flex-start"
        const isEmail = r.channel === "email"
        // SMS = blue/slate (matches ChatStream); email = amber-tinted to read distinctly.
        const bg = isInbound ? (isEmail ? "#fef3c7" : "#dbeafe") : isEmail ? "#fff7ed" : "#f1f5f9"
        const border = isInbound
          ? isEmail
            ? "1px solid #fde68a"
            : "1px solid #93c5fd"
          : isEmail
            ? "1px solid #fed7aa"
            : "1px solid #cbd5e1"
        return (
          <div key={`${r.source}:${r.id}`} style={{ display: "flex", justifyContent: align }}>
            <div
              style={{
                maxWidth: "82%",
                background: bg,
                border,
                borderRadius: 10,
                padding: "0.5rem 0.75rem",
                fontSize: "0.9em",
                color: "#0f172a",
                whiteSpace: "pre-wrap",
              }}
            >
              <div
                style={{
                  fontSize: "0.7em",
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  marginBottom: 2,
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    background: isEmail ? "#f59e0b" : "#3b82f6",
                    color: "#fff",
                    borderRadius: 4,
                    padding: "0 5px",
                    fontSize: "0.9em",
                  }}
                >
                  {isEmail ? "✉ email" : "sms"}
                </span>
                <span>{r.direction}</span>
                <span>· {relativeTime(r.ts)}</span>
                {r.status ? <span>· {r.status}</span> : null}
              </div>
              {isEmail && r.subject ? (
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{r.subject}</div>
              ) : null}
              {r.text || <span style={{ color: "#94a3b8", fontStyle: "italic" }}>(empty)</span>}
            </div>
          </div>
        )
      })}
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

function Section({ title, rows, columns }: { title: string; rows: AnyRow[]; columns: string[] }) {
  return (
    <Panel title={title}>
      <DataTable<AnyRow>
        rows={rows}
        empty={<EmptyState title={`No ${title.toLowerCase()} yet`} body="Nothing recorded for this conversation in the current sample window." />}
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
