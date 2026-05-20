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
import { Link, useNavigate } from "react-router-dom"
import {
  GoogleAuthProvider,
  getRedirectResult,
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithCustomToken,
  signInWithEmailLink,
  signInWithRedirect,
  onAuthStateChanged,
} from "firebase/auth"
import { auth } from "../lib/firebase.js"
import {
  CLAIM_EMAIL_KEY,
  isCandidateHost,
  parseLoginNextPath,
  redirectToCandidatePortal,
  readStoredValue,
  rememberStoredValue,
  resolvePostLoginDestination,
} from "../lib/browser-identity"
import { peekSource, type SignupSource } from "../lib/source.js"
import { verifyCandidateMagicLinkSession } from "../lib/candidate-verify.js"

const EMAIL_STORAGE_KEY = CLAIM_EMAIL_KEY
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
          <div className="wk-imsg-phone__name">Claire</div>
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
}: {
  children: ReactNode
  hero?: boolean
  signedIn?: boolean
  signedInUser?: { name?: string; src?: string }
}) {
  if (signedIn) {
    return (
      <div className="wk-shell wk-shell--app">
        <style>{CANDIDATE_STYLES}</style>
        <style>{APP_SHELL_STYLES}</style>
        <header className="wk-appbar">
          <div className="wk-appbar__inner">
            <Link to="/me" className="wk-header__brand" aria-label="WeKruit home">
              <WekruitLogo size={22} />
            </Link>
            <nav className="wk-appnav" aria-label="App navigation">
              <AppNavLink to="/me">Pipeline</AppNavLink>
              <AppNavLink to="/me/profile">Profile</AppNavLink>
              <AppNavLink to="/market">Market</AppNavLink>
            </nav>
            <div className="wk-appbar__right">
              <button type="button" className="wk-appbar__icon" aria-label="Notifications">
                <Icon name="message" size={18} stroke={1.7} />
                <span className="wk-appbar__dot" />
              </button>
              <button type="button" className="wk-appbar__user" aria-label="Account menu">
                <Avatar name={signedInUser?.name ?? "You"} src={signedInUser?.src} size={32} tone="warm" />
              </button>
            </div>
          </div>
        </header>
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
            <span className="wk-header__brand-meta">Open</span>
          </Link>
          <nav className="wk-nav" aria-label="Candidate navigation">
            <Link to="/" className="wk-nav__link">Open interviews</Link>
            <Link to="/market" className="wk-nav__link">Open market</Link>
            <Link to="/me" className="wk-nav__link">Pipeline</Link>
            <Link to="/me/profile" className="wk-nav__link">Profile</Link>
          </nav>
          <div className="wk-header__cta">
            <Link to="/login" className="wk-header__signin">Sign in</Link>
            <Link to="/login" className="wk-btn wk-btn--ink wk-btn--sm">Start with Claire</Link>
          </div>
        </div>
      </header>
      <main className="wk-main">{children}</main>
      <footer className="wk-footer">
        <div className="wk-footer__inner">
          <div className="wk-footer__brand">
            <WekruitLogo size={20} />
            <span className="wk-footer__tag">Candidate retention marketplace.</span>
          </div>
          <nav className="wk-footer__nav">
            <a href="https://wekruit.com">For employers</a>
            <Link to="/legal">Privacy</Link>
            <Link to="/legal">Terms</Link>
            <a href="mailto:claire@wekruit.com">claire@wekruit.com</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}

// Sticky-aware nav link for the signed-in app bar. Pathname match so
// /me/profile lights "Profile" without also lighting "Pipeline".
function AppNavLink({ to, children }: { to: string; children: ReactNode }) {
  const here = typeof window !== "undefined" ? window.location.pathname : "/"
  const active =
    here === to ||
    (to === "/me" && here === "/me") ||
    (to !== "/me" && to !== "/" && (here === to || here.startsWith(to + "/")))
  return (
    <Link to={to} className={`wk-nav__link${active ? " is-active" : ""}`}>
      {children}
    </Link>
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

export default function CandidateLogin() {
  const navigate = useNavigate()
  const isCompletingLink = useMemo(() => isSignInWithEmailLink(auth(), window.location.href), [])
  const nextDest = useMemo(
    () => parseLoginNextPath(new URLSearchParams(window.location.search).get("next")),
    [],
  )
  const [email, setEmail] = useState(() => readStoredValue(EMAIL_STORAGE_KEY) ?? "")
  const [status, setStatus] = useState<
    "idle" | "google" | "linkedin" | "sending" | "sent" | "signing_in" | "error"
  >(isCompletingLink ? "signing_in" : "idle")
  const [error, setError] = useState<string | null>(null)
  const finishInFlight = useRef(false)

  const finishSignedIn = useCallback(async () => {
    if (finishInFlight.current) return
    finishInFlight.current = true
    setStatus("signing_in")
    setError(null)
    try {
      const verifySource = signupSourceForLoginNext(nextDest)
      const verified = await verifyCandidateMagicLinkSession(
        verifySource ? { source: verifySource } : undefined,
      )
      const destination = resolvePostLoginDestination(
        nextDest,
        verified.portalReady,
        verifySource,
      )
      if (!isCandidateHost()) {
        redirectToCandidatePortal(destination)
        return
      }
      const dest = parseLoginNextPath(destination)
      navigate({ pathname: dest.pathname, search: dest.search }, { replace: true })
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      finishInFlight.current = false
    }
  }, [navigate, nextDest])

  useEffect(() => {
    if (isCompletingLink) return
    let cancelled = false
    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      if (!cancelled && user) void finishSignedIn()
    })
    void (async () => {
      try {
        const linkedinPayload = takeLinkedinAuthPayload()
        if (linkedinPayload?.ok) {
          await signInWithCustomToken(auth(), linkedinPayload.customToken)
          if (!cancelled) await finishSignedIn()
          return
        }
        if (linkedinPayload && !linkedinPayload.ok) throw new Error(linkedinPayload.error)
        const result = await getRedirectResult(auth())
        if (!cancelled && result?.user) await finishSignedIn()
      } catch (err) {
        if (!cancelled) {
          setStatus("error")
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
      unsubscribe()
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
    setStatus(kind); setError(null)
    if (kind === "linkedin") {
      const returnTo = `${window.location.origin}/login?next=${encodeURIComponent(nextDest.to)}`
      window.location.assign(`${LINKEDIN_AUTH_START_URL}?returnTo=${encodeURIComponent(returnTo)}`)
      return
    }
    await signInWithRedirect(auth(), createGoogleProvider())
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

  const busy = status === "google" || status === "linkedin" || status === "sending" || status === "signing_in"

  return (
    <CandidateShell>
      <div className="wk-login">
        <div className="wk-container">
          <div className="wk-login__card">
            <p className="wk-eyebrow">
              {isCompletingLink ? "Finishing sign-in" : "Pick up where you left off"}
            </p>
            <h1 className="wk-login__h">
              {isCompletingLink
                ? <>Finishing <em className="wk-accent">sign-in.</em></>
                : <>Already talked to <em className="wk-accent">Claire?</em></>}
            </h1>
            <p className="wk-login__sub">
              {isCompletingLink
                ? "One sec — confirming your email and pulling up your pipeline."
                : "Sign in and we'll pull up your active pipeline. Magic-link, Google, or LinkedIn — your choice."}
            </p>

            {!isCompletingLink ? (
              <>
                <div className="wk-login__providers">
                  <button
                    type="button"
                    className="wk-btn wk-btn--ink wk-btn--block"
                    onClick={() => void startProviderSignIn("google")}
                    disabled={busy}
                  >
                    {status === "google" ? "Opening Google…" : "Continue with Google"}
                  </button>
                  <button
                    type="button"
                    className="wk-btn wk-btn--linkedin wk-btn--block"
                    onClick={() => void startProviderSignIn("linkedin")}
                    disabled={busy}
                  >
                    {status === "linkedin" ? "Opening LinkedIn…" : "Continue with LinkedIn"}
                  </button>
                </div>
                <div className="wk-login__divider"><span>or magic link</span></div>
              </>
            ) : null}

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
                {isCompletingLink
                  ? (status === "signing_in" ? "Signing in…" : "Continue")
                  : (status === "sending" ? "Sending…" : "Send magic link")}
                {!busy ? <Icon name="arrow-right" size={16} stroke={2} /> : null}
              </button>
            </form>

            {status === "sent" ? (
              <p className="wk-success">Magic link sent to {cleanEmail(email)}.</p>
            ) : null}
            {error ? <p className="wk-error">{error}</p> : null}

            <p className="wk-login__fine">
              First time? <Link to="/" className="wk-link">Start with Claire</Link> — same flow.
            </p>
          </div>
        </div>
      </div>
    </CandidateShell>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Styles — global candidate visual system + login screen
// ────────────────────────────────────────────────────────────────────────────

const CANDIDATE_STYLES = `
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
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 24px;
  padding: 14px 24px;
}
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

/* Mobile ---------------------------------------------------------------- */
@media (max-width: 820px) {
  .wk-header__inner { gap: 8px; padding: 12px 16px; }
  .wk-nav { display: none; }
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
// Signed-in app shell — sticky app bar with Pipeline · Profile · Market.
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
`
