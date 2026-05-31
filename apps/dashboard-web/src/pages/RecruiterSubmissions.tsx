/**
 * Admin view of pa-recruiter-submissions.
 *
 * Lists every recruiter submission newest-first, with chip filters (job + status),
 * sortable columns, pagination, row drill-down. Backed by the unified DataTable
 * primitive + useTable hook.
 */
import { Fragment, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { arrayUnion, collection, doc, getDocs, limit, orderBy, query, serverTimestamp, updateDoc } from "firebase/firestore"
import { AdminJobLink } from "../components/AdminEntityLink.js"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { DataTable, type Column } from "../components/console/primitives.js"
import { useTable } from "../components/console/useTable.js"
import { db } from "../lib/firebase.js"
import { createRecruiterInviteCode, type CreateRecruiterInviteCodeResult } from "../lib/recruiter-platform-api.js"

interface SubmissionDoc {
  id: string
  jobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  submitter?: { name?: string; email?: string }
  candidate?: {
    name?: string
    link?: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  checklist?: Record<string, boolean>
  score?: {
    hardChecked: number
    hardTotal: number
    fitChecked: number
    fitTotal: number
    bonusChecked: number
    bonusTotal: number
    antiChecked: number
    antiTotal: number
  }
  status?: string
  recruiterId?: string | null
  recruiterEmail?: string
  recruiterFeedbackNote?: string | null
  sheetSyncedAt?: { seconds: number } | null
  sheetSyncError?: string | null
  createdAt?: { seconds: number } | null
  createdAtMs?: number
  hardScorePct?: number
}

function formatTimestamp(ts: SubmissionDoc["createdAt"]): string {
  if (!ts || typeof ts.seconds !== "number") return "—"
  return new Date(ts.seconds * 1000).toLocaleString()
}

function statusBadge(s: string | undefined): "ok" | "warn" | "info" | "muted" {
  switch (s) {
    case "submitted":
    case "new":
      return "info"
    case "advanced": return "ok"
    case "interviewing": return "ok"
    case "hired": return "ok"
    case "rejected": return "warn"
    case "reviewing": return "info"
    default: return "muted"
  }
}

const STATUS_VALUES = ["submitted", "new", "reviewing", "advanced", "interviewing", "hired", "rejected", "duplicate"]

interface RecruiterProfileDoc {
  id: string
  firebaseUid?: string
  name?: string
  email?: string
  status?: string
  notificationPreferences?: { newRolesEmail?: boolean }
}

interface RecruiterInviteCodeDoc {
  id: string
  active?: boolean
  inviteCode?: string
  codePreview?: string
  label?: string | null
  maxUses?: number
  usedCount?: number
  expiresAt?: string | null
  createdAt?: { seconds?: number } | string | null
  createdByEmail?: string | null
  lastUsedByEmail?: string | null
}

interface RecruiterNotificationDoc {
  id: string
  status?: string
  recruiterEmail?: string
  roleTitle?: string
  createdAt?: { seconds?: number } | string | null
  sentAt?: { seconds?: number } | string | null
  lastError?: string
}

function timestampToMs(raw: unknown): number {
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "object" && typeof (raw as { seconds?: unknown }).seconds === "number") {
    return ((raw as { seconds: number }).seconds) * 1000
  }
  return 0
}

function toDatetimeLocalValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function defaultRecruiterCodeExpiryLocal(): string {
  const date = new Date()
  date.setFullYear(date.getFullYear() + 1)
  return toDatetimeLocalValue(date)
}

function formatOpsDate(raw: unknown): string {
  const ms = timestampToMs(raw)
  return ms ? new Date(ms).toLocaleString() : "—"
}

function formatCodeExpiry(raw?: string | null): string {
  if (!raw) return "—"
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? raw : new Date(ms).toLocaleString()
}

type RecruiterAdminSection = "codes" | "submissions"

function codeStatus(code: RecruiterInviteCodeDoc): { label: string; tone: Parameters<typeof Badge>[0]["tone"] } {
  if (code.active === false) return { label: "disabled", tone: "muted" }
  if ((code.usedCount ?? 0) >= 1) return { label: "used", tone: "info" }
  if (code.expiresAt && Date.parse(code.expiresAt) <= Date.now()) return { label: "expired", tone: "warn" }
  return { label: "usable", tone: "ok" }
}

export default function RecruiterSubmissions({ section = "submissions" }: { section?: RecruiterAdminSection }) {
  const isSubmissions = section === "submissions"
  const [loading, setLoading] = useState(isSubmissions)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<SubmissionDoc[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    if (!isSubmissions) {
      setLoading(false)
      setErr(null)
      setExpandedId(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const q = query(
          collection(db(), "pa-recruiter-submissions"),
          orderBy("createdAt", "desc"),
          limit(500),
        )
        const snap = await getDocs(q)
        if (cancelled) return
        const all = snap.docs.map((d) => {
          const data = d.data() as Omit<SubmissionDoc, "id">
          const createdAtMs = data.createdAt?.seconds ? data.createdAt.seconds * 1000 : 0
          const hardScorePct = data.score?.hardTotal
            ? data.score.hardChecked / data.score.hardTotal
            : 0
          return { id: d.id, ...data, createdAtMs, hardScorePct }
        })
        setRows(all)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isSubmissions])

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      if (r.jobId && !seen.has(r.jobId)) {
        seen.set(r.jobId, r.jobTitleSnapshot ?? r.jobId)
      }
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: SubmissionDoc) => r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<SubmissionDoc>(rows, {
    defaultSort: { key: "createdAtMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.submitter?.name?.toLowerCase().includes(q) ?? false) ||
      (r.submitter?.email?.toLowerCase().includes(q) ?? false) ||
      (r.candidate?.name?.toLowerCase().includes(q) ?? false) ||
      (r.candidate?.link?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "status",
        label: "Status",
        multi: true,
        options: STATUS_VALUES.map((s) => ({
          key: s,
          label: s,
          test: (r: SubmissionDoc) => (r.status ?? "new") === s,
        })),
      },
      {
        id: "score",
        label: "Score",
        multi: false,
        options: [
          {
            key: "hardFull",
            label: "Hard 100%",
            title: "All hard-filter boxes ticked",
            test: (r: SubmissionDoc) =>
              !!r.score && r.score.hardTotal > 0 && r.score.hardChecked === r.score.hardTotal,
          },
          {
            key: "hardPartial",
            label: "Hard < 100%",
            title: "At least one hard filter missing",
            test: (r: SubmissionDoc) =>
              !!r.score && r.score.hardTotal > 0 && r.score.hardChecked < r.score.hardTotal,
          },
          {
            key: "antiFlagged",
            label: "Anti-flag ≥ 1",
            title: "At least one anti-signal ticked",
            test: (r: SubmissionDoc) => !!r.score && r.score.antiChecked > 0,
          },
          {
            key: "sheetError",
            label: "Sheet sync error",
            test: (r: SubmissionDoc) => Boolean(r.sheetSyncError),
          },
        ],
      },
    ],
  })

  const header = (
    <>
      <PageHeader
        title={section === "codes" ? "Recruiter Access" : "Recruiter Submissions"}
        description={
          section === "codes"
            ? "Create one-use recruiter access codes, review recruiter accounts, and monitor new-role alerts."
            : "Review recruiter-submitted candidates and move each submission through the hiring-board pipeline."
        }
      />
      <RecruiterSectionTabs active={section} />
    </>
  )

  if (section === "codes") {
    return (
      <div>
        {header}
        <RecruiterOpsPanel />
      </div>
    )
  }

  if (loading) {
    return (
      <div>
        {header}
        <LoadingState label="Loading submissions..." />
      </div>
    )
  }
  if (err) {
    return (
      <div>
        {header}
        <ErrorState message={err} />
      </div>
    )
  }

  const columns: Column<SubmissionDoc>[] = [
    {
      key: "createdAtMs",
      label: "Submitted",
      sortable: true,
      width: 170,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatTimestamp(r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Job",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "-"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "submitter",
      label: "Submitter",
      render: (r) => (
        <>
          <div>{r.submitter?.name ?? "—"}</div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.submitter?.email ?? ""}</div>
        </>
      ),
    },
    {
      key: "candidate",
      label: "Candidate",
      render: (r) => (
        <>
          <div>{r.candidate?.name ?? "—"}</div>
          {r.candidate?.link && (
            <a
              href={r.candidate.link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ fontSize: 11, color: "#2a5fb8" }}
            >
              {r.candidate.link.length > 36 ? r.candidate.link.slice(0, 36) + "…" : r.candidate.link}
            </a>
          )}
        </>
      ),
    },
    {
      key: "hardScorePct",
      label: "Hard",
      sortable: true,
      width: 70,
      render: (r) => (r.score ? `${r.score.hardChecked}/${r.score.hardTotal}` : "—"),
    },
    {
      key: "fitScore",
      label: "Fit",
      width: 70,
      render: (r) => (r.score ? `${r.score.fitChecked}/${r.score.fitTotal}` : "—"),
    },
    {
      key: "antiScore",
      label: "Anti",
      width: 70,
      render: (r) => (r.score ? `${r.score.antiChecked}/${r.score.antiTotal}` : "—"),
    },
    {
      key: "sheet",
      label: "Sheet",
      width: 80,
      render: (r) => (r.sheetSyncedAt ? "✓ synced" : r.sheetSyncError ? "× error" : "—"),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      width: 100,
      render: (r) => <Badge tone={statusBadge(r.status)}>{r.status ?? "submitted"}</Badge>,
    },
    {
      key: "feedback",
      label: "Feedback",
      width: 90,
      render: (r) => r.recruiterFeedbackNote ? "note" : "—",
    },
  ]

  return (
    <div>
      {header}
      <Panel>
        <DataTable<SubmissionDoc>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search submitter / candidate / job…"
          sort={table.sort}
          onSort={table.toggleSort}
          page={table.page}
          pageCount={table.pageCount}
          onPageChange={table.setPage}
          onResetFilters={table.reset}
          count={table.filteredCount}
          totalCount={table.totalRows}
          onRowClick={(r) => setExpandedId(expandedId === r.id ? null : r.id ?? null)}
          empty={
            <div style={{ padding: 40, textAlign: "center", color: "#777" }}>
              No submissions match the current filters.
            </div>
          }
        />
      </Panel>

      {expandedId && (() => {
        const row = rows.find((r) => r.id === expandedId)
        if (!row) return null
        return (
          <RowDetailPanel
            row={row}
            onClose={() => setExpandedId(null)}
            onUpdated={(next) => {
              setRows((prev) => prev.map((r) => r.id === next.id ? { ...r, ...next } : r))
            }}
          />
        )
      })()}
    </div>
  )
}

