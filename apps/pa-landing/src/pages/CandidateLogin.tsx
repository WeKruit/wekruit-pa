/**
 * CandidateLogin.tsx — production file.
 *
 * Exports:
 *  - default CandidateLogin (the /login page)
 *  - CandidateShell (header + footer + page chrome, used by every candidate route)
 *  - Shared atoms: PulseDot, LiveStatusPill, Avatar, CompanyMark, HiringManagerCard,
 *    IMessageThread, WekruitLogo, Icon — inlined here so Landing.tsx and PublicJob.tsx
 *    can import them without us adding a component library.
 *
 * Visual system: WeKruit warm-editorial (cream + espresso + peach halo) with
 * a warm terracotta confidence accent for live / match / interview signals.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type CSSProperties } from "react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import {
  GoogleAuthProvider,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithCustomToken,
  signInWithEmailLink,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth"
import { auth } from "../lib/firebase.js"
import { clearSsoCookie } from "../lib/cross-domain-sso.js"
import { redirectResultPromise, ssoBootstrapPromise } from "../lib/auth-redirect-bootstrap.js"
import {
  CLAIM_EMAIL_KEY,
  clearRememberedLoginNext,
  isLayoffHost,
  isProfileRoleSignalPath,
  isPublicJobPath,
  onboardingDestination,
  onboardingDestinationWithReturnPath,
  parseLoginNextPath,
  readRememberedLoginNext,
  readStoredValue,
  rememberLoginNext,
  rememberOnboardingIntentForPath,
  rememberStoredValue,
  resolvePostLoginDestination,
} from "../lib/browser-identity"
import { peekSource, stickSourceFromLoginNext, type SignupSource } from "../lib/source.js"
import { verifyCandidateMagicLinkSession } from "../lib/candidate-verify.js"
import {
  startCandidatePhoneLink,
  verifyCandidatePhoneLink,
} from "../lib/candidate-phone-link.js"
import { LayoffLoginCard } from "../components/LayoffLoginCard.js"
import { AudienceToggle } from "../components/AudienceToggle.js"

const EMAIL_STORAGE_KEY = CLAIM_EMAIL_KEY
const OAUTH_PENDING_KEY = "pa_oauth_pending"
const PHONE_LINK_INTENT_KEY = "pa_phone_link_intent"
const LINKEDIN_AUTH_START_URL =
  import.meta.env.VITE_LINKEDIN_AUTH_START_URL ??
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paLinkedinAuthStart"

function cleanEmail(value: string): string {
  return value.trim().toLowerCase()
}

function createGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: "select_account" })
  return provider
}

function formatAuthError(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : ""
  switch (code) {
    case "auth/unauthorized-domain":
      return "This site isn't authorized for Google sign-in yet. Confirm this domain is listed under Firebase → Authentication → Authorized domains, wait a few minutes, then try again."
    case "auth/popup-closed-by-user":
      return "Google sign-in was cancelled. Try again when you're ready."
    case "auth/popup-blocked":
      return "Your browser blocked the Google sign-in popup. Allow popups for this site and try again."
    case "auth/cancelled-popup-request":
      return "Sign-in was interrupted. Try again."
    default:
      if (err instanceof Error && err.message) return err.message
      return code ? code.replace(/^auth\//, "").replace(/-/g, " ") : "Sign-in failed. Try again."
  }
}

function readPhoneLinkIntent(): boolean {
  try {
    return window.sessionStorage.getItem(PHONE_LINK_INTENT_KEY) === "1"
  } catch {
    return false
  }
}

function rememberPhoneLinkIntent(): void {
  try {
    window.sessionStorage.setItem(PHONE_LINK_INTENT_KEY, "1")
  } catch {
    // ignore private mode
  }
}

function clearPhoneLinkIntent(): void {
  try {
    window.sessionStorage.removeItem(PHONE_LINK_INTENT_KEY)
  } catch {
    // ignore private mode
  }
}

function readPhoneLinkIntentParam(searchParams: URLSearchParams): boolean {
  const value = searchParams.get("phoneLink")
  return value === "1" || value === "true"
}

function waitForAuthUser(timeoutMs = 5000): Promise<User | null> {
  if (auth().currentUser) return Promise.resolve(auth().currentUser)
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      unsub()
      resolve(auth().currentUser)
    }, timeoutMs)
    const unsub = onAuthStateChanged(auth(), (user) => {
      if (user) {
        window.clearTimeout(timer)
        unsub()
        resolve(user)
      }
    })
  })
}

function takeLinkedinAuthPayload(): { ok: true; customToken: string } | { ok: false; error: string } | null {
  const prefix = "pa_linkedin_auth:"
  if (!window.name.startsWith(prefix)) return null
  const raw = window.name.slice(prefix.length)
  window.name = ""
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>
    if (payload.ok === true && typeof payload.customToken === "string") {
      return { ok: true, customToken: payload.customToken }
    }
    return {
      ok: false,
      error: typeof payload.error === "string" ? payload.error : "linkedin_auth_failed",
    }
  } catch {
    return { ok: false, error: "linkedin_auth_payload_invalid" }
  }
}

type PhoneLinkState =
  | { status: "idle"; message: string | null; requestId?: undefined; phoneMasked?: undefined }
  | { status: "needs_auth"; message: string; requestId?: undefined; phoneMasked?: undefined }
  | { status: "ready"; message: string; requestId?: undefined; phoneMasked?: undefined }
  | { status: "sending_code"; message: string | null; requestId?: undefined; phoneMasked?: undefined }
  | { status: "code_sent"; message: string; requestId: string; phoneMasked: string }
  | { status: "verifying"; message: string; requestId: string; phoneMasked: string }
  | { status: "linked"; message: string; requestId?: string; phoneMasked?: string }
  | { status: "error"; message: string; requestId?: string; phoneMasked?: string }

// ────────────────────────────────────────────────────────────────────────────
// Shared atoms (exported)
// ────────────────────────────────────────────────────────────────────────────

export function WekruitLogo({ size = 22 }: { size?: number }) {
  return (
    <span className="wk-logo" style={{ fontSize: size }}>
      We<em>kruit</em>
    </span>
  )
}

export function PulseDot({
  size = 8,
  color = "var(--wk-live-pulse)",
  label,
}: { size?: number; color?: string; label?: string }) {
  return (
    <span className="wk-pulsedot" role={label ? "img" : undefined} aria-label={label}
          style={{ "--wk-pulse-size": `${size}px`, "--wk-pulse-color": color } as CSSProperties}>
      <span className="wk-pulsedot__ring" />
      <span className="wk-pulsedot__core" />
    </span>
  )
}

export function LiveStatusPill({ children, dotColor }: { children: ReactNode; dotColor?: string }) {
  return (
    <span className="wk-live-pill">
      <PulseDot size={7} color={dotColor} />
      <span>{children}</span>
    </span>
  )
}

export function Avatar({
  name = "", src, size = 44, tone = "warm",
}: { name?: string; src?: string; size?: number; tone?: "warm" | "moss" | "slate" }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0]?.toUpperCase()).join("")
  const tones: Record<string, string> = {
    warm:  "linear-gradient(135deg, #F0BFA0 0%, #E8A988 60%, #C77F58 100%)",
    moss:  "linear-gradient(135deg, #B7C7A0 0%, #4F6B3C 100%)",
    slate: "linear-gradient(135deg, #B5A595 0%, #5A4636 100%)",
  }
  return (
    <span
      className="wk-avatar"
      aria-hidden={!name}
      style={{ width: size, height: size, fontSize: size * 0.36, background: tones[tone] }}
    >
      {src ? <img src={src} alt="" /> : initials}
    </span>
  )
}

export function CompanyMark({ logo, bg, size = 44 }: { logo: string; bg: string; size?: number }) {
  return (
    <span
      className="wk-cmp-mark"
      style={{ width: size, height: size, background: bg, fontSize: size * 0.5 }}
      aria-hidden="true"
    >
      {logo}
    </span>
  )
}

export function HiringManagerCard({
  name, title, company, online = true, tone = "warm",
}: {
  name: string; title: string; company?: string; online?: boolean
  tone?: "warm" | "moss" | "slate"
}) {
  return (
    <div className="wk-hm-card">
      <Avatar name={name} size={56} tone={tone} />
      <div className="wk-hm-card__body">
        <div className="wk-hm-card__name">{name}</div>
        <div className="wk-hm-card__meta">
          {title}{company ? ` · ${company}` : ""}
        </div>
      </div>
      {online ? <LiveStatusPill>Online now</LiveStatusPill> : null}
    </div>
  )
}

// ── iMessage ──────────────────────────────────────────────────────────────
type IMsg = { from: "user" | "claire"; text: string }

export function IMessageThread({
  messages, header = "Claire", phoneFrame = false, loop = true,
}: { messages: IMsg[]; header?: string; phoneFrame?: boolean; loop?: boolean }) {
  const [shown, setShown] = useState(0)
  const [typing, setTyping] = useState(false)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    if (!loop) { setShown(messages.length); return }
    const timers: number[] = []
    const at = (fn: () => void, ms: number) => {
      const id = window.setTimeout(fn, ms)
      timers.push(id)
      return id
    }

    function play(i: number) {
      if (i >= messages.length) {
        // hold the completed thread, then fade out, snap-reset, and replay
        at(() => {
          setFading(true)
          at(() => {
            setShown(0); setTyping(false)
            at(() => {
              setFading(false)
              at(() => play(0), 250)
            }, 80)
          }, 620)
        }, 2400)
        return
      }
      const msg = messages[i]
      if (msg.from === "claire") {
        setTyping(true)
        at(() => {
          setTyping(false); setShown(i + 1)
          at(() => play(i + 1), 750)
        }, 900)
      } else {
        setShown(i + 1)
        at(() => play(i + 1), 850)
      }
    }
    at(() => play(0), 500)
    return () => { timers.forEach((id) => window.clearTimeout(id)) }
  }, [loop, messages])

  const visible = messages.slice(0, shown)

  const inner = (
    <div className={`wk-imsg-thread${fading ? " wk-imsg-thread--fading" : ""}`}>
      <div className="wk-imsg-stamp"><strong>iMessage</strong> · Today 9:24 AM</div>
      <div className="wk-imsg-sender">{header}</div>
      <div className="wk-imsg-thread__body">
        {visible.map((m, i) => {
          const next = visible[i + 1]
          const tail =
            (!next || next.from !== m.from) &&
            !(typing && m.from === "claire" && i === visible.length - 1)
          return (
            <div
              key={`${shown}-${i}`}
              className={`wk-imsg-row wk-imsg-row--${m.from}`}
            >
              <div className={`wk-imsg-bubble wk-imsg-bubble--${m.from}${tail ? " has-tail" : ""}`}>
                {m.text}
              </div>
            </div>
          )
        })}
        {typing ? (
          <div className="wk-imsg-row wk-imsg-row--claire">
            <div className="wk-imsg-bubble wk-imsg-bubble--claire has-tail wk-imsg-typing">
              <span /><span /><span />
            </div>
          </div>
        ) : null}
      </div>
      <div className="wk-imsg-stamp wk-imsg-stamp--right">
        {shown === messages.length && !fading ? "Delivered" : "\u00A0"}
      </div>
    </div>
  )

  if (!phoneFrame) return inner
  return (
    <div className="wk-imsg-phone">
      <div className="wk-imsg-phone__notch" />
      <div className="wk-imsg-phone__topbar">
        <span className="wk-imsg-phone__time">9:24</span>
        <span className="wk-imsg-phone__icons">
          <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden="true">
            <path d="M1 6l2 2 4-4 6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <svg width="16" height="10" viewBox="0 0 16 10" fill="none" aria-hidden="true">
            <rect x="1" y="2" width="11" height="6" rx="1.5" stroke="currentColor" strokeWidth="1" fill="none"/>
            <rect x="2.5" y="3.5" width="8" height="3" rx=".4" fill="currentColor"/>
            <rect x="13" y="4" width="1.5" height="2" rx=".4" fill="currentColor"/>
          </svg>
        </span>
      </div>
      <div className="wk-imsg-phone__header">
        <Avatar name="Claire" size={36} tone="warm" />
        <div>
          <div className="wk-imsg-phone__name">{header}</div>
          <div className="wk-imsg-phone__sub">WeKruit recruiter</div>
        </div>
      </div>
      {inner}
    </div>
  )
}

// ── Icon (small inline stroke set) ────────────────────────────────────────
type IconName =
  | "arrow-right" | "arrow-left" | "arrow-down"
  | "check" | "calendar" | "clock" | "message" | "video"
  | "upload" | "lock" | "bolt" | "pin" | "sparkle"
  | "mail" | "link" | "shield"

export function Icon({ name, size = 18, stroke = 1.6 }: { name: IconName; size?: number; stroke?: number }) {
  const props = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: stroke,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
    style: { display: "inline-block", verticalAlign: "middle", flex: "none" } as CSSProperties,
  }
  switch (name) {
    case "arrow-right": return (<svg {...props}><path d="M5 12h14M13 6l6 6-6 6"/></svg>)
    case "arrow-left":  return (<svg {...props}><path d="M19 12H5M11 18l-6-6 6-6"/></svg>)
    case "arrow-down":  return (<svg {...props}><path d="M12 5v14M6 13l6 6 6-6"/></svg>)
    case "check":       return (<svg {...props}><path d="M5 12l5 5L20 7"/></svg>)
    case "calendar":    return (<svg {...props}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>)
    case "clock":       return (<svg {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>)
    case "message":     return (<svg {...props}><path d="M21 12c0 4.4-4 8-9 8-1.4 0-2.7-.3-3.8-.7L3 21l1.5-4.2C3.6 15.5 3 13.8 3 12c0-4.4 4-8 9-8s9 3.6 9 8z"/></svg>)
    case "video":       return (<svg {...props}><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>)
    case "upload":      return (<svg {...props}><path d="M12 3v14M6 9l6-6 6 6M5 21h14"/></svg>)
    case "lock":        return (<svg {...props}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>)
    case "bolt":        return (<svg {...props}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>)
    case "pin":         return (<svg {...props}><path d="M12 22s7-7.5 7-13a7 7 0 1 0-14 0c0 5.5 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/></svg>)
    case "sparkle":     return (<svg {...props}><path d="M12 3v6M12 15v6M3 12h6M15 12h6M6 6l4 4M14 14l4 4M6 18l4-4M14 10l4-4"/></svg>)
    case "mail":        return (<svg {...props}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>)
    case "link":        return (<svg {...props}><path d="M10 13a5 5 0 0 0 7 0l4-4a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-4 4a5 5 0 0 0 7 7l2-2"/></svg>)
    case "shield":      return (<svg {...props}><path d="M12 2l8 3v6c0 5-3.5 9.4-8 11-4.5-1.6-8-6-8-11V5l8-3z"/></svg>)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CandidateShell — header + footer + page chrome
// ────────────────────────────────────────────────────────────────────────────

export function CandidateShell({
  children,
  hero = false,
  signedIn = false,
  signedInUser,
  claireHref = null,
  startHref = "/onboarding",
  startLabel = "Start with Claire",
}: {
  children: ReactNode
  hero?: boolean
  signedIn?: boolean
  signedInUser?: { name?: string; src?: string; email?: string }
  claireHref?: string | null
  startHref?: string
  startLabel?: string
}) {
  // Hooks must run unconditionally — used only by the signed-in rail branch.
  const navigate = useNavigate()
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Marketing header is auth-aware: once a session resolves, drop the
  // "Sign in" link and swap the CTA for a single "My WeKruit" entry. Stays
  // "unknown" until onAuthStateChanged fires so signed-in users don't flash
  // the signed-out chrome on first paint where a session already exists.
  const [authState, setAuthState] = useState<User | null | "unknown">("unknown")
  useEffect(() => {
    let unsub = () => {}
    try {
      unsub = onAuthStateChanged(auth(), (u) => setAuthState(u))
    } catch {
      setAuthState(null)
    }
    return () => unsub()
  }, [])
  const isAuthed = authState !== "unknown" && authState !== null

  if (signedIn) {
    // v3 candidate operating-center chrome: a left navigation rail (desktop)
    // that collapses to a slide-in drawer + compact top bar under 900px.
    return (
      <div className={`wk-shell wk-shell--app${drawerOpen ? " is-drawer-open" : ""}`}>
        <style>{CANDIDATE_STYLES}</style>
        <style>{APP_SHELL_STYLES}</style>
        <header className="wk-apptopbar">
          <button
            type="button"
            className="wk-apptopbar__menu"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <Link to="/me" className="wk-apptopbar__brand" aria-label="WeKruit home">
            <WekruitLogo size={18} />
          </Link>
          {claireHref ? (
            <a href={claireHref} className="wk-apptopbar__claire" aria-label="Message Claire">
              <PulseDot size={6} />
            </a>
          ) : (
            <Link to="/me/profile#profile-corrections" className="wk-apptopbar__claire is-pending" aria-label="Update profile">
              <PulseDot size={6} />
            </Link>
          )}
        </header>

        <CandidateAppNav
          user={signedInUser}
          pathname={location.pathname}
          claireHref={claireHref}
          onNavigate={(to) => { navigate(to); setDrawerOpen(false) }}
          onClose={() => setDrawerOpen(false)}
        />
        {drawerOpen ? <div className="wk-sidenav__scrim" onClick={() => setDrawerOpen(false)} /> : null}

        <main className="wk-main">{children}</main>
      </div>
    )
  }
  return (
    <div className={`wk-shell${hero ? " wk-shell--hero" : ""}`}>
      <style>{CANDIDATE_STYLES}</style>
      <style>{LEGACY_CANDIDATE_STYLES}</style>
      <header className="wk-header">
        <div className="wk-header__inner">
          <Link to="/" className="wk-header__brand" aria-label="WeKruit home">
            <WekruitLogo size={22} />
          </Link>
          <AudienceToggle />
          <nav className="wk-nav" aria-label="Candidate navigation">
            <HowItWorksLink />
            <Link to="/refer" className="wk-nav__link">Earn $4k</Link>
            {!isAuthed ? <Link to="/me" className="wk-nav__link">My WeKruit</Link> : null}
          </nav>
          <div className="wk-header__cta">
            {isAuthed ? (
              <Link to="/me" className="wk-btn wk-btn--ink wk-btn--sm">My WeKruit</Link>
            ) : (
              <>
                <Link to="/login" className="wk-header__signin">Sign in</Link>
                <Link to={startHref} className="wk-btn wk-btn--ink wk-btn--sm wk-header__primary" aria-label={startLabel}>
                  <span className="wk-header__primary-full" aria-hidden="true">Start with Claire</span>
                  <span className="wk-header__primary-short" aria-hidden="true">Claire</span>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="wk-main">{children}</main>
      <footer className="wk-footer">
        <div className="wk-footer__inner">
          <div className="wk-footer__brand">
            <WekruitLogo size={20} />
            <span className="wk-footer__tag">The agentic talent marketplace.</span>
          </div>
          <nav className="wk-footer__nav">
            <Link to="/auto-apply">Auto-Apply Beta</Link>
            <Link to="/employers">For employers</Link>
            <Link to="/legal">Privacy</Link>
            <Link to="/legal">Terms</Link>
            <a href="mailto:noahliu@wekruit.com">noahliu@wekruit.com</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}

export function buildClaireImessageHref(senderNumber?: string | null, body = "Hi Claire"): string | null {
  const trimmed = typeof senderNumber === "string" ? senderNumber.trim() : ""
  if (!/^\+\d{8,16}$/.test(trimmed)) return null
  return `sms:${trimmed}?&body=${encodeURIComponent(body)}`
}

type AppNavItem = { to: string; icon: AppNavIconName; label: string; external?: boolean }

function appNavItems(claireHref: string | null): AppNavItem[] {
  return [
  { to: "/me", icon: "pipeline", label: "Home" },
  { to: "/me/matches", icon: "match", label: "Roles" },
  { to: "/market", icon: "market", label: "Market" },
  ...(claireHref ? [{ to: claireHref, icon: "claire" as const, label: "Claire", external: true }] : []),
  { to: "/me/profile", icon: "profile", label: "Profile" },
  { to: "/me/privacy", icon: "privacy", label: "Privacy" },
  { to: "/me/refer", icon: "refer", label: "Refer · $4k" },
  ]
}

type AppNavIconName = "pipeline" | "match" | "claire" | "profile" | "privacy" | "refer" | "market"

// Rail glyphs — kept local so the shared Icon set stays lean.
function AppNavIcon({ name, size = 17 }: { name: AppNavIconName; size?: number }) {
  const p = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.7,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    style: { display: "block", flex: "none" } as CSSProperties,
  }
  switch (name) {
    case "pipeline": return (<svg {...p}><path d="M3 6h18M3 12h18M3 18h18" /><circle cx="6" cy="6" r="2" fill="currentColor" stroke="none" /><circle cx="14" cy="12" r="2" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="2" fill="currentColor" stroke="none" /></svg>)
    case "match": return (<svg {...p}><path d="M12 3v6M12 15v6M3 12h6M15 12h6M6 6l4 4M14 14l4 4M6 18l4-4M14 10l4-4" /></svg>)
    case "claire": return (<svg {...p}><path d="M21 12c0 4.4-4 8-9 8-1.4 0-2.7-.3-3.8-.7L3 21l1.5-4.2C3.6 15.5 3 13.8 3 12c0-4.4 4-8 9-8s9 3.6 9 8z" /></svg>)
    case "profile": return (<svg {...p}><circle cx="12" cy="9" r="4" /><path d="M4 21c0-4 4-7 8-7s8 3 8 7" /></svg>)
    case "privacy": return (<svg {...p}><path d="M12 3l7 3v5c0 4.3-2.8 8-7 10-4.2-2-7-5.7-7-10V6z" /><path d="M9.5 12.5l1.7 1.7 3.4-4" /></svg>)
    case "refer": return (<svg {...p}><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M3 12h18M12 8v13M12 8s-3-5-5-3 0 5 5 3M12 8s3-5 5-3 0 5-5 3" /></svg>)
    case "market": return (<svg {...p}><circle cx="12" cy="12" r="9" /><path d="M16 8l-2 6-6 2 2-6z" /></svg>)
  }
}

function isNavItemActive(pathname: string, to: string, external?: boolean): boolean {
  if (external) return false
  if (to === "/me") return pathname === "/me"
  if (to === "/me/matches") return pathname === "/me/matches" || pathname.startsWith("/me/match")
  if (to === "/market") return pathname === "/market"
  if (to === "/me/privacy") return pathname === "/me/privacy"
  return pathname === to || pathname.startsWith(to + "/")
}

function CandidateAppNav({
  user,
  pathname,
  claireHref,
  onNavigate,
  onClose,
}: {
  user?: { name?: string; src?: string; email?: string }
  pathname: string
  claireHref: string | null
  onNavigate: (to: string) => void
  onClose: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const name = user?.name ?? "You"
  const navItems = appNavItems(claireHref)

  async function handleSignOut() {
    setMenuOpen(false)
    try {
      await clearSsoCookie()
    } catch {
      // Non-fatal — sign out of Firebase regardless.
    }
    await signOut(auth())
  }

  return (
    <aside className="wk-sidenav">
      <div className="wk-sidenav__top">
        <Link
          to="/me"
          className="wk-sidenav__brand"
          onClick={(e) => { e.preventDefault(); onNavigate("/me") }}
          aria-label="WeKruit home"
        >
          <WekruitLogo size={20} />
        </Link>
        <button type="button" className="wk-sidenav__close" onClick={onClose} aria-label="Close menu">
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <nav className="wk-sidenav__nav" aria-label="App navigation">
        {navItems.map((item) => {
          const active = isNavItemActive(pathname, item.to, item.external)
          const content = (
            <>
              <span className="wk-sidenav__ico" aria-hidden="true">
                <AppNavIcon name={item.icon} size={17} />
              </span>
              <span className="wk-sidenav__lbl">{item.label}</span>
            </>
          )
          if (item.external) {
            return (
              <a key={item.to} href={item.to} className="wk-sidenav__link" onClick={onClose}>
                {content}
              </a>
            )
          }
          return (
            <Link
              key={item.to}
              to={item.to}
              className={`wk-sidenav__link${active ? " is-active" : ""}`}
              onClick={(e) => { e.preventDefault(); onNavigate(item.to) }}
            >
              {content}
            </Link>
          )
        })}
      </nav>

      <div className="wk-sidenav__bottom">
        {claireHref ? (
          <a href={claireHref} className="wk-sidenav__claire" onClick={onClose}>
            <span className="wk-sidenav__claire-dot" aria-hidden="true">
              <PulseDot size={6} />
            </span>
            <span className="wk-sidenav__claire-body">
              <strong>Claire is active</strong>
              <em>On iMessage</em>
            </span>
          </a>
        ) : (
          <Link
            to="/me/profile#profile-corrections"
            className="wk-sidenav__claire is-pending"
            onClick={(e) => { e.preventDefault(); onNavigate("/me/profile#profile-corrections") }}
          >
            <span className="wk-sidenav__claire-dot" aria-hidden="true">
              <PulseDot size={6} />
            </span>
            <span className="wk-sidenav__claire-body">
              <strong>Update profile</strong>
              <em>Add context for Claire</em>
            </span>
          </Link>
        )}

        <div className="wk-sidenav__account">
          <button
            type="button"
            className="wk-sidenav__user"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Avatar name={name} src={user?.src} size={28} tone="warm" />
            <span className="wk-sidenav__user-name">
              <strong>{name}</strong>
              {user?.email ? <em>{user.email}</em> : null}
            </span>
            <Icon name="arrow-down" size={12} stroke={2} />
          </button>
          {menuOpen ? (
            <>
              <div className="wk-sidenav__menu-scrim" onClick={() => setMenuOpen(false)} />
              <div className="wk-sidenav__menu" role="menu">
                <Link
                  to="/me/profile"
                  role="menuitem"
                  className="wk-sidenav__menu-item"
                  onClick={(e) => { e.preventDefault(); setMenuOpen(false); onNavigate("/me/profile") }}
                >
                  <Icon name="lock" size={13} stroke={1.8} /> Profile &amp; privacy
                </Link>
                <button type="button" role="menuitem" className="wk-sidenav__menu-item" onClick={handleSignOut}>
                  <Icon name="arrow-left" size={13} stroke={1.8} /> Sign out
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </aside>
  )
}

// "How it works" — SPA hash anchor needs an onClick scroll because
// react-router-dom doesn't process the URL hash. If already on /, smooth
// scroll directly. Else navigate to /#how and let Landing's mount-time
// effect (Landing.tsx) handle scroll after render.
function HowItWorksLink() {
  const navigate = useNavigate()
  function go(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    if (window.location.pathname === "/") {
      document.getElementById("how")?.scrollIntoView({ behavior: "smooth", block: "start" })
      // Keep the hash in the URL for shareability without reloading.
      if (window.location.hash !== "#how") {
        window.history.replaceState(null, "", "/#how")
      }
    } else {
      navigate("/#how")
    }
  }
  return (
    <a href="/#how" className="wk-nav__link" onClick={go}>
      How it works
    </a>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /login page
// ────────────────────────────────────────────────────────────────────────────

function signupSourceForLoginNext(next: ReturnType<typeof parseLoginNextPath>): SignupSource | undefined {
  if (!next.isOnboarding) return undefined
  const params = new URLSearchParams(next.search.replace(/^\?/, ""))
  const fromQuery = params.get("source")
  if (fromQuery === "layoff" || fromQuery === "WeKruit_Laid_Off") return "WeKruit_Laid_Off"
  if (fromQuery === "candidate") return "candidate"
  const fromCookie = peekSource()
  return fromCookie === "WeKruit_Laid_Off" ? "WeKruit_Laid_Off" : undefined
}

function onboardingRoleReturnPath(next: ReturnType<typeof parseLoginNextPath>): string | null {
  if (!next.isOnboarding) return null
  const params = new URLSearchParams(next.search.replace(/^\?/, ""))
  const roleReturnPath = params.get("next")
  return roleReturnPath && isPublicJobPath(roleReturnPath) ? roleReturnPath : null
}

function roleInterviewFirstTimeHref(next: ReturnType<typeof parseLoginNextPath>): string | null {
  const rolePath = onboardingRoleReturnPath(next) ?? (isPublicJobPath(next.pathname) ? next.to : null)
  if (!rolePath) return null
  const roleDest = parseLoginNextPath(rolePath, rolePath)
  if (!isPublicJobPath(roleDest.pathname)) return null
  return `${roleDest.pathname.replace(/\/cv$/, "")}${roleDest.search}${roleDest.hash}`
}

function publicJobPathForLoginNext(next: ReturnType<typeof parseLoginNextPath>): string | null {
  const rolePath = onboardingRoleReturnPath(next) ?? (isPublicJobPath(next.pathname) ? next.to : null)
  if (!rolePath) return null
  const roleDest = parseLoginNextPath(rolePath, rolePath)
  return isPublicJobPath(roleDest.pathname) ? roleDest.pathname.replace(/\/cv$/, "") : null
}

const JOB_SLUG_LABELS: Record<string, string> = {
  ai: "AI",
  api: "API",
  apis: "APIs",
  ciso: "CISO",
  devops: "DevOps",
  evm: "EVM",
  gtm: "GTM",
  ios: "iOS",
  llm: "LLM",
  macos: "macOS",
  ml: "ML",
  qa: "QA",
  ui: "UI",
  ux: "UX",
}

function humanizeJobSlugToken(token: string): string {
  const lower = token.toLowerCase()
  return JOB_SLUG_LABELS[lower] ?? lower.charAt(0).toUpperCase() + lower.slice(1)
}

function humanizeRoleSlugTokens(tokens: string[]): string {
  if (!tokens.length) return "Open role"
  const fullstack = tokens[tokens.length - 1]?.toLowerCase() === "fullstack"
  const core = fullstack ? tokens.slice(0, -1) : tokens
  const title = core.map(humanizeJobSlugToken).join(" ").trim() || "Open role"
  return fullstack ? `${title} (Full-Stack)` : title
}

function roleInterviewSummary(next: ReturnType<typeof parseLoginNextPath>): { title: string; company: string } | null {
  const rolePath = publicJobPathForLoginNext(next)
  const slug = rolePath?.match(/^\/j\/([^/]+)$/)?.[1]
  if (!slug) return null
  const decodedSlug = decodeURIComponent(slug)
    .replace(/^(?:wekruit|standout)-[a-f0-9]{8}-/i, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  const [companyToken, ...roleTokens] = decodedSlug.split("-").filter(Boolean)
  if (!companyToken || roleTokens.length === 0) return null
  return {
    company: humanizeJobSlugToken(companyToken),
    title: humanizeRoleSlugTokens(roleTokens),
  }
}

function profileRoleSignalSummary(next: ReturnType<typeof parseLoginNextPath>): { title: string; company: string } | null {
  if (!isProfileRoleSignalPath(next.pathname, next.search, next.hash)) return null
  const params = new URLSearchParams(next.search.replace(/^\?/, ""))
  const title = params.get("profileRoleSignalTitle")?.trim()
  const company = params.get("profileRoleSignalCompany")?.trim()
  return title && company ? { title, company } : null
}

function LoginPipelinePreview() {
  const items = [
    {
      title: "Active role interviews",
      body: "See the roles Claire is screening with you and what needs your next answer.",
    },
    {
      title: "Claire session history",
      body: "Pick up prior conversations without losing resume, preference, or interview context.",
    },
    {
      title: "Profile signals and corrections",
      body: "Review the facts Claire uses before she pursues or rules out a role.",
    },
    {
      title: "Passed-profile consent",
      body: "Control when evidence is ready to share with a hiring team.",
    },
  ]

  return (
    <section className="wk-login-preview" aria-label="What opens after sign-in">
      <p className="wk-login-preview__k">What opens after sign-in</p>
      <ul className="wk-login-preview__list">
        {items.map((item) => (
          <li className="wk-login-preview__item" key={item.title}>
            <span className="wk-login-preview__icon">
              <Icon name="check" size={11} stroke={2.4} />
            </span>
            <span>
              <strong>{item.title}</strong>
              <em>{item.body}</em>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function LoginRoleInterviewSummary({ title, company, href }: { title: string; company: string; href: string }) {
  return (
    <section className="wk-login-role" aria-label="Selected role for this interview">
      <span className="wk-login-role__mark" aria-hidden="true">{company.charAt(0).toUpperCase()}</span>
      <span className="wk-login-role__body">
        <span className="wk-login-role__k">Selected role</span>
        <strong>{title}</strong>
        <em>{company} · Claire role interview</em>
      </span>
      <Link className="wk-login-role__link" to={href}>Brief</Link>
    </section>
  )
}

function LoginRoleSignalPreview({ title, company }: { title: string; company: string }) {
  const items = [
    {
      title: "Role signal waiting",
      body: `${title} at ${company} stays attached so Claire can turn it into profile evidence.`,
    },
    {
      title: "Durable preference update",
      body: "Claire uses the role to update target roles, constraints, and corrections instead of treating it as an application.",
    },
    {
      title: "No automatic submission",
      body: "This only updates your WeKruit profile signal; hiring teams still see evidence only after a role screen and consent.",
    },
  ]

  return (
    <section className="wk-login-preview" aria-label="Role signal after sign-in">
      <p className="wk-login-preview__k">Role signal after sign-in</p>
      <ul className="wk-login-preview__list">
        {items.map((item) => (
          <li className="wk-login-preview__item" key={item.title}>
            <span className="wk-login-preview__icon">
              <Icon name="check" size={11} stroke={2.4} />
            </span>
            <span>
              <strong>{item.title}</strong>
              <em>{item.body}</em>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

type LoginContextKind = "role" | "signal" | "onboarding" | "referral" | "pipeline"

function LoginContextStrip({ kind }: { kind: LoginContextKind }) {
  const items: Record<LoginContextKind, { title: string; body: string }[]> = {
    role: [
      { title: "Role screen", body: "Claire keeps this brief attached." },
      { title: "Profile evidence", body: "Resume and answers follow the interview." },
      { title: "Consent gate", body: "Only passed evidence can be shared." },
    ],
    signal: [
      { title: "Saved signal", body: "This role updates your profile targets." },
      { title: "Preference memory", body: "Corrections stay attached for future screens." },
      { title: "No auto-apply", body: "Nothing goes to a hiring team yet." },
    ],
    onboarding: [
      { title: "Profile chat", body: "Claire asks before anything is shared." },
      { title: "Resume + LinkedIn", body: "Background turns into reusable evidence." },
      { title: "Nearest proof", body: "Fit comes from closest-overlap work." },
    ],
    referral: [
      { title: "Invite ledger", body: "Your friend and milestone status stay attached." },
      { title: "$50 interview reward", body: "Tracked after a verified hiring-manager interview." },
      { title: "$4k placement reward", body: "Tracked after a verified offer/start." },
    ],
    pipeline: [
      { title: "Active interviews", body: "Resume where Claire needs your answer." },
      { title: "Session memory", body: "Prior roles and corrections stay attached." },
      { title: "Share control", body: "Passed evidence waits for consent." },
    ],
  }

  return (
    <section className="wk-login-context" aria-label="What Claire keeps through sign-in">
      <span className="wk-login-context__label">After sign-in, Claire keeps</span>
      <div className="wk-login-context__items">
        {items[kind].map((item) => (
          <span key={item.title} className="wk-login-context__item">
            <span className="wk-login-context__dot">
              <Icon name="check" size={10} stroke={2.4} />
            </span>
            <span>
              <strong>{item.title}</strong>
              <em>{item.body}</em>
            </span>
          </span>
        ))}
      </div>
    </section>
  )
}

function LoginOnboardingPreview() {
  const items = [
    {
      title: "One durable Claire profile",
      body: "Sign-in opens the same WeKruit profile Claire uses across role interviews, evidence, and corrections.",
    },
    {
      title: "Resume and LinkedIn uptake",
      body: "Claire starts by turning your background into a durable WeKruit profile.",
    },
    {
      title: "Target roles and constraints",
      body: "Capture the roles, locations, salary range, timing, visa, and company shapes that matter.",
    },
    {
      title: "Nearest-work evidence",
      body: "Claire asks for closest-overlap proof before a role becomes a fit decision.",
    },
    {
      title: "Profile corrections stay editable",
      body: "You can correct facts and preferences before Claire pursues or rules out a role.",
    },
  ]

  return (
    <section className="wk-login-preview" aria-label="What Claire starts after sign-in">
      <p className="wk-login-preview__k">What Claire starts after sign-in</p>
      <ul className="wk-login-preview__list">
        {items.map((item) => (
          <li className="wk-login-preview__item" key={item.title}>
            <span className="wk-login-preview__icon">
              <Icon name="message" size={11} stroke={2.4} />
            </span>
            <span>
              <strong>{item.title}</strong>
              <em>{item.body}</em>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function LoginReferralPreview() {
  const items = [
    {
      title: "Invite tracking",
      body: "See which referrals are linked to you and whether they have claimed the invite.",
    },
    {
      title: "Verified milestones",
      body: "Interview and placement rewards only move when WeKruit can verify the milestone.",
    },
    {
      title: "Candidate-first loop",
      body: "Friends still get Claire's profile conversation and consent-gated role screens.",
    },
    {
      title: "Payout status",
      body: "Keep the reward ledger separate from the candidate's interview evidence.",
    },
  ]

  return (
    <section className="wk-login-preview" aria-label="What the referral dashboard opens after sign-in">
      <p className="wk-login-preview__k">Referral dashboard after sign-in</p>
      <ul className="wk-login-preview__list">
        {items.map((item) => (
          <li className="wk-login-preview__item" key={item.title}>
            <span className="wk-login-preview__icon">
              <Icon name="check" size={11} stroke={2.4} />
            </span>
            <span>
              <strong>{item.title}</strong>
              <em>{item.body}</em>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function CandidateLogin() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isCompletingLink = useMemo(() => isSignInWithEmailLink(auth(), window.location.href), [])
  const phoneLinkIntentFromUrl = useMemo(() => readPhoneLinkIntentParam(searchParams), [searchParams])
  const nextDest = useMemo(() => {
    const raw = searchParams.get("next")
    const safeRaw = raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : null
    if (safeRaw) rememberLoginNext(safeRaw)
    let oauthPendingForNext = false
    try {
      oauthPendingForNext = window.sessionStorage.getItem(OAUTH_PENDING_KEY) === "1"
    } catch {
      // ignore private mode
    }
    const remembered = oauthPendingForNext ? readRememberedLoginNext() : null
    const intentPath = safeRaw ?? remembered
    if (intentPath) rememberOnboardingIntentForPath(intentPath)
    stickSourceFromLoginNext(intentPath)
    const fallback = isLayoffHost()
      ? onboardingDestination("WeKruit_Laid_Off")
      : onboardingDestination(peekSource())
    const nextInput = safeRaw ?? remembered ?? fallback
    return parseLoginNextPath(nextInput, fallback)
  }, [searchParams])
  const [email, setEmail] = useState(() => readStoredValue(EMAIL_STORAGE_KEY) ?? "")
  const [status, setStatus] = useState<
    "idle" | "google" | "linkedin" | "sending" | "sent" | "signing_in" | "error"
  >(() => {
    if (isCompletingLink) return "signing_in"
    try {
      if (window.sessionStorage.getItem(OAUTH_PENDING_KEY) === "1") return "signing_in"
    } catch {
      // ignore private mode
    }
    return "idle"
  })
  const [error, setError] = useState<string | null>(null)
  const [signedInUser, setSignedInUser] = useState<User | null>(() => auth().currentUser)
  const [phoneLinkMode, setPhoneLinkMode] = useState(() => phoneLinkIntentFromUrl || readPhoneLinkIntent())
  const [phoneLinkPhone, setPhoneLinkPhone] = useState("")
  const [phoneLinkCode, setPhoneLinkCode] = useState("")
  const [phoneLink, setPhoneLink] = useState<PhoneLinkState>(() =>
    phoneLinkIntentFromUrl || readPhoneLinkIntent()
      ? {
          status: auth().currentUser ? "ready" : "needs_auth",
          message: auth().currentUser
            ? "Enter the phone number you used with Claire."
            : "Sign in first. We will keep this phone-link step open.",
        }
      : { status: "idle", message: null },
  )
  const finishInFlight = useRef(false)

  useEffect(() => {
    if (!phoneLinkIntentFromUrl) return
    rememberPhoneLinkIntent()
    setPhoneLinkMode(true)
    setPhoneLink((prev) =>
      prev.status === "idle" || prev.status === "needs_auth"
        ? {
            status: auth().currentUser ? "ready" : "needs_auth",
            message: auth().currentUser
              ? "Enter the phone number you used with Claire."
              : "Sign in first. We will keep this phone-link step open.",
          }
        : prev,
    )
  }, [phoneLinkIntentFromUrl])

  useEffect(() => {
    return onAuthStateChanged(auth(), (user) => {
      setSignedInUser(user)
      if (user && readPhoneLinkIntent()) {
        setPhoneLinkMode(true)
        setPhoneLink((prev) =>
          prev.status === "needs_auth" || prev.status === "idle"
            ? { status: "ready", message: "Signed in. Enter the phone number you used with Claire." }
            : prev,
        )
      }
    })
  }, [])

  const finishSignedIn = useCallback(async () => {
    if (finishInFlight.current) return
    finishInFlight.current = true
    setStatus("signing_in")
    setError(null)
    try {
      if (readPhoneLinkIntent()) {
        setPhoneLinkMode(true)
        setPhoneLink({ status: "ready", message: "Signed in. Enter the phone number you used with Claire." })
        setStatus("idle")
        return
      }
      const verifySource = signupSourceForLoginNext(nextDest)
      const verified = await verifyCandidateMagicLinkSession({
        ...(verifySource ? { source: verifySource } : {}),
        registrationEntryPath: nextDest.to,
      })
      const destination = resolvePostLoginDestination(
        nextDest,
        verified.portalReady,
        verifySource,
      )
      clearRememberedLoginNext()
      const dest = parseLoginNextPath(destination)
      navigate({ pathname: dest.pathname, search: dest.search }, { replace: true })
    } catch (err) {
      setStatus("error")
      setError(formatAuthError(err))
    } finally {
      finishInFlight.current = false
    }
  }, [navigate, nextDest])

  useEffect(() => {
    if (isCompletingLink) return
    let cancelled = false

    void (async () => {
      let oauthPending = false
      try {
        oauthPending = window.sessionStorage.getItem(OAUTH_PENDING_KEY) === "1"
        // Layoff auth uses popup/provider windows; drop stale redirect flags from older attempts.
        if (isLayoffHost() && oauthPending) {
          window.sessionStorage.removeItem(OAUTH_PENDING_KEY)
          oauthPending = false
        }

        const linkedinPayload = takeLinkedinAuthPayload()
        if (linkedinPayload?.ok) {
          await signInWithCustomToken(auth(), linkedinPayload.customToken)
          if (!cancelled && auth().currentUser) await finishSignedIn()
          return
        }
        if (linkedinPayload && !linkedinPayload.ok) throw new Error(linkedinPayload.error)

        // Redirect result is consumed at app bootstrap (main.tsx import) before React mounts.
        // Cross-domain SSO bootstrap runs in parallel — wait for it too so a user who
        // signed in on candidate.wekruit.com gets auto-recognized here on wekruit.com
        // without seeing the login form flash.
        const [result] = await Promise.all([redirectResultPromise, ssoBootstrapPromise.catch(() => null)])
        if (cancelled) return

        window.sessionStorage.removeItem(OAUTH_PENDING_KEY)
        let user = result?.user ?? auth().currentUser
        if (!user && oauthPending) {
          user = await waitForAuthUser(5000)
        }
        if (user) {
          await finishSignedIn()
          return
        }
        if (oauthPending) {
          setStatus("error")
          setError(
            "Sign-in didn't finish after redirect. Choose Google or LinkedIn again, or use Try again if the provider already completed.",
          )
          return
        }
        setStatus("idle")
      } catch (err) {
        window.sessionStorage.removeItem(OAUTH_PENDING_KEY)
        if (!cancelled) {
          setStatus("error")
          setError(formatAuthError(err))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [finishSignedIn, isCompletingLink])

  useEffect(() => {
    if (!isCompletingLink) return
    const stored = cleanEmail(readStoredValue(EMAIL_STORAGE_KEY) ?? "")
    if (!stored) { setStatus("idle"); return }
    let cancelled = false
    void (async () => {
      try {
        await signInWithEmailLink(auth(), stored, window.location.href)
        window.localStorage.removeItem(EMAIL_STORAGE_KEY)
        if (!cancelled) await finishSignedIn()
      } catch (err) {
        if (!cancelled) {
          setStatus("error")
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => { cancelled = true }
  }, [finishSignedIn, isCompletingLink])

  async function startProviderSignIn(kind: "google" | "linkedin") {
    setStatus(kind)
    setError(null)
    rememberLoginNext(nextDest.to)
    rememberOnboardingIntentForPath(nextDest.to)
    if (kind === "google") {
      // Popup avoids the signInWithRedirect third-party-cookie trap when
      // authDomain (wekruit-5f89b.firebaseapp.com) differs from the site
      // origin (candidate.wekruit.com / layoff.wekruit.com).
      try {
        await signInWithPopup(auth(), createGoogleProvider())
        setStatus("signing_in")
        await finishSignedIn()
      } catch (err) {
        setStatus("error")
        setError(formatAuthError(err))
      }
      return
    }
    try {
      window.sessionStorage.setItem(OAUTH_PENDING_KEY, "1")
    } catch {
      // ignore private mode
    }
    const returnTo = `${window.location.origin}/login?next=${encodeURIComponent(nextDest.to)}`
    window.location.assign(`${LINKEDIN_AUTH_START_URL}?returnTo=${encodeURIComponent(returnTo)}`)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const nextEmail = cleanEmail(email)
    if (!nextEmail) return
    setError(null)
    try {
      if (isCompletingLink) {
        setStatus("signing_in")
        await signInWithEmailLink(auth(), nextEmail, window.location.href)
        window.localStorage.removeItem(EMAIL_STORAGE_KEY)
        await finishSignedIn()
        return
      }
      setStatus("sending")
      rememberLoginNext(nextDest.to)
      rememberOnboardingIntentForPath(nextDest.to)
      await sendSignInLinkToEmail(auth(), nextEmail, {
        url: `${window.location.origin}/login?next=${encodeURIComponent(nextDest.to)}`,
        handleCodeInApp: true,
      })
      rememberStoredValue(EMAIL_STORAGE_KEY, nextEmail)
      setStatus("sent")
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function activatePhoneLink() {
    rememberPhoneLinkIntent()
    rememberLoginNext(nextDest.to)
    setPhoneLinkMode(true)
    setError(null)
    setPhoneLink(
      signedInUser
        ? { status: "ready", message: "Enter the phone number you used with Claire." }
        : { status: "needs_auth", message: "Sign in first. We will keep this phone-link step open." },
    )
  }

  function closePhoneLink() {
    clearPhoneLinkIntent()
    setPhoneLinkMode(false)
    setPhoneLinkPhone("")
    setPhoneLinkCode("")
    setPhoneLink({ status: "idle", message: null })
  }

  async function onPhoneLinkStart(e: FormEvent) {
    e.preventDefault()
    if (!signedInUser) {
      activatePhoneLink()
      return
    }
    setPhoneLink({ status: "sending_code", message: null })
    try {
      const result = await startCandidatePhoneLink(phoneLinkPhone)
      if (!result.ok) {
        setPhoneLink({ status: "error", message: result.message })
        return
      }
      setPhoneLinkCode("")
      setPhoneLink({
        status: "code_sent",
        requestId: result.requestId,
        phoneMasked: result.phoneMasked,
        message: `Code sent to ${result.phoneMasked}. Enter it here to connect this web account.`,
      })
    } catch (err) {
      setPhoneLink({
        status: "error",
        message: err instanceof Error ? err.message : "Could not send the code. Try again.",
      })
    }
  }

  async function onPhoneLinkVerify(e: FormEvent) {
    e.preventDefault()
    if (phoneLink.status !== "code_sent" && phoneLink.status !== "verifying") return
    const requestId = phoneLink.requestId
    const phoneMasked = phoneLink.phoneMasked
    setPhoneLink({
      status: "verifying",
      requestId,
      phoneMasked,
      message: "Checking the code with Claire's phone thread…",
    })
    try {
      const result = await verifyCandidatePhoneLink(requestId, phoneLinkCode)
      if (!result.ok) {
        setPhoneLink(
          result.reason === "invalid_code"
            ? { status: "code_sent", requestId, phoneMasked, message: result.message }
            : { status: "error", requestId, phoneMasked, message: result.message },
        )
        return
      }
      clearPhoneLinkIntent()
      clearRememberedLoginNext()
      setPhoneLink({
        status: "linked",
        phoneMasked: result.phoneMasked,
        message: "Claire's phone thread is connected.",
      })
      const verifySource = signupSourceForLoginNext(nextDest)
      const destination = nextDest.isOnboarding
        ? "/me"
        : resolvePostLoginDestination(nextDest, true, verifySource)
      const dest = parseLoginNextPath(destination)
      navigate({ pathname: dest.pathname, search: dest.search }, { replace: true })
    } catch (err) {
      setPhoneLink({
        status: "error",
        requestId,
        phoneMasked,
        message: err instanceof Error ? err.message : "Could not verify the code. Try again.",
      })
    }
  }

  const phoneLinkBusy = phoneLink.status === "sending_code" || phoneLink.status === "verifying"
  const busy = status === "google" || status === "linkedin" || status === "sending" || status === "signing_in" || phoneLinkBusy
  const onLayoff = isLayoffHost()
  const onboardingRoleReturn = onboardingRoleReturnPath(nextDest)
  const roleInterview = roleInterviewSummary(nextDest)
  const profileRoleSignal = profileRoleSignalSummary(nextDest)
  const roleInterviewNext = isPublicJobPath(nextDest.pathname) || Boolean(onboardingRoleReturn)
  const roleSignalNext = Boolean(profileRoleSignal)
  const onboardingNext = nextDest.isOnboarding && !roleInterviewNext
  const referralNext = nextDest.pathname === "/me/refer"
  const showCompletingLink = isCompletingLink && !phoneLinkMode
  const showAuthControls = !showCompletingLink && !(phoneLinkMode && signedInUser)
  const phoneLinkAuthActive = phoneLinkMode && !signedInUser && showAuthControls
  const showMainAuthControls = showAuthControls && !phoneLinkAuthActive
  const showPipelinePreview = !showCompletingLink && !roleInterviewNext && !roleSignalNext && !onboardingNext && !referralNext
  const showRoleSignalPreview = !showCompletingLink && roleSignalNext
  const showOnboardingPreview = !showCompletingLink && onboardingNext
  const showReferralPreview = !showCompletingLink && referralNext
  const loginContextKind: LoginContextKind =
    roleInterviewNext ? "role" : roleSignalNext ? "signal" : onboardingNext ? "onboarding" : referralNext ? "referral" : "pipeline"
  const roleFirstTimeHref = roleInterviewFirstTimeHref(nextDest)
  const roleSignalFirstTimeHref = roleSignalNext ? onboardingDestinationWithReturnPath(nextDest.to, peekSource()) : null
  const firstTimeHref = roleInterviewNext
    ? roleFirstTimeHref ?? nextDest.to
    : roleSignalNext
      ? roleSignalFirstTimeHref ?? onboardingDestination(peekSource())
      : onboardingNext
        ? nextDest.to
        : onboardingDestination(peekSource())
  const loginEyebrow = showCompletingLink
    ? "Finishing sign-in"
    : roleInterviewNext
      ? "Role interview"
      : roleSignalNext
        ? "Role signal"
      : onboardingNext
        ? "Start with Claire"
      : referralNext
        ? "Referral dashboard"
        : "Pick up where you left off"
  const loginSub = showCompletingLink
    ? "One sec — confirming your email and pulling up your pipeline."
    : status === "signing_in"
      ? onboardingRoleReturn
        ? "One sec — confirming your sign-in and keeping this role attached to Claire's profile flow."
        : roleInterviewNext
        ? "One sec — confirming your sign-in and reopening this role with Claire."
        : roleSignalNext
        ? "One sec — confirming your sign-in and saving this role as durable profile signal."
        : onboardingNext
          ? "One sec — confirming your sign-in and opening Claire's profile flow."
        : referralNext
          ? "One sec — confirming your sign-in and opening the referral ledger."
          : "One sec — confirming your sign-in and pulling up your active pipeline."
      : onboardingRoleReturn
        ? "Sign in once and Claire will keep this role attached to your profile flow. Magic-link, Google, or LinkedIn — your choice."
        : roleInterviewNext
          ? "Sign in and Claire keeps this role attached to your interview and profile."
        : roleSignalNext
          ? "Sign in and Claire will add this role to your durable profile signals."
        : onboardingNext
          ? "Sign in once and Claire starts a guided profile chat: resume or LinkedIn first, then target roles, constraints, and nearest-work evidence."
        : referralNext
          ? "Sign in once to track referral invites, verified interview rewards, and offer/start payouts."
          : "Sign in and we'll pull up your active pipeline. Magic-link, Google, or LinkedIn — your choice."

  const renderAuthControls = () => (
    <div className="wk-login__auth-block">
      <div className="wk-login__providers">
        <button
          type="button"
          className="wk-btn wk-btn--ink wk-btn--block"
          onClick={() => void startProviderSignIn("google")}
          disabled={busy}
        >
          {status === "google" ? "Opening Google…" : onboardingNext ? "Start with Google" : "Continue with Google"}
        </button>
        <button
          type="button"
          className="wk-btn wk-btn--linkedin wk-btn--block"
          onClick={() => void startProviderSignIn("linkedin")}
          disabled={busy}
        >
          {status === "linkedin" ? "Opening LinkedIn…" : onboardingNext ? "Start with LinkedIn" : "Continue with LinkedIn"}
        </button>
      </div>
      <div className="wk-login__divider"><span>or magic link</span></div>
      <form onSubmit={onSubmit} className="wk-login__form">
        <label className="wk-login__field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={busy}
          />
        </label>
        <button type="submit" className="wk-btn wk-btn--primary wk-btn--block" disabled={busy}>
          {status === "sending" ? "Sending…" : "Send magic link"}
          {!busy ? <Icon name="arrow-right" size={16} stroke={2} /> : null}
        </button>
      </form>
    </div>
  )

  if (onLayoff) {
    const layoffStatus =
      status === "error"
        ? "error"
        : status === "signing_in"
          ? "signing_in"
          : status === "google"
            ? "google"
            : status === "linkedin"
              ? "linkedin"
              : "idle"
    return (
      <LayoffLoginCard
        status={layoffStatus}
        error={error}
        busy={busy}
        onGoogle={() => void startProviderSignIn("google")}
        onLinkedIn={() => void startProviderSignIn("linkedin")}
        onRetry={() => {
          setError(null)
          void startProviderSignIn("google")
        }}
      />
    )
  }

  const loginBody = (
      <div className="wk-login">
        <div className="wk-container">
          <div className={`wk-login__card${showPipelinePreview ? " wk-login__card--pipeline" : ""}${phoneLinkMode ? " wk-login__card--phone-link" : ""}`}>
            <p className="wk-eyebrow">
              {loginEyebrow}
            </p>
            <h1 className="wk-login__h">
              {showCompletingLink
                ? <>Finishing <em className="wk-accent">sign-in.</em></>
                : roleInterviewNext
                  ? <>Continue this <em className="wk-accent">role.</em></>
                : roleSignalNext
                  ? <>Save this <em className="wk-accent">role signal.</em></>
                : onboardingNext
                  ? <>Start with <em className="wk-accent">Claire.</em></>
                : referralNext
                  ? <>Open referral <em className="wk-accent">dashboard.</em></>
                : <>Already talked to <em className="wk-accent">Claire?</em></>}
            </h1>
            <p className="wk-login__sub">
              {loginSub}
            </p>

            {roleInterviewNext && roleInterview ? (
              <LoginRoleInterviewSummary title={roleInterview.title} company={roleInterview.company} href={roleFirstTimeHref ?? nextDest.to} />
            ) : null}

            {!showCompletingLink ? <LoginContextStrip kind={loginContextKind} /> : null}

            {!showCompletingLink ? (
              <section className={`wk-login-phone-link${phoneLinkMode ? " is-open" : ""}`} aria-label="Connect a Claire phone thread">
                <button
                  type="button"
                  className="wk-login-phone-link__trigger"
                  onClick={activatePhoneLink}
                  disabled={phoneLinkBusy}
                >
                  <Icon name="message" size={16} stroke={2} />
                  <span>I've texted Claire</span>
                </button>
                <p className="wk-login-phone-link__copy">
                  Already talked with Claire by phone? Verify that number and open the WeKruit profile Claire already knows.
                </p>

                {phoneLinkMode ? (
                  <div className="wk-login-phone-link__panel">
                    {!signedInUser ? (
                      <>
                        <p className="wk-login-phone-link__note">
                          Choose a sign-in method below. Then Claire texts a code to connect the phone thread she already knows.
                        </p>
                        <div className="wk-login-phone-link__auth" aria-label="Sign in before connecting Claire phone thread">
                          {renderAuthControls()}
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="wk-login-phone-link__note">
                          Signed in as {signedInUser.email ?? "this account"}. We will text a code to the phone Claire already has.
                        </p>
                        <form className="wk-login-phone-link__form" onSubmit={onPhoneLinkStart}>
                          <label className="wk-login__field">
                            <span>Phone used with Claire</span>
                            <input
                              type="tel"
                              inputMode="tel"
                              autoComplete="tel"
                              value={phoneLinkPhone}
                              onChange={(e) => setPhoneLinkPhone(e.target.value)}
                              placeholder="+1 415 555 0100"
                              disabled={busy}
                            />
                          </label>
                          <button type="submit" className="wk-btn wk-btn--secondary wk-btn--block" disabled={busy}>
                            {phoneLink.status === "sending_code" ? "Sending code…" : "Text me a code"}
                          </button>
                        </form>

                        {(phoneLink.status === "code_sent" || phoneLink.status === "verifying") ? (
                          <form className="wk-login-phone-link__form" onSubmit={onPhoneLinkVerify}>
                            <label className="wk-login__field">
                              <span>Verification code</span>
                              <input
                                type="text"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                value={phoneLinkCode}
                                onChange={(e) => setPhoneLinkCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                placeholder="123456"
                                disabled={busy}
                              />
                            </label>
                            <button type="submit" className="wk-btn wk-btn--ink wk-btn--block" disabled={busy || phoneLinkCode.length < 6}>
                              {phoneLink.status === "verifying" ? "Connecting…" : "Connect Claire thread"}
                            </button>
                          </form>
                        ) : null}
                      </>
                    )}

                    {phoneLink.message && phoneLink.status !== "needs_auth" ? (
                      <p className={phoneLink.status === "error" ? "wk-error" : "wk-success"} aria-live="polite">
                        {phoneLink.message}
                      </p>
                    ) : null}
                    <button type="button" className="wk-login-phone-link__close" onClick={closePhoneLink}>
                      Use normal onboarding
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}

            {showRoleSignalPreview && profileRoleSignal ? <LoginRoleSignalPreview title={profileRoleSignal.title} company={profileRoleSignal.company} /> : null}

            {status === "signing_in" && !showCompletingLink ? (
              <p className="wk-success">Signing you in…</p>
            ) : null}

            {showMainAuthControls ? renderAuthControls() : null}

            {showCompletingLink ? (
              <form onSubmit={onSubmit} className="wk-login__form">
                <label className="wk-login__field">
                  <span>Email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    disabled={busy}
                  />
                </label>
                <button type="submit" className="wk-btn wk-btn--primary wk-btn--block" disabled={busy}>
                  {status === "signing_in" ? "Signing in…" : "Continue"}
                  {!busy ? <Icon name="arrow-right" size={16} stroke={2} /> : null}
                </button>
              </form>
            ) : null}

            {status === "sent" ? (
              <p className="wk-success">Magic link sent to {cleanEmail(email)}.</p>
            ) : null}
            {error ? (
              <p className="wk-error">
                {error}{" "}
                <button
                  type="button"
                  className="wk-link"
                  style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
                  onClick={() => void finishSignedIn()}
                >
                  Try again
                </button>
              </p>
            ) : null}

            {showPipelinePreview ? <LoginPipelinePreview /> : null}
            {showOnboardingPreview ? <LoginOnboardingPreview /> : null}
            {showReferralPreview ? <LoginReferralPreview /> : null}

            {!onboardingNext ? (
              <p className="wk-login__fine">
                {roleInterviewNext ? (
                  <>First time on this role? <Link to={firstTimeHref} className="wk-link">Continue here</Link> and Claire will keep the role attached.</>
                ) : roleSignalNext ? (
                  <>First time? <Link to={firstTimeHref} className="wk-link">Continue here</Link> and Claire will start your profile with this role signal.</>
                ) : (
                  <>First time? <Link to={firstTimeHref} className="wk-link">Continue here</Link> and Claire will start the same profile flow.</>
                )}
              </p>
            ) : null}
          </div>
        </div>
      </div>
  )

  return <CandidateShell>{loginBody}</CandidateShell>
}

// ────────────────────────────────────────────────────────────────────────────
// Styles — global candidate visual system + login screen
// ────────────────────────────────────────────────────────────────────────────

export const CANDIDATE_STYLES = `
/* Fonts ----------------------------------------------------------------- */
@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital,wght@0,400;1,400&family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..700&family=Hanken+Grotesk:wght@300..800&display=swap');

