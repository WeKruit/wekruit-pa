import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import {
  GoogleAuthProvider,
  getRedirectResult,
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithCustomToken,
  signInWithEmailLink,
  signInWithRedirect,
} from "firebase/auth"
import { auth } from "../lib/firebase.js"

const EMAIL_STORAGE_KEY = "wkr_claim_email"
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

export default function CandidateLogin() {
  const navigate = useNavigate()
  const isCompletingLink = useMemo(() => isSignInWithEmailLink(auth(), window.location.href), [])
  const nextPath = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get("next")
    return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/me"
  }, [])
  const [email, setEmail] = useState(() => window.localStorage.getItem(EMAIL_STORAGE_KEY) ?? "")
  const [status, setStatus] = useState<
    "idle" | "google" | "linkedin" | "sending" | "sent" | "signing_in" | "error"
  >(
    isCompletingLink ? "signing_in" : "idle"
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isCompletingLink) return
    let cancelled = false
    void (async () => {
      try {
        const linkedinPayload = takeLinkedinAuthPayload()
        if (linkedinPayload?.ok) {
          await signInWithCustomToken(auth(), linkedinPayload.customToken)
          if (!cancelled) navigate(nextPath, { replace: true })
          return
        }
        if (linkedinPayload && !linkedinPayload.ok) {
          throw new Error(linkedinPayload.error)
        }
        const result = await getRedirectResult(auth())
        if (!cancelled && result?.user) {
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

  async function startProviderSignIn(kind: "google" | "linkedin") {
    setStatus(kind)
    setError(null)
    if (kind === "linkedin") {
      const returnTo = `${window.location.origin}${nextPath}`
      window.location.assign(`${LINKEDIN_AUTH_START_URL}?returnTo=${encodeURIComponent(returnTo)}`)
      return
    }
    const provider = createGoogleProvider()
    try {
      await signInWithRedirect(auth(), provider)
    } catch (err) {
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
        navigate(nextPath, { replace: true })
        return
      }
      setStatus("sending")
      await sendSignInLinkToEmail(auth(), nextEmail, {
        url: `${window.location.origin}/login?next=${encodeURIComponent(nextPath)}`,
        handleCodeInApp: true,
      })
      window.localStorage.setItem(EMAIL_STORAGE_KEY, nextEmail)
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
          <div className="candidate-provider-actions">
            <button
              type="button"
              className="candidate-primary-link"
              onClick={() => void startProviderSignIn("google")}
              disabled={status === "google" || status === "linkedin" || status === "sending" || status === "signing_in"}
            >
              {status === "google" ? "Opening Google" : "Continue with Google"}
            </button>
            <button
              type="button"
              className="candidate-primary-link candidate-linkedin-link"
              onClick={() => void startProviderSignIn("linkedin")}
              disabled={status === "google" || status === "linkedin" || status === "sending" || status === "signing_in"}
            >
              {status === "linkedin" ? "Opening LinkedIn" : "Continue with LinkedIn"}
            </button>
            <div className="candidate-divider">or</div>
          </div>
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
          <p className="candidate-success">Magic link sent to {cleanEmail(email)}.</p>
        ) : null}
        {error ? <p className="candidate-error">{error}</p> : null}
        <Link className="candidate-muted-link" to="/">Back to WeKruit</Link>
      </main>
    </CandidateShell>
  )
}

export function CandidateShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="candidate-shell">
      <style>{CANDIDATE_STYLES}</style>
      <header className="candidate-header">
        <Link to="/" className="candidate-brand">WeKruit</Link>
        <nav className="candidate-nav" aria-label="Candidate navigation">
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
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Arial, sans-serif;
  background: #f6f2ea;
  color: #18211a;
}
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
  .candidate-shell { padding: 16px; }
  .candidate-panel { padding: 18px; }
  .candidate-profile-list div { grid-template-columns: 1fr; gap: 4px; }
}
`
