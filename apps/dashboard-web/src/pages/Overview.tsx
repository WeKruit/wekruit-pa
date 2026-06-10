import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, getDocs, limit, orderBy, query, where } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { db } from "../lib/firebase.js"
import { useWorkQueueCounts } from "../lib/work-queue-counts.js"
import { Icon } from "../components/console/Icon.js"
import {
  Card,
  EntityCard,
  HitlInboxRow,
  MetricStrip,
  PageHeader,
  PulseDot,
  SectionHead,
  StatusPill,
} from "../components/console/primitives.js"
import type { HitlRow } from "../components/console/primitives.js"

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

function shortAge(iso?: unknown): string {
  if (typeof iso !== "string" || !iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / (60 * 24))}d`
}

function healthLabel(
  health: HealthJson | { error: string } | null
): { label: string; tone: "live" | "hitl" | "blocked" | "neutral" } {
  if (!health) return { label: "not configured", tone: "neutral" }
  if ("error" in health) return { label: "unreachable", tone: "blocked" }
  if (health.ok && health.firebase && health.outboundListener && health.imessageReady) {
    return { label: "ready", tone: "live" }
  }
  return { label: "degraded", tone: "hitl" }
}

type TurnUsage = {
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  hostedToolCalls?: { name: string; count: number }[]
}
type TurnRow = Row & { usage?: TurnUsage; createdAt?: string }

function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return sorted[idx] ?? 0
}

function aggregateUsage(turns: TurnRow[]): {
  byModel: {
    model: string
    provider: string
    turns: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }[]
  toolCalls: { name: string; count: number }[]
  p95Input: number
  totalTurns: number
} {
  type Bucket = {
    model: string
    provider: string
    turns: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  const byKey = new Map<string, Bucket>()
  const toolCounts = new Map<string, number>()
  const inputs: number[] = []
  let totalTurns = 0
  for (const t of turns) {
    const u = t.usage
    if (!u) continue
    totalTurns++
    const provider = u.provider ?? "unknown"
    const model = u.model ?? "unknown"
    const key = `${provider}/${model}`
    const bucket: Bucket = byKey.get(key) ?? {
      model,
      provider,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
    bucket.turns++
    if (typeof u.inputTokens === "number") {
      bucket.inputTokens += u.inputTokens
      inputs.push(u.inputTokens)
    }
    if (typeof u.outputTokens === "number") bucket.outputTokens += u.outputTokens
    if (typeof u.totalTokens === "number") bucket.totalTokens += u.totalTokens
    byKey.set(key, bucket)
    for (const call of u.hostedToolCalls ?? []) {
      if (typeof call?.name !== "string" || typeof call.count !== "number") continue
      toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + call.count)
    }
  }
  const byModel = [...byKey.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  const toolCalls = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  return { byModel, toolCalls, p95Input: p95(inputs), totalTurns }
}

async function loadRows(collectionName: string, max = 80, orderField = "createdAt"): Promise<Row[]> {
  const snap = await getDocs(
    query(collection(db(), collectionName), orderBy(orderField, "desc"), limit(max))
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return "Late night"
  if (h < 12) return "Good morning"
  if (h < 17) return "Good afternoon"
  return "Good evening"
}

type TodayCardDef = {
  key: string
  label: string
  desc: string
  to: string
  cta: string
  count: number | null
}

function TodayCard({ card, onOpen }: { card: TodayCardDef; onOpen: (to: string) => void }) {
  const clear = card.count === 0
  const unknown = card.count === null
  return (
    <Card
      title={card.label}
      action={
        clear ? (
          <StatusPill tone="neutral">clear</StatusPill>
        ) : unknown ? (
          <StatusPill tone="neutral">unavailable</StatusPill>
        ) : (
          <StatusPill tone="hitl" dot>
            queue
          </StatusPill>
        )
      }
    >
      <div
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 28,
          letterSpacing: "-0.02em",
          lineHeight: 1.05,
          color: clear || unknown ? "var(--ink-3)" : "var(--ink)",
        }}
      >
        {unknown ? "—" : card.count!.toLocaleString()}
      </div>
      <div className="caption" style={{ marginTop: 6, color: "var(--ink-3)" }}>
        {card.desc}
      </div>
      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          className={`btn btn--sm ${clear || unknown ? "btn--ghost" : "btn--secondary"}`}
          onClick={() => onOpen(card.to)}
        >
          {card.cta}
          <Icon name="arrow_right" size={12} />
        </button>
      </div>
    </Card>
  )
}

export function Overview() {
  const navigate = useNavigate()
  const workQueue = useWorkQueueCounts()
  const [inbound, setInbound] = useState<Row[]>([])
  const [outbound, setOutbound] = useState<Row[]>([])
  const [turns, setTurns] = useState<Row[]>([])
  const [users, setUsers] = useState<Row[]>([])
  const [jobs, setJobs] = useState<Row[]>([])
  const [heartbeats, setHeartbeats] = useState<Row[]>([])
  const [usageTurns, setUsageTurns] = useState<TurnRow[]>([])
  const [health, setHealth] = useState<HealthJson | { error: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const healthBase = (import.meta.env.VITE_WORKER_HEALTH_URL || "").trim().replace(/\/$/, "")

  async function refresh() {
    setBusy(true)
    setErr(null)
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const turnsUsageSnap = getDocs(
        query(
          collection(db(), PA_COLLECTIONS.turns),
          where("createdAt", ">=", since),
          orderBy("createdAt", "desc"),
          limit(500)
        )
      )
      const [i, o, t, u, j, h, paTurnsSnap] = await Promise.all([
        loadRows(PA_COLLECTIONS.inboundEvents),
        loadRows(PA_COLLECTIONS.outbound),
        loadRows(PA_COLLECTIONS.agentTurns),
        loadRows(PA_COLLECTIONS.users, 200),
        loadRows(PA_COLLECTIONS.scheduledJobs, 80, "dueAt"),
        loadRows(PA_COLLECTIONS.runtimeHeartbeats, 80, "lastSeenAt"),
        turnsUsageSnap,
      ])
      setInbound(i)
      setOutbound(o)
      setTurns(t)
      setUsers(u)
      setJobs(j)
      setHeartbeats(h)
      setUsageTurns(
        paTurnsSnap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return { id: d.id, ...data } as TurnRow
        })
      )
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
    return { pending, processing, failed, deadLetter }
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
    return { pending, sending, failed, deadLetter }
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
    return { pending, processing, failed, deadLetter }
  }, [jobs])
  const usageStats = useMemo(() => aggregateUsage(usageTurns), [usageTurns])
  const healthStatus = healthLabel(health)

  const hitlRows: HitlRow[] = useMemo(() => {
    const rows: HitlRow[] = []
    for (const r of failures.slice(0, 6)) {
      const status = String(r.status)
      const type =
        status === "dead_letter"
          ? "outreach"
          : "id" in (r as Record<string, unknown>)
            ? "match"
            : "match"
      rows.push({
        id: r.id,
        type,
        object: String(r.lastError || r.error || r.deadLetterReason || "Failed event"),
        objectMeta: status,
        urgency: status === "dead_letter" ? "high" : "med",
        age: shortAge(r.createdAt || r.updatedAt),
      })
    }
    return rows
  }, [failures])

  const todayCards: TodayCardDef[] = [
    {
      key: "prescreen",
      label: "Prescreen review",
      desc: "Terminal PASS/FAIL calls waiting for an operator commit.",
      to: "/admin/prescreen-ops",
      cta: "Review prescreens",
      count: workQueue.prescreenPending,
    },
    {
      key: "identity",
      label: "Identity conflicts",
      desc: "Candidate identity merges that need a human call.",
      to: "/admin/identity-conflicts",
      cta: "Resolve conflicts",
      count: workQueue.identityOpen,
    },
    {
      key: "enrichment",
      label: "Enrichment review",
      desc: workQueue.enrichmentDraftsApprox
        ? "Drafts awaiting approval (latest-100 sample)."
        : "Job enrichment drafts awaiting approval.",
      to: "/admin/job-enrichment",
      cta: "Review drafts",
      count: workQueue.enrichmentDrafts,
    },
    {
      key: "recruiter",
      label: "Recruiter submissions",
      desc: "Fresh recruiter submissions to triage.",
      to: "/admin/recruiter-hub?tab=board",
      cta: "Open recruiter hub",
      count: workQueue.recruiterNew,
    },
    {
      key: "outbound",
      label: "Pending outbound",
      desc: "Drafted outbound messages waiting for approval.",
      to: "/admin/pending-outbound",
      cta: "Approve outbound",
      count: workQueue.pendingOutbound,
    },
    {
      key: "layoff",
      label: "Layoff signups",
      desc: "Employer signups pending verification.",
      to: "/admin/layoff-employers",
      cta: "Verify employers",
      count: workQueue.layoffPending,
    },
  ]
  const todayTotal = todayCards.reduce((n, c) => n + (c.count ?? 0), 0)

  return (
    <>
      <PageHeader
        eyebrow="PA Control Plane"
        title={`${greeting()} — operator overview`}
        subtitle="Live health, queue pressure, and the next places to look. Click any card to drill in."
        actions={
          <>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" size={12} />
              {busy ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => navigate("/operations")}
            >
              View ops queue
              <Icon name="arrow_right" size={12} />
            </button>
          </>
        }
      />

      {err ? (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: "var(--blocked-bg)",
            color: "var(--blocked)",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      ) : null}

      {/* Today — actionable work queues */}
      <div>
        <SectionHead
          title="Today"
          count={workQueue.loading ? undefined : todayTotal}
          actions={
            workQueue.loading ? (
              <span className="caption" style={{ color: "var(--ink-3)" }}>
                counting…
              </span>
            ) : undefined
          }
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 14,
          }}
        >
          {todayCards.map((card) => (
            <TodayCard key={card.key} card={card} onOpen={(to) => navigate(to)} />
          ))}
        </div>
      </div>

      {/* 4-up entity strip */}
      <div className="grid-4">
        <EntityCard
          icon="users"
          label="Conversations"
          hero={users.length}
          subs={[
            {
              value: heartbeats.length,
              label: "runtime heartbeats",
              tone: heartbeats.length > 0 ? "live" : "neutral",
            },
            { value: formatAge(users[0]?.createdAt), label: "latest" },
          ]}
          cta="Browse candidates"
          tone={users.length > 0 ? "live" : "neutral"}
          onClick={() => navigate("/conversations")}
        />
        <EntityCard
          icon="inbox"
          label="Inbound queue"
          hero={inboundStats.pending}
          heroUnit="pending"
          subs={[
            {
              value: inboundStats.processing,
              label: "processing",
              tone: inboundStats.processing > 0 ? "info" : "neutral",
            },
            {
              value: inboundStats.failed + inboundStats.deadLetter,
              label: "failed · dead-letter",
              tone:
                inboundStats.deadLetter > 0
                  ? "blocked"
                  : inboundStats.failed > 0
                    ? "hitl"
                    : "neutral",
            },
          ]}
          cta="Open ops queue"
          tone={
            inboundStats.deadLetter > 0 ? "blocked" : inboundStats.failed > 0 ? "hitl" : "live"
          }
          onClick={() => navigate("/operations")}
        />
        <EntityCard
          icon="send"
          label="Outbound queue"
          hero={outboundStats.pending}
          heroUnit="pending"
          subs={[
            {
              value: outboundStats.sending,
              label: "sending",
              tone: outboundStats.sending > 0 ? "info" : "neutral",
            },
            {
              value: outboundStats.failed + outboundStats.deadLetter,
              label: "failed · dead-letter",
              tone:
                outboundStats.deadLetter > 0
                  ? "blocked"
                  : outboundStats.failed > 0
                    ? "hitl"
                    : "neutral",
            },
          ]}
          cta="Outreach ops"
          tone={
            outboundStats.deadLetter > 0
              ? "blocked"
              : outboundStats.failed > 0
                ? "hitl"
                : "live"
          }
          onClick={() => navigate("/admin/outreach-ops")}
        />
        <EntityCard
          icon="clock"
          label="Scheduled jobs"
          hero={jobsStats.pending}
          heroUnit="due"
          subs={[
            {
              value: jobsStats.processing,
              label: "processing",
              tone: jobsStats.processing > 0 ? "info" : "neutral",
            },
            {
              value: jobsStats.failed + jobsStats.deadLetter,
              label: "failed · dead-letter",
              tone:
                jobsStats.deadLetter > 0
                  ? "blocked"
                  : jobsStats.failed > 0
                    ? "hitl"
                    : "neutral",
            },
          ]}
          cta="Open triggers"
          tone={
            jobsStats.deadLetter > 0 ? "blocked" : jobsStats.failed > 0 ? "hitl" : "live"
          }
          onClick={() => navigate("/triggers")}
        />
      </div>

      {/* Worker / health strip */}
      <MetricStrip
        items={[
          {
            label: "Worker",
            value: healthStatus.label,
            tone: healthStatus.tone,
            animated: healthStatus.tone === "live",
            sub:
              health && !("error" in health)
                ? `${health.uptimeSec ?? 0}s uptime`
                : "Set VITE_WORKER_HEALTH_URL for live health",
          },
          {
            label: "Firebase",
            value: health && !("error" in health) && health.firebase ? "ok" : "—",
            tone:
              health && !("error" in health) && health.firebase ? "live" : "neutral",
          },
          {
            label: "Outbound listener",
            value:
              health && !("error" in health) && health.outboundListener ? "ok" : "—",
            tone:
              health && !("error" in health) && health.outboundListener
                ? "live"
                : "neutral",
          },
          {
            label: "iMessage",
            value: health && !("error" in health) && health.imessageReady ? "ready" : "—",
            tone:
              health && !("error" in health) && health.imessageReady ? "live" : "neutral",
          },
        ]}
      />

      {/* HITL inbox · Live failures */}
      <div className="split-2">
        <div>
          <SectionHead
            title="Needs attention"
            count={hitlRows.length}
            actions={
              <Link
                to="/operations"
                className="btn btn--ghost btn--sm"
                style={{ textDecoration: "none" }}
              >
                Open queue
                <Icon name="arrow_right" size={12} />
              </Link>
            }
          />
          <Card padded={false}>
            {hitlRows.length === 0 ? (
              <div style={{ padding: 28, textAlign: "center", color: "var(--ink-3)" }}>
                Nothing failing in the latest sample. Inbox is clear.
              </div>
            ) : (
              hitlRows.map((row) => (
                <HitlInboxRow
                  key={row.id}
                  row={row}
                  onClick={() => navigate("/operations")}
                />
              ))
            )}
          </Card>
        </div>

        <div>
          <SectionHead
            title="Runbook"
            actions={<StatusPill tone="info">links</StatusPill>}
          />
          <Card padded={false}>
            <div className="feed">
              <Link
                to="/conversations"
                className="feed__item"
                style={{ textDecoration: "none" }}
              >
                <span className="feed__item-dot">
                  <PulseDot tone="live" size={6} />
                </span>
                <div>
                  <div className="feed__title">Review conversations</div>
                  <div className="feed__meta">Browse latest candidate threads</div>
                </div>
                <span className="feed__time">live</span>
              </Link>
              <Link
                to="/admin/match-debug"
                className="feed__item"
                style={{ textDecoration: "none" }}
              >
                <span className="feed__item-dot">
                  <PulseDot tone="hitl" size={6} />
                </span>
                <div>
                  <div className="feed__title">Match debug</div>
                  <div className="feed__meta">V16 cascade · score breakdown</div>
                </div>
                <span className="feed__time">tool</span>
              </Link>
              <Link
                to="/admin/external-supply"
                className="feed__item"
                style={{ textDecoration: "none" }}
              >
                <span className="feed__item-dot">
                  <PulseDot tone="info" size={6} />
                </span>
                <div>
                  <div className="feed__title">External supply</div>
                  <div className="feed__meta">Bulk intake · enrichment · outreach</div>
                </div>
                <span className="feed__time">flow</span>
              </Link>
              <Link
                to="/eval/n-round-sim"
                className="feed__item"
                style={{ textDecoration: "none" }}
              >
                <span className="feed__item-dot">
                  <PulseDot tone="info" size={6} />
                </span>
                <div>
                  <div className="feed__title">Run N-round sim</div>
                  <div className="feed__meta">Eval Claire against scenarios</div>
                </div>
                <span className="feed__time">eval</span>
              </Link>
              <Link
                to="/admin/canonical-tags"
                className="feed__item"
                style={{ textDecoration: "none" }}
              >
                <span className="feed__item-dot">
                  <PulseDot tone="neutral" size={6} />
                </span>
                <div>
                  <div className="feed__title">Canonical tags</div>
                  <div className="feed__meta">Promote sandbox → canonical</div>
                </div>
                <span className="feed__time">admin</span>
              </Link>
            </div>
          </Card>
        </div>
      </div>

      {/* Token + tool-call cost */}
      <div>
        <SectionHead
          title="Token + tool-call cost — last 24h"
          count={usageStats.totalTurns}
          actions={
            <span className="caption" style={{ color: "var(--ink-3)" }}>
              p95 input {usageStats.p95Input.toLocaleString()} tokens
            </span>
          }
        />
        {usageStats.totalTurns === 0 ? (
          <Card>
            <div style={{ padding: 12, color: "var(--ink-3)", fontSize: 13 }}>
              No pa_turns rows with usage in the last 24h. Check back after the next
              inbound turn.
            </div>
          </Card>
        ) : (
          <div className="grid-4">
            {usageStats.byModel.map((m) => (
              <Card key={`${m.provider}-${m.model}`} title={m.model}>
                <div
                  style={{
                    fontFamily: "var(--font-serif)",
                    fontSize: 28,
                    letterSpacing: "-0.02em",
                    color: "var(--ink)",
                    lineHeight: 1.05,
                  }}
                >
                  {m.totalTokens.toLocaleString()}
                </div>
                <div className="caption" style={{ marginTop: 6 }}>
                  {m.provider} · {m.turns} turn{m.turns === 1 ? "" : "s"} ·{" "}
                  {m.inputTokens.toLocaleString()} in / {m.outputTokens.toLocaleString()} out
                </div>
              </Card>
            ))}
            {usageStats.toolCalls.length === 0 ? (
              <Card title="Hosted tool calls">
                <div
                  style={{
                    fontFamily: "var(--font-serif)",
                    fontSize: 28,
                    color: "var(--ink-3)",
                  }}
                >
                  0
                </div>
                <div className="caption" style={{ marginTop: 6 }}>
                  no web_search / hosted tools fired
                </div>
              </Card>
            ) : (
              usageStats.toolCalls.map((tc) => (
                <Card key={`tool-${tc.name}`} title={`tool: ${tc.name}`}>
                  <div
                    style={{
                      fontFamily: "var(--font-serif)",
                      fontSize: 28,
                      letterSpacing: "-0.02em",
                      color: "var(--ink)",
                    }}
                  >
                    {tc.count.toLocaleString()}
                  </div>
                  <div className="caption" style={{ marginTop: 6 }}>
                    invocations (last 24h)
                  </div>
                </Card>
              ))
            )}
          </div>
        )}
      </div>
    </>
  )
}
