/**
 * Admin view of pa-recruiter-submissions.
 *
 * Lists every recruiter submission newest-first, with chip filters (job + status),
 * sortable columns, pagination, row drill-down. Backed by the unified DataTable
 * primitive + useTable hook.
 */
import { Fragment, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { arrayUnion, collection, doc, getDocs, getDocsFromServer, limit, orderBy, query, serverTimestamp, updateDoc } from "firebase/firestore"
import { AdminJobLink } from "../components/AdminEntityLink.js"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { DataTable, type Column } from "../components/console/primitives.js"
import { useTable } from "../components/console/useTable.js"
import { auth, db } from "../lib/firebase.js"
import { createRecruiterInviteCode, replaceRecruiterInviteCode, type CreateRecruiterInviteCodeResult } from "../lib/recruiter-platform-api.js"

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
const SOURCE_STAGE_VALUES = ["sourced", "contacted", "screened", "ready", "submitted", "archived"]
const CALIBRATION_VALUES = ["not_rated", "calibration_requested", "good_fit", "bad_fit", "suggested"]

interface SourcedCandidateDoc {
  id: string
  candidateId?: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  stage?: string
  candidate?: {
    name?: string
    link?: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  calibrationStatus?: string
  calibrationNote?: string | null
  calibrationUpdatedAt?: { seconds?: number } | string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
  updatedAtMs?: number
}

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

interface RecruiterRoleFeedbackDoc {
  id: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  difficulty?: string
  reasons?: string[]
  note?: string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
  updatedAtMs?: number
}

interface RecruiterRoleQuestionDoc {
  id: string
  questionId?: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  question?: string
  status?: "open" | "answered"
  answer?: string | null
  answeredByEmail?: string | null
  answeredAt?: { seconds?: number } | string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
  updatedAtMs?: number
}

interface RecruiterRoleApplicationDoc {
  id: string
  applicationId?: string
  recruiterId?: string
  recruiterEmail?: string
  jobId?: string
  inboundJobId?: string
  jobTitleSnapshot?: string
  companyLabelSnapshot?: string
  status?: "pending" | "approved" | "not_approved" | "withdrawn" | "rescinded"
  pitch?: string | null
  anonymizeCandidates?: boolean
  preparedCandidateIds?: string[]
  preparedCandidateCount?: number
  adminNote?: string | null
  reviewedByEmail?: string | null
  reviewedAt?: { seconds?: number } | string | null
  createdAt?: { seconds?: number } | string | null
  updatedAt?: { seconds?: number } | string | null
  updatedAtMs?: number
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

const KNOWN_RECRUITER_INVITE_CODES_KEY = "wekruit.admin.recruiterInviteCodes.v1"

function isFullRecruiterInviteCode(raw?: string | null): raw is string {
  const trimmed = raw?.trim()
  return Boolean(trimmed && /^WK-[A-Z0-9-]{4,40}$/.test(trimmed))
}

function readKnownRecruiterInviteCodes(): Record<string, string> {
  if (typeof window === "undefined") return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KNOWN_RECRUITER_INVITE_CODES_KEY) ?? "{}") as Record<string, unknown>
    const codes: Record<string, string> = {}
    for (const [id, code] of Object.entries(parsed)) {
      if (typeof code === "string" && isFullRecruiterInviteCode(code)) {
        codes[id] = code.trim().toUpperCase()
      }
    }
    return codes
  } catch {
    return {}
  }
}

function writeKnownRecruiterInviteCodes(codes: Record<string, string>): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(KNOWN_RECRUITER_INVITE_CODES_KEY, JSON.stringify(codes))
  } catch {
    // Firestore remains source of truth; this cache only preserves same-browser visibility.
  }
}

