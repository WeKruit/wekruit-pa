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
import { useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"

// Same-origin Hosting rewrite → paLinkedinConnectSubmit (see firebase.json).
const CONNECT_SUBMIT_URL = "/_li/connect"

// UPGRADE flag — only show the OAuth button when the LinkedIn app is configured.
const OAUTH_ENABLED =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_LINKEDIN_OAUTH_ENABLED === "true"

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

  const tokenMissing = !token

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
          setErrMsg("This link has expired or was already used. Text Claire and we'll send a fresh one.")
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

  function onOauthClick() {
    // The verified-login UPGRADE wires the existing LinkedIn OAuth connector.
    // It is only shown when VITE_LINKEDIN_OAUTH_ENABLED is set AND requires a
    // token-scoped connect mode (a texted prospect has no Firebase session).
    // Until that lands, fall back to the URL form rather than dead-ending.
    setErrMsg("LinkedIn sign-in isn't available yet — paste your profile link below.")
  }

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "2.25rem 1.25rem" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <strong style={{ fontSize: "1.1rem", letterSpacing: "-0.02em" }}>WeKruit</strong>
      </header>

      {status === "ok" ? (
        <>
          <h1 style={{ marginBottom: "0.25rem" }}>You're all set 🎉</h1>
          <p style={{ color: "#5f665b", marginTop: 0 }}>
            Head back to your texts with Claire — we've got your profile.
          </p>
        </>
      ) : status === "review" ? (
        <>
          <h1 style={{ marginBottom: "0.25rem" }}>Thanks — we're double-checking</h1>
          <p style={{ color: "#5f665b", marginTop: 0 }}>
            That LinkedIn profile is already linked to another account, so our team
            will take a quick look. No action needed — Claire will follow up by text.
          </p>
        </>
      ) : (
        <>
          <h1 style={{ marginBottom: "0.25rem" }}>Connect your LinkedIn</h1>
          <p style={{ color: "#5f665b", marginTop: 0 }}>
            This lets Claire pull in your experience automatically — no resume needed.
            It only takes a second.
          </p>

          {OAUTH_ENABLED && (
            <button
              type="button"
              onClick={onOauthClick}
              style={{
                display: "block",
                width: "100%",
                marginTop: "1.25rem",
                padding: "0.85rem 1rem",
                fontSize: 16,
                fontWeight: 600,
                color: "#fff",
                background: "#0a66c2",
                border: "none",
                borderRadius: 10,
                cursor: "pointer",
              }}
            >
              Sign in with LinkedIn
            </button>
          )}

          <form onSubmit={onSubmit} style={{ marginTop: OAUTH_ENABLED ? "1rem" : "1.5rem" }}>
            <label htmlFor="li-url" style={{ display: "block", fontSize: 14, color: "#5f665b", marginBottom: 6 }}>
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
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "0.8rem 0.9rem",
                fontSize: 16,
                border: "1px solid #d4d8ce",
                borderRadius: 10,
              }}
            />
            <button
              type="submit"
              disabled={status === "submitting" || tokenMissing}
              style={{
                display: "block",
                width: "100%",
                marginTop: "1rem",
                padding: "0.85rem 1rem",
                fontSize: 16,
                fontWeight: 600,
                color: "#fff",
                background: status === "submitting" || tokenMissing ? "#9aa295" : "#1b1f17",
                border: "none",
                borderRadius: 10,
                cursor: status === "submitting" || tokenMissing ? "default" : "pointer",
              }}
            >
              {status === "submitting" ? "Connecting…" : "Connect"}
            </button>
          </form>

          {tokenMissing && (
            <p style={{ color: "#b4452f", fontSize: 14, marginTop: "0.75rem" }}>
              This link looks incomplete. Please reopen the link from your text message.
            </p>
          )}
          {errMsg && (
            <p style={{ color: "#b4452f", fontSize: 14, marginTop: "0.75rem" }}>{errMsg}</p>
          )}
        </>
      )}
    </div>
  )
}
