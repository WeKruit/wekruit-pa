/**
 * /admin/pending-outbound — batch human-approve-then-send queue.
 *
 * Lists `pa-pending-outbound` rows (grouped by reasonCode), shows the draft
 * body + whyQueued + suppressed badge, and supports per-row edit / approve /
 * skip plus BATCH "approve selected" and a rolling "send approved" pass.
 *
 * SAFETY (mirrors the server gate):
 *  - Suppressed rows are never selectable and never sendable.
 *  - The live Sendblue dispatch is server-GATED and currently NOT wired, so a
 *    `send` comes back `blocked` with reason "send_not_wired". The UI surfaces
 *    every outcome and never assumes a message was delivered.
 *  - "Send approved" is an explicit, deliberate human click — there is no
 *    auto-send anywhere on this page.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import {
  approvePendingOutbound,
  listPendingOutbound,
  sendPendingOutbound,
  skipPendingOutbound,
  updatePendingOutboundDraft,
  type PendingOutboundRow,
  type PendingOutboundStatus,
  type SendOutcome,
} from "../lib/pending-outbound-api.js"
import {
  approvableFromSelection,
  groupByReasonCode,
  isBatchSelectable,
  isSendable,
  sendReasonLabel,
  sendableFromSelection,
  statusTone,
  summarize,
} from "./PendingOutbound.helpers.js"

type Api = {
  list: typeof listPendingOutbound
  update: typeof updatePendingOutboundDraft
  approve: typeof approvePendingOutbound
  skip: typeof skipPendingOutbound
  send: typeof sendPendingOutbound
}

const PROD_API: Api = {
  list: listPendingOutbound,
  update: updatePendingOutboundDraft,
  approve: approvePendingOutbound,
  skip: skipPendingOutbound,
  send: sendPendingOutbound,
}

const STATUS_FILTERS: Array<{ label: string; value: PendingOutboundStatus | "all" }> = [
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
  { label: "Sent", value: "sent" },
  { label: "Skipped", value: "skipped" },
  { label: "Failed", value: "failed" },
  { label: "All", value: "all" },
]

export default function PendingOutbound({ api = PROD_API }: { api?: Api }) {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<PendingOutboundRow[]>([])
  const [statusFilter, setStatusFilter] = useState<PendingOutboundStatus | "all">("pending")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const [outcomes, setOutcomes] = useState<SendOutcome[]>([])

  const reload = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const fetched = await api.list(
        statusFilter === "all" ? null : statusFilter,
        300
      )
      setRows(fetched)
      setSelected(new Set())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [api, statusFilter])

  useEffect(() => {
    void reload()
  }, [reload])

  const groups = useMemo(() => groupByReasonCode(rows), [rows])
  const stats = useMemo(() => summarize(rows), [rows])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const patchRow = (doc: PendingOutboundRow) =>
    setRows((prev) => prev.map((r) => (r.id === doc.id ? doc : r)))

  const onApprove = async (id: string) => {
    setBusyId(id)
    try {
      patchRow(await api.approve(id))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const onSkip = async (id: string) => {
    setBusyId(id)
    try {
      patchRow(await api.skip(id))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const onSaveEdit = async () => {
    if (!editId) return
    setBusyId(editId)
    try {
      patchRow(await api.update(editId, editText))
      setEditId(null)
      setEditText("")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const onSendOne = async (id: string) => {
    setBusyId(id)
    try {
      const outcome = await api.send(id)
      patchRow(outcome.row)
      setOutcomes((prev) => [outcome, ...prev].slice(0, 50))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  // BATCH — approve every selected pending (non-suppressed) row.
  const onApproveSelected = async () => {
    const targets = approvableFromSelection(rows, selected)
    if (targets.length === 0) return
    setBatchBusy(true)
    try {
      for (const row of targets) {
        // eslint-disable-next-line no-await-in-loop
        patchRow(await api.approve(row.id))
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBatchBusy(false)
    }
  }

  // BATCH — rolling (one-at-a-time) send of approved+non-suppressed rows in the
  // current selection. Explicit human click only. Every outcome is recorded;
  // the server may decline (blocked) without dispatching.
  const onSendApproved = async () => {
    const targets = sendableFromSelection(rows, selected)
    if (targets.length === 0) return
    const proceed = window.confirm(
      `Send ${targets.length} approved message(s)? Suppressed/opted-out recipients are blocked server-side and never receive anything. The live Sendblue dispatch is currently gated (not wired) — sends will report blocked until wiring is enabled.`
    )
    if (!proceed) return
    setBatchBusy(true)
    try {
      const collected: SendOutcome[] = []
      for (const row of targets) {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await api.send(row.id)
        patchRow(outcome.row)
        collected.push(outcome)
      }
      setOutcomes((prev) => [...collected.reverse(), ...prev].slice(0, 50))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBatchBusy(false)
    }
  }

  const selectedApprovable = approvableFromSelection(rows, selected).length
  const selectedSendable = sendableFromSelection(rows, selected).length

  if (loading) return <LoadingState label="Loading pending outbound..." />
  if (err) return <ErrorState message={err} />

  return (
    <div>
      <PageHeader
        eyebrow="Outreach · HITL"
        title="Pending Outbound"
        description="Human-approve-then-send queue. Edit drafts, approve, and send in rolling batches. Suppressed recipients are blocked server-side."
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as PendingOutboundStatus | "all")
              }
            >
              {STATUS_FILTERS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void reload()}>
              Refresh
            </button>
          </div>
        }
      />

      <div className="notice notice-warn" style={{ marginBottom: "1rem" }}>
        Live Sendblue dispatch is <strong>gated and not yet wired</strong>. The{" "}
        <em>Send</em> actions exercise every approval + suppression + opt-out
        gate, but the actual send returns <code>blocked: send_not_wired</code>{" "}
        until the dispatch seam is deliberately enabled. No message can fire
        without an explicit human click.
      </div>

      <Panel
        title={`${stats.total} row(s) · ${stats.pending} pending · ${stats.approved} approved · ${stats.suppressed} suppressed`}
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              disabled={batchBusy || selectedApprovable === 0}
              onClick={() => void onApproveSelected()}
            >
              Approve selected ({selectedApprovable})
            </button>
            <button
              type="button"
              disabled={batchBusy || selectedSendable === 0}
              onClick={() => void onSendApproved()}
              title="Rolling send of approved, non-suppressed rows in the selection"
            >
              Send approved ({selectedSendable})
            </button>
          </div>
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            title="Queue is empty"
            body={`No ${statusFilter === "all" ? "" : statusFilter} pending-outbound rows.`}
          />
        ) : (
          groups.map((group) => (
            <div key={group.reasonCode} style={{ marginBottom: "1.5rem" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <h3 style={{ margin: 0, fontFamily: "monospace" }}>
                  {group.reasonCode}
                </h3>
                <Badge tone="muted">{group.rows.length}</Badge>
                {group.sendableCount > 0 && (
                  <Badge tone="info">{group.sendableCount} sendable</Badge>
                )}
                {group.suppressedCount > 0 && (
                  <Badge tone="warn">{group.suppressedCount} suppressed</Badge>
                )}
              </div>
              {group.rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  busy={busyId === row.id || batchBusy}
                  selected={selected.has(row.id)}
                  editing={editId === row.id}
                  editText={editText}
                  onToggle={() => toggle(row.id)}
                  onApprove={() => void onApprove(row.id)}
                  onSkip={() => void onSkip(row.id)}
                  onSend={() => void onSendOne(row.id)}
                  onBeginEdit={() => {
                    setEditId(row.id)
                    setEditText(row.draftBody)
                  }}
                  onCancelEdit={() => {
                    setEditId(null)
                    setEditText("")
                  }}
                  onChangeEdit={setEditText}
                  onSaveEdit={() => void onSaveEdit()}
                />
              ))}
            </div>
          ))
        )}
      </Panel>

      {outcomes.length > 0 && (
        <Panel title="Send outcomes (most recent first)">
          <table style={{ width: "100%", fontSize: "0.9em" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Row</th>
                <th style={{ textAlign: "left" }}>Result</th>
                <th style={{ textAlign: "left" }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((o, i) => (
                <tr key={`${o.id}-${i}`}>
                  <td style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
                    {o.id}
                  </td>
                  <td>
                    <Badge tone={o.ok ? "ok" : o.blocked ? "warn" : "warn"}>
                      {o.ok ? "sent" : o.blocked ? "blocked" : "failed"}
                    </Badge>
                  </td>
                  <td>{sendReasonLabel(o.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  )
}

function Row({
  row,
  busy,
  selected,
  editing,
  editText,
  onToggle,
  onApprove,
  onSkip,
  onSend,
  onBeginEdit,
  onCancelEdit,
  onChangeEdit,
  onSaveEdit,
}: {
  row: PendingOutboundRow
  busy: boolean
  selected: boolean
  editing: boolean
  editText: string
  onToggle: () => void
  onApprove: () => void
  onSkip: () => void
  onSend: () => void
  onBeginEdit: () => void
  onCancelEdit: () => void
  onChangeEdit: (v: string) => void
  onSaveEdit: () => void
}) {
  const selectable = isBatchSelectable(row)
  const sendable = isSendable(row)
  return (
    <div
      style={{
        padding: "0.75rem",
        margin: "0.5rem 0",
        background: row.suppressed ? "#fff4f4" : "#fffaf0",
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={selected}
          disabled={!selectable}
          onChange={onToggle}
          aria-label={`select ${row.id}`}
        />
        <Badge tone={statusTone(row.status)}>{row.status}</Badge>
        <Badge tone="muted">{row.kind}</Badge>
        {row.suppressed && (
          <Badge tone="warn">
            suppressed{row.suppressedReason ? `: ${row.suppressedReason}` : ""}
          </Badge>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "monospace", fontSize: "0.78em", opacity: 0.6 }}>
          {row.userId}
        </span>
      </div>

      <div style={{ fontSize: "0.8em", opacity: 0.7, marginBottom: 6 }}>
        Why queued: {row.whyQueued}
        {row.toE164 ? ` · ${row.toE164}` : " · (no handle)"} · {row.channel}
      </div>

      {editing ? (
        <div>
          <textarea
            value={editText}
            onChange={(e) => onChangeEdit(e.target.value)}
            rows={3}
            style={{ width: "100%", fontFamily: "inherit" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button type="button" disabled={busy || !editText.trim()} onClick={onSaveEdit}>
              Save draft
            </button>
            <button type="button" onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div
          style={{
            whiteSpace: "pre-wrap",
            padding: "0.5rem",
            background: "rgba(0,0,0,0.03)",
            borderRadius: 8,
            marginBottom: 6,
          }}
        >
          {row.draftBody}
        </div>
      )}

      {row.sendError && (
        <div className="notice notice-bad" style={{ fontSize: "0.8em" }}>
          Send error: {row.sendError}
        </div>
      )}

      {!editing && (
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button
            type="button"
            disabled={busy || row.status !== "pending"}
            onClick={onBeginEdit}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={busy || row.status !== "pending"}
            onClick={onApprove}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy || row.status === "sent" || row.status === "skipped"}
            onClick={onSkip}
          >
            Skip
          </button>
          <button
            type="button"
            disabled={busy || !sendable}
            onClick={onSend}
            title={
              sendable
                ? "Send this approved message (server-gated)"
                : row.suppressed
                  ? "Suppressed — cannot send"
                  : "Approve first to enable send"
            }
          >
            Send
          </button>
        </div>
      )}
    </div>
  )
}
