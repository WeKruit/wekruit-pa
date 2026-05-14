import { useEffect, useMemo, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  getRedirectResult,
  isSignInWithEmailLink,
  OAuthProvider,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signInWithPopup,
  signInWithRedirect,
} from "firebase/auth"
import { auth } from "../lib/firebase.js"

const EMAIL_STORAGE_KEY = "wkr_claim_email"
const NEXT_STORAGE_KEY = "wkr_claim_next"
const LINKEDIN_PROVIDER_ID = import.meta.env.VITE_LINKEDIN_PROVIDER_ID ?? "oidc.linkedin"

function cleanEmail(value: string): string {
  return value.trim().toLowerCase()
}

function cleanNextPath(value: string | null): string {
  if (!value) return "/me"
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("://")) return "/me"
  return value
}

function createLinkedInProvider(): OAuthProvider {
  const provider = new OAuthProvider(LINKEDIN_PROVIDER_ID)
  provider.addScope("openid")
  provider.addScope("profile")
  provider.addScope("email")
  return provider
}

export default function CandidateLogin() {
  const navigate = useNavigate()
  const location = useLocation()
  const isCompletingLink = useMemo(() => isSignInWithEmailLink(auth(), window.location.href), [])
  const nextPath = useMemo(
    () => cleanNextPath(new URLSearchParams(location.search).get("next") ?? window.localStorage.getItem(NEXT_STORAGE_KEY)),
    [location.search]
  )
  const [email, setEmail] = useState(() => window.localStorage.getItem(EMAIL_STORAGE_KEY) ?? "")
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "signing_in" | "error">(
    isCompletingLink ? "signing_in" : "idle"
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isCompletingLink) return
    let cancelled = false
    void (async () => {
      try {
        const result = await getRedirectResult(auth())
        if (result?.user && !cancelled) {
          window.localStorage.removeItem(NEXT_STORAGE_KEY)
          navigate(nextPath, { replace: true })
        }
      } catch (err) {
        if (!cancelled) {
          setStatus("error")
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isCompletingLink, navigate, nextPath])

  useEffect(() => {
    if (!isCompletingLink) return
    const stored = cleanEmail(window.localStorage.getItem(EMAIL_STORAGE_KEY) ?? "")
    if (!stored) {
      setStatus("idle")
      return
    }
    let cancelled = false
    void (async () => {
      try {
        await signInWithEmailLink(auth(), stored, window.location.href)
        window.localStorage.removeItem(EMAIL_STORAGE_KEY)
        window.localStorage.removeItem(NEXT_STORAGE_KEY)
        if (!cancelled) navigate(nextPath, { replace: true })
      } catch (err) {
        if (!cancelled) {
          setStatus("error")
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isCompletingLink, navigate, nextPath])

  async function onLinkedInSignIn() {
    setError(null)
    setStatus("signing_in")
    window.localStorage.setItem(NEXT_STORAGE_KEY, nextPath)
    try {
      await signInWithPopup(auth(), createLinkedInProvider())
      window.localStorage.removeItem(NEXT_STORAGE_KEY)
      navigate(nextPath, { replace: true })
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : ""
      if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
        await signInWithRedirect(auth(), createLinkedInProvider())
        return
      }
      setStatus("error")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const nextEmail = cleanEmail(email)
    if (!nextEmail) return
    setError(null)
    try {
      if (isCompletingLink) {
        setStatus("signing_in")
        await signInWithEmailLink(auth(), nextEmail, window.location.href)
        window.localStorage.removeItem(EMAIL_STORAGE_KEY)
        window.localStorage.removeItem(NEXT_STORAGE_KEY)
        navigate(nextPath, { replace: true })
        return
      }
      setStatus("sending")
      await sendSignInLinkToEmail(auth(), nextEmail, {
        url: `${window.location.origin}/login?next=${encodeURIComponent(nextPath)}`,
        handleCodeInApp: true,
      })
      window.localStorage.setItem(EMAIL_STORAGE_KEY, nextEmail)
      window.localStorage.setItem(NEXT_STORAGE_KEY, nextPath)
      setStatus("sent")
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <CandidateShell>
      <main className="candidate-panel">
        <p className="candidate-kicker">Candidate profile</p>
        <h1>{isCompletingLink ? "Finish sign in" : "Sign in"}</h1>
        {!isCompletingLink ? (
          <>
            <button
              className="candidate-linkedin-button"
              type="button"
              disabled={status === "sending" || status === "signing_in"}
              onClick={() => void onLinkedInSignIn()}
            >
              {status === "signing_in" ? "Opening LinkedIn" : "Continue with LinkedIn"}
            </button>
            <div className="candidate-login-divider">or</div>
          </>
        ) : null}
        <form onSubmit={onSubmit} className="candidate-form">
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={status === "sending" || status === "signing_in"}
            />
          </label>
          <button type="submit" disabled={status === "sending" || status === "signing_in"}>
            {isCompletingLink
              ? status === "signing_in"
                ? "Signing in"
                : "Continue"
              : status === "sending"
                ? "Sending"
                : "Send link"}
          </button>
        </form>
        {status === "sent" ? (
          <p className="candidate-success">Magic link sent to {cleanEmail(email)}. It will bring you back to continue.</p>
        ) : null}
        {error ? <p className="candidate-error">{error}</p> : null}
        <Link className="candidate-muted-link" to={nextPath === "/me" ? "/" : nextPath}>Back to WeKruit</Link>
      </main>
    </CandidateShell>
  )
}

export function CandidateShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="candidate-shell">
      <style>{CANDIDATE_STYLES}</style>
      <header className={wide ? "candidate-header candidate-header-wide" : "candidate-header"}>
        <Link to="/" className="candidate-brand">WeKruit</Link>
        <nav className="candidate-header-nav" aria-label="Candidate navigation">
          <Link to="/" className="candidate-header-link">Jobs</Link>
          <Link to="/me/matches" className="candidate-header-link">Matches</Link>
          <Link to="/me" className="candidate-header-link">Profile</Link>
        </nav>
      </header>
      {children}
    </div>
  )
}

const CANDIDATE_STYLES = `
* {
  box-sizing: border-box;
}
html {
  background: #f6f2ea;
}
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Arial, sans-serif;
  background: #f6f2ea;
  color: #18211a;
}
.candidate-shell {
  min-height: 100vh;
  padding: 24px;
}
.candidate-header {
  max-width: 760px;
  margin: 0 auto 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.candidate-header-wide {
  max-width: 1040px;
}
.candidate-brand {
  color: #18211a;
  font-weight: 800;
  text-decoration: none;
  letter-spacing: 0;
}
.candidate-header-nav {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  flex-wrap: wrap;
}
.candidate-header-link,
.candidate-muted-link {
  color: #46624c;
  font-weight: 700;
  text-decoration: none;
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
.candidate-linkedin-button {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  margin-bottom: 14px;
  padding: 0 16px;
  border: 1px solid #0a66c2;
  border-radius: 8px;
  background: #0a66c2;
  color: #fff;
  font: inherit;
  font-weight: 850;
  cursor: pointer;
}
.candidate-linkedin-button:disabled {
  opacity: 0.6;
  cursor: wait;
}
.candidate-login-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 14px;
  color: #63705d;
  font-size: 13px;
  font-weight: 800;
  text-transform: uppercase;
}
.candidate-login-divider::before,
.candidate-login-divider::after {
  content: "";
  height: 1px;
  flex: 1;
  background: #ddd3c2;
}
.candidate-form label {
  display: grid;
  gap: 6px;
  color: #364233;
  font-weight: 700;
}
.candidate-form input {
  width: 100%;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
  .candidate-shell { padding: 18px; }
  .candidate-header {
    align-items: flex-start;
    flex-direction: column;
    margin-bottom: 22px;
  }
  .candidate-header-nav {
    justify-content: flex-start;
    gap: 14px;
  }
  .candidate-panel { padding: 18px; }
  .candidate-profile-list div { grid-template-columns: 1fr; gap: 4px; }
}
`