/* Tokens (scoped to .wk-shell so we don't leak into legacy candidate-* CSS) */
.wk-shell {
  --wk-cream: #F5EDE3;
  --wk-cream-2: #EFE4D4;
  --wk-cream-3: #FAF5EC;
  --wk-ink: #2D1A0A;
  --wk-ink-2: #5A4636;
  --wk-ink-3: #897462;
  --wk-ink-4: #B5A595;
  --wk-border: #E3D6C3;
  --wk-border-strong: #C9B69E;
  --wk-peach-50: #FBE8DA;
  --wk-peach-100: #F6D6BE;
  --wk-peach-200: #F0BFA0;
  --wk-peach-300: #E8A988;
  --wk-peach-glow: rgba(232, 169, 136, 0.55);
  --wk-live: #9A4421;
  --wk-live-2: #7A3318;
  --wk-live-soft: #FBE8DA;
  --wk-live-border: #F0BFA0;
  --wk-live-pulse: #E0742E;
  --wk-imsg-blue: #007AFF;
  --wk-imsg-blue-2: #0A85FF;
  --wk-imsg-gray: #E9E9EB;
  --wk-r-sm: 8px;
  --wk-r-md: 14px;
  --wk-r-lg: 20px;
  --wk-r-pill: 999px;
  --wk-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --wk-halo-hero:
    radial-gradient(ellipse 80% 70% at 50% 30%, var(--wk-peach-glow) 0%, transparent 60%),
    radial-gradient(ellipse 60% 50% at 0% 50%, rgba(246,214,190,.45) 0%, transparent 55%),
    radial-gradient(ellipse 60% 50% at 100% 50%, rgba(246,214,190,.45) 0%, transparent 55%),
    var(--wk-cream);

  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--wk-cream);
  font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: var(--wk-ink);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wk-shell--hero { background: var(--wk-halo-hero); }
