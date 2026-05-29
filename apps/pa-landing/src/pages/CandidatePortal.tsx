/**
 * CandidatePortal.tsx — `/me` (CandidateMe) and `/me/profile` (CandidateProfile).
 *
 * v2 redesign (Claude Design 2026-05-20 bundle):
 *  - `/me` = candidate operating center. Status header → Up next → Stage bar +
 *    pipeline rows → New matches inbox → sidebar (profile card + connectors +
 *    "This week with Claire").
 *  - `/me/profile` = full-edit profile surface with the same data the sidebar
 *    pitches; signed-in app bar (Pipeline · Profile · Market) so the user is
 *    never bounced back to marketing chrome.
 *
 * Real-data integration is unchanged:
 *  - paCandidateClaimProfile → CandidateSelfProfile (displayName, masked PII,
 *    globalTags, linkedinUrl, latestResumeArtifactId, handles).
 *  - paCandidateListMatches → CandidateMatchCard[] (status, job, whyMatched).
 *  - paCandidateProfileCorrection / paCandidatePrivacyRequest callables.
 *  Sections without backing data (years-of-experience, current role, salary
 *  floor, visa, Claire-this-week stats) are hidden or derived from what we have
 *  rather than mocked — they will light up as the backend grows.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { Link, useNavigate } from "react-router-dom"
import { onAuthStateChanged, signOut, type User } from "firebase/auth"
import { clearSsoCookie } from "../lib/cross-domain-sso.js"
import { httpsCallable } from "firebase/functions"
import { doc, getFirestore, onSnapshot } from "firebase/firestore"
import { auth, functions } from "../lib/firebase.js"
import { mergePortalCache, readPortalCache } from "../lib/portal-cache.js"
import {
  createCandidateProfileCorrectionSubmitter,
  type CandidateSelfProfile,
} from "../lib/candidate-profile-correction.js"
import {
  createCandidatePrivacyRequestSubmitter,
  type CandidatePrivacyRequestKind,
} from "../lib/candidate-privacy-request.js"
import {
  getCandidateJobStatusDisplay,
  type CandidateJobStatus,
} from "../lib/candidate-job-status.js"
import { GLOBAL_UID_KEY, readStoredValue } from "../lib/browser-identity"
import { useCandidatePortalGate } from "../lib/candidate-portal-gate.js"
import {
  CandidateShell,
  Avatar,
  CompanyMark,
  Icon,
  PulseDot,
} from "./CandidateLogin.js"

const LOGO_BG_POOL = [
  "#2A1812", "#0F1B2D", "#5E6AD2", "#635BFF", "#0D0D0D", "#1A1A1A", "#374151", "#7C2D12",
]
const TONE_POOL: Array<"warm" | "moss" | "slate"> = ["warm", "slate", "moss"]

function djb2(s: string): number {
  let h = 5381 >>> 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0
  return h
}

// ────────────────────────────────────────────────────────────────────────────
// useClaimedProfile — paCandidateClaimProfile callable wrapper
// ────────────────────────────────────────────────────────────────────────────

interface CandidateClaimResult {
  ok: true
  candidateId: string
  selfProfile: CandidateSelfProfile
  idempotent: boolean
}

type ClaimState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "ready"; user: User; profile: CandidateSelfProfile }
  | { status: "error"; message: string }

export function useClaimedProfile(): ClaimState {
  const [state, setState] = useState<ClaimState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    // Firestore live-update unsubscribe handle; recreated on claim success.
    let unsubSnapshot: (() => void) | null = null

    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      // Reset prior listener on auth change.
      if (unsubSnapshot) {
        unsubSnapshot()
        unsubSnapshot = null
      }
      if (!user) {
        setState({ status: "signed_out" })
        return
      }

      // Optimistic: hydrate from localStorage cache if we have both
      // candidateId + selfProfile for this uid. UI paints immediately;
      // the claim callable runs in the background to invalidate.
      const cached = readPortalCache(user.uid)
      if (cached?.candidateId && cached?.selfProfile) {
        setState({ status: "ready", user, profile: cached.selfProfile })
        attachSnapshot(cached.candidateId)
      } else {
        setState({ status: "loading" })
      }

      // Background callable — confirm + refresh.
      void (async () => {
        try {
          const claimProfile = httpsCallable<{ browserUid?: string | null }, CandidateClaimResult>(
            functions(),
            "paCandidateClaimProfile",
          )
          const browserUid = readStoredValue(GLOBAL_UID_KEY)
          const result = await claimProfile({ browserUid })
          if (cancelled) return
          mergePortalCache(user.uid, {
            candidateId: result.data.candidateId,
            selfProfile: result.data.selfProfile,
          })
          setState({ status: "ready", user, profile: result.data.selfProfile })
          // (Re)attach snapshot listener to the now-known candidateId.
          attachSnapshot(result.data.candidateId)
        } catch (err) {
          if (cancelled) return
          // Don't override optimistic-ready render on transient failure.
          if (cached?.selfProfile) {
            console.warn("candidate profile background refresh failed", err)
            return
          }
          console.error("candidate profile claim failed", err)
          setState({ status: "error", message: profileLoadErrorMessage(err) })
        }
      })()

      // Live updates: pa-candidate-self-profiles/{candidateId} read rule
      // permits the mapped candidate. Real-time = no callable poll needed.
      // Capture user.uid into closure-local const (User can churn).
      const capturedUid = user.uid
      function attachSnapshot(candidateId: string) {
        if (unsubSnapshot) unsubSnapshot()
        unsubSnapshot = onSnapshot(
          doc(getFirestore(), "pa-candidate-self-profiles", candidateId),
          (snap) => {
            if (cancelled) return
            if (!snap.exists()) return
            const fresh = snap.data() as CandidateSelfProfile
            mergePortalCache(capturedUid, { selfProfile: fresh })
            setState((prev) => {
              if (prev.status === "ready") return { status: "ready", user: prev.user, profile: fresh }
              return prev
            })
          },
          (err) => {
            // Listener failure is non-fatal — callable already populated us.
            console.warn("candidate self-profile snapshot failed", err)
          },
        )
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
      if (unsubSnapshot) unsubSnapshot()
    }
  }, [])

  return state
}

function profileLoadErrorMessage(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : ""
  const raw = err instanceof Error ? err.message : String(err)
  if (code === "functions/unauthenticated" || /unauthenticated|sign in/i.test(raw)) {
    return "Your session expired. Sign in again to load your WeKruit profile."
  }
  if (code === "functions/failed-precondition" || /failed-precondition|operator review|conflict/i.test(raw)) {
    return "We need to review this profile before showing it here."
  }
  if (
    code === "functions/internal" ||
    code === "functions/unavailable" ||
    raw === "internal" ||
    /network|fetch|cors|503|429/i.test(raw)
  ) {
    return "Profile is temporarily unavailable. Refresh in a moment — we'll retry."
  }
  return "We could not load your profile just now. Refresh the page, or sign in again if this keeps happening."
}

// ────────────────────────────────────────────────────────────────────────────
// useCandidateMatches — paCandidateListMatches callable wrapper
// ────────────────────────────────────────────────────────────────────────────

export type CandidateReviewDecision = {
  candidateMessageBody: string
  decisionReason: string
  recommendedActions: string[]
  finalTerminal: "PASS" | "FAIL" | "HARD_STOP"
  reviewedAt: string
}

export type CandidateMatchCard = {
  matchId: string
  jobId: string
  bucket: "recommended" | "invited"
  status: CandidateJobStatus
  job: {
    title: string
    company: string
    location?: string
    salaryRange?: string
    href: string
  }
  whyMatched: string[]
  rank?: number
  computedAt: string
  reviewDecision?: CandidateReviewDecision
}

type CandidateMatchesResult = {
  ok: true
  candidateId: string
  generatedAt: string
  matches: CandidateMatchCard[]
}

type MatchesState =
  | { status: "idle" | "loading" }
  | { status: "ready"; matches: CandidateMatchCard[] }
  | { status: "error"; message: string }

export function useCandidateMatches(enabled: boolean): MatchesState {
  const [state, setState] = useState<MatchesState>({ status: "idle" })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState({ status: "loading" })
    void (async () => {
      try {
        const listMatches = httpsCallable<{ limit: number }, CandidateMatchesResult>(
          functions(),
          "paCandidateListMatches",
        )
        const result = await listMatches({ limit: 25 })
        if (!cancelled) setState({ status: "ready", matches: result.data.matches })
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: matchesLoadErrorMessage(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  return state
}

// Translate raw Firebase callable errors (FirebaseError.code like
// "functions/internal", "functions/unauthenticated", network/CORS failures)
// into copy a candidate can act on. Default leans transient: a brief retry is
// the most useful prompt for the user, and matches are reloaded on next /me
// visit anyway.
function matchesLoadErrorMessage(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : ""
  const rawMessage = err instanceof Error ? err.message : String(err)
  if (code === "functions/unauthenticated" || /unauthenticated/i.test(rawMessage)) {
    return "Your session expired. Sign in again to see your matches."
  }
  if (code === "functions/failed-precondition" || /failed-precondition/i.test(rawMessage)) {
    return "We need to finish setting up your profile before matches show. Open Profile to fill in the basics."
  }
  if (code === "functions/permission-denied" || /permission-denied/i.test(rawMessage)) {
    return "This account isn't authorized to view matches."
  }
  if (code === "functions/deadline-exceeded" || /timeout|deadline/i.test(rawMessage)) {
    return "Matches took too long to load. Refresh in a moment."
  }
  if (
    code === "functions/internal" ||
    code === "functions/unavailable" ||
    rawMessage === "internal" ||
    /network|fetch|cors|503|429/i.test(rawMessage)
  ) {
    return "Matches are temporarily unavailable. We'll keep retrying — try refreshing in a moment."
  }
  return "We couldn't load your matches just now. Refresh the page, or sign in again if this keeps happening."
}

// Generic translator for callable mutations (corrections, privacy requests).
// Keeps the validation pre-check messages (server-side throws with specific
// detail) but humanizes the generic "internal" placeholder.
function callableSubmitErrorMessage(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : ""
  const raw = err instanceof Error ? err.message : String(err)
  if (code === "functions/unauthenticated") return "Sign in again to submit this."
  if (code === "functions/failed-precondition") return raw || "We can't submit this right now."
  if (code === "functions/invalid-argument") return raw || "Please review the form and try again."
  if (
    code === "functions/internal" ||
    code === "functions/unavailable" ||
    raw === "internal" ||
    /network|fetch|cors|503|429/i.test(raw)
  ) {
    return "Submit failed — service is briefly unavailable. Try again in a moment."
  }
  return raw || "Something went wrong submitting that. Try again."
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers — humanize canonical-tag tokens, derive sidebar data from schema
// ────────────────────────────────────────────────────────────────────────────

export function formatProfileValue(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function formatProfileStatus(value: string) {
  if (value === "claimed") return "Signed in and verified"
  if (value === "prospect") return "Profile created"
  return formatProfileValue(value)
}

function firstNameOf(profile: CandidateSelfProfile): string {
  const raw = profile.displayName?.trim() ?? ""
  if (!raw) return ""
  return raw.split(/\s+/)[0]
}

function deriveHeadline(profile: CandidateSelfProfile): string | null {
  const tags = profile.globalTags
  const role = tags?.roleFunction?.[0]
  const industry = tags?.industrySector?.[0]
  if (role && industry) return `${formatProfileValue(role)} · ${formatProfileValue(industry)}`
  if (role) return formatProfileValue(role)
  if (profile.profileSummary && profile.profileSummary.length < 90) return profile.profileSummary
  return null
}

function joinTags(values: string[] | undefined, max = 3, sep = " · "): string {
  if (!values || values.length === 0) return ""
  return values.slice(0, max).map(formatProfileValue).join(sep)
}

type ConnectorRow = {
  id: string
  label: string
  meta: string
  connected: boolean
  brand: string
  letter: string
}

function deriveConnectors(profile: CandidateSelfProfile): ConnectorRow[] {
  const hasHandle = (kind: string) =>
    profile.handles?.some((h) => h.kind === kind && h.verifiedAt) ?? false
  const phoneVerified = !!profile.phoneMasked || hasHandle("phone")
  const emailVerified = !!profile.emailMasked || hasHandle("email")
  return [
    {
      id: "resume",
      label: "Resume",
      meta: profile.latestResumeArtifactId ? "PDF on file" : "Send Claire a PDF on iMessage",
      connected: !!profile.latestResumeArtifactId,
      brand: "#2D1A0A",
      letter: "R",
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      meta: profile.linkedinUrl ? linkedinHandleFromUrl(profile.linkedinUrl) : "Not connected",
      connected: !!profile.linkedinUrl,
      brand: "#0A66C2",
      letter: "in",
    },
    {
      id: "email",
      label: "Email",
      meta: profile.emailMasked ?? "Not connected",
      connected: emailVerified,
      brand: "#EA4335",
      letter: "M",
    },
    {
      id: "sms",
      label: "Phone / SMS",
      meta: profile.phoneMasked ?? "Not connected",
      connected: phoneVerified,
      brand: "#34C759",
      letter: "S",
    },
  ]
}

function linkedinHandleFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\/in\/([^/]+)\/?/)
    if (m && m[1]) return `in/${m[1]}`
    return u.host.replace(/^www\./, "")
  } catch {
    return url.replace(/^https?:\/\//, "")
  }
}

// ────────────────────────────────────────────────────────────────────────────
// /me — candidate operating center (v2 layout)
// ────────────────────────────────────────────────────────────────────────────

export function CandidateMe() {
  const gate = useCandidatePortalGate()
  const profileState = useClaimedProfile()

  if (gate.status !== "ready") {
    return <PortalGatePending gate={gate} kicker="Your pipeline" />
  }

  if (profileState.status === "signed_out") return <SignInRequired kicker="Your pipeline" />
  if (profileState.status === "loading") return <PortalLoading kicker="Your pipeline" />
  if (profileState.status === "error") return <PortalError kicker="Your pipeline" message={profileState.message} />

  return <CandidateMeReady profileState={profileState} />
}

function CandidateMeReady({
  profileState,
}: {
  profileState: Extract<ClaimState, { status: "ready" }>
}) {
  const matchesState = useCandidateMatches(true)
  const profile = profileState.profile
  const allMatches = matchesState.status === "ready" ? matchesState.matches : []

  const upNext = allMatches.filter(
    (m) => m.status === "invited" || m.status === "interview_started",
  )
  const recommended = allMatches.filter((m) => m.status === "recommended")
  const pipelineMatches = allMatches.filter((m) => m.status !== "recommended")

  const matchesLoading = matchesState.status === "loading" || matchesState.status === "idle"
  const matchesErrored = matchesState.status === "error"
  const matchesError = matchesState.status === "error" ? matchesState.message : null

  const actionsCount = upNext.length
  const firstName = firstNameOf(profile)
  const greet = firstName ? `, ${firstName}` : ""

  return (
    <CandidateShell signedIn signedInUser={{ name: profile.displayName ?? "You" }}>
      <style>{ME_PORTAL_STYLES}</style>
      <div className="wkv2">
        <header className="wkv2-status">
          <div className="wk-container wkv2-status__inner">
            <div className="wkv2-status__copy">
              <div className="wkv2-status__eyebrow">
                <PulseDot size={6} />
                <span>My WeKruit · <strong>live</strong></span>
              </div>
              <h1 className="wkv2-status__h1">
                {actionsCount > 0 ? (
                  <>
                    <em className="wkv2-num">{actionsCount}</em> thing{actionsCount === 1 ? "" : "s"} need{actionsCount === 1 ? "s" : ""} you.
                  </>
                ) : (
                  <>Welcome back{greet}.</>
                )}
              </h1>
            </div>
            {upNext.length > 0 ? (
              <div className="wkv2-status__cta">
                <Link to={upNext[0].job.href} className="wk-btn wk-btn--primary">
                  Continue with Claire <Icon name="arrow-right" size={14} stroke={2} />
                </Link>
                <span className="wkv2-status__when">
                  Next: {upNext[0].job.title} at {upNext[0].job.company}
                </span>
              </div>
            ) : null}
          </div>
        </header>

        <div className="wk-container">
          <div className="wkv2-grid">
            <div className="wkv2-main">
              <UpNextSection
                upNext={upNext}
                loading={matchesLoading}
                errored={matchesErrored}
                error={matchesError}
              />
              <PipelineSection
                matches={pipelineMatches}
                recommendedCount={recommended.length}
                loading={matchesLoading}
              />
              <NewMatchesSection
                matches={recommended}
                loading={matchesLoading}
                errored={matchesErrored}
                error={matchesError}
              />
            </div>

            <aside className="wkv2-side">
              <SidebarProfileCard profile={profile} />
              <SidebarConnectorsCard profile={profile} />
              <SidebarClaireWeekCard activeCount={pipelineMatches.length} matchCount={recommended.length} />
              <button
                type="button"
                className="wk-btn wk-btn--ghost wk-btn--sm wkv2-signout"
                onClick={async () => {
                  await clearSsoCookie()
                  await signOut(auth())
                }}
              >
                Sign out
              </button>
            </aside>
          </div>
        </div>
      </div>
    </CandidateShell>
  )
}

function UpNextSection({
  upNext,
  loading,
  errored,
  error,
}: {
  upNext: CandidateMatchCard[]
  loading: boolean
  errored: boolean
  error: string | null
}) {
  return (
    <section className="wkv2-sec" id="up-next">
      <header className="wkv2-sec__head">
        <h2 className="wkv2-sec__h">
          Up next
          {upNext.length > 0 ? <span className="wkv2-sec__count">{upNext.length}</span> : null}
        </h2>
        <span className="wkv2-sec__sub">Only things waiting on you.</span>
      </header>
      {loading ? (
        <div className="wkv2-empty">Loading your pipeline…</div>
      ) : errored ? (
        <div className="wkv2-empty wkv2-empty--error">{error}</div>
      ) : upNext.length === 0 ? (
        <div className="wkv2-empty">
          Nothing waiting on you right now. Claire will text you when she lines something up.
        </div>
      ) : (
        <div className="wkv2-actions">
          {upNext.map((m) => <UpNextRow key={m.matchId} match={m} />)}
        </div>
      )}
    </section>
  )
}

function UpNextRow({ match }: { match: CandidateMatchCard }) {
  const display = getCandidateJobStatusDisplay(match.status, match.job.title)
  const h = djb2(match.jobId || match.job.company)
  const logo = (match.job.company[0] ?? "?").toUpperCase()
  const logoBg = LOGO_BG_POOL[h % LOGO_BG_POOL.length]
  const urgent = match.status === "invited"
  return (
    <article className={`wkv2-act${urgent ? " wkv2-act--urgent" : ""}`}>
      <div className="wkv2-act__mark" style={{ background: logoBg }}>{logo}</div>
      <div className="wkv2-act__body">
        <p className={`wkv2-act__meta${urgent ? " wkv2-act__meta--urgent" : ""}`}>
          {urgent ? <PulseDot size={5} /> : null}
          <span>{display.label} · {match.job.title}</span>
        </p>
        <h3 className="wkv2-act__t">{display.nextStep}</h3>
        {match.job.location ? <p className="wkv2-act__sub">{match.job.company} · {match.job.location}</p> : null}
      </div>
      <div className="wkv2-act__right">
        <Link to={match.job.href} className={`wk-btn ${urgent ? "wk-btn--primary" : "wk-btn--secondary"} wk-btn--sm`}>
          {display.ctaLabel} <Icon name="arrow-right" size={14} stroke={2} />
        </Link>
      </div>
    </article>
  )
}

type StageDef = { id: CandidateJobStatus | "all"; label: string; dot: string }

const STAGES: StageDef[] = [
  { id: "invited", label: "Invited", dot: "var(--wk-live-pulse)" },
  { id: "interview_started", label: "Screening", dot: "#1f6feb" },
  { id: "review_pending", label: "Reviewing", dot: "#c08800" },
  { id: "passed", label: "Passed", dot: "#1f6feb" },
  { id: "not_passed", label: "Not passed", dot: "var(--wk-ink-4)" },
  { id: "paused", label: "Paused", dot: "var(--wk-ink-4)" },
]

function PipelineSection({
  matches,
  recommendedCount,
  loading,
}: {
  matches: CandidateMatchCard[]
  recommendedCount: number
  loading: boolean
}) {
  const [activeStage, setActiveStage] = useState<CandidateJobStatus | null>(null)
  const counts = useMemo(() => {
    const c: Partial<Record<CandidateJobStatus, number>> = {}
    matches.forEach((m) => {
      c[m.status] = (c[m.status] ?? 0) + 1
    })
    return c
  }, [matches])
  const filtered = activeStage ? matches.filter((m) => m.status === activeStage) : matches
  return (
    <section className="wkv2-sec" id="pipeline">
      <header className="wkv2-sec__head">
        <h2 className="wkv2-sec__h">Interview pipeline</h2>
        <span className="wkv2-sec__sub">
          {activeStage ? (
            <button
              type="button"
              className="wkv2-clear"
              onClick={() => setActiveStage(null)}
            >
              Clear filter ×
            </button>
          ) : (
            "Tap a stage to filter."
          )}
        </span>
      </header>

      <div className="wkv2-stages" role="tablist" aria-label="Pipeline stage filter">
        <button
          type="button"
          role="tab"
          aria-selected={activeStage === null}
          className={`wkv2-stage${activeStage === null ? " is-active" : ""}`}
          onClick={() => setActiveStage(null)}
        >
          <span className="wkv2-stage__top">
            <span className="wkv2-stage__dot" style={{ background: "var(--wk-ink-3)" }} />
            <span>New match</span>
          </span>
          <span className={`wkv2-stage__num${recommendedCount === 0 ? " wkv2-stage__num--zero" : ""}`}>
            {recommendedCount}
          </span>
        </button>
        {STAGES.map((s) => {
          const n = counts[s.id as CandidateJobStatus] ?? 0
          const active = activeStage === s.id
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`wkv2-stage${active ? " is-active" : ""}`}
              onClick={() => setActiveStage(active ? null : (s.id as CandidateJobStatus))}
            >
              <span className="wkv2-stage__top">
                <span className="wkv2-stage__dot" style={{ background: s.dot }} />
                <span>{s.label}</span>
              </span>
              <span className={`wkv2-stage__num${n === 0 ? " wkv2-stage__num--zero" : ""}`}>{n}</span>
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="wkv2-empty">Loading interview pipeline…</div>
      ) : filtered.length === 0 ? (
        <div className="wkv2-empty">Nothing in this stage right now.</div>
      ) : (
        <div className="wkv2-rows">
          {filtered.map((m) => <PipelineRow key={m.matchId} match={m} />)}
        </div>
      )}
    </section>
  )
}

function PipelineRow({ match }: { match: CandidateMatchCard }) {
  const display = getCandidateJobStatusDisplay(match.status, match.job.title)
  const h = djb2(match.jobId || match.job.company)
  const logo = (match.job.company[0] ?? "?").toUpperCase()
  const logoBg = LOGO_BG_POOL[h % LOGO_BG_POOL.length]
  const showDecision = shouldShowReviewDecision(match)
  return (
    <article className="wkv2-row">
      <CompanyMark logo={logo} bg={logoBg} size={48} />
      <div className="wkv2-row__body">
        <div className="wkv2-row__head">
          <h4 className="wkv2-row__t">{match.job.title}</h4>
          <StageChip status={match.status} />
        </div>
        <p className="wkv2-row__co">
          {match.job.company}{match.job.location ? ` · ${match.job.location}` : ""}
        </p>
        <p className="wkv2-row__next">{display.nextStep}</p>
        {showDecision ? <ReviewDecisionBlock match={match} /> : null}
      </div>
      <div className="wkv2-row__right">
        <Link to={match.job.href} className="wk-btn wk-btn--secondary wk-btn--sm">
          Open <Icon name="arrow-right" size={12} stroke={2} />
        </Link>
      </div>
    </article>
  )
}

function shouldShowReviewDecision(match: CandidateMatchCard): boolean {
  if (!match.reviewDecision) return false
  return match.status === "passed" || match.status === "not_passed"
}

function ReviewDecisionBlock({ match }: { match: CandidateMatchCard }) {
  const decision = match.reviewDecision
  if (!decision) return null
  const isNotPassed = match.status === "not_passed"
  return (
    <div className="wkv2-decision">
      <p className="wkv2-decision__msg">{decision.candidateMessageBody}</p>
      <div className="wkv2-decision__reason">
        <span>{isNotPassed ? "Why this role closed" : "Next-step note"}</span>
        <p>{decision.decisionReason}</p>
        {isNotPassed ? <p>Your profile stays active for stronger WeKruit matches.</p> : null}
      </div>
      {decision.recommendedActions.length > 0 ? (
        <ul className="wkv2-decision__actions">
          {decision.recommendedActions.slice(0, 5).map((action, index) => (
            <li key={`${match.matchId}-action-${index}`}>
              <Icon name="check" size={12} stroke={2.4} />
              <span>{action}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function StageChip({ status }: { status: CandidateJobStatus }) {
  if (status === "invited")
    return (
      <span className="wkv2-chip wkv2-chip--live">
        <PulseDot size={6} /> Invited
      </span>
    )
  if (status === "interview_started")
    return (
      <span className="wkv2-chip wkv2-chip--blue">
        <PulseDot size={6} color="#1f6feb" /> Screening
      </span>
    )
  if (status === "review_pending")
    return (
      <span className="wkv2-chip wkv2-chip--warm">
        <Icon name="clock" size={11} stroke={2.4} /> Reviewing
      </span>
    )
  if (status === "passed")
    return (
      <span className="wkv2-chip wkv2-chip--warm">
        <Icon name="check" size={11} stroke={2.4} /> Passed
      </span>
    )
  if (status === "not_passed") return <span className="wkv2-chip wkv2-chip--muted">Not passed</span>
  if (status === "paused") return <span className="wkv2-chip wkv2-chip--muted">Paused</span>
  return <span className="wkv2-chip wkv2-chip--muted">New match</span>
}

function NewMatchesSection({
  matches,
  loading,
  errored,
  error,
}: {
  matches: CandidateMatchCard[]
  loading: boolean
  errored: boolean
  error: string | null
}) {
  return (
    <section className="wkv2-sec" id="matches">
      <header className="wkv2-sec__head">
        <h2 className="wkv2-sec__h">
          New matches
          {matches.length > 0 ? <span className="wkv2-sec__count">{matches.length}</span> : null}
        </h2>
        <span className="wkv2-sec__sub">Claire matched these. Mark them so she learns.</span>
      </header>
      {loading ? (
        <div className="wkv2-empty">Loading new matches…</div>
      ) : errored ? (
        <div className="wkv2-empty wkv2-empty--error">{error}</div>
      ) : matches.length === 0 ? (
        <div className="wkv2-empty">
          No new matches this week. Claire is still hunting — she'll text when something fits.
        </div>
      ) : (
        <div className="wkv2-inbox">
          {matches.map((m) => <MatchInboxCard key={m.matchId} match={m} />)}
        </div>
      )}
    </section>
  )
}

function MatchInboxCard({ match }: { match: CandidateMatchCard }) {
  const [vote, setVote] = useState<"yes" | "no" | null>(null)
  const h = djb2(match.jobId || match.job.company)
  const logo = (match.job.company[0] ?? "?").toUpperCase()
  const logoBg = LOGO_BG_POOL[h % LOGO_BG_POOL.length]
  const isInvite = match.bucket === "invited"
  return (
    <article className={`wkv2-match${isInvite ? " is-invite" : ""}`}>
      <CompanyMark logo={logo} bg={logoBg} size={48} />
      <div className="wkv2-match__body">
        <div className="wkv2-match__head">
          {isInvite ? (
            <span className="wkv2-match__chip">WeKruit invite — worth screening</span>
          ) : (
            <span className="wkv2-match__chip wkv2-match__chip--muted">New match</span>
          )}
          <h3 className="wkv2-match__t">{match.job.title}</h3>
        </div>
        <p className="wkv2-match__co">
          <b>{match.job.company}</b>{match.job.location ? ` · ${match.job.location}` : ""}
        </p>
        {match.whyMatched.length > 0 ? (
          <div className="wkv2-match__why">
            <div className="wkv2-match__why-h">Why this matches you</div>
            <ul>
              {match.whyMatched.slice(0, 4).map((w, i) => (
                <li key={i}>
                  <Icon name="check" size={12} stroke={2.4} />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="wkv2-match__foot">
        <div className="wkv2-match__salary">
          {match.job.salaryRange ?? <span className="wkv2-match__no-salary">Salary by interview</span>}
        </div>
        <div className="wkv2-match__actions">
          <div className="wkv2-match__feedback">
            <button
              type="button"
              className={`wkv2-fb wkv2-fb--yes${vote === "yes" ? " is-on" : ""}`}
              onClick={() => setVote(vote === "yes" ? null : "yes")}
              aria-pressed={vote === "yes"}
            >
              <ThumbIcon dir="up" /> Interested
            </button>
            <button
              type="button"
              className={`wkv2-fb wkv2-fb--no${vote === "no" ? " is-on" : ""}`}
              onClick={() => setVote(vote === "no" ? null : "no")}
              aria-pressed={vote === "no"}
            >
              <ThumbIcon dir="down" /> Not for me
            </button>
          </div>
          <Link to={match.job.href} className="wk-btn wk-btn--primary wk-btn--sm">
            See role <Icon name="arrow-right" size={14} stroke={2} />
          </Link>
        </div>
      </div>
    </article>
  )
}

function ThumbIcon({ dir }: { dir: "up" | "down" }) {
  const up = dir === "up"
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "middle", flex: "none" }}
    >
      {up ? (
        <path d="M7 22V11M2 13v7a2 2 0 0 0 2 2h3V11H4a2 2 0 0 0-2 2zM15 5l-1 5h6.5a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 19 21H7V11l4-9h1.5A2.5 2.5 0 0 1 15 4.5z" />
      ) : (
        <path d="M17 2v11M22 11V4a2 2 0 0 0-2-2h-3v11h3a2 2 0 0 0 2-2zM9 19l1-5H3.5a2 2 0 0 1-2-2.3l1.4-7A2 2 0 0 1 5 3h12v11l-4 9h-1.5A2.5 2.5 0 0 1 9 19.5z" />
      )}
    </svg>
  )
}

function SidebarProfileCard({ profile }: { profile: CandidateSelfProfile }) {
  const tone: "warm" | "moss" | "slate" = TONE_POOL[djb2(profile.displayName ?? "you") % TONE_POOL.length]
  const headline = deriveHeadline(profile)
  const tags = profile.globalTags
  const rows: Array<{ label: string; value: string }> = []
  if (tags?.roleFunction?.length) rows.push({ label: "Targets", value: joinTags(tags.roleFunction, 3) })
  if (tags?.targetLocations?.length) rows.push({ label: "Where", value: joinTags(tags.targetLocations, 3, ", ") })
  if (tags?.industrySector?.length) rows.push({ label: "Industries", value: joinTags(tags.industrySector, 3, " · ") })
  if (tags?.targetJobType?.length) rows.push({ label: "Job type", value: joinTags(tags.targetJobType, 3, " · ") })
  if (profile.emailMasked) rows.push({ label: "Email", value: profile.emailMasked })
  if (profile.phoneMasked) rows.push({ label: "Phone", value: profile.phoneMasked })
  const skills = tags?.skills?.slice(0, 10) ?? []
  return (
    <div className="wkv2-card">
      <div className="wkv2-prof__head">
        <Avatar name={profile.displayName ?? "You"} size={52} tone={tone} />
        <div style={{ minWidth: 0 }}>
          <h2 className="wkv2-prof__name">{profile.displayName ?? "Your profile"}</h2>
          {headline ? <p className="wkv2-prof__sub">{headline}</p> : null}
        </div>
      </div>

      {rows.length > 0 ? (
        <>
          <h3 className="wkv2-card__h">
            What Claire pitches
            <Link to="/me/profile">Edit</Link>
          </h3>
          <ul className="wkv2-prof__fields">
            {rows.map((r) => (
              <li key={r.label}><strong>{r.label}</strong><span>{r.value}</span></li>
            ))}
          </ul>
        </>
      ) : (
        <p className="wkv2-prof__empty">
          Claire is still learning what you want. Open the profile editor to fill in roles,
          locations, and industries.
        </p>
      )}

      {skills.length > 0 ? (
        <div>
          <h3 className="wkv2-card__h" style={{ marginBottom: 8 }}>Skills</h3>
          <div className="wkv2-prof__skills">
            {skills.map((s) => (
              <span key={s} className="wkv2-prof__skill">{formatProfileValue(s)}</span>
            ))}
          </div>
        </div>
      ) : null}

      <Link to="/me/profile" className="wkv2-prof__fix">
        <Icon name="check" size={12} stroke={2} />
        <span>Fix something — Claire updates everything</span>
      </Link>
    </div>
  )
}

function SidebarConnectorsCard({ profile }: { profile: CandidateSelfProfile }) {
  const items = deriveConnectors(profile)
  return (
    <div className="wkv2-card">
      <h3 className="wkv2-card__h">
        Connected
        <Link to="/me/profile">Add more</Link>
      </h3>
      <div className="wkv2-conn">
        {items.map((c) => (
          <div key={c.id} className="wkv2-conn__row">
            <span
              className="wkv2-conn__ico"
              style={{ background: c.brand, color: "#fff", fontSize: 11, fontWeight: 700, letterSpacing: "-0.02em" }}
            >
              {c.letter}
            </span>
            <div style={{ minWidth: 0 }}>
              <span className="wkv2-conn__label">{c.label}</span>
              <span className="wkv2-conn__meta">{c.meta}</span>
            </div>
            {c.connected ? (
              <span className="wkv2-conn__btn wkv2-conn__btn--status">
                <span className="wkv2-conn__check"><Icon name="check" size={9} stroke={3} /></span>
                On file
              </span>
            ) : (
              <span className="wkv2-conn__btn wkv2-conn__btn--status wkv2-conn__btn--muted">Not connected</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function SidebarClaireWeekCard({
  activeCount,
  matchCount,
}: {
  activeCount: number
  matchCount: number
}) {
  return (
    <div className="wkv2-card wkv2-card--ink">
      <h3 className="wkv2-card__h">This week with Claire</h3>
      <p className="wkv2-ink-h">
        {matchCount > 0 ? (
          <>Surfaced <em>{matchCount} new match{matchCount === 1 ? "" : "es"}</em> for you to weigh.</>
        ) : (
          <>Claire is keeping <em>your profile</em> visible to hiring managers.</>
        )}
      </p>
      <div className="wkv2-ink-stats">
        <div>
          <div className="wkv2-ink-stat__num">{matchCount}</div>
          <div className="wkv2-ink-stat__lbl">Matches</div>
        </div>
        <div>
          <div className="wkv2-ink-stat__num">{activeCount}</div>
          <div className="wkv2-ink-stat__lbl">Active</div>
        </div>
        <div>
          <div className="wkv2-ink-stat__num">{activeCount + matchCount}</div>
          <div className="wkv2-ink-stat__lbl">Total</div>
        </div>
      </div>
      <a href="sms:+18004448888?body=Hi%20Claire" className="wkv2-ink-link">
        Open iMessage with Claire <Icon name="arrow-right" size={12} stroke={2} />
      </a>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /me/profile — full edit surface (v2 layout)
// ────────────────────────────────────────────────────────────────────────────

export function CandidateProfile() {
  const gate = useCandidatePortalGate()
  const state = useClaimedProfile()

  if (gate.status !== "ready") {
    return <PortalGatePending gate={gate} kicker="Profile" />
  }

  if (state.status === "signed_out") return <SignInRequired kicker="Profile" />
  if (state.status === "loading") return <PortalLoading kicker="Profile" />
  if (state.status === "error") return <PortalError kicker="Profile" message={state.message} />
  return <ProfileSurface initial={state.profile} />
}

function ProfileSurface({ initial }: { initial: CandidateSelfProfile }) {
  const [profile, setProfile] = useState<CandidateSelfProfile>(initial)
  const [editing, setEditing] = useState(false)
  useEffect(() => setProfile(initial), [initial])
  return (
    <CandidateShell signedIn signedInUser={{ name: profile.displayName ?? "You" }}>
      <style>{ME_PORTAL_STYLES}</style>
      <style>{PROFILE_STYLES}</style>
      <div className="wk-prof">
        <div className="wk-container">
          <header className="wk-prof__head">
            <div>
              <h1 className="wk-prof__h1">Profile</h1>
              <p className="wk-prof__sub">
                Everything Claire knows about you, and what she pitches on your behalf.
              </p>
            </div>
            <div className="wk-prof__head-actions">
              <span className="wk-prof__live">
                <PulseDot size={6} /> {profile.lifecycleState === "claimed" ? "Visible to employers" : formatProfileStatus(profile.lifecycleState)}
              </span>
              <button
                type="button"
                className={`wk-btn ${editing ? "wk-btn--secondary" : "wk-btn--primary"} wk-btn--sm`}
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? "Done editing" : "Edit profile"}
              </button>
            </div>
          </header>

          <div className="wk-prof__grid">
            <div className="wk-prof__main">
              <IdentityCard profile={profile} />
              <WhatClairePitchesCard profile={profile} />
              <SkillsCard profile={profile} editing={editing} />
              <UpdatePreferencesPanel onProfileUpdated={setProfile} />
            </div>

            <aside className="wk-prof__side">
              <ContactCard profile={profile} />
              <ConnectedAccountsCard profile={profile} />
              <PrivacyCard />
              <PrivacyRequestPanel />
              <button
                type="button"
                className="wk-btn wk-btn--ghost wk-btn--sm wkv2-signout"
                onClick={async () => {
                  await clearSsoCookie()
                  await signOut(auth())
                }}
              >
                Sign out
              </button>
            </aside>
          </div>
        </div>
      </div>
    </CandidateShell>
  )
}

function IdentityCard({ profile }: { profile: CandidateSelfProfile }) {
  const tone: "warm" | "moss" | "slate" = TONE_POOL[djb2(profile.displayName ?? "you") % TONE_POOL.length]
  const headline = deriveHeadline(profile)
  const metaParts: string[] = []
  if (profile.globalTags?.targetJobType?.length) metaParts.push(formatProfileValue(profile.globalTags.targetJobType[0]))
  if (profile.globalTags?.targetLocations?.length) metaParts.push(formatProfileValue(profile.globalTags.targetLocations[0]))
  metaParts.push(formatProfileStatus(profile.lifecycleState))
  return (
    <section className="wkv2-card wk-prof-card">
      <div className="wk-prof-id">
        <Avatar name={profile.displayName ?? "You"} size={64} tone={tone} />
        <div className="wk-prof-id__body">
          <h2 className="wk-prof-id__name">{profile.displayName ?? "Your profile"}</h2>
          {headline ? <p className="wk-prof-id__headline">{headline}</p> : null}
          <p className="wk-prof-id__meta">{metaParts.join(" · ")}</p>
        </div>
      </div>
    </section>
  )
}

function WhatClairePitchesCard({ profile }: { profile: CandidateSelfProfile }) {
  const tags = profile.globalTags
  const rows: Array<{ label: string; value: string }> = []
  if (tags?.roleFunction?.length) rows.push({ label: "Targets", value: joinTags(tags.roleFunction, 4, " · ") })
  if (tags?.targetLocations?.length) rows.push({ label: "Where", value: joinTags(tags.targetLocations, 5, ", ") })
  if (tags?.industrySector?.length) rows.push({ label: "Industries", value: joinTags(tags.industrySector, 5, " · ") })
  if (tags?.targetJobType?.length) rows.push({ label: "Job type", value: joinTags(tags.targetJobType, 4, " · ") })
  if (tags?.relevantTags?.length) rows.push({ label: "Tags", value: joinTags(tags.relevantTags, 6, " · ") })
  return (
    <section className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">What Claire pitches</h3>
      <p className="wk-prof-card__hint">These are the answers Claire gives any hiring manager who asks.</p>
      {rows.length === 0 ? (
        <p className="wk-prof-card__hint" style={{ margin: 0 }}>
          Claire hasn't captured these yet. Tell her on iMessage or use "Update preferences" below.
        </p>
      ) : (
        <div className="wk-prof-rows">
          {rows.map((r) => (
            <div key={r.label} className="wk-prof-row">
              <span className="wk-prof-row__label">{r.label}</span>
              <span className="wk-prof-row__value">{r.value}</span>
            </div>
          ))}
        </div>
      )}
      {profile.profileSummary ? (
        <p className="wk-prof-summary">{profile.profileSummary}</p>
      ) : null}
    </section>
  )
}

function SkillsCard({ profile, editing }: { profile: CandidateSelfProfile; editing: boolean }) {
  const skills = profile.globalTags?.skills ?? []
  if (skills.length === 0 && !editing) {
    return (
      <section className="wkv2-card wk-prof-card">
        <h3 className="wkv2-card__h">Skills</h3>
        <p className="wk-prof-card__hint">
          Claire pulls these from your résumé. Upload one on iMessage to see them here.
        </p>
      </section>
    )
  }
  return (
    <section className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">Skills</h3>
      <p className="wk-prof-card__hint">Tags Claire matches against role requirements.</p>
      <div className="wkv2-prof__skills wk-prof-skills">
        {skills.map((s) => (
          <span key={s} className="wkv2-prof__skill wk-prof-skill">
            {formatProfileValue(s)}
          </span>
        ))}
        {editing ? (
          <span className="wk-prof-skill wk-prof-skill--add">
            <Icon name="check" size={11} stroke={2.4} /> Add via "Update preferences"
          </span>
        ) : null}
      </div>
    </section>
  )
}

function ContactCard({ profile }: { profile: CandidateSelfProfile }) {
  return (
    <section className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">Contact</h3>
      <p className="wk-prof-card__hint">Only shared after you accept an interview.</p>
      <div className="wk-prof-rows wk-prof-rows--stack">
        <div className="wk-prof-row">
          <span className="wk-prof-row__label">Email</span>
          <span className="wk-prof-row__value">{profile.emailMasked ?? "Not set"}</span>
        </div>
        <div className="wk-prof-row">
          <span className="wk-prof-row__label">Phone</span>
          <span className="wk-prof-row__value">{profile.phoneMasked ?? "Not set"}</span>
        </div>
      </div>
    </section>
  )
}

function ConnectedAccountsCard({ profile }: { profile: CandidateSelfProfile }) {
  const items = deriveConnectors(profile)
  return (
    <section className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">Connected accounts</h3>
      <div className="wkv2-conn wk-prof-conn">
        {items.map((c) => (
          <div key={c.id} className="wkv2-conn__row">
            <span
              className="wkv2-conn__ico"
              style={{ background: c.brand, color: "#fff", fontSize: 11, fontWeight: 600 }}
            >
              {c.letter}
            </span>
            <span className="wkv2-conn__label">
              {c.label}
              <span className="wkv2-conn__meta">{c.meta}</span>
            </span>
            <span className={`wkv2-conn__btn wkv2-conn__btn--status${c.connected ? "" : " wkv2-conn__btn--muted"}`}>
              {c.connected ? "On file" : "Not connected"}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function PrivacyCard() {
  const [showMe, setShowMe] = useState(true)
  const [blockEmployer, setBlockEmployer] = useState(true)
  const [shareResume, setShareResume] = useState(false)
  return (
    <section className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">Privacy</h3>
      <div className="wk-prof-privacy">
        <button
          type="button"
          className="wk-prof-privacy__row"
          onClick={() => setShowMe((v) => !v)}
        >
          <span>
            <strong>Show me to employers</strong>
            <em>Pause if you don't want new matches.</em>
          </span>
          <span className={`wk-prof-toggle${showMe ? " is-on" : ""}`} aria-hidden="true"><span /></span>
        </button>
        <button
          type="button"
          className="wk-prof-privacy__row"
          onClick={() => setBlockEmployer((v) => !v)}
        >
          <span>
            <strong>Block current employer</strong>
            <em>Auto-detected from your résumé experience.</em>
          </span>
          <span className={`wk-prof-toggle${blockEmployer ? " is-on" : ""}`} aria-hidden="true"><span /></span>
        </button>
        <button
          type="button"
          className="wk-prof-privacy__row"
          onClick={() => setShareResume((v) => !v)}
        >
          <span>
            <strong>Share full résumé before screen</strong>
            <em>Off — only Claire's summary is shared.</em>
          </span>
          <span className={`wk-prof-toggle${shareResume ? " is-on" : ""}`} aria-hidden="true"><span /></span>
        </button>
      </div>
      <p className="wk-prof-card__hint" style={{ marginTop: 8 }}>
        These toggles read your preference today. Use "Request" below to make a binding change with Claire.
      </p>
    </section>
  )
}

function UpdatePreferencesPanel({
  onProfileUpdated,
}: {
  onProfileUpdated: (profile: CandidateSelfProfile) => void
}) {
  const [correctionText, setCorrectionText] = useState("")
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [message, setMessage] = useState<string | null>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    setStatus("submitting")
    try {
      const submitCorrection = createCandidateProfileCorrectionSubmitter(functions())
      const result = await submitCorrection({ correctionText })
      onProfileUpdated(result.selfProfile)
      setCorrectionText("")
      const applied = result.appliedKeys?.length ? ` Updated: ${result.appliedKeys.join(", ")}.` : ""
      setMessage(`Correction submitted.${applied}`)
      setStatus("success")
    } catch (err) {
      setMessage(callableSubmitErrorMessage(err))
      setStatus("error")
    }
  }

  return (
    <section className="wkv2-card wk-prof-card" aria-labelledby="prof-update-title">
      <h3 className="wkv2-card__h" id="prof-update-title">Update preferences</h3>
      <p className="wk-prof-card__hint">
        Tell Claire what to change. Free-form is fine — she'll update the canonical tags for you.
      </p>
      <form onSubmit={onSubmit} className="wk-prof-form">
        <textarea
          value={correctionText}
          onChange={(e) => setCorrectionText(e.target.value)}
          disabled={status === "submitting"}
          rows={4}
          placeholder="Example: I prefer product roles in New York or remote, and want to avoid early-stage startups."
        />
        <button
          type="submit"
          className="wk-btn wk-btn--primary wk-btn--sm"
          disabled={status === "submitting" || correctionText.trim().length === 0}
        >
          {status === "submitting" ? "Submitting…" : "Send to Claire"}
        </button>
      </form>
      {status === "success" && message ? <p className="wk-success">{message}</p> : null}
      {status === "error" && message ? <p className="wk-error">{message}</p> : null}
    </section>
  )
}

const PRIVACY_REQUEST_OPTIONS: Array<{ kind: CandidatePrivacyRequestKind; label: string }> = [
  { kind: "export", label: "Export my data" },
  { kind: "delete", label: "Delete my profile" },
  { kind: "stop_outreach", label: "Stop outreach" },
  { kind: "privacy_question", label: "Privacy question" },
]

function PrivacyRequestPanel() {
  const [kind, setKind] = useState<CandidatePrivacyRequestKind>("export")
  const [detailText, setDetailText] = useState("")
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [message, setMessage] = useState<string | null>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    setStatus("submitting")
    try {
      const submitPrivacyRequest = createCandidatePrivacyRequestSubmitter(functions())
      const result = await submitPrivacyRequest({ kind, detailText })
      setDetailText("")
      setMessage(result.existingOpen ? "Open request already exists." : "Request submitted for review.")
      setStatus("success")
    } catch (err) {
      setMessage(callableSubmitErrorMessage(err))
      setStatus("error")
    }
  }

  return (
    <section className="wkv2-card wk-prof-card" aria-labelledby="prof-privacy-title">
      <h3 className="wkv2-card__h" id="prof-privacy-title">Privacy requests</h3>
      <p className="wk-prof-card__hint">Binding actions reviewed by a WeKruit operator.</p>
      <form onSubmit={onSubmit} className="wk-prof-form">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as CandidatePrivacyRequestKind)}
          disabled={status === "submitting"}
          className="wk-prof-form__select"
        >
          {PRIVACY_REQUEST_OPTIONS.map((o) => (
            <option key={o.kind} value={o.kind}>{o.label}</option>
          ))}
        </select>
        <textarea
          value={detailText}
          onChange={(e) => setDetailText(e.target.value)}
          disabled={status === "submitting"}
          rows={3}
          placeholder="Add context for the operator review."
        />
        <button type="submit" className="wk-btn wk-btn--secondary wk-btn--sm" disabled={status === "submitting"}>
          {status === "submitting" ? "Submitting…" : "Submit request"}
        </button>
      </form>
      {status === "success" && message ? <p className="wk-success">{message}</p> : null}
      {status === "error" && message ? <p className="wk-error">{message}</p> : null}
    </section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Loading / signed-out / error states
// ────────────────────────────────────────────────────────────────────────────

function PortalCard({ kicker, children }: { kicker: string; children: ReactNode }) {
  return (
    <CandidateShell>
      <style>{ME_PORTAL_STYLES}</style>
      <div className="wkv2" style={{ paddingTop: 56 }}>
        <div className="wk-container">
          <section className="wkv2-card wk-prof-card" style={{ maxWidth: 520, margin: "40px auto" }}>
            <p className="wk-eyebrow">{kicker}</p>
            {children}
          </section>
        </div>
      </div>
    </CandidateShell>
  )
}

function PortalGatePending({
  gate,
  kicker,
}: {
  gate: ReturnType<typeof useCandidatePortalGate>
  kicker: string
}) {
  if (gate.status === "verify_error") {
    return (
      <PortalCard kicker={kicker}>
        <h1 className="wk-prof__h1">Couldn&apos;t load your profile</h1>
        <p className="wk-error">{gate.message}</p>
        <button
          type="button"
          className="wk-btn wk-btn--primary"
          onClick={() => window.location.reload()}
        >
          Try again <Icon name="arrow-right" size={14} stroke={2} />
        </button>
      </PortalCard>
    )
  }
  const heading =
    gate.status === "redirecting_onboarding" ? "Almost there" : "Welcome back"
  const message =
    gate.status === "redirecting_onboarding"
      ? "Finishing onboarding with Claire — one second…"
      : "Loading your matches and interviews…"
  return (
    <PortalCard kicker={kicker}>
      <h1 className="wk-prof__h1">{heading}</h1>
      <p className="wk-prof__sub">{message}</p>
      <PortalSkeletonShimmer />
    </PortalCard>
  )
}

// Tiny 3-dot bounce + 2 shimmer rows so the loading card feels alive
// even when it does have to wait on the verify callable (first visit only,
// once portal-cache stores portalReady=true subsequent renders skip this).
function PortalSkeletonShimmer() {
  return (
    <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 12 }} aria-hidden="true">
      <div style={{ display: "inline-flex", gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "var(--ink-3)",
              opacity: 0.4,
              animation: `wk-skel-bounce 1.1s ${i * 0.15}s ease-in-out infinite`,
            }}
          />
        ))}
      </div>
      <span
        style={{
          height: 10,
          width: "85%",
          borderRadius: 6,
          background: "linear-gradient(90deg, var(--border) 0%, var(--cream-2) 50%, var(--border) 100%)",
          backgroundSize: "200% 100%",
          animation: "wk-skel-shimmer 1.6s linear infinite",
        }}
      />
      <span
        style={{
          height: 10,
          width: "65%",
          borderRadius: 6,
          background: "linear-gradient(90deg, var(--border) 0%, var(--cream-2) 50%, var(--border) 100%)",
          backgroundSize: "200% 100%",
          animation: "wk-skel-shimmer 1.6s 0.2s linear infinite",
        }}
      />
      <style>{`
        @keyframes wk-skel-bounce {
          0%, 80%, 100% { transform: scale(0.7); opacity: 0.3; }
          40% { transform: scale(1); opacity: 0.9; }
        }
        @keyframes wk-skel-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  )
}

function SignInRequired({ kicker }: { kicker: string }) {
  const navigate = useNavigate()
  return (
    <PortalCard kicker={kicker}>
      <h1 className="wk-prof__h1">Sign in required</h1>
      <p className="wk-prof__sub">Sign in to load your candidate profile, pipeline, and matches.</p>
      <button type="button" className="wk-btn wk-btn--primary" onClick={() => navigate("/login")}>
        Sign in <Icon name="arrow-right" size={14} stroke={2} />
      </button>
    </PortalCard>
  )
}

function PortalLoading({ kicker }: { kicker: string }) {
  return (
    <PortalCard kicker={kicker}>
      <h1 className="wk-prof__h1">Welcome back</h1>
      <p className="wk-prof__sub">Loading your matches and interviews…</p>
    </PortalCard>
  )
}

function PortalError({ kicker, message }: { kicker: string; message: string }) {
  const navigate = useNavigate()
  return (
    <PortalCard kicker={kicker}>
      <h1 className="wk-prof__h1">Profile unavailable</h1>
      <p className="wk-error">{message}</p>
      <button type="button" className="wk-btn wk-btn--primary" onClick={() => navigate("/login")}>
        Sign in again <Icon name="arrow-right" size={14} stroke={2} />
      </button>
    </PortalCard>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Styles — /me operating center + /me/profile editor
// Variables use the `--wk-*` namespace declared by .wk-shell in CandidateLogin.
// ────────────────────────────────────────────────────────────────────────────

const ME_PORTAL_STYLES = `
.wkv2 { padding: 0 0 80px; background: var(--wk-cream); min-height: 100vh; }
.wk-container { max-width: 1240px; margin: 0 auto; padding: 0 28px; }
@media (max-width: 760px) { .wk-container { padding: 0 18px; } }

.wkv2-status { position: relative; padding: 36px 0 28px; overflow: hidden; }
.wkv2-status__inner { display: grid; grid-template-columns: 1fr auto; gap: 32px; align-items: end; }
.wkv2-status__copy { max-width: 720px; min-width: 0; }
.wkv2-status__eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 500;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--wk-ink-3); margin-bottom: 10px;
}
.wkv2-status__eyebrow strong { color: var(--wk-ink); font-weight: 600; }
.wkv2-status__h1 {
  font-family: 'Newsreader', serif;
  font-weight: 400;
  font-size: clamp(30px, 3.6vw, 44px);
  line-height: 1.08; letter-spacing: -0.022em;
  color: var(--wk-ink); margin: 0;
}
.wkv2-status__h1 .wkv2-num { display: inline-block; font-style: italic; color: var(--wk-live); font-weight: 400; }
.wkv2-status__cta { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.wkv2-status__cta .wk-btn { white-space: nowrap; }
.wkv2-status__when { font-size: 12px; color: var(--wk-ink-3); font-weight: 500; }

.wkv2-grid {
  padding: 32px 0 0;
  display: grid; grid-template-columns: minmax(0, 1fr) 320px;
  gap: 32px; align-items: start;
}
.wkv2-main { display: grid; gap: 44px; min-width: 0; }
.wkv2-side { display: grid; gap: 16px; position: sticky; top: 88px; }
.wkv2-signout { justify-self: center; margin-top: 4px; }

.wkv2-sec { display: grid; gap: 14px; }
.wkv2-sec__head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 16px; padding-bottom: 12px;
  border-bottom: 1px solid var(--wk-border);
  flex-wrap: wrap;
}
.wkv2-sec__h {
  font-family: 'Hanken Grotesk', sans-serif;
  font-weight: 600; font-size: 18px;
  letter-spacing: -0.005em; line-height: 1.2;
  color: var(--wk-ink); margin: 0;
  display: inline-flex; align-items: baseline; gap: 10px;
  white-space: nowrap;
}
.wkv2-sec__count {
  font-family: 'Hanken Grotesk', sans-serif;
  font-weight: 600; font-size: 12px;
  color: var(--wk-live);
  background: var(--wk-live-soft);
  border: 1px solid var(--wk-live-border);
  border-radius: var(--wk-r-pill);
  padding: 2px 8px; letter-spacing: 0;
}
.wkv2-sec__sub { color: var(--wk-ink-3); font-size: 13.5px; font-weight: 500; }
.wkv2-clear {
  background: transparent; border: 0; cursor: pointer;
  color: var(--wk-live); font: inherit; font-weight: 600;
  padding: 0;
}

.wkv2-actions { display: grid; gap: 12px; }
.wkv2-act {
  display: grid; grid-template-columns: 56px 1fr auto;
  gap: 18px; align-items: center;
  padding: 18px 22px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  transition: border-color 180ms var(--wk-ease),
              box-shadow 220ms var(--wk-ease),
              transform 220ms var(--wk-ease);
}
.wkv2-act:hover {
  border-color: var(--wk-live-border);
  box-shadow: 0 2px 0 0 rgba(154,68,33,.06), 0 10px 24px -14px rgba(154,68,33,.20);
  transform: translateY(-1px);
}
.wkv2-act--urgent {
  background: linear-gradient(180deg, var(--wk-cream) 0%, var(--wk-cream-3) 100%);
  border-color: var(--wk-live-border);
  box-shadow: 0 0 0 4px rgba(224,116,46,0.06);
}
.wkv2-act__mark {
  width: 56px; height: 56px; border-radius: 14px;
  display: inline-flex; align-items: center; justify-content: center;
  font-family: 'Newsreader', serif; font-weight: 500;
  color: var(--wk-cream);
  font-size: 22px; letter-spacing: -0.02em;
  flex: none;
}
.wkv2-act__body { min-width: 0; }
.wkv2-act__meta {
  font-size: 12px; font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--wk-ink-3); margin: 0 0 4px;
  display: inline-flex; align-items: center; gap: 8px;
}
.wkv2-act__meta--urgent { color: var(--wk-live); }
.wkv2-act__t {
  margin: 0;
  font-family: 'Hanken Grotesk', sans-serif;
  font-weight: 600; font-size: 16px;
  letter-spacing: -0.005em; line-height: 1.35;
  color: var(--wk-ink);
}
.wkv2-act__sub { margin: 4px 0 0; font-size: 14px; color: var(--wk-ink-2); line-height: 1.45; }
.wkv2-act__right {
  display: flex; flex-direction: column;
  align-items: flex-end; gap: 8px; min-width: 130px;
}

.wkv2-stages {
  display: grid; grid-template-columns: repeat(6, 1fr);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  background: var(--wk-cream-3);
  overflow: hidden;
}
.wkv2-stage {
  appearance: none; border: 0; background: transparent;
  text-align: left; padding: 14px 16px 16px;
  display: grid; gap: 8px; cursor: pointer;
  border-right: 1px solid var(--wk-border);
  position: relative;
  transition: background 180ms var(--wk-ease);
  color: var(--wk-ink);
  font-family: inherit;
}
.wkv2-stage:last-child { border-right: 0; }
.wkv2-stage:hover { background: #FFF8EB; }
.wkv2-stage.is-active { background: var(--wk-cream); }
.wkv2-stage.is-active::after {
  content: ""; position: absolute;
  left: 16px; right: 16px; bottom: 0;
  height: 2px; background: var(--wk-live);
  border-radius: 2px;
}
.wkv2-stage__top {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 600;
  letter-spacing: -0.005em; color: var(--wk-ink);
  white-space: nowrap;
}
.wkv2-stage__num {
  font-family: 'Hanken Grotesk', sans-serif;
  font-weight: 600; font-size: 22px;
  letter-spacing: -0.01em; color: var(--wk-ink);
  line-height: 1; font-variant-numeric: tabular-nums;
}
.wkv2-stage__num--zero { color: var(--wk-ink-4); }
.wkv2-stage__dot {
  width: 7px; height: 7px; border-radius: 50%;
  display: inline-block; flex: none;
}

.wkv2-rows { display: grid; gap: 10px; }
.wkv2-row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  gap: 18px; align-items: center;
  padding: 18px 22px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  transition: border-color 180ms var(--wk-ease),
              transform 220ms var(--wk-ease);
}
.wkv2-row:hover { border-color: var(--wk-live-border); transform: translateY(-1px); }
.wkv2-row__body { min-width: 0; }
.wkv2-row__head {
  display: flex; align-items: center; gap: 10px;
  flex-wrap: wrap; margin-bottom: 4px;
}
.wkv2-row__t {
  margin: 0;
  font-family: 'Hanken Grotesk', sans-serif;
  font-weight: 600; font-size: 15.5px;
  letter-spacing: -0.005em; line-height: 1.35;
  color: var(--wk-ink);
}
.wkv2-row__co { margin: 0; font-size: 13px; color: var(--wk-ink-3); }
.wkv2-row__co b { color: var(--wk-ink-2); font-weight: 600; }
.wkv2-row__next {
  margin: 6px 0 0; font-size: 13.5px;
  color: var(--wk-ink-2); line-height: 1.4;
}
.wkv2-row__right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; white-space: nowrap; }
.wkv2-decision {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-sm);
  background: #fff;
  display: grid;
  gap: 8px;
}
.wkv2-decision__msg,
.wkv2-decision__reason p {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--wk-ink-2);
}
.wkv2-decision__reason {
  display: grid;
  gap: 4px;
}
.wkv2-decision__reason span {
  font-size: 12px;
  font-weight: 700;
  color: var(--wk-ink);
}
.wkv2-decision__actions {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}
.wkv2-decision__actions li {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  gap: 7px;
  align-items: start;
  font-size: 13px;
  line-height: 1.35;
  color: var(--wk-ink-2);
}
.wkv2-decision__actions svg {
  color: var(--wk-live);
  margin-top: 2px;
}

.wkv2-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: var(--wk-r-pill);
  font-size: 12px; font-weight: 600; line-height: 1;
  letter-spacing: -0.005em;
}
.wkv2-chip--warm { background: var(--wk-peach-50); color: var(--wk-ink); border: 1px solid var(--wk-peach-100); }
.wkv2-chip--blue { background: rgba(31,111,235,.10); color: #1f6feb; }
.wkv2-chip--live { background: var(--wk-live-soft); color: var(--wk-live); border: 1px solid var(--wk-live-border); }
.wkv2-chip--muted { background: var(--wk-cream-2); color: var(--wk-ink-3); border: 1px solid var(--wk-border); }
.wkv2-chip--ink { background: var(--wk-ink); color: var(--wk-cream); }

.wkv2-inbox { display: grid; gap: 10px; }
.wkv2-match {
  display: grid; grid-template-columns: auto 1fr;
  gap: 16px; padding: 18px 22px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  transition: border-color 180ms var(--wk-ease);
}
.wkv2-match:hover { border-color: var(--wk-live-border); }
.wkv2-match.is-invite {
  background: linear-gradient(180deg, var(--wk-peach-50) 0%, var(--wk-cream-3) 50%);
  border-color: var(--wk-peach-200);
}
.wkv2-match__body { min-width: 0; }
.wkv2-match__head { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-bottom: 2px; }
.wkv2-match__t {
  margin: 0;
  font-family: 'Hanken Grotesk', sans-serif;
  font-weight: 600; font-size: 16px;
  letter-spacing: -0.005em; line-height: 1.35;
  color: var(--wk-ink);
}
.wkv2-match__chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px;
  background: var(--wk-live-soft);
  border: 1px solid var(--wk-live-border);
  color: var(--wk-live);
  border-radius: var(--wk-r-pill);
  font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  white-space: nowrap;
}
.wkv2-match__chip--muted {
  background: var(--wk-cream-2); border-color: var(--wk-border); color: var(--wk-ink-3);
}
.wkv2-match__co { margin: 4px 0 0; font-size: 13.5px; color: var(--wk-ink-3); }
.wkv2-match__co b { color: var(--wk-ink-2); font-weight: 600; }
.wkv2-match__why { margin: 12px 0 0; display: grid; gap: 4px; }
.wkv2-match__why-h {
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--wk-ink-3); margin-bottom: 4px;
}
.wkv2-match__why ul { margin: 0; padding: 0; display: grid; gap: 4px; list-style: none; }
.wkv2-match__why li {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: 13.5px; color: var(--wk-ink-2); line-height: 1.45;
}
.wkv2-match__why li svg { color: var(--wk-live); flex: none; margin-top: 3px; }
.wkv2-match__foot {
  grid-column: 2 / -1;
  display: flex; align-items: center; justify-content: space-between;
  gap: 14px; flex-wrap: wrap;
  padding-top: 14px; margin-top: 4px;
  border-top: 1px dashed var(--wk-border);
}
.wkv2-match__salary {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 19px; letter-spacing: -0.018em;
  color: var(--wk-ink); line-height: 1.2;
  white-space: nowrap;
  display: inline-flex; align-items: baseline; gap: 8px;
}
.wkv2-match__no-salary {
  font-family: 'Hanken Grotesk', sans-serif;
  font-size: 12px; font-weight: 500;
  color: var(--wk-ink-3);
  text-transform: uppercase; letter-spacing: 0.06em;
}
.wkv2-match__actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; align-items: center; }
.wkv2-match__feedback { display: flex; gap: 6px; }
.wkv2-fb {
  appearance: none; border: 1px solid var(--wk-border);
  background: var(--wk-cream); color: var(--wk-ink-2);
  border-radius: var(--wk-r-pill);
  padding: 6px 12px; font-size: 12px; font-weight: 600;
  cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: all 180ms var(--wk-ease);
  font-family: inherit;
}
.wkv2-fb:hover { border-color: var(--wk-ink); color: var(--wk-ink); }
.wkv2-fb--yes.is-on { background: var(--wk-ink); color: var(--wk-cream); border-color: var(--wk-ink); }
.wkv2-fb--no.is-on  { background: var(--wk-cream-2); color: var(--wk-ink-3); border-color: var(--wk-border-strong); opacity: 0.7; }

.wkv2-empty {
  padding: 22px;
  border: 1px dashed var(--wk-border);
  border-radius: var(--wk-r-md);
  background: var(--wk-cream-2);
  color: var(--wk-ink-3);
  font-size: 14px; line-height: 1.5;
}
.wkv2-empty--error { color: #9c2b24; border-color: #c8896e; }

.wkv2-card {
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  padding: 20px;
  display: grid; gap: 14px;
}
.wkv2-card__h {
  font-family: 'Hanken Grotesk', sans-serif;
  font-weight: 600; font-size: 14px;
  color: var(--wk-ink);
  letter-spacing: -0.005em; margin: 0;
  display: flex; align-items: center; justify-content: space-between;
}
.wkv2-card__h a {
  color: var(--wk-ink-2); font-weight: 500;
  font-size: 12.5px; letter-spacing: 0;
  border-bottom: 1px solid var(--wk-border);
  text-decoration: none; padding-bottom: 1px;
}
.wkv2-card__h a:hover { color: var(--wk-ink); border-color: var(--wk-ink); }

.wkv2-prof__head {
  display: flex; align-items: center; gap: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--wk-border);
}
.wkv2-prof__name {
  margin: 0;
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 22px; line-height: 1.15;
  letter-spacing: -0.02em; color: var(--wk-ink);
}
.wkv2-prof__sub {
  margin: 3px 0 0;
  font-size: 13px; color: var(--wk-ink-3); line-height: 1.35;
}
.wkv2-prof__empty {
  font-size: 13.5px; color: var(--wk-ink-3); margin: 0;
}
.wkv2-prof__fields {
  display: grid; gap: 11px; margin: 0; padding: 0;
  list-style: none;
}
.wkv2-prof__fields li {
  display: grid; grid-template-columns: 86px 1fr;
  gap: 12px; font-size: 13px; color: var(--wk-ink-2);
  align-items: baseline;
}
.wkv2-prof__fields strong {
  font-family: 'Hanken Grotesk', sans-serif;
  font-weight: 600; font-size: 10.5px;
  color: var(--wk-ink-3);
  text-transform: uppercase; letter-spacing: 0.06em;
}
.wkv2-prof__fields span { line-height: 1.4; }
.wkv2-prof__skills { display: flex; flex-wrap: wrap; gap: 5px; }
.wkv2-prof__skill {
  font-size: 11.5px; padding: 3px 8px;
  background: var(--wk-cream-2);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-pill);
  color: var(--wk-ink-2);
  letter-spacing: -0.005em;
}
.wkv2-prof__fix {
  width: 100%; margin-top: 4px;
  background: transparent;
  border: 1px dashed var(--wk-border-strong);
  border-radius: var(--wk-r-sm);
  padding: 10px 12px;
  font-family: 'Hanken Grotesk', sans-serif;
  font-size: 12.5px; color: var(--wk-ink-3);
  text-align: left; cursor: pointer; text-decoration: none;
  transition: all 180ms var(--wk-ease);
  display: flex; align-items: center; gap: 8px;
}
.wkv2-prof__fix:hover {
  color: var(--wk-ink);
  border-color: var(--wk-ink);
  background: var(--wk-cream-2);
}

.wkv2-conn { display: grid; gap: 6px; }
.wkv2-conn__row {
  display: grid; grid-template-columns: 28px 1fr auto;
  gap: 12px; align-items: center;
  padding: 10px 4px;
  border-bottom: 1px solid var(--wk-border);
}
.wkv2-conn__row:last-child { border-bottom: 0; }
.wkv2-conn__ico {
  width: 28px; height: 28px;
  border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  flex: none;
}
.wkv2-conn__label {
  font-size: 13px; color: var(--wk-ink); font-weight: 500;
  letter-spacing: -0.005em; line-height: 1.2;
  display: block;
}
.wkv2-conn__meta {
  display: block; font-size: 11px; color: var(--wk-ink-3);
  font-weight: 500; margin-top: 1px;
}
.wkv2-conn__btn {
  background: transparent; border: 0;
  font-family: 'Hanken Grotesk', sans-serif;
  font-size: 11.5px; font-weight: 600;
  color: var(--wk-ink-2);
  padding: 4px 8px; border-radius: var(--wk-r-sm);
  display: inline-flex; align-items: center; gap: 4px;
  white-space: nowrap; text-decoration: none;
}
.wkv2-conn__btn:hover { background: var(--wk-cream-2); color: var(--wk-ink); }
.wkv2-conn__btn--status:hover { background: transparent; color: var(--wk-ink-2); }
.wkv2-conn__btn--muted { color: var(--wk-ink-3); }
.wkv2-conn__btn--muted:hover { color: var(--wk-ink-3); }
.wkv2-conn__check {
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--wk-live); color: var(--wk-cream);
  display: inline-flex; align-items: center; justify-content: center;
  flex: none;
}

.wkv2-card--ink {
  background: var(--wk-ink);
  color: var(--wk-cream);
  border-color: transparent;
  padding: 22px;
  display: grid; gap: 14px;
}
.wkv2-card--ink .wkv2-card__h { color: rgba(245,237,227,.6); }
.wkv2-ink-h {
  margin: 0;
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 22px; line-height: 1.2;
  letter-spacing: -0.02em; color: var(--wk-cream);
}
.wkv2-ink-h em { color: var(--wk-peach-200); font-style: italic; }
.wkv2-ink-stats {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 16px; border-top: 1px solid rgba(245,237,227,.12);
  padding-top: 14px;
}
.wkv2-ink-stat__num {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 28px; letter-spacing: -0.02em;
  color: var(--wk-cream); line-height: 1;
}
.wkv2-ink-stat__lbl {
  margin-top: 4px;
  font-size: 11px; font-weight: 500;
  letter-spacing: 0.04em; text-transform: uppercase;
  color: rgba(245,237,227,.6);
}
.wkv2-ink-link {
  display: inline-flex; align-items: center; gap: 8px;
  color: var(--wk-cream); font-size: 13px; font-weight: 600;
  border-bottom: 1px solid rgba(245,237,227,.4);
  padding-bottom: 2px; text-decoration: none;
  align-self: flex-start; width: fit-content;
}
.wkv2-ink-link:hover { border-color: var(--wk-cream); }

@media (max-width: 980px) {
  .wkv2-grid { grid-template-columns: 1fr; }
  .wkv2-side { position: static; }
  .wkv2-stages { grid-template-columns: repeat(3, 1fr); }
  .wkv2-stage:nth-child(3) { border-right: 0; }
  .wkv2-stage:nth-child(n+4) { border-top: 1px solid var(--wk-border); }
  .wkv2-row { grid-template-columns: 48px 1fr; padding: 14px 16px; }
  .wkv2-row__right { grid-column: 1 / -1; flex-direction: row; align-items: center; justify-content: space-between; }
}
@media (max-width: 700px) {
  .wkv2-status__inner { grid-template-columns: 1fr; }
  .wkv2-status__cta { align-items: flex-start; }
  .wkv2-stages { grid-template-columns: repeat(2, 1fr); }
  .wkv2-act { grid-template-columns: 48px 1fr; }
  .wkv2-act__right {
    grid-column: 1 / -1; flex-direction: row;
    align-items: center; justify-content: space-between;
    min-width: 0;
  }
}
`

const PROFILE_STYLES = `
.wk-prof { padding: 32px 0 56px; background: var(--wk-cream); min-height: 60vh; }
.wk-prof__head {
  display: grid; grid-template-columns: 1fr auto;
  align-items: end; gap: 24px;
  margin: 4px 0 28px; padding-bottom: 20px;
  border-bottom: 1px solid var(--wk-border);
}
.wk-prof__h1 {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 36px; letter-spacing: -0.02em;
  line-height: 1.1; color: var(--wk-ink); margin: 0;
}
.wk-prof__sub {
  color: var(--wk-ink-2); font-size: 14.5px; line-height: 1.55;
  margin: 8px 0 0; max-width: 560px;
}
.wk-prof__head-actions { display: inline-flex; align-items: center; gap: 14px; }
.wk-prof__live {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 500;
  color: var(--wk-ink-2);
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-pill);
  padding: 6px 12px; white-space: nowrap;
}

.wk-prof__grid {
  display: grid; grid-template-columns: minmax(0, 1fr) 340px;
  gap: 24px; align-items: start;
}
.wk-prof__main { display: grid; gap: 18px; min-width: 0; }
.wk-prof__side { display: grid; gap: 18px; position: sticky; top: 88px; }

.wk-prof-card { padding: 22px 22px 20px; }
.wk-prof-card__hint {
  font-size: 12.5px; color: var(--wk-ink-3);
  margin: -6px 0 6px; line-height: 1.45;
}

.wk-prof-id { display: flex; align-items: center; gap: 18px; }
.wk-prof-id__body { min-width: 0; flex: 1; }
.wk-prof-id__name {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 26px; letter-spacing: -0.018em;
  line-height: 1.1; color: var(--wk-ink); margin: 0;
}
.wk-prof-id__headline { margin: 6px 0 0; font-size: 14px; color: var(--wk-ink-2); }
.wk-prof-id__meta { margin: 6px 0 0; font-size: 12.5px; color: var(--wk-ink-3); }

.wk-prof-rows { display: grid; gap: 10px; margin-top: 4px; }
.wk-prof-rows--stack { gap: 12px; }
.wk-prof-row {
  display: grid; grid-template-columns: 110px 1fr;
  gap: 14px; align-items: baseline;
  padding: 8px 0; border-bottom: 1px solid var(--wk-border);
  background: transparent; border-left: 0; border-right: 0; border-top: 0;
  text-align: left; font-family: inherit;
  width: 100%; appearance: none;
}
.wk-prof-row:last-child { border-bottom: 0; }
.wk-prof-row__label {
  font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--wk-ink-3);
}
.wk-prof-row__value {
  font-size: 14px; color: var(--wk-ink); line-height: 1.45;
}

.wk-prof-summary {
  margin: 12px 0 0;
  font-size: 13.5px; color: var(--wk-ink-2);
  line-height: 1.5;
  padding: 12px 14px;
  background: var(--wk-cream-2);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-sm);
}

.wk-prof-skills { gap: 6px; margin-top: 6px; }
.wk-prof-skill {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12.5px; padding: 5px 10px;
  border-radius: var(--wk-r-pill);
  background: var(--wk-cream-3);
  color: var(--wk-ink-2);
  border: 1px solid var(--wk-border);
}
.wk-prof-skill--add {
  background: transparent;
  border: 1px dashed var(--wk-border-strong);
  color: var(--wk-ink-2);
}

.wk-prof-privacy { display: grid; gap: 4px; margin-top: 4px; }
.wk-prof-privacy__row {
  display: grid; grid-template-columns: 1fr auto;
  gap: 12px; align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--wk-border);
  background: transparent; border-left: 0; border-right: 0; border-top: 0;
  width: 100%; cursor: pointer;
  text-align: left; font-family: inherit;
}
.wk-prof-privacy__row:last-child { border-bottom: 0; }
.wk-prof-privacy__row strong {
  display: block;
  font-family: 'Hanken Grotesk', sans-serif;
  font-weight: 600; font-size: 13.5px;
  color: var(--wk-ink);
}
.wk-prof-privacy__row em {
  display: block; font-style: normal;
  font-size: 12px; color: var(--wk-ink-3);
  margin-top: 2px; line-height: 1.4;
}
.wk-prof-toggle {
  width: 34px; height: 20px;
  border-radius: 999px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border-strong);
  position: relative;
  transition: background 180ms var(--wk-ease), border-color 180ms var(--wk-ease);
  display: inline-block;
}
.wk-prof-toggle > span {
  position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px;
  border-radius: 50%;
  background: var(--wk-ink-3);
  transition: transform 180ms var(--wk-ease), background 180ms var(--wk-ease);
  display: block;
}
.wk-prof-toggle.is-on { background: var(--wk-ink); border-color: var(--wk-ink); }
.wk-prof-toggle.is-on > span { transform: translateX(14px); background: var(--wk-cream); }

.wk-prof-form { display: grid; gap: 10px; margin-top: 4px; }
.wk-prof-form textarea,
.wk-prof-form__select {
  width: 100%;
  font-family: inherit; font-size: 14px;
  color: var(--wk-ink); background: var(--wk-cream);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-sm);
  padding: 10px 12px;
  transition: border-color 180ms var(--wk-ease);
}
.wk-prof-form textarea { resize: vertical; min-height: 90px; }
.wk-prof-form textarea:focus,
.wk-prof-form__select:focus {
  outline: none; border-color: var(--wk-ink);
  box-shadow: 0 0 0 3px rgba(45,26,10,.08);
}
.wk-prof-form button { justify-self: start; }

@media (max-width: 960px) {
  .wk-prof__grid { grid-template-columns: 1fr; }
  .wk-prof__side { position: static; }
}
@media (max-width: 640px) {
  .wk-prof__head { grid-template-columns: 1fr; align-items: start; }
  .wk-prof__h1 { font-size: 28px; }
  .wk-prof__live { display: none; }
  .wk-prof-row { grid-template-columns: 1fr; gap: 4px; }
}
`
