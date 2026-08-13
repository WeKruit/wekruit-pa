/**
 * WkJobs — device-approval page for the `wkjobs` command-line job search.
 *
 * Route: /wkjobs?user_code=ACDE-FGHJ
 *
 * Flow:
 *   1. `wkjobs login` prints a code and opens this page.
 *   2. Not signed in → bounce to /login?next=/wkjobs?user_code=… so Google,
 *      LinkedIn and magic-link all come from the existing CandidateLogin. This
 *      page deliberately implements no auth of its own.
 *   3. Signed in → show the code, take the wkjobs consent, POST the decision to
 *      paWkJobsApi /v1/device/approve with a Firebase ID token. The candidate is
 *      derived server-side from pa-candidate-auth; this page never sends one.
 *   4. Approved → the CLI's next poll authorizes. Then, and only then, offer the
 *      resume upload — it sharpens matching but must never gate connecting.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { onAuthStateChanged, type User } from "firebase/auth"
import { auth } from "../lib/firebase.js"
import { uploadResume } from "../lib/onboarding-cv.js"
import { trackEvent } from "../lib/analytics.js"

const WKJOBS_API_URL =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_WKJOBS_API_URL ??
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paWkJobsApi"

/**
 * Must match WKJOBS_CONSENT_VERSION in apps/functions/src/wkjobs/store.ts. The
 * backend refuses any other value, so drift fails closed rather than recording
 * an agreement to copy nobody displayed.
 */
const CONSENT_VERSION = "wkjobs-2026-08-12"

const CONSENT_TEXT =
  "I agree to connect the wkjobs command-line tool to my WeKruit profile. It runs on my own " +
  "computer. If I turn on LinkedIn search, it stores my LinkedIn session there so it can search " +
  "on my behalf — that session stays on my machine and is never sent to WeKruit. I can " +
  "disconnect anytime with `wkjobs logout`."

type Phase =
  | "loading"
  | "need_code"
  | "signed_out"
  | "confirm"
  | "working"
  | "approved"
  | "denied"
  | "error"

const ERROR_COPY: Record<string, string> = {
  unknown_code: "We don't recognize that code. Check it against your terminal and try again.",
  expired: "That code has expired. Run `wkjobs login` again for a fresh one.",
  already_decided: "That code was already used. Run `wkjobs login` again for a fresh one.",
  no_candidate_profile:
    "You're signed in, but your WeKruit candidate profile isn't set up yet. Finish onboarding, then reopen this link.",
  sign_in_required: "Your session expired. Sign in again to connect.",
}

function normalizeForDisplay(raw: string): string {
  const compact = raw.trim().toUpperCase().replace(/[\s-]/g, "")
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : raw.trim().toUpperCase()
}

