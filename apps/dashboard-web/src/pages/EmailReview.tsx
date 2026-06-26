/**
 * /admin/email-review — HITL surface for inbound candidate email.
 *
 * Two sections:
 *   1. Pending auto-reply DRAFTS (pa-inbound-email-drafts, pending_review).
 *      The inbound webhook now records the LLM-composed reply here instead of
 *      auto-sending. Operator can edit the body, approve+send (real Mailgun
 *      send via paAdminSendInboundEmailDraft), or dismiss. Nothing sends on its
 *      own — this closes the unsupervised-candidate-email HITL gap.
 *   2. Unmatched queue (pa-inbound-emails-unmatched) — replies that couldn't be
 *      mapped to a thread (no_conv_token / thread_not_found) or were routed to
 *      review (sensitive_topic_hitl: comp / visa / STOP). These most need a
 *      human; surfaced read-only here for triage.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import {
  getInboundEmailDrafts,
  getInboundUnmatchedList,
  sendInboundEmailDraft,
  type InboundEmailDraftRow,
  type InboundUnmatchedRow,
} from "../lib/inbound-email-review-api.js"

function relTime(iso: string | undefined): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  const diff = Date.now() - t
  if (diff < 60_000) return "just now"
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function reasonTone(reason: string | undefined): "warn" | "info" | "muted" {
  if (reason === "sensitive_topic_hitl") return "warn"
  if (reason === "thread_not_found" || reason === "no_conv_token") return "info"
  return "muted"
}

export default function EmailReview() {
  const [drafts, setDrafts] = useState<InboundEmailDraftRow[] | null>(null)
  const [unmatched, setUnmatched] = useState<InboundUnmatchedRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Per-draft local edit buffer + in-flight action id.
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [d, u] = await Promise.all([getInboundEmailDrafts("pending_review"), getInboundUnmatchedList()])
      setDrafts(d.rows)
      setUnmatched(u.rows)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onApprove = useCallback(
    async (row: InboundEmailDraftRow) => {
      setBusy(row.id)
      setNotice(null)
      try {
        const edited = edits[row.id]
        const res = await sendInboundEmailDraft({
          draftId: row.id,
          action: "approve_send",
          ...(edited && edited !== row.replyBody ? { editedBody: edited } : {}),
        })
        if (res.sent) {
          setNotice(`Sent to ${row.candidateEmail ?? "candidate"}.`)
          setDrafts((prev) => (prev ?? []).filter((d) => d.id !== row.id))
        } else {
          setNotice(`Send did not complete (${res.reason ?? res.status}).`)
        }
      } catch (e: unknown) {
        setNotice(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
      }
    },
    [edits],
  )

  const onDismiss = useCallback(async (row: InboundEmailDraftRow) => {
    setBusy(row.id)
    setNotice(null)
    try {
      await sendInboundEmailDraft({ draftId: row.id, action: "dismiss" })
      setNotice("Draft dismissed (not sent).")
      setDrafts((prev) => (prev ?? []).filter((d) => d.id !== row.id))
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [])

  const draftCount = drafts?.length ?? 0
  const unmatchedCount = unmatched?.length ?? 0
  const sortedUnmatched = useMemo(
    () =>
      [...(unmatched ?? [])].sort((a, b) => {
        // Surface sensitive (comp/visa/STOP) first — they most need a human.
        const rank = (r?: string) => (r === "sensitive_topic_hitl" ? 0 : r === "thread_not_found" ? 1 : 2)
        const d = rank(a.reason) - rank(b.reason)
        if (d !== 0) return d
        return String(b.createdAt).localeCompare(String(a.createdAt))
      }),
    [unmatched],
  )

  return (
    <div>
      <PageHeader
        title="Email review"
        description="Inbound candidate email — approve auto-reply drafts before they send, and triage the unmatched queue."
        actions={
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        }
      />

      {err ? <ErrorState message={err} /> : null}
      {notice ? <div className="notice notice-good">{notice}</div> : null}

      <Panel
        title="Pending auto-reply drafts"
        eyebrow={`${draftCount} awaiting approval`}
      >
        <p className="muted-copy" style={{ marginTop: 0 }}>
          The auto-replier now <b>drafts</b> candidate replies for approval — nothing sends until you click Approve &amp;
          send. Edit the body inline if needed.
        </p>
        {loading && !drafts ? (
          <LoadingState label="Loading drafts…" />
        ) : draftCount === 0 ? (
          <EmptyState
            title="No pending drafts"
            body="When a candidate replies by email, the composed reply will appear here for your approval."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {drafts!.map((row) => {
              const body = edits[row.id] ?? row.replyBody ?? ""
              return (
                <div
                  key={row.id}
                  style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.85rem 1rem", background: "#fff" }}
                >
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                    <Badge tone="info">pending</Badge>
                    <code>{row.candidateEmail ?? "(no email)"}</code>
                    <span className="muted-copy">· {relTime(row.createdAt)}</span>
                    {row.userId ? (
                      <a href={`/users/${row.userId}`} style={{ fontSize: "0.85em" }}>
                        candidate ↗
                      </a>
                    ) : null}
                  </div>
                  {row.inboundSubject ? (
                    <div style={{ fontSize: "0.85em", color: "#475569" }}>
                      Re: <b>{row.inboundSubject}</b>
                    </div>
                  ) : null}
                  {row.inboundPreview ? (
                    <div
                      style={{
                        fontSize: "0.85em",
                        color: "#64748b",
                        background: "#f8fafc",
                        borderRadius: 6,
                        padding: "0.4rem 0.6rem",
                        margin: "6px 0",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      <span style={{ textTransform: "uppercase", fontSize: "0.85em", letterSpacing: "0.04em" }}>
                        Candidate said:
                      </span>
                      {"\n"}
                      {row.inboundPreview}
                    </div>
                  ) : null}
                  <div style={{ fontSize: "0.8em", color: "#64748b", marginBottom: 2 }}>
                    Draft reply{row.replySubject ? ` · ${row.replySubject}` : ""}:
                  </div>
                  <textarea
                    value={body}
                    onChange={(e) => setEdits((prev) => ({ ...prev, [row.id]: e.target.value }))}
                    rows={Math.min(10, Math.max(3, body.split("\n").length + 1))}
                    style={{ width: "100%", fontSize: "0.9em", padding: "0.5rem", borderRadius: 6, border: "1px solid #cbd5e1" }}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={() => void onApprove(row)}
                      disabled={busy === row.id || !body.trim()}
                    >
                      {busy === row.id ? "Sending…" : "Approve & send"}
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={() => void onDismiss(row)}
                      disabled={busy === row.id}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Panel>

      <Panel title="Unmatched inbound queue" eyebrow={`${unmatchedCount} items`}>
        <p className="muted-copy" style={{ marginTop: 0 }}>
          Replies that couldn't be threaded, or were routed to review (comp / visa / legal / STOP). These need a human —
          sensitive topics are listed first.
        </p>
        {loading && !unmatched ? (
          <LoadingState label="Loading unmatched…" />
        ) : unmatchedCount === 0 ? (
          <EmptyState title="Nothing unmatched" body="All inbound email has been threaded successfully." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sortedUnmatched.map((row) => (
              <div
                key={row.id}
                style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.7rem 0.9rem", background: "#fff" }}
              >
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 4 }}>
                  <Badge tone={reasonTone(row.reason)}>{row.reason ?? "other"}</Badge>
                  {row.sender ? <code>{row.sender}</code> : null}
                  <span className="muted-copy">· {relTime(row.createdAt)}</span>
                  {row.resolutionStatus ? <Badge tone="muted">{row.resolutionStatus}</Badge> : null}
                </div>
                {row.subject ? <div style={{ fontSize: "0.85em", color: "#475569" }}>{row.subject}</div> : null}
                {row.inboundTextPreview ? (
                  <div style={{ fontSize: "0.85em", color: "#64748b", whiteSpace: "pre-wrap", marginTop: 4 }}>
                    {row.inboundTextPreview}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
