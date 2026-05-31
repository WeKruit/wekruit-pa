/**
 * Recruiter platform — /recruiters
 *
 * Invite-gated marketplace for WeKruit partner recruiters. Roles come from
 * pa-jobs through paCollabJobsList; submissions and recruiter-visible status
 * come from pa-recruiter-submissions.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react"
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth"
import { Link, useSearchParams } from "react-router-dom"
import "../styles/recruiter-board.css"
import {
  fetchCollabJobs,
  fetchRecruiterSubmissions,
  getRecruiterProfile,
  registerRecruiterAccess,
  updateRecruiterPreferences,
  type CollabJob,
  type RecruiterSession,
  type RecruiterSubmissionItem,
} from "../lib/recruiter-board-api.js"
import { auth } from "../lib/firebase.js"

type RecruiterTab = "overview" | "roles" | "submissions" | "feedback" | "settings"

const TABS: Array<{ id: RecruiterTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "roles", label: "Roles" },
  { id: "submissions", label: "Submissions" },
  { id: "feedback", label: "Feedback" },
  { id: "settings", label: "Settings" },
]

const STATUS_LABELS: Record<string, { label: string; tone: "live" | "info" | "success" | "warn" | "mute" }> = {
  new: { label: "Submitted", tone: "live" },
  submitted: { label: "Submitted", tone: "live" },
  reviewing: { label: "WeKruit review", tone: "info" },
  advanced: { label: "Sent to hiring team", tone: "success" },
  interviewing: { label: "Interviewing", tone: "success" },
  hired: { label: "Hired", tone: "success" },
  rejected: { label: "Not a fit", tone: "warn" },
  duplicate: { label: "Duplicate", tone: "mute" },
}

function statusMeta(status?: string) {
  return STATUS_LABELS[status ?? "submitted"] ?? { label: status ?? "Submitted", tone: "mute" as const }
}

function createdAtMs(s: RecruiterSubmissionItem): number {
  const raw = s.createdAt
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "object" && typeof raw.seconds === "number") return raw.seconds * 1000
  return 0
}

function formatWhen(s: RecruiterSubmissionItem): string {
  const ms = createdAtMs(s)
  return ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Just now"
}

function shortText(text: string | undefined, fallback = "—", max = 56): string {
  if (!text) return fallback
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function sortSubmissions(rows: RecruiterSubmissionItem[]): RecruiterSubmissionItem[] {
  return [...rows].sort((a, b) => createdAtMs(b) - createdAtMs(a))
}

function submissionScore(s: RecruiterSubmissionItem): string {
  if (!s.score) return "Score pending"
  return `Hard ${s.score.hardChecked}/${s.score.hardTotal} · Fit ${s.score.fitChecked}/${s.score.fitTotal}`
}

export default function RecruiterBoard() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [session, setSession] = useState<RecruiterSession | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [submissions, setSubmissions] = useState<RecruiterSubmissionItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const tabParam = searchParams.get("tab")
  const activeTab = TABS.some((t) => t.id === tabParam) ? tabParam as RecruiterTab : "overview"

  useEffect(() => {
    fetchCollabJobs()
      .then((list) => setJobs(list))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      void (async () => {
        if (!user) {
          if (!active) return
          setSession(null)
          setSubmissions([])
          setAuthReady(true)
          return
        }
        try {
          const next = await getRecruiterProfile()
          if (active) setSession(next)
        } catch {
          if (active) setSession(null)
        } finally {
          if (active) setAuthReady(true)
        }
      })()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const reloadSubmissions = async () => {
    if (!session) return
    try {
      setSubmissionError(null)
      const rows = await fetchRecruiterSubmissions()
      setSubmissions(sortSubmissions(rows))
    } catch (e) {
      setSubmissionError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void reloadSubmissions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.recruiterId])

  const setTab = (tab: RecruiterTab) => setSearchParams(tab === "overview" ? {} : { tab })

  if (!authReady) {
    return <div className="rb-access"><div className="rb-state">Loading recruiter workspace...</div></div>
  }

  if (!session) {
    return <RecruiterAccessGate onAuthed={(next) => {
      setSession(next)
      void reloadSubmissions()
    }} />
  }

  const openJobs = jobs ?? []
  const stats = computeRecruiterStats(openJobs, submissions)
  const recentSubmissions = submissions.slice(0, 4)
  const feedbackRows = submissions.filter((s) => Boolean(s.recruiterFeedbackNote))

  return (
    <div className="rb-platform">
      <aside className="rb-platform__nav">
        <Link to="/" className="rb-platform__brand" aria-label="WeKruit">
          <span className="rb-platform__logo">W</span>
          <span>
            <strong>WeKruit</strong>
            <em>Recruiter</em>
          </span>
        </Link>
        <div className="rb-platform__identity">
          <span className="rb-platform__avatar">{session.recruiter.name.slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{session.recruiter.name}</strong>
            <em>{session.recruiter.email}</em>
          </span>
        </div>
        <nav className="rb-platform__tabs" aria-label="Recruiter workspace">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? "is-active" : ""}
              onClick={() => setTab(tab.id)}
            >
              {tab.label}
              {tab.id === "submissions" && submissions.length > 0 ? <span>{submissions.length}</span> : null}
            </button>
          ))}
        </nav>
        <Link to={openJobs[0] ? `/recruiters/job/${openJobs[0].jobId}` : "#"} className="rb-platform__cta">
          Submit candidate
        </Link>
        <button
          type="button"
          className="rb-platform__signout"
          onClick={() => {
            void signOut(auth())
            setSession(null)
            setSubmissions([])
          }}
        >
          Sign out
        </button>
      </aside>

      <main className="rb-platform__main">
        <header className="rb-platform__top">
          <div>
            <p className="rb-overline">Private recruiter workspace</p>
            <h1>{activeTab === "overview" ? `Good to see you, ${session.recruiter.name.split(" ")[0]}.` : TABS.find((t) => t.id === activeTab)?.label}</h1>
          </div>
          <div className="rb-platform__top-actions">
            <button type="button" className="rb-btn" onClick={() => void reloadSubmissions()}>
              Refresh status
            </button>
            <button type="button" className="rb-btn primary" onClick={() => setTab("roles")}>
              Browse roles
            </button>
          </div>
        </header>

        {error && <div className="rb-state error">Could not load roles: {error}</div>}
        {submissionError && <div className="rb-state error">Could not load your submissions: {submissionError}</div>}

        {activeTab === "overview" && (
          <OverviewTab
            stats={stats}
            jobs={openJobs}
            submissions={recentSubmissions}
            onRoles={() => setTab("roles")}
            onSubmissions={() => setTab("submissions")}
          />
        )}
        {activeTab === "roles" && <RolesTab jobs={openJobs} loading={!jobs && !error} />}
        {activeTab === "submissions" && <SubmissionsTab submissions={submissions} />}
        {activeTab === "feedback" && <FeedbackTab submissions={feedbackRows} />}
        {activeTab === "settings" && <SettingsTab session={session} onSessionChange={setSession} />}
      </main>
    </div>
  )
}

function computeRecruiterStats(jobs: CollabJob[], submissions: RecruiterSubmissionItem[]) {
  const reviewing = submissions.filter((s) => ["submitted", "new", "reviewing"].includes(s.status ?? "submitted")).length
  const advanced = submissions.filter((s) => ["advanced", "interviewing", "hired"].includes(s.status ?? "")).length
  const feedback = submissions.filter((s) => Boolean(s.recruiterFeedbackNote)).length
  return [
    { label: "Open roles", value: String(jobs.length), meta: "from WeKruit collab jobs" },
    { label: "My submissions", value: String(submissions.length), meta: "tracked by your recruiter account" },
    { label: "In review", value: String(reviewing), meta: "waiting on WeKruit or hiring team" },
    { label: "Advanced", value: String(advanced), meta: feedback ? `${feedback} feedback notes` : "no feedback notes yet" },
  ]
}

function RecruiterAccessGate({ onAuthed }: { onAuthed: (session: RecruiterSession) => void }) {
  const [mode, setMode] = useState<"signup" | "signin">("signup")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [inviteCode, setInviteCode] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    setNotice(null)
    try {
      if (mode === "signup") {
        const normalizedEmail = email.trim().toLowerCase()
        const currentUser = auth().currentUser
        if (currentUser?.email?.toLowerCase() === normalizedEmail) {
          // This lets a recruiter retry a code after Firebase account creation
          // succeeded but the invite-code binding failed.
        } else {
          if (currentUser) await signOut(auth())
          await createUserWithEmailAndPassword(auth(), normalizedEmail, password)
        }
        const session = await registerRecruiterAccess({ name, email, inviteCode })
        onAuthed(session)
      } else {
        await signInWithEmailAndPassword(auth(), email.trim(), password)
        const session = await getRecruiterProfile()
        onAuthed(session)
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const resetPassword = async () => {
    if (!email.trim()) {
      setErr("Enter your email first.")
      return
    }
    setBusy(true)
    setErr(null)
    setNotice(null)
    try {
      await sendPasswordResetEmail(auth(), email.trim())
      setNotice("Password reset email sent.")
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const switchMode = (next: "signup" | "signin") => {
    setMode(next)
    setErr(null)
    setNotice(null)
  }

  const title = mode === "signup" ? "Create recruiter account" : "Sign in"
  const cta = mode === "signup" ? "Create account" : "Sign in"

  return (
    <div className="rb-access">
      <div className="rb-access__bar">
        <Link to="/" className="rb-platform__brand">
          <span className="rb-platform__logo">W</span>
          <span><strong>WeKruit</strong><em>Recruiter</em></span>
        </Link>
        <Link to="/" className="rb-access__link">Back to WeKruit</Link>
      </div>
      <main className="rb-access__body">
        <section className="rb-access__copy">
          <p className="rb-overline">Invite only</p>
          <h1>Submit candidates into live WeKruit searches.</h1>
          <p>
            Browse collab roles, send qualified candidates with consent, and track
            WeKruit review status from one recruiter workspace.
          </p>
          <ul>
            <li>Roles are pulled from WeKruit collab `pa-jobs`.</li>
            <li>Every submission is bound to your Firebase recruiter account.</li>
            <li>New role alerts and feedback stay attached to your login.</li>
          </ul>
        </section>
        <form className="rb-access__card" onSubmit={submit}>
          <span className="rb-access__badge">Registered recruiters only</span>
          <div className="rb-access__switch" role="tablist" aria-label="Recruiter auth mode">
            <button type="button" className={mode === "signup" ? "is-active" : ""} onClick={() => switchMode("signup")}>Create account</button>
            <button type="button" className={mode === "signin" ? "is-active" : ""} onClick={() => switchMode("signin")}>Sign in</button>
          </div>
          <h2>{title}</h2>
          {mode === "signup" && (
            <>
              <label>
                <span>Access code</span>
                <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="WK-XXXX-XXXX" autoComplete="one-time-code" required />
              </label>
              <label>
                <span>Your name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sloane Whitfield" autoComplete="name" required />
              </label>
            </>
          )}
          <label>
            <span>Work email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@agency.com" autoComplete="username" required />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
            />
          </label>
          {err && <p className="rb-access__err">{err}</p>}
          {notice && <p className="rb-access__notice">{notice}</p>}
          <button className="rb-btn primary rb-btn--block" disabled={busy}>
            {busy ? "Working..." : cta}
          </button>
          {mode === "signin" && (
            <button type="button" className="rb-access__reset" disabled={busy} onClick={() => void resetPassword()}>
              Reset password
            </button>
          )}
        </form>
      </main>
    </div>
  )
}

function OverviewTab({
  stats,
  jobs,
  submissions,
  onRoles,
  onSubmissions,
}: {
  stats: Array<{ label: string; value: string; meta: string }>
  jobs: CollabJob[]
  submissions: RecruiterSubmissionItem[]
  onRoles: () => void
  onSubmissions: () => void
}) {
  return (
    <div className="rb-workspace">
      <section className="rb-stats">
        {stats.map((s) => (
          <article className="rb-stat" key={s.label}>
            <span>{s.label}</span>
            <strong>{s.value}</strong>
            <em>{s.meta}</em>
          </article>
        ))}
      </section>
      <div className="rb-workspace__grid">
        <section className="rb-panel">
          <header className="rb-panel__head">
            <div><h2>Roles ready for candidates</h2><p>Open searches with WeKruit collaboration enabled.</p></div>
            <button type="button" className="rb-panel__link" onClick={onRoles}>All roles</button>
          </header>
          <div className="rb-role-list">
            {jobs.slice(0, 4).map((job) => <RoleRow key={job.jobId} job={job} />)}
            {jobs.length === 0 && <p className="rb-empty">No active collab roles right now.</p>}
          </div>
        </section>
        <section className="rb-panel">
          <header className="rb-panel__head">
            <div><h2>Status tracker</h2><p>Submission feedback lands here after WeKruit review.</p></div>
            <button type="button" className="rb-panel__link" onClick={onSubmissions}>Open tracker</button>
          </header>
          <div className="rb-submission-list">
            {submissions.map((s) => <SubmissionRow key={s.id} submission={s} />)}
            {submissions.length === 0 && <p className="rb-empty">Submit your first candidate from a role page.</p>}
          </div>
        </section>
      </div>
    </div>
  )
}

function RolesTab({ jobs, loading }: { jobs: CollabJob[]; loading: boolean }) {
  const [q, setQ] = useState("")
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return jobs
    return jobs.filter((j) =>
      j.title.toLowerCase().includes(needle) ||
      j.recruiterBoard.label.location.toLowerCase().includes(needle) ||
      j.recruiterBoard.label.company.toLowerCase().includes(needle) ||
      j.recruiterBoard.label.pills.some((p) => p.text.toLowerCase().includes(needle)),
    )
  }, [jobs, q])

  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Role marketplace</h2><p>These are the live WeKruit collab `pa-jobs` open to recruiter submissions.</p></div>
        <label className="rb-search">
          <span>Search roles</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, location, tag..." autoComplete="off" />
        </label>
      </header>
      {loading && <div className="rb-state">Loading open roles...</div>}
      {!loading && (
        <div className="rb-role-grid">
          {filtered.map((job) => <RoleCard key={job.jobId} job={job} />)}
          {filtered.length === 0 && <p className="rb-empty">No roles match that search.</p>}
        </div>
      )}
    </section>
  )
}

function SubmissionsTab({ submissions }: { submissions: RecruiterSubmissionItem[] }) {
  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Submission pipeline</h2><p>Each row is one candidate you submitted through the recruiter board.</p></div>
      </header>
      <div className="rb-submission-list rb-submission-list--full">
        {submissions.map((s) => <SubmissionRow key={s.id} submission={s} expanded />)}
        {submissions.length === 0 && <p className="rb-empty">No submissions yet. Open a role and submit a candidate with consent.</p>}
      </div>
    </section>
  )
}

function FeedbackTab({ submissions }: { submissions: RecruiterSubmissionItem[] }) {
  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Feedback loop</h2><p>WeKruit review notes show up here so your next candidates calibrate faster.</p></div>
      </header>
      <div className="rb-submission-list rb-submission-list--full">
        {submissions.map((s) => <SubmissionRow key={s.id} submission={s} expanded />)}
        {submissions.length === 0 && <p className="rb-empty">No written feedback yet. Status changes will still appear in Submissions.</p>}
      </div>
    </section>
  )
}

function SettingsTab({
  session,
  onSessionChange,
}: {
  session: RecruiterSession
  onSessionChange: (session: RecruiterSession) => void
}) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const newRolesEmail = session.recruiter.notificationPreferences?.newRolesEmail !== false
  const setNewRolesEmail = async (next: boolean) => {
    setSaving(true)
    setErr(null)
    try {
      const updated = await updateRecruiterPreferences({ newRolesEmail: next })
      onSessionChange(updated)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <section className="rb-panel rb-panel--settings">
      <header className="rb-panel__head">
        <div><h2>Recruiter account</h2><p>Invite-gated access for partner recruiters.</p></div>
      </header>
      <dl className="rb-settings">
        <div><dt>Name</dt><dd>{session.recruiter.name}</dd></div>
        <div><dt>Email</dt><dd>{session.recruiter.email}</dd></div>
        <div><dt>Access model</dt><dd>Firebase Auth + recruiter access code</dd></div>
      </dl>
      <label className="rb-settings-toggle">
        <span>
          <strong>New role email notifications</strong>
          <em>WeKruit will email you when a new collab role opens for submissions.</em>
        </span>
        <input
          type="checkbox"
          checked={newRolesEmail}
          disabled={saving}
          onChange={(e) => void setNewRolesEmail(e.target.checked)}
        />
      </label>
      {err && <p className="rb-access__err">{err}</p>}
      <p className="rb-settings__note">
        WeKruit issues recruiter access codes manually. If the code is revoked or expires, this workspace stops loading status data.
      </p>
    </section>
  )
}

function RoleCard({ job }: { job: CollabJob }) {
  const hard = job.recruiterBoard.checklist.groups.find((g) => g.kind === "hard")?.items.length ?? 0
  const fit = job.recruiterBoard.checklist.groups.find((g) => g.kind === "fit")?.items.length ?? 0
  return (
    <Link to={`/recruiters/job/${job.jobId}`} className="rb-role-card">
      <span className="rb-role-card__code">Co. {job.recruiterBoard.label.companyCode}</span>
      <h3>{job.title}</h3>
      <p>{job.recruiterBoard.label.company} · {job.recruiterBoard.label.location}</p>
      <div className="rb-role-card__pills">
        {job.recruiterBoard.label.pills.map((p, i) => <span key={i} className={`rb-pill ${p.tone ?? ""}`}>{p.text}</span>)}
      </div>
      <footer>
        <span>{hard} hard checks</span>
        <span>{fit} fit checks</span>
      </footer>
    </Link>
  )
}

function RoleRow({ job }: { job: CollabJob }) {
  return (
    <Link to={`/recruiters/job/${job.jobId}`} className="rb-role-row">
      <span className="rb-role-row__logo">{job.recruiterBoard.label.companyCode}</span>
      <span className="rb-role-row__body">
        <strong>{job.title}</strong>
        <em>{job.recruiterBoard.label.company} · {job.recruiterBoard.label.location}</em>
      </span>
      <span className="rb-role-row__action">Open role</span>
    </Link>
  )
}

function SubmissionRow({ submission, expanded = false }: { submission: RecruiterSubmissionItem; expanded?: boolean }) {
  const meta = statusMeta(submission.status)
  return (
    <article className={`rb-submission ${expanded ? "is-expanded" : ""}`}>
      <div className="rb-submission__main">
        <span className={`rb-status is-${meta.tone}`}>{meta.label}</span>
        <div>
          <h3>{submission.candidate?.name ?? "Candidate"}</h3>
          <p>{shortText(submission.jobTitleSnapshot, "Role")} · {shortText(submission.companyLabelSnapshot, "Company")}</p>
        </div>
      </div>
      <div className="rb-submission__side">
        <span>{formatWhen(submission)}</span>
        <strong>{submissionScore(submission)}</strong>
      </div>
      {expanded && (
        <div className="rb-submission__detail">
          <p><strong>Candidate:</strong> {submission.candidate?.currentRole || "Role not provided"}{submission.candidate?.yoe ? ` · ${submission.candidate.yoe} YOE` : ""}</p>
          {submission.candidate?.link && <a href={submission.candidate.link} target="_blank" rel="noopener noreferrer">{shortText(submission.candidate.link, submission.candidate.link, 80)}</a>}
          {submission.recruiterFeedbackNote && (
            <blockquote>{submission.recruiterFeedbackNote}</blockquote>
          )}
        </div>
      )}
    </article>
  )
}