export default function WkJobs() {
  const [searchParams] = useSearchParams()
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [typedCode, setTypedCode] = useState("")
  const [consented, setConsented] = useState(false)
  const [errorReason, setErrorReason] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>("loading")

  const userCode = useMemo(() => {
    const fromUrl = (searchParams.get("user_code") ?? "").trim()
    return fromUrl ? normalizeForDisplay(fromUrl) : ""
  }, [searchParams])

  const activeCode = userCode || (typedCode.trim() ? normalizeForDisplay(typedCode) : "")

  useEffect(() => {
    const unsub = onAuthStateChanged(auth(), (next) => setUser(next))
    return () => unsub()
  }, [])

  useEffect(() => {
    if (user === undefined) return
    if (phase === "approved" || phase === "denied" || phase === "working") return
    if (!user) {
      setPhase("signed_out")
      return
    }
    setPhase(activeCode ? "confirm" : "need_code")
  }, [user, activeCode, phase])

  const signInHref = useMemo(() => {
    const next = activeCode ? `/wkjobs?user_code=${encodeURIComponent(activeCode)}` : "/wkjobs"
    return `/login?next=${encodeURIComponent(next)}`
  }, [activeCode])

  const decide = useCallback(
    async (approve: boolean) => {
      if (!user || !activeCode) return
      setErrorReason(null)
      setPhase("working")
      try {
        const idToken = await user.getIdToken()
        const res = await fetch(`${WKJOBS_API_URL}/v1/device/approve`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
          body: JSON.stringify({
            user_code: activeCode,
            approve,
            ...(approve ? { consent_version: CONSENT_VERSION } : {}),
          }),
        })
        const data = (await res.json().catch(() => null)) as { reason?: string } | null
        if (!res.ok) {
          setErrorReason(data?.reason ?? "request_failed")
          setPhase("error")
          return
        }
        void trackEvent(approve ? "wkjobs_device_approved" : "wkjobs_device_denied")
        setPhase(approve ? "approved" : "denied")
      } catch {
        setErrorReason("network")
        setPhase("error")
      }
    },
    [user, activeCode],
  )

  return (
    <main className="wk-wkjobs">
      <style>{WKJOBS_STYLES}</style>
      <section className="wk-wkjobs__panel" aria-label="Connect the wkjobs command-line tool">
        <header className="wk-wkjobs__brand">
          <strong>WeKruit</strong>
          <span>wkjobs CLI</span>
        </header>

        {phase === "loading" && <p className="wk-wkjobs__copy">Checking your session…</p>}

        {phase === "signed_out" && (
          <>
            <p className="wk-wkjobs__eyebrow">Connect your terminal</p>
            <h1 className="wk-wkjobs__title">
              <span>Sign in to</span>
              <span>connect wkjobs</span>
            </h1>
            <p className="wk-wkjobs__copy">
              Sign in with Google or LinkedIn and we'll link the wkjobs command-line tool to your
              WeKruit profile. You'll come straight back here.
            </p>
            {activeCode && <CodeChip code={activeCode} />}
            <div className="wk-wkjobs__actions">
              <a className="wk-wkjobs__button" href={signInHref}>
                Sign in to continue
              </a>
            </div>
          </>
        )}

        {phase === "need_code" && (
          <>
            <p className="wk-wkjobs__eyebrow">Enter your code</p>
            <h1 className="wk-wkjobs__title">
              <span>What's the code</span>
              <span>in your terminal?</span>
            </h1>
            <p className="wk-wkjobs__copy">
              Run <code className="wk-wkjobs__code">wkjobs login</code> and type the code it prints.
            </p>
            <form
              className="wk-wkjobs__form"
              onSubmit={(e) => {
                e.preventDefault()
                if (typedCode.trim()) setPhase("confirm")
              }}
            >
              <label className="wk-wkjobs__label" htmlFor="wkjobs-code">
                Your code
              </label>
              <input
                id="wkjobs-code"
                className="wk-wkjobs__input"
                value={typedCode}
                onChange={(e) => setTypedCode(e.target.value)}
                placeholder="ACDE-FGHJ"
                autoComplete="off"
                spellCheck={false}
              />
              <button className="wk-wkjobs__submit" type="submit" disabled={!typedCode.trim()}>
                Continue
              </button>
            </form>
          </>
        )}

        {(phase === "confirm" || phase === "working") && (
          <>
            <p className="wk-wkjobs__eyebrow">Confirm this device</p>
            <h1 className="wk-wkjobs__title">
              <span>Connect wkjobs</span>
              <span>to your profile</span>
            </h1>
            <p className="wk-wkjobs__copy">
              Check that this code matches the one in your terminal. If it doesn't, don't connect.
            </p>
            <CodeChip code={activeCode} />

            <label className="wk-wkjobs__consent">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
                disabled={phase === "working"}
              />
              <span>
                {CONSENT_TEXT} See our <a href="/legal">Terms</a> and{" "}
                <a href="/legal">Privacy Policy</a>.
              </span>
            </label>

            <div className="wk-wkjobs__actions">
              <button
                className="wk-wkjobs__button"
                type="button"
                onClick={() => void decide(true)}
                disabled={!consented || phase === "working"}
              >
                {phase === "working" ? "Connecting…" : "Connect"}
              </button>
              <button
                className="wk-wkjobs__link"
                type="button"
                onClick={() => void decide(false)}
                disabled={phase === "working"}
              >
                This wasn't me
              </button>
            </div>
          </>
        )}

        {phase === "approved" && <Approved />}

        {phase === "denied" && (
          <>
            <p className="wk-wkjobs__eyebrow">Not connected</p>
            <h1 className="wk-wkjobs__title">
              <span>We didn't</span>
              <span>connect it</span>
            </h1>
            <p className="wk-wkjobs__copy">
              That code was rejected and can't be used. If you didn't start this, nothing further is
              needed.
            </p>
          </>
        )}

        {phase === "error" && (
          <>
            <p className="wk-wkjobs__eyebrow">Something went wrong</p>
            <h1 className="wk-wkjobs__title">
              <span>We couldn't</span>
              <span>connect that</span>
            </h1>
            <p className="wk-wkjobs__copy">
              {(errorReason && ERROR_COPY[errorReason]) ??
                "Something went wrong on our end. Run `wkjobs login` again for a fresh code."}
            </p>
            <div className="wk-wkjobs__actions">
              <button
                className="wk-wkjobs__link"
                type="button"
                onClick={() => {
                  setErrorReason(null)
                  setPhase(user ? "need_code" : "signed_out")
                }}
              >
                Try again
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  )
}

function CodeChip({ code }: { code: string }) {
  return (
    <p className="wk-wkjobs__chip" aria-label={`Code ${code.split("").join(" ")}`}>
      {code}
    </p>
  )
}

/**
 * Post-approval resume prompt. Deliberately after the connection succeeds and
 * dismissible: matching accuracy is the pitch, not a toll.
 */
function Approved() {
  const [file, setFile] = useState<File | null>(null)
  const [state, setState] = useState<"idle" | "uploading" | "done" | "error" | "dismissed">("idle")
  const [errMsg, setErrMsg] = useState<string | null>(null)

  async function onUpload() {
    if (!file) return
    setErrMsg(null)
    setState("uploading")
    try {
      await uploadResume(file, { source: "wkjobs_cli" })
      void trackEvent("wkjobs_resume_uploaded")
      setState("done")
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "Upload failed. Please try again.")
      setState("error")
    }
  }

  return (
    <>
      <p className="wk-wkjobs__eyebrow">Connected</p>
      <h1 className="wk-wkjobs__title">
        <span>You're</span>
        <span>all set</span>
      </h1>
      <p className="wk-wkjobs__copy">
        Head back to your terminal — wkjobs is connected to your WeKruit profile.
      </p>

      {state === "done" ? (
        <div className="wk-wkjobs__nudge">
          <p className="wk-wkjobs__nudge-title">Resume added</p>
          <p className="wk-wkjobs__copy">
            We'll use it to match you against roles rather than just keywords.
          </p>
        </div>
      ) : state === "dismissed" ? null : (
        <div className="wk-wkjobs__nudge">
          <p className="wk-wkjobs__nudge-title">Add your resume for better matches</p>
          <p className="wk-wkjobs__copy">
            Without it we match on keywords. With it we match against your actual history — the
            roles you see get noticeably more accurate. PDF or DOCX, up to 5 MB.
          </p>
          <input
            type="file"
            className="wk-wkjobs__file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={state === "uploading"}
          />
          {errMsg && <p className="wk-wkjobs__error">{errMsg}</p>}
          <div className="wk-wkjobs__actions">
            <button
              className="wk-wkjobs__button"
              type="button"
              onClick={() => void onUpload()}
              disabled={!file || state === "uploading"}
            >
              {state === "uploading" ? "Uploading…" : "Add resume"}
            </button>
            <button
              className="wk-wkjobs__link"
              type="button"
              onClick={() => setState("dismissed")}
              disabled={state === "uploading"}
            >
              Maybe later
            </button>
          </div>
        </div>
      )}
    </>
  )
}

