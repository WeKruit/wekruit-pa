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
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
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
  deriveCandidateOperatingLoop,
  type CandidateOperatingLoop,
} from "./CandidatePortalLoop.helpers.js"
import {
  CandidateShell,
  Avatar,
  CompanyMark,
  Icon,
  PulseDot,
  buildClaireImessageHref,
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
  /** WeKruit-collaborated job → pre-screen CTA + viewable session/status. */
  collab?: boolean
  job: {
    title: string
    company: string
    location?: string
    salaryRange?: string
    href: string
    /** External source listing — non-collab recommendations open this for inspection. */
    applyUrl?: string
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

type MatchesSnapshot =
  | { status: "idle" | "loading" }
  | { status: "ready"; matches: CandidateMatchCard[] }
  | { status: "error"; message: string }

type MatchesState = MatchesSnapshot & {
  reload: () => void
}

export function useCandidateMatches(enabled: boolean): MatchesState {
  const [state, setState] = useState<MatchesSnapshot>({ status: "idle" })
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])

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
  }, [enabled, tick])

  return { ...state, reload }
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
    return "We need to finish setting up your profile before roles show. Open Profile to fill in the basics."
  }
  if (code === "functions/permission-denied" || /permission-denied/i.test(rawMessage)) {
    return "This account isn't authorized to view matches."
  }
  if (code === "functions/deadline-exceeded" || /timeout|deadline/i.test(rawMessage)) {
    return "Roles took too long to load. Refresh in a moment."
  }
  if (
    code === "functions/internal" ||
    code === "functions/unavailable" ||
    rawMessage === "internal" ||
    /network|fetch|cors|503|429/i.test(rawMessage)
  ) {
    return "Roles are temporarily unavailable. We'll keep retrying — try refreshing in a moment."
  }
  return "We couldn't load your roles just now. Refresh the page, or sign in again if this keeps happening."
}

// Generic translator for callable mutations (corrections, privacy requests).
// Never echo callable detail directly; those messages often contain backend
// state names that are not useful to candidates.
function callableSubmitErrorMessage(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : ""
  const raw = err instanceof Error ? err.message : String(err)
  if (code === "functions/unauthenticated" || /unauthenticated|sign in/i.test(raw)) {
    return "Sign in again to submit this."
  }
  if (code === "functions/failed-precondition" || /failed-precondition|operator review|not linked/i.test(raw)) {
    return "We need to review your profile before saving this."
  }
  if (code === "functions/invalid-argument" || /invalid-argument/i.test(raw)) {
    return "Review the form and try again. Claire can still update this from your message."
  }
  if (
    code === "functions/internal" ||
    code === "functions/unavailable" ||
    raw === "internal" ||
    /network|fetch|cors|503|429/i.test(raw)
  ) {
    return "Submit failed — service is briefly unavailable. Try again in a moment."
  }
  return "That did not submit. Try again in a moment, or message Claire if this is urgent."
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers — humanize canonical-tag tokens, derive sidebar data from schema
// ────────────────────────────────────────────────────────────────────────────

// Humanize canonical tag tokens for display (single source of tag labels).
// Overrides for the awkward ones; general rule handles the rest (_and_ → &,
// underscores → spaces, Title Case, known acronyms upper-cased).
const TAG_LABEL_OVERRIDES: Record<string, string> = {
  artificial_intelligence_and_machine_learning: "AI & Machine Learning",
  software_and_saas: "Software & SaaS",
  crypto_web3_blockchain: "Crypto / Web3",
  e_commerce_and_retail: "E-commerce & Retail",
  healthcare_and_life_sciences: "Healthcare & Life Sciences",
  human_resources_and_recruiting: "HR & Recruiting",
  non_profit_and_social_impact: "Non-profit & Social Impact",
  clean_energy_and_climate_tech: "Clean Energy & Climate Tech",
  real_estate_and_proptech: "Real Estate & PropTech",
  agriculture_and_foodtech: "Agriculture & FoodTech",
  accessibility_and_assistive_technology: "Accessibility & Assistive Tech",
  research_and_academia: "Research & Academia",
  media_and_entertainment: "Media & Entertainment",
  hardware_and_semiconductors: "Hardware & Semiconductors",
  transportation_and_logistics: "Transportation & Logistics",
  automotive_and_mobility: "Automotive & Mobility",
  aerospace_and_defense: "Aerospace & Defense",
  energy_and_utilities: "Energy & Utilities",
  manufacturing_and_industrial: "Manufacturing & Industrial",
  construction_and_built_environment: "Construction & Built Environment",
  hospitality_and_travel: "Hospitality & Travel",
  advertising_and_marketing: "Advertising & Marketing",
  professional_services: "Professional Services",
  accounting_and_audit: "Accounting & Audit",
  sports_and_recreation: "Sports & Recreation",
  fashion_and_apparel: "Fashion & Apparel",
  beauty_and_personal_care: "Beauty & Personal Care",
  arts_and_culture: "Arts & Culture",
  robotics_and_automation: "Robotics & Automation",
  technology_general: "Technology (general)",
  education_technology: "Education Technology",
  // role function
  engineering_and_development: "Engineering & Development",
  software_engineering: "Software Engineering",
  product_management: "Product Management",
  customer_service_and_support: "Customer Service & Support",
  legal_and_compliance: "Legal & Compliance",
  management_and_executive: "Management & Executive",
  public_sector_and_government: "Public Sector & Government",
  arts_and_entertainment: "Arts & Entertainment",
  creatives_and_design: "Creatives & Design",
  accounting_and_finance: "Accounting & Finance",
  education_and_training: "Education & Training",
  human_resources: "Human Resources",
  data_analysis: "Data Analysis",
  business_analyst: "Business Analyst",
  // company stage
  pre_seed: "Pre-seed",
  series_a: "Series A",
  series_b: "Series B",
  series_c: "Series C",
  series_d_plus: "Series D+",
  ipo_public: "IPO / Public",
  private_mature: "Private (mature)",
  non_profit: "Non-profit",
  // company size (orchestrator enum)
  early_startup: "Early-stage startup",
  scale_up: "Scale-up",
  mid_market: "Mid-market",
  enterprise: "Enterprise",
  open: "Any size",
  // job type
  full_time: "Full-time",
  part_time: "Part-time",
  new_graduate: "New graduate",
  co_op_rotation: "Co-op / Rotation",
  return_to_work_program: "Return-to-work",
  // career stage
  c_level: "C-level",
  vp: "VP",
  entry_level: "Entry level",
  mid_level: "Mid level",
  // visa
  citizen: "U.S. citizen",
  permanent_resident: "Permanent resident",
  sponsor_needed: "Needs sponsorship",
}
const TAG_ACRONYMS = new Set([
  "ai", "ml", "api", "saas", "hr", "it", "ux", "ui", "qa", "sql", "vp",
  "ceo", "cto", "cfo", "b2b", "b2c", "sdk", "ar", "vr", "iot", "ev", "gtm",
])

function profileValueText(value: unknown): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of ["name", "label", "token", "value"]) {
      const candidate = record[key]
      if (typeof candidate === "string" && candidate.trim()) return candidate
    }
  }
  return ""
}

export function formatProfileValue(value: unknown): string {
  const raw = profileValueText(value)
  const key = raw.trim().toLowerCase()
  if (!key) return ""
  if (TAG_LABEL_OVERRIDES[key]) return TAG_LABEL_OVERRIDES[key]
  return raw
    .replace(/_and_/g, " & ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (TAG_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
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

function joinTags(values: readonly unknown[] | undefined, max = 3, sep = " · "): string {
  if (!values || values.length === 0) return ""
  return values.map(formatProfileValue).filter(Boolean).slice(0, max).join(sep)
}

type ConnectorRow = {
  id: string
  label: string
  meta: string
  connected: boolean
  brand: string
  letter: string
  provider?: "linkedin" | "github" | "calcom"
  action?: "send_resume"
}

function deriveConnectors(profile: CandidateSelfProfile): ConnectorRow[] {
  const hasHandle = (kind: string) =>
    profile.handles?.some((h) => h.kind === kind && h.verifiedAt) ?? false
  const phoneVerified = !!profile.phoneMasked || hasHandle("phone")
  const emailVerified = !!profile.emailMasked || hasHandle("email")
  const linkedinConnected =
    hasRealLinkedinUrl(profile.linkedinUrl) || !!profile.linkedinOauthProfile || hasHandle("linkedin")
  const githubConnected = !!profile.githubUrl || !!profile.githubOauthProfile || hasHandle("github")
  const calcomConnected = !!profile.calcomUrl || hasHandle("calcom")
  return [
    {
      id: "resume",
      label: "Resume",
      meta: profile.latestResumeArtifactId ? "PDF on file" : "Send Claire a PDF on iMessage",
      connected: !!profile.latestResumeArtifactId,
      brand: "#2D1A0A",
      letter: "R",
      action: "send_resume",
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      meta: linkedinConnectorMeta(profile, linkedinConnected),
      connected: linkedinConnected,
      brand: "#0A66C2",
      letter: "in",
      provider: "linkedin",
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
    {
      id: "github",
      label: "GitHub",
      meta: githubConnectorMeta(profile, githubConnected),
      connected: githubConnected,
      brand: "#0B0B0B",
      letter: "G",
      provider: "github",
    },
    {
      id: "calcom",
      label: "Cal.com",
      meta: profile.calcomUrl ? profile.calcomUrl.replace(/^https?:\/\//, "") : calcomConnected ? "Connected" : "Not connected",
      connected: calcomConnected,
      brand: "#0E1217",
      letter: "✱",
      provider: "calcom",
    },
  ]
}

function isLinkedinConnectorMarkerUrl(url: string | undefined): boolean {
  return !!url && url.includes(`/oauth-${"linked"}/`)
}

function hasRealLinkedinUrl(url: string | undefined): boolean {
  return !!url && !isLinkedinConnectorMarkerUrl(url)
}

function linkedinConnectorMeta(profile: CandidateSelfProfile, connected: boolean): string {
  if (hasRealLinkedinUrl(profile.linkedinUrl)) return linkedinHandleFromUrl(profile.linkedinUrl!)
  const name = profile.linkedinOauthProfile?.name
  if (name) return `Connected as ${name}`
  return connected ? "Connected" : "Not connected"
}

function githubConnectorMeta(profile: CandidateSelfProfile, connected: boolean): string {
  const login = profile.githubOauthProfile?.login
  const repoCount = profile.githubPublicRepos?.length ?? 0
  if (login && repoCount > 0) return `@${login} · ${repoCount} public repos`
  if (login) return `@${login}`
  if (profile.githubUrl) return githubHandleFromUrl(profile.githubUrl)
  return connected ? "Connected" : "Not connected"
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

function githubHandleFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/^\/([^/]+)\/?/)
    if (m && m[1]) return `@${m[1]}`
    return u.host.replace(/^www\./, "")
  } catch {
    return url.replace(/^https?:\/\//, "")
  }
}

async function startCandidateConnectorOAuth(provider: "linkedin" | "github" | "calcom"): Promise<void> {
  const call = httpsCallable<
    { provider: "linkedin" | "github" | "calcom"; returnTo: string },
    { ok: true; provider: "linkedin" | "github" | "calcom"; authUrl: string }
  >(functions(), "paCandidateConnectorOAuthStart")
  const result = await call({ provider, returnTo: window.location.href })
  if (!result.data.authUrl) {
    throw new Error("connector_auth_url_missing")
  }
  window.location.assign(result.data.authUrl)
}

function connectorErrorMessage(err: unknown, provider: ConnectorRow["provider"]): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes("github_oauth_config_missing")) {
    return "GitHub connection is not available yet. Message Claire to add your GitHub context."
  }
  if (raw.includes("calcom_oauth_config_missing")) {
    return "Cal.com connection is not available yet. Message Claire to share scheduling context."
  }
  if (raw.includes("linkedin_config_missing")) {
    return "LinkedIn connection is not available yet. Add your LinkedIn in the profile update box."
  }
  if (raw.includes("connector_auth_url_missing")) {
    return "The connection did not return a sign-in link. Try again in a moment."
  }
  if (raw.includes("not linked to a candidate profile")) {
    return "Open the profile once it finishes loading, then try connecting again."
  }
  return `Could not connect ${provider ?? "account"}. Try again.`
}

function ConnectorAction({
  connector,
  claireHref,
  withCheck = false,
}: {
  connector: ConnectorRow
  claireHref: string | null
  withCheck?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (connector.connected) {
    return (
      <span className="wkv2-conn__btn">
        {withCheck ? <span className="wkv2-conn__check"><Icon name="check" size={9} stroke={3} /></span> : null}
        Connected
      </span>
    )
  }
  if (connector.action === "send_resume") {
    if (!claireHref) {
      return (
        <Link to="/me/profile#profile-corrections" className="wkv2-conn__btn wkv2-conn__btn--connect">
          Update profile
        </Link>
      )
    }
    return (
      <a href={claireHref} className="wkv2-conn__btn wkv2-conn__btn--connect">
        Send PDF
      </a>
    )
  }
  if (!connector.provider) {
    return <span className="wkv2-conn__btn wkv2-conn__btn--muted">Not on file</span>
  }
  return (
    <span className="wkv2-conn__action">
      <button
        type="button"
        className="wkv2-conn__btn wkv2-conn__btn--connect"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(null)
          void startCandidateConnectorOAuth(connector.provider!)
            .catch((err) => {
              setError(connectorErrorMessage(err, connector.provider))
            })
            .finally(() => setBusy(false))
        }}
      >
        Connect
      </button>
      {error ? <span className="wkv2-conn__error" role="status">{error}</span> : null}
    </span>
  )
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

  // Real-status → v3 buckets. No mocked rows: everything below derives from the
  // claim-profile + list-matches callables (or hides when we don't have it yet).
  const upNext = allMatches.filter(
    (m) => m.status === "invited" || m.status === "interview_started",
  )
  const recommended = allMatches.filter((m) => m.status === "recommended")
  const pipelineMatches = allMatches.filter((m) => m.status !== "recommended")

  const matchesLoading = matchesState.status === "loading" || matchesState.status === "idle"
  const matchesErrored = matchesState.status === "error"
  const matchesError = matchesState.status === "error" ? matchesState.message : null

  const firstName = firstNameOf(profile)
  const completeness = deriveCompleteness(profile)
  const visibility = deriveVisibilityFromMatches(allMatches)
  const operatingLoop = deriveCandidateOperatingLoop(allMatches)
  const claireHref = buildClaireImessageHref(profile.senderNumber)

  const interviewActions: MeAction[] = upNext.map((m) => {
    const display = getCandidateJobStatusDisplay(m.status, m.job.title)
    const claire = m.status === "interview_started"
    return {
      key: m.matchId,
      logo: (m.job.company[0] ?? "?").toUpperCase(),
      logoBg: LOGO_BG_POOL[djb2(m.jobId || m.job.company) % LOGO_BG_POOL.length],
      urgent: m.status === "invited" || m.status === "interview_started",
      meta: `${display.label} · ${m.job.title}`,
      title: display.nextStep,
      sub: [m.job.company, m.job.location].filter(Boolean).join(" · "),
      cta: claire && claireHref ? "Continue with Claire" : display.ctaLabel,
      href: claireHref && claire ? claireHref : m.job.href,
      external: Boolean(claireHref && claire),
      when: meWhen(m.computedAt),
    }
  })
  const roleFollowupActions = deriveRoleFollowupActions(allMatches)
  const actions: MeAction[] = [...interviewActions, ...roleFollowupActions]
  const recommendedNextAction = deriveRecommendedRolesAction(recommended.length)
  const profileNextAction = deriveProfileNextAction(completeness)
  const actionCount = actions.length + (recommendedNextAction ? 1 : 0) + (profileNextAction ? 1 : 0)

  return (
    <CandidateShell
      signedIn
      signedInUser={{ name: profile.displayName ?? "You", email: profile.emailMasked }}
      claireHref={claireHref}
    >
      <style>{ME_V3_STYLES}</style>
      <div className="wkv3">
        <MeStatusHeader
          actionsCount={actionCount}
          firstName={firstName}
          visibility={visibility}
          hasPrimary={actionCount > 0}
        />

        <div className="wk-container">
          <div className="wkv3-grid">
            <div className="wkv3-main">
              <MeUpNext
                actions={actions}
                recommendedNextAction={recommendedNextAction}
                profileNextAction={profileNextAction}
                loading={matchesLoading}
                errored={matchesErrored}
                error={matchesError}
                recommendedCount={recommended.length}
              />
              {matchesErrored ? <MeRoleDashboardError message={matchesError} onRetry={matchesState.reload} /> : null}
              <MeOperatingLoopPanel loop={operatingLoop} />
              <MeActivityLog matches={allMatches} claireHref={claireHref} />
              <MePipeline
                matches={pipelineMatches}
                loading={matchesLoading}
                errored={matchesErrored}
                error={matchesError}
                claireHref={claireHref}
              />
              <MeNewMatches
                matches={recommended}
                loading={matchesLoading}
                errored={matchesErrored}
                error={matchesError}
                claireHref={claireHref}
              />
            </div>

            <aside className="wkv3-side">
              <MeCompletenessCard completeness={completeness} />
              <MeClaireSignalsCard profile={profile} />
              <MeVisibilityCard visibility={visibility} />
            </aside>
          </div>
        </div>
      </div>
    </CandidateShell>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /me — derived view models (honest: from real profile + matches, never mocked)
// ────────────────────────────────────────────────────────────────────────────

type MeAction = {
  key: string
  logo: string
  logoBg: string
  urgent: boolean
  meta: string
  title: string
  sub: string
  cta: string
  href: string
  external: boolean
  when: string
}

type MeCompleteness = {
  pct: number
  missing: Array<{ id: string; label: string; impact: string; critical?: boolean }>
}

type MeVisibility = {
  state: "discoverable" | "interviewing"
  label: string
  one: string
  two: string
  cta: string
}

type MeSignalRow = {
  label: string
  value: string
}

type MeActivityRow = {
  key: string
  logo: string
  logoBg: string
  event: string
  role: string
  company: string
  detail: string
  href: string
  external: boolean
  when: string
}

// Relative timestamp for the "when" hints — derived from the match computedAt.
function meWhen(iso?: string): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ""
  const diff = Date.now() - t
  const day = 86_400_000
  if (diff < 3_600_000) return "Just now"
  if (diff < day) return "Today"
  if (diff < 2 * day) return "Yesterday"
  return `${Math.floor(diff / day)}d ago`
}

// Profile completeness is computed from which durable fields actually exist on
// the claimed profile — so the ring + checklist reflect reality, not a constant.
function deriveCompleteness(profile: CandidateSelfProfile): MeCompleteness {
  const tags = profile.globalTags
  const checks: Array<{ id: string; label: string; impact: string; done: boolean; critical?: boolean }> = [
    { id: "resume", label: "Upload résumé", impact: "Improves matching evidence", done: !!profile.latestResumeArtifactId, critical: true },
    { id: "targets", label: "Target roles", impact: "Sets Claire's role target", done: !!tags?.roleFunction?.length },
    { id: "locations", label: "Location preferences", impact: "Keeps location filters honest", done: !!tags?.targetLocations?.length },
    { id: "industries", label: "Industry preferences", impact: "Keeps industry filters honest", done: !!tags?.industrySector?.length },
    { id: "skills", label: "Skills", impact: "Adds skills evidence", done: !!tags?.skills?.length },
    {
      id: "linkedin",
      label: "Connect LinkedIn",
      impact: "Confirms account",
      done: !!profile.linkedinOauthProfile || hasRealLinkedinUrl(profile.linkedinUrl),
    },
    { id: "story", label: "Career summary", impact: "Adds context for role review", done: !!profile.profileSummary },
  ]
  const done = checks.filter((c) => c.done).length
  const pct = Math.round((done / checks.length) * 100)
  const missing = checks
    .filter((c) => !c.done)
    .map((c) => ({ id: c.id, label: c.label, impact: c.impact, critical: c.critical }))
  return { pct, missing }
}

function deriveProfileNextAction(completeness: MeCompleteness): MeAction | null {
  const missing = completeness.missing.find((m) => m.critical) ?? completeness.missing[0]
  if (!missing) return null
  return {
    key: `profile-${missing.id}`,
    logo: "C",
    logoBg: "#0D0D0D",
    urgent: Boolean(missing.critical),
    meta: `Profile gap · ${missing.label}`,
    title: "Complete your Claire profile",
    sub: `${missing.label} — ${missing.impact}`,
    cta: "Update profile",
    href: profileActionHrefForMissing(missing),
    external: false,
    when: "",
  }
}

function deriveRecommendedRolesAction(recommendedCount: number): MeAction | null {
  if (recommendedCount <= 0) return null
  return {
    key: "recommended-roles",
    logo: "R",
    logoBg: "#1F6FEB",
    urgent: false,
    meta: `New roles · ${recommendedCount} ${recommendedCount === 1 ? "role" : "roles"}`,
    title: "Review new roles Claire found",
    sub:
      recommendedCount === 1
        ? "One role is ready for review."
        : `${recommendedCount} roles are ready for review.`,
    cta: "Review roles",
    href: "/me/matches",
    external: false,
    when: "",
  }
}

function deriveRoleFollowupActions(matches: CandidateMatchCard[]): MeAction[] {
  return [...matches]
    .filter((m) => m.status === "passed" || m.status === "intro_accepted" || Boolean(profileSignalHrefForMatch(m)))
    .sort((a, b) => {
      const at = Date.parse(a.computedAt)
      const bt = Date.parse(b.computedAt)
      return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at)
    })
    .slice(0, 2)
    .map((match) => {
      const accepted = match.status === "intro_accepted"
      const profileSignalHref = profileSignalHrefForMatch(match)
      const introRejectedSignal = match.status === "intro_rejected" && Boolean(profileSignalHref)
      const profileSignalMeta = introRejectedSignal ? "Intro closed · profile signal" : "Role closed · profile signal"
      const display = getCandidateJobStatusDisplay(match.status, match.job.title)
      const target = matchPrimaryTarget(match)
      return {
        key: `followup-${match.matchId}-${match.status}`,
        logo: (match.job.company[0] ?? "?").toUpperCase(),
        logoBg: LOGO_BG_POOL[djb2(match.jobId || match.job.company) % LOGO_BG_POOL.length],
        urgent: false,
        meta: profileSignalHref ? profileSignalMeta : accepted ? "Intro accepted · next step" : "Passed profile · review",
        title: match.job.title,
        sub: match.reviewDecision?.decisionReason || display.nextStep,
        cta: profileSignalHref ? "Update profile signal" : accepted ? "Review intro" : "Review pass note",
        href: profileSignalHref ?? target.url,
        external: profileSignalHref ? false : target.external,
        when: meWhen(match.computedAt),
      }
    })
}

