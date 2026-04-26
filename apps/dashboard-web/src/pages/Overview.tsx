import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { db } from "../lib/firebase.js"

type Row = Record<string, unknown> & { id: string }
type HealthJson = {
  ok?: boolean
  firebase?: boolean
  outboundListener?: boolean
  imessageReady?: boolean
  uptimeSec?: number
}

function formatAge(iso?: unknown): string {
  if (typeof iso !== "string" || !iso) return "unknown"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "unknown"
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

function healthLabel(health: HealthJson | { error: string } | null): { label: string; tone: string } {
  if (!health) return { label: "not configured", tone: "muted" }
  if ("error" in health) return { label: "unreachable", tone: "bad" }
  if (health.ok && health.firebase && health.outboundListener && health.imessageReady) {
    return { label: "ready", tone: "good" }
  }
  return { label: "degraded", tone: "warn" }
}

async function loadRows(collectionName: string, max = 80, orderField = "createdAt"): Promise<Row[]> {
  const snap = await getDocs(
    query(collection(db(), collectionName), orderBy(orderField, "desc"), limit(max))
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

export function Overview() {
  const [inbound, setInbound] = useState<Row[]>([])
  const [outbound, setOutbound] = useState<Row[]>([])
  const [turns, setTurns] = useState<Row[]>([])
  const [users, setUsers] = useState<Row[]>([])
  const [jobs, setJobs] = useState<Row[]>([])
  const [heartbeats, setHeartbeats] = useState<Row[]>([])
  const [health, setHealth] = useState<HealthJson | { error: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const healthBase = (import.meta.env.VITE_WORKER_HEALTH_URL || "").trim().replace(/\/$/, "")

  async function refresh() {
    setBusy(true)
    setErr(null)
    try {
      const [i, o, t, u, j, h] = await Promise.all([
        loadRows(PA_COLLECTIONS.inboundEvents),
        loadRows(PA_COLLECTIONS.outbound),
        loadRows(PA_COLLECTIONS.agentTurns),
        loadRows(PA_COLLECTIONS.users, 200),
        loadRows(PA_COLLECTIONS.scheduledJobs, 80, "dueAt"),
        loadRows(PA_COLLECTIONS.runtimeHeartbeats, 80, "lastSeenAt"),
      ])
      setInbound(i)
      setOutbound(o)
      setTurns(t)
      setUsers(u)
      setJobs(j)
      setHeartbeats(h)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!healthBase) {
      setHealth(null)
      return
    }
    let cancelled = false
    const run = () => {
      fetch(`${healthBase}/health`, { mode: "cors" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: HealthJson) => {
          if (!cancelled) setHealth(j)
        })
        .catch(() => {
          if (!cancelled) setHealth({ error: "unreachable" })
        })
    }
    run()
    const id = window.setInterval(run, 12_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [healthBase])

  const failures = useMemo(
    () =>
      [...inbound, ...outbound, ...turns]
        .filter((r) => r.status === "failed" || r.status === "dead_letter")
        .slice(0, 6),
    [inbound, outbound, turns]
  )
  const inboundStats = useMemo(() => {
    let pending = 0
    let processing = 0
    let failed = 0
    let deadLetter = 0
    for (const r of inbound) {
      const s = r.status
      if (s === "pending") pending++
      else if (s === "processing") processing++
      else if (s === "failed") failed++
      else if (s === "dead_letter") deadLetter++
    }
    const tone =
      deadLetter > 0 || failed > 0 ? "bad" : pending + processing > 0 ? "warn" : "good"
    return { pending, processing, failed, deadLetter, tone }
  }, [inbound])
  const outboundStats = useMemo(() => {
    let pending = 0
    let sending = 0
    let failed = 0
    let deadLetter = 0
    for (const r of outbound) {
      const s = r.status
      if (s === "pending") pending++
      else if (s === "sending") sending++
      else if (s === "failed") failed++
      else if (s === "dead_letter") deadLetter++
    }
    const tone =
      deadLetter > 0 || failed > 0 ? "bad" : pending + sending > 0 ? "warn" : "good"
    return { pending, sending, failed, deadLetter, tone }
  }, [outbound])
  const jobsStats = useMemo(() => {
    let pending = 0
    let processing = 0
    let failed = 0
    let deadLetter = 0
    for (const r of jobs) {
      const s = r.status
      if (s === "pending") pending++
      else if (s === "processing") processing++
      else if (s === "failed") failed++
      else if (s === "dead_letter") deadLetter++
    }
    const tone =
      deadLetter > 0 || failed > 0 ? "bad" : pending + processing > 0 ? "warn" : "good"
    return { pending, processing, failed, deadLetter, tone }
  }, [jobs])
  const healthStatus = healthLabel(health)

  return (
    <div className="page-stack">
      <header className="hero-panel">
        <div>
          <p className="eyebrow">PA Control Plane</p>
          <h1>Operator overview</h1>
          <p>
            One screen for live health, queue pressure, and the next places an operator should look.
          </p>
        </div>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          {busy ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      {err ? <div className="notice notice-bad">Error: {err}</div> : null}

      <section className="metric-grid">
        <article className="metric-card">
          <span className={`status-dot ${healthStatus.tone}`} />
          <p>Worker</p>
          <strong>{healthStatus.label}</strong>
          <small>{health && !("error" in health) ? `${health.uptimeSec ?? 0}s uptime` : "Set VITE_WORKER_HEALTH_URL for live health"}</small>
        </article>
        <article className="metric-card">
          <span className={`status-dot ${inboundStats.tone}`} />
          <p>Inbound queue</p>
          <strong>{inboundStats.pending}</strong>
          <small>
            {inboundStats.processing} processing · {inboundStats.failed} failed
            {inboundStats.deadLetter > 0 ? ` · ${inboundStats.deadLetter} dead letter` : ""}
          </small>
        </article>
        <article className="metric-card">
          <span className={`status-dot ${outboundStats.tone}`} />
          <p>Outbound queue</p>
          <strong>{outboundStats.pending}</strong>
          <small>
            {outboundStats.sending} sending · {outboundStats.failed} failed
            {outboundStats.deadLetter > 0 ? ` · ${outboundStats.deadLetter} dead letter` : ""}
          </small>
        </article>
        <article className="metric-card">
          <span className="status-dot good" />
          <p>Conversations</p>
          <strong>{users.length}</strong>
          <small>latest {formatAge(users[0]?.createdAt)}</small>
        </article>
        <article className="metric-card">
          <span className={`status-dot ${jobsStats.tone}`} />
          <p>Scheduled jobs</p>
          <strong>{jobsStats.pending}</strong>
          <small>
            {jobsStats.processing} processing · {jobsStats.failed} failed
            {jobsStats.deadLetter > 0 ? ` · ${jobsStats.deadLetter} dead letter` : ""}
          </small>
        </article>
        <article className="metric-card">
          <span className="status-dot good" />
          <p>Runtime heartbeats</p>
          <strong>{heartbeats.length}</strong>
          <small>latest {formatAge(heartbeats[0]?.lastSeenAt)}</small>
        </article>
      </section>

      <section className="split-grid">
        <article className="panel">
          <div className="section-title">
            <div>
              <p className="eyebrow">Needs attention</p>
              <h2>Recent failures</h2>
            </div>
            <Link to="/operations">Open operations</Link>
          </div>
          {failures.length === 0 ? (
            <p className="empty-copy">No recent failed or dead-lettered work in the latest sample.</p>
          ) : (
            <div className="event-list">
              {failures.map((r) => (
                <div className="event-row" key={`${String(r.status)}-${r.id}`}>
                  <div>
                    <strong>{String(r.status)}</strong>
                    <p>{String(r.lastError || r.error || r.deadLetterReason || "No error message")}</p>
                  </div>
                  <small>{formatAge(r.createdAt || r.updatedAt)}</small>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="panel">
          <div className="section-title">
            <div>
              <p className="eyebrow">Next action</p>
              <h2>Runbook shortcuts</h2>
            </div>
          </div>
          <div className="action-list">
            <Link to="/conversations">Review conversations</Link>
            <Link to="/operations">Inspect queues and turns</Link>
            <Link to="/agents">Check default agent</Link>
            <Link to="/playground">Run E2E lab</Link>
          </div>
        </article>
      </section>
    </div>
  )
}
