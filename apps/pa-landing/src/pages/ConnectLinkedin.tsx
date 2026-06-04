/**
 * ConnectLinkedin — candidate-domain LinkedIn one-tap connect page.
 *
 * Route: /connect-linkedin?token=<t>  (candidate.wekruit.com ONLY — never admin).
 *
 * Flow:
 *   1. Claire (thin) texts the candidate this link. The page reads `?token=`
 *      (the single-use connect token bound to the candidate server-side).
 *   2. MVP: the candidate confirms/pastes their LinkedIn profile URL + taps
 *      Connect. The page POSTs {token, linkedinUrl} to the same-origin
 *      `/_li/connect` rewrite (paLinkedinConnectSubmit).
 *   3. The CF links the handle, enriches by URL (CoreSignal → experienceHighlights
 *      + tags), emits the thin-pitch runtime event, and returns an `sms:` reroute.
 *   4. On `{ ok, smsDeepLink }`, the page sets `window.location.href = smsDeepLink`
 *      so the candidate is dropped back into their iMessage thread with the body
 *      "I've done LinkedIn submission <token>" prefilled — they tap Send and the
 *      thin pitch fires.
 *
 * UPGRADE (flag-gated): when `VITE_LINKEDIN_OAUTH_ENABLED` is set, also render a
 * "Sign in with LinkedIn" button. Absent → URL-submit is the sole flow (the MVP
 * works with ONLY the CoreSignal key; OAuth needs the LinkedIn app secret + a
 * token-scoped connect mode that is out of scope for this branch).
 *
 * Never 500s the candidate — every error path falls back to the URL form.
 */
import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"

// Same-origin Hosting rewrite → paLinkedinConnectSubmit (see firebase.json).
const CONNECT_SUBMIT_URL = "/_li/connect"

// One-tap "Login with LinkedIn" (Adam 2026-06-03): the page redirects STRAIGHT to LinkedIn's OAuth
// login, carrying the connect token, then routes back to the iMessage thread. The URL-paste form
// below is the FALLBACK ("use your LinkedIn URL instead") for full work-history depth via Coresignal.
const LINKEDIN_AUTH_START_URL =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_LINKEDIN_AUTH_START_URL ??
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paLinkedinAuthStart"
// where LinkedIn returns to (allow-listed in linkedin-auth.ts); the apex serves this same SPA.
const CONNECT_RETURN_TO = "https://wekruit.com/connect-linkedin"

interface ConnectSubmitResult {
  ok: boolean
  reason?: string
  enriched?: boolean
  smsDeepLink?: string
}

function looksLikeLinkedinUrl(value: string): boolean {
  const t = value.trim().toLowerCase()
  return t.includes("linkedin.com/in/") || t.includes("linkedin.com/pub/")
}