function buildUpNextActions({
  actions,
  recommendedNextAction,
  profileNextAction,
}: {
  actions: MeAction[]
  recommendedNextAction: MeAction | null
  profileNextAction: MeAction | null
}): MeAction[] {
  const urgentActions = actions.filter((a) => a.urgent)
  const nonUrgentActions = actions.filter((a) => !a.urgent)
  const criticalProfileAction = profileNextAction?.urgent ? profileNextAction : null
  const nonCriticalProfileAction = profileNextAction && !profileNextAction.urgent ? profileNextAction : null
  return [
    ...urgentActions,
    ...(criticalProfileAction ? [criticalProfileAction] : []),
    ...nonUrgentActions,
    ...(recommendedNextAction ? [recommendedNextAction] : []),
    ...(nonCriticalProfileAction ? [nonCriticalProfileAction] : []),
  ]
}

function profileActionHrefForMissing(missing: MeCompleteness["missing"][number]): string {
  switch (missing.id) {
    case "resume":
      return "/me/profile#connector-resume"
    case "linkedin":
      return "/me/profile#connector-linkedin"
    case "skills":
      return "/me/profile#skills"
    case "story":
      return "/me/profile#profile-corrections"
    default:
      return "/me/profile#match-preferences"
  }
}

// Visibility reflects real candidate-side pipeline activity. We don't have a
// hidden/retained flag yet, so only the two states we can prove are surfaced.
function deriveVisibilityFromMatches(matches: CandidateMatchCard[]): MeVisibility {
  const activeCount = matches.filter(
    (m) =>
      m.status === "invited" ||
      m.status === "interview_started" ||
      m.status === "review_pending",
  ).length
  const matchCount = matches.filter((m) => m.status === "recommended").length
  return deriveVisibility(activeCount, matchCount)
}

function deriveVisibility(activeCount: number, matchCount: number): MeVisibility {
  if (activeCount > 0) {
    return {
      state: "interviewing",
      label: "Active pipeline",
      one: `${activeCount} active ${activeCount === 1 ? "role" : "roles"} in your pipeline.`,
      two: "Visibility and availability changes go through reviewed requests.",
      cta: "Request availability change",
    }
  }
  return {
    state: "discoverable",
    label: "Open to matches",
    one: "Your profile is open for role matching.",
    two:
      matchCount > 0
        ? `${matchCount} new ${matchCount === 1 ? "role" : "roles"} waiting for you.`
        : "Update preferences if your target roles or deal-breakers changed.",
    cta: "Request outreach change",
  }
}

function profileTagArray(profile: CandidateSelfProfile, fields: string[]): string[] {
  const tags = (profile.globalTags ?? {}) as Record<string, unknown>
  for (const field of fields) {
    const value = tags[field]
    if (Array.isArray(value)) return value.map(formatProfileValue).filter(Boolean)
    if (typeof value === "string" && value.trim()) return [formatProfileValue(value)]
  }
  return []
}

function salarySignal(profile: CandidateSelfProfile): string {
  const tags = (profile.globalTags ?? {}) as Record<string, unknown>
  const minSalaryUsd = tags.minSalaryUsd
  if (typeof minSalaryUsd !== "number" || !Number.isFinite(minSalaryUsd) || minSalaryUsd <= 0) return ""
  return `$${Math.round(minSalaryUsd).toLocaleString("en-US")}+`
}

function deriveClaireSignalRows(profile: CandidateSelfProfile): MeSignalRow[] {
  const rows: MeSignalRow[] = []
  const roleFunction = profileTagArray(profile, ["targetRoleFunction", "roleFunction"])
  const targetLocations = profileTagArray(profile, ["targetLocations"])
  const industrySector = profileTagArray(profile, ["industrySector"])
  const targetJobType = profileTagArray(profile, ["targetJobType"])
  const skills = profileTagArray(profile, ["skills"])
  const minSalaryUsd = salarySignal(profile)

  if (roleFunction.length) rows.push({ label: "Roles", value: roleFunction.slice(0, 3).join(" · ") })
  if (targetLocations.length) rows.push({ label: "Locations", value: targetLocations.slice(0, 3).join(", ") })
  if (industrySector.length) rows.push({ label: "Industries", value: industrySector.slice(0, 3).join(" · ") })
  if (targetJobType.length) rows.push({ label: "Job type", value: targetJobType.slice(0, 2).join(" · ") })
  if (minSalaryUsd) rows.push({ label: "Comp floor", value: minSalaryUsd })
  if (skills.length) rows.push({ label: "Skills", value: skills.slice(0, 4).join(" · ") })
  if (profile.profileSummary && rows.length < 3) rows.push({ label: "Story", value: profile.profileSummary })

  return rows.slice(0, 6)
}

function activityEventLabel(match: CandidateMatchCard): string {
  if (match.reviewDecision) {
    if (match.status === "passed") return "Passed review"
    if (match.status === "not_passed") return "Role closed after review"
    return "Review note posted"
  }
  const display = getCandidateJobStatusDisplay(match.status, match.job.title)
  return display.label
}

function activityDetail(match: CandidateMatchCard): string {
  if (match.reviewDecision?.decisionReason) return match.reviewDecision.decisionReason
  const display = getCandidateJobStatusDisplay(match.status, match.job.title)
  return display.nextStep
}

function activityTargetForMatch(match: CandidateMatchCard, claireHref: string | null) {
  if (match.status === "interview_started" && claireHref) return { external: true, url: claireHref }
  const profileSignalHref = profileSignalHrefForMatch(match)
  if (profileSignalHref) return { external: false, url: profileSignalHref }
  return matchPrimaryTarget(match)
}

function activityTargetOpensNewTab(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

function deriveMeActivityRows(matches: CandidateMatchCard[], claireHref: string | null): MeActivityRow[] {
  return [...matches]
    .sort((a, b) => {
      const at = Date.parse(a.computedAt)
      const bt = Date.parse(b.computedAt)
      return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at)
    })
    .slice(0, 4)
    .map((match) => {
      const target = activityTargetForMatch(match, claireHref)
      return {
        key: `${match.matchId}-${match.status}`,
        logo: (match.job.company[0] ?? "?").toUpperCase(),
        logoBg: LOGO_BG_POOL[djb2(match.jobId || match.job.company) % LOGO_BG_POOL.length],
        event: activityEventLabel(match),
        role: match.job.title,
        company: match.job.company,
        detail: activityDetail(match),
        href: target.url,
        external: target.external,
        when: meWhen(match.computedAt),
      }
    })
}

