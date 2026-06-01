/**
 * Recruiter board single-role view — /recruiters/job/:jobId
 *
 * JD primary, checklist + submission form secondary. POSTs to
 * paRecruiterSubmission CF on submit; checklist + form state persisted in
 * localStorage so a recruiter can come back later.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { onAuthStateChanged } from "firebase/auth"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import "../styles/recruiter-board.css"
import {
  createRecruiterRoleQuestion,
  fetchCollabJobs,
  fetchRecruiterRoleFeedback,
  fetchRecruiterRoleIntelligence,
  fetchRecruiterRoleQuestions,
  fetchRecruiterSourcedCandidates,
  fetchRecruiterSubmissions,
  getRecruiterProfile,
  saveRecruiterRoleFeedback,
  saveRecruiterSourcedCandidate,
  submitRecruiterCandidate,
  type CollabJob,
  type RecruiterRoleFeedbackDifficulty,
  type RecruiterRoleFeedbackItem,
  type RecruiterRoleFeedbackReason,
  type RecruiterRoleIntelligenceItem,
  type RecruiterRoleQuestionItem,
  type RecruiterSession,
  type RecruiterSourcedCandidateItem,
  type RecruiterSubmissionItem,
  type SubmissionResponse,
} from "../lib/recruiter-board-api.js"
import { auth } from "../lib/firebase.js"

const STORAGE_KEY_PREFIX = "rb-state-v1:"
const ROLE_PENDING_SUBMISSION_LIMIT = 5

const ROLE_FEEDBACK_DIFFICULTIES: Array<{ id: RecruiterRoleFeedbackDifficulty; label: string; detail: string }> = [
  { id: "easy", label: "Easy", detail: "Candidate supply is strong" },
  { id: "medium", label: "Medium", detail: "Workable with normal sourcing" },
  { id: "hard", label: "Hard", detail: "Needs tighter calibration" },
  { id: "blocked", label: "Blocked", detail: "Cannot make progress without changes" },
]

const ROLE_FEEDBACK_REASONS: Array<{ id: RecruiterRoleFeedbackReason; label: string }> = [
  { id: "low_comp", label: "Comp too low" },
  { id: "location_mismatch", label: "Location blocks supply" },
  { id: "unclear_requirements", label: "Requirements unclear" },
  { id: "small_candidate_pool", label: "Small candidate pool" },
  { id: "hiring_team_slow", label: "Feedback too slow" },
  { id: "role_too_broad", label: "Role too broad" },
  { id: "candidate_interest_low", label: "Low candidate interest" },
  { id: "too_many_recruiters", label: "Too many recruiters" },
  { id: "other", label: "Other" },
]

interface FormState {
  submitterName: string
  submitterEmail: string
  candidateName: string
  candidateLink: string
  candidateCurrentRole: string
  candidateYoe: string
  candidateNotes: string
  candidateConsent: boolean
  checklist: Record<string, boolean>
}

function emptyForm(): FormState {
  return {
    submitterName: "",
    submitterEmail: "",
    candidateName: "",
    candidateLink: "",
    candidateCurrentRole: "",
    candidateYoe: "",
    candidateNotes: "",
    candidateConsent: false,
    checklist: {},
  }
}

function loadFormState(jobId: string): FormState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + jobId)
    if (raw) return { ...emptyForm(), ...JSON.parse(raw) }
  } catch (e) {
    // ignore
  }
  return emptyForm()
}

function saveFormState(jobId: string, state: FormState): void {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + jobId, JSON.stringify(state))
  } catch (e) {
    // ignore
  }
}

function withRecruiterDefaults(state: FormState, session: RecruiterSession | null): FormState {
  if (!session) return state
  return {
    ...state,
    submitterName: state.submitterName || session.recruiter.name,
    submitterEmail: state.submitterEmail || session.recruiter.email,
  }
}

function timestampMs(raw: unknown): number {
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "object" && typeof (raw as { seconds?: unknown }).seconds === "number") {
    return (raw as { seconds: number }).seconds * 1000
  }
  return 0
}

function submissionTimeMs(raw: unknown): number {
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "object" && typeof (raw as { seconds?: unknown }).seconds === "number") {
    return (raw as { seconds: number }).seconds * 1000
  }
  return 0
}

function roleMatches(job: CollabJob, row: { jobId?: string; inboundJobId?: string }): boolean {
  return row.inboundJobId === job.jobId || row.jobId === job.jobId
}

function roleSubmissionStatusLabel(status?: string): string {
  switch (status) {
    case "reviewing": return "WeKruit review"
    case "advanced": return "Sent to team"
    case "interviewing": return "Interviewing"
    case "hired": return "Hired"
    case "rejected": return "Rejected"
    case "duplicate": return "Duplicate"
    case "submitted":
    case "new":
    default:
      return "Submitted"
  }
}

function roleSubmissionNextAction(status?: string): string {
  switch (status) {
    case "reviewing": return "Wait for WeKruit calibration before sending lookalikes."
    case "advanced": return "Keep the candidate warm for hiring-team review."
    case "interviewing": return "Watch for scheduling and close-process updates."
    case "hired": return "Placement reached hired status."
    case "rejected": return "Read feedback before sourcing another candidate."
    case "duplicate": return "Candidate already exists for this search."
    default: return "Queued for WeKruit triage."
  }
}

function roleSubmissionLastActivity(row: RecruiterSubmissionItem): string {
  const ms = submissionTimeMs(row.recruiterFeedbackUpdatedAt ?? row.updatedAt ?? row.createdAt)
  return ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Today"
}

function sourcedStageLabel(stage?: string): string {
  switch (stage) {
    case "contacted": return "Contacted"
    case "screened": return "Screened"
    case "ready": return "Ready"
    case "submitted": return "Submitted"
    case "archived": return "Archived"
    default: return "Sourced"
  }
}

function sourcedCalibrationLabel(status?: string): string {
  switch (status) {
    case "calibration_requested": return "Needs adjustment"
    case "good_fit": return "Good fit"
    case "bad_fit": return "Not a fit"
    case "suggested": return "Suggested direction"
    default: return "Not rated"
  }
}

function formatSubmissionFailure(reason?: string): string {
  if (reason === "single_submission_limit_reached") {
    return "This role is outside your primary slots and your weekly single-submission limit is used. Add the role as primary from the recruiter dashboard or wait for the rolling window to reset."
  }
  return reason ?? "submission_failed"
}

type RoleChecklistKind = CollabJob["recruiterBoard"]["checklist"]["groups"][number]["kind"]

type RoleSubmissionPacket = {
  score: number
  label: string
  tone: "ready" | "watch" | "blocked"
  summary: string
  blockers: string[]
  warnings: string[]
  proof: string[]
  nextAction: string
  missingHard: string[]
  antiFlags: string[]
}

function roleChecklistItems(job: CollabJob, kind: RoleChecklistKind) {
  return job.recruiterBoard.checklist.groups.find((group) => group.kind === kind)?.items ?? []
}

function buildRoleSubmissionPacket(input: {
  job: CollabJob
  form: FormState
  pendingSlots: number
  selectedCandidate: RecruiterSourcedCandidateItem | null
  roleCandidates: RecruiterSourcedCandidateItem[]
  roleSubmissions: RecruiterSubmissionItem[]
  roleFeedback: RecruiterRoleFeedbackItem | null
  roleQuestions: RecruiterRoleQuestionItem[]
  intelligence: RecruiterRoleIntelligenceItem | null
}): RoleSubmissionPacket {
  const { job, form, pendingSlots, selectedCandidate, roleCandidates, roleSubmissions, roleFeedback, roleQuestions, intelligence } = input
  const hardItems = roleChecklistItems(job, "hard")
  const fitItems = roleChecklistItems(job, "fit")
  const bonusItems = roleChecklistItems(job, "bonus")
  const antiItems = roleChecklistItems(job, "anti")
  const checked = (kind: RoleChecklistKind) => roleChecklistItems(job, kind).filter((item) => form.checklist[item.id]).length
  const hardChecked = checked("hard")
  const fitChecked = checked("fit")
  const bonusChecked = checked("bonus")
  const antiChecked = checked("anti")
  const missingHard = hardItems.filter((item) => !form.checklist[item.id]).map((item) => item.text)
  const antiFlags = antiItems.filter((item) => form.checklist[item.id]).map((item) => item.text)
  const blockers: string[] = []
  const warnings: string[] = []
  const proof: string[] = []
  if (!form.candidateName.trim()) blockers.push("Candidate name is missing.")
  if (!form.candidateLink.trim()) blockers.push("LinkedIn or resume link is missing.")
  if (!form.candidateConsent) blockers.push("Candidate consent is not confirmed.")
  if (pendingSlots <= 0) blockers.push("This role has no pending submission slots left.")
  if (hardItems.length > 0 && hardChecked < hardItems.length) warnings.push(`${hardItems.length - hardChecked} hard check${hardItems.length - hardChecked === 1 ? "" : "s"} still need proof.`)
  if (antiFlags.length > 0) warnings.push(`${antiFlags.length} anti-signal${antiFlags.length === 1 ? "" : "s"} marked. Add context before submitting.`)
  if (fitItems.length > 0 && fitChecked === 0) warnings.push("No fit checks are verified yet.")
  if (!form.candidateNotes.trim()) warnings.push("Add notes explaining why this candidate fits the role.")
  if (roleFeedback?.difficulty === "blocked") warnings.push("You marked this role blocked. Ask WeKruit for calibration before adding volume.")
  if (roleQuestions.some((question) => (question.status ?? "open") === "open")) warnings.push("There is an open role question waiting on WeKruit.")
  if (selectedCandidate) proof.push("Pulled from saved candidate queue")
  if (form.candidateCurrentRole.trim()) proof.push(form.candidateCurrentRole.trim())
  if (form.candidateYoe.trim()) proof.push(`${form.candidateYoe.trim()} experience`)
  if (hardChecked === hardItems.length && hardItems.length > 0) proof.push("All hard checks verified")
  if (fitChecked > 0) proof.push(`${fitChecked}/${fitItems.length} fit checks`)
  if (bonusChecked > 0) proof.push(`${bonusChecked}/${bonusItems.length} bonus signals`)
  if ((intelligence?.readyCount ?? 0) > 0) proof.push(`${intelligence?.readyCount} ready candidate${intelligence?.readyCount === 1 ? "" : "s"} across board`)
  if (roleCandidates.length > 0) proof.push(`${roleCandidates.length} sourced in your CRM`)
  if (roleSubmissions.length > 0) proof.push(`${roleSubmissions.length} prior submission${roleSubmissions.length === 1 ? "" : "s"}`)

  const basicsScore = (form.candidateName.trim() ? 10 : 0) + (form.candidateLink.trim() ? 10 : 0) + (form.candidateConsent ? 12 : 0)
  const hardScore = hardItems.length ? Math.round((hardChecked / hardItems.length) * 34) : 22
  const fitScore = fitItems.length ? Math.round((fitChecked / fitItems.length) * 18) : 10
  const bonusScore = bonusItems.length ? Math.min(10, Math.round((bonusChecked / bonusItems.length) * 10)) : 4
  const notesScore = form.candidateNotes.trim() ? 8 : 0
  const queueScore = selectedCandidate ? 5 : roleCandidates.length ? 3 : 0
  const penalty = antiChecked * 12 + (pendingSlots <= 0 ? 30 : 0) + (roleFeedback?.difficulty === "blocked" ? 10 : 0)
  const score = Math.max(0, Math.min(100, basicsScore + hardScore + fitScore + bonusScore + notesScore + queueScore - penalty))
  const tone: RoleSubmissionPacket["tone"] = blockers.length ? "blocked" : score >= 82 && warnings.length === 0 ? "ready" : "watch"
  const label = tone === "blocked" ? "Blocked" : tone === "ready" ? "Ready to submit" : "Needs proof"
  const summary = tone === "ready"
    ? "This packet has consent, candidate identity, and enough checklist proof to submit cleanly."
    : tone === "blocked"
      ? "Fix the blocking items before this submission can move cleanly through WeKruit review."
      : "This candidate can become a strong submission once the missing proof is filled in."
  const nextAction = blockers[0] ?? warnings[0] ?? "Submit the candidate, then track review status from the recruiter inbox."
  return {
    score,
    label,
    tone,
    summary,
    blockers,
    warnings,
    proof: proof.slice(0, 6),
    nextAction,
    missingHard: missingHard.slice(0, 4),
    antiFlags: antiFlags.slice(0, 4),
  }
}

// Minimal Markdown → React renderer for jdBlocks.body. Supports `-` bullet
// lists, blank-line paragraphs, and inline `**bold**` / `*em*` / `` `code` ``.
function renderMarkdown(text: string): ReactNode[] {
  const lines = text.split("\n")
  const out: ReactNode[] = []
  let listBuffer: string[] = []
  let key = 0
  const flushList = () => {
    if (listBuffer.length) {
      out.push(
        <ul key={key++}>
          {listBuffer.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      )
      listBuffer = []
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith("- ")) {
      listBuffer.push(line.slice(2))
    } else if (line === "") {
      flushList()
    } else {
      flushList()
      out.push(<p key={key++}>{renderInline(line)}</p>)
    }
  }
  flushList()
  return out
}

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  // Tokenize on **bold**, *em*, `code`
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[1]
    if (tok.startsWith("**")) parts.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith("`")) parts.push(<code key={key++}>{tok.slice(1, -1)}</code>)
    else parts.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    last = regex.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export default function RecruiterRole() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [session, setSession] = useState<RecruiterSession | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [sourcedCandidates, setSourcedCandidates] = useState<RecruiterSourcedCandidateItem[]>([])
  const [submissions, setSubmissions] = useState<RecruiterSubmissionItem[]>([])
  const [roleFeedback, setRoleFeedback] = useState<RecruiterRoleFeedbackItem[]>([])
  const [roleIntelligence, setRoleIntelligence] = useState<RecruiterRoleIntelligenceItem[]>([])
  const [roleQuestions, setRoleQuestions] = useState<RecruiterRoleQuestionItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [trackerError, setTrackerError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [submission, setSubmission] = useState<SubmissionResponse | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [prefilledCandidateId, setPrefilledCandidateId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      void (async () => {
        if (!user) {
          if (!active) return
          setSession(null)
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

  // Restore persisted form once we know the jobId.
  useEffect(() => {
    if (jobId) setForm(withRecruiterDefaults(loadFormState(jobId), session))
  }, [jobId, session])

  // Fetch list once; pull out the role this page renders.
  useEffect(() => {
    fetchCollabJobs()
      .then((list) => setJobs(list))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  useEffect(() => {
    if (!session) return
    let active = true
    const roleIntelligenceRequest = fetchRecruiterRoleIntelligence().catch(() => [] as RecruiterRoleIntelligenceItem[])
    Promise.all([
      fetchRecruiterSourcedCandidates(),
      fetchRecruiterSubmissions(),
      fetchRecruiterRoleFeedback(),
      fetchRecruiterRoleQuestions(),
      roleIntelligenceRequest,
    ])
      .then(([candidates, rows, feedback, questions, intelligence]) => {
        if (!active) return
        setSourcedCandidates(candidates)
        setSubmissions(rows)
        setRoleFeedback(feedback)
        setRoleQuestions(questions)
        setRoleIntelligence(intelligence)
        setTrackerError(null)
      })
      .catch((e) => {
        if (active) setTrackerError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      active = false
    }
  }, [session?.recruiterId])

  // Persist form on every change.
  useEffect(() => {
    if (jobId) saveFormState(jobId, form)
  }, [jobId, form])

  const job = useMemo(() => jobs?.find((j) => j.jobId === jobId) ?? null, [jobs, jobId])

  useEffect(() => {
    const candidateParam = searchParams.get("candidateId")
    if (!candidateParam || prefilledCandidateId === candidateParam) return
    const candidate = sourcedCandidates.find((c) => c.id === candidateParam || c.candidateId === candidateParam)
    if (!candidate) return
    setForm((next) => withRecruiterDefaults({
      ...next,
      candidateName: candidate.candidate?.name || "",
      candidateLink: candidate.candidate?.link || "",
      candidateCurrentRole: candidate.candidate?.currentRole || "",
      candidateYoe: candidate.candidate?.yoe || "",
      candidateNotes: candidate.candidate?.notes || "",
    }, session))
    setPrefilledCandidateId(candidateParam)
  }, [prefilledCandidateId, searchParams, session, sourcedCandidates])

  if (error) return <div className="rb-page"><div className="rb-state error">Could not load: {error}</div></div>
  if (!authReady) return <div className="rb-page"><div className="rb-state">Loading recruiter account...</div></div>
  if (!session) {
    return (
      <div className="rb-page rb-page--access-required">
        <main className="rb-main">
          <Link to="/recruiters" className="rb-back">Back to recruiter access</Link>
          <div className="rb-access-required">
            <p className="rb-overline">Invite required</p>
            <h1>Recruiter access is required before submitting candidates.</h1>
            <p>Enter your WeKruit recruiter code first. After that, role pages can submit and track candidates under your account.</p>
            <Link to="/recruiters" className="rb-btn primary">Enter access code</Link>
          </div>
        </main>
      </div>
    )
  }
  if (!jobs) return <div className="rb-page"><div className="rb-state">Loading…</div></div>
  if (!job) {
    return (
      <div className="rb-page">
        <main className="rb-main">
          <Link to="/recruiters" className="rb-back">← All roles</Link>
          <div className="rb-state error">
            Role <code>{jobId}</code> not found or no longer active.
          </div>
        </main>
      </div>
    )
  }

  const groups = job.recruiterBoard.checklist.groups
  const totals = {
    hard: groups.find((g) => g.kind === "hard")?.items.length ?? 0,
    fit: groups.find((g) => g.kind === "fit")?.items.length ?? 0,
    bonus: groups.find((g) => g.kind === "bonus")?.items.length ?? 0,
    anti: groups.find((g) => g.kind === "anti")?.items.length ?? 0,
  }
  const checkedCounts = {
    hard: (groups.find((g) => g.kind === "hard")?.items ?? []).filter((i) => form.checklist[i.id]).length,
    fit: (groups.find((g) => g.kind === "fit")?.items ?? []).filter((i) => form.checklist[i.id]).length,
    bonus: (groups.find((g) => g.kind === "bonus")?.items ?? []).filter((i) => form.checklist[i.id]).length,
    anti: (groups.find((g) => g.kind === "anti")?.items ?? []).filter((i) => form.checklist[i.id]).length,
  }
  const totalChecked = Object.values(checkedCounts).reduce((s, n) => s + n, 0)
  const totalItems = Object.values(totals).reduce((s, n) => s + n, 0)
  const roleCandidates = sourcedCandidates
    .filter((candidate) => roleMatches(job, candidate))
    .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))
  const roleSubmissions = submissions
    .filter((row) => roleMatches(job, row))
    .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt))
  const currentRoleFeedback = roleFeedback.find((feedback) => roleMatches(job, feedback)) ?? null
  const currentRoleIntelligence = roleIntelligence.find((item) => item.jobId === job.jobId) ?? null
  const currentRoleQuestions = roleQuestions
    .filter((question) => roleMatches(job, question))
    .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))
  const pendingCount = roleSubmissions.filter((row) => ["submitted", "new", "reviewing"].includes(row.status ?? "submitted")).length
  const pendingSlots = Math.max(0, ROLE_PENDING_SUBMISSION_LIMIT - pendingCount)
  const selectedCandidate = prefilledCandidateId
    ? roleCandidates.find((candidate) => candidate.id === prefilledCandidateId || candidate.candidateId === prefilledCandidateId) ?? null
    : null
  const submissionPacket = buildRoleSubmissionPacket({
    job,
    form,
    pendingSlots,
    selectedCandidate,
    roleCandidates,
    roleSubmissions,
    roleFeedback: currentRoleFeedback,
    roleQuestions: currentRoleQuestions,
    intelligence: currentRoleIntelligence,
  })

  const useSourcedCandidate = (candidate: RecruiterSourcedCandidateItem) => {
    setForm((next) => withRecruiterDefaults({
      ...next,
      candidateName: candidate.candidate?.name || "",
      candidateLink: candidate.candidate?.link || "",
      candidateCurrentRole: candidate.candidate?.currentRole || "",
      candidateYoe: candidate.candidate?.yoe || "",
      candidateNotes: candidate.candidate?.notes || "",
    }, session))
    setPrefilledCandidateId(candidate.id)
    setSearchParams({ candidateId: candidate.id })
    requestAnimationFrame(() => document.getElementById("submit-candidate")?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!session) {
      setSubmitError("recruiter_access_required")
      return
    }
    if (!form.candidateConsent) {
      setSubmitError("candidate_consent_required")
      return
    }
    if (pendingSlots <= 0) {
      setSubmitError("This role already has 5 pending submissions from your account. Wait for review feedback before submitting more.")
      return
    }
    setSubmitError(null)
    setSubmitting(true)
    const result = await submitRecruiterCandidate({
      jobId: job.jobId,
      submitter: {
        name: form.submitterName.trim(),
        email: form.submitterEmail.trim(),
      },
      candidate: {
        name: form.candidateName.trim(),
        link: form.candidateLink.trim(),
        currentRole: form.candidateCurrentRole.trim() || undefined,
        yoe: form.candidateYoe.trim() || undefined,
        notes: form.candidateNotes.trim() || undefined,
      },
      checklist: form.checklist,
      candidateConsent: true,
    })
    setSubmitting(false)
    if (result.ok) {
      setSubmission(result)
      if (selectedCandidate) {
        saveRecruiterSourcedCandidate({
          candidateId: selectedCandidate.candidateId || selectedCandidate.id,
          jobId: selectedCandidate.inboundJobId || job.jobId,
          stage: "submitted",
          candidate: {
            name: form.candidateName.trim(),
            link: form.candidateLink.trim(),
            currentRole: form.candidateCurrentRole.trim() || undefined,
            yoe: form.candidateYoe.trim() || undefined,
            notes: form.candidateNotes.trim() || undefined,
          },
        })
          .then((saved) => setSourcedCandidates((rows) => [saved, ...rows.filter((row) => row.id !== saved.id)]))
          .catch(() => undefined)
      }
      saveFormState(job.jobId, withRecruiterDefaults(emptyForm(), session))
      window.scrollTo({ top: 0, behavior: "smooth" })
    } else {
      setSubmitError(formatSubmissionFailure(result.reason))
    }
  }

  const resetChecklist = () => {
    if (!confirm("Clear this role's checklist and candidate fields?")) return
    setForm(withRecruiterDefaults(emptyForm(), session))
  }

  const submitAnother = () => {
    setSubmission(null)
  }

  return (
    <div className="rb-page">
      <main className="rb-main">
        <Link to="/recruiters" className="rb-back">← All roles</Link>

        <div className="rb-role-header">
          <div>
            <h2>{job.title}</h2>
            <div className="meta">
              <span>{job.recruiterBoard.label.company}</span>
              <span>{job.recruiterBoard.label.location}</span>
              <span>
                {job.recruiterBoard.label.pills.map((p, i) => (
                  <span key={i} className={`rb-pill ${p.tone ?? ""}`}>{p.text}</span>
                ))}
              </span>
            </div>
          </div>
        </div>

        <section className="rb-role-cockpit" aria-label="Role recruiting cockpit">
          <article>
            <span>Reward</span>
            <strong>{job.compSummary || "$10K+ placement fee"}</strong>
            <em>Paid on successful hire.</em>
          </article>
          <article>
            <span>Pending slots</span>
            <strong>{pendingSlots}/{ROLE_PENDING_SUBMISSION_LIMIT}</strong>
            <em>Wait for feedback when full.</em>
          </article>
          <article>
            <span>My role pipeline</span>
            <strong>{roleCandidates.length} sourced</strong>
            <em>{roleSubmissions.length} submitted.</em>
          </article>
          <article>
            <span>Scorecard</span>
            <strong>{totals.hard} hard / {totals.fit} fit</strong>
            <em>{totals.anti} anti-signal checks.</em>
          </article>
        </section>

        <RoleIntelligencePanel
          intelligence={currentRoleIntelligence}
          fallback={{
            candidates: roleCandidates.length,
            submissions: roleSubmissions.length,
            pending: pendingCount,
            questions: currentRoleQuestions.length,
            feedback: currentRoleFeedback,
          }}
        />

        {submission && submission.ok && (
          <div className="rb-success">
            <strong>Candidate submitted.</strong> We&apos;ll review and update your tracker.
            {submission.score && (
              <div style={{ marginTop: 6, color: "#1a1a1a" }}>
                Score: Hard {submission.score.hardChecked}/{submission.score.hardTotal}{" "}
                · Fit {submission.score.fitChecked}/{submission.score.fitTotal}{" "}
                · Bonus {submission.score.bonusChecked}/{submission.score.bonusTotal}{" "}
                · Anti {submission.score.antiChecked}/{submission.score.antiTotal}
              </div>
            )}
            {submission.submissionMode && (
              <div style={{ marginTop: 6, color: "#1a1a1a" }}>
                Submission mode: {submission.submissionMode === "primary_role" ? "Primary role" : "Single submission"}
              </div>
            )}
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button className="rb-btn" onClick={submitAnother}>Submit another for this role</button>
              <button className="rb-btn" onClick={() => navigate("/recruiters?tab=submissions")}>Track status</button>
            </div>
          </div>
        )}

        {trackerError && <div className="rb-error">Could not load role tracker: {trackerError}</div>}

        <div className="rb-role-dashboard">
          <section className="rb-role-main">
            <div className="rb-jd">
              {job.compSummary && <div className="rb-comp"><strong>Comp:</strong> {job.compSummary}</div>}
              {job.jdBlocks.map((block, i) => (
                <section className="block" key={i}>
                  <h3>{block.heading}</h3>
                  {renderMarkdown(block.body)}
                </section>
              ))}
              {job.recruiterBoard.interviewProcess && (
                <section className="block">
                  <h3>Interview process</h3>
                  <p>{job.recruiterBoard.interviewProcess}</p>
                </section>
              )}
            </div>

            <div className="rb-culture">
              <h3>Culture &amp; what they're building</h3>
              <p><strong>The bet:</strong> {job.recruiterBoard.culture.bet}</p>
              <ul>
                {job.recruiterBoard.culture.bullets.map((b, i) => (
                  <li key={i}>{renderInline(b)}</li>
                ))}
              </ul>
            </div>

            <div className="rb-banner">
              <strong>Recruiters: source first, submit only after consent.</strong>
              <span className="small">
                Use the role queue to prefill a sourced candidate, tick every verified requirement, then submit.
                The role allows up to {ROLE_PENDING_SUBMISSION_LIMIT} pending submissions before waiting for feedback.
              </span>
              <span className="chip">{pendingSlots} pending slots open</span>
            </div>

            <SubmissionPacketPanel packet={submissionPacket} />

            <form id="submit-candidate" className="rb-form-section rb-form" onSubmit={onSubmit}>
              <h3 className="section-title">Your contact (for follow-up)</h3>
              <p className="rb-form-note">Submitting as {session.recruiter.email}. WeKruit status updates will appear in your recruiter tracker.</p>
              {selectedCandidate && (
                <p className="rb-form-note rb-form-note--active">
                  Prefilled from your sourced candidate queue: {selectedCandidate.candidate?.name || "Candidate"}.
                </p>
              )}
              <div className="field">
                <label>Your name *</label>
                <input
                  type="text"
                  required
                  value={form.submitterName}
                  onChange={(e) => setForm({ ...form, submitterName: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Your email *</label>
                <input
                  type="email"
                  required
                  value={form.submitterEmail}
                  onChange={(e) => setForm({ ...form, submitterEmail: e.target.value })}
                />
              </div>

          <h3 className="section-title" style={{ marginTop: 24 }}>Candidate</h3>
          <div className="field">
            <label>Candidate name *</label>
            <input
              type="text"
              required
              value={form.candidateName}
              onChange={(e) => setForm({ ...form, candidateName: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Resume / LinkedIn *</label>
            <input
              type="text"
              required
              placeholder="https://linkedin.com/in/…"
              value={form.candidateLink}
              onChange={(e) => setForm({ ...form, candidateLink: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Current role</label>
            <input
              type="text"
              value={form.candidateCurrentRole}
              onChange={(e) => setForm({ ...form, candidateCurrentRole: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Years of experience</label>
            <input
              type="text"
              value={form.candidateYoe}
              onChange={(e) => setForm({ ...form, candidateYoe: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Notes for us</label>
            <textarea
              value={form.candidateNotes}
              onChange={(e) => setForm({ ...form, candidateNotes: e.target.value })}
            />
          </div>
          <label className="rb-consent">
            <input
              type="checkbox"
              required
              checked={form.candidateConsent}
              onChange={(e) => setForm({ ...form, candidateConsent: e.target.checked })}
            />
            <span>I confirm this candidate gave consent to be submitted to WeKruit for this role.</span>
          </label>

          <h3 className="section-title" style={{ marginTop: 24 }}>Fit checklist</h3>
          {groups.map((group) => (
            <div className={`rb-group ${group.kind}`} key={group.kind}>
              <h4>
                {group.heading}
                <span className="count">
                  {checkedCounts[group.kind]} / {group.items.length}
                </span>
              </h4>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!form.checklist[item.id]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            checklist: { ...form.checklist, [item.id]: e.target.checked },
                          })
                        }
                      />
                      <span className="item-text">{item.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {submitError && <div className="rb-error">Submission failed: {submitError}</div>}

          <div className="rb-actions">
            <button type="submit" className="rb-btn primary" disabled={submitting || pendingSlots <= 0}>
              {submitting ? "Submitting…" : "Submit candidate"}
            </button>
            <button type="button" className="rb-btn" onClick={resetChecklist} disabled={submitting}>
              Reset checklist
            </button>
            <div className="rb-progress">
              <strong>{totalChecked}</strong> of {totalItems} boxes checked
            </div>
          </div>
        </form>
          </section>

          <aside className="rb-role-side">
            <section className="rb-side-panel">
              <h3>Candidate queue</h3>
              <p>Prospects saved in your CRM for this role. Use one to prefill the submit form.</p>
              <div className="rb-role-candidate-list">
                {roleCandidates.slice(0, 8).map((candidate) => (
                  <article key={candidate.id}>
                    <span>
                      <strong>{candidate.candidate?.name || "Candidate"}</strong>
                      <em>{candidate.candidate?.currentRole || sourcedStageLabel(candidate.stage)}</em>
                      {(candidate.calibrationStatus || candidate.calibrationNote) && (
                        <em>
                          {sourcedCalibrationLabel(candidate.calibrationStatus)}
                          {candidate.calibrationNote ? ` - ${candidate.calibrationNote}` : ""}
                        </em>
                      )}
                    </span>
                    <small>{sourcedStageLabel(candidate.stage)}</small>
                    <button type="button" className="rb-btn" onClick={() => useSourcedCandidate(candidate)}>
                      Use
                    </button>
                  </article>
                ))}
                {roleCandidates.length === 0 && <p className="rb-side-empty">No sourced candidates for this role yet.</p>}
              </div>
              <button type="button" className="rb-btn rb-btn--block" onClick={() => navigate("/recruiters?tab=candidates")}>
                Add sourced candidate
              </button>
            </section>

            <section className="rb-side-panel">
              <h3>Calibration</h3>
              <div className="rb-calibration-stack">
                {groups.filter((group) => group.kind === "hard" || group.kind === "anti").map((group) => (
                  <div key={group.kind}>
                    <strong>{group.heading}</strong>
                    <ul>
                      {group.items.slice(0, 4).map((item) => <li key={item.id}>{item.text}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            </section>

            <RoleFeedbackPanel
              job={job}
              feedback={currentRoleFeedback}
              onSaved={(saved) => {
                setRoleFeedback((rows) => [saved, ...rows.filter((row) => row.id !== saved.id)])
              }}
            />

            <RoleQuestionsPanel
              job={job}
              questions={currentRoleQuestions}
              onCreated={(question) => {
                setRoleQuestions((rows) => [question, ...rows.filter((row) => row.id !== question.id)])
              }}
            />

            <section className="rb-side-panel">
              <h3>My submissions</h3>
              <div className="rb-role-submission-list">
                {roleSubmissions.slice(0, 6).map((row) => (
                  <article key={row.id}>
                    <span>
                      <strong>{row.candidate?.name || "Candidate"}</strong>
                      <em>{roleSubmissionStatusLabel(row.status)}</em>
                      <em>{roleSubmissionNextAction(row.status)}</em>
                      {row.recruiterFeedbackNote && <em className="rb-role-submission-note">{row.recruiterFeedbackNote}</em>}
                    </span>
                    <small>{roleSubmissionLastActivity(row)}</small>
                  </article>
                ))}
                {roleSubmissions.length === 0 && <p className="rb-side-empty">No submitted candidates yet.</p>}
              </div>
            </section>
          </aside>
        </div>
      </main>
    </div>
  )
}

function SubmissionPacketPanel({ packet }: { packet: RoleSubmissionPacket }) {
  return (
    <section className={`rb-submission-packet is-${packet.tone}`} aria-label="Submission packet readiness">
      <header>
        <div>
          <span>Submission packet</span>
          <strong>{packet.label}</strong>
          <p>{packet.summary}</p>
        </div>
        <div className="rb-submission-packet__score">
          <b>{packet.score}</b>
          <em>quality score</em>
        </div>
      </header>
      <div className="rb-submission-packet__grid">
        <article>
          <span>Next required move</span>
          <strong>{packet.nextAction}</strong>
        </article>
        <article>
          <span>Proof captured</span>
          {packet.proof.length ? (
            <ul>
              {packet.proof.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p>No candidate proof captured yet.</p>
          )}
        </article>
        <article>
          <span>Review risks</span>
          {packet.blockers.length || packet.warnings.length ? (
            <ul>
              {[...packet.blockers, ...packet.warnings].slice(0, 6).map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p>No major review risks detected.</p>
          )}
        </article>
      </div>
      {(packet.missingHard.length > 0 || packet.antiFlags.length > 0) && (
        <div className="rb-submission-packet__checks">
          {packet.missingHard.length > 0 && (
            <div>
              <strong>Missing hard proof</strong>
              {packet.missingHard.map((item) => <span key={item}>{item}</span>)}
            </div>
          )}
          {packet.antiFlags.length > 0 && (
            <div>
              <strong>Anti-signal context needed</strong>
              {packet.antiFlags.map((item) => <span key={item}>{item}</span>)}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function roleFeedbackDifficultyLabel(difficulty?: RecruiterRoleFeedbackDifficulty): string {
  return ROLE_FEEDBACK_DIFFICULTIES.find((item) => item.id === difficulty)?.label ?? "Not shared"
}

function roleFeedbackReasonLabel(reason: RecruiterRoleFeedbackReason): string {
  return ROLE_FEEDBACK_REASONS.find((item) => item.id === reason)?.label ?? reason
}

function roleIntelligenceActivityLabel(iso: string | null | undefined): string {
  if (!iso) return "No activity yet"
  const ms = Date.parse(iso)
  if (!ms) return "No activity yet"
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function roleIntelligenceDiagnosis(
  intelligence: RecruiterRoleIntelligenceItem | null,
  feedback: RecruiterRoleFeedbackItem | null,
): { label: string; detail: string; tone: "good" | "watch" | "blocked" | "quiet" } {
  if (intelligence?.feedback.blocked) {
    return { label: "Blocked market", detail: "Recruiters are reporting a hard stop.", tone: "blocked" }
  }
  if (intelligence && intelligence.feedback.hard > intelligence.feedback.easy) {
    return { label: "Hard search", detail: "Tighten calibration before adding volume.", tone: "watch" }
  }
  if (feedback?.difficulty === "blocked") {
    return { label: "You marked blocked", detail: "This role needs WeKruit calibration.", tone: "blocked" }
  }
  if (feedback?.difficulty === "hard") {
    return { label: "You marked hard", detail: "Your market signal says this needs focus.", tone: "watch" }
  }
  if (intelligence && (intelligence.readyCount > 0 || intelligence.advancedCount > 0)) {
    return { label: "Market moving", detail: "Candidate signal is reaching the queue.", tone: "good" }
  }
  return { label: "Signal forming", detail: "Early role data; source carefully.", tone: "quiet" }
}

function RoleIntelligencePanel({
  intelligence,
  fallback,
}: {
  intelligence: RecruiterRoleIntelligenceItem | null
  fallback: {
    candidates: number
    submissions: number
    pending: number
    questions: number
    feedback: RecruiterRoleFeedbackItem | null
  }
}) {
  const diagnosis = roleIntelligenceDiagnosis(intelligence, fallback.feedback)
  const topReasons = intelligence?.feedback.topReasons.length
    ? intelligence.feedback.topReasons
    : (fallback.feedback?.reasons ?? []).map((reason) => ({ reason, count: 1 }))
  const sourced = intelligence?.sourcedCount ?? fallback.candidates
  const ready = intelligence?.readyCount ?? 0
  const submissions = intelligence?.submissionCount ?? fallback.submissions
  const pending = intelligence?.pendingCount ?? fallback.pending
  const recruiters = intelligence?.recruiterCount ?? 1
  const openQuestions = intelligence?.openQuestionCount ?? fallback.questions
  const answeredQuestions = intelligence?.answeredQuestionCount ?? 0
  const feedbackTotal = intelligence?.feedback.total ?? (fallback.feedback ? 1 : 0)
  const activity = intelligence ? roleIntelligenceActivityLabel(intelligence.lastActivityAt) : "Self data only"

  return (
    <section className={`rb-role-intel is-${diagnosis.tone}`} aria-label="Role intelligence">
      <div className="rb-role-intel__lead">
        <span>Role intelligence</span>
        <strong>{diagnosis.label}</strong>
        <em>{diagnosis.detail}</em>
      </div>
      <div className="rb-role-intel__metrics">
        <div>
          <span>Recruiters active</span>
          <strong>{recruiters}</strong>
          <em>{activity}</em>
        </div>
        <div>
          <span>Sourced / ready</span>
          <strong>{sourced} / {ready}</strong>
          <em>{submissions} submitted, {pending} pending.</em>
        </div>
        <div>
          <span>Calibration</span>
          <strong>{feedbackTotal} signal{feedbackTotal === 1 ? "" : "s"}</strong>
          <em>{openQuestions} open Q, {answeredQuestions} answered.</em>
        </div>
      </div>
      <div className="rb-role-intel__reasons">
        {topReasons.length ? (
          topReasons.slice(0, 4).map((item) => (
            <span key={item.reason}>{roleFeedbackReasonLabel(item.reason)}{item.count > 1 ? ` ×${item.count}` : ""}</span>
          ))
        ) : (
          <span>No blocker reason yet</span>
        )}
      </div>
    </section>
  )
}

function RoleFeedbackPanel({
  job,
  feedback,
  onSaved,
}: {
  job: CollabJob
  feedback: RecruiterRoleFeedbackItem | null
  onSaved: (feedback: RecruiterRoleFeedbackItem) => void
}) {
  const [difficulty, setDifficulty] = useState<RecruiterRoleFeedbackDifficulty>(feedback?.difficulty ?? "medium")
  const [reasons, setReasons] = useState<RecruiterRoleFeedbackReason[]>(feedback?.reasons ?? [])
  const [note, setNote] = useState(feedback?.note ?? "")
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setDifficulty(feedback?.difficulty ?? "medium")
    setReasons(feedback?.reasons ?? [])
    setNote(feedback?.note ?? "")
    setSavedAt(null)
    setErr(null)
  }, [feedback?.id])

  const toggleReason = (reason: RecruiterRoleFeedbackReason) => {
    setReasons((current) => current.includes(reason)
      ? current.filter((item) => item !== reason)
      : [...current, reason].slice(0, 6))
  }

  const save = async () => {
    setSaving(true)
    setErr(null)
    try {
      const saved = await saveRecruiterRoleFeedback({
        jobId: job.jobId,
        difficulty,
        reasons,
        note: note.trim() || undefined,
      })
      onSaved(saved)
      setSavedAt(new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rb-side-panel rb-role-feedback">
      <h3>Role feedback</h3>
      <p>Share market signal before the search drifts.</p>
      <div className="rb-feedback-difficulty" role="radiogroup" aria-label="Role difficulty">
        {ROLE_FEEDBACK_DIFFICULTIES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={difficulty === item.id ? "is-active" : ""}
            onClick={() => setDifficulty(item.id)}
          >
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </button>
        ))}
      </div>
      <div className="rb-feedback-reasons" aria-label="Role feedback reasons">
        {ROLE_FEEDBACK_REASONS.map((reason) => (
          <button
            key={reason.id}
            type="button"
            className={reasons.includes(reason.id) ? "is-active" : ""}
            onClick={() => toggleReason(reason.id)}
          >
            {reason.label}
          </button>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Comp signal, market objection, missing calibration, or why this role is blocked..."
        rows={4}
      />
      <div className="rb-role-feedback__footer">
        <span>{feedback ? `${roleFeedbackDifficultyLabel(feedback.difficulty)} last saved` : "No role feedback yet"}</span>
        <button type="button" className="rb-btn" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving..." : "Save feedback"}
        </button>
      </div>
      {savedAt && <p className="rb-form-note rb-form-note--active">Saved at {savedAt}.</p>}
      {err && <p className="rb-error">{err}</p>}
    </section>
  )
}

function roleQuestionTime(raw: unknown): string {
  const ms = timestampMs(raw)
  return ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Just now"
}

function RoleQuestionsPanel({
  job,
  questions,
  onCreated,
}: {
  job: CollabJob
  questions: RecruiterRoleQuestionItem[]
  onCreated: (question: RecruiterRoleQuestionItem) => void
}) {
  const [question, setQuestion] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const createQuestion = async () => {
    const trimmed = question.trim()
    if (trimmed.length < 8) {
      setErr("Ask a specific role question.")
      return
    }
    setSubmitting(true)
    setErr(null)
    try {
      const saved = await createRecruiterRoleQuestion({
        jobId: job.jobId,
        question: trimmed,
      })
      onCreated(saved)
      setQuestion("")
      setSavedAt(new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="rb-side-panel rb-role-questions">
      <h3>Questions for WeKruit</h3>
      <p>Ask role-specific calibration questions before spending sourcing cycles.</p>
      <div className="rb-role-question-list">
        {questions.slice(0, 5).map((item) => (
          <article key={item.id} className={item.status === "answered" ? "is-answered" : ""}>
            <div>
              <strong>{item.question || "Question"}</strong>
              <small>{item.status === "answered" ? "Answered" : "Open"} · {roleQuestionTime(item.updatedAt ?? item.createdAt)}</small>
            </div>
            {item.answer && <p>{item.answer}</p>}
          </article>
        ))}
        {questions.length === 0 && <p className="rb-side-empty">No questions for this role yet.</p>}
      </div>
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Example: Are Canada-based candidates acceptable if they overlap US hours?"
        rows={4}
      />
      <div className="rb-role-feedback__footer">
        <span>{savedAt ? `Sent at ${savedAt}` : "WeKruit answers appear here"}</span>
        <button type="button" className="rb-btn" onClick={() => void createQuestion()} disabled={submitting || question.trim().length < 8}>
          {submitting ? "Sending..." : "Ask question"}
        </button>
      </div>
      {err && <p className="rb-error">{err}</p>}
    </section>
  )
}