export default function ConnectLinkedin() {
  const [searchParams] = useSearchParams()
  const token = useMemo(() => (searchParams.get("token") ?? "").trim(), [searchParams])
  const [linkedinUrl, setLinkedinUrl] = useState("")
  const [status, setStatus] = useState<"idle" | "submitting" | "ok" | "review" | "err">("idle")
  const [errMsg, setErrMsg] = useState<string | null>(null)
  // ONE-TAP "Login with LinkedIn": when false (default) the page bounces straight to LinkedIn's OAuth
  // login; the candidate can switch to the URL-paste fallback ("use your LinkedIn URL instead").
  const [useUrlFallback, setUseUrlFallback] = useState(false)

  const tokenMissing = !token

  // As soon as we have a token, redirect to LinkedIn's OAuth login (full-page, mobile-friendly — no
  // popup) carrying the connect token. The callback binds the verified identity + routes back to the
  // iMessage thread. Skipped when the candidate explicitly chose the URL-paste fallback.
  useEffect(() => {
    if (!token || useUrlFallback) return
    try {
      const u = new URL(LINKEDIN_AUTH_START_URL)
      u.searchParams.set("connectToken", token)
      u.searchParams.set("returnTo", CONNECT_RETURN_TO)
      window.location.href = u.toString()
    } catch {
      // Bad auth-start URL config → fall back to the paste form rather than dead-ending.
      setUseUrlFallback(true)
    }
  }, [token, useUrlFallback])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErrMsg(null)
    if (tokenMissing) {
      setStatus("err")
      setErrMsg("This link looks incomplete. Please reopen the link from your text.")
      return
    }
    if (!looksLikeLinkedinUrl(linkedinUrl)) {
      setStatus("err")
      setErrMsg("Please paste your full LinkedIn profile URL (linkedin.com/in/…).")
      return
    }
    try {
      setStatus("submitting")
      const res = await fetch(CONNECT_SUBMIT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, linkedinUrl: linkedinUrl.trim() }),
      })
      const data = (await res.json().catch(() => null)) as ConnectSubmitResult | null
      if (!res.ok || !data) {
        setStatus("err")
        setErrMsg(`Something went wrong (${res.status}). Please try again.`)
        return
      }
      if (!data.ok) {
        if (data.reason === "needs_review") {
          setStatus("review")
          return
        }
        if (data.reason === "invalid_url") {
          setStatus("err")
          setErrMsg("We couldn't read that LinkedIn URL. Please paste the full profile link.")
          return
        }
        if (
          data.reason === "token_used" ||
          data.reason === "token_expired" ||
          data.reason === "unknown_token" ||
          data.reason === "missing_token"
        ) {
          setStatus("err")
          setErrMsg(
            "This link has expired or was already used. Text Claire and we'll send a fresh one.",
          )
          return
        }
        setStatus("err")
        setErrMsg("Something went wrong. Please try again.")
        return
      }
      // Success — reroute back to the iMessage thread (the prefilled "done" body).
      setStatus("ok")
      if (data.smsDeepLink) {
        window.location.href = data.smsDeepLink
      }
    } catch (err) {
      setStatus("err")
      setErrMsg(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="wk-li-connect">
      <style>{LINKEDIN_CONNECT_STYLES}</style>
      <section className="wk-li-connect__panel" aria-label="Connect LinkedIn to Claire">
        <header className="wk-li-connect__brand">
          <strong>WeKruit</strong>
          <span>Claire profile update</span>
        </header>

        {token && !useUrlFallback && status === "idle" ? (
          <>
            <p className="wk-li-connect__eyebrow">Taking you to LinkedIn</p>
            <h1 className="wk-li-connect__title">
              <span>Connecting</span>
              <span>LinkedIn</span>
            </h1>
            <p className="wk-li-connect__copy">
              Taking you to LinkedIn to sign in — you'll come right back to your texts with Claire.
            </p>
            <button
              type="button"
              onClick={() => setUseUrlFallback(true)}
              className="wk-li-connect__link"
            >
              Having trouble? Paste your LinkedIn URL instead
            </button>
          </>
        ) : status === "ok" ? (
          <>
            <p className="wk-li-connect__eyebrow">Profile connected</p>
            <h1 className="wk-li-connect__title">
              <span>You're</span>
              <span>all set</span>
            </h1>
            <p className="wk-li-connect__copy">
              Head back to your texts with Claire — we've got your profile.
            </p>
          </>
        ) : status === "review" ? (
          <>
            <p className="wk-li-connect__eyebrow">Manual check</p>
            <h1 className="wk-li-connect__title">
              <span>Thanks.</span>
              <span>We're checking.</span>
            </h1>
            <p className="wk-li-connect__copy">
              That LinkedIn profile is already linked to another account, so our team will take a
              quick look. No action needed — Claire will follow up by text.
            </p>
          </>
        ) : (
          <>
            <p className="wk-li-connect__eyebrow">Add work history for Claire</p>
            <h1 className="wk-li-connect__title">
              <span>Connect your</span>
              <span>LinkedIn</span>
            </h1>
            <p className="wk-li-connect__copy">
              This lets Claire pull in your experience automatically — no resume needed. It only
              takes a second.
            </p>

            <form onSubmit={onSubmit} className="wk-li-connect__form">
              <label htmlFor="li-url" className="wk-li-connect__label">
                Your LinkedIn profile URL
              </label>
              <input
                id="li-url"
                type="url"
                inputMode="url"
                autoComplete="url"
                placeholder="https://www.linkedin.com/in/your-name"
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
                disabled={status === "submitting"}
                className="wk-li-connect__input"
              />
              <button
                type="submit"
                disabled={status === "submitting" || tokenMissing}
                className="wk-li-connect__submit"
              >
                {status === "submitting" ? "Connecting…" : "Connect"}
              </button>
            </form>

            {tokenMissing && (
              <p className="wk-li-connect__error">
                This link looks incomplete. Please reopen the link from your text message.
              </p>
            )}
            {errMsg && <p className="wk-li-connect__error">{errMsg}</p>}
          </>
        )}
      </section>
    </main>
  )
}

