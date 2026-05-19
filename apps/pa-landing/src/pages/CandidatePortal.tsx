/**
 * CandidatePortal.tsx — `/me` and `/me/profile`.
 *
 * `/me` is the unified pipeline (Up next · In motion · New roles · Supply card ·
 * Claire status). `/me/profile` is the supply-card detail editor with profile
 * correction + privacy request panels.
 *
 * Integration logic (Firebase auth + paCandidateClaimProfile +
 * paCandidateListMatches + profile-correction + privacy-request callables)
 * is unchanged — only the rendering shell is new and shares atoms with
 * CandidateLogin / Landing / PublicJob.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { Link, useNavigate } from "react-router-dom"
import { onAuthStateChanged, signOut, type User } from "firebase/auth"
import { httpsCallable } from "firebase/functions"
import { auth, functions } from "../lib/firebase.js"
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
import {
  CandidateShell,
  Avatar,
  CompanyMark,
  Icon,
  LiveStatusPill,
  PulseDot,
} from "./CandidateLogin.js"

const LOGO_BG_POOL = ["#2A1812", "#0F1B2D", "#5E6AD2", "#635BFF", "#0D0D0D", "#1A1A1A", "#374151", "#7C2D12"]
const TONE_POOL: Array<"warm" | "moss" | "slate"> = ["warm", "slate", "moss"]

function djb2(s: string): number {
  let h = 5381 >>> 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0
  return h
}

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
    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      if (!user) {
        setState({ status: "signed_out" })
        return
      }
      setState({ status: "loading" })
      void (async () => {
        try {
          const claimProfile = httpsCallable<{ browserUid?: string | null }, CandidateClaimResult>(
            functions(),
            "paCandidateClaimProfile"
          )
          const browserUid = readStoredValue(GLOBAL_UID_KEY)
          const result = await claimProfile({ browserUid })
          if (!cancelled) {
            setState({ status: "ready", user, profile: result.data.selfProfile })
          }
        } catch (err) {
          console.error("candidate profile claim failed", err)
          if (!cancelled) {
            setState({ status: "error", message: profileLoadErrorMessage(err) })
          }
        }
      })()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return state
}

function profileLoadErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/unauthenticated|sign in/i.test(raw)) {
    return "Your session expired. Sign in again to load your WeKruit profile."
  }
  if (/failed-precondition|operator review|conflict/i.test(raw)) {
    return "We need to review this profile before showing it here."
  }
  return "We could not load your profile just now. Refresh the page, or sign in again if this keeps happening."
}

// ────────────────────────────────────────────────────────────────────────────
// Matches data — same `paCandidateListMatches` callable as before
// ────────────────────────────────────────────────────────────────────────────

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
          "paCandidateListMatches"
        )
        const result = await listMatches({ limit: 25 })
        if (!cancelled) setState({ status: "ready", matches: result.data.matches })
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  return state
}

// ────────────────────────────────────────────────────────────────────────────
// /me — unified pipeline
// ────────────────────────────────────────────────────────────────────────────

export function CandidateMe() {
  const profileState = useClaimedProfile()
  const matchesState = useCandidateMatches(profileState.status === "ready")

  if (profileState.status === "signed_out") {
    return <SignInRequired kicker="Your pipeline" />
  }
  if (profileState.status === "loading") {
    return <PortalLoading kicker="Your pipeline" />
  }
  if (profileState.status === "error") {
    return <PortalError kicker="Your pipeline" message={profileState.message} />
  }

  const profile = profileState.profile
  const matches = matchesState.status === "ready" ? matchesState.matches : []
  const upNext = matches.filter((m) => m.status === "invited" || m.status === "interview_started")
  const inMotion = matches.filter((m) => m.status === "passed")
  const newRoles = matches.filter((m) => m.status === "recommended")
  const upNextCount = upNext.length
  const matchesLoading = matchesState.status === "loading" || matchesState.status === "idle"
  const matchesErrored = matchesState.status === "error"
  const matchesError = matchesState.status === "error" ? matchesState.message : null
  const firstName = greetingName(profile)

  return (
    <CandidateShell>
      <style>{CANDIDATE_PORTAL_STYLES}</style>
      <div className="wk-me">
        <div className="wk-container">
          <header className="wk-me__head">
            <p className="wk-eyebrow"><PulseDot size={6} /> Your pipeline · live</p>
            <h1 className="wk-me__h1">
              {upNextCount > 0 ? (
                <>
                  <em className="wk-accent">{upNextCount}</em> need{upNextCount === 1 ? "s" : ""} something from you.
                </>
              ) : (
                <>Welcome back{firstName ? `, ${firstName}` : ""}.</>
              )}
            </h1>
            <p className="wk-me__lede">
              Active interviews and new matches in one place. Claire keeps it current —
              you don't track anything.
            </p>
          </header>

          <PipelineSection
            title="Up next"
            sub="Waiting on you"
            empty="Nothing waiting on you right now. Claire will text you when she lines something up."
            loading={matchesLoading}
            error={matchesErrored ? matchesError : null}
            cards={upNext}
            ctaTone="primary"
          />
          <PipelineSection
            title="In motion"
            sub="Employer is moving. You're done for now."
            empty="No active screens — finish an Up next item and you'll see it here while the hiring manager reviews."
            loading={matchesLoading}
            error={null}
            cards={inMotion}
            ctaTone="secondary"
          />
          <NewRolesSection
            loading={matchesLoading}
            error={null}
            cards={newRoles}
          />

          <section className="wk-me__bottom">
            <SupplyCard profile={profile} />
            <ClaireStatusCard />
          </section>

          <div className="wk-me__signout">
            <button
              type="button"
              className="wk-btn wk-btn--ghost wk-btn--sm"
              onClick={() => void signOut(auth())}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </CandidateShell>
  )
}

function greetingName(profile: CandidateSelfProfile): string {
  const raw = profile.displayName?.trim() ?? ""
  if (!raw) return ""
  return raw.split(/\s+/)[0]
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline + match cards
// ────────────────────────────────────────────────────────────────────────────

function PipelineSection({
  title,
  sub,
  empty,
  loading,
  error,
  cards,
  ctaTone,
}: {
  title: string
  sub: string
  empty: string
  loading: boolean
  error: string | null
  cards: CandidateMatchCard[]
  ctaTone: "primary" | "secondary"
}) {
  return (
    <section className="wk-me__group">
      <header className="wk-me__group-head">
        <h2 className="wk-me__h2">{title}</h2>
        <span className="wk-me__group-sub">{sub}</span>
      </header>
      {loading ? (
        <div className="wk-me__placeholder">Loading…</div>
      ) : error ? (
        <div className="wk-me__placeholder wk-me__placeholder--error">{error}</div>
      ) : cards.length === 0 ? (
        <div className="wk-me__placeholder">{empty}</div>
      ) : (
        <div className="wk-me__list">
          {cards.map((c) => <PipeRow key={c.matchId} match={c} ctaTone={ctaTone} />)}
        </div>
      )}
    </section>
  )
}

function PipeRow({ match, ctaTone }: { match: CandidateMatchCard; ctaTone: "primary" | "secondary" }) {
  const display = getCandidateJobStatusDisplay(match.status, match.job.title)
  const h = djb2(match.jobId || match.job.company)
  const logo = (match.job.company[0] ?? "?").toUpperCase()
  const logoBg = LOGO_BG_POOL[h % LOGO_BG_POOL.length]
  return (
    <article className="wk-pipe">
      <div className="wk-pipe__left">
        <CompanyMark logo={logo} bg={logoBg} size={48} />
      </div>
      <div className="wk-pipe__body">
        <div className="wk-pipe__row">
          <h3 className="wk-pipe__title">{match.job.title}</h3>
          <StageBadge status={match.status} />
        </div>
        <p className="wk-pipe__company">
          {match.job.company}
          {match.job.location ? ` · ${match.job.location}` : ""}
        </p>
        <p className="wk-pipe__next">{display.nextStep}</p>
      </div>
      <div className="wk-pipe__right">
        <Link
          to={match.job.href}
          className={`wk-btn wk-btn--${ctaTone} wk-btn--sm`}
        >
          {display.ctaLabel} <Icon name="arrow-right" size={14} stroke={2} />
        </Link>
      </div>
    </article>
  )
}

function StageBadge({ status }: { status: CandidateJobStatus }) {
  if (status === "invited") return <LiveStatusPill>Invited</LiveStatusPill>
  if (status === "interview_started")
    return (
      <span className="wk-stage wk-stage--blue">
        <PulseDot size={6} color="#1f6feb" /> Claire is asking
      </span>
    )
  if (status === "passed")
    return (
      <span className="wk-stage wk-stage--warm">
        <Icon name="check" size={11} stroke={2.4} /> Passed screen
      </span>
    )
  if (status === "recommended") return <span className="wk-stage wk-stage--warm">New match</span>
  if (status === "not_passed") return <span className="wk-stage wk-stage--muted">Not passed</span>
  if (status === "paused") return <span className="wk-stage wk-stage--muted">Paused</span>
  return null
}

function NewRolesSection({
  loading,
  error,
  cards,
}: {
  loading: boolean
  error: string | null
  cards: CandidateMatchCard[]
}) {
  return (
    <section className="wk-me__group">
      <header className="wk-me__group-head">
        <h2 className="wk-me__h2">New roles for you</h2>
        <span className="wk-me__group-sub">Claire matched these this week.</span>
      </header>
      {loading ? (
        <div className="wk-me__placeholder">Loading…</div>
      ) : error ? (
        <div className="wk-me__placeholder wk-me__placeholder--error">{error}</div>
      ) : cards.length === 0 ? (
        <div className="wk-me__placeholder">
          No new matches this week. Claire is still hunting — she'll text when something fits.
        </div>
      ) : (
        <div className="wk-matches">
          {cards.map((m) => <NewRoleCard key={m.matchId} match={m} />)}
        </div>
      )}
    </section>
  )
}

function NewRoleCard({ match }: { match: CandidateMatchCard }) {
  const h = djb2(match.jobId || match.job.company)
  const logo = (match.job.company[0] ?? "?").toUpperCase()
  const logoBg = LOGO_BG_POOL[h % LOGO_BG_POOL.length]
  return (
    <article className="wk-match">
      <div className="wk-match__top">
        <div className="wk-match__co">
          <CompanyMark logo={logo} bg={logoBg} size={44} />
          <div>
            <h3 className="wk-match__title">{match.job.title}</h3>
            <p className="wk-match__company">
              {match.job.company}
              {match.job.location ? ` · ${match.job.location}` : ""}
            </p>
          </div>
        </div>
        <span className="wk-stage wk-stage--warm">New match</span>
      </div>
      {match.whyMatched.length ? (
        <div className="wk-match__why">
          <span className="wk-eyebrow">Why this matches</span>
          <ul>
            {match.whyMatched.slice(0, 4).map((w) => (
              <li key={w}><Icon name="check" size={12} stroke={2.2} /> {w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="wk-match__footer">
        {match.job.salaryRange ? (
          <span className="wk-match__salary">{match.job.salaryRange}</span>
        ) : <span />}
        <Link to={match.job.href} className="wk-btn wk-btn--primary wk-btn--sm">
          See role <Icon name="arrow-right" size={14} stroke={2} />
        </Link>
      </div>
    </article>
  )
}

function SupplyCard({ profile }: { profile: CandidateSelfProfile }) {
  const tone: "warm" | "moss" | "slate" = TONE_POOL[djb2(profile.displayName ?? "you") % TONE_POOL.length]
  const tags = profile.globalTags
  const rows: Array<{ label: string; value: string }> = []
  if (tags?.roleFunction?.length) {
    rows.push({ label: "Role", value: tags.roleFunction.slice(0, 3).map(formatProfileValue).join(", ") })
  }
  if (tags?.targetLocations?.length) {
    rows.push({ label: "Where", value: tags.targetLocations.slice(0, 3).map(formatProfileValue).join(", ") })
  }
  if (tags?.industrySector?.length) {
    rows.push({ label: "Industry", value: tags.industrySector.slice(0, 3).map(formatProfileValue).join(", ") })
  }
  if (tags?.targetJobType?.length) {
    rows.push({ label: "Type", value: tags.targetJobType.slice(0, 3).map(formatProfileValue).join(", ") })
  }
  if (profile.linkedinUrl) {
    rows.push({ label: "LinkedIn", value: "Connected" })
  }
  if (profile.latestResumeArtifactId) {
    rows.push({ label: "Resume", value: "Parsed and attached" })
  }
  if (rows.length === 0) {
    rows.push({ label: "Status", value: formatProfileStatus(profile.lifecycleState) })
  }
  return (
    <div className="wk-me-card wk-me-card--profile">
      <div className="wk-me-card__profile-head">
        <Avatar name={profile.displayName ?? "You"} size={48} tone={tone} />
        <div>
          <p className="wk-eyebrow">What employers see</p>
          <h3 className="wk-me-card__h">Your supply card</h3>
        </div>
      </div>
      <ul className="wk-me-card__list">
        {rows.slice(0, 5).map((row) => (
          <li key={row.label}>
            <strong>{row.label}</strong>
            <span>{row.value}</span>
          </li>
        ))}
      </ul>
      <Link to="/me/profile" className="wk-btn wk-btn--primary wk-btn--block">
        Edit my supply card <Icon name="arrow-right" size={14} stroke={2} />
      </Link>
    </div>
  )
}

function ClaireStatusCard() {
  return (
    <div className="wk-me-card wk-me-card--ink">
      <p className="wk-eyebrow wk-me-card__eyebrow-light">This week</p>
      <h3 className="wk-me-card__h wk-me-card__h-light">
        Claire keeps your profile in front of hiring managers — <em className="wk-accent">no application form</em>.
      </h3>
      <p className="wk-me-card__copy-light">
        New matches and active interviews land here automatically. You only see the
        managers who said yes.
      </p>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /me/profile — supply-card detail editor
// ────────────────────────────────────────────────────────────────────────────

export function CandidateProfile() {
  const state = useClaimedProfile()
  if (state.status === "signed_out") return <SignInRequired kicker="Supply card" />
  if (state.status === "loading") return <PortalLoading kicker="Supply card" />
  if (state.status === "error") return <PortalError kicker="Supply card" message={state.message} />
  return (
    <CandidateShell>
      <style>{CANDIDATE_PORTAL_STYLES}</style>
      <div className="wk-me wk-me--profile">
        <div className="wk-container wk-me__profile">
          <header className="wk-me__head">
            <p className="wk-eyebrow"><Link to="/me" className="wk-link">← Back to pipeline</Link></p>
            <h1 className="wk-me__h1">{state.profile.displayName ?? "Your supply card"}</h1>
            <p className="wk-me__lede">
              Edit what employers see when Claire pitches you. Tags below come from your
              resume and conversations with Claire. Use the correction box to refine.
            </p>
          </header>
          <ProfileDetails profile={state.profile} />
        </div>
      </div>
    </CandidateShell>
  )
}

function ProfileDetails({ profile }: { profile: CandidateSelfProfile }) {
  const [currentProfile, setCurrentProfile] = useState(profile)
  const tags = currentProfile.globalTags
  const resumeLabel = currentProfile.latestResumeArtifactId ? "Parsed and attached" : "Add a resume to unlock better matches"
  const linkedinLabel = currentProfile.linkedinUrl ? "Connected" : "Not connected"

  useEffect(() => {
    setCurrentProfile(profile)
  }, [profile])

  return (
    <>
      <section className="wk-me-card wk-me-card--profile-detail">
        <h2 className="wk-me-card__h">Identity</h2>
        <dl className="wk-profile-list">
          <ProfileRow label="Profile status" value={formatProfileStatus(currentProfile.lifecycleState)} />
          <ProfileRow label="Email" value={currentProfile.emailMasked ?? "Not set"} />
          <ProfileRow label="Phone" value={currentProfile.phoneMasked ?? "Not set"} />
          <ProfileRow label="Resume" value={resumeLabel} />
          <ProfileRow label="LinkedIn" value={linkedinLabel} />
        </dl>
      </section>

      {currentProfile.profileSummary ? (
        <section className="wk-me-card wk-me-card--profile-detail">
          <h2 className="wk-me-card__h">How Claire describes you</h2>
          <p className="wk-profile-summary">{currentProfile.profileSummary}</p>
        </section>
      ) : null}

      {tags ? (
        <section className="wk-me-card wk-me-card--profile-detail">
          <h2 className="wk-me-card__h">Tags</h2>
          <div className="wk-tag-groups">
            <TagGroup label="Roles" values={tags.roleFunction} />
            <TagGroup label="Skills" values={tags.skills} />
            <TagGroup label="Industries" values={tags.industrySector} />
            <TagGroup label="Locations" values={tags.targetLocations} />
            <TagGroup label="Job types" values={tags.targetJobType} />
            <TagGroup label="Tags" values={tags.relevantTags} />
          </div>
        </section>
      ) : null}

      <ProfileCorrectionPanel onProfileUpdated={setCurrentProfile} />
      <PrivacyRequestPanel />
    </>
  )
}

function ProfileCorrectionPanel({
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
      setMessage(err instanceof Error ? err.message : String(err))
      setStatus("error")
    }
  }

  return (
    <section className="wk-me-card wk-me-card--profile-detail" aria-labelledby="candidate-correction-title">
      <h2 id="candidate-correction-title" className="wk-me-card__h">Update preferences</h2>
      <form onSubmit={onSubmit} className="wk-form">
        <label>
          <span>Correction</span>
          <textarea
            value={correctionText}
            onChange={(event) => setCorrectionText(event.target.value)}
            disabled={status === "submitting"}
            rows={4}
            placeholder="Example: I prefer product roles in New York or remote, and I want to avoid early-stage startups."
          />
        </label>
        <button
          type="submit"
          className="wk-btn wk-btn--primary"
          disabled={status === "submitting" || correctionText.trim().length === 0}
        >
          {status === "submitting" ? "Submitting…" : "Submit correction"}
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
      setMessage(err instanceof Error ? err.message : String(err))
      setStatus("error")
    }
  }

  return (
    <section className="wk-me-card wk-me-card--profile-detail" aria-labelledby="candidate-privacy-title">
      <h2 id="candidate-privacy-title" className="wk-me-card__h">Privacy requests</h2>
      <form onSubmit={onSubmit} className="wk-form">
        <label>
          <span>Request</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as CandidatePrivacyRequestKind)}
            disabled={status === "submitting"}
          >
            {PRIVACY_REQUEST_OPTIONS.map((option) => (
              <option key={option.kind} value={option.kind}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Details</span>
          <textarea
            value={detailText}
            onChange={(event) => setDetailText(event.target.value)}
            disabled={status === "submitting"}
            rows={3}
            placeholder="Add context for the operator review."
          />
        </label>
        <button type="submit" className="wk-btn wk-btn--primary" disabled={status === "submitting"}>
          {status === "submitting" ? "Submitting…" : "Submit request"}
        </button>
      </form>
      {status === "success" && message ? <p className="wk-success">{message}</p> : null}
      {status === "error" && message ? <p className="wk-error">{message}</p> : null}
    </section>
  )
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function TagGroup({ label, values }: { label: string; values?: string[] }) {
  if (!values || values.length === 0) return null
  return (
    <div className="wk-tag-group">
      <h3>{label}</h3>
      <div className="wk-tag-row">
        {values.slice(0, 24).map((value) => (
          <span key={value} className="wk-tag">{formatProfileValue(value)}</span>
        ))}
      </div>
    </div>
  )
}

export function formatProfileStatus(value: string) {
  if (value === "claimed") return "Signed in and verified"
  if (value === "prospect") return "Profile created"
  return formatProfileValue(value)
}

export function formatProfileValue(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

// ────────────────────────────────────────────────────────────────────────────
// Shared shell-state cards (signed-out, loading, error)
// ────────────────────────────────────────────────────────────────────────────

function PortalCard({ kicker, children }: { kicker: string; children: ReactNode }) {
  return (
    <CandidateShell>
      <style>{CANDIDATE_PORTAL_STYLES}</style>
      <div className="wk-me">
        <div className="wk-container">
          <section className="wk-me-card wk-me-card--state">
            <p className="wk-eyebrow">{kicker}</p>
            {children}
          </section>
        </div>
      </div>
    </CandidateShell>
  )
}

function SignInRequired({ kicker }: { kicker: string }) {
  const navigate = useNavigate()
  return (
    <PortalCard kicker={kicker}>
      <h1 className="wk-me-card__h">Sign in required</h1>
      <p className="wk-me-card__copy">Sign in to load your candidate profile, pipeline, and matches.</p>
      <button
        type="button"
        className="wk-btn wk-btn--primary"
        onClick={() => navigate("/login")}
      >
        Sign in <Icon name="arrow-right" size={14} stroke={2} />
      </button>
    </PortalCard>
  )
}

function PortalLoading({ kicker }: { kicker: string }) {
  return (
    <PortalCard kicker={kicker}>
      <h1 className="wk-me-card__h">Loading…</h1>
      <p className="wk-me-card__copy">Checking your signed-in WeKruit profile.</p>
    </PortalCard>
  )
}

function PortalError({ kicker, message }: { kicker: string; message: string }) {
  const navigate = useNavigate()
  return (
    <PortalCard kicker={kicker}>
      <h1 className="wk-me-card__h">Profile unavailable</h1>
      <p className="wk-error">{message}</p>
      <button
        type="button"
        className="wk-btn wk-btn--primary"
        onClick={() => navigate("/login")}
      >
        Sign in again <Icon name="arrow-right" size={14} stroke={2} />
      </button>
    </PortalCard>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Styles
// ────────────────────────────────────────────────────────────────────────────

const CANDIDATE_PORTAL_STYLES = `
.wk-me { padding: 56px 0 32px; background: var(--wk-cream); min-height: 60vh; }
.wk-me__head { display: grid; gap: 10px; margin-bottom: 48px; max-width: 720px; }
.wk-me__head .wk-eyebrow .wk-link { border-bottom: 0; }
.wk-me__h1 {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: clamp(36px, 5vw, 60px);
  line-height: 1.04; letter-spacing: -0.024em;
  color: var(--wk-ink); margin: 4px 0 0;
}
.wk-me__lede {
  color: var(--wk-ink-2); font-size: 16.5px; line-height: 1.5;
  margin: 8px 0 0; max-width: 580px;
}

.wk-me__group { margin-bottom: 56px; }
.wk-me__group-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 16px; flex-wrap: wrap;
  margin-bottom: 16px; padding-bottom: 12px;
  border-bottom: 1px solid var(--wk-border);
}
.wk-me__h2 {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 26px; letter-spacing: -0.018em;
  line-height: 1.15; color: var(--wk-ink); margin: 0;
}
.wk-me__group-sub { color: var(--wk-ink-3); font-size: 13.5px; font-weight: 500; }
.wk-me__list { display: grid; gap: 12px; }
.wk-me__placeholder {
  padding: 20px 22px;
  background: var(--wk-cream-3);
  border: 1px dashed var(--wk-border);
  border-radius: var(--wk-r-md);
  color: var(--wk-ink-3);
  font-size: 14.5px; line-height: 1.5;
}
.wk-me__placeholder--error { color: #9c2b24; border-color: #c8896e; }

/* Pipeline rows */
.wk-pipe {
  display: grid; grid-template-columns: auto 1fr auto;
  gap: 20px; align-items: center;
  padding: 20px 22px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  transition: border-color 200ms var(--wk-ease),
              box-shadow 200ms var(--wk-ease),
              transform 200ms var(--wk-ease);
}
.wk-pipe:hover {
  border-color: var(--wk-live-border);
  box-shadow: 0 8px 24px -8px rgba(45,26,10,.12);
  transform: translateY(-1px);
}
.wk-pipe__row {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 14px; flex-wrap: wrap;
}
.wk-pipe__title {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 20px; letter-spacing: -0.018em;
  line-height: 1.2; color: var(--wk-ink); margin: 0;
  flex: 1 1 240px; min-width: 0;
}
.wk-pipe__company { color: var(--wk-ink-3); font-size: 13.5px; margin: 4px 0 0; }
.wk-pipe__next {
  color: var(--wk-ink-2); font-size: 14.5px;
  line-height: 1.45; margin: 8px 0 0;
}
.wk-pipe__right {
  display: flex; flex-direction: column; align-items: flex-end;
  gap: 10px; min-width: 160px;
}

