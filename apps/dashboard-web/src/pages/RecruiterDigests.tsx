import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react"
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import {
  fetchRecruiterDigests,
  sendRecruiterDigests,
  type RecruiterDigest,
  type RecruiterDigestPreviewItem,
} from "../lib/recruiter-platform-api.js"

const DUE_DAYS = 3

const chip: CSSProperties = {
  display: "inline-flex",
  flexDirection: "column",
  gap: 2,
  padding: "8px 12px",
  background: "var(--surface-2, #f5f4ef)",
  borderRadius: 8,
  minWidth: 92,
}
const chipNum: CSSProperties = { fontSize: 20, fontWeight: 600, lineHeight: 1.1 }
const chipLbl: CSSProperties = { fontSize: 12, opacity: 0.7 }
const btn: CSSProperties = {
  padding: "7px 14px",
  borderRadius: 8,
  border: "1px solid var(--border, rgba(0,0,0,0.15))",
  background: "transparent",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
}
const btnPrimary: CSSProperties = { ...btn, background: "#185fa5", color: "#fff", border: "1px solid #185fa5" }

function lastSentLabel(item: RecruiterDigestPreviewItem): string {
  if (item.daysSinceSent === null) return "Never sent"
  if (item.daysSinceSent === 0) return "Sent today"
  return `Sent ${item.daysSinceSent} day${item.daysSinceSent === 1 ? "" : "s"} ago`
}

function isDue(item: RecruiterDigestPreviewItem): boolean {
  return item.daysSinceSent === null || item.daysSinceSent >= DUE_DAYS
}

function DraftPreview({ digest }: { digest: RecruiterDigest }) {
  const s = digest.stats
  return (
    <div style={{ marginTop: 12, padding: "14px 16px", border: "1px solid var(--border, rgba(0,0,0,0.12))", borderRadius: 10 }}>
      <div style={{ fontSize: 13, opacity: 0.65, marginBottom: 4 }}>Subject</div>
      <div style={{ fontWeight: 500, marginBottom: 12 }}>
        Your WeKruit pipeline — {s.newSubmitted} new in {digest.windowDays} days
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <span style={chip}><span style={chipNum}>{s.newSubmitted}</span><span style={chipLbl}>New submitted</span></span>
        <span style={chip}><span style={chipNum}>{s.intoInterview}</span><span style={chipLbl}>Into interview</span></span>
        <span style={chip}><span style={chipNum}>{s.advanced}</span><span style={chipLbl}>Advanced</span></span>
        <span style={chip}><span style={chipNum}>{s.closed}</span><span style={chipLbl}>Closed out</span></span>
      </div>
      <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 12 }}>
        Active now: <strong>{s.activeNow} in motion</strong> · {s.inInterviewNow} in interview · {s.withClientNow} with client · {s.hiredLifetime} hired all-time · {s.lifetimeTotal} submitted all-time
      </div>
      {digest.coaching.topReasons.length > 0 && (
        <div style={{ fontSize: 13.5, background: "#fbf6e9", borderLeft: "3px solid #ba7517", padding: "10px 12px", color: "#633806", marginBottom: 12 }}>
          <strong>Why most closed:</strong>{" "}
          {digest.coaching.topReasons.map((r) => `${r.label} (${r.count})`).join(", ")}.
          {digest.coaching.tip ? ` ${digest.coaching.tip}` : ""}
        </div>
      )}
      <div style={{ fontSize: 13, fontWeight: 500, opacity: 0.7, marginBottom: 4 }}>New roles — last 2 weeks ({digest.newRoles.length})</div>
      <ul style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 14 }}>
        {digest.newRoles.map((r) => (
          <li key={r.jobId}>{r.title} <span style={{ opacity: 0.6 }}>— {r.company} · {r.location}</span></li>
        ))}
        {digest.newRoles.length === 0 && <li style={{ opacity: 0.6 }}>None opened recently</li>}
      </ul>
      <div style={{ fontSize: 13, fontWeight: 500, opacity: 0.7, marginBottom: 4 }}>Highest-priority roles ({digest.priorityRoles.length})</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
        {digest.priorityRoles.map((r) => (
          <li key={r.jobId}>
            <strong style={{ color: r.tier === "urgent" ? "#791f1f" : "#633806" }}>[{(r.tier ?? "").toUpperCase()}]</strong>{" "}
            {r.title} <span style={{ opacity: 0.6 }}>— {r.company} · {r.location}</span>
          </li>
        ))}
        {digest.priorityRoles.length === 0 && <li style={{ opacity: 0.6 }}>None flagged</li>}
      </ul>
    </div>
  )
}

