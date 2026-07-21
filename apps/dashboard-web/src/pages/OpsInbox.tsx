/**
 * /admin/ops-inbox — two built-but-previously-invisible audit surfaces folded
 * into one read-only page:
 *
 *   1. Team-invites roster (pa-employer-team-invites) — who was invited to which
 *      org, which role, and whether delivery failed. No accept flow exists yet,
 *      so status is always "pending" (read-only).
 *   2. Outbound email audit log (pa-headhunter-emails) — the three-writer
 *      headhunter/interview-offer/inbound-autoreply send log, filterable by
 *      source + showing send status. Read-only (status is system-owned). Body
 *      is never surfaced (PII) — subject only.
 *
 * Data: paAdminTeamInvitesList + paAdminHeadhunterEmailsList. Both admin-gated.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"

const TEAM_INVITES_CALLABLE = "paAdminTeamInvitesList"
const HEADHUNTER_EMAILS_CALLABLE = "paAdminHeadhunterEmailsList"

type TeamInviteRow = {
  id: string
  email?: string
  role?: string
  status?: string
  orgName?: string
  inviterEmail?: string
  emailDeliveryFailed?: boolean
  mailgunStatus?: number
  invitedAt?: string
}

type TeamInvitesResult = {
  rows: TeamInviteRow[]
  total: number
  truncated: boolean
  generatedAt: string
}

type HeadhunterEmailRow = {
  id: string
  to?: string
  subject?: string
  status?: string
  source?: string
  convToken?: string
  mailgunMessageId?: string
  userId?: string
  jobId?: string
  createdAt?: string
}

type HeadhunterEmailsResult = {
  rows: HeadhunterEmailRow[]
  total: number
  truncated: boolean
  generatedAt: string
}

const EMAIL_SOURCES = ["all", "headhunter_mcp", "email_interview_offer", "inbound_email_autoreply"] as const
type EmailSourceFilter = (typeof EMAIL_SOURCES)[number]

async function loadTeamInvites(): Promise<TeamInvitesResult> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable<Record<string, never>, TeamInvitesResult>(firebase.functions(), TEAM_INVITES_CALLABLE)
  const result = await fn({})
  return result.data
}

async function loadHeadhunterEmails(): Promise<HeadhunterEmailsResult> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable<Record<string, never>, HeadhunterEmailsResult>(
    firebase.functions(),
    HEADHUNTER_EMAILS_CALLABLE,
  )
  const result = await fn({})
  return result.data
}

function emailStatusTone(status?: string): "ok" | "warn" | "info" | "muted" {
  switch (status) {
    case "sent":
      return "ok"
    case "failed":
    case "error":
      return "warn"
    case "pending":
      return "info"
    default:
      return "muted"
  }
}

function formatWhen(iso?: string): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export default function OpsInbox() {
  const [invites, setInvites] = useState<TeamInvitesResult | null>(null)
  const [emails, setEmails] = useState<HeadhunterEmailsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [emailSource, setEmailSource] = useState<EmailSourceFilter>("all")

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    void Promise.all([loadTeamInvites(), loadHeadhunterEmails()])
      .then(([inv, em]) => {
        setInvites(inv)
        setEmails(em)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Group invites by org (or inviter when org absent).
  const invitesByOrg = useMemo(() => {
    const all = invites?.rows ?? []
    const groups = new Map<string, TeamInviteRow[]>()
    for (const r of all) {
      const key = r.orgName ?? r.inviterEmail ?? "(unknown org)"
      const list = groups.get(key) ?? []
      list.push(r)
      groups.set(key, list)
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [invites])

  const emailRows = useMemo(() => {
    const all = emails?.rows ?? []
    const filtered = emailSource === "all" ? all : all.filter((r) => r.source === emailSource)
    return [...filtered].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
  }, [emails, emailSource])

  if (loading) return <LoadingState label="Loading ops inbox…" />
  if (error) return <ErrorState message={error} />

  return (
    <div className="page-stack">
      <PageHeader
        title="Ops inbox"
        description="Team-invite roster + outbound email audit log — two built-but-invisible employer/headhunter surfaces. Read-only."
        actions={
          <button type="button" className="btn btn--sm" onClick={load}>
            Refresh
          </button>
        }
      />

      <Panel
        title={`Team invites · ${invites?.total ?? 0}${invites?.truncated ? " · truncated" : ""}`}
      >
        {invitesByOrg.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", opacity: 0.6 }}>No team invites yet.</p>
        ) : (
          invitesByOrg.map(([org, list]) => (
            <div key={org} style={{ marginBottom: "1rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.9rem", margin: "0.5rem 0" }}>
                {org} <span style={{ opacity: 0.6, fontWeight: 400 }}>· {list.length} invite(s)</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Invited by</th>
                      <th>Invited</th>
                      <th>Delivery</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list
                      .slice()
                      .sort((a, b) => (b.invitedAt ?? "").localeCompare(a.invitedAt ?? ""))
                      .map((row) => (
                        <tr key={row.id}>
                          <td>{row.email ?? "—"}</td>
                          <td>{(row.role ?? "—").replace(/_/g, " ")}</td>
                          <td>
                            <Badge tone={row.status === "pending" ? "info" : "muted"}>
                              {row.status ?? "—"}
                            </Badge>
                          </td>
                          <td>{row.inviterEmail ?? "—"}</td>
                          <td style={{ whiteSpace: "nowrap" }}>{formatWhen(row.invitedAt)}</td>
                          <td>
                            {row.emailDeliveryFailed ? (
                              <Badge tone="warn">
                                failed{row.mailgunStatus ? ` (${row.mailgunStatus})` : ""}
                              </Badge>
                            ) : (
                              <Badge tone="ok">sent</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </Panel>

      <Panel
        title={`Outbound email log · ${emailRows.length}${emails?.truncated ? " · truncated" : ""}`}
        actions={
          <select
            value={emailSource}
            onChange={(e) => setEmailSource(e.target.value as EmailSourceFilter)}
            style={{ padding: "0.3rem 0.6rem", borderRadius: 6, border: "1px solid var(--ink-6, #ccc)", fontSize: "0.85rem" }}
          >
            {EMAIL_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All sources" : s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        }
      >
        {emailRows.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", opacity: 0.6 }}>No outbound emails in this filter.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>To</th>
                  <th>Subject</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {emailRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.to ?? "—"}</td>
                    <td style={{ maxWidth: 320 }}>
                      <div>{row.subject ?? "—"}</div>
                      {(row.userId || row.jobId) && (
                        <div style={{ fontSize: "0.72rem", opacity: 0.6 }}>
                          {row.userId ? `user ${row.userId}` : ""}
                          {row.userId && row.jobId ? " · " : ""}
                          {row.jobId ? `job ${row.jobId}` : ""}
                        </div>
                      )}
                    </td>
                    <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>
                      {(row.source ?? "—").replace(/_/g, " ")}
                    </td>
                    <td>
                      <Badge tone={emailStatusTone(row.status)}>{row.status ?? "—"}</Badge>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatWhen(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