type RecruiterAdminSection = "codes" | "applications" | "sourced" | "feedback" | "questions" | "submissions"

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
        title={
          section === "codes"
            ? "Recruiter Access"
            : section === "applications"
              ? "Recruiter Applications"
            : section === "sourced"
              ? "Recruiter Sourced Candidates"
              : section === "feedback"
                ? "Recruiter Role Feedback"
                : section === "questions"
                  ? "Recruiter Role Questions"
                : "Recruiter Submissions"
        }
        description={
          section === "codes"
            ? "Create one-use recruiter access codes, review recruiter accounts, and monitor new-role alerts."
            : section === "applications"
              ? "Review recruiter requests to work specific roles, approve trusted coverage, and reject weak or over-capacity searches."
            : section === "sourced"
              ? "Review sourced prospects before formal submission, calibrate recruiters, and monitor role-level supply."
              : section === "feedback"
                ? "Review recruiter market feedback on role difficulty, blockers, and calibration gaps."
                : section === "questions"
                  ? "Answer recruiter role-calibration questions before they waste sourcing cycles."
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

  if (section === "sourced") {
    return (
      <div>
        {header}
        <RecruiterSourcedCandidatesPanel />
      </div>
    )
  }

  if (section === "applications") {
    return (
      <div>
        {header}
        <RecruiterRoleApplicationsPanel />
      </div>
    )
  }

  if (section === "feedback") {
    return (
      <div>
        {header}
        <RecruiterRoleFeedbackPanel />
      </div>
    )
  }

  if (section === "questions") {
    return (
      <div>
        {header}
        <RecruiterRoleQuestionsPanel />
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
      key: "applications",
      label: "Applications",
      to: "/admin/recruiter-applications",
      detail: "Approve role access",
    },
    {
      key: "sourced",
      label: "Sourced candidates",
      to: "/admin/recruiter-sourced",
      detail: "Calibration queue",
    },
    {
      key: "feedback",
      label: "Role feedback",
      to: "/admin/recruiter-feedback",
      detail: "Market blockers",
    },
    {
      key: "questions",
      label: "Role questions",
      to: "/admin/recruiter-questions",
      detail: "Calibration inbox",
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
        gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
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
  const [knownInviteCodes, setKnownInviteCodes] = useState<Record<string, string>>(() => readKnownRecruiterInviteCodes())
  const [creating, setCreating] = useState(false)
  const [replacingCodeId, setReplacingCodeId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    try {
      const [profileSnap, codeSnap, notificationSnap] = await Promise.all([
        getDocs(collection(db(), "pa-recruiter-users")),
        getDocsFromServer(collection(db(), "pa-recruiter-invite-codes")),
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
      rememberGeneratedCode(result)
      setLabel("")
      setExpiresAtLocal(defaultRecruiterCodeExpiryLocal())
      await reload()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  const rememberGeneratedCode = (result: CreateRecruiterInviteCodeResult) => {
    setGenerated(result)
    setKnownInviteCodes((prev) => {
      const next = { ...prev, [result.inviteCodeId]: result.inviteCode }
      writeKnownRecruiterInviteCodes(next)
      return next
    })
  }

  const replaceLegacyCode = async (inviteCodeId: string) => {
    setReplacingCodeId(inviteCodeId)
    setErr(null)
    try {
      const result = await replaceRecruiterInviteCode(inviteCodeId)
      rememberGeneratedCode(result)
      await reload()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setReplacingCodeId(null)
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
              {generated.replacedInviteCodeId && (
                <div style={{ color: "#7a3e10", fontSize: 12, marginTop: 4 }}>
                  Replaced the unrecoverable legacy code and disabled the old row.
                </div>
              )}
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
        <OpsSection title="Access codes" subtitle="Admins can view and copy one-use recruiter codes. Legacy hash-only rows can be replaced with a visible code.">
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
                    const rawInviteCode = isFullRecruiterInviteCode(code.inviteCode)
                      ? code.inviteCode
                      : knownInviteCodes[code.id]
                    const canCopy = isFullRecruiterInviteCode(rawInviteCode)
                    const visibleCode = canCopy ? rawInviteCode : code.codePreview ?? code.id.slice(0, 10)
                    const rawMissing = !canCopy && status.label === "usable"
                    return (
                      <tr key={code.id} style={{ borderBottom: "1px solid #f1f1f1" }}>
                        <td style={{ padding: "9px 6px", fontFamily: "monospace", fontWeight: 700, whiteSpace: "nowrap" }}>
                          <div>{visibleCode}</div>
                          {rawMissing && (
                            <div style={{ marginTop: 3, fontFamily: "inherit", fontWeight: 500, color: "#9a4b12", fontSize: 11 }}>
                              raw code unavailable
                            </div>
                          )}
                        </td>
                        <td style={{ padding: "9px 6px" }}>
                          {canCopy ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                void navigator.clipboard?.writeText(rawInviteCode)
                              }}
                              style={{ padding: "5px 8px", border: "1px solid #ccc", borderRadius: 6, background: "#fff", fontSize: 12 }}
                            >
                              Copy
                            </button>
                          ) : rawMissing ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                void replaceLegacyCode(code.id)
                              }}
                              disabled={replacingCodeId === code.id}
                              style={{ padding: "5px 8px", border: "1px solid #d9b892", borderRadius: 6, background: "#fff7ed", color: "#7a3e10", fontSize: 12 }}
                            >
                              {replacingCodeId === code.id ? "Replacing..." : "Replace"}
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

function calibrationTone(status?: string): Parameters<typeof Badge>[0]["tone"] {
  switch (status) {
    case "good_fit": return "ok"
    case "bad_fit": return "warn"
    case "calibration_requested": return "info"
    case "suggested": return "info"
    default: return "muted"
  }
}

function stageTone(stage?: string): Parameters<typeof Badge>[0]["tone"] {
  switch (stage) {
    case "ready": return "ok"
    case "submitted": return "info"
    case "archived": return "muted"
    case "screened": return "info"
    case "contacted": return "info"
    default: return "muted"
  }
}

function difficultyTone(difficulty?: string): Parameters<typeof Badge>[0]["tone"] {
  switch (difficulty) {
    case "blocked": return "warn"
    case "hard": return "info"
    case "easy": return "ok"
    default: return "muted"
  }
}

function prettyKey(value?: string | null): string {
  return value ? value.replace(/_/g, " ") : "not rated"
}

function RecruiterSourcedCandidatesPanel() {
  const [rows, setRows] = useState<SourcedCandidateDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setErr(null)
    try {
      const snap = await getDocs(query(
        collection(db(), "pa-recruiter-sourced-candidates"),
        orderBy("updatedAt", "desc"),
        limit(500),
      ))
      setRows(snap.docs.map((d) => {
        const data = d.data() as Omit<SourcedCandidateDoc, "id">
        return { id: d.id, ...data, updatedAtMs: timestampToMs(data.updatedAt ?? data.createdAt) }
      }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      const id = r.inboundJobId ?? r.jobId
      if (id && !seen.has(id)) seen.set(id, r.jobTitleSnapshot ?? id)
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: SourcedCandidateDoc) => r.inboundJobId === jobId || r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<SourcedCandidateDoc>(rows, {
    defaultSort: { key: "updatedAtMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.recruiterEmail?.toLowerCase().includes(q) ?? false) ||
      (r.candidate?.name?.toLowerCase().includes(q) ?? false) ||
      (r.candidate?.link?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.companyLabelSnapshot?.toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "stage",
        label: "Stage",
        multi: true,
        options: SOURCE_STAGE_VALUES.map((s) => ({
          key: s,
          label: s,
          test: (r: SourcedCandidateDoc) => (r.stage ?? "sourced") === s,
        })),
      },
      {
        id: "calibration",
        label: "Calibration",
        multi: true,
        options: CALIBRATION_VALUES.map((s) => ({
          key: s,
          label: prettyKey(s),
          test: (r: SourcedCandidateDoc) => (r.calibrationStatus ?? "not_rated") === s,
        })),
      },
    ],
  })

  const metrics = {
    total: rows.length,
    ready: rows.filter((r) => r.stage === "ready").length,
    submitted: rows.filter((r) => r.stage === "submitted").length,
    needsReview: rows.filter((r) => !r.calibrationStatus || r.calibrationStatus === "not_rated" || r.calibrationStatus === "calibration_requested").length,
  }

  if (loading) return <LoadingState label="Loading sourced candidates..." />
  if (err) return <ErrorState message={err} />

  const columns: Column<SourcedCandidateDoc>[] = [
    {
      key: "updatedAtMs",
      label: "Updated",
      sortable: true,
      width: 160,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatOpsDate(r.updatedAt ?? r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Role",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "—"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "recruiterEmail",
      label: "Recruiter",
      sortable: true,
      render: (r) => r.recruiterEmail ?? r.recruiterId ?? "—",
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
              {r.candidate.link.length > 42 ? r.candidate.link.slice(0, 42) + "..." : r.candidate.link}
            </a>
          )}
        </>
      ),
    },
    {
      key: "stage",
      label: "Stage",
      sortable: true,
      width: 120,
      render: (r) => <Badge tone={stageTone(r.stage)}>{r.stage ?? "sourced"}</Badge>,
    },
    {
      key: "calibrationStatus",
      label: "Calibration",
      sortable: true,
      width: 140,
      render: (r) => <Badge tone={calibrationTone(r.calibrationStatus)}>{prettyKey(r.calibrationStatus)}</Badge>,
    },
    {
      key: "calibrationNote",
      label: "Feedback",
      width: 180,
      render: (r) => r.calibrationNote ? (r.calibrationNote.length > 44 ? r.calibrationNote.slice(0, 44) + "..." : r.calibrationNote) : "—",
    },
  ]

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Sourced" value={metrics.total} />
        <OpsMetric label="Ready" value={metrics.ready} />
        <OpsMetric label="Submitted" value={metrics.submitted} />
        <OpsMetric label="Needs calibration" value={metrics.needsReview} />
      </div>
      <Panel>
        <DataTable<SourcedCandidateDoc>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search recruiter / candidate / role..."
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
              No sourced candidates match the current filters.
            </div>
          }
        />
      </Panel>
      {expandedId && (() => {
        const row = rows.find((r) => r.id === expandedId)
        if (!row) return null
        return (
          <SourcedCandidateDetailPanel
            row={row}
            onClose={() => setExpandedId(null)}
            onUpdated={(next) => {
              setRows((prev) => prev.map((r) => r.id === next.id ? { ...r, ...next, updatedAtMs: Date.now() } : r))
            }}
          />
        )
      })()}
    </div>
  )
}

function RecruiterRoleFeedbackPanel() {
  const [rows, setRows] = useState<RecruiterRoleFeedbackDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setErr(null)
    try {
      const snap = await getDocs(query(
        collection(db(), "pa-recruiter-role-feedback"),
        orderBy("updatedAt", "desc"),
        limit(500),
      ))
      setRows(snap.docs.map((d) => {
        const data = d.data() as Omit<RecruiterRoleFeedbackDoc, "id">
        return { id: d.id, ...data, updatedAtMs: timestampToMs(data.updatedAt ?? data.createdAt) }
      }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      const id = r.inboundJobId ?? r.jobId
      if (id && !seen.has(id)) seen.set(id, r.jobTitleSnapshot ?? id)
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: RecruiterRoleFeedbackDoc) => r.inboundJobId === jobId || r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<RecruiterRoleFeedbackDoc>(rows, {
    defaultSort: { key: "updatedAtMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.recruiterEmail?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.companyLabelSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.note?.toLowerCase().includes(q) ?? false) ||
      (r.reasons?.join(" ").toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "difficulty",
        label: "Difficulty",
        multi: true,
        options: ["easy", "medium", "hard", "blocked"].map((s) => ({
          key: s,
          label: s,
          test: (r: RecruiterRoleFeedbackDoc) => (r.difficulty ?? "medium") === s,
        })),
      },
      {
        id: "reason",
        label: "Reason",
        multi: true,
        options: [
          "low_comp",
          "location_mismatch",
          "unclear_requirements",
          "small_candidate_pool",
          "hiring_team_slow",
          "role_too_broad",
          "candidate_interest_low",
          "too_many_recruiters",
          "other",
        ].map((s) => ({
          key: s,
          label: prettyKey(s),
          test: (r: RecruiterRoleFeedbackDoc) => r.reasons?.includes(s) ?? false,
        })),
      },
    ],
  })

  const metrics = {
    total: rows.length,
    hard: rows.filter((r) => r.difficulty === "hard").length,
    blocked: rows.filter((r) => r.difficulty === "blocked").length,
    noted: rows.filter((r) => Boolean(r.note)).length,
  }

  if (loading) return <LoadingState label="Loading role feedback..." />
  if (err) return <ErrorState message={err} />

  const columns: Column<RecruiterRoleFeedbackDoc>[] = [
    {
      key: "updatedAtMs",
      label: "Updated",
      sortable: true,
      width: 160,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatOpsDate(r.updatedAt ?? r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Role",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "—"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "recruiterEmail",
      label: "Recruiter",
      sortable: true,
      render: (r) => r.recruiterEmail ?? r.recruiterId ?? "—",
    },
    {
      key: "difficulty",
      label: "Difficulty",
      sortable: true,
      width: 120,
      render: (r) => <Badge tone={difficultyTone(r.difficulty)}>{r.difficulty ?? "medium"}</Badge>,
    },
    {
      key: "reasons",
      label: "Reasons",
      render: (r) => (r.reasons?.length ? r.reasons.map(prettyKey).join(", ") : "—"),
    },
    {
      key: "note",
      label: "Note",
      render: (r) => r.note ? (r.note.length > 92 ? r.note.slice(0, 92) + "..." : r.note) : "—",
    },
  ]

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Feedback rows" value={metrics.total} />
        <OpsMetric label="Hard roles" value={metrics.hard} />
        <OpsMetric label="Blocked roles" value={metrics.blocked} />
        <OpsMetric label="With notes" value={metrics.noted} />
      </div>
      <Panel actions={<button type="button" onClick={() => void reload()}>Refresh</button>}>
        <DataTable<RecruiterRoleFeedbackDoc>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search recruiter / role / blocker..."
          sort={table.sort}
          onSort={table.toggleSort}
          page={table.page}
          pageCount={table.pageCount}
          onPageChange={table.setPage}
          onResetFilters={table.reset}
          count={table.filteredCount}
          totalCount={table.totalRows}
          empty={
            <div style={{ padding: 40, textAlign: "center", color: "#777" }}>
              No recruiter role feedback yet.
            </div>
          }
        />
      </Panel>
    </div>
  )
}

function applicationStatusTone(status?: string): Parameters<typeof Badge>[0]["tone"] {
  switch (status) {
    case "approved": return "ok"
    case "pending": return "info"
    case "not_approved":
    case "rescinded": return "warn"
    default: return "muted"
  }
}

function RecruiterRoleApplicationsPanel() {
  const [rows, setRows] = useState<RecruiterRoleApplicationDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setErr(null)
    try {
      const snap = await getDocs(query(
        collection(db(), "pa-recruiter-role-applications"),
        orderBy("updatedAt", "desc"),
        limit(500),
      ))
      setRows(snap.docs.map((d) => {
        const data = d.data() as Omit<RecruiterRoleApplicationDoc, "id">
        return { id: d.id, ...data, updatedAtMs: timestampToMs(data.updatedAt ?? data.createdAt) }
      }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      const id = r.inboundJobId ?? r.jobId
      if (id && !seen.has(id)) seen.set(id, r.jobTitleSnapshot ?? id)
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: RecruiterRoleApplicationDoc) => r.inboundJobId === jobId || r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<RecruiterRoleApplicationDoc>(rows, {
    defaultSort: { key: "updatedAtMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.recruiterEmail?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.companyLabelSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.pitch?.toLowerCase().includes(q) ?? false) ||
      (r.adminNote?.toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "status",
        label: "Status",
        multi: true,
        options: ["pending", "approved", "not_approved", "withdrawn", "rescinded"].map((s) => ({
          key: s,
          label: prettyKey(s),
          test: (r: RecruiterRoleApplicationDoc) => (r.status ?? "pending") === s,
        })),
      },
    ],
  })

  const metrics = {
    total: rows.length,
    pending: rows.filter((r) => r.status === "pending").length,
    approved: rows.filter((r) => r.status === "approved").length,
    withProof: rows.filter((r) => (r.preparedCandidateCount ?? 0) > 0).length,
  }

  if (loading) return <LoadingState label="Loading recruiter applications..." />
  if (err) return <ErrorState message={err} />

  const columns: Column<RecruiterRoleApplicationDoc>[] = [
    {
      key: "updatedAtMs",
      label: "Updated",
      sortable: true,
      width: 160,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatOpsDate(r.updatedAt ?? r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Role",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "—"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "recruiterEmail",
      label: "Recruiter",
      sortable: true,
      render: (r) => r.recruiterEmail ?? r.recruiterId ?? "—",
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      width: 130,
      render: (r) => <Badge tone={applicationStatusTone(r.status)}>{prettyKey(r.status ?? "pending")}</Badge>,
    },
    {
      key: "preparedCandidateCount",
      label: "Proof",
      sortable: true,
      width: 90,
      render: (r) => `${r.preparedCandidateCount ?? r.preparedCandidateIds?.length ?? 0}`,
    },
    {
      key: "pitch",
      label: "Pitch",
      render: (r) => r.pitch ? (r.pitch.length > 96 ? `${r.pitch.slice(0, 96)}...` : r.pitch) : "—",
    },
  ]

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Applications" value={metrics.total} />
        <OpsMetric label="Pending review" value={metrics.pending} />
        <OpsMetric label="Approved" value={metrics.approved} />
        <OpsMetric label="With candidate proof" value={metrics.withProof} />
      </div>
      <Panel actions={<button type="button" onClick={() => void reload()}>Refresh</button>}>
        <DataTable<RecruiterRoleApplicationDoc>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search recruiter / role / pitch..."
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
              No recruiter role applications yet.
            </div>
          }
        />
      </Panel>
      {expandedId && (() => {
        const row = rows.find((r) => r.id === expandedId)
        if (!row) return null
        return (
          <RoleApplicationDetailPanel
            row={row}
            onClose={() => setExpandedId(null)}
            onUpdated={(next) => {
              setRows((prev) => prev.map((r) => r.id === next.id ? { ...r, ...next, updatedAtMs: Date.now() } : r))
            }}
          />
        )
      })()}
    </div>
  )
}

function RoleApplicationDetailPanel({
  row,
  onClose,
  onUpdated,
}: {
  row: RecruiterRoleApplicationDoc
  onClose: () => void
  onUpdated: (next: RecruiterRoleApplicationDoc) => void
}) {
  const [status, setStatus] = useState(row.status ?? "pending")
  const [adminNote, setAdminNote] = useState(row.adminNote ?? "")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const saveReview = async () => {
    setSaving(true)
    setErr(null)
    try {
      const reviewedByEmail = auth().currentUser?.email ?? "operator"
      const cleanNote = adminNote.trim()
      await updateDoc(doc(db(), "pa-recruiter-role-applications", row.id), {
        status,
        adminNote: cleanNote || null,
        reviewedByEmail,
        reviewedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        statusHistory: arrayUnion({
          status,
          by: "admin",
          adminEmail: reviewedByEmail,
          atIso: new Date().toISOString(),
          ...(cleanNote ? { note: cleanNote } : {}),
        }),
      })
      onUpdated({
        ...row,
        status,
        adminNote: cleanNote || null,
        reviewedByEmail,
        updatedAtMs: Date.now(),
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel title="Review role application" eyebrow={row.jobTitleSnapshot ?? row.jobId ?? "Role application"}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
          <div><b>Recruiter:</b> {row.recruiterEmail ?? row.recruiterId ?? "—"}</div>
          <div><b>Role:</b> {row.jobId ? <AdminJobLink jobId={row.jobId}>{row.jobTitleSnapshot ?? row.jobId}</AdminJobLink> : row.jobTitleSnapshot ?? "—"}</div>
          <div><b>Prepared candidates:</b> {row.preparedCandidateCount ?? row.preparedCandidateIds?.length ?? 0}</div>
          <div><b>Anonymized:</b> {row.anonymizeCandidates ? "yes" : "no"}</div>
        </div>
        <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 8, background: "#faf8f4", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
          <b>Recruiter pitch:</b>
          <br />
          {row.pitch ?? "—"}
        </div>
      </div>
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid #eee", display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#555" }}>
          Review status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as NonNullable<RecruiterRoleApplicationDoc["status"]>)}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 8, font: "inherit", color: "#222" }}
          >
            {["pending", "approved", "not_approved", "rescinded"].map((s) => <option key={s} value={s}>{prettyKey(s)}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#555" }}>
          Recruiter-visible note
          <textarea
            value={adminNote}
            onChange={(e) => setAdminNote(e.target.value)}
            rows={5}
            placeholder="Why approved, what proof is missing, or what to improve before reapplying..."
            style={{ resize: "vertical", padding: 10, border: "1px solid #ddd", borderRadius: 8, font: "inherit", color: "#222" }}
          />
        </label>
        {err && <div style={{ color: "#a00", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => void saveReview()} disabled={saving}>
            {saving ? "Saving..." : "Save review"}
          </button>
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
      </div>
    </Panel>
  )
}

function questionStatusTone(status?: string): Parameters<typeof Badge>[0]["tone"] {
  return status === "answered" ? "ok" : "info"
}

function RecruiterRoleQuestionsPanel() {
  const [rows, setRows] = useState<RecruiterRoleQuestionDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setErr(null)
    try {
      const snap = await getDocs(query(
        collection(db(), "pa-recruiter-role-questions"),
        orderBy("updatedAt", "desc"),
        limit(500),
      ))
      setRows(snap.docs.map((d) => {
        const data = d.data() as Omit<RecruiterRoleQuestionDoc, "id">
        return { id: d.id, ...data, updatedAtMs: timestampToMs(data.updatedAt ?? data.createdAt) }
      }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      const id = r.inboundJobId ?? r.jobId
      if (id && !seen.has(id)) seen.set(id, r.jobTitleSnapshot ?? id)
    }
    return [...seen.entries()].map(([jobId, label]) => ({
      key: jobId,
      label,
      title: jobId,
      test: (r: RecruiterRoleQuestionDoc) => r.inboundJobId === jobId || r.jobId === jobId,
    }))
  }, [rows])

  const table = useTable<RecruiterRoleQuestionDoc>(rows, {
    defaultSort: { key: "updatedAtMs", dir: "desc" },
    pageSize: 50,
    search: (r, q) =>
      (r.recruiterEmail?.toLowerCase().includes(q) ?? false) ||
      (r.jobTitleSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.companyLabelSnapshot?.toLowerCase().includes(q) ?? false) ||
      (r.question?.toLowerCase().includes(q) ?? false) ||
      (r.answer?.toLowerCase().includes(q) ?? false),
    chips: [
      { id: "job", label: "Job", multi: false, options: jobOptions },
      {
        id: "status",
        label: "Status",
        multi: true,
        options: ["open", "answered"].map((s) => ({
          key: s,
          label: s,
          test: (r: RecruiterRoleQuestionDoc) => (r.status ?? "open") === s,
        })),
      },
    ],
  })

  const metrics = {
    total: rows.length,
    open: rows.filter((r) => (r.status ?? "open") === "open").length,
    answered: rows.filter((r) => r.status === "answered").length,
    recruiters: new Set(rows.map((r) => r.recruiterEmail ?? r.recruiterId).filter(Boolean)).size,
  }

  if (loading) return <LoadingState label="Loading recruiter questions..." />
  if (err) return <ErrorState message={err} />

  const columns: Column<RecruiterRoleQuestionDoc>[] = [
    {
      key: "updatedAtMs",
      label: "Updated",
      sortable: true,
      width: 160,
      render: (r) => <span style={{ whiteSpace: "nowrap" }}>{formatOpsDate(r.updatedAt ?? r.createdAt)}</span>,
    },
    {
      key: "jobTitleSnapshot",
      label: "Role",
      sortable: true,
      render: (r) => (
        <>
          <div style={{ fontWeight: 500 }}>
            {r.jobId ? <AdminJobLink jobId={r.jobId}>{r.jobTitleSnapshot ?? r.jobId}</AdminJobLink> : r.jobTitleSnapshot ?? "—"}
          </div>
          <div style={{ color: "#777", fontSize: 11 }}>{r.companyLabelSnapshot ?? ""}</div>
        </>
      ),
    },
    {
      key: "recruiterEmail",
      label: "Recruiter",
      sortable: true,
      render: (r) => r.recruiterEmail ?? r.recruiterId ?? "—",
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      width: 110,
      render: (r) => <Badge tone={questionStatusTone(r.status)}>{r.status ?? "open"}</Badge>,
    },
    {
      key: "question",
      label: "Question",
      render: (r) => r.question ? (r.question.length > 96 ? r.question.slice(0, 96) + "..." : r.question) : "—",
    },
    {
      key: "answer",
      label: "Answer",
      render: (r) => r.answer ? (r.answer.length > 80 ? r.answer.slice(0, 80) + "..." : r.answer) : "—",
    },
  ]

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <OpsMetric label="Questions" value={metrics.total} />
        <OpsMetric label="Open" value={metrics.open} />
        <OpsMetric label="Answered" value={metrics.answered} />
        <OpsMetric label="Recruiters" value={metrics.recruiters} />
      </div>
      <Panel actions={<button type="button" onClick={() => void reload()}>Refresh</button>}>
        <DataTable<RecruiterRoleQuestionDoc>
          columns={columns}
          rows={table.visibleRows}
          chips={table.chipsForRender}
          search={table.search}
          onSearch={table.setSearch}
          searchPlaceholder="Search recruiter / role / question..."
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
              No recruiter role questions yet.
            </div>
          }
        />
      </Panel>
      {expandedId && (() => {
        const row = rows.find((r) => r.id === expandedId)
        if (!row) return null
        return (
          <RoleQuestionDetailPanel
            row={row}
            onClose={() => setExpandedId(null)}
            onUpdated={(next) => {
              setRows((prev) => prev.map((r) => r.id === next.id ? { ...r, ...next, updatedAtMs: Date.now() } : r))
            }}
          />
        )
      })()}
    </div>
  )
}

function RoleQuestionDetailPanel({
  row,
  onClose,
  onUpdated,
}: {
  row: RecruiterRoleQuestionDoc
  onClose: () => void
  onUpdated: (next: RecruiterRoleQuestionDoc) => void
}) {
  const [answer, setAnswer] = useState(row.answer ?? "")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const saveAnswer = async () => {
    const trimmed = answer.trim()
    if (!trimmed) {
      setErr("Answer is required.")
      return
    }
    setSaving(true)
    setErr(null)
    try {
      const answeredByEmail = auth().currentUser?.email ?? "operator"
      await updateDoc(doc(db(), "pa-recruiter-role-questions", row.id), {
        answer: trimmed,
        status: "answered",
        answeredByEmail,
        answeredAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      onUpdated({
        ...row,
        answer: trimmed,
        status: "answered",
        answeredByEmail,
        updatedAtMs: Date.now(),
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel title="Answer recruiter question" eyebrow={row.jobTitleSnapshot ?? row.jobId ?? "Role question"}>
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
          <div><b>Recruiter:</b> {row.recruiterEmail ?? row.recruiterId ?? "—"}</div>
          <div><b>Role:</b> {row.jobId ? <AdminJobLink jobId={row.jobId}>{row.jobTitleSnapshot ?? row.jobId}</AdminJobLink> : row.jobTitleSnapshot ?? "—"}</div>
          <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 8, background: "#faf8f4", lineHeight: 1.5 }}>
            <b>Question:</b> {row.question ?? "—"}
          </div>
        </div>
        <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#555" }}>
          Recruiter-visible answer
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={5}
            style={{ resize: "vertical", padding: 10, border: "1px solid #ddd", borderRadius: 8, font: "inherit", color: "#222" }}
          />
        </label>
        {err && <div style={{ color: "#a00", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => void saveAnswer()} disabled={saving || !answer.trim()}>
            {saving ? "Saving..." : "Save answer"}
          </button>
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
      </div>
    </Panel>
  )
}

function SourcedCandidateDetailPanel({
  row,
  onClose,
  onUpdated,
}: {
  row: SourcedCandidateDoc
  onClose: () => void
  onUpdated: (row: Partial<SourcedCandidateDoc> & { id: string }) => void
}) {
  const [draftStage, setDraftStage] = useState(row.stage ?? "sourced")
  const [draftCalibration, setDraftCalibration] = useState(row.calibrationStatus ?? "not_rated")
  const [draftNote, setDraftNote] = useState(row.calibrationNote ?? "")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await updateDoc(doc(db(), "pa-recruiter-sourced-candidates", row.id), {
        stage: draftStage,
        calibrationStatus: draftCalibration,
        calibrationNote: draftNote.trim() || null,
        calibrationUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        calibrationHistory: arrayUnion({
          stage: draftStage,
          calibrationStatus: draftCalibration,
          note: draftNote.trim() || null,
          by: "admin",
          atIso: new Date().toISOString(),
        }),
      })
      onUpdated({
        id: row.id,
        stage: draftStage,
        calibrationStatus: draftCalibration,
        calibrationNote: draftNote.trim() || null,
        calibrationUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      title="Sourced candidate calibration"
      actions={
        <button
          onClick={onClose}
          style={{ border: "none", background: "none", cursor: "pointer", color: "#888", fontSize: 16 }}
          aria-label="Close"
        >
          x
        </button>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>Candidate</h4>
          <p style={{ margin: 0, fontSize: 13 }}>
            <strong>{row.candidate?.name ?? "Candidate"}</strong>
            {row.candidate?.currentRole && <> - {row.candidate.currentRole}</>}
            {row.candidate?.yoe && <> - {row.candidate.yoe} YOE</>}
          </p>
          {row.candidate?.link && (
            <p style={{ margin: "4px 0 0", fontSize: 12 }}>
              <a href={row.candidate.link} target="_blank" rel="noopener noreferrer">{row.candidate.link}</a>
            </p>
          )}
          {row.candidate?.notes && (
            <>
              <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>Recruiter note</h4>
              <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{row.candidate.notes}</p>
            </>
          )}
        </div>
        <div>
          <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>Role</h4>
          <p style={{ margin: 0, fontSize: 13 }}>
            <strong>{row.jobTitleSnapshot ?? row.jobId ?? "Role"}</strong>
            <br />
            <span style={{ color: "#777" }}>{row.companyLabelSnapshot ?? ""}</span>
          </p>
          <h4 style={{ margin: "12px 0 6px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>Recruiter</h4>
          <p style={{ margin: 0, fontSize: 13 }}>{row.recruiterEmail ?? row.recruiterId ?? "—"}</p>
        </div>
      </div>
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid #eee" }}>
        <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", color: "#777" }}>
          Recruiter-visible calibration
        </h4>
        <div style={{ display: "grid", gridTemplateColumns: "160px 190px 1fr auto", gap: 10, alignItems: "start" }}>
          <select
            value={draftStage}
            onChange={(e) => setDraftStage(e.target.value)}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
          >
            {SOURCE_STAGE_VALUES.map((s) => <option value={s} key={s}>{s}</option>)}
          </select>
          <select
            value={draftCalibration}
            onChange={(e) => setDraftCalibration(e.target.value)}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
          >
            {CALIBRATION_VALUES.map((s) => <option value={s} key={s}>{prettyKey(s)}</option>)}
          </select>
          <textarea
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="Feedback visible to recruiter, e.g. why good fit or what to adjust..."
            rows={3}
            style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13, resize: "vertical" }}
          />
          <button
            onClick={save}
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
      const cleanNote = draftNote.trim()
      await updateDoc(doc(db(), "pa-recruiter-submissions", row.id), {
        status: draftStatus,
        recruiterFeedbackNote: cleanNote || null,
        recruiterFeedbackUpdatedAt: serverTimestamp(),
        statusHistory: arrayUnion({
          status: draftStatus,
          by: "admin",
          atIso: new Date().toISOString(),
          ...(cleanNote ? { note: cleanNote } : {}),
        }),
        updatedAt: serverTimestamp(),
      })
      onUpdated({
        id: row.id,
        status: draftStatus,
        recruiterFeedbackNote: cleanNote || null,
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
