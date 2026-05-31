/**
 * Admin view of pa-recruiter-submissions.
 *
 * Lists every recruiter submission newest-first, with chip filters (job + status),
 * sortable columns, pagination, row drill-down. Backed by the unified DataTable
 * primitive + useTable hook.
 */
import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react"
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
  codePreview?: string
  label?: string | null
  maxUses?: number
  usedCount?: number
  expiresAt?: string | null
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

export default function RecruiterSubmissions() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<SubmissionDoc[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
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
  }, [])

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

  if (loading) return <LoadingState label="Loading submissions..." />
  if (err) return <ErrorState message={err} />

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
      <PageHeader
        title="Recruiter Submissions"
        description="Create one-time recruiter access codes and review recruiter-submitted candidates."
        actions={
          <a
            href="#recruiter-code-form"
            style={{ padding: "9px 12px", border: "1px solid #222", background: "#222", color: "#fff", borderRadius: 6, textDecoration: "none", fontSize: 13, fontWeight: 600 }}
          >
            Create single-use code
          </a>
        }
      />
      <RecruiterOpsPanel />
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

function RecruiterOpsPanel() {
  const [profiles, setProfiles] = useState<RecruiterProfileDoc[]>([])
  const [codes, setCodes] = useState<RecruiterInviteCodeDoc[]>([])
  const [notifications, setNotifications] = useState<RecruiterNotificationDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [label, setLabel] = useState("")
  const [expiresAtLocal, setExpiresAtLocal] = useState("")
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
      setExpiresAtLocal("")
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
  const focusCodeForm = () => {
    document.getElementById("recruiter-code-form")?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <Panel
      title="Recruiter access"
      eyebrow="Codes, accounts, notifications"
      actions={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={focusCodeForm}
            style={{ padding: "8px 12px", border: "1px solid #222", background: "#222", color: "#fff", borderRadius: 6 }}
          >
            Create single-use code
          </button>
          <button type="button" onClick={() => void reload()} disabled={loading}>Refresh</button>
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Active recruiters" value={activeRecruiters} />
        <OpsMetric label="New-role email on" value={emailOn} />
        <OpsMetric label="Usable codes" value={activeCodes} />
        <OpsMetric label="Notifications sent" value={sentNotifications} meta={failedNotifications ? `${failedNotifications} failed` : undefined} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 360px) 1fr", gap: 18 }}>
        <form id="recruiter-code-form" onSubmit={createCode} style={{ display: "grid", gap: 10 }}>
          <div style={{ fontWeight: 600 }}>Create single-use recruiter code</div>
          <p style={{ color: "#666", margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            Each code is single-use. The first successful signup binds it to one Firebase recruiter account.
          </p>
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
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>How new role notifications work</div>
            <p style={{ color: "#666", margin: 0, fontSize: 13, lineHeight: 1.5 }}>
              When a `pa-jobs` document becomes `wekruitCollaborationStatus=collaborated` with `recruiterBoard.active=true`,
              the recruiter-board function creates one idempotent notification per active recruiter and emails anyone with new-role notifications enabled.
            </p>
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Recent notifications</div>
            {notifications.slice(0, 5).map((n) => (
              <div key={n.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, padding: "8px 0", borderTop: "1px solid #eee", fontSize: 12 }}>
                <span>
                  <b>{n.roleTitle ?? "Role"}</b>
                  <br />
                  <span style={{ color: "#777" }}>{n.recruiterEmail ?? "unknown recruiter"}</span>
                </span>
                <Badge tone={n.status === "sent" ? "ok" : n.status === "failed" ? "warn" : "muted"}>{n.status ?? "queued"}</Badge>
              </div>
            ))}
            {!notifications.length && <p style={{ color: "#777", fontSize: 12, margin: 0 }}>No role notifications yet.</p>}
          </div>
        </div>
      </div>
    </Panel>
  )
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
