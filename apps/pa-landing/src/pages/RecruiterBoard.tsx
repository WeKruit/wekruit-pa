/**
 * Recruiter platform — /recruiters
 *
 * Invite-gated marketplace for WeKruit partner recruiters. Roles come from
 * pa-jobs through paCollabJobsList; submissions and recruiter-visible status
 * come from pa-recruiter-submissions.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react"
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth"
import { Link, useSearchParams } from "react-router-dom"
import "../styles/recruiter-board.css"
import {
  fetchCollabJobs,
  fetchRecruiterSourcedCandidates,
  fetchRecruiterSubmissions,
  getRecruiterProfile,
  registerRecruiterAccess,
  saveRecruiterSourcedCandidate,
  updateRecruiterPreferences,
  type CollabJob,
  type RecruiterSession,
  type RecruiterSourcedCandidateInput,
  type RecruiterSourcedCandidateItem,
  type RecruiterSourcedCandidateStage,
  type RecruiterSubmissionItem,
} from "../lib/recruiter-board-api.js"
import { auth } from "../lib/firebase.js"
import { redirectResultPromise } from "../lib/auth-redirect-bootstrap.js"

type RecruiterTab = "overview" | "roles" | "matches" | "candidates" | "submissions" | "performance" | "settings"

const TABS: Array<{ id: RecruiterTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "roles", label: "Roles" },
  { id: "matches", label: "Matchboard" },
  { id: "candidates", label: "Candidates" },
  { id: "submissions", label: "Submissions" },
  { id: "performance", label: "Performance" },
  { id: "settings", label: "Settings" },
]

const ROLE_FILTERS = [
  { id: "all", label: "All roles" },
  { id: "new", label: "New this week" },
  { id: "with_candidates", label: "Has candidates" },
  { id: "needs_submissions", label: "Needs submissions" },
] as const

type RoleFilter = typeof ROLE_FILTERS[number]["id"]

const PRIMARY_ROLE_SLOT_LIMIT = 5
const SINGLE_SUBMISSION_WEEKLY_LIMIT = 5

const SOURCE_STAGES: Array<{ id: RecruiterSourcedCandidateStage; label: string; tone: "live" | "info" | "success" | "warn" | "mute" }> = [
  { id: "sourced", label: "Sourced", tone: "mute" },
  { id: "contacted", label: "Contacted", tone: "info" },
  { id: "screened", label: "Screened", tone: "info" },
  { id: "ready", label: "Ready", tone: "live" },
  { id: "submitted", label: "Submitted", tone: "success" },
  { id: "archived", label: "Archived", tone: "mute" },
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

const CALIBRATION_LABELS: Record<string, { label: string; tone: "live" | "info" | "success" | "warn" | "mute" }> = {
  not_rated: { label: "Not rated", tone: "mute" },
  calibration_requested: { label: "Needs adjustment", tone: "info" },
  good_fit: { label: "Good fit", tone: "success" },
  bad_fit: { label: "Not a fit", tone: "warn" },
  suggested: { label: "Suggested direction", tone: "info" },
}

const SUBMISSION_PROGRESS = [
  { id: "submitted", label: "Submitted" },
  { id: "reviewing", label: "WeKruit review" },
  { id: "advanced", label: "Hiring team" },
  { id: "interviewing", label: "Interviewing" },
  { id: "hired", label: "Hired" },
] as const

function statusMeta(status?: string) {
  return STATUS_LABELS[status ?? "submitted"] ?? { label: status ?? "Submitted", tone: "mute" as const }
}

function calibrationMeta(status?: string) {
  return CALIBRATION_LABELS[status ?? "not_rated"] ?? { label: status?.replace(/_/g, " ") ?? "Not rated", tone: "mute" as const }
}

function createdAtMs(s: RecruiterSubmissionItem): number {
  return timestampValueMs(s.createdAt)
}

function updatedAtMs(s: RecruiterSourcedCandidateItem): number {
  return timestampValueMs(s.updatedAt ?? s.createdAt)
}

function timestampValueMs(raw: RecruiterSubmissionItem["createdAt"] | RecruiterSourcedCandidateItem["createdAt"]): number {
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

function sortSourcedCandidates(rows: RecruiterSourcedCandidateItem[]): RecruiterSourcedCandidateItem[] {
  return [...rows].sort((a, b) => updatedAtMs(b) - updatedAtMs(a))
}

function submissionScore(s: RecruiterSubmissionItem): string {
  if (!s.score) return "Score pending"
  return `Hard ${s.score.hardChecked}/${s.score.hardTotal} · Fit ${s.score.fitChecked}/${s.score.fitTotal}`
}

function roleKey(job: CollabJob): string {
  return job.jobId
}

function recruiterPrimaryRoleIds(session: RecruiterSession | null): string[] {
  return session?.recruiter.workspacePreferences?.primaryRoleIds ?? []
}

function isPrimaryRole(job: CollabJob, primaryRoleIds: string[]): boolean {
  return primaryRoleIds.includes(roleKey(job))
}

function roleUpdatedMs(job: CollabJob): number {
  return job.updatedAt ? Date.parse(job.updatedAt) || 0 : 0
}

function isNewRole(job: CollabJob): boolean {
  const updatedMs = roleUpdatedMs(job)
  return updatedMs > 0 && Date.now() - updatedMs <= 7 * 86_400_000
}

function candidateName(c: RecruiterSourcedCandidateItem): string {
  return c.candidate?.name || "Unnamed candidate"
}

function sourceStageMeta(stage?: RecruiterSourcedCandidateStage) {
  return SOURCE_STAGES.find((s) => s.id === stage) ?? SOURCE_STAGES[0]!
}

function normalizeTokens(value: string | undefined): string[] {
  if (!value) return []
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
}

function cleanRecruiterEmail(value: string): string {
  return value.trim().toLowerCase()
}

function createRecruiterGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: "select_account" })
  return provider
}

const RECRUITER_ACCESS_PENDING_KEY = "wk_recruiter_access_pending_v1"

interface PendingRecruiterAccess {
  inviteCode: string
  createdAtMs: number
}

function readPendingRecruiterAccess(): PendingRecruiterAccess | null {
  try {
    const raw = window.sessionStorage.getItem(RECRUITER_ACCESS_PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingRecruiterAccess>
    if (!parsed.inviteCode || typeof parsed.inviteCode !== "string") return null
    if (typeof parsed.createdAtMs !== "number" || Date.now() - parsed.createdAtMs > 10 * 60 * 1000) {
      window.sessionStorage.removeItem(RECRUITER_ACCESS_PENDING_KEY)
      return null
    }
    return { inviteCode: parsed.inviteCode, createdAtMs: parsed.createdAtMs }
  } catch {
    return null
  }
}

function writePendingRecruiterAccess(inviteCode: string) {
  window.sessionStorage.setItem(RECRUITER_ACCESS_PENDING_KEY, JSON.stringify({
    inviteCode,
    createdAtMs: Date.now(),
  }))
}

function clearPendingRecruiterAccess() {
  try {
    window.sessionStorage.removeItem(RECRUITER_ACCESS_PENDING_KEY)
  } catch {
    // sessionStorage can be unavailable in private browsing.
  }
}

function recruiterNameFromGoogleUser(user: User): string {
  const displayName = user.displayName?.trim()
  if (displayName) return displayName
  const emailPrefix = user.email?.split("@")[0]?.replace(/[._-]+/g, " ").trim()
  return emailPrefix || "Recruiter"
}

function authErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : ""
}

function formatRecruiterAuthError(error: unknown): string {
  const code = authErrorCode(error)
  switch (code) {
    case "auth/account-exists-with-different-credential":
      return "That email already uses another Firebase sign-in method. Use the Google account tied to this recruiter access code."
    case "auth/cancelled-popup-request":
      return "Google sign-in was interrupted. Try again."
    case "auth/unauthorized-domain":
      return "This domain is not authorized for Google sign-in in Firebase yet."
    default:
      if (error instanceof Error) {
        if (error.message === "unauthorized") {
          return "This Google account does not have recruiter access. Enter an access code first."
        }
        if (error.message === "invalid_or_expired_invite_code") {
          return "That access code is invalid, expired, already bound to another recruiter, or does not match this Google account."
        }
        if (error.message) return error.message
      }
      return code ? code.replace(/^auth\//, "").replace(/-/g, " ") : "Recruiter access failed."
  }
}

export default function RecruiterBoard() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [session, setSession] = useState<RecruiterSession | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [sourcedCandidates, setSourcedCandidates] = useState<RecruiterSourcedCandidateItem[]>([])
  const [submissions, setSubmissions] = useState<RecruiterSubmissionItem[]>([])
  const [statusLoaded, setStatusLoaded] = useState(false)
  const [primaryRoleSavingId, setPrimaryRoleSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accessError, setAccessError] = useState<string | null>(null)
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
    let handlingUid: string | null = null

    const finishRecruiterAuth = async (user: User | null) => {
      if (!user) {
        if (!active) return
        setSession(null)
        setSourcedCandidates([])
        setSubmissions([])
        setStatusLoaded(false)
        setAuthReady(true)
        return
      }
      if (handlingUid === user.uid) return
      handlingUid = user.uid
      const pending = readPendingRecruiterAccess()
      if (pending) {
        try {
          const email = cleanRecruiterEmail(user.email ?? "")
          if (!email) throw new Error("Google did not return an email for this account.")
          const next = await registerRecruiterAccess({
            name: recruiterNameFromGoogleUser(user),
            email,
            inviteCode: pending.inviteCode,
          })
          clearPendingRecruiterAccess()
          if (active) {
            setAccessError(null)
            setSession(next)
          }
          return
        } catch (e) {
          clearPendingRecruiterAccess()
          await signOut(auth()).catch(() => undefined)
          if (active) {
            setSession(null)
            setSourcedCandidates([])
            setSubmissions([])
            setStatusLoaded(false)
            setAccessError(formatRecruiterAuthError(e))
          }
          return
        } finally {
          if (active) setAuthReady(true)
        }
      }

      try {
        const next = await getRecruiterProfile()
        if (active) {
          setAccessError(null)
          setSession(next)
        }
      } catch {
        await signOut(auth()).catch(() => undefined)
        if (active) {
          setSession(null)
          setSourcedCandidates([])
          setSubmissions([])
          setStatusLoaded(false)
        }
      } finally {
        if (active) setAuthReady(true)
      }
    }

    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      void finishRecruiterAuth(user)
    })
    void redirectResultPromise
      .then((result) => finishRecruiterAuth(result?.user ?? auth().currentUser))
      .catch((err) => {
        clearPendingRecruiterAccess()
        if (active) {
          setAccessError(formatRecruiterAuthError(err))
          setAuthReady(true)
        }
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
      setStatusLoaded(false)
      const [submissionRows, sourceRows] = await Promise.all([
        fetchRecruiterSubmissions(),
        fetchRecruiterSourcedCandidates(),
      ])
      setSubmissions(sortSubmissions(submissionRows))
      setSourcedCandidates(sortSourcedCandidates(sourceRows))
      setStatusLoaded(true)
    } catch (e) {
      setSubmissionError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void reloadSubmissions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.recruiterId])

  const setTab = (tab: RecruiterTab) => setSearchParams(tab === "overview" ? {} : { tab })
  const primaryRoleIds = recruiterPrimaryRoleIds(session)
  const updatePrimaryRoleSlots = async (jobId: string, makePrimary: boolean) => {
    if (!session) return
    const current = recruiterPrimaryRoleIds(session)
    const next = makePrimary
      ? [...current.filter((id) => id !== jobId), jobId]
      : current.filter((id) => id !== jobId)
    if (next.length > PRIMARY_ROLE_SLOT_LIMIT) {
      setSubmissionError(`Primary roles are limited to ${PRIMARY_ROLE_SLOT_LIMIT} active slots.`)
      return
    }
    setPrimaryRoleSavingId(jobId)
    setSubmissionError(null)
    try {
      const updated = await updateRecruiterPreferences({
        notificationPreferences: session.recruiter.notificationPreferences ?? { newRolesEmail: true },
        workspacePreferences: { primaryRoleIds: next },
      })
      setSession(updated)
    } catch (e) {
      setSubmissionError(e instanceof Error ? e.message : String(e))
    } finally {
      setPrimaryRoleSavingId(null)
    }
  }

  if (!authReady) {
    return <div className="rb-access"><div className="rb-state">Loading recruiter workspace...</div></div>
  }

  if (!session) {
    return <RecruiterAccessGate initialError={accessError} />
  }

  const openJobs = jobs ?? []
  const stats = computeRecruiterStats(openJobs, submissions, sourcedCandidates)
  const recentSubmissions = submissions.slice(0, 4)

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
              {tab.id === "candidates" && sourcedCandidates.length > 0 ? <span>{sourcedCandidates.length}</span> : null}
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
            setSourcedCandidates([])
            setSubmissions([])
            setStatusLoaded(false)
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

        {activeTab === "overview" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "overview" && statusLoaded && (
          <OverviewTab
            stats={stats}
            jobs={openJobs}
            submissions={recentSubmissions}
            sourcedCandidates={sourcedCandidates}
            primaryRoleIds={primaryRoleIds}
            onRoles={() => setTab("roles")}
            onMatches={() => setTab("matches")}
            onCandidates={() => setTab("candidates")}
            onSubmissions={() => setTab("submissions")}
            onPrimaryRoleToggle={(jobId, makePrimary) => void updatePrimaryRoleSlots(jobId, makePrimary)}
            primaryRoleSavingId={primaryRoleSavingId}
          />
        )}
        {activeTab === "roles" && (
          <RolesTab
            jobs={openJobs}
            submissions={submissions}
            sourcedCandidates={sourcedCandidates}
            loading={!jobs && !error}
            primaryRoleIds={primaryRoleIds}
            primaryRoleSavingId={primaryRoleSavingId}
            onPrimaryRoleToggle={(jobId, makePrimary) => void updatePrimaryRoleSlots(jobId, makePrimary)}
          />
        )}
        {activeTab === "matches" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "matches" && statusLoaded && <MatchboardTab jobs={openJobs} candidates={sourcedCandidates} submissions={submissions} primaryRoleIds={primaryRoleIds} />}
        {activeTab === "candidates" && (
          !statusLoaded ? <RecruiterStatusLoading /> :
          <CandidatesTab
            jobs={openJobs}
            candidates={sourcedCandidates}
            onSaved={(saved) => setSourcedCandidates((rows) => sortSourcedCandidates([saved, ...rows.filter((row) => row.id !== saved.id)]))}
          />
        )}
        {activeTab === "submissions" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "submissions" && statusLoaded && <SubmissionsTab submissions={submissions} />}
        {activeTab === "performance" && !statusLoaded && <RecruiterStatusLoading />}
        {activeTab === "performance" && statusLoaded && <PerformanceTab jobs={openJobs} candidates={sourcedCandidates} submissions={submissions} primaryRoleIds={primaryRoleIds} />}
        {activeTab === "settings" && <SettingsTab session={session} onSessionChange={setSession} />}
      </main>
    </div>
  )
}

function computeRecruiterStats(
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
) {
  const reviewing = submissions.filter((s) => ["submitted", "new", "reviewing"].includes(s.status ?? "submitted")).length
  const advanced = submissions.filter((s) => ["advanced", "interviewing", "hired"].includes(s.status ?? "")).length
  const interviews = submissions.filter((s) => ["interviewing", "hired"].includes(s.status ?? "")).length
  const feedback = submissions.filter((s) => Boolean(s.recruiterFeedbackNote)).length
  const activeSource = sourcedCandidates.filter((c) => c.stage !== "archived").length
  const interviewRate = submissions.length ? Math.round((interviews / submissions.length) * 100) : 0
  return [
    { label: "Open roles", value: String(jobs.length), meta: "live WeKruit collab searches", signal: "live", tone: "live" },
    { label: "Sourced candidates", value: String(activeSource), meta: "saved before submission", signal: "+", tone: "info" },
    { label: "Pending review", value: String(reviewing), meta: "waiting on WeKruit or hiring team", signal: "wait", tone: "warn" },
    { label: "Interview rate", value: `${interviewRate}%`, meta: feedback ? `${advanced} advanced - ${feedback} notes` : `${advanced} advanced`, signal: "rate", tone: "success" },
  ]
}

function RecruiterStatusLoading() {
  return (
    <section className="rb-panel rb-panel--fill rb-loading-panel" aria-live="polite">
      <h2>Syncing recruiter workspace...</h2>
      <p>Loading your saved candidates, submissions, feedback, and role-alert settings.</p>
    </section>
  )
}

function RecruiterAccessGate({ initialError }: { initialError?: string | null }) {
  const [inviteCode, setInviteCode] = useState("")
  const [err, setErr] = useState<string | null>(initialError ?? null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setErr(initialError ?? null)
  }, [initialError])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedInviteCode = inviteCode.trim()
    if (!trimmedInviteCode) {
      setErr("Enter your recruiter access code first.")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      writePendingRecruiterAccess(trimmedInviteCode)
      if (auth().currentUser) await signOut(auth())
      await signInWithRedirect(auth(), createRecruiterGoogleProvider())
    } catch (error) {
      clearPendingRecruiterAccess()
      setErr(formatRecruiterAuthError(error))
      setBusy(false)
    }
  }

  const clearStuckGoogleState = async () => {
    setBusy(true)
    setErr(null)
    try {
      clearPendingRecruiterAccess()
      await signOut(auth()).catch(() => undefined)
      window.location.assign("/recruiters")
    } catch (error) {
      setErr(formatRecruiterAuthError(error))
    } finally {
      setBusy(false)
    }
  }

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
          <h2>Enter access code</h2>
          <p className="rb-access__hint">
            WeKruit verifies the code first, then binds this recruiter workspace to the Google account you choose.
          </p>
          <label>
            <span>Access code</span>
            <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="WK-XXXX-XXXX" autoComplete="one-time-code" required />
          </label>
          {err && <p className="rb-access__err">{err}</p>}
          <button className="rb-btn primary rb-btn--block" disabled={busy}>
            {busy ? "Opening Google..." : "Continue with Gmail"}
          </button>
          <button type="button" className="rb-access__reset" disabled={busy} onClick={() => void clearStuckGoogleState()}>
            Restart sign-in
          </button>
        </form>
      </main>
    </div>
  )
}

function OverviewTab({
  stats,
  jobs,
  submissions,
  sourcedCandidates,
  primaryRoleIds,
  onRoles,
  onMatches,
  onCandidates,
  onSubmissions,
  onPrimaryRoleToggle,
  primaryRoleSavingId,
}: {
  stats: Array<{ label: string; value: string; meta: string; signal: string; tone: string }>
  jobs: CollabJob[]
  submissions: RecruiterSubmissionItem[]
  sourcedCandidates: RecruiterSourcedCandidateItem[]
  primaryRoleIds: string[]
  onRoles: () => void
  onMatches: () => void
  onCandidates: () => void
  onSubmissions: () => void
  onPrimaryRoleToggle: (jobId: string, makePrimary: boolean) => void
  primaryRoleSavingId: string | null
}) {
  const primaryJobs = jobs.filter((job) => isPrimaryRole(job, primaryRoleIds))
  const suggestedJobs = jobs
    .filter((job) => !isPrimaryRole(job, primaryRoleIds))
    .slice(0, Math.max(0, PRIMARY_ROLE_SLOT_LIMIT - primaryJobs.length))
  const priorityJobs = [...primaryJobs, ...suggestedJobs].slice(0, PRIMARY_ROLE_SLOT_LIMIT)
  const pipeline = buildCandidatePipeline(sourcedCandidates, submissions)
  const feedback = submissions.filter((s) => Boolean(s.recruiterFeedbackNote)).slice(0, 3)
  const workItems = buildRecruiterWorkQueue(jobs, sourcedCandidates, submissions)
  return (
    <div className="rb-workspace">
      <section className="rb-stats">
        {stats.map((s) => (
          <article className={`rb-stat is-${s.tone}`} key={s.label}>
            <span>{s.label}<em>{s.signal}</em></span>
            <strong>{s.value}</strong>
            <em>{s.meta}</em>
          </article>
        ))}
      </section>
      <div className="rb-workbench-grid">
        <section className="rb-panel rb-priority-panel">
          <header className="rb-panel__head">
            <div><h2>Primary role slots</h2><p>Focus up to {PRIMARY_ROLE_SLOT_LIMIT} roles; non-primary submissions use weekly single-submit credits.</p></div>
            <button type="button" className="rb-panel__link" onClick={onRoles}>All roles</button>
          </header>
          <div className="rb-slot-meter">
            <strong>{primaryRoleIds.length}/{PRIMARY_ROLE_SLOT_LIMIT} primary slots</strong>
            <span>{SINGLE_SUBMISSION_WEEKLY_LIMIT} single submissions per rolling week outside primary roles.</span>
          </div>
          <div className="rb-priority-table">
            <div className="rb-priority-table__head">
              <span>Role</span>
              <span>Reward</span>
              <span>Location</span>
              <span>Checks</span>
              <span>Signal</span>
              <span>Slot</span>
            </div>
            {priorityJobs.map((job) => (
              <PriorityRoleRow
                key={job.jobId}
                job={job}
                sourcedCount={sourcedCandidates.filter((c) => c.inboundJobId === roleKey(job) || c.jobId === roleKey(job)).length}
                submissionCount={submissions.filter((s) => s.inboundJobId === roleKey(job) || s.jobId === roleKey(job)).length}
                primary={isPrimaryRole(job, primaryRoleIds)}
                disabled={primaryRoleSavingId === roleKey(job) || (!isPrimaryRole(job, primaryRoleIds) && primaryRoleIds.length >= PRIMARY_ROLE_SLOT_LIMIT)}
                onPrimaryRoleToggle={onPrimaryRoleToggle}
              />
            ))}
            {jobs.length === 0 && <p className="rb-empty">No active collab roles right now.</p>}
          </div>
        </section>
        <section className="rb-panel rb-pipeline-panel">
          <header className="rb-panel__head">
            <div><h2>Candidate pipeline</h2><p>Sourcing through submitted status in one view.</p></div>
            <button type="button" className="rb-panel__link" onClick={onCandidates}>All candidates</button>
          </header>
          <div className="rb-pipeline">
            {pipeline.map((lane) => (
              <div className={`rb-pipeline__lane is-${lane.tone}`} key={lane.label}>
                <header><span>{lane.label}</span><strong>{lane.items.length}</strong></header>
                <div>
                  {lane.items.slice(0, 4).map((item) => <PipelineCard key={item.id} item={item} />)}
                  {lane.items.length === 0 && <p className="rb-pipeline__empty">No candidates</p>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="rb-panel rb-command-panel">
        <header className="rb-panel__head">
          <div><h2>Today&apos;s work queue</h2><p>The fastest path from open role to sourced candidate to submitted status.</p></div>
          <button type="button" className="rb-panel__link" onClick={onMatches}>Open matchboard</button>
        </header>
        <div className="rb-command-list">
          {workItems.map((item) => (
            <article className={`rb-command-item is-${item.tone}`} key={item.title}>
              <span>{item.label}</span>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
              <button
                type="button"
                className="rb-panel__link"
                onClick={item.action === "roles" ? onRoles : item.action === "submissions" ? onSubmissions : item.action === "matches" ? onMatches : onCandidates}
              >
                {item.cta}
              </button>
            </article>
          ))}
        </div>
      </section>
      <section className="rb-panel rb-feedback-panel">
        <header className="rb-panel__head">
          <div><h2>Feedback &amp; calibration</h2><p>Hiring-team notes and next actions for tighter submissions.</p></div>
          <button type="button" className="rb-panel__link" onClick={onSubmissions}>Open submissions</button>
        </header>
        <div className="rb-feedback-grid">
          <div className="rb-feedback-table">
            {feedback.map((s) => <FeedbackLine key={s.id} submission={s} />)}
            {feedback.length === 0 && <p className="rb-empty">No written feedback yet. Submit candidates and WeKruit notes will appear here.</p>}
          </div>
          <aside className="rb-next-action">
            <span>Next action</span>
            <strong>{sourcedCandidates.length ? "Move ready candidates into role briefs" : "Start a sourcing shortlist"}</strong>
            <p>
              {sourcedCandidates.length
                ? "Use the Candidates tab to keep prospects warm, then open the matching role brief when they are ready to submit."
                : "Save prospects before submission so your workbench has a real pipeline, not just final submissions."}
            </p>
            <button type="button" className="rb-btn" onClick={onCandidates}>Open candidate CRM</button>
          </aside>
        </div>
      </section>
    </div>
  )
}

type PipelineItem = {
  id: string
  name: string
  title: string
  company: string
  age: string
  kind: "source" | "submission"
  href?: string
}

function buildCandidatePipeline(
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  submissions: RecruiterSubmissionItem[],
) {
  const sourced = sourcedCandidates
    .filter((c) => ["sourced", "contacted", "screened"].includes(c.stage))
    .map(sourceToPipelineItem)
  const ready = sourcedCandidates.filter((c) => c.stage === "ready").map(sourceToPipelineItem)
  const submitted = submissions
    .filter((s) => ["submitted", "new"].includes(s.status ?? "submitted"))
    .map(submissionToPipelineItem)
  const reviewing = submissions.filter((s) => s.status === "reviewing").map(submissionToPipelineItem)
  const interviewing = submissions
    .filter((s) => ["advanced", "interviewing", "hired"].includes(s.status ?? ""))
    .map(submissionToPipelineItem)
  return [
    { label: "Sourced", tone: "mute", items: sourced },
    { label: "Ready", tone: "live", items: ready },
    { label: "Submitted", tone: "info", items: submitted },
    { label: "In review", tone: "warn", items: reviewing },
    { label: "Interviewing", tone: "success", items: interviewing },
  ]
}

function buildRecruiterWorkQueue(
  jobs: CollabJob[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
  submissions: RecruiterSubmissionItem[],
) {
  const readyCandidates = sourcedCandidates.filter((c) => c.stage === "ready")
  const newRoles = jobs.filter(isNewRole)
  const feedbackRows = submissions.filter((s) => Boolean(s.recruiterFeedbackNote))
  const pending = submissions.filter((s) => ["submitted", "new", "reviewing"].includes(s.status ?? "submitted"))

  if (readyCandidates.length > 0) {
    return [
      {
        label: "Submit next",
        title: `${readyCandidates.length} ready candidate${readyCandidates.length === 1 ? "" : "s"}`,
        body: "Use the matchboard to choose the strongest open role before sending another formal submission.",
        cta: "Match candidates",
        action: "matches" as const,
        tone: "live",
      },
      {
        label: "Calibration",
        title: feedbackRows.length ? `${feedbackRows.length} feedback note${feedbackRows.length === 1 ? "" : "s"}` : "No written feedback yet",
        body: feedbackRows.length ? "Read the notes before continuing the same search." : "Keep submissions tight until the first feedback arrives.",
        cta: "Review submissions",
        action: "submissions" as const,
        tone: feedbackRows.length ? "warn" : "info",
      },
      {
        label: "Role supply",
        title: newRoles.length ? `${newRoles.length} new role${newRoles.length === 1 ? "" : "s"} this week` : `${jobs.length} open roles`,
        body: "Prioritize roles with clear hard checks and no current submissions from your account.",
        cta: "Browse roles",
        action: "roles" as const,
        tone: "info",
      },
    ]
  }

  return [
    {
      label: "Start here",
      title: sourcedCandidates.length ? "Move prospects to ready" : "Build a sourced shortlist",
      body: sourcedCandidates.length
        ? "Screen saved prospects, mark the strongest as ready, then submit from the role brief."
        : "Save LinkedIn or resume links before submitting so duplicate and status tracking can work.",
      cta: "Open candidate CRM",
      action: "candidates" as const,
      tone: "live",
    },
    {
      label: "Role supply",
      title: newRoles.length ? `${newRoles.length} new role${newRoles.length === 1 ? "" : "s"} this week` : `${jobs.length} open roles`,
      body: "Filter the marketplace before sourcing so you do not waste effort on weak-fit roles.",
      cta: "Browse roles",
      action: "roles" as const,
      tone: "info",
    },
    {
      label: "Review load",
      title: pending.length ? `${pending.length} pending review` : "No pending submissions",
      body: pending.length
        ? "Wait for feedback if you are close to the pending limit on a role."
        : "You have room to submit once a candidate has confirmed consent.",
      cta: "Open submissions",
      action: "submissions" as const,
      tone: pending.length ? "warn" : "success",
    },
  ]
}

function sourceToPipelineItem(c: RecruiterSourcedCandidateItem): PipelineItem {
  return {
    id: c.id,
    name: candidateName(c),
    title: c.candidate?.currentRole || "Candidate",
    company: c.jobTitleSnapshot || c.companyLabelSnapshot || "Saved prospect",
    age: formatCandidateAge(c.updatedAt ?? c.createdAt),
    kind: "source",
    href: c.inboundJobId ? `/recruiters/job/${encodeURIComponent(c.inboundJobId)}?candidateId=${encodeURIComponent(c.id)}` : undefined,
  }
}

function submissionToPipelineItem(s: RecruiterSubmissionItem): PipelineItem {
  return {
    id: s.id,
    name: s.candidate?.name || "Candidate",
    title: s.candidate?.currentRole || "Submitted candidate",
    company: s.jobTitleSnapshot || s.companyLabelSnapshot || "Submitted role",
    age: formatWhen(s),
    kind: "submission",
  }
}

function formatCandidateAge(raw: RecruiterSourcedCandidateItem["createdAt"]): string {
  const ms = timestampValueMs(raw)
  if (!ms) return "Today"
  const days = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000))
  if (days === 0) return "Today"
  if (days === 1) return "1d ago"
  return `${days}d ago`
}

function roleChecklistCounts(job: CollabJob) {
  const hard = job.recruiterBoard.checklist.groups.find((g) => g.kind === "hard")?.items.length ?? 0
  const fit = job.recruiterBoard.checklist.groups.find((g) => g.kind === "fit")?.items.length ?? 0
  return { hard, fit }
}

function roleFitSignal(job: CollabJob, sourcedCount: number, submissionCount: number) {
  const { hard, fit } = roleChecklistCounts(job)
  const base = Math.min(96, 52 + hard * 4 + fit * 2 + submissionCount * 8 + sourcedCount * 3)
  if (base >= 82) return { label: "High", percent: base, tone: "live" }
  if (base >= 68) return { label: "Medium", percent: base, tone: "warn" }
  return { label: "Good", percent: base, tone: "info" }
}

function roleReward(job: CollabJob): string {
  if (job.compSummary) return job.compSummary.length > 18 ? "Success fee" : job.compSummary
  return "$10K+"
}

function PriorityRoleRow({
  job,
  sourcedCount,
  submissionCount,
  primary,
  disabled,
  onPrimaryRoleToggle,
}: {
  job: CollabJob
  sourcedCount: number
  submissionCount: number
  primary: boolean
  disabled: boolean
  onPrimaryRoleToggle: (jobId: string, makePrimary: boolean) => void
}) {
  const { hard, fit } = roleChecklistCounts(job)
  const signal = roleFitSignal(job, sourcedCount, submissionCount)
  return (
    <article className="rb-priority-row">
      <span>
        <Link to={`/recruiters/job/${job.jobId}`}>{job.title}</Link>
        <em>{job.recruiterBoard.label.company}</em>
      </span>
      <span>{roleReward(job)}</span>
      <span>{job.recruiterBoard.label.location}</span>
      <span>{hard} hard - {fit} fit</span>
      <span className={`rb-fit-signal is-${signal.tone}`}>{signal.label} {signal.percent}%</span>
      <button
        type="button"
        className={`rb-row-button ${primary ? "is-active" : ""}`}
        disabled={disabled}
        onClick={() => onPrimaryRoleToggle(roleKey(job), !primary)}
      >
        {primary ? "Primary" : "Add slot"}
      </button>
    </article>
  )
}

function PipelineCard({ item }: { item: PipelineItem }) {
  const body = (
    <>
      <span className="rb-candidate-dot">{item.name.slice(0, 1).toUpperCase()}</span>
      <span>
        <strong>{item.name}</strong>
        <em>{item.title}</em>
        <small>{item.company} - {item.age}</small>
      </span>
    </>
  )
  return item.href ? (
    <Link to={item.href} className="rb-pipeline-card">{body}</Link>
  ) : (
    <div className="rb-pipeline-card">{body}</div>
  )
}

function FeedbackLine({ submission }: { submission: RecruiterSubmissionItem }) {
  const meta = statusMeta(submission.status)
  return (
    <article className="rb-feedback-line">
      <span className={`rb-status is-${meta.tone}`}>{meta.label}</span>
      <span>
        <strong>{submission.candidate?.name || "Candidate"}</strong>
        <em>{submission.jobTitleSnapshot || "Role"}</em>
      </span>
      <p>{submission.recruiterFeedbackNote}</p>
      <small>{formatWhen(submission)}</small>
    </article>
  )
}

function RolesTab({
  jobs,
  submissions,
  sourcedCandidates,
  loading,
  primaryRoleIds,
  primaryRoleSavingId,
  onPrimaryRoleToggle,
}: {
  jobs: CollabJob[]
  submissions: RecruiterSubmissionItem[]
  sourcedCandidates: RecruiterSourcedCandidateItem[]
  loading: boolean
  primaryRoleIds: string[]
  primaryRoleSavingId: string | null
  onPrimaryRoleToggle: (jobId: string, makePrimary: boolean) => void
}) {
  const [q, setQ] = useState("")
  const [filter, setFilter] = useState<RoleFilter>("all")
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const visible = jobs.filter((job) => {
      const sourcedCount = sourcedCandidates.filter((c) => c.inboundJobId === roleKey(job) || c.jobId === roleKey(job)).length
      const submissionCount = submissions.filter((s) => s.inboundJobId === roleKey(job) || s.jobId === roleKey(job)).length
      if (filter === "new" && !isNewRole(job)) return false
      if (filter === "with_candidates" && sourcedCount === 0) return false
      if (filter === "needs_submissions" && submissionCount > 0) return false
      return true
    })
    if (!needle) return visible
    return visible.filter((j) =>
      j.title.toLowerCase().includes(needle) ||
      j.recruiterBoard.label.location.toLowerCase().includes(needle) ||
      j.recruiterBoard.label.company.toLowerCase().includes(needle) ||
      j.recruiterBoard.label.pills.some((p) => p.text.toLowerCase().includes(needle)),
    )
  }, [filter, jobs, q, sourcedCandidates, submissions])

  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Role marketplace</h2><p>Live WeKruit collab roles with scorecards, pipeline context, and submit paths.</p></div>
        <label className="rb-search">
          <span>Search roles</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, location, tag..." autoComplete="off" />
        </label>
      </header>
      <div className="rb-filter-row" role="tablist" aria-label="Role filters">
        {ROLE_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={filter === option.id ? "is-active" : ""}
            onClick={() => setFilter(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {loading && <div className="rb-state">Loading open roles...</div>}
      {!loading && (
        <div className="rb-role-grid">
          {filtered.map((job) => (
            <RoleCard
              key={job.jobId}
              job={job}
              sourcedCount={sourcedCandidates.filter((c) => c.inboundJobId === roleKey(job) || c.jobId === roleKey(job)).length}
              submissionCount={submissions.filter((s) => s.inboundJobId === roleKey(job) || s.jobId === roleKey(job)).length}
              primary={isPrimaryRole(job, primaryRoleIds)}
              primarySlotsFull={primaryRoleIds.length >= PRIMARY_ROLE_SLOT_LIMIT}
              disabled={primaryRoleSavingId === roleKey(job)}
              onPrimaryRoleToggle={onPrimaryRoleToggle}
            />
          ))}
          {filtered.length === 0 && <p className="rb-empty">No roles match that search.</p>}
        </div>
      )}
    </section>
  )
}

type CandidateRoleMatch = {
  job: CollabJob
  score: number
  reasons: string[]
  sourcedCount: number
  submissionCount: number
}

function candidateMatchText(candidate: RecruiterSourcedCandidateItem): string {
  return [
    candidate.candidate?.name,
    candidate.candidate?.currentRole,
    candidate.candidate?.yoe,
    candidate.candidate?.notes,
    candidate.jobTitleSnapshot,
    candidate.companyLabelSnapshot,
  ].filter(Boolean).join(" ")
}

function jobMatchText(job: CollabJob): string {
  return [
    job.title,
    job.recruiterBoard.label.location,
    job.recruiterBoard.label.pills.map((p) => p.text).join(" "),
    job.recruiterBoard.checklist.groups.flatMap((g) => [g.heading, ...g.items.map((item) => item.text)]).join(" "),
    job.jdBlocks.map((block) => `${block.heading} ${block.body}`).join(" "),
  ].filter(Boolean).join(" ")
}

function scoreCandidateAgainstJob(
  candidate: RecruiterSourcedCandidateItem,
  job: CollabJob,
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
): CandidateRoleMatch {
  const candidateTokens = new Set(normalizeTokens(candidateMatchText(candidate)))
  const jobTokens = normalizeTokens(jobMatchText(job))
  const overlap = Array.from(new Set(jobTokens.filter((token) => candidateTokens.has(token)))).slice(0, 5)
  const stageBoost: Record<RecruiterSourcedCandidateStage, number> = {
    sourced: 3,
    contacted: 6,
    screened: 10,
    ready: 16,
    submitted: 6,
    archived: -16,
  }
  const calibrationBoost = candidate.calibrationStatus === "good_fit"
    ? 8
    : candidate.calibrationStatus === "bad_fit"
      ? -14
      : candidate.calibrationStatus === "calibration_requested"
        ? -4
        : 0
  const titleTokens = normalizeTokens(job.title)
  const titleOverlap = titleTokens.filter((token) => candidateTokens.has(token)).length
  const sourcedCount = sourcedCandidates.filter((c) => c.inboundJobId === roleKey(job) || c.jobId === roleKey(job)).length
  const submissionCount = submissions.filter((s) => s.inboundJobId === roleKey(job) || s.jobId === roleKey(job)).length
  const score = Math.max(20, Math.min(98, 42 + overlap.length * 7 + titleOverlap * 8 + (stageBoost[candidate.stage] ?? 0) + calibrationBoost - submissionCount * 3))
  const reasons = [
    ...overlap.slice(0, 3).map((token) => `Keyword: ${token}`),
    sourceStageMeta(candidate.stage).label,
    candidate.calibrationStatus ? calibrationMeta(candidate.calibrationStatus).label : "",
    submissionCount === 0 ? "No submissions yet" : "",
  ].filter(Boolean).slice(0, 4)
  return { job, score, reasons, sourcedCount, submissionCount }
}

function buildCandidateRoleMatches(
  candidate: RecruiterSourcedCandidateItem,
  jobs: CollabJob[],
  submissions: RecruiterSubmissionItem[],
  sourcedCandidates: RecruiterSourcedCandidateItem[],
): CandidateRoleMatch[] {
  return jobs
    .map((job) => scoreCandidateAgainstJob(candidate, job, submissions, sourcedCandidates))
    .sort((a, b) => b.score - a.score)
}

function MatchboardTab({
  jobs,
  candidates,
  submissions,
  primaryRoleIds,
}: {
  jobs: CollabJob[]
  candidates: RecruiterSourcedCandidateItem[]
  submissions: RecruiterSubmissionItem[]
  primaryRoleIds: string[]
}) {
  const activeCandidates = useMemo(
    () => sortSourcedCandidates(candidates.filter((candidate) => candidate.stage !== "archived")),
    [candidates],
  )
  const [selectedId, setSelectedId] = useState<string>("")
  const selectedCandidate = activeCandidates.find((candidate) => candidate.id === selectedId) ?? activeCandidates[0]
  const matches = useMemo(
    () => selectedCandidate ? buildCandidateRoleMatches(selectedCandidate, jobs, submissions, candidates).slice(0, 8) : [],
    [candidates, jobs, selectedCandidate, submissions],
  )

  useEffect(() => {
    if (!selectedId && activeCandidates[0]) setSelectedId(activeCandidates[0].id)
    if (selectedId && !activeCandidates.some((candidate) => candidate.id === selectedId)) {
      setSelectedId(activeCandidates[0]?.id ?? "")
    }
  }, [activeCandidates, selectedId])

  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Candidate-to-role matchboard</h2><p>Pick a saved prospect, compare open roles, then submit from the strongest brief.</p></div>
      </header>
      {activeCandidates.length === 0 ? (
        <p className="rb-empty">Save sourced candidates first. The matchboard needs candidate notes or a LinkedIn/resume link to rank open roles.</p>
      ) : (
        <div className="rb-matchboard">
          <aside className="rb-matchboard__candidates" aria-label="Saved candidates">
            {activeCandidates.map((candidate) => {
              const stage = sourceStageMeta(candidate.stage)
              const topMatch = buildCandidateRoleMatches(candidate, jobs, submissions, candidates)[0]
              return (
                <button
                  key={candidate.id}
                  type="button"
                  className={selectedCandidate?.id === candidate.id ? "is-active" : ""}
                  onClick={() => setSelectedId(candidate.id)}
                >
                  <span className="rb-candidate-dot">{candidateName(candidate).slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>{candidateName(candidate)}</strong>
                    <em>{candidate.candidate?.currentRole || candidate.jobTitleSnapshot || "Candidate"}</em>
                    <small>{stage.label}{topMatch ? ` - ${topMatch.score}% top match` : ""}</small>
                  </span>
                </button>
              )
            })}
          </aside>
          <div className="rb-matchboard__main">
            {selectedCandidate && (
              <section className="rb-match-profile">
                <div>
                  <span className="rb-candidate-dot">{candidateName(selectedCandidate).slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>{candidateName(selectedCandidate)}</strong>
                    <em>{selectedCandidate.candidate?.currentRole || "Candidate profile"}</em>
                  </span>
                </div>
                <p>{shortText(selectedCandidate.candidate?.notes, "No recruiter note yet. Add context in Candidate CRM to improve ranking.", 160)}</p>
              </section>
            )}
            <div className="rb-match-list">
              {matches.map((match) => (
                <CandidateRoleMatchRow
                  key={match.job.jobId}
                  match={match}
                  candidate={selectedCandidate}
                  primary={isPrimaryRole(match.job, primaryRoleIds)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function CandidateRoleMatchRow({
  match,
  candidate,
  primary,
}: {
  match: CandidateRoleMatch
  candidate?: RecruiterSourcedCandidateItem
  primary: boolean
}) {
  return (
    <article className="rb-match-row">
      <div className="rb-match-row__score">
        <strong>{match.score}%</strong>
        <span>fit</span>
      </div>
      <div className="rb-match-row__body">
        <h3>{match.job.title}</h3>
        <p>{match.job.recruiterBoard.label.company} - {match.job.recruiterBoard.label.location}</p>
        <div>
          {match.reasons.map((reason) => <span key={reason}>{reason}</span>)}
        </div>
      </div>
      <div className="rb-match-row__meta">
        <strong>{primary ? "Primary role" : "Single submission"}</strong>
        <span>{match.sourcedCount} sourced</span>
        <span>{match.submissionCount} submitted</span>
        <Link to={`/recruiters/job/${match.job.jobId}${candidate ? `?candidateId=${encodeURIComponent(candidate.id)}` : ""}`}>
          Open brief
        </Link>
      </div>
    </article>
  )
}

function CandidatesTab({
  jobs,
  candidates,
  onSaved,
}: {
  jobs: CollabJob[]
  candidates: RecruiterSourcedCandidateItem[]
  onSaved: (candidate: RecruiterSourcedCandidateItem) => void
}) {
  const [form, setForm] = useState<RecruiterSourcedCandidateInput>(() => ({
    jobId: jobs[0]?.jobId ?? "",
    stage: "sourced",
    candidate: { name: "", link: "", currentRole: "", yoe: "", notes: "" },
  }))
  const [saving, setSaving] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!form.jobId && jobs[0]) setForm((next) => ({ ...next, jobId: jobs[0]!.jobId }))
  }, [form.jobId, jobs])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!form.jobId) {
      setErr("Choose a role for this candidate.")
      return
    }
    setSaving(true)
    setErr(null)
    try {
      const saved = await saveRecruiterSourcedCandidate({
        ...form,
        candidate: {
          name: form.candidate.name.trim(),
          link: form.candidate.link.trim(),
          currentRole: form.candidate.currentRole?.trim() || undefined,
          yoe: form.candidate.yoe?.trim() || undefined,
          notes: form.candidate.notes?.trim() || undefined,
        },
      })
      onSaved(saved)
      setForm({
        jobId: form.jobId,
        stage: "sourced",
        candidate: { name: "", link: "", currentRole: "", yoe: "", notes: "" },
      })
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const grouped = SOURCE_STAGES.map((stage) => ({
    ...stage,
    candidates: candidates.filter((c) => c.stage === stage.id),
  }))

  const updateStage = async (candidate: RecruiterSourcedCandidateItem, stage: RecruiterSourcedCandidateStage) => {
    const jobId = candidate.inboundJobId || candidate.jobId || ""
    const link = candidate.candidate?.link?.trim()
    if (!jobId || !link) {
      setErr("This saved candidate is missing the role or link needed to update it.")
      return
    }
    setUpdatingId(candidate.id)
    setErr(null)
    try {
      const saved = await saveRecruiterSourcedCandidate({
        candidateId: candidate.candidateId || candidate.id,
        jobId,
        stage,
        candidate: {
          name: candidate.candidate?.name || candidateName(candidate),
          link,
          currentRole: candidate.candidate?.currentRole,
          yoe: candidate.candidate?.yoe,
          notes: candidate.candidate?.notes,
        },
      })
      onSaved(saved)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Candidate CRM</h2><p>Save prospects before formal submission, then move ready candidates into a role brief.</p></div>
      </header>
      <div className="rb-candidate-crm">
        <form className="rb-source-form" onSubmit={save}>
          <h3>Save sourced candidate</h3>
          <label>
            <span>Role</span>
            <select value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })} required>
              <option value="" disabled>Choose role</option>
              {jobs.map((job) => (
                <option key={job.jobId} value={job.jobId}>{job.title} · {job.recruiterBoard.label.company}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Candidate name</span>
            <input
              value={form.candidate.name}
              onChange={(e) => setForm({ ...form, candidate: { ...form.candidate, name: e.target.value } })}
              required
            />
          </label>
          <label>
            <span>LinkedIn / resume</span>
            <input
              value={form.candidate.link}
              onChange={(e) => setForm({ ...form, candidate: { ...form.candidate, link: e.target.value } })}
              placeholder="https://linkedin.com/in/..."
              required
            />
          </label>
          <div className="rb-source-form__split">
            <label>
              <span>Current role</span>
              <input
                value={form.candidate.currentRole ?? ""}
                onChange={(e) => setForm({ ...form, candidate: { ...form.candidate, currentRole: e.target.value } })}
              />
            </label>
            <label>
              <span>Stage</span>
              <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as RecruiterSourcedCandidateStage })}>
                {SOURCE_STAGES.filter((s) => s.id !== "submitted").map((stage) => (
                  <option key={stage.id} value={stage.id}>{stage.label}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>Recruiter note</span>
            <textarea
              value={form.candidate.notes ?? ""}
              onChange={(e) => setForm({ ...form, candidate: { ...form.candidate, notes: e.target.value } })}
              placeholder="Why this person fits, warm intro status, compensation notes..."
            />
          </label>
          {err && <p className="rb-access__err">{err}</p>}
          <button className="rb-btn primary rb-btn--block" disabled={saving || jobs.length === 0}>
            {saving ? "Saving..." : "Save to pipeline"}
          </button>
        </form>

        <div className="rb-candidate-board">
          {grouped.map((group) => (
            <section className={`rb-candidate-stage is-${group.tone}`} key={group.id}>
              <header><strong>{group.label}</strong><span>{group.candidates.length}</span></header>
              {group.candidates.slice(0, 8).map((candidate) => (
                <SourcedCandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  disabled={updatingId === candidate.id}
                  onStageChange={(stage) => void updateStage(candidate, stage)}
                />
              ))}
              {group.candidates.length === 0 && <p>No candidates</p>}
            </section>
          ))}
        </div>
      </div>
    </section>
  )
}

function SourcedCandidateCard({
  candidate,
  disabled,
  onStageChange,
}: {
  candidate: RecruiterSourcedCandidateItem
  disabled: boolean
  onStageChange: (stage: RecruiterSourcedCandidateStage) => void
}) {
  const stage = sourceStageMeta(candidate.stage)
  const calibration = calibrationMeta(candidate.calibrationStatus)
  return (
    <article className="rb-source-card">
      <div>
        <span className="rb-candidate-dot">{candidateName(candidate).slice(0, 1).toUpperCase()}</span>
        <span>
          <strong>{candidateName(candidate)}</strong>
          <em>{candidate.candidate?.currentRole || candidate.jobTitleSnapshot || "Candidate"}</em>
        </span>
      </div>
      <p>{shortText(candidate.candidate?.notes, "No note yet", 96)}</p>
      {(candidate.calibrationStatus || candidate.calibrationNote) && (
        <div className="rb-source-card__calibration">
          <span className={`rb-status is-${calibration.tone}`}>{calibration.label}</span>
          {candidate.calibrationNote && <p>{shortText(candidate.calibrationNote, "", 120)}</p>}
        </div>
      )}
      <footer>
        <span className={`rb-status is-${stage.tone}`}>{stage.label}</span>
        <select
          aria-label={`Update ${candidateName(candidate)} stage`}
          value={candidate.stage}
          disabled={disabled}
          onChange={(e) => onStageChange(e.target.value as RecruiterSourcedCandidateStage)}
        >
          {SOURCE_STAGES.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        {candidate.inboundJobId ? <Link to={`/recruiters/job/${candidate.inboundJobId}?candidateId=${encodeURIComponent(candidate.id)}`}>Submit</Link> : null}
      </footer>
    </article>
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

function PerformanceTab({
  jobs,
  candidates,
  submissions,
  primaryRoleIds,
}: {
  jobs: CollabJob[]
  candidates: RecruiterSourcedCandidateItem[]
  submissions: RecruiterSubmissionItem[]
  primaryRoleIds: string[]
}) {
  const feedbackRows = submissions.filter((s) => Boolean(s.recruiterFeedbackNote))
  const advanced = submissions.filter((s) => ["advanced", "interviewing", "hired"].includes(s.status ?? "")).length
  const pending = submissions.filter((s) => ["submitted", "new", "reviewing"].includes(s.status ?? "submitted")).length
  const ready = candidates.filter((c) => c.stage === "ready").length
  const sourceToSubmit = candidates.length ? Math.round((submissions.length / candidates.length) * 100) : 0
  const singleSubmissions = submissions.filter((submission) => submission.submissionMode === "single_submission").length
  const primarySubmissions = submissions.filter((submission) => submission.submissionMode === "primary_role").length
  const metrics = [
    { label: "Submitted", value: String(submissions.length), meta: "formal candidates", tone: "live" },
    { label: "Pending review", value: String(pending), meta: "awaiting feedback", tone: "warn" },
    { label: "Advanced", value: String(advanced), meta: "sent forward / interview", tone: "success" },
    { label: "Source to submit", value: `${sourceToSubmit}%`, meta: `${ready} ready now`, tone: "info" },
  ]
  const stageRows = SOURCE_STAGES.map((stage) => ({
    ...stage,
    count: candidates.filter((candidate) => candidate.stage === stage.id).length,
  }))
  const statusRows = Object.entries(STATUS_LABELS).map(([status, meta]) => ({
    status,
    ...meta,
    count: submissions.filter((submission) => (submission.status ?? "submitted") === status).length,
  })).filter((row) => row.count > 0)

  return (
    <section className="rb-panel rb-panel--fill">
      <header className="rb-panel__head">
        <div><h2>Performance &amp; calibration</h2><p>Source quality, review velocity, and feedback from WeKruit in one operating view.</p></div>
      </header>
      <section className="rb-stats rb-stats--inside">
        {metrics.map((metric) => (
          <article className={`rb-stat is-${metric.tone}`} key={metric.label}>
            <span>{metric.label}<em>{metric.tone}</em></span>
            <strong>{metric.value}</strong>
            <em>{metric.meta}</em>
          </article>
        ))}
      </section>
      <div className="rb-performance-grid">
        <section className="rb-performance-card">
          <h3>Pipeline funnel</h3>
          <div className="rb-funnel">
            {stageRows.map((row) => (
              <div key={row.id}>
                <span>{row.label}</span>
                <strong>{row.count}</strong>
                <i style={{ width: `${Math.max(8, Math.min(100, candidates.length ? (row.count / candidates.length) * 100 : 8))}%` }} />
              </div>
            ))}
          </div>
        </section>
        <section className="rb-performance-card">
          <h3>Submission status</h3>
          <div className="rb-funnel">
            {statusRows.length > 0 ? statusRows.map((row) => (
              <div key={row.status}>
                <span>{row.label}</span>
                <strong>{row.count}</strong>
                <i style={{ width: `${Math.max(8, Math.min(100, submissions.length ? (row.count / submissions.length) * 100 : 8))}%` }} />
              </div>
            )) : <p>No submissions yet.</p>}
          </div>
        </section>
        <section className="rb-performance-card rb-performance-card--wide">
          <h3>Feedback loop</h3>
          <div className="rb-submission-list">
            {feedbackRows.map((s) => <SubmissionRow key={s.id} submission={s} expanded />)}
            {feedbackRows.length === 0 && <p className="rb-empty">No written feedback yet. Status changes will still appear in Submissions.</p>}
          </div>
        </section>
        <section className="rb-performance-card">
          <h3>Role coverage</h3>
          <p>{primaryRoleIds.length}/{PRIMARY_ROLE_SLOT_LIMIT} primary role slots are active.</p>
          <p>{primarySubmissions} submissions came from primary roles.</p>
          <p>{singleSubmissions}/{SINGLE_SUBMISSION_WEEKLY_LIMIT} single submissions used in the tracked window.</p>
          <p>{jobs.filter((job) => !submissions.some((s) => s.inboundJobId === roleKey(job) || s.jobId === roleKey(job))).length} open roles have no submissions from this account yet.</p>
        </section>
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
      const updated = await updateRecruiterPreferences({
        notificationPreferences: { newRolesEmail: next },
        workspacePreferences: session.recruiter.workspacePreferences ?? { primaryRoleIds: [] },
      })
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
        <div><dt>Primary roles</dt><dd>{(session.recruiter.workspacePreferences?.primaryRoleIds.length ?? 0)}/{PRIMARY_ROLE_SLOT_LIMIT} slots</dd></div>
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

function RoleCard({
  job,
  sourcedCount = 0,
  submissionCount = 0,
  primary,
  primarySlotsFull,
  disabled,
  onPrimaryRoleToggle,
}: {
  job: CollabJob
  sourcedCount?: number
  submissionCount?: number
  primary: boolean
  primarySlotsFull: boolean
  disabled: boolean
  onPrimaryRoleToggle: (jobId: string, makePrimary: boolean) => void
}) {
  const { hard, fit } = roleChecklistCounts(job)
  const signal = roleFitSignal(job, sourcedCount, submissionCount)
  const slotDisabled = disabled || (!primary && primarySlotsFull)
  return (
    <article className={`rb-role-card ${primary ? "is-primary" : ""}`}>
      <div className="rb-role-card__topline">
        <span className="rb-role-card__code">Co. {job.recruiterBoard.label.companyCode}</span>
        {isNewRole(job) && <span className="rb-role-card__new">New</span>}
      </div>
      <h3><Link to={`/recruiters/job/${job.jobId}`}>{job.title}</Link></h3>
      <p>{job.recruiterBoard.label.company} - {job.recruiterBoard.label.location}</p>
      <div className="rb-role-card__pills">
        {job.recruiterBoard.label.pills.map((p, i) => <span key={i} className={`rb-pill ${p.tone ?? ""}`}>{p.text}</span>)}
      </div>
      <div className="rb-role-card__signal">
        <span className={`rb-fit-signal is-${signal.tone}`}>{signal.label} {signal.percent}%</span>
        <em>{sourcedCount} sourced - {submissionCount} submitted - {primary ? "primary slot" : "single-submit role"}</em>
      </div>
      <footer>
        <span>{hard} hard checks</span>
        <span>{fit} fit checks</span>
        <button
          type="button"
          disabled={slotDisabled}
          onClick={() => onPrimaryRoleToggle(roleKey(job), !primary)}
        >
          {primary ? "Primary" : primarySlotsFull ? "Slots full" : "Add primary"}
        </button>
      </footer>
    </article>
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
  const currentStatus = submission.status === "new" ? "submitted" : submission.status ?? "submitted"
  const currentIndex = SUBMISSION_PROGRESS.findIndex((step) => step.id === currentStatus)
  const isClosed = currentStatus === "rejected" || currentStatus === "duplicate"
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
          <div className={`rb-submission-timeline ${isClosed ? "is-closed" : ""}`} aria-label="Submission status timeline">
            {SUBMISSION_PROGRESS.map((step, index) => (
              <span key={step.id} className={currentIndex >= index ? "is-complete" : ""}>
                {step.label}
              </span>
            ))}
            {isClosed && <span className="is-complete">{meta.label}</span>}
          </div>
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