const LINKEDIN_CONNECT_STYLES = `
.wk-li-connect {
  min-height: 100vh;
  box-sizing: border-box;
  padding: clamp(28px, 5vw, 72px) clamp(18px, 4vw, 56px);
  background:
    radial-gradient(circle at 52% 16%, rgba(229, 126, 54, 0.14), transparent 34%),
    linear-gradient(180deg, #f6eee4 0%, #f2eadf 100%);
  color: #2d1a0a;
}
.wk-li-connect__panel {
  width: min(100%, 520px);
  margin: 0 auto;
}
.wk-li-connect__brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: clamp(34px, 5vw, 58px);
  font-size: 15px;
}
.wk-li-connect__brand strong {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 23px;
  font-weight: 500;
  letter-spacing: 0;
}
.wk-li-connect__brand span,
.wk-li-connect__eyebrow,
.wk-li-connect__label {
  color: #75695d;
}
.wk-li-connect__brand span {
  font-size: 13px;
}
.wk-li-connect__eyebrow {
  margin: 0 0 12px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
.wk-li-connect__title {
  display: flex;
  flex-direction: column;
  gap: clamp(8px, 1.2vw, 14px);
  margin: 0 0 22px;
  font-family: 'Newsreader', Georgia, serif;
  font-size: clamp(48px, 6vw, 72px);
  line-height: 1.16;
  font-weight: 400;
  letter-spacing: 0;
  text-wrap: balance;
}
.wk-li-connect__title > span {
  display: block;
  line-height: inherit;
}
.wk-li-connect__copy {
  max-width: 440px;
  margin: 0;
  color: #61584f;
  font-size: 17px;
  line-height: 1.55;
}
.wk-li-connect__form {
  margin-top: 26px;
}
.wk-li-connect__label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
}
.wk-li-connect__input {
  width: 100%;
  box-sizing: border-box;
  padding: 14px 15px;
  font-size: 16px;
  color: #2d1a0a;
  background: rgba(255, 255, 255, 0.74);
  border: 1px solid rgba(45, 26, 10, 0.18);
  border-radius: 8px;
  outline: none;
}
.wk-li-connect__input:focus {
  border-color: rgba(45, 26, 10, 0.58);
  box-shadow: 0 0 0 3px rgba(229, 126, 54, 0.18);
}
.wk-li-connect__submit {
  display: block;
  width: 100%;
  margin-top: 14px;
  padding: 15px 18px;
  font-size: 16px;
  font-weight: 700;
  color: #fffaf2;
  background: #2d1a0a;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
.wk-li-connect__submit:disabled {
  color: #fffaf2;
  background: #9da495;
  cursor: default;
}
.wk-li-connect__link {
  margin-top: 22px;
  padding: 0;
  color: #4f463e;
  background: none;
  border: 0;
  border-bottom: 1px solid currentColor;
  font-size: 14px;
  cursor: pointer;
}
.wk-li-connect__error {
  margin: 12px 0 0;
  color: #b4452f;
  font-size: 14px;
  line-height: 1.45;
}
@media (max-width: 520px) {
  .wk-li-connect {
    padding: 22px 18px 40px;
  }
  .wk-li-connect__brand {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 32px;
  }
  .wk-li-connect__title {
    font-size: clamp(42px, 14vw, 54px);
    line-height: 1.18;
    gap: 8px;
  }
}
`