.wk-shell *, .wk-shell *::before, .wk-shell *::after { box-sizing: border-box; }
.wk-shell a { color: inherit; }
/* Restore button text colors on anchors (Link renders <a>, which the rule
   above otherwise resets to inherit and produces invisible CTA text). */
.wk-shell a.wk-btn--primary,
.wk-shell a.wk-btn--ink { color: var(--wk-cream); }
.wk-shell a.wk-btn--secondary { color: var(--wk-ink); }
.wk-shell a.wk-btn--linkedin { color: #fff; }
.wk-shell a.wk-btn--ghost { color: var(--wk-ink-2); }
.wk-shell a.wk-btn--ghost:hover { color: var(--wk-ink); }

/* Logo ------------------------------------------------------------------ */
.wk-logo {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  letter-spacing: -0.02em;
  color: var(--wk-ink);
  font-weight: 500;
  line-height: 1;
  display: inline-flex;
  align-items: baseline;
}
.wk-logo em { font-style: italic; font-weight: 400; }

/* Header / footer ------------------------------------------------------- */
.wk-header {
  position: sticky; top: 0; z-index: 10;
  background: rgba(245, 237, 227, 0.78);
  backdrop-filter: saturate(140%) blur(14px);
  -webkit-backdrop-filter: saturate(140%) blur(14px);
  border-bottom: 1px solid rgba(227, 214, 195, 0.55);
}
.wk-header__inner {
  max-width: 1160px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 14px 24px;
  flex-wrap: nowrap;
}
.wk-header__inner > .wk-nav { margin-left: auto; }
.wk-header__inner > .wk-header__cta { flex: none; }
.wk-header__brand { text-decoration: none; display: inline-flex; align-items: baseline; gap: 10px; }
.wk-header__brand-meta {
  display: inline-flex; align-items: baseline; gap: 10px;
  font-family: 'Instrument Serif', 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-style: italic; font-size: 18px;
  color: var(--wk-peach-300); letter-spacing: -0.01em;
}
.wk-header__brand-meta::before {
  content: "·"; color: var(--wk-ink-3); font-style: normal; font-size: 14px;
}
.wk-nav { display: flex; align-items: center; justify-content: center; gap: 28px; }
.wk-nav__link {
  display: inline-flex; align-items: center; height: 34px; padding: 0;
  background: transparent;
  color: var(--wk-ink-3);
  font-size: 14.5px;
  font-weight: 500;
  letter-spacing: -0.005em;
  text-decoration: none;
  white-space: nowrap;
  transition: color 200ms var(--wk-ease);
}
.wk-nav__link:hover { color: var(--wk-ink); background: transparent; }
.wk-nav__link[aria-current="page"], .wk-nav__link.is-active {
  color: var(--wk-ink); font-weight: 600; background: transparent;
}
.wk-header__cta { justify-self: end; display: inline-flex; align-items: center; gap: 18px; }
.wk-header__signin {
  color: var(--wk-ink-2); text-decoration: none;
  font-size: 14.5px; font-weight: 500; white-space: nowrap;
  transition: color 200ms var(--wk-ease);
}
.wk-header__signin:hover { color: var(--wk-ink); }
.wk-header__primary-short { display: none; }
.wk-main { flex: 1; }
.wk-footer {
  margin-top: 80px;
  border-top: 1px solid var(--wk-border);
  padding: 28px 24px 36px;
  background: var(--wk-cream);
}
.wk-footer__inner {
  max-width: 1160px; margin: 0 auto;
  display: flex; flex-wrap: wrap; gap: 16px 32px;
  align-items: center; justify-content: space-between;
}
.wk-footer__brand { display: inline-flex; align-items: baseline; gap: 12px; }
.wk-footer__tag { color: var(--wk-ink-3); font-size: 13.5px; }
.wk-footer__nav { display: inline-flex; gap: 20px; flex-wrap: wrap; }
.wk-footer__nav a { color: var(--wk-ink-3); text-decoration: none; font-size: 13.5px; transition: color 200ms var(--wk-ease); }
.wk-footer__nav a:hover { color: var(--wk-ink); }

/* Container utilities --------------------------------------------------- */
.wk-container { max-width: 1160px; margin: 0 auto; padding: 0 24px; }
.wk-container--narrow { max-width: 940px; margin: 0 auto; padding: 0 24px; }

/* Buttons --------------------------------------------------------------- */
.wk-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  font-family: inherit; font-weight: 600; font-size: 14.5px;
  letter-spacing: -0.005em; line-height: 1;
  padding: 13px 20px; border-radius: var(--wk-r-pill);
  border: 1px solid transparent; cursor: pointer;
  transition: background 200ms var(--wk-ease), color 200ms var(--wk-ease),
              border-color 200ms var(--wk-ease), box-shadow 200ms var(--wk-ease),
              transform 200ms var(--wk-ease);
  text-decoration: none; white-space: nowrap;
}
.wk-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--wk-cream), 0 0 0 4px var(--wk-ink); }
.wk-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.wk-btn--primary { background: var(--wk-ink); color: var(--wk-cream); box-shadow: 0 1px 2px rgba(45,26,10,.08); }
.wk-btn--primary:hover:not(:disabled) { background: #1C0F04; box-shadow: 0 4px 12px -2px rgba(45,26,10,.22); transform: translateY(-1px); }
.wk-btn--ink { background: var(--wk-ink); color: var(--wk-cream); box-shadow: 0 1px 2px rgba(45,26,10,.06); }
.wk-btn--ink:hover:not(:disabled) { background: #1C0F04; transform: translateY(-1px); }
.wk-btn--secondary { background: transparent; color: var(--wk-ink); border-color: var(--wk-ink); }
.wk-btn--secondary:hover:not(:disabled) { background: var(--wk-ink); color: var(--wk-cream); }
.wk-btn--linkedin { background: #0A66C2; color: #fff; border-color: #0A66C2; }
.wk-btn--linkedin:hover:not(:disabled) { background: #08549d; }
.wk-btn--ghost { background: transparent; color: var(--wk-ink-2); }
.wk-btn--ghost:hover:not(:disabled) { background: rgba(45,26,10,.06); color: var(--wk-ink); }
.wk-btn--sm { padding: 9px 14px; font-size: 13.5px; }
.wk-btn--lg { padding: 16px 26px; font-size: 15px; }
.wk-btn--block { width: 100%; }

.wk-link {
  color: var(--wk-ink); text-decoration: none;
  border-bottom: 1px solid var(--wk-ink-4); padding-bottom: 1px;
  transition: border-color 200ms var(--wk-ease);
}
.wk-link:hover { border-bottom-color: var(--wk-ink); }

.wk-eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  font-weight: 500; font-size: 12px;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--wk-ink-3); margin: 0;
}
.wk-accent { font-style: italic; font-weight: 400; font-feature-settings: 'ss01' on; }

.wk-success { color: var(--wk-live); font-weight: 600; font-size: 14px; margin: 0; }
.wk-error { color: #9A3B2A; font-weight: 600; font-size: 14px; margin: 0; }

/* Atoms ---------------------------------------------------------------- */
.wk-avatar {
  border-radius: 50%;
  color: var(--wk-cream);
  font-family: inherit; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center;
  flex: none;
  box-shadow: inset 0 0 0 1px rgba(45,26,10,.08), 0 1px 2px rgba(45,26,10,.08);
  overflow: hidden;
  letter-spacing: 0;
}
.wk-avatar img { width: 100%; height: 100%; object-fit: cover; }
.wk-cmp-mark {
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 10px;
  color: #fff;
  font-family: 'Newsreader', serif;
  font-weight: 500; letter-spacing: -0.02em; line-height: 1;
}

.wk-pulsedot {
  position: relative;
  display: inline-flex;
  width: var(--wk-pulse-size); height: var(--wk-pulse-size);
  flex: none;
}
.wk-pulsedot__core, .wk-pulsedot__ring {
  position: absolute; inset: 0; border-radius: 50%;
  background: var(--wk-pulse-color);
}
.wk-pulsedot__core { box-shadow: 0 0 0 2px rgba(255,253,248,.9); }
.wk-pulsedot__ring { animation: wk-pulse 1.8s cubic-bezier(0.22,1,0.36,1) infinite; pointer-events: none; }
@keyframes wk-pulse {
  0%   { transform: scale(1);   opacity: .55; }
  70%  { transform: scale(2.6); opacity: 0; }
  100% { transform: scale(2.6); opacity: 0; }
}

.wk-live-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 11px 5px 9px; border-radius: var(--wk-r-pill);
  background: var(--wk-live-soft); border: 1px solid var(--wk-live-border);
  color: var(--wk-live);
  font-size: 12.5px; font-weight: 600;
  letter-spacing: -0.005em; line-height: 1;
  white-space: nowrap;
}

.wk-hm-card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 18px;
  padding: 20px 22px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
}
.wk-hm-card__body { min-width: 0; }
.wk-hm-card__name {
  font-family: 'Newsreader', serif; font-weight: 400; font-size: 22px;
  line-height: 1.15; letter-spacing: -0.018em;
  color: var(--wk-ink);
}
.wk-hm-card__meta { margin-top: 4px; color: var(--wk-ink-3); font-size: 13.5px; }

/* iMessage thread ------------------------------------------------------- */
.wk-imsg-thread {
  display: flex; flex-direction: column; gap: 3px;
  padding: 14px 14px 18px;
  background: #fff;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
  color: #0B0C0E; font-size: 14.5px; line-height: 1.32;
  transition: opacity 520ms var(--wk-ease);
}
.wk-imsg-thread--fading { opacity: 0; }
.wk-imsg-thread__body {
  display: flex; flex-direction: column; gap: 3px;
  min-height: 340px;
  justify-content: flex-end;
}
.wk-imsg-stamp { text-align: center; font-size: 11px; color: #8E8E93; padding: 6px 0 8px; letter-spacing: -0.01em; }
.wk-imsg-stamp strong { color: #0B0C0E; font-weight: 600; }
.wk-imsg-stamp--right { text-align: right; padding: 4px 6px 0 0; }
.wk-imsg-sender { text-align: center; font-size: 11.5px; color: #8E8E93; padding-bottom: 6px; font-weight: 500; }
.wk-imsg-row { display: flex; margin: 1px 0; animation: wk-bubble-in 320ms var(--wk-ease) both; }
.wk-imsg-row--user { justify-content: flex-end; }
.wk-imsg-row--claire { justify-content: flex-start; }
@keyframes wk-bubble-in {
  from { opacity: 0; transform: translateY(8px) scale(.96); }
  to   { opacity: 1; transform: translateY(0)   scale(1); }
}
.wk-imsg-bubble {
  position: relative; max-width: 78%;
  padding: 8px 13px 9px; border-radius: 19px;
  font-size: 14.5px; line-height: 1.33; letter-spacing: -0.01em;
}
.wk-imsg-bubble--user {
  background: linear-gradient(180deg, var(--wk-imsg-blue-2) 0%, var(--wk-imsg-blue) 100%);
  color: #fff;
}
.wk-imsg-bubble--claire { background: var(--wk-imsg-gray); color: #0B0C0E; }
.wk-imsg-bubble.has-tail::before {
  content: ""; position: absolute; bottom: -1px;
  width: 18px; height: 18px; border-radius: 50%;
}
.wk-imsg-bubble.has-tail::after {
  content: ""; position: absolute; bottom: 0;
  width: 10px; height: 18px; background: #fff; border-radius: 50%;
}
.wk-imsg-bubble--user.has-tail::before  { right: -7px;  background: var(--wk-imsg-blue); }
.wk-imsg-bubble--user.has-tail::after   { right: -10px; }
.wk-imsg-bubble--claire.has-tail::before{ left: -7px;  background: var(--wk-imsg-gray); }
.wk-imsg-bubble--claire.has-tail::after { left: -10px; }
.wk-imsg-typing { padding: 12px 16px; display: inline-flex; gap: 4px; align-items: center; }
.wk-imsg-typing span {
  width: 7px; height: 7px; border-radius: 50%;
  background: #9da0a8; display: inline-block;
  animation: wk-typing 1.2s ease-in-out infinite;
}
.wk-imsg-typing span:nth-child(2) { animation-delay: .15s; }
.wk-imsg-typing span:nth-child(3) { animation-delay: .30s; }
@keyframes wk-typing {
  0%, 60%, 100% { transform: translateY(0);   opacity: .35; }
  30%           { transform: translateY(-3px); opacity: 1; }
}
.wk-imsg-phone {
  position: relative; width: 100%; max-width: 360px;
  background: #fff; border-radius: 38px;
  padding: 12px 0 8px;
  box-shadow:
    0 0 0 1.5px rgba(45,26,10,.12),
    0 30px 80px -30px rgba(45,26,10,.30),
    0 12px 28px -16px rgba(45,26,10,.18);
  overflow: hidden;
}
.wk-imsg-phone__notch {
  position: absolute; top: 7px; left: 50%; transform: translateX(-50%);
  width: 90px; height: 22px; background: #0b0c0e; border-radius: 999px; z-index: 2;
}
.wk-imsg-phone__topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 24px 8px; color: #0b0c0e;
  font-size: 13.5px; font-weight: 600;
  position: relative; z-index: 1;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
}
.wk-imsg-phone__time { letter-spacing: -0.02em; }
.wk-imsg-phone__icons { display: inline-flex; gap: 6px; align-items: center; }
.wk-imsg-phone__header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid #eceef1;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
}
.wk-imsg-phone__name { font-weight: 600; font-size: 15px; color: #0B0C0E; letter-spacing: -0.01em; line-height: 1.2; }
.wk-imsg-phone__sub { font-size: 12px; color: #8E8E93; margin-top: 2px; }

/* Login screen ---------------------------------------------------------- */
.wk-login { padding: 64px 0 96px; min-height: 70vh; background: var(--wk-halo-hero); }
.wk-login__card {
  max-width: 460px; margin: 0 auto;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-lg);
  padding: 36px 32px;
  display: flex; flex-direction: column; gap: 16px;
  box-shadow: 0 8px 24px -8px rgba(45,26,10,.10);
}
.wk-login__h {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: clamp(32px, 4vw, 42px);
  letter-spacing: -0.022em; line-height: 1.05;
  margin: 4px 0 0; color: var(--wk-ink);
}
.wk-login__sub { color: var(--wk-ink-2); font-size: 15px; line-height: 1.5; margin: 0; }
.wk-login-role {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 11px 0;
  border-top: 1px solid var(--wk-border);
  border-bottom: 1px solid var(--wk-border);
}
.wk-login-role__mark {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--wk-peach-200);
  color: var(--wk-ink);
  font-weight: 750;
  font-size: 14px;
  box-shadow: inset 0 0 0 1px rgba(45,26,10,.08);
}
.wk-login-role__body {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.wk-login-role__k {
  color: var(--wk-ink-3);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.wk-login-role__body strong {
  color: var(--wk-ink);
  font-size: 14.5px;
  line-height: 1.2;
  font-weight: 750;
}
.wk-login-role__body em {
  color: var(--wk-ink-3);
  font-style: normal;
  font-size: 12.5px;
  line-height: 1.25;
}
.wk-login-role__link {
  color: var(--wk-ink);
  font-size: 12.5px;
  font-weight: 700;
  text-decoration: none;
  border-bottom: 1px solid rgba(45,26,10,.45);
}
.wk-login-context {
  display: grid;
  gap: 10px;
  padding: 12px 0 4px;
}
.wk-login-context__label {
  color: var(--wk-ink-3);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.wk-login-context__items {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.wk-login-context__item {
  min-width: 0;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 7px;
  align-items: start;
  color: var(--wk-ink-2);
  line-height: 1.2;
}
.wk-login-context__dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--wk-ink);
  color: var(--wk-cream);
  margin-top: 1px;
}
.wk-login-context__item strong {
  display: block;
  color: var(--wk-ink);
  font-size: 12.5px;
  line-height: 1.2;
  font-weight: 750;
}
.wk-login-context__item em {
  display: block;
  margin-top: 3px;
  color: var(--wk-ink-3);
  font-style: normal;
  font-size: 11.5px;
  line-height: 1.28;
}
.wk-login-phone-link {
  display: grid;
  gap: 7px;
  padding: 10px 0 0;
  border-top: 1px solid rgba(201, 182, 158, 0.5);
}
.wk-login-phone-link__trigger {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 42px;
  border-radius: var(--wk-r-pill);
  border: 1px solid var(--wk-border-strong);
  background: rgba(255, 253, 248, 0.52);
  color: var(--wk-ink);
  font: inherit;
  font-weight: 750;
  cursor: pointer;
  transition: background 200ms var(--wk-ease), border-color 200ms var(--wk-ease), transform 200ms var(--wk-ease);
}
.wk-login-phone-link__trigger:hover:not(:disabled) {
  background: var(--wk-cream-3);
  border-color: var(--wk-ink);
  transform: translateY(-1px);
}
.wk-login-phone-link__trigger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.wk-login-phone-link__copy,
.wk-login-phone-link__note {
  margin: 0;
  color: var(--wk-ink-3);
  font-size: 12.5px;
  line-height: 1.35;
}
.wk-login-phone-link__panel {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  background: rgba(255, 253, 248, 0.46);
}
.wk-login-phone-link__form {
  display: grid;
  gap: 10px;
}
.wk-login-phone-link__close {
  justify-self: center;
  border: 0;
  background: transparent;
  color: var(--wk-ink-3);
  font: inherit;
  font-size: 12.5px;
  font-weight: 650;
  padding: 2px 0;
  cursor: pointer;
  border-bottom: 1px solid transparent;
}
.wk-login-phone-link__close:hover {
  color: var(--wk-ink);
  border-bottom-color: var(--wk-ink-4);
}
.wk-login-preview {
  display: grid;
  gap: 10px;
  padding: 14px 0;
  border-top: 1px solid var(--wk-border);
  border-bottom: 1px solid var(--wk-border);
}
.wk-login-preview__k {
  margin: 0;
  color: var(--wk-ink-3);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}
.wk-login-preview__list {
  display: grid;
  gap: 9px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wk-login-preview__item {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 9px;
  align-items: start;
}
.wk-login-preview__icon {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--wk-ink);
  color: var(--wk-cream);
}
.wk-login-preview__item strong {
  display: block;
  color: var(--wk-ink);
  font-size: 13.5px;
  line-height: 1.25;
}
.wk-login-preview__item em {
  display: block;
  margin-top: 2px;
  color: var(--wk-ink-3);
  font-style: normal;
  font-size: 12.5px;
  line-height: 1.35;
}
.wk-login__auth-block { display: grid; gap: 12px; }
.wk-login__providers { display: grid; gap: 10px; margin-top: 8px; }
.wk-login__divider {
  display: flex; align-items: center; gap: 10px;
  color: var(--wk-ink-3); font-size: 12px; margin: 4px 0;
  text-transform: uppercase; letter-spacing: 0.08em;
}
.wk-login__divider::before, .wk-login__divider::after {
  content: ""; flex: 1; height: 1px; background: var(--wk-border);
}
.wk-login__form { display: grid; gap: 12px; }
.wk-login__field { display: grid; gap: 6px; font-size: 13px; font-weight: 500; color: var(--wk-ink-2); }
.wk-login__field input {
  width: 100%;
  font-family: inherit; font-size: 15px;
  color: var(--wk-ink); background: var(--wk-cream);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  padding: 12px 14px;
  transition: border-color 200ms var(--wk-ease);
}
.wk-login__field input:focus {
  outline: none; border-color: var(--wk-ink);
  box-shadow: 0 0 0 3px rgba(45,26,10,.08);
}
.wk-login__fine { color: var(--wk-ink-3); font-size: 13px; margin: 8px 0 0; text-align: center; }
.wk-login-phone-link__auth .wk-login__auth-block { gap: 10px; }
.wk-login-phone-link__auth .wk-login__providers { margin-top: 0; gap: 8px; }
.wk-login-phone-link__auth .wk-login__divider { margin: 0; }
.wk-login-phone-link__auth .wk-login__form { gap: 10px; }

/* Mobile ---------------------------------------------------------------- */
@media (max-width: 820px) {
  .wk-header__inner { gap: 8px; padding: 12px 16px; }
  .wk-nav { display: none; }
  .wk-header__inner > .wk-header__cta { margin-left: auto; }
}
@media (max-width: 480px) {
  .wk-header__inner { padding: 12px; }
  .wk-header__brand-meta { display: none; }
  .wk-header__cta { gap: 0; }
  .wk-header__cta .wk-btn { display: none; }
  .wk-header__signin { display: none; font-size: 13.5px; margin-right: 0; }
  .wk-header__primary {
    display: inline-flex !important;
    height: 32px;
    padding: 0 12px;
    font-size: 13px;
  }
  .wk-header__primary-full { display: none; }
  .wk-header__primary-short { display: inline; }
  .wk-login { padding: 32px 0 72px; }
  .wk-login__card { padding: 28px 32px; gap: 14px; }
  .wk-login__auth-block { order: 3; gap: 10px; }
  .wk-login-phone-link { order: 4; }
  .wk-login-context { order: 5; }
  .wk-login-preview { order: 6; }
  .wk-login__fine { order: 7; }
  .wk-login__card--phone-link { gap: 12px; }
  .wk-login__card--phone-link .wk-login-context { display: none; }
  .wk-login__card--pipeline { padding-top: 24px; padding-bottom: 24px; gap: 12px; }
  .wk-login__h { font-size: clamp(30px, 9vw, 36px); line-height: 1.07; }
  .wk-login__sub { font-size: 14px; line-height: 1.45; }
  .wk-login-role { grid-template-columns: 30px minmax(0, 1fr) auto; gap: 9px; padding: 10px 0; }
  .wk-login-role__mark { width: 30px; height: 30px; font-size: 13px; }
  .wk-login-role__body strong { font-size: 14px; }
  .wk-login-role__body em { font-size: 12px; }
  .wk-login-context { gap: 8px; padding-top: 8px; padding-bottom: 0; }
  .wk-login-context__items {
    display: grid;
    grid-template-columns: 1fr;
    gap: 7px;
  }
  .wk-login-context__item {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    align-items: start;
    gap: 8px;
    min-height: 0;
    padding: 9px 10px;
    border: 1px solid var(--wk-border);
    border-radius: 14px;
    background: var(--wk-cream);
  }
  .wk-login-context__dot { width: 16px; height: 16px; margin-top: 1px; }
  .wk-login-context__dot svg { width: 9px; height: 9px; }
  .wk-login-context__item strong {
    font-size: 12px;
    line-height: 1.15;
    white-space: normal;
  }
  .wk-login-context__item em {
    display: block;
    margin-top: 2px;
    font-size: 11.5px;
    line-height: 1.25;
  }
  .wk-login-phone-link { gap: 6px; padding-top: 8px; }
  .wk-login-phone-link__trigger { min-height: 38px; font-size: 13.5px; }
  .wk-login-phone-link__copy,
  .wk-login-phone-link__note { font-size: 12px; line-height: 1.32; }
  .wk-login-phone-link__panel { gap: 9px; padding: 10px; border-radius: 12px; }
  .wk-login-phone-link__auth .wk-login__auth-block { gap: 8px; }
  .wk-login-phone-link__auth .wk-login__providers { gap: 8px; }
  .wk-login-phone-link__form { gap: 9px; }
  .wk-login__card--pipeline .wk-login-context { gap: 7px; padding-top: 6px; }
  .wk-login__card--pipeline .wk-login-context__items { gap: 6px; }
  .wk-login__card--pipeline .wk-login-context__item { gap: 7px; }
  .wk-login__card--pipeline .wk-login-context__item em { margin-top: 1px; font-size: 11.5px; line-height: 1.22; }
  .wk-login__card--pipeline .wk-login__providers { gap: 8px; margin-top: 0; }
  .wk-login__card--pipeline .wk-login__divider { margin: 0; }
  .wk-login__card--pipeline .wk-login__form { gap: 10px; }
  .wk-login__card--pipeline .wk-login-preview { gap: 7px; padding: 10px 0; }
  .wk-login__card--pipeline .wk-login-preview__list { gap: 7px; }
  .wk-login-preview { gap: 8px; padding: 12px 0; }
  .wk-login-preview__list { gap: 8px; }
  .wk-login__providers { margin-top: 2px; }
}
@media (max-width: 760px) {
  .wk-container, .wk-container--narrow { padding: 0 18px; }
}
@media (prefers-reduced-motion: reduce) {
  .wk-shell *, .wk-shell *::before, .wk-shell *::after {
    animation-duration: .01ms !important;
    transition-duration: .01ms !important;
  }
}
`

// Legacy candidate-* CSS — kept until /me + /me/matches get the wk-* redesign
// pass. Scoped class names so they only affect pages that still reference them.
const LEGACY_CANDIDATE_STYLES = `
.candidate-shell {
  min-height: 100vh;
  padding: 24px;
}
.candidate-header {
  max-width: 980px;
  margin: 0 auto 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.candidate-brand {
  color: #18211a;
  font-weight: 800;
  text-decoration: none;
  letter-spacing: 0;
}
.candidate-header-link,
.candidate-muted-link {
  color: #46624c;
  font-weight: 700;
  text-decoration: none;
}
.candidate-nav,
.candidate-provider-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.candidate-provider-actions {
  display: grid;
  gap: 10px;
  margin-bottom: 14px;
}
.candidate-provider-actions .candidate-primary-link {
  width: 100%;
  font: inherit;
}
.candidate-linkedin-link {
  background: #0a66c2;
  border-color: #0a66c2;
}
.candidate-divider {
  color: #7a6f5d;
  font-size: 13px;
  font-weight: 800;
  text-align: center;
}
.candidate-panel {
  max-width: 520px;
  margin: 0 auto;
  background: #fffdf8;
  border: 1px solid #ddd3c2;
  border-radius: 8px;
  padding: 24px;
}
.candidate-panel h1 {
  margin: 0 0 18px;
  font-size: 28px;
  line-height: 1.15;
  letter-spacing: 0;
}
.candidate-kicker {
  margin: 0 0 8px;
  color: #63705d;
  font-size: 13px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0;
}
.candidate-form {
  display: grid;
  gap: 14px;
}
.candidate-form label {
  display: grid;
  gap: 6px;
  color: #364233;
  font-weight: 700;
}
.candidate-form input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #cfc3ae;
  border-radius: 8px;
  padding: 12px;
  font: inherit;
  background: #fff;
  color: #18211a;
}
.candidate-form button,
.candidate-primary-link,
.candidate-secondary-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  min-height: 42px;
  padding: 0 16px;
  border-radius: 8px;
  border: 1px solid #2f6f4f;
  background: #2f6f4f;
  color: #fffdf8;
  font-weight: 800;
  text-decoration: none;
  cursor: pointer;
}
.candidate-form button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.candidate-secondary-button {
  background: #fffdf8;
  color: #2f6f4f;
}
.candidate-success {
  color: #16643b;
  font-weight: 800;
}
.candidate-error {
  color: #9c2b24;
  font-weight: 800;
}
.candidate-profile-list {
  display: grid;
  gap: 1px;
  margin: 0 0 18px;
  background: #e5dccd;
  border: 1px solid #e5dccd;
  border-radius: 8px;
  overflow: hidden;
}
.candidate-profile-list div {
  display: grid;
  grid-template-columns: minmax(120px, 0.38fr) 1fr;
  gap: 12px;
  padding: 12px;
  background: #fffdf8;
}
.candidate-profile-list dt {
  color: #63705d;
  font-weight: 800;
}
.candidate-profile-list dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.candidate-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.candidate-summary {
  color: #364233;
  line-height: 1.55;
}
.candidate-tag-groups {
  display: grid;
  gap: 16px;
}
.candidate-tag-group h2 {
  margin: 0 0 8px;
  font-size: 15px;
  letter-spacing: 0;
}
.candidate-tag-group div {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.candidate-tag-group span {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  background: #edf5ee;
  color: #24543c;
  font-size: 13px;
  font-weight: 800;
}
@media (max-width: 560px) {
  .candidate-shell { padding: 16px; }
  .candidate-panel { padding: 18px; }
  .candidate-profile-list div { grid-template-columns: 1fr; gap: 4px; }
}
`

// ────────────────────────────────────────────────────────────────────────────
// Signed-in app shell — sticky app bar for the candidate operating home.
// Used by CandidateMe + CandidateProfile (the /me and /me/profile surfaces).
// ────────────────────────────────────────────────────────────────────────────

const APP_SHELL_STYLES = `
.wk-shell--app { background: var(--wk-cream); }
.wk-shell--app .wk-main { padding-top: 0; }
.wk-appbar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(245, 237, 227, 0.82);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  backdrop-filter: blur(14px) saturate(160%);
  border-bottom: 1px solid var(--wk-border);
}
.wk-appbar__inner {
  max-width: 1240px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 32px;
  padding: 14px 28px;
}
.wk-appnav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 22px;
}
.wk-appnav .wk-nav__link {
  font-size: 14px;
  font-weight: 500;
  color: var(--wk-ink-2);
  height: 32px;
  padding: 0 10px;
  border-radius: var(--wk-r-sm);
  transition: color 180ms var(--wk-ease), background 180ms var(--wk-ease);
}
.wk-appnav .wk-nav__link:hover { color: var(--wk-ink); background: var(--wk-cream-3); }
.wk-appnav .wk-nav__link.is-active {
  color: var(--wk-ink);
  font-weight: 600;
  background: var(--wk-cream-3);
}
.wk-appbar__right { display: inline-flex; align-items: center; gap: 10px; }
.wk-appbar__icon {
  appearance: none;
  position: relative;
  width: 36px; height: 36px;
  border-radius: 50%;
  background: transparent;
  border: 1px solid transparent;
  color: var(--wk-ink-2);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: background 180ms var(--wk-ease), color 180ms var(--wk-ease);
}
.wk-appbar__icon:hover { background: var(--wk-cream-3); color: var(--wk-ink); }
.wk-appbar__dot {
  position: absolute;
  top: 8px; right: 8px;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--wk-live-pulse);
  border: 1.5px solid var(--wk-cream);
}
.wk-appbar__user {
  appearance: none;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  border-radius: 50%;
  outline-offset: 2px;
}
.wk-appbar__user:hover { opacity: 0.86; }
@media (max-width: 760px) {
  .wk-appnav { display: none; }
  .wk-appbar__inner { gap: 16px; padding: 12px 16px; }
}

/* ─── v3 left navigation rail (overrides the legacy top app bar above) ───── */
/* Alias the design-bundle's unprefixed tokens onto the production --wk-* set,
   so the ported v3 CSS below (and the /me page styles) read verbatim. */
.wk-shell--app {
  --cream: var(--wk-cream); --cream-2: var(--wk-cream-2); --cream-3: var(--wk-cream-3);
  --ink: var(--wk-ink); --ink-2: var(--wk-ink-2); --ink-3: var(--wk-ink-3); --ink-4: var(--wk-ink-4);
  --border: var(--wk-border); --border-strong: var(--wk-border-strong);
  --peach-50: var(--wk-peach-50); --peach-100: var(--wk-peach-100);
  --peach-200: var(--wk-peach-200); --peach-300: var(--wk-peach-300);
  --live: var(--wk-live); --live-2: var(--wk-live-2); --live-soft: var(--wk-live-soft);
  --live-border: var(--wk-live-border); --live-pulse: var(--wk-live-pulse);
  --r-sm: var(--wk-r-sm); --r-md: var(--wk-r-md); --r-lg: var(--wk-r-lg); --r-pill: var(--wk-r-pill);
  --ease: var(--wk-ease); --dur-fast: 200ms; --dur-base: 240ms;
  --success: #3a8a5a; --success-bg: rgba(58,138,90,.12); --danger: #b3402e;
  --candidate-card: var(--wk-cream-3); --candidate-card-hover: #FFF8EB; --candidate-page: var(--wk-cream);
  --font-serif: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  --font-sans: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --z-sticky: 50;

  display: grid;
  grid-template-columns: 232px 1fr;
  min-height: 100vh;
  background: var(--cream);
}
.wk-shell--app .wk-main { padding-top: 0; min-width: 0; }
.wk-shell--app .wk-appbar { display: none; }

.wk-apptopbar { display: none; }

.wk-sidenav {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--cream-3);
  border-right: 1px solid var(--border);
  padding: 18px 12px 14px;
  gap: 14px;
  z-index: var(--z-sticky);
}
.wk-sidenav__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 12px;
  border-bottom: 1px solid var(--border);
}
.wk-sidenav__brand { display: inline-flex; align-items: center; text-decoration: none; color: var(--ink); }
.wk-sidenav__close {
  display: none;
  appearance: none; border: 0; background: transparent;
  color: var(--ink-2); padding: 4px; border-radius: var(--r-sm); cursor: pointer;
}
.wk-sidenav__nav {
  display: grid; gap: 2px; align-content: start;
  flex: 1; min-height: 0; overflow-y: auto;
}
.wk-sidenav__link {
  display: grid;
  grid-template-columns: 24px 1fr;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--r-sm);
  color: var(--ink-2);
  font-size: 13.5px;
  font-weight: 500;
  text-decoration: none;
  letter-spacing: -0.005em;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.wk-sidenav__link:hover { background: rgba(45, 26, 10, 0.05); color: var(--ink); }