// Extra glyphs not in the shared Icon set (kept local to this surface).
function MeIcon({
  name,
  size = 14,
  stroke = 1.8,
}: {
  name: "chevron-right" | "eye-off"
  size?: number
  stroke?: number
}) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: stroke,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    style: { display: "inline-block", flex: "none", verticalAlign: "middle" } as CSSProperties,
  }
  if (name === "eye-off")
    return (
      <svg {...p}>
        <path d="M17 17s5-5 5-5-4-7-10-7c-1.6 0-3.1.4-4.4 1M3 3l18 18M9.9 5.1A9.4 9.4 0 0 0 2 12s4 7 10 7c1.6 0 3.1-.4 4.4-1" />
      </svg>
    )
  return (
    <svg {...p}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /me — status header
// ────────────────────────────────────────────────────────────────────────────

function MeStatusHeader({
  actionsCount,
  firstName,
  visibility,
  hasPrimary,
}: {
  actionsCount: number
  firstName: string
  visibility: MeVisibility
  hasPrimary: boolean
}) {
  return (
    <header className="wkv3-status">
      <div className="wk-container wkv3-status__inner">
        <div className="wkv3-status__copy">
          <div className="wkv3-status__eyebrow">
            <span className="wkv3-status__dot"><PulseDot size={6} /></span>
            <span>Home · <strong>{visibility.label.toLowerCase()}</strong></span>
          </div>
          <h1 className="wkv3-status__h1">
            {actionsCount > 0 ? (
              <>
                <em className="wkv3-num">{actionsCount}</em> thing{actionsCount === 1 ? "" : "s"} need
                {actionsCount === 1 ? "s" : ""} you.
              </>
            ) : firstName ? (
              <>Nothing needs you right now, {firstName}.</>
            ) : (
              <>Nothing needs you right now.</>
            )}
          </h1>
          <p className="wkv3-status__sub">
            Active interviews, new roles, and profile updates appear here when there is something candidate-visible.
          </p>
        </div>
        {hasPrimary ? (
          <div className="wkv3-status__cta">
            <button
              type="button"
              className="wk-btn wk-btn--primary wk-btn--sm"
              onClick={() => {
                document.getElementById("up-next")?.scrollIntoView({ behavior: "smooth", block: "start" })
              }}
            >
              Review up next <Icon name="arrow-right" size={13} stroke={2} />
            </button>
          </div>
        ) : null}
      </div>
    </header>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /me — Up next
// ────────────────────────────────────────────────────────────────────────────

function MeUpNext({
  actions,
  recommendedNextAction,
  profileNextAction,
  loading,
  errored,
  error,
  recommendedCount,
}: {
  actions: MeAction[]
  recommendedNextAction: MeAction | null
  profileNextAction: MeAction | null
  loading: boolean
  errored: boolean
  error: string | null
  recommendedCount: number
}) {
  const upNextActions = buildUpNextActions({ actions, recommendedNextAction, profileNextAction })
  return (
    <section className="wkv3-sec" id="up-next">
      <header className="wkv3-sec__head">
        <h2 className="wkv3-sec__h">
          Up next
          {upNextActions.length > 0 ? <span className="wkv3-sec__count">{upNextActions.length}</span> : null}
        </h2>
        <span className="wkv3-sec__sub">
          {upNextActions.length > 0 ? "Only things waiting on you." : "Nothing waiting on you."}
        </span>
      </header>
      {upNextActions.length > 0 ? (
        <div className="wkv3-actions">
          {upNextActions.map((a) => (
            <MeActionRow key={a.key} a={a} />
          ))}
        </div>
      ) : loading ? (
        <div className="wkv3-empty-block">Loading your pipeline…</div>
      ) : errored ? (
        <div className="wkv3-empty-block">{error}</div>
      ) : (
        <MeWaitingCard recommendedCount={recommendedCount} />
      )}
    </section>
  )
}

function MeActionRow({ a }: { a: MeAction }) {
  const btnClass = `wk-btn ${a.urgent ? "wk-btn--primary" : "wk-btn--secondary"} wk-btn--sm`
  const label = (
    <>
      {a.cta} <Icon name="arrow-right" size={14} stroke={2} />
    </>
  )
  return (
    <article className={`wkv3-act${a.urgent ? " wkv3-act--urgent" : ""}`}>
      <div className="wkv3-act__mark" style={{ background: a.logoBg }}>
        {a.logo}
      </div>
      <div className="wkv3-act__body">
        <p className={`wkv3-act__meta${a.urgent ? " is-urgent" : ""}`}>
          {a.urgent ? <PulseDot size={5} /> : null}
          <span>{a.meta}</span>
        </p>
        <h3 className="wkv3-act__t">{a.title}</h3>
        {a.sub ? <p className="wkv3-act__sub">{a.sub}</p> : null}
      </div>
      <div className="wkv3-act__right">
        {a.external ? (
          <a href={a.href} className={btnClass}>
            {label}
          </a>
        ) : (
          <Link to={a.href} className={btnClass}>
            {label}
          </Link>
        )}
        {a.when ? <span className="wkv3-act__when">{a.when}</span> : null}
      </div>
    </article>
  )
}

function MeRoleDashboardError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <section className="wkv3-roleerr" role="alert" aria-live="polite">
      <div>
        <strong>Your role dashboard couldn&apos;t load.</strong>
        <span>{message ?? "Refresh, or try again in a moment."}</span>
      </div>
      <button type="button" className="wk-btn wk-btn--secondary wk-btn--sm" onClick={onRetry}>
        Retry
      </button>
    </section>
  )
}

function MeWaitingCard({ recommendedCount }: { recommendedCount: number }) {
  return (
    <article className="wkv3-wait">
      <div className="wkv3-wait__ico" aria-hidden="true">
        <span className="wkv3-wait__pulse" />
        <span className="wkv3-wait__pulse wkv3-wait__pulse--2" />
        <span className="wkv3-wait__core" />
      </div>
      <div className="wkv3-wait__body">
        <p className="wkv3-wait__kicker">No action waiting</p>
        <h3 className="wkv3-wait__t">Your role queue is clear right now.</h3>
        <p className="wkv3-wait__sub">
          {recommendedCount > 0
            ? `${recommendedCount} new ${recommendedCount === 1 ? "role" : "roles"} surfaced — take a look below.`
            : "If this looks wrong, update the target roles, locations, and deal-breakers Claire should use."}
        </p>
        <Link to="/me/profile#match-preferences" className="wk-btn wk-btn--secondary wk-btn--sm">
          Review matching preferences <Icon name="arrow-right" size={13} stroke={2} />
        </Link>
        <div className="wkv3-wait__bar" aria-hidden="true">
          <span />
        </div>
        <p className="wkv3-wait__meta">Profile edits keep future matching tied to evidence you can review.</p>
      </div>
    </article>
  )
}

function MeOperatingLoopPanel({ loop }: { loop: CandidateOperatingLoop }) {
  return (
    <section className={`wkv3-sec wkv3-loop is-${loop.state}`} aria-label="WeKruit loop">
      <header className="wkv3-sec__head">
        <h2 className="wkv3-sec__h">WeKruit loop</h2>
        <span className="wkv3-sec__sub">Candidate-visible role states and feedback signals in one place.</span>
      </header>
      <div className="wkv3-loop__body">
        <div className="wkv3-loop__summary">
          <p className="wkv3-loop__kicker">{loop.primaryLabel}</p>
          <p className="wkv3-loop__text">{loop.body}</p>
          <p className="wkv3-loop__next">{loop.nextAction}</p>
        </div>
        <dl className="wkv3-loop__stats" aria-label="Candidate role state counts">
          {loop.stats.map((stat) => (
            <div className={`wkv3-loop__stat is-${stat.tone}`} key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
              <span>{stat.detail}</span>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

function MeActivityLog({ matches, claireHref }: { matches: CandidateMatchCard[]; claireHref: string | null }) {
  const rows = deriveMeActivityRows(matches, claireHref)
  if (rows.length === 0) return null
  return (
    <section className="wkv3-sec wkv3-activity" id="activity">
      <header className="wkv3-sec__head">
        <h2 className="wkv3-sec__h">Recent activity</h2>
        <span className="wkv3-sec__sub">Latest role updates from Claire and WeKruit.</span>
      </header>
      <div className="wkv3-activity__list">
        {rows.map((row) => (
          row.external ? (
            <a
              href={row.href}
              className="wkv3-activity__row"
              key={row.key}
              target={activityTargetOpensNewTab(row.href) ? "_blank" : undefined}
              rel={activityTargetOpensNewTab(row.href) ? "noopener noreferrer" : undefined}
            >
              <span className="wkv3-activity__mark" style={{ background: row.logoBg }}>{row.logo}</span>
              <span className="wkv3-activity__body">
                <span className="wkv3-activity__event">{row.event}</span>
                <strong>{row.role}</strong>
                <em>{row.company}</em>
                <span className="wkv3-activity__detail">{row.detail}</span>
              </span>
              {row.when ? <span className="wkv3-activity__when">{row.when}</span> : null}
            </a>
          ) : (
            <Link to={row.href} className="wkv3-activity__row" key={row.key}>
              <span className="wkv3-activity__mark" style={{ background: row.logoBg }}>{row.logo}</span>
              <span className="wkv3-activity__body">
                <span className="wkv3-activity__event">{row.event}</span>
                <strong>{row.role}</strong>
                <em>{row.company}</em>
                <span className="wkv3-activity__detail">{row.detail}</span>
              </span>
              {row.when ? <span className="wkv3-activity__when">{row.when}</span> : null}
            </Link>
          )
        ))}
      </div>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /me — Active interviews (stage bar + rows)
// ────────────────────────────────────────────────────────────────────────────

type MeStageDef = { id: string; label: string; dot: string; statuses: CandidateJobStatus[] }

const ME_STAGES: MeStageDef[] = [
  { id: "invited", label: "Invited", dot: "var(--wk-live-pulse)", statuses: ["invited"] },
  { id: "screening", label: "Screening", dot: "#1f6feb", statuses: ["interview_started"] },
  { id: "passed", label: "Passed", dot: "#1f6feb", statuses: ["passed"] },
  { id: "reviewing", label: "Reviewing", dot: "#3a8a5a", statuses: ["review_pending"] },
  { id: "intro", label: "Intro", dot: "#3a8a5a", statuses: ["intro_accepted", "intro_rejected"] },
  { id: "closed", label: "Closed", dot: "var(--wk-ink-4)", statuses: ["not_passed", "paused"] },
]

function MePipeline({
  matches,
  loading,
  errored,
  error,
  claireHref,
}: {
  matches: CandidateMatchCard[]
  loading: boolean
  errored: boolean
  error: string | null
  claireHref: string | null
}) {
  const [activeStage, setActiveStage] = useState<string | null>(null)
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    ME_STAGES.forEach((s) => {
      c[s.id] = matches.filter((m) => s.statuses.includes(m.status)).length
    })
    return c
  }, [matches])

  const activeDef = activeStage ? ME_STAGES.find((s) => s.id === activeStage) : null
  const filtered =
    activeDef && activeDef.statuses.length > 0
      ? matches.filter((m) => activeDef.statuses.includes(m.status))
      : matches
  const hasPipelineRows = matches.length > 0

  return (
    <section className="wkv3-sec" id="pipeline">
      <header className="wkv3-sec__head">
        <h2 className="wkv3-sec__h">Interview pipeline</h2>
        <span className="wkv3-sec__sub">
          {activeStage ? (
            <button type="button" className="wkv3-sec__clear" onClick={() => setActiveStage(null)}>
              Clear filter ×
            </button>
          ) : (
            hasPipelineRows ? "Tap a stage to filter." : "Stages appear as roles move forward."
          )}
        </span>
      </header>

      <div className="wkv3-stages" role="tablist" aria-label="Pipeline stage filter">
        {ME_STAGES.map((s) => {
          const n = counts[s.id] ?? 0
          const active = activeStage === s.id
          const disabled = n === 0 && !active
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-disabled={disabled}
              disabled={disabled}
              className={`wkv3-stage${active ? " is-active" : ""}${disabled ? " is-disabled" : ""}`}
              onClick={() => setActiveStage(active ? null : s.id)}
            >
              <span className="wkv3-stage__top">
                <span className="wkv3-stage__sdot" style={{ background: s.dot }} />
                <span>{s.label}</span>
              </span>
              <span className={`wkv3-stage__n${n === 0 ? " is-zero" : ""}`}>{n}</span>
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="wkv3-empty-block">Loading interview pipeline…</div>
      ) : errored ? (
        <div className="wkv3-empty-block wkv3-empty-block--error">{error}</div>
      ) : filtered.length === 0 ? (
        <div className="wkv3-empty-block">
          {matches.length === 0
            ? "No active roles yet. Claire adds them as matching work moves forward."
            : "Nothing in this stage right now."}
        </div>
      ) : (
        <div className="wkv3-rows">
          {filtered.map((m) => (
            <MePipelineRow key={m.matchId} match={m} claireHref={claireHref} />
          ))}
        </div>
      )}
    </section>
  )
}

function meStageChip(status: CandidateJobStatus) {
  switch (status) {
    case "invited":
      return (
        <span className="wkv3-chip wkv3-chip--live">
          <PulseDot size={6} /> Invited
        </span>
      )
    case "interview_started":
      return (
        <span className="wkv3-chip wkv3-chip--blue">
          <PulseDot size={6} color="#1f6feb" /> Screening
        </span>
      )
    case "review_pending":
      return <span className="wkv3-chip wkv3-chip--ink">Reviewing</span>
    case "passed":
      return (
        <span className="wkv3-chip wkv3-chip--warm">
          <Icon name="check" size={11} stroke={2.4} /> Passed
        </span>
      )
    case "intro_accepted":
      return (
        <span className="wkv3-chip wkv3-chip--warm">
          <Icon name="check" size={11} stroke={2.4} /> Intro accepted
        </span>
      )
    case "intro_rejected":
      return <span className="wkv3-chip wkv3-chip--muted">Intro closed</span>
    case "not_passed":
      return <span className="wkv3-chip wkv3-chip--muted">Closed</span>
    case "paused":
      return <span className="wkv3-chip wkv3-chip--muted">Paused</span>
    default:
      return <span className="wkv3-chip wkv3-chip--muted">New</span>
  }
}

function pipelineActionForMatch(match: CandidateMatchCard, claireHref: string | null) {
  if (match.status === "interview_started" && claireHref) {
    return { external: true, url: claireHref, label: "Continue with Claire" }
  }
  const profileSignalHref = profileSignalHrefForMatch(match)
  if (profileSignalHref) return { external: false, url: profileSignalHref, label: "Update profile signal" }
  const display = getCandidateJobStatusDisplay(match.status, match.job.title)
  const target = matchPrimaryTarget(match)
  return { ...target, label: display.ctaLabel }
}

function MePipelineRow({ match, claireHref }: { match: CandidateMatchCard; claireHref: string | null }) {
  const display = getCandidateJobStatusDisplay(match.status, match.job.title)
  const action = pipelineActionForMatch(match, claireHref)
  const logo = (match.job.company[0] ?? "?").toUpperCase()
  const logoBg = LOGO_BG_POOL[djb2(match.jobId || match.job.company) % LOGO_BG_POOL.length]
  const when = meWhen(match.computedAt)
  const showDecision = shouldShowReviewDecision(match)
  return (
    <article className="wkv3-row">
      <CompanyMark logo={logo} bg={logoBg} size={48} />
      <div className="wkv3-row__body">
        <div className="wkv3-row__head">
          <h4 className="wkv3-row__t">{match.job.title}</h4>
          {meStageChip(match.status)}
        </div>
        <p className="wkv3-row__co">
          {match.job.company}
          {match.job.location ? ` · ${match.job.location}` : ""}
        </p>
        <p className="wkv3-row__next">{display.nextStep}</p>
        {showDecision ? <ReviewDecisionBlock match={match} /> : null}
      </div>
      <div className="wkv3-row__right">
        {action.external ? (
          <a href={action.url} className="wk-btn wk-btn--secondary wk-btn--sm">
            {action.label} <Icon name="arrow-right" size={12} stroke={2} />
          </a>
        ) : (
          <Link to={action.url} className="wk-btn wk-btn--secondary wk-btn--sm">
            {action.label} <Icon name="arrow-right" size={12} stroke={2} />
          </Link>
        )}
        {when ? <span className="wkv3-row__when">{when}</span> : null}
      </div>
    </article>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Prescreen review-decision surfacing (from origin/main) — shown on terminal
// pipeline rows so the candidate sees Claire's PASS/NOT_PASS message + reasons.
// ────────────────────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────────────────────
// /me — New matches (digest peeks; full inbox lives on /me/matches)
// ────────────────────────────────────────────────────────────────────────────
function MeNewMatches({
  matches,
  loading,
  errored,
  error,
  claireHref,
}: {
  matches: CandidateMatchCard[]
  loading: boolean
  errored: boolean
  error: string | null
  claireHref: string | null
}) {
  return (
    <section className="wkv3-sec" id="matches">
      <header className="wkv3-sec__head">
        <h2 className="wkv3-sec__h">
          New roles
          {matches.length > 0 ? <span className="wkv3-sec__count">{matches.length}</span> : null}
        </h2>
        {matches.length > 0 ? (
          <Link to="/me/matches" className="wkv3-sec__viewall">
            See all <Icon name="arrow-right" size={12} stroke={2} />
          </Link>
        ) : (
          <span className="wkv3-sec__sub">Nothing in your inbox right now.</span>
        )}
      </header>
      {loading ? (
        <div className="wkv3-empty-block">Loading new roles…</div>
      ) : errored ? (
        <div className="wkv3-empty-block">{error}</div>
      ) : matches.length > 0 ? (
        <>
          <div className="wkv3-peeks">
            {matches.slice(0, 2).map((m) => (
              <MeMatchPeek key={m.matchId} match={m} />
            ))}
          </div>
          <Link to="/me/matches" className="wkv3-seeall">
            {matches.length > 2 ? `See all ${matches.length} roles` : "Open all your roles — filter and review"}
            <Icon name="arrow-right" size={13} stroke={2} />
          </Link>
        </>
      ) : (
        <MeNewRolesEmptyState claireHref={claireHref} />
      )}
    </section>
  )
}

function MeNewRolesEmptyState({ claireHref }: { claireHref: string | null }) {
  return (
    <div className="wkv3-empty-block wkv3-empty-block--actionable">
      <h3>No new roles match your profile yet.</h3>
      <p>
        Update target roles, locations, and deal-breakers so new roles can surface with clearer evidence.
      </p>
      <div className="wkv3-empty-actions">
        <Link to="/me/profile#match-preferences" className="wk-btn wk-btn--primary wk-btn--sm">
          Update matching profile <Icon name="arrow-right" size={13} stroke={2} />
        </Link>
        {claireHref ? (
          <a href={claireHref} className="wk-btn wk-btn--secondary wk-btn--sm">
            Message Claire <Icon name="message" size={12} stroke={1.9} />
          </a>
        ) : null}
      </div>
    </div>
  )
}

// Where a match card's primary action points:
//  - collab     → our internal page (/j/:jobId): WeKruit listing + pre-screen.
//  - non-collab → the real external source listing for inspection. Falls back to
//    the internal page only when applyUrl is absent (atsApplyUrl is a V16 hard
//    filter, so recommended recs effectively always carry it).
function profileSignalHrefForMatch(match: CandidateMatchCard): string | null {
  const params = new URLSearchParams()
  params.set("profileRoleSignalTitle", match.job.title)
  params.set("profileRoleSignalCompany", match.job.company)

  if (match.status === "not_passed" && match.reviewDecision) {
    params.set("profileRoleSignalOutcome", "not_passed")
    params.set("profileRoleSignalReason", match.reviewDecision.decisionReason)
    if (match.reviewDecision.recommendedActions.length > 0) {
      params.set("profileRoleSignalActions", match.reviewDecision.recommendedActions.slice(0, 3).join("\n"))
    }
    return `/me/profile?${params.toString()}#profile-corrections`
  }

  if (match.status === "intro_rejected") {
    const display = getCandidateJobStatusDisplay(match.status, match.job.title)
    params.set("profileRoleSignalOutcome", "intro_rejected")
    params.set("profileRoleSignalReason", display.nextStep)
    return `/me/profile?${params.toString()}#profile-corrections`
  }

  return null
}

function profileSignalHrefForRecommendedMatch(match: CandidateMatchCard): string {
  const params = new URLSearchParams()
  params.set("profileRoleSignalTitle", match.job.title)
  params.set("profileRoleSignalCompany", match.job.company)
  if (match.job.location) params.set("profileRoleSignalLocation", match.job.location)
  if (match.whyMatched.length > 0) {
    params.set("profileRoleSignalReason", match.whyMatched.slice(0, 3).join("\n"))
  }
  return `/me/profile?${params.toString()}#profile-corrections`
}

function matchPrimaryTarget(match: CandidateMatchCard): { external: boolean; url: string } {
  if (!match.collab && match.job.applyUrl) return { external: true, url: match.job.applyUrl }
  return { external: false, url: match.job.href }
}

function MeMatchPeek({ match }: { match: CandidateMatchCard }) {
  const logo = (match.job.company[0] ?? "?").toUpperCase()
  const logoBg = LOGO_BG_POOL[djb2(match.jobId || match.job.company) % LOGO_BG_POOL.length]
  const isCollab = !!match.collab
  const recommendedSignalHref = profileSignalHrefForRecommendedMatch(match)
  const target = matchPrimaryTarget(match)
  const statusDisplay = getCandidateJobStatusDisplay(match.status, match.job.title)
  const peekCtaLabel = isCollab ? statusDisplay.ctaLabel : "View source"
  return (
    <article className="wkv3-peek">
      <CompanyMark logo={logo} bg={logoBg} size={44} />
      <div className="wkv3-peek__body">
        <div className="wkv3-peek__head">
          <h4 className="wkv3-peek__t">{match.job.title}</h4>
          {isCollab ? (
            <span className="wkv3-chip wkv3-chip--warm">
              <PulseDot size={5} /> WeKruit-screened
            </span>
          ) : (
            <span className="wkv3-chip wkv3-chip--muted">New</span>
          )}
        </div>
        <p className="wkv3-peek__co">
          <b>{match.job.company}</b>
          {match.job.location ? ` · ${match.job.location}` : ""}
        </p>
      </div>
      <div className="wkv3-peek__right">
        <span className="wkv3-peek__salary">{match.job.salaryRange ?? "By interview"}</span>
        <div className="wkv3-peek__actions">
          {target.external ? (
            <a className="wkv3-peek__go" href={target.url} target="_blank" rel="noreferrer">
              {peekCtaLabel} <Icon name="arrow-right" size={12} stroke={2} />
            </a>
          ) : (
            <Link className="wkv3-peek__go" to={target.url}>
              {peekCtaLabel} <Icon name="arrow-right" size={12} stroke={2} />
            </Link>
          )}
          <Link to={recommendedSignalHref} className="wkv3-peek__signal">
            Use as signal
          </Link>
        </div>
      </div>
    </article>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /me — sidebar cards
// ────────────────────────────────────────────────────────────────────────────

function MeCompletenessCard({ completeness }: { completeness: MeCompleteness }) {
  const navigate = useNavigate()
  const { pct, missing } = completeness
  const radius = 22
  const circ = 2 * Math.PI * radius
  const dash = (pct / 100) * circ
  return (
    <div className="wkv3-comp">
      <div className="wkv3-comp__top">
        <svg className="wkv3-comp__ring" width="60" height="60" viewBox="0 0 60 60" aria-hidden="true">
          <circle cx="30" cy="30" r={radius} strokeWidth="5" fill="none" style={{ stroke: "var(--wk-border)" }} />
          <circle
            cx="30"
            cy="30"
            r={radius}
            strokeWidth="5"
            fill="none"
            strokeDasharray={`${dash} ${circ - dash}`}
            strokeDashoffset={circ * 0.25}
            strokeLinecap="round"
            transform="rotate(-90 30 30)"
            style={{ stroke: "var(--wk-live)" }}
          />
        </svg>
        <div className="wkv3-comp__head">
          <div className="wkv3-comp__pct">
            <strong>{pct}</strong>
            <span>%</span>
          </div>
          <div className="wkv3-comp__lbl">profile complete</div>
        </div>
      </div>

      {missing.length > 0 ? (
        <>
          <p className="wkv3-comp__lede">
            {missing.some((m) => m.id === "resume")
              ? "Add a résumé so Claire can compare roles with stronger evidence."
              : "Add a few things so Claire has more evidence to compare."}
          </p>
          <ul className="wkv3-comp__list">
            {missing.slice(0, 3).map((m) => (
              <li key={m.id} className={m.critical ? "is-critical" : ""}>
                <span className="wkv3-comp__check" aria-hidden="true" />
                <div className="wkv3-comp__item">
                  <span className="wkv3-comp__what">{m.label}</span>
                  <span className="wkv3-comp__impact">{m.impact}</span>
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="wk-btn wk-btn--ink wk-btn--block wk-btn--sm"
            onClick={() => navigate(profileActionHrefForMissing(missing[0]))}
          >
            Complete profile <Icon name="arrow-right" size={13} stroke={2} />
          </button>
        </>
      ) : (
        <div className="wkv3-comp__done">
          <span className="wkv3-comp__check is-on" aria-hidden="true">
            <Icon name="check" size={11} stroke={2.6} />
          </span>
          <div>
            <strong>Profile complete.</strong>
            <span>Claire has everything she needs to match you.</span>
          </div>
        </div>
      )}
    </div>
  )
}

function MeClaireSignalsCard({ profile }: { profile: CandidateSelfProfile }) {
  const rows = deriveClaireSignalRows(profile)
  return (
    <div className="wkv3-signal">
      <div className="wkv3-signal__head">
        <span className="wkv3-signal__kicker">Matching signal</span>
        <strong>What Claire is matching on</strong>
      </div>
      <p className="wkv3-signal__lede">Pulled from your resume, tags, and corrections.</p>
      {rows.length > 0 ? (
        <dl className="wkv3-signal__rows">
          {rows.map((row) => (
            <div className="wkv3-signal__row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="wkv3-signal__empty">
          Claire needs more target-role signal before roles can surface with clear evidence.
        </p>
      )}
      <Link to="/me/profile#match-preferences" className="wkv3-signal__link">
        Update matching profile <Icon name="arrow-right" size={12} stroke={2} />
      </Link>
    </div>
  )
}

function MeVisibilityCard({ visibility }: { visibility: MeVisibility }) {
  return (
    <div className={`wkv3-vis wkv3-vis--${visibility.state}`}>
      <div className="wkv3-vis__top">
        <div className="wkv3-vis__head">
          <span className="wkv3-vis__kicker">Visibility</span>
          <strong className="wkv3-vis__label">{visibility.label}</strong>
        </div>
        <Link
          to="/me/privacy#privacy-requests"
          className="wkv3-vis__manage"
          aria-label="Review visibility requests"
        >
          <MeIcon name="chevron-right" size={14} stroke={2} />
        </Link>
      </div>
      <p className="wkv3-vis__one">{visibility.one}</p>
      <p className="wkv3-vis__two">{visibility.two}</p>
      <div className="wkv3-vis__actions">
        <Link to="/me/privacy#privacy-requests" className="wk-btn wk-btn--secondary wk-btn--sm">
          {visibility.cta}
        </Link>
        <Link
          to="/me/privacy#privacy"
          className="wkv3-vis__btn wkv3-vis__btn--quiet"
        >
          Review privacy rules
        </Link>
      </div>
    </div>
  )
}

function MeVisibilityPendingCard({ error }: { error: string | null }) {
  return (
    <div className="wkv3-vis wkv3-vis--pending">
      <div className="wkv3-vis__top">
        <div className="wkv3-vis__head">
          <span className="wkv3-vis__kicker">Visibility</span>
          <strong className="wkv3-vis__label">
            {error ? "Pipeline unavailable" : "Checking pipeline"}
          </strong>
        </div>
        <Link
          to="/me/privacy#privacy-requests"
          className="wkv3-vis__manage"
          aria-label="Review visibility requests"
        >
          <MeIcon name="chevron-right" size={14} stroke={2} />
        </Link>
      </div>
      <p className="wkv3-vis__one">
        {error ?? "Loading your active roles before showing visibility."}
      </p>
      <p className="wkv3-vis__two">Profile edits still save normally.</p>
      <div className="wkv3-vis__actions">
        <Link to="/me/privacy#privacy-requests" className="wk-btn wk-btn--secondary wk-btn--sm">
          Request outreach change
        </Link>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /me — styles (ported from the v3 design bundle; unprefixed design tokens are
// aliased to the production --wk-* set so the page reads verbatim).
// ────────────────────────────────────────────────────────────────────────────

const ME_V3_STYLES = `
.wkv3 {
  --cream: var(--wk-cream); --cream-2: var(--wk-cream-2); --cream-3: var(--wk-cream-3);
  --ink: var(--wk-ink); --ink-2: var(--wk-ink-2); --ink-3: var(--wk-ink-3); --ink-4: var(--wk-ink-4);
  --border: var(--wk-border); --border-strong: var(--wk-border-strong);
  --peach-50: var(--wk-peach-50); --peach-100: var(--wk-peach-100);
  --peach-200: var(--wk-peach-200); --peach-300: var(--wk-peach-300);
  --live: var(--wk-live); --live-2: var(--wk-live-2); --live-soft: var(--wk-live-soft);
  --live-border: var(--wk-live-border); --live-pulse: var(--wk-live-pulse);
  --r-sm: var(--wk-r-sm); --r-md: var(--wk-r-md); --r-lg: var(--wk-r-lg); --r-pill: var(--wk-r-pill);
  --ease: var(--wk-ease); --dur-fast: 200ms; --dur-base: 240ms;
  --success: #3a8a5a; --success-bg: rgba(58,138,90,.12);
  --candidate-card: var(--wk-cream-3); --candidate-card-hover: #FFF8EB;
  --font-serif: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  --font-sans: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  padding: 0 0 80px;
  background: var(--cream);
  min-height: 100vh;
}
.wkv3 .wk-btn--block { width: 100%; }

/* Status header */
.wkv3-status {
  padding: 28px 0 22px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}
.wkv3-status__inner {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 28px;
  align-items: end;
}
.wkv3-status__copy { max-width: 720px; min-width: 0; }
.wkv3-status__eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  font-family: var(--font-sans);
  font-size: 11.5px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--ink-3); margin: 0 0 12px;
}
.wkv3-status__eyebrow strong { color: var(--ink); font-weight: 700; }
.wkv3-status__dot {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; color: var(--ink-3);
}
.wkv3-status__h1 {
  font-family: var(--font-serif);
  font-weight: 400;
  font-size: clamp(28px, 3.4vw, 40px);
  line-height: 1.06;
  letter-spacing: -0.022em;
  color: var(--ink);
  margin: 0;
  text-wrap: balance;
}
.wkv3-status__h1 .wkv3-num { font-style: italic; color: var(--live); font-weight: 400; }
.wkv3-status__sub {
  font-size: 14.5px; color: var(--ink-2); line-height: 1.5;
  max-width: 580px; margin: 10px 0 0;
}
.wkv3-status__cta {
  display: grid; gap: 6px; justify-items: end; text-align: right; align-self: end;
}
.wkv3-status__cta .wk-btn { white-space: nowrap; }

/* Page grid */
.wkv3-grid {
  padding: 24px 0 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 28px;
  align-items: start;
}
.wkv3-main { display: grid; gap: 28px; min-width: 0; }
.wkv3-side { display: grid; gap: 14px; position: sticky; top: 24px; }

/* Section heads */
.wkv3-sec { display: grid; gap: 14px; }
.wkv3-sec__head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.wkv3-sec__h {
  font-family: var(--font-sans); font-weight: 600; font-size: 17px;
  letter-spacing: -0.005em; line-height: 1.2; color: var(--ink);
  margin: 0; display: inline-flex; align-items: baseline; gap: 10px; white-space: nowrap;
}
.wkv3-sec__count {
  font-family: var(--font-sans); font-weight: 600; font-size: 11.5px;
  color: var(--live); background: var(--live-soft); border: 1px solid var(--live-border);
  border-radius: var(--r-pill); padding: 2px 8px;
}
.wkv3-sec__sub { color: var(--ink-3); font-size: 13px; font-weight: 500; }
.wkv3-sec__clear { background: transparent; border: 0; cursor: pointer; color: var(--live); font: inherit; font-weight: 600; }
.wkv3-sec__viewall {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--font-sans); font-size: 12.5px; font-weight: 600;
  color: var(--live); text-decoration: none; white-space: nowrap;
}
.wkv3-sec__viewall:hover { text-decoration: underline; }

/* Candidate operating loop */
.wkv3-loop__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.84fr);
  gap: 14px;
  align-items: stretch;
}
.wkv3-loop__summary {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--candidate-card);
  padding: 17px 18px;
  display: grid;
  gap: 8px;
  position: relative;
  overflow: hidden;
}
.wkv3-loop__summary::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  background: var(--ink-3);
}
.wkv3-loop.is-action_needed .wkv3-loop__summary::before { background: var(--live); }
.wkv3-loop.is-in_review .wkv3-loop__summary::before { background: var(--success); }
.wkv3-loop.is-roles_to_review .wkv3-loop__summary::before { background: #1F6FEB; }
.wkv3-loop.is-intro_signal .wkv3-loop__summary::before { background: var(--success); }
.wkv3-loop.is-profile_signal .wkv3-loop__summary::before { background: var(--success); }
.wkv3-loop__kicker {
  margin: 0;
  font-size: 10.5px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--live);
}
.wkv3-loop.is-in_review .wkv3-loop__kicker { color: var(--success); }
.wkv3-loop.is-roles_to_review .wkv3-loop__kicker { color: #1F6FEB; }
.wkv3-loop.is-intro_signal .wkv3-loop__kicker { color: var(--success); }
.wkv3-loop.is-profile_signal .wkv3-loop__kicker { color: var(--success); }
.wkv3-loop.is-profile_active .wkv3-loop__kicker { color: var(--ink-3); }
.wkv3-loop__text {
  margin: 0;
  color: var(--ink);
  font-family: var(--font-serif);
  font-size: 20px;
  line-height: 1.22;
  letter-spacing: -0.016em;
}
.wkv3-loop__next {
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
  line-height: 1.45;
}
.wkv3-loop__stats {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.wkv3-loop__stat {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--candidate-card);
  padding: 13px 12px;
  display: grid;
  gap: 4px;
}
.wkv3-loop__stat.is-live { border-color: var(--live-border); background: var(--live-soft); }
.wkv3-loop__stat.is-blue { border-color: rgba(31,111,235,.22); background: rgba(31,111,235,.07); }
.wkv3-loop__stat.is-green { border-color: rgba(58,138,90,.24); background: var(--success-bg); }
.wkv3-loop__stat dt {
  color: var(--ink-3);
  font-size: 10px;
  line-height: 1.1;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}
.wkv3-loop__stat dd {
  margin: 0;
  color: var(--ink);
  font-family: var(--font-serif);
  font-size: 28px;
  line-height: 1;
  letter-spacing: -0.02em;
}
.wkv3-loop__stat span {
  color: var(--ink-3);
  font-size: 11.5px;
  line-height: 1.25;
}

/* Sidebar: completeness */
.wkv3-comp {
  background: var(--candidate-card); border: 1px solid var(--border);
  border-radius: var(--r-md); padding: 16px;
  display: grid; gap: 12px; position: relative; overflow: hidden;
}
.wkv3-comp__top { display: flex; align-items: center; gap: 14px; position: relative; }
.wkv3-comp__ring { flex: none; }
.wkv3-comp__head { min-width: 0; }
.wkv3-comp__pct {
  font-family: var(--font-serif); font-weight: 400; font-size: 28px;
  line-height: 1; letter-spacing: -0.02em; color: var(--ink);
  display: inline-flex; align-items: baseline; gap: 2px;
}
.wkv3-comp__pct strong { font-weight: 400; }
.wkv3-comp__pct span { font-size: 14px; color: var(--ink-3); font-style: italic; }
.wkv3-comp__lbl {
  margin-top: 2px; font-size: 11.5px; color: var(--ink-3);
  letter-spacing: 0.04em; text-transform: uppercase; font-weight: 500;
}
.wkv3-comp__lede { margin: 0; font-size: 13px; color: var(--ink-2); line-height: 1.4; }
.wkv3-comp__list { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.wkv3-comp__list li {
  display: grid; grid-template-columns: 16px 1fr; gap: 10px; align-items: start; position: relative;
}
.wkv3-comp__check {
  width: 14px; height: 14px; border-radius: 50%;
  border: 1.5px dashed var(--border-strong); background: var(--cream);
  margin-top: 2px; display: inline-flex; align-items: center; justify-content: center; color: var(--cream);
}
.wkv3-comp__check.is-on { border: none; background: var(--live); }
.wkv3-comp__list li.is-critical .wkv3-comp__check { border: 1.5px solid var(--live); border-style: solid; background: var(--live-soft); }
.wkv3-comp__item { display: grid; gap: 1px; }
.wkv3-comp__what { font-size: 12.5px; color: var(--ink); font-weight: 600; letter-spacing: -0.005em; line-height: 1.2; }
.wkv3-comp__impact { font-size: 11px; color: var(--ink-3); line-height: 1.3; }
.wkv3-comp__done {
  display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center;
  font-size: 12.5px; color: var(--ink-2); line-height: 1.4;
}
.wkv3-comp__done strong { color: var(--ink); display: block; }
.wkv3-comp__done span { color: var(--ink-3); }

/* Sidebar: real matching signal */
.wkv3-signal {
  background: var(--candidate-card);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 16px;
  box-shadow: var(--shadow-card);
  display: grid;
  gap: 12px;
}
.wkv3-signal__head { display: grid; gap: 4px; }
.wkv3-signal__kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--live);
  font-weight: 700;
}
.wkv3-signal__head strong {
  font-family: var(--font-serif);
  font-weight: 400;
  font-size: 21px;
  letter-spacing: -0.02em;
  line-height: 1.1;
  color: var(--ink);
}
.wkv3-signal__lede,
.wkv3-signal__empty {
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
  line-height: 1.4;
}
.wkv3-signal__rows { margin: 0; display: grid; gap: 8px; }
.wkv3-signal__row {
  display: grid;
  grid-template-columns: minmax(76px, 0.36fr) minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.wkv3-signal__row dt {
  font-size: 11px;
  color: var(--ink-3);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.wkv3-signal__row dd {
  margin: 0;
  min-width: 0;
  font-size: 13px;
  color: var(--ink);
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.wkv3-signal__link {
  width: fit-content;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--live);
  text-decoration: none;
  font-size: 12.5px;
  font-weight: 700;
}
.wkv3-signal__link:hover { color: var(--ink); }

/* Sidebar: visibility */
.wkv3-vis {
  position: relative; border-radius: var(--r-md); padding: 16px;
  display: grid; gap: 12px; border: 1px solid var(--border);
  background: var(--candidate-card); overflow: hidden;
}
.wkv3-vis__top { display: grid; grid-template-columns: 1fr auto; align-items: start; gap: 8px; }
.wkv3-vis__head { display: grid; gap: 4px; min-width: 0; }
.wkv3-vis__kicker { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); font-weight: 600; }
.wkv3-vis__label {
  font-family: var(--font-sans); font-weight: 600; font-size: 16px; color: var(--ink);
  line-height: 1.2; letter-spacing: -0.01em; display: inline-flex; align-items: center; gap: 8px;
}
.wkv3-vis__label::after {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: var(--live); display: inline-block; box-shadow: 0 0 0 3px rgba(224,116,46,.18);
}
.wkv3-vis--interviewing .wkv3-vis__label::after { background: var(--success); box-shadow: 0 0 0 3px rgba(58,138,90,.15); }
.wkv3-vis--pending .wkv3-vis__label::after { background: var(--ink-3); box-shadow: 0 0 0 3px rgba(45,26,10,.10); }
.wkv3-vis__manage { appearance: none; border: 0; background: transparent; padding: 4px; cursor: pointer; color: var(--ink-3); border-radius: var(--r-sm); }
.wkv3-vis__manage:hover { background: rgba(45,26,10,.06); color: var(--ink); }
.wkv3-vis__one { margin: 0; font-size: 13.5px; color: var(--ink-2); line-height: 1.45; }
.wkv3-vis__two {
  margin: 0; padding-top: 8px; border-top: 1px dashed var(--border);
  font-size: 12px; color: var(--ink-3); line-height: 1.4;
}
.wkv3-vis__actions { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.wkv3-vis__btn {
  appearance: none; background: transparent; border: 0; color: var(--ink);
  font: inherit; font-size: 12.5px; font-weight: 600; padding: 2px 0; cursor: pointer;
  border-bottom: 1px solid var(--ink); transition: opacity var(--dur-fast) var(--ease); letter-spacing: -0.005em;
}
.wkv3-vis__btn:hover { opacity: 0.65; }
.wkv3-vis__btn--quiet { color: var(--ink-3); border-bottom-color: var(--border-strong); border-bottom-style: dashed; font-weight: 500; }
.wkv3-vis__btn--quiet:hover { color: var(--ink); border-bottom-color: var(--ink); opacity: 1; }

/* Up next: action rows */
.wkv3-actions { display: grid; gap: 10px; }
.wkv3-act {
  display: grid; grid-template-columns: 44px 1fr auto; gap: 14px; align-items: start;
  padding: 14px 16px; background: var(--candidate-card); border: 1px solid var(--border);
  border-radius: var(--r-md); transition: border-color var(--dur-fast) var(--ease), transform var(--dur-base) var(--ease);
}
.wkv3-act:hover { border-color: var(--live-border); transform: translateY(-1px); }
.wkv3-act--urgent { border-color: var(--live-border); box-shadow: 0 0 0 4px rgba(224,116,46,0.06); }
.wkv3-act__mark {
  width: 44px; height: 44px; border-radius: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  font-family: var(--font-serif); color: var(--cream); font-size: 19px; letter-spacing: -0.02em; flex: none;
}
.wkv3-act__body { min-width: 0; }
.wkv3-act__meta {
  margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--ink-3); line-height: 1.4;
  display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.wkv3-act__meta.is-urgent { color: var(--live); }
.wkv3-act__t {
  margin: 0; font-family: var(--font-sans); font-weight: 600; font-size: 15px;
  letter-spacing: -0.005em; line-height: 1.35; color: var(--ink);
}
.wkv3-act__sub { margin: 3px 0 0; font-size: 13px; color: var(--ink-2); line-height: 1.4; }
.wkv3-act__right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 120px; }
.wkv3-act__when { font-size: 11.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; }

/* Waiting card */
.wkv3-wait {
  display: grid; grid-template-columns: 64px 1fr; gap: 18px; align-items: start;
  padding: 20px 22px; background: linear-gradient(180deg, var(--cream-3) 0%, var(--cream-2) 100%);
  border: 1px solid var(--border); border-radius: var(--r-md); position: relative; overflow: hidden;
}
.wkv3-wait::before {
  content: ""; position: absolute; inset: 0;
  background: radial-gradient(circle at 18px 36px, var(--peach-50) 0%, transparent 22%);
  pointer-events: none;
}
.wkv3-wait__ico { position: relative; width: 56px; height: 56px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.wkv3-wait__core { width: 12px; height: 12px; border-radius: 50%; background: var(--live); z-index: 2; }
.wkv3-wait__pulse { position: absolute; inset: 8px; border-radius: 50%; background: var(--live); opacity: 0.25; animation: wkv3-wait-pulse 2.4s ease-out infinite; }
.wkv3-wait__pulse--2 { animation-delay: 1.2s; }
@keyframes wkv3-wait-pulse { 0% { transform: scale(0.6); opacity: 0.35; } 100% { transform: scale(1.7); opacity: 0; } }
.wkv3-wait__body { min-width: 0; position: relative; z-index: 1; }
.wkv3-wait__kicker { margin: 0 0 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--live); }
.wkv3-wait__t { margin: 0; font-family: var(--font-serif); font-weight: 400; font-size: 20px; letter-spacing: -0.018em; line-height: 1.2; color: var(--ink); }
.wkv3-wait__sub { margin: 6px 0 12px; font-size: 13px; color: var(--ink-2); line-height: 1.45; }
.wkv3-wait__bar { height: 4px; background: var(--cream); border-radius: 2px; overflow: hidden; border: 1px solid var(--border); }
.wkv3-wait__bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--live-pulse), var(--live)); border-radius: 2px; animation: wkv3-wait-shimmer 3s ease-in-out infinite alternate; }
@keyframes wkv3-wait-shimmer { from { width: 38%; } to { width: 78%; } }
.wkv3-wait__meta { margin: 8px 0 0; font-size: 11.5px; color: var(--ink-3); }

/* Recent activity */
.wkv3-activity__list { display: grid; gap: 8px; }
.wkv3-activity__row {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  padding: 12px 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--candidate-card);
  color: inherit;
  text-decoration: none;
  transition: border-color var(--dur-fast) var(--ease), transform var(--dur-base) var(--ease);
}
.wkv3-activity__row:hover { border-color: var(--live-border); transform: translateY(-1px); }
.wkv3-activity__mark {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--cream);
  font-size: 13px;
  font-weight: 700;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.18);
}
.wkv3-activity__body { min-width: 0; display: grid; gap: 3px; }
.wkv3-activity__event {
  font-size: 10.5px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--live);
}
.wkv3-activity__body strong {
  min-width: 0;
  font-size: 14px;
  line-height: 1.25;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.wkv3-activity__body em {
  font-style: normal;
  font-size: 12.5px;
  color: var(--ink-3);
  overflow-wrap: anywhere;
}
.wkv3-activity__detail {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--ink-2);
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.wkv3-activity__when {
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}

/* Stage bar */
.wkv3-stages {
  display: grid; grid-template-columns: repeat(6, 1fr);
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--candidate-card); overflow: hidden;
}
.wkv3-stage {
  appearance: none; border: 0; background: transparent; text-align: left;
  padding: 12px 14px 14px; display: grid; gap: 6px; cursor: pointer;
  border-right: 1px solid var(--border); position: relative;
  transition: background var(--dur-fast) var(--ease);
}
.wkv3-stage:last-child { border-right: 0; }
.wkv3-stage:hover { background: var(--candidate-card-hover); }
.wkv3-stage.is-active { background: var(--cream); }
.wkv3-stage.is-active::after { content: ""; position: absolute; left: 14px; right: 14px; bottom: 0; height: 2px; background: var(--live); border-radius: 2px; }
.wkv3-stage.is-disabled { cursor: default; opacity: 0.54; }
.wkv3-stage.is-disabled:hover { background: transparent; }
.wkv3-stage__top { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; letter-spacing: -0.005em; color: var(--ink); white-space: nowrap; }
.wkv3-stage__sdot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex: none; }
.wkv3-stage__n { font-family: var(--font-sans); font-weight: 600; font-size: 20px; letter-spacing: -0.01em; color: var(--ink); line-height: 1; font-variant-numeric: tabular-nums; }
.wkv3-stage__n.is-zero { color: var(--ink-4); }

/* Pipeline rows */
.wkv3-rows { display: grid; gap: 8px; }
.wkv3-row {
  display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 16px; align-items: center;
  padding: 14px 18px; background: var(--candidate-card); border: 1px solid var(--border);
  border-radius: var(--r-md); transition: border-color var(--dur-fast) var(--ease), transform var(--dur-base) var(--ease);
}
.wkv3-row:hover { border-color: var(--live-border); transform: translateY(-1px); }
.wkv3-row__body { min-width: 0; }
.wkv3-row__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 3px; }
.wkv3-row__t { margin: 0; font-family: var(--font-sans); font-weight: 600; font-size: 14.5px; color: var(--ink); letter-spacing: -0.005em; line-height: 1.35; }
.wkv3-row__co { margin: 0; font-size: 12.5px; color: var(--ink-3); }
.wkv3-row__co b { color: var(--ink-2); font-weight: 600; }
.wkv3-row__next { margin: 4px 0 0; font-size: 13px; color: var(--ink-2); line-height: 1.4; }
.wkv3-row__right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.wkv3-row__when { font-size: 11.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; }

/* Chips */
.wkv3-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: var(--r-pill); font-size: 11.5px; font-weight: 600; line-height: 1; }
.wkv3-chip--warm { background: var(--peach-50); color: var(--ink); border: 1px solid var(--peach-100); }
.wkv3-chip--blue { background: rgba(31,111,235,.10); color: #1f6feb; }
.wkv3-chip--live { background: var(--live-soft); color: var(--live); border: 1px solid var(--live-border); }
.wkv3-chip--muted { background: var(--cream-2); color: var(--ink-3); border: 1px solid var(--border); }
.wkv3-chip--ink { background: var(--ink); color: var(--cream); }

/* Match peeks */
.wkv3-peeks { display: grid; gap: 8px; }
.wkv3-peek {
  display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 14px; align-items: center;
  padding: 13px 18px; background: var(--candidate-card); border: 1px solid var(--border);
  border-radius: var(--r-md); transition: border-color var(--dur-fast) var(--ease), transform var(--dur-base) var(--ease);
}
.wkv3-peek:hover { border-color: var(--live-border); transform: translateY(-1px); }
.wkv3-peek__body { min-width: 0; }
.wkv3-peek__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 2px; }
.wkv3-peek__t { margin: 0; font-family: var(--font-sans); font-weight: 600; font-size: 14.5px; color: var(--ink); letter-spacing: -0.005em; line-height: 1.3; }
.wkv3-peek__co { margin: 0; font-size: 12.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wkv3-peek__co b { color: var(--ink-2); font-weight: 600; }
.wkv3-peek__right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; white-space: nowrap; }
.wkv3-peek__salary { font-size: 12.5px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
.wkv3-peek__actions { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.wkv3-peek__go,
.wkv3-peek__signal {
  display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 600;
  text-decoration: none; line-height: 1.2;
}
.wkv3-peek__go { color: var(--live); }
.wkv3-peek__signal { color: var(--ink-3); }
.wkv3-peek__go:hover,
.wkv3-peek__signal:hover { color: var(--ink); }
.wkv3-seeall {
  display: inline-flex; align-items: center; gap: 6px; justify-self: start;
  padding: 9px 15px; font-family: var(--font-sans); font-size: 13px; font-weight: 600;
  color: var(--ink-2); text-decoration: none; border: 1px solid var(--border);
  border-radius: var(--r-pill); background: var(--cream-2);
  transition: border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.wkv3-seeall:hover { border-color: var(--live-border); color: var(--ink); }

.wkv3-roleerr {
  display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
  margin-bottom: 18px; padding: 16px 18px; border: 1px solid rgba(156,43,36,.32);
  border-radius: var(--r-md); background: rgba(156,43,36,.065); color: #7e241e;
}
.wkv3-roleerr div { display: grid; gap: 3px; min-width: 0; }
.wkv3-roleerr strong { font-size: 14px; color: #69201a; }
.wkv3-roleerr span { font-size: 13px; line-height: 1.45; color: #8d352c; }

/* Empty / loading block */
.wkv3-empty-block {
  padding: 28px 24px; background: var(--cream-3); border: 1px dashed var(--border-strong);
  border-radius: var(--r-md); color: var(--ink-3); font-size: 14px; line-height: 1.5; text-align: center;
}
.wkv3-empty-block--error { border-color: rgba(156,43,36,.38); background: rgba(156,43,36,.055); color: #8d352c; }
.wkv3-empty-block h3 { margin: 0 0 6px; font-family: var(--font-serif); font-weight: 400; font-size: 20px; color: var(--ink); letter-spacing: -0.018em; }
.wkv3-empty-block p { margin: 0 auto; color: var(--ink-2); font-size: 13px; max-width: 460px; }
.wkv3-empty-actions {
  margin-top: 16px; display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap;
}

/* Responsive */
@media (max-width: 1180px) {
  .wkv3-grid { grid-template-columns: 1fr; }
  .wkv3-side { position: static; grid-template-columns: 1fr 1fr; gap: 14px; }
}
@media (max-width: 820px) {
  .wkv3-loop__body { grid-template-columns: 1fr; }
  .wkv3-stages { grid-template-columns: repeat(3, 1fr); }
  .wkv3-stage:nth-child(3) { border-right: 0; }
  .wkv3-stage:nth-child(n+4) { border-top: 1px solid var(--border); }
  .wkv3-row { grid-template-columns: 44px 1fr; padding: 12px 14px; }
  .wkv3-row__right { grid-column: 1 / -1; flex-direction: row; justify-content: space-between; align-items: center; }
}
@media (max-width: 700px) {
  .wkv3-status { padding: 22px 0 14px; }
  .wkv3-status__inner { grid-template-columns: 1fr; gap: 16px; align-items: stretch; }
  .wkv3-status__cta { justify-items: stretch; text-align: left; }
  .wkv3-status__cta .wk-btn { justify-content: space-between; }
  .wkv3-side { grid-template-columns: 1fr; }
  .wkv3-peek { grid-template-columns: 44px minmax(0, 1fr); padding: 13px 14px; }
  .wkv3-peek__right { grid-column: 1 / -1; flex-direction: row; align-items: center; justify-content: space-between; min-width: 0; gap: 10px; }
  .wkv3-peek__actions { flex-direction: row; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
  .wkv3-act { grid-template-columns: 44px 1fr; padding: 14px 16px; }
  .wkv3-act__right { grid-column: 1 / -1; flex-direction: row; align-items: center; justify-content: space-between; min-width: 0; gap: 10px; }
  .wkv3-activity__row { grid-template-columns: 38px minmax(0, 1fr); }
  .wkv3-activity__when { grid-column: 2; }
  .wkv3-loop__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wkv3-loop__text { font-size: 18px; }
  .wkv3-stages { grid-template-columns: repeat(2, 1fr); }
  .wkv3-stage:nth-child(odd) { border-right: 1px solid var(--border); }
  .wkv3-stage:nth-child(even) { border-right: 0; }
  .wkv3-stage:nth-child(n+3) { border-top: 1px solid var(--border); }
  .wkv3-wait { grid-template-columns: 1fr; }
  .wkv3-wait__ico { display: none; }
}
`

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

export function CandidatePrivacy() {
  const gate = useCandidatePortalGate()
  const state = useClaimedProfile()

  if (gate.status !== "ready") {
    return <PortalGatePending gate={gate} kicker="Privacy" />
  }

  if (state.status === "signed_out") return <SignInRequired kicker="Privacy" />
  if (state.status === "loading") return <PortalLoading kicker="Privacy" />
  if (state.status === "error") return <PortalError kicker="Privacy" message={state.message} />
  return <PrivacySurface profile={state.profile} />
}

function useProfileHashScroll() {
  const location = useLocation()
  useEffect(() => {
    const hash = location.hash.replace(/^#/, "") || window.location.hash.replace(/^#/, "")
    if (!hash) return
    window.setTimeout(() => {
      document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" })
    }, 0)
  }, [location.hash])
}

type ProfileSignalDraft = { text: string; sourceLabel: string; structuredFields: Record<string, unknown> }

function useProfileSignalDraft(): ProfileSignalDraft | null {
  const location = useLocation()
  return useMemo(() => {
    const params = new URLSearchParams(location.search)
    const title = params.get("profileRoleSignalTitle")?.trim()
    const company = params.get("profileRoleSignalCompany")?.trim()
    if (!title || !company) return null

    const outcome = params.get("profileRoleSignalOutcome")?.trim()
    const reason = params.get("profileRoleSignalReason")?.trim()
    const actions = params.get("profileRoleSignalActions")?.trim()
    if (outcome === "intro_rejected" && reason) {
      return {
        sourceLabel: "Closed intro signal",
        structuredFields: {
          roleSignal: {
            source: "closed_intro",
            title,
            company,
            outcome: "intro_rejected",
            reason,
          },
        },
        text: `Use this closed intro as profile signal: ${title} at ${company}. Employer intro outcome: ${reason}. Update my durable matching preferences or profile evidence if this closure should change future matching. Do not treat this as an automatic application.`,
      }
    }

    if (outcome === "not_passed" && reason) {
      const actionList = actions
        ? actions.split(/\n+/g).map((a) => a.trim()).filter(Boolean).slice(0, 3)
        : []
      const actionsText = actions
        ? ` Recommended next profile updates: ${actions.replace(/\n+/g, "; ")}.`
        : ""
      return {
        sourceLabel: "Closed role signal",
        structuredFields: {
          roleSignal: {
            source: "closed_role",
            title,
            company,
            outcome: "not_passed",
            reason,
            actions: actionList,
          },
        },
        text: `Use this closed role as profile signal: ${title} at ${company}. Claire closed this role because: ${reason}.${actionsText} Update my durable matching preferences or profile evidence to avoid repeating this mismatch. Do not treat this as an automatic application.`,
      }
    }

    if (reason) {
      return {
        sourceLabel: "Recommended role signal",
        structuredFields: {
          roleSignal: {
            source: "recommended_role",
            title,
            company,
            reason,
          },
        },
        text: `Use this recommended role as profile signal: ${title} at ${company}. Claire surfaced this role because: ${reason.replace(/\n+/g, "; ")}. If this reflects what I want, update my durable matching preferences. Do not treat this as an automatic application.`,
      }
    }

    const context = [
      params.get("profileRoleSignalFunction")?.trim(),
      params.get("profileRoleSignalLevel")?.trim(),
      params.get("profileRoleSignalLocation")?.trim(),
    ].filter((v): v is string => Boolean(v))

    const contextText = context.length ? ` (${context.join(", ")})` : ""
    return {
      sourceLabel: "Source role from market",
      structuredFields: {
        roleSignal: {
          source: "market_role",
          title,
          company,
          context,
        },
      },
      text: `Use this market role as profile signal: ${title} at ${company}${contextText}. If this reflects what I want, update my durable matching preferences. Do not treat this as an automatic application.`,
    }
  }, [location.search])
}

function ProfileSurface({ initial }: { initial: CandidateSelfProfile }) {
  useProfileHashScroll()
  const profileSignalDraft = useProfileSignalDraft()
  const matchesState = useCandidateMatches(true)
  const [profile, setProfile] = useState<CandidateSelfProfile>(initial)
  const [editing, setEditing] = useState(false)
  useEffect(() => setProfile(initial), [initial])
  const completeness = deriveCompleteness(profile)
  const visibility = matchesState.status === "ready" ? deriveVisibilityFromMatches(matchesState.matches) : null
  const visibilityError = matchesState.status === "error" ? matchesState.message : null
  const claireHref = buildClaireImessageHref(profile.senderNumber)
  return (
    <CandidateShell signedIn signedInUser={{ name: profile.displayName ?? "You", email: profile.emailMasked }} claireHref={claireHref}>
      <style>{ME_PORTAL_STYLES}</style>
      <style>{ME_V3_STYLES}</style>
      <style>{PROFILE_STYLES}</style>
      <div className="wk-prof">
        <div className="wk-container">
          <header className="wk-prof__head">
            <div>
              <p className="wk-eyebrow">Profile · what Claire pitches</p>
              <h1 className="wk-prof__h1">Your operating profile.</h1>
              <p className="wk-prof__sub">
                Everything Claire knows about you, and exactly what she shares on your behalf. The more
                complete this is, the more evidence Claire has for role review.
              </p>
            </div>
            <div className="wk-prof__head-actions">
              <span className="wk-prof__live">
                <PulseDot size={6} /> {profile.lifecycleState === "claimed" ? "Profile active" : formatProfileStatus(profile.lifecycleState)}
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

          {/* Top strip: completeness + visibility — first-class state (reused from Home) */}
          <div className="wk-prof__topstrip">
            <MeCompletenessCard completeness={completeness} />
            {visibility ? <MeVisibilityCard visibility={visibility} /> : <MeVisibilityPendingCard error={visibilityError} />}
          </div>

          <div className="wk-prof__grid">
            <div className="wk-prof__main">
              <IdentityCard profile={profile} />
              <MatchPreferencesCard profile={profile} onSaved={setProfile} />
              <WhatClairePitchesCard profile={profile} claireHref={claireHref} />
              <ExperienceHighlightsCard profile={profile} />
              <SkillsCard profile={profile} editing={editing} claireHref={claireHref} />
              <UpdatePreferencesPanel onProfileUpdated={setProfile} initialCorrectionDraft={profileSignalDraft} />
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

function PrivacySurface({ profile }: { profile: CandidateSelfProfile }) {
  useProfileHashScroll()
  const claireHref = buildClaireImessageHref(profile.senderNumber)
  return (
    <CandidateShell signedIn signedInUser={{ name: profile.displayName ?? "You", email: profile.emailMasked }} claireHref={claireHref}>
      <style>{ME_PORTAL_STYLES}</style>
      <style>{PROFILE_STYLES}</style>
      <div className="wk-prof wk-privacy">
        <div className="wk-container">
          <header className="wk-prof__head">
            <div>
              <p className="wk-eyebrow">Candidate privacy</p>
              <h1 className="wk-prof__h1">Your privacy requests.</h1>
              <p className="wk-prof__sub">
                Export, deletion, outreach, and employer-block requests stay reviewed before anything binding changes.
              </p>
            </div>
            <div className="wk-prof__head-actions">
              <Link to="/me/profile" className="wk-btn wk-btn--secondary wk-btn--sm">
                <Icon name="arrow-left" size={13} stroke={2} /> Back to profile
              </Link>
            </div>
          </header>

          <div className="wk-privacy__grid">
            <PrivacyCard />
            <PrivacyRequestPanel />
          </div>
        </div>
      </div>
    </CandidateShell>
  )
}

// ── Match preferences — the canonical-tag tagging surface ───────────────────
// Chips read current selections from globalTags (best-effort, real where the
// projection includes the field) and persist through the existing correction
// pipeline (free-form → Claire maps to canonical tags). No mock-only toggles.
type ProfilePrefGroup = {
  field: string
  label: string
  hint: string
  multi: boolean
  tone: "default" | "warn"
  readFields: string[]
  options: string[]
}

// Canonical vocab tokens — mirror @wekruit/shared-tags canonical vocabs
// (role-function, industry-sector, company-stage, job-type, career-stage, visa)
// + the orchestrator `companySize` enum. shared-tags is the single source of
// truth; the tokens are inlined here only to avoid a vite build-time dependency
// on the package's compiled dist. Keep in sync with packages/shared-tags.
const PROFILE_PREF_GROUPS: ProfilePrefGroup[] = [
  {
    field: "targetRoleFunction",
    label: "Target roles",
    hint: "What you want to do — Claire's first hard filter.",
    multi: true,
    tone: "default",
    readFields: ["targetRoleFunction", "roleFunction"],
    options: [
      "software_engineering", "engineering_and_development", "product_management", "data_analysis",
      "business_analyst", "creatives_and_design", "marketing", "sales", "customer_service_and_support",
      "management_and_executive", "consultant", "accounting_and_finance", "human_resources",
      "legal_and_compliance", "education_and_training", "public_sector_and_government", "arts_and_entertainment",
    ],
  },
  {
    field: "industrySector",
    label: "Industry",
    hint: "Sectors you want to work in.",
    multi: true,
    tone: "default",
    readFields: ["industrySector", "relevantIndustry"],
    options: [
      "artificial_intelligence_and_machine_learning", "software_and_saas", "financial_technology",
      "healthcare_and_life_sciences", "biotechnology_and_pharmaceuticals", "hardware_and_semiconductors",
      "e_commerce_and_retail", "consumer_goods", "cybersecurity", "crypto_web3_blockchain", "gaming_and_esports",
      "education_technology", "real_estate_and_proptech", "transportation_and_logistics", "automotive_and_mobility",
      "aerospace_and_defense", "energy_and_utilities", "clean_energy_and_climate_tech", "manufacturing_and_industrial",
      "construction_and_built_environment", "agriculture_and_foodtech", "hospitality_and_travel",
      "media_and_entertainment", "advertising_and_marketing", "telecommunications", "professional_services",
      "legal_services", "accounting_and_audit", "management_consulting", "human_resources_and_recruiting",
      "non_profit_and_social_impact", "public_sector_and_government", "research_and_academia", "sports_and_recreation",
      "fashion_and_apparel", "beauty_and_personal_care", "arts_and_culture", "accessibility_and_assistive_technology",
      "robotics_and_automation", "quantum_computing", "space_technology", "technology_general",
    ],
  },
  {
    field: "companyStage",
    label: "Company stage",
    hint: "Funding stage you'd join.",
    multi: true,
    tone: "default",
    readFields: ["companyStage"],
    options: [
      "pre_seed", "seed", "series_a", "series_b", "series_c", "series_d_plus",
      "ipo_public", "private_mature", "bootstrapped", "non_profit",
    ],
  },
  {
    field: "companySize",
    label: "Company size",
    hint: "How big — pick one.",
    multi: false,
    tone: "default",
    readFields: ["companySize"],
    options: ["seed", "early_startup", "scale_up", "mid_market", "enterprise", "open"],
  },
  {
    field: "targetJobType",
    label: "Job type",
    hint: "Employment type.",
    multi: true,
    tone: "default",
    readFields: ["targetJobType"],
    options: [
      "full_time", "internship", "new_graduate", "contract", "part_time",
      "fellowship", "apprenticeship", "freelance", "return_to_work_program", "co_op_rotation",
    ],
  },
  {
    field: "careerStage",
    label: "Your seniority",
    hint: "Your level — pick one.",
    multi: false,
    tone: "default",
    readFields: ["careerStage"],
    options: [
      "intern", "student", "entry_level", "junior", "mid_level", "senior",
      "staff", "principal", "manager", "director", "vp", "c_level", "founder",
    ],
  },
  {
    field: "visaStatus",
    label: "Work authorization",
    hint: "Pick one.",
    multi: false,
    tone: "default",
    readFields: ["visaStatus"],
    options: ["citizen", "permanent_resident", "sponsor_needed", "other"],
  },
]

function MatchPreferencesCard({
  profile,
  onSaved,
}: {
  profile: CandidateSelfProfile
  onSaved: (p: CandidateSelfProfile) => void
}) {
  const tags = (profile.globalTags ?? {}) as Record<string, unknown>
  const readField = (fields: string[]): string[] => {
    for (const f of fields) {
      const v = tags[f]
      if (Array.isArray(v)) return v.map((x) => String(x))
      if (typeof v === "string" && v.length > 0) return [v]
    }
    return []
  }

  const [picked, setPicked] = useState<Record<string, Set<string>>>(() => {
    const init: Record<string, Set<string>> = {}
    for (const g of PROFILE_PREF_GROUPS) {
      const current = readField(g.readFields).filter((t) => g.options.includes(t))
      init[g.field] = new Set(g.multi ? current : current.slice(0, 1))
    }
    return init
  })
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [message, setMessage] = useState<string | null>(null)

  function toggle(field: string, opt: string, multi: boolean) {
    setPicked((prev) => {
      const next = { ...prev }
      const s = new Set(next[field])
      if (multi) {
        if (s.has(opt)) s.delete(opt)
        else s.add(opt)
      } else if (s.has(opt)) {
        s.clear()
      } else {
        s.clear()
        s.add(opt)
      }
      next[field] = s
      return next
    })
    setDirty(true)
    setStatus("idle")
    setMessage(null)
  }

  async function save() {
    setStatus("submitting")
    setMessage(null)
    // Deterministic canonical tag patch — keyed by the real candidate tag fields.
    const structuredFields: Record<string, unknown> = {}
    const summary: string[] = []
    for (const g of PROFILE_PREF_GROUPS) {
      const sel = Array.from(picked[g.field] ?? [])
      structuredFields[g.field] = g.multi ? sel : (sel[0] ?? null)
      if (sel.length > 0) summary.push(`${g.label}: ${sel.map(formatProfileValue).join(", ")}`)
    }
    const correctionText = summary.length
      ? `Match preferences updated — ${summary.join("; ")}.`
      : "Match preferences cleared."
    try {
      const submit = createCandidateProfileCorrectionSubmitter(functions())
      const result = await submit({ correctionText, targetType: "user_tags", structuredFields })
      onSaved(result.selfProfile)
      setDirty(false)
      setStatus("success")
      setMessage("Saved — Claire will match against these.")
    } catch (err) {
      setStatus("error")
      setMessage(callableSubmitErrorMessage(err))
    }
  }

  return (
    <section id="match-preferences" className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">
        Match preferences
        <span className="wk-prof-card__src">Claire matches against these</span>
      </h3>
      <p className="wk-prof-card__hint">
        The canonical tags Claire matches you against — the same vocabulary used to tag every job. Toggle what
        fits, then send it to Claire.
      </p>
      {PROFILE_PREF_GROUPS.map((g) => (
        <PrefGroup
          key={g.field}
          label={g.label}
          hint={g.hint}
          tone={g.tone}
          options={g.options}
          selected={picked[g.field]}
          onToggle={(o) => toggle(g.field, o, g.multi)}
        />
      ))}
      <div className="wk-prefs__save">
        <button
          type="button"
          className="wk-btn wk-btn--primary wk-btn--sm"
          disabled={!dirty || status === "submitting"}
          onClick={save}
        >
          {status === "submitting" ? "Saving…" : "Save preferences"}
        </button>
        {status === "success" && message ? <span className="wk-success">{message}</span> : null}
        {status === "error" && message ? <span className="wk-error">{message}</span> : null}
      </div>
    </section>
  )
}

function PrefGroup({
  label,
  hint,
  options,
  selected,
  onToggle,
  tone = "default",
}: {
  label: string
  hint: string
  options: string[]
  selected: Set<string> | undefined
  onToggle: (opt: string) => void
  tone?: "default" | "warn"
}) {
  return (
    <div className="wk-prefs">
      <div className="wk-prefs__head">
        <span className="wk-prefs__label">{label}</span>
        <span className="wk-prefs__hint">{hint}</span>
      </div>
      <div className={`wk-prefs__chips wk-prefs__chips--${tone}`}>
        {options.map((o) => {
          const on = selected?.has(o) ?? false
          return (
            <button
              key={o}
              type="button"
              className={`wk-pref${on ? " is-on" : ""}`}
              onClick={() => onToggle(o)}
              aria-pressed={on}
            >
              <span className="wk-pref__check" aria-hidden="true">
                {on ? <Icon name="check" size={10} stroke={2.6} /> : null}
              </span>
              {formatProfileValue(o)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function IdentityCard({ profile }: { profile: CandidateSelfProfile }) {
  const tone: "warm" | "moss" | "slate" = TONE_POOL[djb2(profile.displayName ?? "you") % TONE_POOL.length]
  const headline = deriveHeadline(profile)
  const metaParts: string[] = []
  if (profile.globalTags?.targetJobType?.length) metaParts.push(joinTags(profile.globalTags.targetJobType, 2, " · "))
  if (profile.globalTags?.targetLocations?.length) metaParts.push(joinTags(profile.globalTags.targetLocations, 2, ", "))
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

function WhatClairePitchesCard({
  profile,
  claireHref,
}: {
  profile: CandidateSelfProfile
  claireHref: string | null
}) {
  const tags = profile.globalTags
  const rows: Array<{ label: string; value: string }> = []
  if (tags?.roleFunction?.length) rows.push({ label: "Targets", value: joinTags(tags.roleFunction, 4, " · ") })
  if (tags?.targetLocations?.length) rows.push({ label: "Where", value: joinTags(tags.targetLocations, 5, ", ") })
  if (tags?.industrySector?.length) rows.push({ label: "Industries", value: joinTags(tags.industrySector, 5, " · ") })
  if (tags?.targetJobType?.length) rows.push({ label: "Job type", value: joinTags(tags.targetJobType, 4, " · ") })
  if (tags?.companySizePreference?.length) rows.push({ label: "Company size", value: joinTags(tags.companySizePreference, 4, " · ") })
  if (tags?.companyStage?.length) rows.push({ label: "Company stage", value: joinTags(tags.companyStage, 4, " · ") })
  if (tags?.careerStageRange?.length === 2) {
    rows.push({ label: "Seniority", value: `${formatProfileValue(tags.careerStageRange[0])}–${formatProfileValue(tags.careerStageRange[1])}` })
  } else if (tags?.careerStage) {
    rows.push({ label: "Seniority", value: formatProfileValue(tags.careerStage) })
  }
  if (tags?.relevantTags?.length) rows.push({ label: "Tags", value: joinTags(tags.relevantTags, 6, " · ") })
  return (
    <section className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">What Claire pitches</h3>
      <p className="wk-prof-card__hint">These are the answers Claire gives any hiring manager who asks.</p>
      {rows.length === 0 ? (
        <div className="wk-prof-card__empty">
          <p className="wk-prof-card__hint" style={{ margin: 0 }}>
            Claire hasn&apos;t captured these yet.
          </p>
          <div className="wk-prof-card__actions">
            {claireHref ? (
              <a href={claireHref} className="wk-btn wk-btn--secondary wk-btn--sm">
                Message Claire
              </a>
            ) : null}
            <Link to="/me/profile#profile-corrections" className="wk-btn wk-btn--primary wk-btn--sm">
              Update preferences
            </Link>
          </div>
        </div>
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

function ExperienceHighlightsCard({ profile }: { profile: CandidateSelfProfile }) {
  const experiences = (profile.experienceHighlights ?? []).slice(0, 8)
  if (experiences.length === 0) return null
  const sourceLabel = experiences.find((experience) => experience.sourceLabel)?.sourceLabel
  return (
    <section className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">Experience</h3>
      {sourceLabel ? <p className="wk-prof-card__hint">From {sourceLabel}</p> : null}
      <div className="wk-prof-exp">
        {experiences.map((experience, index) => {
          const meta = experienceMeta(experience)
          return (
            <div
              key={`${experience.company}-${experience.title}-${experience.startDate ?? index}`}
              className="wk-prof-exp__item"
            >
              <span className="wk-prof-exp__dot" aria-hidden="true" />
              <div className="wk-prof-exp__body">
                <div className="wk-prof-exp__top">
                  <strong>{experience.title}</strong>
                  <span>{formatExperienceRange(experience)}</span>
                </div>
                <div className="wk-prof-exp__company">
                  {experience.companyLogoUrl ? (
                    <img
                      src={experience.companyLogoUrl}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(event) => {
                        event.currentTarget.style.display = "none"
                      }}
                    />
                  ) : null}
                  <span>
                    {experience.company}
                    {experience.location ? ` · ${experience.location}` : ""}
                  </span>
                </div>
                {experience.description ? (
                  <p className="wk-prof-exp__desc">{experience.description}</p>
                ) : null}
                {meta.length > 0 ? (
                  <div className="wk-prof-exp__meta">
                    {meta.map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function formatExperienceRange(experience: NonNullable<CandidateSelfProfile["experienceHighlights"]>[number]): string {
  const end = experience.currentRole ? "Present" : experience.endDate
  return [experience.startDate, end].filter(Boolean).join(" - ")
}

function experienceMeta(experience: NonNullable<CandidateSelfProfile["experienceHighlights"]>[number]): string[] {
  const meta = [
    experience.department,
    experience.managementLevel,
    experience.companyIndustry,
    experience.companySizeRange,
    [experience.companyHqCity, experience.companyHqCountry].filter(Boolean).join(", "),
  ]
  return meta.filter((item): item is string => Boolean(item))
}

function SkillsCard({
  profile,
  editing,
  claireHref,
}: {
  profile: CandidateSelfProfile
  editing: boolean
  claireHref: string | null
}) {
  const skills = (profile.globalTags?.skills ?? []).map(formatProfileValue).filter(Boolean)
  if (skills.length === 0 && !editing) {
    return (
      <section id="skills" className="wkv2-card wk-prof-card">
        <h3 className="wkv2-card__h">Skills</h3>
        <div className="wk-prof-card__empty">
          <p className="wk-prof-card__hint">
            Claire pulls these from your résumé.
          </p>
          {claireHref ? (
            <a href={claireHref} className="wk-btn wk-btn--secondary wk-btn--sm">
              Send résumé
            </a>
          ) : null}
        </div>
      </section>
    )
  }
  return (
    <section id="skills" className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">Skills</h3>
      <p className="wk-prof-card__hint">Tags Claire matches against role requirements.</p>
      <div className="wkv2-prof__skills wk-prof-skills">
        {skills.map((s) => (
          <span key={s} className="wkv2-prof__skill wk-prof-skill">
            {s}
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
  const githubRepos = (profile.githubPublicRepos ?? []).slice(0, 3)
  const claireHref = buildClaireImessageHref(profile.senderNumber)
  return (
    <section id="connected-accounts" className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">Connected accounts</h3>
      <div className="wkv2-conn wk-prof-conn">
        {items.map((c) => (
          <div key={c.id} id={`connector-${c.id}`} className="wkv2-conn__row">
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
            <ConnectorAction connector={c} claireHref={claireHref} />
          </div>
        ))}
        {githubRepos.length > 0 ? (
          <div className="wkv2-conn__repos" aria-label="GitHub public repositories">
            {githubRepos.map((repo) => {
              const label = repo.fullName ?? repo.name
              const meta = [repo.language, typeof repo.stars === "number" ? `${repo.stars} stars` : ""]
                .filter(Boolean)
                .join(" · ")
              return repo.url ? (
                <a key={repo.url} href={repo.url} target="_blank" rel="noreferrer" className="wkv2-conn__repo">
                  <span>{label}</span>
                  {meta ? <em>{meta}</em> : null}
                </a>
              ) : (
                <span key={label} className="wkv2-conn__repo">
                  <span>{label}</span>
                  {meta ? <em>{meta}</em> : null}
                </span>
              )
            })}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function PrivacyCard() {
  const rows = [
    {
      label: "Matching visibility",
      value: "Claire uses your profile for role matching; reviewed requests pause outreach or change visibility rules.",
    },
    {
      label: "Current employer protection",
      value: "Send a privacy request with the company name if a current or sensitive employer should be blocked.",
    },
    {
      label: "Resume sharing",
      value: "This profile screen does not publish your full resume; sharing changes go through operator review.",
    },
  ]
  return (
    <section id="privacy" className="wkv2-card wk-prof-card">
      <h3 className="wkv2-card__h">Privacy</h3>
      <div className="wk-prof-privacy">
        {rows.map((row) => (
          <div key={row.label} className="wk-prof-privacy__row">
            <span>
              <strong>{row.label}</strong>
              <em>{row.value}</em>
            </span>
            <span className="wk-prof-privacy__badge">Reviewed</span>
          </div>
        ))}
      </div>
      <p className="wk-prof-card__hint" style={{ marginTop: 8 }}>
        Binding changes go through reviewed privacy requests below.
      </p>
    </section>
  )
}

function UpdatePreferencesPanel({
  initialCorrectionDraft,
  onProfileUpdated,
}: {
  initialCorrectionDraft?: ProfileSignalDraft | null
  onProfileUpdated: (profile: CandidateSelfProfile) => void
}) {
  const initialCorrectionText = initialCorrectionDraft?.text ?? null
  const [correctionText, setCorrectionText] = useState(() => initialCorrectionText ?? "")
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (initialCorrectionText) setCorrectionText(initialCorrectionText)
  }, [initialCorrectionText])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    setStatus("submitting")
    try {
      const submitCorrection = createCandidateProfileCorrectionSubmitter(functions())
      const structuredFields = initialCorrectionDraft?.structuredFields
      const result = await submitCorrection({ correctionText, structuredFields })
      onProfileUpdated(result.selfProfile)
      setCorrectionText("")
      const roleSignalSubmitted = Boolean(initialCorrectionDraft?.structuredFields.roleSignal)
      setMessage(
        roleSignalSubmitted
          ? "Role signal saved — Claire will use it as matching evidence."
          : "Correction submitted. Claire will review it for future matching.",
      )
      setStatus("success")
    } catch (err) {
      setMessage(callableSubmitErrorMessage(err))
      setStatus("error")
    }
  }

  return (
    <section id="profile-corrections" className="wkv2-card wk-prof-card" aria-labelledby="prof-update-title">
      <h3 className="wkv2-card__h" id="prof-update-title">Update preferences</h3>
      <p className="wk-prof-card__hint">
        Tell Claire what to change. Free-form is fine — she'll update the canonical tags for you. Edit any market role context, closed role context, or closed intro context before sending.
      </p>
      {initialCorrectionDraft ? (
        <div className="wk-prof-card__signal" aria-label={initialCorrectionDraft.sourceLabel}>
          <strong>{initialCorrectionDraft.sourceLabel}</strong>
          <span>Review this as preference evidence, then send it to Claire if it reflects what you want.</span>
        </div>
      ) : null}
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
    <section id="privacy-requests" className="wkv2-card wk-prof-card" aria-labelledby="prof-privacy-title">
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
      : "Loading your roles and interviews…"
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
      <p className="wk-prof__sub">Loading your roles and interviews…</p>
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
.wkv2-conn__btn--connect {
  color: var(--wk-live);
  border: 1px solid var(--wk-live-border);
  background: var(--wk-live-soft);
}
.wkv2-conn__btn--connect:hover { background: var(--wk-cream); color: var(--wk-live-2); }
.wkv2-conn__btn--connect:disabled {
  opacity: 0.65;
  cursor: wait;
}
.wkv2-conn__btn--muted,
.wkv2-conn__btn--muted:hover {
  background: transparent;
  color: var(--wk-ink-3);
  cursor: default;
}
.wkv2-conn__action {
  display: grid;
  justify-items: end;
  gap: 4px;
  max-width: 220px;
}
.wkv2-conn__error {
  color: #8d352c;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.25;
  text-align: right;
  white-space: normal;
}
.wkv2-conn__check {
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--wk-live); color: var(--wk-cream);
  display: inline-flex; align-items: center; justify-content: center;
  flex: none;
}
.wkv2-conn__repos {
  display: grid;
  gap: 4px;
  padding: 2px 4px 10px 40px;
}
.wkv2-conn__repo {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  min-width: 0;
  color: var(--wk-ink);
  text-decoration: none;
  font-size: 11.5px;
  line-height: 1.25;
}
.wkv2-conn__repo span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wkv2-conn__repo em {
  font-style: normal;
  color: var(--wk-ink-3);
  white-space: nowrap;
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
.wk-privacy__grid {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(320px, 1.05fr);
  gap: 18px;
  align-items: start;
}

.wk-prof-card { padding: 22px 22px 20px; }
.wk-prof-card__hint {
  font-size: 12.5px; color: var(--wk-ink-3);
  margin: -6px 0 6px; line-height: 1.45;
}
.wk-prof-card__signal {
  display: grid; gap: 3px;
  margin: 8px 0 10px;
  padding: 10px 12px;
  border: 1px solid #BCC7E8;
  border-radius: var(--wk-r-sm);
  background: #F1F4FB;
}
.wk-prof-card__signal strong {
  color: var(--wk-ink);
  font-size: 12.5px;
  line-height: 1.3;
}
.wk-prof-card__signal span {
  color: var(--wk-ink-2);
  font-size: 12px;
  line-height: 1.4;
}
.wk-prof-card__empty { display: grid; gap: 10px; align-items: start; }
.wk-prof-card__actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

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

.wk-prof-exp {
  display: grid;
  gap: 0;
  margin-top: 8px;
}
.wk-prof-exp__item {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 12px;
  padding: 10px 0;
}
.wk-prof-exp__item + .wk-prof-exp__item {
  border-top: 1px solid var(--wk-border);
}
.wk-prof-exp__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--wk-ink);
  margin-top: 7px;
}
.wk-prof-exp__body { min-width: 0; }
.wk-prof-exp__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}
.wk-prof-exp__top strong {
  color: var(--wk-ink);
  font-size: 14px;
  line-height: 1.35;
}
.wk-prof-exp__top span {
  color: var(--wk-ink-3);
  font-size: 12px;
  white-space: nowrap;
}
.wk-prof-exp__body p {
  margin: 3px 0 0;
  color: var(--wk-ink-2);
  font-size: 13px;
  line-height: 1.4;
}
.wk-prof-exp__company {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 3px;
  color: var(--wk-ink-2);
  font-size: 13px;
  line-height: 1.4;
}
.wk-prof-exp__company img {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  border-radius: 4px;
  object-fit: cover;
  border: 1px solid var(--wk-border);
  background: var(--wk-cream-2);
}
.wk-prof-exp__desc {
  color: var(--wk-ink-2);
  max-width: 82ch;
}
.wk-prof-exp__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.wk-prof-exp__meta span {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--wk-border);
  background: var(--wk-cream-2);
  color: var(--wk-ink-3);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11.5px;
  line-height: 1.2;
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
  width: 100%;
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
.wk-prof-privacy__badge {
  border: 1px solid var(--wk-border);
  border-radius: 999px;
  padding: 4px 8px;
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--wk-ink-3);
  background: var(--wk-cream-2);
}

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
  .wk-privacy__grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .wk-prof__head { grid-template-columns: 1fr; align-items: start; }
  .wk-prof__h1 { font-size: 28px; }
  .wk-prof__live { display: none; }
  .wk-prof-row { grid-template-columns: 1fr; gap: 4px; }
  .wk-prof-exp__top { display: grid; gap: 3px; }
  .wk-prof-exp__top span { white-space: normal; }
}

/* v3 profile: top strip (completeness + visibility) + match-preference chips */
.wk-prof__topstrip { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 0 0 28px; }
.wk-prof__topstrip > * { margin: 0; }
@media (max-width: 820px) { .wk-prof__topstrip { grid-template-columns: 1fr; } }

.wkv2-card__h .wk-prof-card__src {
  font-family: var(--wk-font-sans, 'Hanken Grotesk', sans-serif);
  font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-3);
}

.wk-prefs { display: grid; gap: 8px; padding-top: 12px; margin-top: 8px; border-top: 1px dashed var(--border); }
.wk-prefs:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.wk-prefs__head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.wk-prefs__label { font-weight: 600; font-size: 13px; color: var(--ink); letter-spacing: -0.005em; }
.wk-prefs__hint { font-size: 11.5px; color: var(--ink-3); font-style: italic; }
.wk-prefs__chips { display: flex; flex-wrap: wrap; gap: 5px; }
.wk-pref {
  appearance: none; border: 1px solid var(--border); background: var(--cream); color: var(--ink-2);
  border-radius: var(--r-pill); padding: 4px 10px 4px 6px; font: inherit; font-size: 12px; font-weight: 500;
  cursor: pointer; display: inline-flex; align-items: center; gap: 6px; letter-spacing: -0.005em;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.wk-pref:hover { border-color: var(--ink-3); color: var(--ink); }
.wk-pref.is-on { background: var(--ink); color: var(--cream); border-color: var(--ink); font-weight: 600; }
.wk-pref__check {
  width: 14px; height: 14px; border-radius: 50%; background: var(--cream-2); border: 1px solid var(--border-strong);
  display: inline-flex; align-items: center; justify-content: center; color: transparent; flex: none;
}
.wk-pref.is-on .wk-pref__check { background: var(--cream); border-color: var(--cream); color: var(--ink); }
.wk-prefs__chips--warn .wk-pref.is-on { background: var(--danger); border-color: var(--danger); color: var(--cream); }
.wk-prefs__chips--warn .wk-pref.is-on .wk-pref__check { color: var(--danger); }
.wk-prefs__save {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding-top: 14px; margin-top: 10px; border-top: 1px dashed var(--border);
}
`


// ────────────────────────────────────────────────────────────────────────────
// /me/matches — the roles inbox (full list; Home shows a digest)
// ────────────────────────────────────────────────────────────────────────────

export function CandidateMatches() {
  const gate = useCandidatePortalGate()
  const profileState = useClaimedProfile()

  if (gate.status !== "ready") return <PortalGatePending gate={gate} kicker="Your roles" />
  if (profileState.status === "signed_out") return <SignInRequired kicker="Your roles" />
  if (profileState.status === "loading") return <PortalLoading kicker="Your roles" />
  if (profileState.status === "error") return <PortalError kicker="Your roles" message={profileState.message} />
  return <MatchesSurface profileState={profileState} />
}

type MatchesFilter = "all" | "action" | "review" | "outcome" | "collab" | "rec"
const MATCHES_FILTERS: Array<{ id: MatchesFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "action", label: "Needs action" },
  { id: "review", label: "In review" },
  { id: "outcome", label: "Outcomes" },
  { id: "collab", label: "WeKruit-screened" },
  { id: "rec", label: "Recommended" },
]

function matchNeedsCandidateAction(match: CandidateMatchCard): boolean {
  return (
    match.status === "recommended" ||
    match.status === "invited" ||
    match.status === "interview_started"
  )
}

function matchHasCandidateOutcome(match: CandidateMatchCard): boolean {
  return (
    match.status === "passed" ||
    match.status === "intro_accepted" ||
    match.status === "intro_rejected" ||
    match.status === "not_passed" ||
    match.status === "paused"
  )
}

function matchesForFilter(matches: CandidateMatchCard[], filter: MatchesFilter): CandidateMatchCard[] {
  switch (filter) {
    case "action":
      return matches.filter(matchNeedsCandidateAction)
    case "review":
      return matches.filter((m) => m.status === "review_pending")
    case "outcome":
      return matches.filter(matchHasCandidateOutcome)
    case "collab":
      return matches.filter((m) => m.collab)
    case "rec":
      return matches.filter((m) => !m.collab)
    case "all":
      return matches
  }
}

function MatchesSurface({
  profileState,
}: {
  profileState: Extract<ClaimState, { status: "ready" }>
}) {
  const matchesState = useCandidateMatches(true)
  // Backend curates the set: WeKruit-collab jobs (pre-screenable) + daily-recommend
  // recs, deduped. Show all; the filter splits collab vs recommended.
  const all = matchesState.status === "ready" ? matchesState.matches : []
  const claireHref = buildClaireImessageHref(profileState.profile.senderNumber)
  return (
    <MatchesView
      profile={profileState.profile}
      all={all}
      claireHref={claireHref}
      loading={matchesState.status === "loading" || matchesState.status === "idle"}
      errored={matchesState.status === "error"}
      error={matchesState.status === "error" ? matchesState.message : null}
    />
  )
}

function MatchesView({
  profile,
  all,
  claireHref,
  loading,
  errored,
  error,
}: {
  profile: CandidateSelfProfile
  all: CandidateMatchCard[]
  claireHref: string | null
  loading: boolean
  errored: boolean
  error: string | null
}) {
  const [filter, setFilter] = useState<MatchesFilter>("all")
  const counts = MATCHES_FILTERS.reduce(
    (acc, f) => {
      acc[f.id] = matchesForFilter(all, f.id).length
      return acc
    },
    {} as Record<MatchesFilter, number>,
  )
  const filtered = matchesForFilter(all, filter)

  return (
    <CandidateShell
      signedIn
      signedInUser={{ name: profile.displayName ?? "You", email: profile.emailMasked }}
      claireHref={claireHref}
    >
      <style>{ME_V3_STYLES}</style>
      <style>{MATCHES_STYLES}</style>
      <div className="wkmp">
        <div className="wk-container wkmp__inner">
          <header className="wkmp__head">
            <div>
              <p className="wkmp__eye">
                <PulseDot size={6} /> Roles · {all.length} total
              </p>
              <h1 className="wkmp__h1">
                <em>Roles</em> WeKruit is tracking for you.
              </h1>
              <p className="wkmp__sub">
                Claire separates WeKruit-screened roles from external recommendations, shows why each role is here,
                and keeps future matching tied to evidence you can review.
              </p>
            </div>
            <div className="wkmp__action">
              <Link to="/me/profile#match-preferences" className="wk-btn wk-btn--primary wk-btn--sm">
                Adjust matching <Icon name="arrow-right" size={12} stroke={1.9} />
              </Link>
            </div>
          </header>

          <div className="wkmp-filters" role="tablist" aria-label="Filter roles">
            {MATCHES_FILTERS.map((f) => {
              const disabled = counts[f.id] === 0 && filter !== f.id
              return (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  aria-disabled={disabled}
                  disabled={disabled}
                  className={`wkmp-chip${filter === f.id ? " is-on" : ""}${disabled ? " is-disabled" : ""}`}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                  <span className="wkmp-chip__n">{counts[f.id]}</span>
                </button>
              )
            })}
          </div>

          <div className="wkmp-grid">
            <div className="wkmp-main">
              {loading ? (
                <div className="wkmp-empty">
                  <h3>Loading…</h3>
                  <p>Pulling your roles and recommendations.</p>
                </div>
              ) : errored ? (
                <div className="wkmp-empty">
                  <h3>Couldn&apos;t load roles.</h3>
                  <p>{error ?? "Refresh in a moment."}</p>
                </div>
              ) : filtered.length > 0 ? (
                <div className="wkmp-list">
                  {filtered.map((m) => (
                    <MeMatchFull key={m.matchId} match={m} claireHref={claireHref} />
                  ))}
                </div>
              ) : (
                <MatchesEmptyState allCount={all.length} claireHref={claireHref} onShowAll={() => setFilter("all")} />
              )}
            </div>

            <aside className="wkmp-side">
              <div className="wkmp-side__card">
                <div className="wkmp-side__claire-id">
                  <Avatar name="Claire WeKruit" size={36} tone="moss" />
                  <div>
                    <strong className="wkmp-side__claire-name">Claire</strong>
                    <span className="wkmp-side__claire-meta">iMessage line</span>
                  </div>
                </div>
                <p className="wkmp-side__sub">
                  For WeKruit-screened roles, Claire handles the screening questions with you.
                </p>
                {claireHref ? (
                  <a href={claireHref} className="wk-btn wk-btn--primary wk-btn--block wk-btn--sm">
                    Continue with Claire <Icon name="arrow-right" size={13} stroke={2} />
                  </a>
                ) : (
                  <Link to="/me/profile#profile-corrections" className="wk-btn wk-btn--secondary wk-btn--block wk-btn--sm">
                    Update profile <Icon name="arrow-right" size={13} stroke={2} />
                  </Link>
                )}
              </div>

              <MeClaireSignalsCard profile={profile} />
            </aside>
          </div>
        </div>
      </div>
    </CandidateShell>
  )
}

function MatchesEmptyState({
  allCount,
  claireHref,
  onShowAll,
}: {
  allCount: number
  claireHref: string | null
  onShowAll: () => void
}) {
  const hasOtherRoles = allCount > 0
  return (
    <div className="wkmp-empty wkmp-empty--actionable">
      <h3>{hasOtherRoles ? "No roles in this view yet." : "No roles match your profile yet."}</h3>
      <p>
        {hasOtherRoles
          ? "This filter is empty. Show all tracked roles or update preferences if this split looks wrong."
          : "Keep target roles, locations, and deal-breakers current so roles can surface with clearer evidence."}
      </p>
      <div className="wkmp-empty__actions">
        {hasOtherRoles ? (
          <button type="button" className="wk-btn wk-btn--secondary wk-btn--sm" onClick={onShowAll}>
            Show all roles
          </button>
        ) : null}
        <Link to="/me/profile#match-preferences" className="wk-btn wk-btn--primary wk-btn--sm">
          Update matching profile <Icon name="arrow-right" size={13} stroke={2} />
        </Link>
        {claireHref ? (
          <a href={claireHref} className="wk-btn wk-btn--secondary wk-btn--sm">
            Message Claire <Icon name="message" size={12} stroke={1.9} />
          </a>
        ) : null}
      </div>
    </div>
  )
}

function MeMatchFull({ match, claireHref }: { match: CandidateMatchCard; claireHref: string | null }) {
  const isCollab = !!match.collab
  const logo = (match.job.company[0] ?? "?").toUpperCase()
  const logoBg = LOGO_BG_POOL[djb2(match.jobId || match.job.company) % LOGO_BG_POOL.length]
  const reasons = match.whyMatched ?? []
  const reasonsLabel = isCollab ? "Why this is in your pipeline" : "Why Claire matched you"
  const statusDisplay = getCandidateJobStatusDisplay(match.status, match.job.title)
  // Collab jobs let the candidate view their pre-screen / job status.
  const showStatus = isCollab && match.status !== "recommended"
  const activeClaireHref = match.status === "interview_started" ? claireHref : null
  const profileSignalHref = profileSignalHrefForMatch(match)
  const recommendedSignalHref = match.status === "recommended" ? profileSignalHrefForRecommendedMatch(match) : null
  return (
    <article className={`wkv3-match${isCollab ? " is-invite" : ""}`}>
      <header className="wkv3-match__head">
        <CompanyMark logo={logo} bg={logoBg} size={52} />
        <div className="wkv3-match__head-body">
          <div className="wkv3-match__chiprow">
            {isCollab ? (
              <span className="wkv3-match__chip is-warm">
                <PulseDot size={5} /> WeKruit-screened
              </span>
            ) : (
              <span className="wkv3-match__chip">New role</span>
            )}
            {showStatus ? <span className="wkv3-match__chip">{statusDisplay.label}</span> : null}
          </div>
          <h3 className="wkv3-match__t">{match.job.title}</h3>
          <p className="wkv3-match__co">
            <b>{match.job.company}</b>
            {match.job.location ? ` · ${match.job.location}` : ""}
          </p>
        </div>
        <div className="wkv3-match__salary">{match.job.salaryRange ?? "By interview"}</div>
      </header>

      {reasons.length > 0 ? (
        <div className="wkv3-match__ev">
          <span className="wkv3-match__ev-eye">{reasonsLabel}</span>
          <ul>
            {reasons.slice(0, 4).map((r, i) => (
              <li key={i}>
                <blockquote>{r}</blockquote>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer className="wkv3-match__foot">
        <div className="wkv3-match__feedback">
          <Link to={recommendedSignalHref ?? "/me/profile#match-preferences"} className="wkv3-match__prefs">
            {recommendedSignalHref ? "Use as profile signal" : "Update matching preferences"}
          </Link>
        </div>
        <div className="wkv3-match__primaries">
          {isCollab ? (
            activeClaireHref ? (
              <>
                <Link to={match.job.href} className="wk-btn wk-btn--secondary wk-btn--sm">
                  View role <Icon name="arrow-right" size={13} stroke={2} />
                </Link>
                <a href={activeClaireHref} className="wk-btn wk-btn--primary wk-btn--sm">
                  <Icon name="message" size={12} stroke={1.9} /> Continue with Claire
                </a>
              </>
            ) : profileSignalHref ? (
              <>
                <Link to={match.job.href} className="wk-btn wk-btn--secondary wk-btn--sm">
                  View role <Icon name="arrow-right" size={13} stroke={2} />
                </Link>
                <Link to={profileSignalHref} className="wk-btn wk-btn--primary wk-btn--sm">
                  Update profile signal <Icon name="arrow-right" size={13} stroke={2} />
                </Link>
              </>
            ) : (
              <>
                {claireHref ? (
                  <a href={claireHref} className="wk-btn wk-btn--secondary wk-btn--sm">
                    <Icon name="message" size={12} stroke={1.9} /> Message Claire
                  </a>
                ) : null}
                <Link to={match.job.href} className="wk-btn wk-btn--primary wk-btn--sm">
                  {statusDisplay.ctaLabel} <Icon name="arrow-right" size={13} stroke={2} />
                </Link>
              </>
            )
          ) : match.job.applyUrl ? (
            <a
              href={match.job.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="wk-btn wk-btn--primary wk-btn--sm"
            >
              View source <Icon name="arrow-right" size={13} stroke={2} />
            </a>
          ) : (
            <Link to={match.job.href} className="wk-btn wk-btn--primary wk-btn--sm">
              View source <Icon name="arrow-right" size={13} stroke={2} />
            </Link>
          )}
        </div>
      </footer>
    </article>
  )
}

const MATCHES_STYLES = `
.wkmp {
  --cream: var(--wk-cream); --cream-2: var(--wk-cream-2); --cream-3: var(--wk-cream-3);
  --ink: var(--wk-ink); --ink-2: var(--wk-ink-2); --ink-3: var(--wk-ink-3); --ink-4: var(--wk-ink-4);
  --border: var(--wk-border); --border-strong: var(--wk-border-strong);
  --peach-50: var(--wk-peach-50); --peach-100: var(--wk-peach-100); --peach-200: var(--wk-peach-200);
  --live: var(--wk-live); --live-soft: var(--wk-live-soft); --live-border: var(--wk-live-border); --live-pulse: var(--wk-live-pulse);
  --r-sm: var(--wk-r-sm); --r-md: var(--wk-r-md); --r-pill: var(--wk-r-pill);
  --ease: var(--wk-ease); --dur-fast: 200ms;
  --candidate-card: var(--wk-cream-3);
  --font-serif: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  --font-sans: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--cream); min-height: 100vh; padding-bottom: 80px;
}
.wkmp__inner { padding-top: 0; }

/* Header */
.wkmp__head {
  padding: 28px 0 22px; border-bottom: 1px solid var(--border); margin-bottom: 24px;
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 28px; align-items: end;
}
.wkmp__head > div { min-width: 0; }
.wkmp__eye {
  display: inline-flex; align-items: center; gap: 8px;
  font-family: var(--font-sans); font-size: 11.5px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 12px;
}
.wkmp__h1 {
  font-family: var(--font-serif); font-weight: 400; font-size: clamp(28px, 3.4vw, 40px);
  line-height: 1.06; letter-spacing: -0.022em; color: var(--ink); margin: 0; text-wrap: balance;
}
.wkmp__h1 em { font-style: italic; color: var(--live); font-weight: 400; }
.wkmp__sub { font-size: 14.5px; color: var(--ink-2); line-height: 1.5; max-width: 580px; margin: 10px 0 0; }
.wkmp__action { display: grid; justify-items: end; align-self: end; }
.wkmp__action .wk-btn { white-space: nowrap; }

/* Filter chips */
.wkmp-filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 24px; }
.wkmp-chip {
  appearance: none; background: var(--cream-3); border: 1px solid var(--border); color: var(--ink-2);
  border-radius: var(--r-pill); padding: 6px 14px; font: inherit; font-size: 13px; font-weight: 600;
  cursor: pointer; display: inline-flex; align-items: center; gap: 8px;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.wkmp-chip:hover { border-color: var(--ink); color: var(--ink); }
.wkmp-chip.is-on { background: var(--ink); color: var(--cream); border-color: var(--ink); }
.wkmp-chip:disabled,
.wkmp-chip.is-disabled {
  cursor: default; opacity: .52; border-color: var(--border); color: var(--ink-3);
}
.wkmp-chip:disabled:hover,
.wkmp-chip.is-disabled:hover { border-color: var(--border); color: var(--ink-3); }
.wkmp-chip__n {
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: var(--r-pill);
  background: var(--cream); color: var(--ink-3); font-variant-numeric: tabular-nums; min-width: 18px;
}
.wkmp-chip.is-on .wkmp-chip__n { background: rgba(245,237,227,.15); color: var(--cream); }

/* Body grid */
.wkmp-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 28px; align-items: start; }
.wkmp-main { display: grid; gap: 14px; min-width: 0; }
.wkmp-side { display: grid; gap: 14px; position: sticky; top: 24px; }
.wkmp-list { display: grid; gap: 12px; }
.wkmp-empty {
  padding: 36px 28px; background: var(--cream-3); border: 1px dashed var(--border-strong);
  border-radius: var(--r-md); text-align: center;
}
.wkmp-empty h3 { margin: 0 0 6px; font-family: var(--font-serif); font-weight: 400; font-size: 22px; color: var(--ink); letter-spacing: -0.02em; }
.wkmp-empty p { margin: 0 auto; color: var(--ink-2); font-size: 13.5px; max-width: 460px; line-height: 1.5; }
.wkmp-empty__actions {
  margin-top: 18px; display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap;
}

/* Side rail */
.wkmp-side__card { background: var(--candidate-card); border: 1px solid var(--border); border-radius: var(--r-md); padding: 16px; display: grid; gap: 10px; }
.wkmp-side__h { margin: 0; font-family: var(--font-sans); font-weight: 600; font-size: 13px; color: var(--ink); }
.wkmp-side__sub { margin: 0; font-size: 12.5px; color: var(--ink-3); line-height: 1.4; }
.wkmp-side__claire-id { display: flex; align-items: center; gap: 10px; }
.wkmp-side__claire-name { display: block; font-family: var(--font-sans); font-weight: 600; font-size: 14px; color: var(--ink); line-height: 1.2; }
.wkmp-side__claire-meta { display: inline-flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 11.5px; color: var(--ink-3); }

/* Match card (full) */
.wkv3-match {
  background: var(--candidate-card); border: 1px solid var(--border); border-radius: var(--r-md);
  padding: 20px 22px; display: grid; gap: 14px; transition: border-color var(--dur-fast) var(--ease);
  position: relative; overflow: hidden;
}
.wkv3-match:hover { border-color: var(--live-border); }
.wkv3-match.is-invite { background: linear-gradient(180deg, var(--peach-50) 0%, var(--candidate-card) 14%); border-color: var(--peach-200); }
.wkv3-match__head { display: grid; grid-template-columns: auto 1fr auto; gap: 14px; align-items: start; }
.wkv3-match__head-body { min-width: 0; }
.wkv3-match__chiprow { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
.wkv3-match__chip {
  display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 700;
  letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 8px; border-radius: var(--r-pill);
  background: var(--cream-2); border: 1px solid var(--border); color: var(--ink-3); white-space: nowrap;
}
.wkv3-match__chip.is-warm { background: var(--live-soft); border-color: var(--live-border); color: var(--live); }
.wkv3-match__t { margin: 2px 0 4px; font-family: var(--font-sans); font-weight: 600; font-size: 17px; letter-spacing: -0.01em; line-height: 1.3; color: var(--ink); }
.wkv3-match__co { margin: 0; font-size: 13px; color: var(--ink-3); line-height: 1.4; }
.wkv3-match__co b { color: var(--ink-2); font-weight: 600; }
.wkv3-match__salary {
  font-family: var(--font-serif); font-weight: 400; font-size: 19px; letter-spacing: -0.018em;
  color: var(--ink); line-height: 1.15; text-align: right; white-space: nowrap;
}
.wkv3-match__ev { display: grid; gap: 6px; }
.wkv3-match__ev-eye { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
.wkv3-match__ev ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.wkv3-match__ev li {
  padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--cream);
}
.wkv3-match__ev blockquote {
  margin: 0; font-size: 12.5px; color: var(--ink-2); line-height: 1.4; font-style: italic;
  position: relative; padding-left: 12px;
}
.wkv3-match__ev blockquote::before {
  content: '"'; position: absolute; left: 0; top: -2px; color: var(--live);
  font-family: var(--font-serif); font-size: 18px; font-style: normal; line-height: 1;
}
.wkv3-match__foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding-top: 12px; border-top: 1px dashed var(--border);
}
.wkv3-match__feedback { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.wkv3-match__prefs {
  font-size: 11.5px; font-weight: 600; color: var(--ink-3); text-decoration: none;
  border-bottom: 1px dashed var(--border-strong); padding-bottom: 1px; margin-left: 4px;
}
.wkv3-match__prefs:hover { color: var(--ink); border-color: var(--ink); }
.wkv3-match__primaries { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }

/* Responsive */
@media (max-width: 1180px) {
  .wkmp-grid { grid-template-columns: 1fr; }
  .wkmp-side { position: static; grid-template-columns: 1fr 1fr; gap: 14px; }
}
@media (max-width: 700px) {
  .wkmp__head { grid-template-columns: 1fr; gap: 16px; align-items: stretch; }
  .wkmp__action { justify-items: stretch; }
  .wkmp__action .wk-btn { justify-content: center; }
  .wkmp-side { grid-template-columns: 1fr; }
  .wkv3-match__head { grid-template-columns: auto 1fr; }
  .wkv3-match__salary { grid-column: 1 / -1; text-align: left; padding-top: 4px; border-top: 1px dashed var(--border); }
  .wkv3-match__foot { flex-direction: column; align-items: stretch; }
  .wkv3-match__primaries { justify-content: stretch; }
  .wkv3-match__primaries .wk-btn { flex: 1; justify-content: center; }
}
`