export default function RecruiterDigests() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<RecruiterDigestPreviewItem[]>([])
  const [windowDays, setWindowDays] = useState(3)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchRecruiterDigests()
      setItems(res.recruiters)
      setWindowDays(res.windowDays)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load digests")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const dueCount = useMemo(() => items.filter(isDue).length, [items])
  const sendableCount = useMemo(() => items.filter((i) => i.digest.recruiterEmail).length, [items])

  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 4000) }

  const send = useCallback(async (recruiterIds: string[] | "all") => {
    const ids = recruiterIds === "all" ? items.filter((i) => i.digest.recruiterEmail).map((i) => i.digest.recruiterId) : recruiterIds
    if (recruiterIds === "all" && !window.confirm(`Send the digest to ${ids.length} recruiter${ids.length === 1 ? "" : "s"} now?`)) return
    setSending((prev) => new Set([...prev, ...ids]))
    try {
      const res = recruiterIds === "all"
        ? await sendRecruiterDigests({ all: true })
        : await sendRecruiterDigests({ recruiterIds: ids })
      const failed = res.results.filter((r) => !r.ok)
      flash(failed.length ? `Sent ${res.sent}/${res.total} — ${failed.length} failed (${failed[0]?.reason ?? "error"})` : `Sent ${res.sent} digest${res.sent === 1 ? "" : "s"}`)
      await load()
    } catch (e) {
      flash(e instanceof Error ? e.message : "Send failed")
    } finally {
      setSending((prev) => { const n = new Set(prev); ids.forEach((id) => n.delete(id)); return n })
    }
  }, [items, load])

  const toggle = (id: string) => setExpanded((prev) => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })

  return (
    <>
      <PageHeader
        eyebrow="Recruiter platform"
        title="Recruiter digests"
        description={`Pipeline summary + new and priority roles, every ${windowDays} days. Nothing sends automatically — review each draft and press send.`}
        actions={
          <button style={btnPrimary} disabled={loading || sendableCount === 0 || sending.size > 0} onClick={() => void send("all")}>
            {sending.size > 0 ? "Sending…" : `Send all (${sendableCount})`}
          </button>
        }
      />

      {toast && <div style={{ margin: "0 0 12px", padding: "10px 14px", background: "#e1f5ee", color: "#0f6e56", borderRadius: 8, fontSize: 14 }}>{toast}</div>}

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <LoadingState label="Loading recruiter digests…" />
      ) : items.length === 0 ? (
        <EmptyState title="No recruiters yet" body="Recruiter digests appear here once recruiters have claimed access." />
      ) : (
        <>
          {dueCount > 0 && (
            <div style={{ margin: "0 0 16px", padding: "12px 16px", background: "#faeeda", color: "#633806", borderRadius: 10, fontSize: 14 }}>
              <strong>{dueCount} recruiter{dueCount === 1 ? "" : "s"} due</strong> — ≥{DUE_DAYS} days since last digest (or never sent). Reminder only; nothing was sent.
            </div>
          )}
          <Panel title={`Recruiters (${items.length})`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {items.map((item) => {
                const d = item.digest
                const open = expanded.has(d.recruiterId)
                const busy = sending.has(d.recruiterId)
                const noEmail = !d.recruiterEmail
                return (
                  <div key={d.recruiterId} style={{ border: "1px solid var(--border, rgba(0,0,0,0.12))", borderRadius: 12, padding: "14px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 500 }}>{d.recruiterName}</div>
                        <div style={{ fontSize: 13, opacity: 0.65 }}>{d.recruiterEmail || "no email on file"}</div>
                      </div>
                      <Badge tone={isDue(item) ? "warn" : "muted"}>{lastSentLabel(item)}</Badge>
                      <span style={{ fontSize: 13, opacity: 0.75 }}>
                        {d.stats.newSubmitted} new · {d.stats.activeNow} active · {d.stats.closed} closed
                      </span>
                      <button style={btn} onClick={() => toggle(d.recruiterId)}>{open ? "Hide draft" : "See draft"}</button>
                      <button
                        style={btnPrimary}
                        disabled={busy || noEmail}
                        title={noEmail ? "No recruiter email on file" : undefined}
                        onClick={() => void send([d.recruiterId])}
                      >
                        {busy ? "Sending…" : "Send"}
                      </button>
                    </div>
                    {open && <DraftPreview digest={d} />}
                  </div>
                )
              })}
            </div>
          </Panel>
        </>
      )}
    </>
  )
}