/* Stage chip variants */
.wk-stage {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 11px; border-radius: var(--wk-r-pill);
  font-size: 12.5px; font-weight: 600;
  line-height: 1; letter-spacing: -0.005em;
}
.wk-stage--blue { background: rgba(31,111,235,.10); color: #1f6feb; }
.wk-stage--warm {
  background: var(--wk-peach-50); color: var(--wk-ink);
  border: 1px solid var(--wk-peach-100);
}
.wk-stage--muted {
  background: var(--wk-cream-2); color: var(--wk-ink-3);
  border: 1px solid var(--wk-border);
}

/* Match cards */
.wk-matches {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 14px;
}
.wk-match {
  display: flex; flex-direction: column; gap: 14px;
  padding: 22px 24px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  transition: border-color 200ms var(--wk-ease),
              box-shadow 200ms var(--wk-ease),
              transform 200ms var(--wk-ease);
}
.wk-match:hover {
  border-color: var(--wk-live-border);
  box-shadow: 0 8px 24px -8px rgba(45,26,10,.12);
  transform: translateY(-1px);
}
.wk-match__top {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 14px; flex-wrap: wrap;
}
.wk-match__co {
  display: flex; align-items: flex-start; gap: 14px;
  flex: 1 1 240px; min-width: 0;
}
.wk-match__title {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 22px; letter-spacing: -0.02em;
  line-height: 1.18; color: var(--wk-ink); margin: 0;
}
.wk-match__company { color: var(--wk-ink-3); font-size: 14px; margin: 4px 0 0; }
.wk-match__why {
  display: grid; gap: 8px;
  padding: 14px 16px;
  background: var(--wk-cream-2);
  border-radius: var(--wk-r-sm);
  border: 1px solid var(--wk-border);
}
.wk-match__why ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.wk-match__why li {
  display: flex; align-items: center; gap: 8px;
  color: var(--wk-ink-2); font-size: 14px;
}
.wk-match__why li svg { color: var(--wk-live); }
.wk-match__footer {
  display: flex; align-items: center; justify-content: space-between;
  gap: 14px; flex-wrap: wrap;
  padding-top: 4px;
}
.wk-match__salary {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 20px; letter-spacing: -0.018em;
  color: var(--wk-ink);
}

/* Bottom row */
.wk-me__bottom {
  display: grid; grid-template-columns: 1.2fr 1fr;
  gap: 16px; margin-top: 16px;
}
.wk-me-card {
  display: flex; flex-direction: column; gap: 14px;
  padding: 24px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
}
.wk-me-card__profile-head { display: flex; align-items: center; gap: 14px; }
.wk-me-card__h {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 22px; letter-spacing: -0.018em;
  line-height: 1.18; color: var(--wk-ink);
  margin: 4px 0 0;
}
.wk-me-card__h-light { color: var(--wk-cream); }
.wk-me-card__eyebrow-light { color: rgba(245,237,227,.65) !important; }
.wk-me-card__copy-light {
  color: rgba(245,237,227,.78);
  margin: 4px 0 0; font-size: 14.5px; line-height: 1.5;
}
.wk-me-card__copy {
  color: var(--wk-ink-2);
  margin: 0; font-size: 14.5px; line-height: 1.5;
}
.wk-me-card__list {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: 8px;
}
.wk-me-card__list li {
  display: grid; grid-template-columns: 90px 1fr;
  gap: 12px; font-size: 14px; color: var(--wk-ink-2);
  padding-bottom: 8px; border-bottom: 1px dashed var(--wk-border);
}
.wk-me-card__list li:last-child { border-bottom: 0; padding-bottom: 0; }
.wk-me-card__list strong {
  font-family: 'Hanken Grotesk', sans-serif;
  font-weight: 500; font-size: 11.5px;
  color: var(--wk-ink-3);
  text-transform: uppercase; letter-spacing: 0.06em;
  align-self: center;
}
.wk-me-card--ink {
  background: var(--wk-ink); color: var(--wk-cream);
  border-color: transparent;
}
.wk-me-card--ink em.wk-accent { color: var(--wk-peach-200); }
.wk-me-card--state { gap: 12px; max-width: 560px; margin: 80px auto 0; }

.wk-me__signout {
  display: flex; justify-content: center;
  margin: 24px 0 8px;
}

/* Profile detail */
.wk-me--profile .wk-me__profile { max-width: 880px; }
.wk-me-card--profile-detail { gap: 14px; }
.wk-profile-list {
  display: grid; gap: 1px; margin: 8px 0 0;
  background: var(--wk-border);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-sm);
  overflow: hidden;
}
.wk-profile-list > div {
  display: grid; grid-template-columns: 140px 1fr;
  gap: 12px; padding: 12px 14px;
  background: var(--wk-cream-3);
}
.wk-profile-list dt {
  color: var(--wk-ink-3); font-weight: 600;
  font-size: 12.5px; letter-spacing: 0.04em;
  text-transform: uppercase;
}
.wk-profile-list dd {
  margin: 0; color: var(--wk-ink);
  font-size: 14.5px; overflow-wrap: anywhere;
}
.wk-profile-summary {
  color: var(--wk-ink-2); margin: 0;
  font-size: 15px; line-height: 1.55;
}
.wk-tag-groups { display: grid; gap: 16px; }
.wk-tag-group h3 {
  margin: 0 0 8px; font-size: 13px;
  font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--wk-ink-3);
}
.wk-tag-row {
  display: flex; flex-wrap: wrap; gap: 6px;
}
.wk-tag {
  display: inline-flex; align-items: center;
  padding: 5px 10px; border-radius: var(--wk-r-pill);
  background: var(--wk-cream-2);
  border: 1px solid var(--wk-border);
  color: var(--wk-ink-2);
  font-size: 12.5px; font-weight: 500;
}
.wk-form { display: grid; gap: 12px; }
.wk-form label {
  display: grid; gap: 6px;
  color: var(--wk-ink-2); font-size: 13px; font-weight: 500;
}
.wk-form textarea,
.wk-form select {
  width: 100%;
  font-family: inherit; font-size: 14.5px;
  color: var(--wk-ink); background: var(--wk-cream);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  padding: 10px 12px;
  transition: border-color 200ms var(--wk-ease);
}
.wk-form textarea { resize: vertical; min-height: 90px; }
.wk-form textarea:focus,
.wk-form select:focus {
  outline: none; border-color: var(--wk-ink);
  box-shadow: 0 0 0 3px rgba(45,26,10,.08);
}
.wk-form button { justify-self: start; }

@media (max-width: 980px) {
  .wk-me__bottom { grid-template-columns: 1fr; }
  .wk-matches { grid-template-columns: 1fr; }
  .wk-pipe { grid-template-columns: auto 1fr; }
  .wk-pipe__right {
    grid-column: 1 / -1;
    flex-direction: row; align-items: center;
    justify-content: flex-end; min-width: 0;
  }
}
@media (max-width: 640px) {
  .wk-profile-list > div { grid-template-columns: 1fr; gap: 4px; }
}
`
