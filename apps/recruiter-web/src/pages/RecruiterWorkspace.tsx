/**
 * Recruiter Workspace — /recruiters
 *
 * Implements the "Recruiter Workspace.dc.html" design: a 3-view shell
 * (Submissions master–detail feedback loop, Roles list, Role brief) over the
 * real recruiter-board API. The submit flow stays on the existing role sheet
 * (/recruiters/job/:jobId); this surface is the status + feedback home.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { signOut } from "firebase/auth"
import "../styles/recruiter-workspace.css"
import { auth } from "../lib/firebase.js"
import { useRecruiterSession } from "../lib/recruiter-session-context.js"
import {
  RecruiterAccessGate,
  readRecruiterInviteLinkFromLocation,
  writePendingRecruiterAccess,
  type RecruiterInviteLink,
} from "./RecruiterBoard.js"
import {
  addRecruiterSubmissionComment,
  fetchCollabJobs,
  fetchRecruiterSourcedCandidates,
  fetchRecruiterSubmissionComments,
  fetchRecruiterSubmissions,
  resendRecruiterCandidateConfirmation,
  updateRecruiterPreferences,
  type CollabJob,
  type RecruiterSubmissionComment,
  type RecruiterSubmissionItem,
} from "../lib/recruiter-board-api.js"

// ---------- tone palette (verbatim from the design) ----------
const TONE = {
  live: { fg: "#9A4421", bg: "#FBE8DA", bd: "#F0BFA0" },
  info: { fg: "#4A5D6E", bg: "#DDE3E5", bd: "#C5CDD1" },
  success: { fg: "#4F6B3C", bg: "#E6E9D9", bd: "#CDD4BA" },
  warn: { fg: "#B57826", bg: "#F4E1C4", bd: "#E6C99A" },
  danger: { fg: "#9A3B2A", bg: "#F2D5CC", bd: "#E2B3A6" },
  mute: { fg: "#897462", bg: "#EFE4D4", bd: "#E3D6C3" },
} as const
type Tone = keyof typeof TONE

function pillStyle(tone: Tone): React.CSSProperties {
  const t = TONE[tone]
  return {
    display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px",
    borderRadius: 999, fontSize: 11.5, fontWeight: 600,
    background: t.bg, color: t.fg, whiteSpace: "nowrap",
  }
}

// ---------- status model (real backend statuses) ----------
const STATUS: Record<string, { label: string; tone: Tone; step: number }> = {
  new: { label: "Submitted", tone: "live", step: 0 },
  submitted: { label: "Submitted", tone: "live", step: 0 },
  reviewing: { label: "In review", tone: "info", step: 0 },
  backburner: { label: "On hold", tone: "mute", step: 0 },
  wekruit_interview: { label: "WeKruit interview", tone: "live", step: 1 },
  client_review: { label: "With client", tone: "info", step: 2 },
  interviewing: { label: "Client interview", tone: "info", step: 2 },
  advanced: { label: "Advanced", tone: "success", step: 2 },
  offer: { label: "Offer", tone: "success", step: 2 },
  hired: { label: "Hired", tone: "success", step: 3 },
  rejected: { label: "Not moving forward", tone: "danger", step: 3 },
  duplicate: { label: "Duplicate", tone: "mute", step: 0 },
}
function statusMeta(s: string | undefined) {
  return STATUS[s ?? "submitted"] ?? STATUS.submitted
}

const ADVANCED_STATUSES = ["wekruit_interview", "client_review", "interviewing", "advanced", "offer", "hired"]
const ACTIVE_STATUSES = ["new", "submitted", "reviewing", "backburner"]

// Feedback reason labels — known vocab from the review flow; unknown reasons
// prettify from snake_case. `good` controls chip tone + pattern aggregation.
const REASON: Record<string, { label: string; good: boolean }> = {
  strong_match: { label: "Strong match", good: true },
  clear_evidence: { label: "Clear evidence", good: true },
  candidate_motivated: { label: "Candidate motivated", good: true },
  missing_hard_filter: { label: "Missing hard filter", good: false },
  weak_evidence: { label: "Thin evidence", good: false },
  comp_mismatch: { label: "Comp mismatch", good: false },
  location_mismatch: { label: "Location mismatch", good: false },
  seniority_mismatch: { label: "Seniority mismatch", good: false },
  not_interested: { label: "Not interested", good: false },
}
function reasonMeta(r: string): { label: string; good: boolean } {
  return REASON[r] ?? { label: r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), good: false }
}

const QUARTER_INTERVIEW_GOAL = 12
const QUARTER_SOURCED_GOAL = 60
const PATTERN_DISMISS_KEY = "rw_patterns_dismissed_v1"

// ---------- shared coercions ----------
function toMs(raw: unknown): number {
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "number") return raw
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    if (typeof obj.seconds === "number") return obj.seconds * 1000
    if (typeof obj._seconds === "number") return obj._seconds * 1000
  }
  return 0
}
function shortDate(raw: unknown): string {
  const ms = toMs(raw)
  if (!ms) return ""
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
function ageDays(raw: unknown): number {
  const ms = toMs(raw)
  if (!ms) return 0
  return Math.floor((Date.now() - ms) / 86_400_000)
}
function money(n: number): string {
  return "$" + n.toLocaleString("en-US")
}

// ---------- per-submission derived model ----------
type ConsentState = "confirmed" | "pending" | "failed" | "unknown"
function consentState(s: RecruiterSubmissionItem): ConsentState {
  const raw = (s.candidateConfirmation?.status ?? s.candidateConsentStatus ?? "").toLowerCase()
  if (raw.includes("confirm")) return "confirmed"
  if (raw.includes("fail") || raw.includes("error") || raw.includes("bounce")) return "failed"
  if (raw.includes("pend") || raw.includes("sent") || raw.includes("await")) return "pending"
  return raw ? "unknown" : "unknown"
}
function consentMeta(c: ConsentState): { label: string; tone: Tone } {
  if (c === "confirmed") return { label: "Candidate confirmed", tone: "success" }
  if (c === "pending") return { label: "Awaiting candidate OK", tone: "warn" }
  if (c === "failed") return { label: "Confirmation failed", tone: "danger" }
  return { label: "Consent", tone: "mute" }
}
function hasFeedback(s: RecruiterSubmissionItem): boolean {
  return Boolean(
    (s.recruiterFeedbackNote && s.recruiterFeedbackNote.trim()) ||
    typeof s.recruiterFeedbackRating === "number" ||
    (s.recruiterFeedbackReasons && s.recruiterFeedbackReasons.length > 0),
  )
}
function lastRequestedInfo(s: RecruiterSubmissionItem): { message: string; at?: string } | null {
  const list = s.requestedInfo ?? []
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i]
    if (entry?.message?.trim()) return { message: entry.message.trim(), at: entry.at }
  }
  return null
}
type NeedsModel = { tone: Tone; body: string; cta: string; action: "resend" | "scroll_feedback" | "scroll_thread" | "ack" }
function needsModel(s: RecruiterSubmissionItem): NeedsModel | null {
  const consent = consentState(s)
  const firstName = (s.candidate?.name ?? "The candidate").split(" ")[0]
  if (consent === "pending" || consent === "failed") {
    return {
      tone: "warn",
      body: `${firstName} hasn't confirmed yet. Candidates confirm before WeKruit reviews — resend the confirmation so this can start moving.`,
      cta: "Resend confirmation",
      action: "resend",
    }
  }
  const requested = lastRequestedInfo(s)
  if (requested && ACTIVE_STATUSES.concat("wekruit_interview").includes(s.status ?? "submitted")) {
    return {
      tone: "warn",
      body: `WeKruit asked for more info: “${requested.message}”`,
      cta: "Reply below",
      action: "scroll_thread",
    }
  }
  if (s.status === "rejected" && hasFeedback(s)) {
    return {
      tone: "danger",
      body: "This one didn't move forward. Read the feedback below and apply it before sourcing similar candidates.",
      cta: "Jump to feedback",
      action: "scroll_feedback",
    }
  }
  const days = ageDays(s.createdAt)
  if (ACTIVE_STATUSES.includes(s.status ?? "submitted") && consent === "confirmed" && days >= 4) {
    return {
      tone: "info",
      body: `This review has been open ${days} days. Hold more lookalikes until WeKruit gives a clearer signal.`,
      cta: "Got it",
      action: "ack",
    }
  }
  return null
}
function needsYou(s: RecruiterSubmissionItem): boolean {
  return needsModel(s) !== null
}

// ---------- payout ----------
function payoutModel(s: RecruiterSubmissionItem): {
  show: boolean
  header: string
  body: string
  bonusLabel: string | null
} {
  const payout = s.recruiterPayout
  const reachedInterview = ADVANCED_STATUSES.includes(s.status ?? "")
  const bonusLabel = reachedInterview ? "$50 interview bonus" : null
  if (payout && typeof payout.amount === "number" && payout.amount > 0) {
    const amount = money(payout.amount)
    const state = (payout.status ?? "").toLowerCase()
    const stateLabel = state === "paid" ? "paid" : state || "recorded"
    return {
      show: true,
      header: `${amount} · ${stateLabel}`,
      body: payout.note?.trim() || `WeKruit recorded a ${amount} payout on this submission (${stateLabel}).`,
      bonusLabel,
    }
  }
  if (s.status === "hired") {
    return {
      show: true,
      header: "Placement won",
      body: "Placement fee per the role terms releases in three installments after the start date. WeKruit will record the payout here.",
      bonusLabel,
    }
  }
  if (reachedInterview) {
    return {
      show: true,
      header: "In flight",
      body: "Cleared the WeKruit interview — the $50 interview bonus stands, and the placement fee releases after hire.",
      bonusLabel,
    }
  }
  if (s.status === "rejected") {
    return { show: false, header: "", body: "", bonusLabel: null }
  }
  return {
    show: true,
    header: "Earning unlocks at the WeKruit interview",
    body: "A $50 bonus at the WeKruit interview, then the placement fee paid in three installments after hire.",
    bonusLabel: null,
  }
}

// ---------- stepper ----------
function buildSteps(s: RecruiterSubmissionItem) {
  const sm = statusMeta(s.status)
  const cur = sm.step
  const outcomeBad = s.status === "rejected"
  const labels = ["Submitted", "WeKruit interview", "With client", sm.step === 3 ? sm.label : "Outcome"]
  return labels.map((label, i) => {
    const done = i < cur
    const isCur = i === cur
    let dotBg = "#FFFFFF", dotBd = "#C9B69E", dotFg = "#B5A595", mark = String(i + 1)
    if (done) { dotBg = "#2D1A0A"; dotBd = "#2D1A0A"; dotFg = "#F5EDE3"; mark = "✓" }
    else if (isCur) {
      if (i === 3 && outcomeBad) { dotBg = "#9A3B2A"; dotBd = "#9A3B2A"; dotFg = "#F5EDE3"; mark = "✕" }
      else if (i === 3) { dotBg = "#4F6B3C"; dotBd = "#4F6B3C"; dotFg = "#F5EDE3"; mark = "✓" }
      else { dotBg = "#2D1A0A"; dotBd = "#2D1A0A"; dotFg = "#F5EDE3" }
    }
    return { label, mark, done, isCur, dotBg, dotBd, dotFg, lineLeftDone: i <= cur && i > 0, lineRightDone: i < cur }
  })
}

// ---------- icons ----------
const ICONS = {
  roles: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v5" /></svg>,
  subs: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3 8-8" /><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /></svg>,
  search: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#897462" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
  refresh: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v5h-5" /></svg>,
  chart: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>,
  close: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>,
  warn: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>,
  openExt: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 17 17 7M9 7h8v8" /></svg>,
  clock: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  send: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>,
  check: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9CC47E" strokeWidth="2.4"><path d="M20 6 9 17l-5-5" /></svg>,
  checkSm: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4F6B3C" strokeWidth="2.6"><path d="M20 6 9 17l-5-5" /></svg>,
  xSm: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9A3B2A" strokeWidth="2.6"><path d="M18 6 6 18M6 6l12 12" /></svg>,
  chevR: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B5A595" strokeWidth="2"><path d="m9 6 6 6-6 6" /></svg>,
  back: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>,
  plus: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>,
  chevD: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#897462" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>,
  bonus: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M20 6 9 17l-5-5" /></svg>,
}

type View = "submissions" | "roles" | "role"
type ListFilter = "all" | "needs" | "feedback" | "passed" | "submitted" | "review" | "interview" | "client" | "offer" | "hired"
type RoleFilter = "all" | "new"

export default function RecruiterWorkspace() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [inviteLink] = useState<RecruiterInviteLink | null>(readRecruiterInviteLinkFromLocation)
  const { session, authReady, profileLoadFailed, retryProfile, setSession } = useRecruiterSession()

  // data
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [submissions, setSubmissions] = useState<RecruiterSubmissionItem[]>([])
  const [sourcedCount, setSourcedCount] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // ui state
  const tabParam = searchParams.get("tab")
  const [view, setView] = useState<View>(tabParam === "submissions" ? "submissions" : tabParam === "roles" ? "roles" : "roles")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [filter, setFilter] = useState<ListFilter>("all")
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all")
  const [search, setSearch] = useState("")
  const [patternDismissed, setPatternDismissed] = useState(() => {
    try { return window.localStorage.getItem(PATTERN_DISMISS_KEY) === "1" } catch { return false }
  })
  const [emailOn, setEmailOn] = useState(true)
  const [emailSaving, setEmailSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // thread state (per selected submission)
  const [comments, setComments] = useState<RecruiterSubmissionComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [reply, setReply] = useState("")
  const [sending, setSending] = useState(false)
  const [composerError, setComposerError] = useState<string | null>(null)
  const [resending, setResending] = useState(false)
  const feedbackRef = useRef<HTMLDivElement | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)

  const flash = (text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }

  // invite-link persistence (same contract as RecruiterBoard)
  useEffect(() => {
    if (!inviteLink) return
    try {
      writePendingRecruiterAccess(inviteLink.code, "", inviteLink.emailHint || undefined)
    } catch { /* storage blocked; gate re-writes before sign-in */ }
    if (searchParams.has("code") || searchParams.has("email") || searchParams.has("invite")) {
      const next = new URLSearchParams(searchParams)
      next.delete("code")
      next.delete("email")
      next.delete("invite")
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteLink])

  // sync view → ?tab for shareable deep links (emails link ?tab=submissions)
  useEffect(() => {
    const want = view === "submissions" ? "submissions" : view === "roles" ? null : null
    const cur = searchParams.get("tab")
    if (want === cur) return
    const next = new URLSearchParams(searchParams)
    if (want) next.set("tab", want)
    else next.delete("tab")
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  useEffect(() => {
    fetchCollabJobs()
      .then(setJobs)
      .catch((e) => setLoadError(String(e?.message ?? e)))
  }, [])

  useEffect(() => {
    if (!session) {
      setSubmissions([])
      setSourcedCount(0)
      setLoaded(false)
      return
    }
    setEmailOn(session.recruiter.notificationPreferences?.submissionUpdatesEmail !== false)
    void reloadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.recruiterId])

  const reloadAll = async () => {
    if (!session) return
    try {
      setLoadError(null)
      const [subs, sourced] = await Promise.all([
        fetchRecruiterSubmissions(),
        fetchRecruiterSourcedCandidates(),
      ])
      const sorted = [...subs].sort((a, b) => toMs(b.updatedAt ?? b.createdAt) - toMs(a.updatedAt ?? a.createdAt))
      setSubmissions(sorted)
      setSourcedCount(sourced.length)
      setLoaded(true)
      setSelectedId((prev) => prev && sorted.some((s) => s.id === prev) ? prev : (sorted[0]?.id ?? null))
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
      setLoaded(true)
    }
  }

  // lazy comments per selection
  useEffect(() => {
    if (!selectedId || !session) { setComments([]); return }
    let active = true
    setCommentsLoading(true)
    fetchRecruiterSubmissionComments(selectedId)
      .then((rows) => { if (active) setComments(rows) })
      .catch(() => { if (active) setComments([]) })
      .finally(() => { if (active) setCommentsLoading(false) })
    return () => { active = false }
  }, [selectedId, session])

  // ---------- derived ----------
  const jobById = useMemo(() => {
    const map = new Map<string, CollabJob>()
    for (const j of jobs ?? []) map.set(j.jobId, j)
    return map
  }, [jobs])

  const needsCount = useMemo(() => submissions.filter(needsYou).length, [submissions])

  const funnelDefs: Array<{ id: ListFilter; label: string; tone: Tone; match: (s: RecruiterSubmissionItem) => boolean }> = [
    { id: "submitted", label: "Submitted", tone: "live", match: (s) => ["new", "submitted"].includes(s.status ?? "submitted") },
    { id: "review", label: "In review", tone: "info", match: (s) => ["reviewing", "backburner"].includes(s.status ?? "") },
    { id: "interview", label: "Interview", tone: "live", match: (s) => s.status === "wekruit_interview" },
    { id: "client", label: "With client", tone: "info", match: (s) => ["client_review", "interviewing"].includes(s.status ?? "") },
    { id: "offer", label: "Offer", tone: "success", match: (s) => ["advanced", "offer"].includes(s.status ?? "") },
    { id: "hired", label: "Hired", tone: "success", match: (s) => s.status === "hired" },
  ]

  const interviewsReached = submissions.filter((s) => ADVANCED_STATUSES.includes(s.status ?? "")).length
  const paidTotal = submissions.reduce((acc, s) => {
    const p = s.recruiterPayout
    if (p && typeof p.amount === "number" && (p.status ?? "").toLowerCase() === "paid") return acc + p.amount
    return acc
  }, 0)
  const scheduledTotal = submissions.reduce((acc, s) => {
    const p = s.recruiterPayout
    if (p && typeof p.amount === "number" && (p.status ?? "").toLowerCase() !== "paid") return acc + p.amount
    return acc
  }, 0)

  const patternChips = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of submissions) {
      if (s.status !== "rejected") continue
      for (const r of s.recruiterFeedbackReasons ?? []) {
        if (!reasonMeta(r).good) counts[r] = (counts[r] ?? 0) + 1
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([r, n]) => ({ label: reasonMeta(r).label, count: n }))
  }, [submissions])

  const visibleSubs = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matchers: Record<ListFilter, (s: RecruiterSubmissionItem) => boolean> = {
      all: () => true,
      needs: needsYou,
      feedback: hasFeedback,
      passed: (s) => s.status === "rejected",
      submitted: funnelDefs[0].match,
      review: funnelDefs[1].match,
      interview: funnelDefs[2].match,
      client: funnelDefs[3].match,
      offer: funnelDefs[4].match,
      hired: funnelDefs[5].match,
    }
    return submissions.filter(matchers[filter]).filter((s) => {
      if (!q) return true
      const job = jobById.get(s.jobId ?? "")
      const hay = [s.candidate?.name, s.candidate?.currentRole, s.jobTitleSnapshot, s.companyLabelSnapshot, job?.title, job?.recruiterBoard?.label?.company]
        .filter(Boolean).join(" ").toLowerCase()
      return hay.includes(q)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissions, filter, search, jobById])

  const selected = submissions.find((s) => s.id === selectedId) ?? visibleSubs[0] ?? submissions[0] ?? null

  // ---------- actions ----------
  const handleToggleEmail = async () => {
    if (emailSaving) return
    const next = !emailOn
    setEmailOn(next)
    setEmailSaving(true)
    try {
      await updateRecruiterPreferences({ notificationPreferences: { submissionUpdatesEmail: next } })
      flash(next ? "Email updates on" : "Email updates off")
    } catch {
      setEmailOn(!next)
      flash("Couldn't save the email preference")
    } finally {
      setEmailSaving(false)
    }
  }

  const handleSignOut = () => { void signOut(auth()).catch(() => undefined) }

  const handleResend = async (submissionId: string) => {
    if (resending) return
    setResending(true)
    try {
      await resendRecruiterCandidateConfirmation(submissionId)
      flash("Confirmation resent")
      await reloadAll()
    } catch (e) {
      flash(e instanceof Error ? e.message : "Resend failed")
    } finally {
      setResending(false)
    }
  }

  const handleNeedsAction = (s: RecruiterSubmissionItem, nm: NeedsModel) => {
    if (nm.action === "resend") { void handleResend(s.id); return }
    if (nm.action === "scroll_feedback") { feedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); return }
    if (nm.action === "scroll_thread") { threadRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); return }
    flash("Noted")
  }

  const handleSendReply = async () => {
    const text = reply.trim()
    if (!text || !selected || sending) return
    setSending(true)
    setComposerError(null)
    try {
      await addRecruiterSubmissionComment({ submissionId: selected.id, message: text })
      const rows = await fetchRecruiterSubmissionComments(selected.id)
      setComments(rows)
      setReply("")
      flash("Sent to WeKruit")
    } catch {
      setComposerError("Failed to send. Try again.")
    } finally {
      setSending(false)
    }
  }

  const dismissPatterns = () => {
    setPatternDismissed(true)
    try { window.localStorage.setItem(PATTERN_DISMISS_KEY, "1") } catch { /* */ }
  }

  const openRole = (jobId: string) => { setSelectedRoleId(jobId); setView("role") }
  const refresh = async () => { await reloadAll(); flash("Status refreshed") }

  // ---------- gate ----------
  if (!authReady) {
    return <div className="rw-root"><div className="rw-loading" style={{ gridColumn: "1 / -1", alignSelf: "center" }}>Loading recruiter workspace…</div></div>
  }
  if (!session) {
    if (profileLoadFailed) {
      return (
        <div className="rw-root">
          <div className="rw-error-state" style={{ gridColumn: "1 / -1", alignSelf: "center" }}>
            Couldn't load your recruiter profile. You're still signed in.
            <div style={{ marginTop: 12 }}>
              <button type="button" className="rw-refresh" onClick={retryProfile}>Retry</button>
            </div>
          </div>
        </div>
      )
    }
    return <RecruiterAccessGate inviteLink={inviteLink} onSessionClaimed={setSession} />
  }

  const recruiter = session.recruiter
  const initial = (recruiter.name || recruiter.email || "R").trim().charAt(0).toUpperCase()

  const titles: Record<View, { title: string; sub: string }> = {
    submissions: { title: "Submissions", sub: "Your candidates, status, and WeKruit feedback" },
    roles: { title: "Roles", sub: "Live WeKruit collab searches" },
    role: { title: "Role", sub: "Brief, screen, and submit" },
  }
  const t = titles[view]

  // roles view-model
  const roleFilterDefs: Array<{ id: RoleFilter; label: string; match: (j: CollabJob) => boolean }> = [
    { id: "all", label: "All roles", match: () => true },
    { id: "new", label: "New this week", match: (j) => Date.now() - toMs(j.updatedAt) < 7 * 86_400_000 },
  ]
  const q = search.trim().toLowerCase()
  const visibleRoles = (jobs ?? [])
    .filter((j) => j.recruiterBoard?.active !== false)
    .filter(roleFilterDefs.find((d) => d.id === roleFilter)?.match ?? (() => true))
    .filter((j) => !q || `${j.title} ${j.recruiterBoard?.label?.company ?? ""} ${j.recruiterBoard?.label?.location ?? ""}`.toLowerCase().includes(q))

  const selectedRole = selectedRoleId ? jobById.get(selectedRoleId) ?? null : null
  const roleSubs = selectedRole ? submissions.filter((s) => s.jobId === selectedRole.jobId) : []

  const interviewPct = Math.min(100, Math.round((interviewsReached / QUARTER_INTERVIEW_GOAL) * 100))
  const sourcedPct = Math.min(100, Math.round((sourcedCount / QUARTER_SOURCED_GOAL) * 100))

  return (
    <div className="rw-root">
      {/* ============ SIDEBAR ============ */}
      <aside className="rw-aside">
        <div className="rw-brand">
          <span className="rw-brand-mark">W</span>
          <span className="rw-brand-name">
            <strong>WeKruit</strong>
            <em>Recruiter</em>
          </span>
        </div>

        <nav className="rw-nav">
          <button
            type="button"
            className={`rw-nav-item ${view === "roles" || view === "role" ? "is-active" : ""}`}
            onClick={() => setView("roles")}
          >
            <span className="rw-nav-label"><span className="rw-nav-icon">{ICONS.roles}</span><span>Roles</span></span>
            <span className="rw-nav-count">{visibleRoles.length || (jobs?.length ?? 0)}</span>
          </button>
          <button
            type="button"
            className={`rw-nav-item ${view === "submissions" ? "is-active" : ""}`}
            onClick={() => setView("submissions")}
          >
            <span className="rw-nav-label"><span className="rw-nav-icon">{ICONS.subs}</span><span>Submissions</span></span>
            <span className={`rw-nav-count ${needsCount > 0 ? "is-warn" : ""}`}>{submissions.length}</span>
          </button>
        </nav>

        <div className="rw-aside-foot">
          <div className="rw-email-card">
            <span className="rw-email-card-copy">
              <strong>Email updates</strong>
              <em>Status &amp; feedback</em>
            </span>
            <button
              type="button"
              className={`rw-toggle ${emailOn ? "is-on" : ""}`}
              onClick={() => void handleToggleEmail()}
              aria-label="Toggle email updates"
              disabled={emailSaving}
            >
              <span className="rw-toggle-knob" />
            </button>
          </div>
          <div className="rw-user">
            <span className="rw-user-avatar">{initial}</span>
            <span className="rw-user-meta">
              <strong>{recruiter.name || "Recruiter"}</strong>
              <em>{recruiter.email}</em>
            </span>
          </div>
          <Link to="/recruiters/jobs" className="rw-signout" style={{ textDecoration: "none", textAlign: "center" }}>Browse open roles</Link>
          <button type="button" className="rw-signout" onClick={handleSignOut}>Sign out</button>
        </div>
      </aside>

      {/* ============ MAIN ============ */}
      <main className="rw-main">
        <header className="rw-header">
          <div className="rw-header-titles">
            <h1>{t.title}</h1>
            <span className="rw-header-sub">{t.sub}</span>
          </div>
          <div className="rw-header-actions">
            <div className="rw-search">
              {ICONS.search}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={view === "roles" || view === "role" ? "Search roles…" : "Search candidates…"}
                autoComplete="off"
              />
            </div>
            <button type="button" className="rw-refresh" onClick={() => void refresh()}>
              {ICONS.refresh}
              Refresh
            </button>
          </div>
        </header>

        <div className="rw-body rw-sc">
          {loadError && <div className="rw-inline-error" style={{ maxWidth: 1180, marginBottom: 14 }}>{loadError}</div>}

          {/* ====================== SUBMISSIONS ====================== */}
          {view === "submissions" && (
            <div className="rw-view">
              {/* summary */}
              <section className="rw-summary">
                <div className="rw-summary-goal">
                  <span className="rw-kicker">Quarter goal</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div className="rw-goal-num">
                      <strong>{interviewsReached}</strong>
                      <span className="rw-goal-of">/ {QUARTER_INTERVIEW_GOAL}</span>
                      <span className="rw-goal-label">interviews</span>
                    </div>
                    <div className="rw-bar"><span style={{ width: `${interviewPct}%` }} /></div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div className="rw-goal-row">
                      <span>Sourced candidates</span>
                      <span>{sourcedCount} / {QUARTER_SOURCED_GOAL}</span>
                    </div>
                    <div className="rw-bar is-green is-thin"><span style={{ width: `${sourcedPct}%` }} /></div>
                  </div>
                </div>
                <div className="rw-summary-pipe">
                  <div className="rw-pipe-head">
                    <span className="rw-kicker">Pipeline this quarter</span>
                    {needsCount > 0 && (
                      <button type="button" className="rw-needs-btn" onClick={() => setFilter("needs")}>
                        <span className="rw-needs-dot" />{needsCount} need you
                      </button>
                    )}
                  </div>
                  <div className="rw-funnel">
                    {funnelDefs.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className={`rw-stage ${filter === f.id ? "is-active" : ""}`}
                        onClick={() => setFilter(filter === f.id ? "all" : f.id)}
                      >
                        <strong style={{ color: TONE[f.tone].fg }}>{submissions.filter(f.match).length}</strong>
                        <span>{f.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="rw-summary-foot">
                    {paidTotal > 0 && <span>Earnings <strong>{money(paidTotal)}</strong> paid</span>}
                    {paidTotal > 0 && scheduledTotal > 0 && <span>·</span>}
                    {scheduledTotal > 0 && <span>Next payouts <strong className="is-green">{money(scheduledTotal)}</strong> scheduled</span>}
                    <span className="rw-foot-terms">$50 / interview · placement fee per role, paid in 3</span>
                  </div>
                </div>
              </section>

              {/* feedback patterns */}
              {!patternDismissed && patternChips.length > 0 && (
                <section className="rw-patterns">
                  <span className="rw-patterns-icon">{ICONS.chart}</span>
                  <div className="rw-patterns-body">
                    <strong>Across your submissions, here's why candidates didn't move forward:</strong>
                    <div className="rw-patterns-chips">
                      {patternChips.map((c) => (
                        <span key={c.label} className="rw-pattern-chip">{c.label}<em>{c.count}</em></span>
                      ))}
                      <span className="rw-patterns-advice">
                        {patternChips[0].count >= 2
                          ? `${patternChips[0].label} is your top blocker — screen for it before you submit.`
                          : "Screen for these earlier to clear review faster."}
                      </span>
                    </div>
                  </div>
                  <button type="button" className="rw-patterns-dismiss" aria-label="Dismiss" onClick={dismissPatterns}>
                    {ICONS.close}
                  </button>
                </section>
              )}

              {/* master-detail */}
              <div className="rw-md">
                {/* list */}
                <section className="rw-list">
                  <div className="rw-filters rw-sc">
                    {([
                      { id: "all" as ListFilter, label: "All", count: submissions.length },
                      { id: "needs" as ListFilter, label: "Needs you", count: needsCount },
                      { id: "feedback" as ListFilter, label: "Has feedback", count: submissions.filter(hasFeedback).length },
                      { id: "passed" as ListFilter, label: "Not moving forward", count: submissions.filter((s) => s.status === "rejected").length },
                    ]).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className={`rw-filter ${filter === f.id ? "is-active" : ""}`}
                        onClick={() => setFilter(f.id)}
                      >
                        {f.label}<em>{f.count}</em>
                      </button>
                    ))}
                  </div>
                  <div className="rw-list-scroll rw-sc">
                    {visibleSubs.map((s) => {
                      const job = jobById.get(s.jobId ?? "")
                      const sm = statusMeta(s.status)
                      const rating = typeof s.recruiterFeedbackRating === "number" ? s.recruiterFeedbackRating : null
                      const ratingTone: Tone = rating == null ? "mute" : rating >= 3 ? "success" : rating === 2 ? "warn" : "danger"
                      const code = job?.recruiterBoard?.label?.companyCode || (s.companyLabelSnapshot ?? "—").slice(0, 2).toUpperCase()
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className={`rw-row ${selected?.id === s.id ? "is-selected" : ""}`}
                          onClick={() => setSelectedId(s.id)}
                        >
                          <span className="rw-row-top">
                            <span className="rw-row-name">
                              <strong>{s.candidate?.name ?? "Candidate"}</strong>
                              {needsYou(s) && <span className="rw-row-needs-dot" />}
                            </span>
                            <span style={pillStyle(sm.tone)}>{sm.label}</span>
                          </span>
                          <span className="rw-row-sub">{s.candidate?.currentRole ?? s.candidate?.currentCompany ?? ""}</span>
                          <span className="rw-row-bottom">
                            <span className="rw-row-role">
                              <span className="rw-role-code">{code}</span>
                              <span>{s.jobTitleSnapshot ?? job?.title ?? "—"}</span>
                            </span>
                            {rating != null && (
                              <span style={{
                                fontStyle: "normal", fontSize: 11, fontWeight: 700, padding: "1px 7px",
                                borderRadius: 6, background: TONE[ratingTone].bg, color: TONE[ratingTone].fg,
                              }}>{rating}/4</span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                    {loaded && visibleSubs.length === 0 && (
                      <p className="rw-empty">
                        {submissions.length === 0
                          ? "No submissions yet. Open a role and submit your first candidate."
                          : "No submissions match this filter."}
                      </p>
                    )}
                    {!loaded && <p className="rw-empty">Loading…</p>}
                  </div>
                </section>

                {/* detail */}
                {selected ? (
                  <DetailPane
                    submission={selected}
                    job={jobById.get(selected.jobId ?? "") ?? null}
                    comments={comments}
                    commentsLoading={commentsLoading}
                    reply={reply}
                    onReply={setReply}
                    onSend={() => void handleSendReply()}
                    sending={sending}
                    composerError={composerError}
                    resending={resending}
                    onNeedsAction={handleNeedsAction}
                    onOpenRole={openRole}
                    feedbackRef={feedbackRef}
                    threadRef={threadRef}
                  />
                ) : (
                  <section className="rw-detail">
                    <div className="rw-empty" style={{ padding: "80px 20px" }}>
                      {loaded ? "Select a submission to see its status and feedback." : "Loading…"}
                    </div>
                  </section>
                )}
              </div>
            </div>
          )}

          {/* ====================== ROLES ====================== */}
          {view === "roles" && (
            <div className="rw-view">
              <section className="rw-role-filters">
                {roleFilterDefs.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={`rw-role-filter ${roleFilter === d.id ? "is-active" : ""}`}
                    onClick={() => setRoleFilter(d.id)}
                  >
                    {d.label}<em>{(jobs ?? []).filter((j) => j.recruiterBoard?.active !== false).filter(d.match).length}</em>
                  </button>
                ))}
              </section>
              <section className="rw-roles">
                {visibleRoles.map((j) => {
                  const label = j.recruiterBoard?.label
                  const isNew = Date.now() - toMs(j.updatedAt) < 7 * 86_400_000
                  const subCount = submissions.filter((s) => s.jobId === j.jobId).length
                  return (
                    <button key={j.jobId} type="button" className="rw-role-card" onClick={() => openRole(j.jobId)}>
                      <span className="rw-role-card-code">{label?.companyCode || j.title.slice(0, 2).toUpperCase()}</span>
                      <span className="rw-role-card-main">
                        <span className="rw-role-card-title">
                          <strong>{j.title}</strong>
                          <span style={pillStyle("success")}>Open</span>
                          {isNew && <span style={pillStyle("live")}>New</span>}
                        </span>
                        <span className="rw-role-card-meta">
                          {[label?.company, label?.location, j.compSummary].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <span className="rw-role-card-fee">
                        <strong>Placement fee</strong>
                        <em>paid in 3 · +$50 / interview</em>
                      </span>
                      <span className="rw-role-card-end">
                        <span className="rw-role-card-count">
                          <strong>{subCount}</strong>
                          <em>yours</em>
                        </span>
                        {ICONS.chevR}
                      </span>
                    </button>
                  )
                })}
                {jobs && visibleRoles.length === 0 && <p className="rw-empty">No roles match this filter.</p>}
                {!jobs && <p className="rw-empty">Loading roles…</p>}
              </section>
            </div>
          )}

          {/* ====================== ROLE DETAIL ====================== */}
          {view === "role" && selectedRole && (
            <div className="rw-view" style={{ maxWidth: 1000 }}>
              <button type="button" className="rw-back" onClick={() => setView("roles")}>
                {ICONS.back}
                All roles
              </button>

              <section className="rw-role-hero">
                <span className="rw-role-hero-code">{selectedRole.recruiterBoard?.label?.companyCode || selectedRole.title.slice(0, 2).toUpperCase()}</span>
                <div className="rw-role-hero-main">
                  <div className="rw-role-hero-top">
                    <div>
                      <h2>{selectedRole.title}</h2>
                      <p className="rw-role-hero-meta">
                        {[selectedRole.recruiterBoard?.label?.company, selectedRole.recruiterBoard?.label?.location].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <Link to={`/recruiters/job/${selectedRole.jobId}`} className="rw-submit-btn">
                      {ICONS.plus}
                      Submit a candidate
                    </Link>
                  </div>
                  <div className="rw-role-stats">
                    {selectedRole.compSummary && (
                      <span className="rw-role-stat"><em>Compensation</em><strong>{selectedRole.compSummary}</strong></span>
                    )}
                    <span className="rw-role-stat"><em>Placement fee</em><strong className="is-green">Per role terms · paid in 3</strong></span>
                    <span className="rw-role-stat"><em>Your submissions</em><strong>{roleSubs.length}</strong></span>
                  </div>
                </div>
              </section>

              <div className="rw-role-cols">
                <section className="rw-panel">
                  <h3>What WeKruit screens for</h3>
                  <div className="rw-screen-rows">
                    {(selectedRole.recruiterBoard?.checklist?.groups ?? []).flatMap((g) =>
                      g.items.map((item) => {
                        const toneMap: Record<string, Tone> = { hard: "danger", fit: "info", bonus: "success", anti: "mute" }
                        const labelMap: Record<string, string> = { hard: "Hard", fit: "Fit", bonus: "Bonus", anti: "Anti" }
                        const tone = toneMap[g.kind] ?? "mute"
                        return (
                          <div key={item.id} className="rw-screen-row">
                            <span className="rw-screen-chip" style={{ background: TONE[tone].bg, color: TONE[tone].fg }}>
                              {labelMap[g.kind] ?? g.kind}
                            </span>
                            <span>{item.text}</span>
                          </div>
                        )
                      }),
                    )}
                    {(selectedRole.recruiterBoard?.checklist?.groups ?? []).length === 0 && (
                      <p className="rw-empty" style={{ padding: "12px 0" }}>Screening checklist coming soon.</p>
                    )}
                  </div>
                  {selectedRole.jdBlocks.length > 0 && (
                    <details className="rw-jd">
                      <summary>Full job description{ICONS.chevD}</summary>
                      <div className="rw-jd-body">
                        {selectedRole.jdBlocks.map((b, i) => (
                          <div key={i} style={{ margin: i === 0 ? "12px 0 0" : "10px 0 0" }}>
                            {b.heading ? <strong style={{ display: "block", marginBottom: 2 }}>{b.heading}</strong> : null}
                            {typeof b.body === "string" && b.body.trim() ? <p style={{ margin: 0 }}>{b.body}</p> : null}
                            {b.items && b.items.length > 0 && (
                              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                                {b.items.map((item, j) => <li key={j}>{item}</li>)}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </section>

                <section className="rw-panel">
                  <h3>Your submissions for this role</h3>
                  <div className="rw-role-subs">
                    {roleSubs.map((s) => {
                      const sm = statusMeta(s.status)
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className="rw-role-sub"
                          onClick={() => { setSelectedId(s.id); setView("submissions") }}
                        >
                          <span className="rw-role-sub-meta">
                            <strong>{s.candidate?.name ?? "Candidate"}</strong>
                            <em>{s.candidate?.currentRole ?? ""}</em>
                          </span>
                          <span style={pillStyle(sm.tone)}>{sm.label}</span>
                        </button>
                      )
                    })}
                    {roleSubs.length === 0 && (
                      <p className="rw-role-subs-empty">No submissions yet. You'll see candidate ownership and status here once you submit.</p>
                    )}
                  </div>
                </section>
              </div>
            </div>
          )}

          {view === "role" && !selectedRole && (
            <div className="rw-view">
              <button type="button" className="rw-back" onClick={() => setView("roles")}>
                {ICONS.back}
                All roles
              </button>
              <p className="rw-empty">Role not found.</p>
            </div>
          )}
        </div>

        {toast && (
          <div className="rw-toast">
            {ICONS.check}
            {toast}
          </div>
        )}
      </main>
    </div>
  )
}

// ============ detail pane ============
function DetailPane({
  submission: s,
  job,
  comments,
  commentsLoading,
  reply,
  onReply,
  onSend,
  sending,
  composerError,
  resending,
  onNeedsAction,
  onOpenRole,
  feedbackRef,
  threadRef,
}: {
  submission: RecruiterSubmissionItem
  job: CollabJob | null
  comments: RecruiterSubmissionComment[]
  commentsLoading: boolean
  reply: string
  onReply: (v: string) => void
  onSend: () => void
  sending: boolean
  composerError: string | null
  resending: boolean
  onNeedsAction: (s: RecruiterSubmissionItem, nm: NeedsModel) => void
  onOpenRole: (jobId: string) => void
  feedbackRef: React.RefObject<HTMLDivElement | null>
  threadRef: React.RefObject<HTMLDivElement | null>
}) {
  const sm = statusMeta(s.status)
  const consent = consentMeta(consentState(s))
  const nm = needsModel(s)
  const steps = buildSteps(s)
  const fb = hasFeedback(s)
  const rating = typeof s.recruiterFeedbackRating === "number" ? s.recruiterFeedbackRating : null
  const ratingTone: Tone = rating == null ? "mute" : rating >= 3 ? "success" : rating === 2 ? "warn" : "danger"
  const reasons = s.recruiterFeedbackReasons ?? []
  const payout = payoutModel(s)
  const requested = lastRequestedInfo(s)
  const code = job?.recruiterBoard?.label?.companyCode || (s.companyLabelSnapshot ?? "—").slice(0, 2).toUpperCase()
  const timeline = [...(s.statusHistory ?? [])].reverse()
  const waiting = !fb && s.status !== "rejected"
  const consentPending = consentState(s) === "pending"

  return (
    <section className="rw-detail">
      <div className="rw-detail-head">
        <div className="rw-detail-head-top">
          <div style={{ minWidth: 0 }}>
            <h2>{s.candidate?.name ?? "Candidate"}</h2>
            <p className="rw-detail-head-sub">{s.candidate?.currentRole ?? s.candidate?.currentCompany ?? ""}</p>
          </div>
          <div className="rw-detail-pills">
            <span style={pillStyle(sm.tone)}>{sm.label}</span>
            <span style={pillStyle(consent.tone)}>{consent.label}</span>
          </div>
        </div>
        <div className="rw-role-bar">
          <span className="rw-role-code">{code}</span>
          <span className="rw-role-bar-title">{s.jobTitleSnapshot ?? job?.title ?? "—"}</span>
          <span className="rw-role-bar-co">· {s.companyLabelSnapshot ?? job?.recruiterBoard?.label?.company ?? ""}</span>
          {s.jobId && (
            <button type="button" className="rw-role-bar-open" onClick={() => s.jobId && onOpenRole(s.jobId)}>
              Open role
              {ICONS.openExt}
            </button>
          )}
        </div>
      </div>

      <div className="rw-detail-scroll rw-sc">
        {/* stepper */}
        <div className="rw-stepper">
          {steps.map((st, i) => (
            <div key={i} className="rw-step">
              <div className="rw-step-track">
                <span className={`rw-step-line ${i === 0 ? "is-edge" : st.lineLeftDone ? "is-done" : ""}`} />
                <span className="rw-step-dot" style={{ background: st.dotBg, borderColor: st.dotBd, color: st.dotFg }}>{st.mark}</span>
                <span className={`rw-step-line ${i === steps.length - 1 ? "is-edge" : st.lineRightDone ? "is-done" : ""}`} />
              </div>
              <span className={`rw-step-label ${st.isCur ? "is-active" : st.done ? "is-done" : ""}`}>{st.label}</span>
            </div>
          ))}
        </div>

        {/* needs-you */}
        {nm && (
          <div className="rw-needs" style={{ background: TONE[nm.tone].bg, color: TONE[nm.tone].fg, borderColor: TONE[nm.tone].bd }}>
            <span className="rw-needs-kicker">{ICONS.warn}Needs you</span>
            <p>{nm.body}</p>
            <button
              type="button"
              className="rw-needs-cta"
              style={{ background: TONE[nm.tone].fg }}
              disabled={nm.action === "resend" && resending}
              onClick={() => onNeedsAction(s, nm)}
            >
              {nm.action === "resend" && resending ? "Resending…" : nm.cta}
            </button>
          </div>
        )}

        {/* requested info */}
        {requested && (
          <div className="rw-requested">
            <strong>WeKruit asked</strong>
            <p>{requested.message}</p>
            {requested.at && <em>{shortDate(requested.at)}</em>}
          </div>
        )}

        {/* feedback */}
        {fb && (
          <div className="rw-card" ref={feedbackRef}>
            <div className="rw-card-head">
              <span className="rw-card-kicker">WeKruit feedback</span>
              <span className="rw-card-stamp">{shortDate(s.recruiterFeedbackUpdatedAt)}</span>
            </div>
            {rating != null && (
              <div className="rw-rating">
                <div className="rw-rating-num">
                  <strong style={{ color: TONE[ratingTone].fg }}>{rating}</strong>
                  <span>/4</span>
                </div>
                <div className="rw-rating-bars">
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} className="rw-rating-bar" style={i < rating ? { background: TONE[ratingTone].fg } : undefined} />
                  ))}
                </div>
                <span style={pillStyle(ratingTone)}>{rating >= 3 ? "Strong" : rating === 2 ? "Mixed" : "Weak"}</span>
              </div>
            )}
            {reasons.length > 0 && (
              <div className="rw-reasons">
                {reasons.map((r) => {
                  const meta = reasonMeta(r)
                  const tone: Tone = meta.good ? "success" : "danger"
                  return (
                    <span key={r} style={{ ...pillStyle(tone), padding: "5px 11px", fontSize: 12 }}>
                      {meta.good ? ICONS.checkSm : ICONS.xSm}{meta.label}
                    </span>
                  )
                })}
              </div>
            )}
            {s.recruiterFeedbackNote?.trim() && <p className="rw-note">“{s.recruiterFeedbackNote.trim()}”</p>}
          </div>
        )}

        {/* payout */}
        {payout.show && (
          <div className="rw-card" style={{ gap: 12, padding: "16px 18px" }}>
            <div className="rw-card-head">
              <span className="rw-card-kicker">Your earnings</span>
              <span className="rw-payout-fee">{payout.header}</span>
            </div>
            <p className="rw-payout-body">{payout.body}</p>
            {payout.bonusLabel && (
              <span className="rw-bonus-chip">{ICONS.bonus}{payout.bonusLabel}</span>
            )}
          </div>
        )}

        {/* waiting */}
        {waiting && (
          <div className="rw-waiting">
            <span className="rw-waiting-icon">{ICONS.clock}</span>
            <div>
              <strong>{consentPending ? "Waiting on candidate confirmation" : "In WeKruit review"}</strong>
              <p>
                {consentPending
                  ? "WeKruit reviews once the candidate confirms. Feedback with a rating and reasons lands here after review."
                  : "WeKruit is reviewing this packet. A rating, reasons, and a clear next step will appear here when it's done."}
              </p>
            </div>
          </div>
        )}

        {/* thread */}
        <div className="rw-thread" ref={threadRef}>
          <span className="rw-card-kicker">Ask WeKruit</span>
          <div className="rw-thread-list">
            {comments.map((c, i) => {
              const mine = c.by === "recruiter"
              return (
                <div key={i} className={`rw-msg ${mine ? "is-mine" : ""}`}>
                  <div className="rw-msg-bubble">
                    <span className="rw-msg-who">{mine ? "You" : "WeKruit"}</span>
                    <p>{c.message}</p>
                  </div>
                  <em className="rw-msg-stamp">{shortDate(c.at)}</em>
                </div>
              )
            })}
            {!commentsLoading && comments.length === 0 && (
              <p className="rw-thread-empty">No questions yet. Ask WeKruit anything about this candidate or the feedback.</p>
            )}
            {commentsLoading && <p className="rw-thread-empty">Loading thread…</p>}
          </div>
          {composerError && <p className="rw-composer-error">{composerError}</p>}
          <div className="rw-composer">
            <textarea
              value={reply}
              onChange={(e) => onReply(e.target.value)}
              placeholder="Ask a clarifying question…"
              rows={1}
              className="rw-sc"
            />
            <button type="button" onClick={onSend} disabled={sending || !reply.trim()}>
              {sending ? "Sending…" : "Send"}
              {ICONS.send}
            </button>
          </div>
        </div>

        {/* timeline */}
        {timeline.length > 0 && (
          <div className="rw-timeline">
            <span className="rw-card-kicker">Activity</span>
            <div className="rw-timeline-items">
              {timeline.map((e, i) => {
                const em = statusMeta(e.status)
                return (
                  <div key={i} className="rw-tl-item">
                    <div className="rw-tl-rail">
                      <span className="rw-tl-dot" style={{ background: TONE[em.tone].fg }} />
                      <span className={`rw-tl-line ${i === timeline.length - 1 ? "is-last" : ""}`} />
                    </div>
                    <div className="rw-tl-body">
                      <div className="rw-tl-head">
                        <strong>{em.label}</strong>
                        <em>{shortDate(e.atIso)}</em>
                      </div>
                      {e.note?.trim() && <p>{e.note.trim()}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
