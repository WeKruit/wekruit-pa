/**
 * ConnectPhone — candidate-domain "I chatted on phone, now bind my website account" page.
 *
 * Route: /connect-phone  (candidate.wekruit.com ONLY — never admin).
 *
 * The INVERSE of the QR opener (which binds website → phone). A candidate who
 * registered FIRST via iMessage and later signs in on the website binds the two:
 *   1. Sign in (Firebase) — gated; if not signed in, prompt to /login.
 *   2. Enter the phone number you've been texting Claire from → STEP 1
 *      (paCandidateConnectPhoneStart) texts a 6-digit code to that thread.
 *   3. Enter the code → STEP 2 (paCandidateConnectPhoneVerify) links the web
 *      session to the existing pa-users/{uid} and routes to /me.
 *
 * Mirror of ConnectLinkedin.tsx (same minimal C-end visual language).
 */
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { onAuthStateChanged, type User } from "firebase/auth"
import { auth } from "../lib/firebase.js"
import { connectPhoneStart, connectPhoneVerify } from "../lib/candidate-verify.js"

type Phase = "phone" | "code" | "done"

function reasonMessage(reason: string | undefined): string {
  switch (reason) {
    case "no_phone_profile":
      return "We couldn't find a chat from that number. Double-check it's the number you've texted Claire from."
    case "not_enabled":
      return "Phone connect isn't available for this account yet."
    case "invalid_phone":
      return "Please enter a valid phone number, including the country code."
    case "send_failed":
      return "We couldn't text that number right now. Please try again in a moment."
    case "code_expired":
      return "That code expired. Tap “Send a new code” to get a fresh one."
    case "too_many_attempts":
      return "Too many tries. Tap “Send a new code” to get a fresh one."
    case "no_outstanding_code":
      return "No active code — tap “Send a new code”."
    case "needs_review":
      return "That account is already linked elsewhere, so our team will take a quick look. Claire will follow up by text."
    case "code_mismatch":
    case "code_used":
      return "That code didn't match. Please re-enter it."
    default:
      return "Something went wrong. Please try again."
  }
}

export default function ConnectPhone() {
  const navigate = useNavigate()
  const [authUser, setAuthUser] = useState<User | null | "unknown">("unknown")
  const [phase, setPhase] = useState<Phase>("phone")
  const [phone, setPhone] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth(), (u) => setAuthUser(u))
    return () => unsub()
  }, [])

  async function onSendCode(e: React.FormEvent) {
    e.preventDefault()
    setErrMsg(null)
    setBusy(true)
    try {
      const res = await connectPhoneStart(phone)
      if (res.ok && res.reason === "already_linked") {
        setPhase("done")
        return
      }
      if (res.ok && res.codeSent) {
        setPhase("code")
        return
      }
      setErrMsg(reasonMessage(res.reason))
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault()
    setErrMsg(null)
    setBusy(true)
    try {
      const res = await connectPhoneVerify(code)
      if (res.ok && res.candidateId) {
        setPhase("done")
        setTimeout(() => navigate("/me"), 900)
        return
      }
      setErrMsg(reasonMessage(res.reason))
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const inputStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "0.8rem 0.9rem",
    fontSize: 16,
    border: "1px solid #d4d8ce",
    borderRadius: 10,
  }
  const buttonStyle = (disabled: boolean) => ({
    display: "block",
    width: "100%",
    marginTop: "1rem",
    padding: "0.85rem 1rem",
    fontSize: 16,
    fontWeight: 600,
    color: "#fff",
    background: disabled ? "#9aa295" : "#1b1f17",
    border: "none",
    borderRadius: 10,
    cursor: disabled ? "default" : "pointer",
  })

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "2.25rem 1.25rem" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <strong style={{ fontSize: "1.1rem", letterSpacing: "-0.02em" }}>WeKruit</strong>
      </header>

      {authUser === "unknown" ? (
        <p style={{ color: "#5f665b" }}>Loading…</p>
      ) : authUser === null ? (
        <>
          <h1 style={{ marginBottom: "0.25rem" }}>Sign in first</h1>
          <p style={{ color: "#5f665b", marginTop: 0 }}>
            Sign in to connect the number you've been texting Claire from.
          </p>
          <a href="/login" style={{ ...buttonStyle(false), textAlign: "center", textDecoration: "none", display: "block" }}>
            Sign in
          </a>
        </>
      ) : phase === "done" ? (
        <>
          <h1 style={{ marginBottom: "0.25rem" }}>You're connected 🎉</h1>
          <p style={{ color: "#5f665b", marginTop: 0 }}>
            Your phone and website account are now linked. Taking you to your profile…
          </p>
        </>
      ) : phase === "code" ? (
        <>
          <h1 style={{ marginBottom: "0.25rem" }}>Enter your code</h1>
          <p style={{ color: "#5f665b", marginTop: 0 }}>
            We texted a 6-digit code to {phone}. Enter it below (it expires in 10 minutes).
          </p>
          <form onSubmit={onVerify} style={{ marginTop: "1.25rem" }}>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              disabled={busy}
              style={inputStyle}
            />
            <button type="submit" disabled={busy || code.length < 6} style={buttonStyle(busy || code.length < 6)}>
              {busy ? "Verifying…" : "Verify"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => {
              setCode("")
              setPhase("phone")
            }}
            style={{ marginTop: "0.75rem", background: "none", border: "none", color: "#5f665b", cursor: "pointer", fontSize: 14 }}
          >
            Send a new code
          </button>
          {errMsg && <p style={{ color: "#b4452f", fontSize: 14, marginTop: "0.75rem" }}>{errMsg}</p>}
        </>
      ) : (
        <>
          <h1 style={{ marginBottom: "0.25rem" }}>Connect your phone</h1>
          <p style={{ color: "#5f665b", marginTop: 0 }}>
            Already chatting with Claire by text? Enter that number and we'll text you a code to link it.
          </p>
          <form onSubmit={onSendCode} style={{ marginTop: "1.25rem" }}>
            <label htmlFor="cp-phone" style={{ display: "block", fontSize: 14, color: "#5f665b", marginBottom: 6 }}>
              Your phone number
            </label>
            <input
              id="cp-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+1 555 123 4567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={busy}
              style={inputStyle}
            />
            <button type="submit" disabled={busy || phone.trim().length < 7} style={buttonStyle(busy || phone.trim().length < 7)}>
              {busy ? "Texting code…" : "Text me a code"}
            </button>
          </form>
          {errMsg && <p style={{ color: "#b4452f", fontSize: 14, marginTop: "0.75rem" }}>{errMsg}</p>}
        </>
      )}
    </div>
  )
}