function RecruiterSectionTabs({ active }: { active: RecruiterAdminSection }) {
  const tabs: Array<{ key: RecruiterAdminSection; label: string; to: string; detail: string }> = [
    {
      key: "codes",
      label: "Access codes",
      to: "/admin/recruiter-access",
      detail: "Invite codes, accounts, role alerts",
    },
    {
      key: "submissions",
      label: "Submissions",
      to: "/admin/recruiter-submissions",
      detail: "Candidate review queue",
    },
  ]

  return (
    <nav
      aria-label="Recruiter admin sections"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 12,
        margin: "0 0 16px",
      }}
    >
      {tabs.map((tab) => {
        const selected = active === tab.key
        return (
          <a
            key={tab.key}
            href={tab.to}
            aria-current={selected ? "page" : undefined}
            style={{
              display: "grid",
              gap: 4,
              padding: "14px 16px",
              border: selected ? "1px solid #2a1a10" : "1px solid #e6ded4",
              borderRadius: 8,
              background: selected ? "#fff" : "#f8f5ef",
              color: "#2a1a10",
              textDecoration: "none",
              boxShadow: selected ? "0 1px 0 rgba(42, 26, 16, 0.08)" : "none",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700 }}>{tab.label}</span>
            <span style={{ color: "#777", fontSize: 12 }}>{tab.detail}</span>
          </a>
        )
      })}
    </nav>
  )
}