.wk-sidenav__link.is-active { background: var(--ink); color: var(--cream); }
.wk-sidenav__link.is-active .wk-sidenav__ico { color: var(--cream); }
.wk-sidenav__ico {
  width: 24px; height: 24px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ink-3);
}
.wk-sidenav__link:hover .wk-sidenav__ico { color: var(--ink); }
.wk-sidenav__lbl { min-width: 0; }
.wk-sidenav__bottom {
  display: grid; gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.wk-sidenav__claire {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  background: var(--cream);
  border: 1px solid var(--live-border);
  border-radius: var(--r-sm);
  text-decoration: none;
  color: var(--ink);
  transition: border-color var(--dur-fast) var(--ease);
}
.wk-sidenav__claire:hover { border-color: var(--live); }
.wk-sidenav__claire.is-pending {
  border-color: var(--border);
  background: var(--cream-2);
  color: var(--ink);
  cursor: pointer;
}
.wk-sidenav__claire.is-pending:hover { border-color: var(--live-border); }
.wk-sidenav__claire-dot {
  width: 22px; height: 22px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--live-soft); border: 1px solid var(--live-border);
}
.wk-sidenav__claire-body { min-width: 0; display: grid; gap: 1px; }
.wk-sidenav__claire-body strong { font-size: 12.5px; font-weight: 600; color: var(--ink); letter-spacing: -0.005em; }
.wk-sidenav__claire-body em { font-style: normal; font-size: 11px; color: var(--ink-3); }
.wk-sidenav__account { position: relative; }
.wk-sidenav__user {
  appearance: none; border: 0; background: transparent;
  display: grid; grid-template-columns: auto 1fr auto;
  gap: 10px; align-items: center;
  padding: 8px 10px; border-radius: var(--r-sm);
  cursor: pointer; width: 100%; text-align: left;
  font: inherit; color: var(--ink);
  transition: background var(--dur-fast) var(--ease);
}
.wk-sidenav__user:hover { background: rgba(45,26,10,.05); }
.wk-sidenav__user-name { display: grid; gap: 1px; min-width: 0; }
.wk-sidenav__user-name strong {
  font-size: 12.5px; font-weight: 600; color: var(--ink); letter-spacing: -0.005em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wk-sidenav__user-name em {
  font-style: normal; font-size: 11px; color: var(--ink-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wk-sidenav__user svg { color: var(--ink-3); }
.wk-sidenav__menu-scrim { position: fixed; inset: 0; z-index: 60; }
.wk-sidenav__menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0; right: 0;
  z-index: 61;
  background: var(--cream-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  box-shadow: 0 12px 28px -12px rgba(45,26,10,.34);
  padding: 6px;
  display: grid;
  gap: 2px;
}
.wk-sidenav__menu-item {
  appearance: none; border: 0; background: transparent;
  width: 100%; text-align: left;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 10px; border-radius: var(--r-sm);
  font: inherit; font-size: 13px; font-weight: 500;
  color: var(--ink-2); cursor: pointer; text-decoration: none;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.wk-sidenav__menu-item:hover { background: rgba(45,26,10,.06); color: var(--ink); }
.wk-sidenav__menu-item svg { color: var(--ink-3); flex: none; }
.wk-sidenav__scrim {
  display: none;
  position: fixed; inset: 0;
  background: rgba(45,26,10,.45);
  -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
  z-index: 40;
}

@media (max-width: 900px) {
  .wk-shell--app { grid-template-columns: 1fr; }
  .wk-apptopbar {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 14px;
    padding: 12px 16px;
    background: rgba(245,237,227,.92);
    -webkit-backdrop-filter: blur(12px) saturate(160%);
    backdrop-filter: blur(12px) saturate(160%);
    border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 30;
  }
  .wk-apptopbar__menu {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--cream-3);
    color: var(--ink);
    padding: 6px 10px;
    border-radius: var(--r-sm);
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .wk-apptopbar__brand { justify-self: center; color: var(--ink); display: inline-flex; }
  .wk-apptopbar__claire {
    width: 36px; height: 36px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 50%;
    background: var(--live-soft); border: 1px solid var(--live-border);
    color: var(--live);
  }
  .wk-apptopbar__claire.is-pending {
    background: var(--cream-2);
    border-color: var(--border);
    color: var(--ink-3);
  }
  .wk-sidenav {
    position: fixed; top: 0; left: 0;
    width: 280px;
    transform: translateX(-100%);
    transition: transform var(--dur-base) cubic-bezier(.2,.7,.1,1);
    z-index: 50;
    box-shadow: 12px 0 32px -16px rgba(45,26,10,.28);
  }
  .wk-shell--app.is-drawer-open .wk-sidenav { transform: translateX(0); }
  .wk-shell--app.is-drawer-open .wk-sidenav__scrim { display: block; }
  .wk-sidenav__close { display: inline-flex; }
}
`
