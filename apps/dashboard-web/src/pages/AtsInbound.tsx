/**
 * v1.9 Phase 86 — /admin/ats-inbound dashboard.
 *
 * Lists recent ATS inbound invites per source w/ status pills. Reads
 * pa-ats-invite-idempotency (each doc = one invite event).
 */
import { useEffect, useState } from "react"
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { db } from "../lib/firebase.js"

type Row = {
  id: string
  source: string
  jobIdExternal: string
  jobIdInternal?: string
  applicantId: string
  userId?: string
  sendOk?: boolean
  createdUser?: boolean
  result?: string
  updatedAt?: string
}

function statusTone(r: Row): "ok" | "warn" | "info" {
  if (r.result === "no_phone") return "warn"
  if (r.sendOk === false) return "warn"
  if (r.sendOk) return "ok"
  return "info"
}

function statusLabel(r: Row): string {
  if (r.result === "no_phone") return "no_phone"
  if (r.sendOk === false) return "send_failed"
  if (r.sendOk) return "invited"
  return "unknown"
}

export default function AtsInbound() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const q = query(
          collection(db(), "pa-ats-invite-idempotency"),
          orderBy("updatedAt", "desc"),
          limit(100)
        )
        const snap = await getDocs(q)
        if (cancelled) return
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Row, "id">) })))
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return <LoadingState label="Loading ATS inbound..." />
  if (err) return <ErrorState message={err} />

  return (
    <div>
      <PageHeader
        title="ATS Inbound"
        description="Recent applicant invites received via paAtsInboundWebhook. Each row = one external applicant resolution. Source pill shows which ATS adapter dispatched."
      />
      <Panel title={`${rows.length} invite event(s)`}>
        {rows.length === 0 && (
          <p style={{ opacity: 0.7, fontSize: "0.9em" }}>
            No ATS inbound yet. Adapters wired:{" "}
            <Badge tone="ok">handshake</Badge>{" "}
            <Badge tone="info">greenhouse (stub)</Badge>{" "}
            <Badge tone="info">lever (stub)</Badge>{" "}
            <Badge tone="info">linkedin (stub)</Badge>
          </p>
        )}
        {rows.length > 0 && (
          <table style={{ width: "100%", fontSize: "0.85em", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(0,0,0,0.15)" }}>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Updated</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Source</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Status</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Ext. Job</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Int. Job</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>Applicant</th>
                <th style={{ textAlign: "left", padding: "0.25rem" }}>User</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
                  <td style={{ padding: "0.25rem", fontFamily: "monospace", fontSize: "0.85em" }}>
                    {r.updatedAt?.slice(0, 16)}
                  </td>
                  <td style={{ padding: "0.25rem" }}>
                    <Badge tone="info">{r.source}</Badge>
                  </td>
                  <td style={{ padding: "0.25rem" }}>
                    <Badge tone={statusTone(r)}>
                      {statusLabel(r)}
                      {r.createdUser ? " · new" : ""}
                    </Badge>
                  </td>
                  <td style={{ padding: "0.25rem", fontFamily: "monospace", fontSize: "0.8em" }}>
                    {r.jobIdExternal}
                  </td>
                  <td style={{ padding: "0.25rem", fontFamily: "monospace", fontSize: "0.8em" }}>
                    {r.jobIdInternal ?? "—"}
                  </td>
                  <td style={{ padding: "0.25rem", fontFamily: "monospace", fontSize: "0.8em" }}>
                    {r.applicantId}
                  </td>
                  <td style={{ padding: "0.25rem", fontFamily: "monospace", fontSize: "0.75em" }}>
                    {r.userId ? `${r.userId.slice(0, 8)}…` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