function RecruiterOpsPanel() {
  const [profiles, setProfiles] = useState<RecruiterProfileDoc[]>([])
  const [codes, setCodes] = useState<RecruiterInviteCodeDoc[]>([])
  const [notifications, setNotifications] = useState<RecruiterNotificationDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [label, setLabel] = useState("")
  const [expiresAtLocal, setExpiresAtLocal] = useState(() => defaultRecruiterCodeExpiryLocal())
  const [generated, setGenerated] = useState<CreateRecruiterInviteCodeResult | null>(null)
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    try {
      const [profileSnap, codeSnap, notificationSnap] = await Promise.all([
        getDocs(collection(db(), "pa-recruiter-users")),
        getDocs(collection(db(), "pa-recruiter-invite-codes")),
        getDocs(query(collection(db(), "pa-recruiter-notifications"), limit(100))),
      ])
      setProfiles(profileSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterProfileDoc, "id">) })))
      setCodes(codeSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterInviteCodeDoc, "id">) })))
      setNotifications(
        notificationSnap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<RecruiterNotificationDoc, "id">) }))
          .sort((a, b) => timestampToMs(b.createdAt) - timestampToMs(a.createdAt)),
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const createCode = async (e: FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setErr(null)
    try {
      const expiresAt = expiresAtLocal ? new Date(expiresAtLocal).toISOString() : undefined
      const result = await createRecruiterInviteCode({
        label: label.trim() || undefined,
        expiresAt,
      })
      setGenerated(result)
      setLabel("")
      setExpiresAtLocal(defaultRecruiterCodeExpiryLocal())
      await reload()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  const activeRecruiters = profiles.filter((p) => p.status !== "disabled").length
  const emailOn = profiles.filter((p) => p.status !== "disabled" && p.notificationPreferences?.newRolesEmail !== false).length
  const activeCodes = codes.filter((c) => c.active !== false && (c.usedCount ?? 0) < 1).length
  const sentNotifications = notifications.filter((n) => n.status === "sent").length
  const failedNotifications = notifications.filter((n) => n.status === "failed").length
  const sortedCodes = [...codes].sort((a, b) => timestampToMs(b.createdAt) - timestampToMs(a.createdAt))
  const sortedProfiles = [...profiles].sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""))

  return (
    <Panel
      title="Recruiter access"
      eyebrow="Codes, accounts, notifications"
      actions={
        <button type="button" onClick={() => void reload()} disabled={loading}>Refresh</button>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Active recruiters" value={activeRecruiters} />
        <OpsMetric label="New-role email on" value={emailOn} />
        <OpsMetric label="Usable codes" value={activeCodes} />
        <OpsMetric label="Notifications sent" value={sentNotifications} meta={failedNotifications ? `${failedNotifications} failed` : undefined} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)", gap: 18, alignItems: "start" }}>
        <form id="recruiter-code-form" onSubmit={createCode} style={{ display: "grid", gap: 10, border: "1px solid #eee", borderRadius: 8, padding: 14, background: "#fff" }}>
          <div>
            <div style={{ fontWeight: 700 }}>Issue access code</div>
            <p style={{ color: "#666", margin: "4px 0 0", fontSize: 13, lineHeight: 1.45 }}>
              One code creates one Firebase recruiter account. Default expiry is one year.
            </p>
          </div>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#666" }}>
            Label
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Recruiter name or note"
              style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#666" }}>
            Expires at
            <input
              type="datetime-local"
              value={expiresAtLocal}
              onChange={(e) => setExpiresAtLocal(e.target.value)}
              style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6 }}
            />
          </label>
          <button
            disabled={creating}
            style={{ padding: "9px 12px", border: "1px solid #222", background: "#222", color: "#fff", borderRadius: 6 }}
          >
            {creating ? "Creating..." : "Create code"}
          </button>
          {err && <p style={{ color: "#a00", fontSize: 12, margin: 0 }}>{err}</p>}
          {generated && (
            <div style={{ background: "#f7f3ed", border: "1px solid #e1d8cc", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: ".08em" }}>Give this code to the recruiter</div>
              <code style={{ display: "block", marginTop: 6, fontSize: 18, fontWeight: 700 }}>{generated.inviteCode}</code>
              <div style={{ color: "#777", fontSize: 12, marginTop: 4 }}>Expires {formatCodeExpiry(generated.expiresAt)}</div>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(generated.inviteCode)}
                style={{ marginTop: 8, padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, background: "#fff" }}
              >
                Copy code
              </button>
            </div>
          )}
        </form>
        <OpsSection title="Access codes" subtitle="Admins can view and copy one-use recruiter codes.">
          {sortedCodes.length ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ color: "#777", textAlign: "left", borderBottom: "1px solid #eee" }}>
                    <th style={{ padding: "8px 6px" }}>Code</th>
                    <th style={{ padding: "8px 6px" }}>Copy</th>
                    <th style={{ padding: "8px 6px" }}>Label</th>
                    <th style={{ padding: "8px 6px" }}>Status</th>
                    <th style={{ padding: "8px 6px" }}>Expires</th>
                    <th style={{ padding: "8px 6px" }}>Bound to</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedCodes.slice(0, 8).map((code) => {
                    const status = codeStatus(code)
                    const visibleCode = code.inviteCode ?? code.codePreview ?? code.id.slice(0, 10)
                    return (
                      <tr key={code.id} style={{ borderBottom: "1px solid #f1f1f1" }}>
                        <td style={{ padding: "9px 6px", fontFamily: "monospace", fontWeight: 700 }}>{visibleCode}</td>
                        <td style={{ padding: "9px 6px" }}>
                          {code.inviteCode ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                void navigator.clipboard?.writeText(code.inviteCode ?? "")
                              }}
                              style={{ padding: "5px 8px", border: "1px solid #ccc", borderRadius: 6, background: "#fff", fontSize: 12 }}
                            >
                              Copy
                            </button>
                          ) : (
                            <span style={{ color: "#999" }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: "9px 6px" }}>{code.label || "—"}</td>
                        <td style={{ padding: "9px 6px" }}><Badge tone={status.tone}>{status.label}</Badge></td>
                        <td style={{ padding: "9px 6px", color: "#666" }}>{formatCodeExpiry(code.expiresAt)}</td>
                        <td style={{ padding: "9px 6px", color: "#666" }}>{code.lastUsedByEmail ?? "—"}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyOpsText>Create an access code to invite the first recruiter.</EmptyOpsText>
          )}
        </OpsSection>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 18, marginTop: 18 }}>
        <OpsSection title="Recruiter accounts" subtitle="Firebase-bound recruiter users who can submit candidates.">
          {sortedProfiles.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {sortedProfiles.slice(0, 8).map((profile) => (
                <div key={profile.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, borderTop: "1px solid #eee", paddingTop: 8, fontSize: 12 }}>
                  <span>
                    <b>{profile.name || profile.email || "Recruiter"}</b>
                    <br />
                    <span style={{ color: "#777" }}>{profile.email ?? profile.firebaseUid ?? profile.id}</span>
                  </span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <Badge tone={profile.status === "disabled" ? "warn" : "ok"}>{profile.status ?? "active"}</Badge>
                    <Badge tone={profile.notificationPreferences?.newRolesEmail === false ? "muted" : "info"}>{profile.notificationPreferences?.newRolesEmail === false ? "email off" : "email on"}</Badge>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyOpsText>No recruiter accounts yet. A recruiter appears here after signup.</EmptyOpsText>
          )}
        </OpsSection>
        <OpsSection title="Role alerts" subtitle="One alert is created per active recruiter when a recruiter-board role is released.">
          {notifications.slice(0, 6).map((n) => (
            <div key={n.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, padding: "8px 0", borderTop: "1px solid #eee", fontSize: 12 }}>
              <span>
                <b>{n.roleTitle ?? "Role"}</b>
                <br />
                <span style={{ color: "#777" }}>{n.recruiterEmail ?? "unknown recruiter"} · {formatOpsDate(n.createdAt)}</span>
              </span>
              <Badge tone={n.status === "sent" ? "ok" : n.status === "failed" ? "warn" : "muted"}>{n.status ?? "queued"}</Badge>
            </div>
          ))}
          {!notifications.length && <EmptyOpsText>No role notifications yet.</EmptyOpsText>}
        </OpsSection>
      </div>
    </Panel>
  )
}

