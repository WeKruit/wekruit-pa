/**
 * /admin/yc-intake — the YC Startup School event operator queue (Adam
 * 2026-07-21: Claire promises founder matches "tonight around 7pm"; the TEAM
 * sends them from here, one click per attendee).
 *
 * Reads `paAdminYcIntakeToday` (ready = intake complete → tonight's sends;
 * incomplete = stragglers for visibility) and fires `paAdminYcSendMatches`
 * per user (backend guards: yc source, intake complete, once per day).
 */
import { useCallback, useEffect, useState } from "react"
import { httpsCallable } from "firebase/functions"
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { functions } from "../lib/firebase.js"

interface YcIntakeRow {
  userId: string
  displayName: string | null
  phoneTail: string | null
  building: string | null
  wantsToMeet: string | null
  completedAt: string | null
  linkedinEnriched: boolean
  createdAt: string | null
  ycEveningMatchSentAt: string | null
}

interface YcIntakeTodayResult {
  ok: true
  ready: YcIntakeRow[]
  incomplete: YcIntakeRow[]
  scanned: number
  truncated: boolean
}

export default function YcIntake() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<YcIntakeTodayResult | null>(null)
  const [sending, setSending] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const fn = httpsCallable<Record<string, never>, YcIntakeTodayResult>(
        functions(),
        "paAdminYcIntakeToday",
      )
      const res = await fn({})
      setData(res.data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sendMatches = useCallback(
    async (userId: string) => {
      setSending((s) => ({ ...s, [userId]: "sending" }))
      try {
        const fn = httpsCallable<{ userId: string }, { ok: boolean; reason?: string }>(
          functions(),
          "paAdminYcSendMatches",
        )
        const res = await fn({ userId })
        setSending((s) => ({
          ...s,
          [userId]: res.data.ok ? "sent" : (res.data.reason ?? "failed"),
        }))
        if (res.data.ok) void load()
      } catch (e) {
        setSending((s) => ({ ...s, [userId]: e instanceof Error ? e.message : "failed" }))
      }
    },
    [load],
  )

  if (loading && !data) return <LoadingState label="Loading YC intake queue…" />
  if (err) return <ErrorState message={err} />

  const ready = data?.ready ?? []
  const incomplete = data?.incomplete ?? []

  const renderRow = (row: YcIntakeRow, showSend: boolean) => {
    const state = sending[row.userId]
    const sentToday =
      row.ycEveningMatchSentAt &&
      row.ycEveningMatchSentAt.slice(0, 10) === new Date().toISOString().slice(0, 10)
    return (
      <div
        key={row.userId}
        style={{
          display: "grid",
          gap: 6,
          padding: "12px 0",
          borderBottom: "1px solid var(--border, #E3D6C3)",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <strong>{row.displayName ?? "(no name yet)"}</strong>
          {row.phoneTail ? <Badge tone="muted">…{row.phoneTail}</Badge> : null}
          {row.linkedinEnriched ? <Badge tone="ok">LinkedIn ✓</Badge> : <Badge tone="muted">no LinkedIn</Badge>}
          {sentToday ? <Badge tone="ok">sent today</Badge> : null}
        </div>
        {row.building ? (
          <div style={{ fontSize: 13 }}>
            <strong>Building:</strong> {row.building}
          </div>
        ) : null}
        {row.wantsToMeet ? (
          <div style={{ fontSize: 13 }}>
            <strong>Wants to meet:</strong> {row.wantsToMeet}
          </div>
        ) : null}
        {showSend ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="btn btn--primary"
              disabled={state === "sending" || state === "sent" || Boolean(sentToday)}
              onClick={() => void sendMatches(row.userId)}
            >
              {state === "sending" ? "Sending…" : sentToday || state === "sent" ? "Sent" : "Send matches now"}
            </button>
            {state && state !== "sending" && state !== "sent" ? (
              <span style={{ fontSize: 12, color: "var(--danger, #9A3B2A)" }}>{state}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="YC Startup School intake"
        description={`Tonight's send queue — Claire promised founder matches around 7PM. ${ready.length} ready · ${incomplete.length} still in intake.`}
      />
      <Panel title={`Ready to send (${ready.length})`}>
        {ready.length === 0 ? (
          <EmptyState title="Nothing ready" body="Nobody has completed the event intake yet today." />
        ) : (
          ready.map((r) => renderRow(r, true))
        )}
      </Panel>
      <Panel title={`Still in intake (${incomplete.length})`}>
        {incomplete.length === 0 ? (
          <EmptyState title="No stragglers" body="Everyone who scanned has finished the intake." />
        ) : (
          incomplete.map((r) => renderRow(r, false))
        )}
      </Panel>
    </div>
  )
}
