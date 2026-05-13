/**
 * v2.0 External Supply V1 — Wave D — `/admin/external-supply/sync`.
 *
 * Per-record state for `pa-instantly-sync-records` and last events per plan.
 * Click row → drawer with sync details + last few `pa-outreach-events` for
 * that plan (reply / bounce / unsubscribe).
 */
import { useEffect, useState } from "react"
import type { InstantlySyncRecord, OutreachEvent } from "@pa/core-types"
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import { InstantlySyncStateChip } from "../../components/external-supply/InstantlySyncStateChip.js"
import {
  listInstantlySyncRecords,
  listOutreachEvents,
} from "../../lib/external-supply-client.js"

export function Sync() {
  const [records, setRecords] = useState<InstantlySyncRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedSyncId, setSelectedSyncId] = useState<string | null>(null)
  const [planEvents, setPlanEvents] = useState<OutreachEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listInstantlySyncRecords({ limit: 100 })
      .then((res) => {
        if (!cancelled) setRecords(res.rows)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const selected = records.find((r) => r.syncId === selectedSyncId) ?? null

  useEffect(() => {
    if (!selected) {
      setPlanEvents([])
      return
    }
    let cancelled = false
    setEventsLoading(true)
    listOutreachEvents({ planId: selected.planId, limit: 50 })
      .then((res) => {
        if (!cancelled) setPlanEvents(res.rows)
      })
      .catch(() => {
        if (!cancelled) setPlanEvents([])
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected?.planId, selected?.syncId])

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V1 / Admin"
        title="Instantly sync"
        description="Per-plan sync records (dry-run / live / suppressed / failed). Click a row to see recent reply / bounce / unsubscribe events."
        actions={
          <button type="button" onClick={() => setRefreshKey((n) => n + 1)} style={secondaryBtnStyle}>
            Refresh
          </button>
        }
      />

      {error && <ErrorState message={error} />}

      <div style={twoColStyle}>
        <Panel
          title={`Sync records (${records.length})`}
          eyebrow="pa-instantly-sync-records · ordered by createdAt desc"
        >
          {loading && records.length === 0 ? (
            <LoadingState label="Loading sync records…" />
          ) : records.length === 0 ? (
            <EmptyState
              title="No syncs"
              body="Approved plans appear here after dry-run or live sync."
            />
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                  <th style={thStyle}>When</th>
                  <th style={thStyle}>Mode</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Plan</th>
                  <th style={thStyle}>Lead ID</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr
                    key={r.syncId}
                    onClick={() => setSelectedSyncId(r.syncId)}
                    style={{
                      cursor: "pointer",
                      borderBottom: "1px solid #f1f5f9",
                      background: r.syncId === selectedSyncId ? "#eff6ff" : "transparent",
                    }}
                  >
                    <td style={{ ...tdStyle, fontSize: "0.8em", color: "#64748b" }}>
                      {r.createdAt.slice(0, 19).replace("T", " ")}
                    </td>
                    <td style={tdStyle}>
                      <span className={`status-badge ${r.mode === "live" ? "warn" : "muted"}`}>{r.mode}</span>
                    </td>
                    <td style={tdStyle}>
                      <InstantlySyncStateChip status={r.syncStatus} />
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }}>
                      {r.planId.slice(0, 8)}…
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8em" }}>
                      {r.instantlyLeadId ? r.instantlyLeadId.slice(0, 14) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title={selected ? `Sync ${selected.syncId.slice(0, 8)}…` : "Select a sync record"}
          eyebrow={selected?.syncStatus ?? ""}
        >
          {!selected ? (
            <EmptyState
              title="No record selected"
              body="Click a row on the left to see its dry-run payload + recent events."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: "0.85em" }}>
                <div>
                  candidate: <code>{selected.candidateId}</code>
                </div>
                <div>
                  job: <code>{selected.jobId}</code>
                </div>
                <div>
                  company: <code>{selected.companyId}</code>
                </div>
                {selected.listId && (
                  <div>
                    list: <code>{selected.listId}</code>
                  </div>
                )}
                {selected.campaignId && (
                  <div>
                    campaign: <code>{selected.campaignId}</code>
                  </div>
                )}
                {selected.instantlyLeadId && (
                  <div>
                    leadId: <code>{selected.instantlyLeadId}</code>
                  </div>
                )}
                {selected.error && (
                  <div style={{ color: "#dc2626" }}>
                    error: <code>{selected.error}</code>
                  </div>
                )}
              </div>

              {selected.dryRunPayload && (
                <details>
                  <summary style={{ cursor: "pointer", fontWeight: 600 }}>Dry-run payload</summary>
                  <pre style={preStyle}>{JSON.stringify(selected.dryRunPayload, null, 2)}</pre>
                </details>
              )}

              <Panel title={`Recent events (${planEvents.length})`} eyebrow="pa-outreach-events">
                {eventsLoading ? (
                  <LoadingState label="Loading events…" />
                ) : planEvents.length === 0 ? (
                  <EmptyState
                    title="No events"
                    body="No reply / bounce / unsubscribe events have landed for this plan yet."
                  />
                ) : (
                  <table style={tableStyle}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                        <th style={thStyle}>Occurred</th>
                        <th style={thStyle}>Kind</th>
                        <th style={thStyle}>Provider</th>
                      </tr>
                    </thead>
                    <tbody>
                      {planEvents.map((ev) => (
                        <tr key={ev.eventId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                          <td style={{ ...tdStyle, fontSize: "0.8em" }}>
                            {ev.occurredAt.slice(0, 19).replace("T", " ")}
                          </td>
                          <td style={tdStyle}>
                            <span className={`status-badge ${eventTone(ev.kind)}`}>{ev.kind}</span>
                          </td>
                          <td style={{ ...tdStyle, fontSize: "0.8em", color: "#64748b" }}>
                            {ev.provider}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}

function eventTone(kind: OutreachEvent["kind"]): string {
  if (kind === "email_replied" || kind === "candidate_interested" || kind === "manual_linkedin_replied") {
    return "good"
  }
  if (
    kind === "email_bounced" ||
    kind === "email_unsubscribed" ||
    kind === "email_marked_spam" ||
    kind === "candidate_declined"
  ) {
    return "bad"
  }
  return "muted"
}

const twoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12,
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "0.85em",
  borderCollapse: "collapse",
}
const thStyle: React.CSSProperties = { padding: "0.5rem 0" }
const tdStyle: React.CSSProperties = { padding: "0.4rem 0" }

const preStyle: React.CSSProperties = {
  background: "#f8fafc",
  padding: "0.75rem",
  borderRadius: 4,
  fontSize: "0.75em",
  overflowX: "auto",
  maxHeight: 320,
}

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  color: "#1f2937",
  padding: "0.5rem 1rem",
  borderRadius: 4,
  cursor: "pointer",
}