function OpsSection({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section style={{ border: "1px solid #eee", borderRadius: 8, padding: 14, background: "#fff", minHeight: 168 }}>
      <div style={{ display: "grid", gap: 3, marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ color: "#777", fontSize: 12, lineHeight: 1.4 }}>{subtitle}</div>}
      </div>
      {children}
    </section>
  )
}

function EmptyOpsText({ children }: { children: ReactNode }) {
  return <p style={{ color: "#777", fontSize: 12, margin: 0 }}>{children}</p>
}

function OpsMetric({ label, value, meta }: { label: string; value: number; meta?: string }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, background: "#fff" }}>
      <div style={{ color: "#777", fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {meta && <div style={{ color: "#a60", fontSize: 12 }}>{meta}</div>}
    </div>
  )
}

function RowDetailPanel({
  row,
  onClose,
  onUpdated,
}: {
  row: SubmissionDoc
  onClose: () => void
  onUpdated: (row: Partial<SubmissionDoc> & { id: string }) => void
}) {
  const checks = row.checklist ?? {}
  const ticked = Object.entries(checks).filter(([, v]) => v).map(([k]) => k)
  const [draftStatus, setDraftStatus] = useState(row.status ?? "submitted")
  const [draftNote, setDraftNote] = useState(row.recruiterFeedbackNote ?? "")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const saveFeedback = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await updateDoc(doc(db(), "pa-recruiter-submissions", row.id), {
        status: draftStatus,
        recruiterFeedbackNote: draftNote.trim() || null,
        recruiterFeedbackUpdatedAt: serverTimestamp(),
        statusHistory: arrayUnion({
          status: draftStatus,
          by: "admin",
          atIso: new Date().toISOString(),
        }),
        updatedAt: serverTimestamp(),
      })
      onUpdated({
        id: row.id,
        status: draftStatus,
        recruiterFeedbackNote: draftNote.trim() || null,
      })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      title="Submission detail"
      actions={
        <button
          onClick={onClose}
          style={{ border: "none", background: "none", cursor: "pointer", color: "#888", fontSize: 16 }}
          aria-label="Close"
        >
          ✕
        </button>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
            Submitter
          </h4>
          <p style={{ margin: 0, fontSize: 13 }}>
            {row.submitter?.name} &lt;{row.submitter?.email}&gt;
          </p>

          <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
            Candidate
          </h4>
          <p style={{ margin: 0, fontSize: 13 }}>
            <strong>{row.candidate?.name}</strong>
            {row.candidate?.currentRole && <> · {row.candidate.currentRole}</>}
            {row.candidate?.yoe && <> · {row.candidate.yoe} YOE</>}
          </p>
          {row.candidate?.link && (
            <p style={{ margin: "4px 0 0", fontSize: 12 }}>
              <a href={row.candidate.link} target="_blank" rel="noopener noreferrer">
                {row.candidate.link}
              </a>
            </p>
          )}
          {row.candidate?.notes && (
            <>
              <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
                Notes
              </h4>
              <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{row.candidate.notes}</p>
            </>
          )}
        </div>

        <div>
          <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
            Score
          </h4>
          {row.score ? (
            <p style={{ margin: 0, fontSize: 13 }}>
              Hard {row.score.hardChecked}/{row.score.hardTotal} ·{" "}
              Fit {row.score.fitChecked}/{row.score.fitTotal} ·{" "}
              Bonus {row.score.bonusChecked}/{row.score.bonusTotal} ·{" "}
              Anti {row.score.antiChecked}/{row.score.antiTotal}
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: "#999" }}>No score.</p>
          )}

          <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
            Ticked items ({ticked.length})
          </h4>
          {ticked.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: "#999" }}>No items ticked.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#444" }}>
              {ticked.map((id) => (
                <li key={id}><code>{id}</code></li>
              ))}
            </ul>
          )}

          {row.sheetSyncError && (
            <>
              <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#a00" }}>
                Sheet sync error
              </h4>
              <p style={{ margin: 0, fontSize: 12, color: "#a00", whiteSpace: "pre-wrap" }}>
                {row.sheetSyncError}
              </p>
            </>
          )}
        </div>
      </div>
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid #eee" }}>
        <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
          Recruiter-visible status and feedback
        </h4>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr auto", gap: 10, alignItems: "start" }}>
          <select
            value={draftStatus}
            onChange={(e) => setDraftStatus(e.target.value)}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
          >
            {STATUS_VALUES.map((s) => <option value={s} key={s}>{s}</option>)}
          </select>
          <textarea
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="Optional note visible to the recruiter..."
            rows={3}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13, resize: "vertical" }}
          />
          <button
            onClick={saveFeedback}
            disabled={saving}
            style={{ padding: "8px 12px", border: "1px solid #222", background: "#222", color: "#fff", borderRadius: 6, cursor: saving ? "default" : "pointer" }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
        {saveError && <p style={{ color: "#a00", fontSize: 12, margin: "8px 0 0" }}>{saveError}</p>}
      </div>
    </Panel>
  )
}