const WKJOBS_STYLES = `
.wk-wkjobs {
  min-height: 100dvh;
  box-sizing: border-box;
  display: grid;
  place-items: start center;
  padding: clamp(30px, 5vw, 68px) clamp(18px, 4vw, 56px);
  background: linear-gradient(180deg, #f7efe6 0%, #f1e8dc 100%);
  color: #2d1a0a;
}
.wk-wkjobs__panel { width: min(100%, 548px); margin: 0 auto; }
.wk-wkjobs__brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: clamp(34px, 5vw, 58px);
  font-size: 15px;
}
.wk-wkjobs__brand strong {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 23px;
  font-weight: 500;
}
.wk-wkjobs__brand span { color: #75695d; font-size: 13px; }
.wk-wkjobs__eyebrow {
  margin: 0 0 12px;
  color: #75695d;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
.wk-wkjobs__title {
  display: flex;
  flex-direction: column;
  gap: clamp(10px, 1vw, 14px);
  margin: 0 0 18px;
  font-family: 'Newsreader', Georgia, serif;
  font-size: clamp(40px, 5vw, 62px);
  line-height: 1.18;
  font-weight: 400;
  text-wrap: balance;
  overflow-wrap: anywhere;
}
.wk-wkjobs__title > span { display: block; line-height: inherit; }
.wk-wkjobs__copy {
  max-width: 440px;
  margin: 0;
  color: #61584f;
  font-size: 16px;
  line-height: 1.5;
}
.wk-wkjobs__code {
  padding: 1px 5px;
  background: rgba(45, 26, 10, 0.07);
  border-radius: 4px;
  font-size: 14px;
}
.wk-wkjobs__chip {
  display: inline-block;
  margin: 22px 0 0;
  padding: 14px 22px;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(45, 26, 10, 0.18);
  border-radius: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: clamp(26px, 6vw, 34px);
  font-weight: 600;
  letter-spacing: 0.16em;
}
.wk-wkjobs__consent {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  margin-top: 26px;
  color: #61584f;
  font-size: 14px;
  line-height: 1.5;
}
.wk-wkjobs__consent input { margin-top: 3px; flex: 0 0 auto; width: 17px; height: 17px; }
.wk-wkjobs__consent a { color: #4f463e; }
.wk-wkjobs__form { margin-top: 24px; }
.wk-wkjobs__label { display: block; margin-bottom: 8px; color: #75695d; font-size: 13px; font-weight: 600; }
.wk-wkjobs__input {
  width: 100%;
  box-sizing: border-box;
  padding: 14px 15px;
  background: rgba(255, 255, 255, 0.74);
  border: 1px solid rgba(45, 26, 10, 0.18);
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 18px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #2d1a0a;
  outline: none;
}
.wk-wkjobs__input:focus {
  border-color: rgba(45, 26, 10, 0.58);
  box-shadow: 0 0 0 3px rgba(229, 126, 54, 0.18);
}
.wk-wkjobs__file { display: block; margin-top: 16px; font-size: 14px; }
.wk-wkjobs__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  margin-top: 26px;
}
.wk-wkjobs__button, .wk-wkjobs__submit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 0 22px;
  color: #fffaf2;
  background: #2d1a0a;
  border: 0;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
}
.wk-wkjobs__submit { width: 100%; margin-top: 14px; }
.wk-wkjobs__button:disabled, .wk-wkjobs__submit:disabled { background: #8f9388; cursor: default; }
.wk-wkjobs__link {
  padding: 0;
  color: #4f463e;
  background: none;
  border: 0;
  border-bottom: 1px solid currentColor;
  font-size: 14px;
  cursor: pointer;
}
.wk-wkjobs__link:disabled { color: #97907f; cursor: default; }
.wk-wkjobs__nudge {
  margin-top: 30px;
  padding: 22px;
  background: rgba(255, 255, 255, 0.62);
  border: 1px solid rgba(45, 26, 10, 0.14);
  border-radius: 12px;
}
.wk-wkjobs__nudge-title { margin: 0 0 8px; font-size: 17px; font-weight: 700; }
.wk-wkjobs__error { margin: 12px 0 0; color: #b4452f; font-size: 14px; line-height: 1.45; }
@media (max-width: 520px) {
  .wk-wkjobs { padding: 22px 18px 36px; }
  .wk-wkjobs__brand { align-items: baseline; gap: 12px; margin-bottom: 26px; }
  .wk-wkjobs__title { font-size: clamp(34px, 11vw, 42px); line-height: 1.22; gap: 10px; margin-bottom: 16px; }
  .wk-wkjobs__copy { font-size: 15.5px; }
  .wk-wkjobs__actions { align-items: stretch; flex-direction: column; gap: 14px; }
  .wk-wkjobs__button { width: 100%; box-sizing: border-box; }
  .wk-wkjobs__link { align-self: flex-start; }
}
`
