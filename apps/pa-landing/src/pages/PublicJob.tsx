/**
 * Candidate-facing public job page.
 *
 * Route: /j/:jobId
 *
 * Contract: a signed-out candidate can inspect the role, but starting Claire
 * must first attach the job flow to a durable WeKruit candidate profile.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { Link, useParams } from "react-router-dom"
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithCustomToken,
  signInWithRedirect,
  type User,
} from "firebase/auth"
import { doc, getDoc, setDoc } from "firebase/firestore"
import { auth, db } from "../lib/firebase.js"
import { CandidateShell } from "./CandidateLogin.js"

const CV_INGEST_URL = import.meta.env.VITE_CV_INGEST_URL ?? ""
const GLOBAL_UID_KEY = "wkr_uid"
const HAS_CV_KEY = "wkr_has_cv"
const EMAIL_STORAGE_KEY = "wkr_claim_email"
const LINKEDIN_AUTH_START_URL =
  import.meta.env.VITE_LINKEDIN_AUTH_START_URL ??
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paLinkedinAuthStart"

interface PrescreenConfig {
  jobTitle?: string
  company?: string
  jobType?: string
  region?: string
  level1Reveal?: {
    salaryRange?: string
  }
}

interface PaJobDoc {
  publicVisible?: boolean
  prescreenConfig?: PrescreenConfig
  descriptionMd?: string
  location?: string
}

interface PoolNumber {
  number: string
  status: "active" | "paused"
}

type LoginStatus = "idle" | "google" | "linkedin" | "email" | "sent" | "error"

function hashStringToUint(s: string): number {
  let h = 5381 >>> 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0
  }
  return h
}

function pickPoolNumber(pool: PoolNumber[] | null, key: string): string | null {
  if (!pool || pool.length === 0) return null
  const active = pool.filter((n) => n.status === "active" && n.number)
  if (active.length === 0) return null
  return active[hashStringToUint(key) % active.length].number
}

function uuidV4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function getOrCreateRequestedUserId(_jobId: string): string {
  const existingGlobal = window.localStorage.getItem(GLOBAL_UID_KEY)
  if (existingGlobal) return existingGlobal
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i)
    if (k && k.startsWith("wkr_rid_")) {
      const v = window.localStorage.getItem(k)
      if (v) {
        window.localStorage.setItem(GLOBAL_UID_KEY, v)
        return v
      }
    }
  }
  const v = uuidV4()
  window.localStorage.setItem(GLOBAL_UID_KEY, v)
  return v
}

function hasCvOnFile(): boolean {
  return window.localStorage.getItem(HAS_CV_KEY) === "true"
}

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

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const result = r.result as string
      const idx = result.indexOf(",")
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export default function PublicJob() {
  const { jobId } = useParams<{ jobId: string }>()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [job, setJob] = useState<PaJobDoc | null>(null)
  const [pool, setPool] = useState<PoolNumber[] | null>(null)
  const [smsClicked, setSmsClicked] = useState(false)
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [loginPromptOpen, setLoginPromptOpen] = useState(false)
  const [loginPromptDismissed, setLoginPromptDismissed] = useState(false)
  const [loginEmail, setLoginEmail] = useState("")
  const [loginStatus, setLoginStatus] = useState<LoginStatus>("idle")
  const [loginError, setLoginError] = useState<string | null>(null)

  const requestedUserId = useMemo(() => (jobId ? getOrCreateRequestedUserId(jobId) : ""), [jobId])
  const nextPath = useMemo(() => (jobId ? `/j/${jobId}` : "/"), [jobId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const linkedinPayload = takeLinkedinAuthPayload()
        if (linkedinPayload?.ok) {
          const cred = await signInWithCustomToken(auth(), linkedinPayload.customToken)
          if (!cancelled) {
            setUser(cred.user)
            setLoginStatus("idle")
            setLoginPromptOpen(false)
            setLoginPromptDismissed(true)
          }
          return
        }
        if (linkedinPayload && !linkedinPayload.ok) {
          throw new Error(linkedinPayload.error)
        }
        const result = await getRedirectResult(auth())
        if (!cancelled && result?.user) {
          setUser(result.user)
          setLoginStatus("idle")
          setLoginPromptOpen(false)
          setLoginPromptDismissed(true)
        }
      } catch (err) {
        if (!cancelled) {
          setLoginStatus("error")
          setLoginError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    const unsubscribe = onAuthStateChanged(auth(), (nextUser) => {
      setUser(nextUser)
      if (nextUser) {
        setLoginStatus("idle")
        setLoginPromptOpen(false)
        setLoginPromptDismissed(true)
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!jobId) {
        setErr("Missing job id")
        setLoading(false)
        return
      }
      try {
        setLoading(true)
        const snap = await getDoc(doc(db(), "pa-jobs", jobId))
        if (cancelled) return
        if (!snap.exists()) {
          setErr("Job not found")
          setLoading(false)
          return
        }
        const data = snap.data() as PaJobDoc
        if (!data.publicVisible) {
          setErr("This job is not publicly visible.")
          setLoading(false)
          return
        }
        setJob(data)
        try {
          const poolSnap = await getDoc(doc(db(), "pa-config", "sendblue-pool"))
          if (poolSnap.exists()) {
            const raw = poolSnap.data() as { numbers?: PoolNumber[] }
            if (Array.isArray(raw.numbers)) setPool(raw.numbers)
          }
        } catch {
          // Non-fatal: the page can still render the role and login gate.
        }
        try {
          await setDoc(doc(db(), "pa-prescreen-pending-invites", requestedUserId), {
            jobId,
            requestedUserId,
            createdAt: new Date().toISOString(),
          })
        } catch {
          // Pre-auth users may not write this doc; webhook-side resolution is still server-owned.
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jobId, requestedUserId])

  useEffect(() => {
    if (user) {
      setLoginPromptOpen(false)
      return
    }
    if (loading || !job || user !== null || loginPromptDismissed) return
    const timer = window.setTimeout(() => setLoginPromptOpen(true), 650)
    return () => window.clearTimeout(timer)
  }, [job, loading, loginPromptDismissed, user])

  async function startProviderSignIn(kind: "google" | "linkedin") {
    setLoginStatus(kind)
    setLoginError(null)
    if (kind === "linkedin") {
      const returnTo = `${window.location.origin}${nextPath}`
      window.location.assign(`${LINKEDIN_AUTH_START_URL}?returnTo=${encodeURIComponent(returnTo)}`)
      return
    }
    const provider = createGoogleProvider()
    try {
      await signInWithRedirect(auth(), provider)
    } catch (err) {
      setLoginStatus("error")
      setLoginError(err instanceof Error ? err.message : String(err))
    }
  }

  async function sendEmailLink(e: FormEvent) {
    e.preventDefault()
    const email = cleanEmail(loginEmail)
    if (!email) {
      setLoginStatus("error")
      setLoginError("Enter your email first.")
      return
    }
    setLoginStatus("email")
    setLoginError(null)
    try {
      await sendSignInLinkToEmail(auth(), email, {
        url: `${window.location.origin}/login?next=${encodeURIComponent(nextPath)}`,
        handleCodeInApp: true,
      })
      window.localStorage.setItem(EMAIL_STORAGE_KEY, email)
      setLoginStatus("sent")
    } catch (err) {
      setLoginStatus("error")
      setLoginError(err instanceof Error ? err.message : String(err))
    }
  }

  function renderLoginControls(location: "panel" | "modal") {
    return (
      <div className={`public-job-login-controls public-job-login-controls-${location}`}>
        <button
          type="button"
          className="public-job-provider-button"
          onClick={() => void startProviderSignIn("google")}
          disabled={loginStatus === "google" || loginStatus === "linkedin" || loginStatus === "email"}
        >
          {loginStatus === "google" ? "Opening Google" : "Continue with Google"}
        </button>
        <button
          type="button"
          className="public-job-provider-button public-job-linkedin-button"
          onClick={() => void startProviderSignIn("linkedin")}
          disabled={loginStatus === "google" || loginStatus === "linkedin" || loginStatus === "email"}
        >
          {loginStatus === "linkedin" ? "Opening LinkedIn" : "Continue with LinkedIn"}
        </button>
        <div className="public-job-login-divider">or</div>
        <form className="public-job-login-email" onSubmit={(e) => void sendEmailLink(e)}>
          <label htmlFor={`job-login-email-${location}`}>Email magic link</label>
          <div>
            <input
              id={`job-login-email-${location}`}
              type="email"
              autoComplete="email"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={loginStatus === "email"}
            />
            <button type="submit" disabled={loginStatus === "email"}>
              {loginStatus === "email" ? "Sending" : "Send"}
            </button>
          </div>
        </form>
        {loginStatus === "sent" ? (
          <p className="candidate-success">Check {cleanEmail(loginEmail)} for your sign-in link.</p>
        ) : null}
        {loginError ? <p className="candidate-error">{loginError}</p> : null}
      </div>
    )
  }

  if (loading || user === undefined) {
    return (
      <CandidateShell>
        <main className="candidate-panel">
          <p className="candidate-kicker">Open role</p>
          <h1>Loading</h1>
        </main>
      </CandidateShell>
    )
  }

  if (err || !job) {
    return (
      <CandidateShell>
        <main className="candidate-panel">
          <p className="candidate-kicker">Open role</p>
          <h1>404</h1>
          <p className="public-job-muted">{err ?? "Not found"}</p>
          <Link className="candidate-primary-link" to="/">Back to jobs</Link>
        </main>
      </CandidateShell>
    )
  }

  const cfg = job.prescreenConfig ?? {}
  const jobTitle = cfg.jobTitle ?? "Open role"
  const company = cfg.company ?? "Confidential employer"
  const location = job.location ?? cfg.region
  const salary = cfg.level1Reveal?.salaryRange
  const sendNumber = pickPoolNumber(pool, requestedUserId)
  const smsBody = `WeKruit_${jobId}_${requestedUserId}_Job`
  const smsHref = sendNumber ? `sms:${sendNumber}?body=${encodeURIComponent(smsBody)}` : null

  return (
    <CandidateShell>
      <style>{PUBLIC_JOB_STYLES}</style>
      <main className="public-job-layout">
        <section className="public-job-main">
          <Link className="candidate-muted-link" to="/">Back to jobs</Link>
          <div className="public-job-title-block">
            <div className="public-job-badges">
              <span>Open role</span>
              <span className="public-job-collab-badge">WeKruit collaborated</span>
            </div>
            <h1>{jobTitle}</h1>
            <p>{company}{location ? ` · ${location}` : ""}</p>
            {salary ? <strong>{salary}</strong> : null}
          </div>
          <article className="public-job-card public-job-description">
            <h2>Role details</h2>
            {cfg.jobType || location || salary ? (
              <p className="public-job-meta">
                {[cfg.jobType, location, salary].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            {job.descriptionMd ? <div className="public-job-copy">{job.descriptionMd}</div> : null}
          </article>
        </section>
        <aside className="public-job-sidebar">
          <section className="public-job-card public-job-start-card">
            <h2>Start the 5-minute screen</h2>
            {user ? (
              <>
                <p>
                  Claire will ask a few quick role-fit questions over iMessage, attached to your
                  WeKruit candidate profile.
                </p>
                {smsHref ? (
                  <a
                    className="candidate-primary-link public-job-sms-link"
                    href={smsHref}
                    onClick={() => setSmsClicked(true)}
                  >
                    Open in iMessage
                  </a>
                ) : (
                  <p className="candidate-error">WeKruit messaging is temporarily unavailable.</p>
                )}
                {smsClicked ? (
                  <p className="candidate-success">Continue in iMessage to answer Claire.</p>
                ) : null}
              </>
            ) : (
              <>
                <p>
                  Sign in first so this interview attaches to your WeKruit candidate profile. Then
                  this page unlocks iMessage for Claire.
                </p>
                {renderLoginControls("panel")}
              </>
            )}
          </section>
          <section className="public-job-card">
            <InlineCvSection
              jobId={jobId!}
              requestedUserId={requestedUserId}
              initialHasCv={hasCvOnFile()}
            />
          </section>
          <p className="public-job-terms">
            By starting, you agree to our <a href="/legal">privacy &amp; terms</a>.
            {sendNumber ? ` WeKruit will text you from ${sendNumber}.` : ""}
          </p>
        </aside>
      </main>
      {loginPromptOpen && !user ? (
        <div className="public-job-login-modal-wrap" role="presentation">
          <button
            className="public-job-login-modal-scrim"
            type="button"
            aria-label="Close sign-in prompt"
            onClick={() => {
              setLoginPromptDismissed(true)
              setLoginPromptOpen(false)
            }}
          />
          <aside
            className="public-job-login-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="public-job-login-modal-title"
          >
            <button
              className="public-job-login-modal-close"
              type="button"
              aria-label="Close"
              onClick={() => {
                setLoginPromptDismissed(true)
                setLoginPromptOpen(false)
              }}
            >
              x
            </button>
            <p className="candidate-kicker">WeKruit candidate profile</p>
            <h2 id="public-job-login-modal-title">Sign in to start this role with Claire</h2>
            <p>
              We attach this interview to your candidate profile first, then unlock iMessage for
              this job.
            </p>
            {renderLoginControls("modal")}
          </aside>
        </div>
      ) : null}
    </CandidateShell>
  )
}

interface InlineCvSectionProps {
  jobId: string
  requestedUserId: string
  initialHasCv: boolean
}

function InlineCvSection({ jobId, requestedUserId, initialHasCv }: InlineCvSectionProps) {
  const [hasCv, setHasCv] = useState<boolean>(initialHasCv)
  if (hasCv) {
    return <p className="candidate-success">We have your resume on file.</p>
  }
  return (
    <div className="public-job-cv-section">
      <h2>Resume</h2>
      <p>PDF or DOCX, under 5 MB. We will use it to tailor the pre-screen.</p>
      <InlineCvUpload
        jobId={jobId}
        requestedUserId={requestedUserId}
        onUploaded={() => setHasCv(true)}
      />
    </div>
  )
}

interface InlineCvUploadProps {
  jobId: string
  requestedUserId: string
  onUploaded: () => void
}

function InlineCvUpload({ jobId, requestedUserId, onUploaded }: InlineCvUploadProps) {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<"idle" | "uploading" | "ok" | "err">("idle")
  const [errMsg, setErrMsg] = useState<string | null>(null)

  useEffect(() => {
    setStatus("idle")
    setErrMsg(null)
  }, [file])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      setStatus("err")
      setErrMsg("File must be under 5 MB.")
      return
    }
    if (!CV_INGEST_URL) {
      setStatus("err")
      setErrMsg("CV ingest endpoint is not configured.")
      return
    }
    try {
      setStatus("uploading")
      const b64 = await fileToBase64(file)
      const res = await fetch(CV_INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tempUserId: requestedUserId,
          browserUid: requestedUserId,
          resumeBase64: b64,
          resumeName: file.name,
          jobIdContext: jobId,
          source: "public_job_page",
        }),
      })
      if (!res.ok) {
        setStatus("err")
        setErrMsg(`Upload failed (${res.status})`)
        return
      }
      window.localStorage.setItem(HAS_CV_KEY, "true")
      setStatus("ok")
      onUploaded()
    } catch (err) {
      setStatus("err")
      setErrMsg(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <form onSubmit={onSubmit} className="public-job-cv-upload">
      <input
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={status === "uploading"}
      />
      <button type="submit" disabled={!file || status === "uploading"}>
        {status === "uploading" ? "Uploading" : "Upload"}
      </button>
      {status === "err" && errMsg ? <p className="candidate-error">{errMsg}</p> : null}
    </form>
  )
}

const PUBLIC_JOB_STYLES = `
.public-job-layout {
  max-width: 980px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 20px;
  align-items: start;
}
.public-job-main,
.public-job-sidebar {
  display: grid;
  gap: 16px;
}
.public-job-title-block {
  display: grid;
  gap: 10px;
  margin-top: 10px;
}
.public-job-title-block h1 {
  margin: 0;
  font-size: clamp(36px, 6vw, 56px);
  line-height: 1.02;
  letter-spacing: 0;
}
.public-job-title-block p {
  margin: 0;
  color: #364233;
  font-size: 18px;
  line-height: 1.35;
}
.public-job-title-block strong {
  justify-self: start;
  padding: 7px 10px;
  border-radius: 8px;
  background: #edf5ee;
  color: #16643b;
  font-size: 18px;
}
.public-job-badges {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.public-job-badges span {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  padding: 0 10px;
  border-radius: 8px;
  background: #f0eee8;
  color: #364233;
  font-size: 13px;
  font-weight: 900;
  text-transform: uppercase;
}
.public-job-badges .public-job-collab-badge {
  background: #dff4eb;
  border: 1px solid #b8dfd1;
  color: #24543c;
  text-transform: none;
}
.public-job-card {
  background: #fffdf8;
  border: 1px solid #ddd3c2;
  border-radius: 8px;
  padding: 20px;
}
.public-job-card h2 {
  margin: 0 0 12px;
  font-size: 22px;
  line-height: 1.2;
  letter-spacing: 0;
}
.public-job-card p {
  color: #364233;
  line-height: 1.5;
}
.public-job-meta {
  margin: 0 0 16px;
  color: #5f665b;
  font-weight: 700;
}
.public-job-copy {
  white-space: pre-wrap;
  line-height: 1.55;
  color: #364233;
}
.public-job-start-card {
  display: grid;
  gap: 12px;
}
.public-job-start-card p {
  margin: 0;
}
.public-job-sms-link {
  width: 100%;
}
.public-job-login-controls {
  display: grid;
  gap: 10px;
}
.public-job-provider-button,
.public-job-login-email button,
.public-job-cv-upload button {
  min-height: 42px;
  border-radius: 8px;
  border: 1px solid #2f6f4f;
  background: #2f6f4f;
  color: #fffdf8;
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}
.public-job-provider-button {
  width: 100%;
}
.public-job-linkedin-button {
  background: #0a66c2;
  border-color: #0a66c2;
}
.public-job-provider-button:disabled,
.public-job-login-email button:disabled,
.public-job-cv-upload button:disabled {
  opacity: 0.62;
  cursor: not-allowed;
}
.public-job-login-divider {
  color: #7a6f5d;
  font-size: 13px;
  font-weight: 800;
  text-align: center;
}
.public-job-login-email {
  display: grid;
  gap: 6px;
}
.public-job-login-email label {
  color: #364233;
  font-size: 13px;
  font-weight: 800;
}
.public-job-login-email div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 72px;
  gap: 8px;
}
.public-job-login-email input {
  min-width: 0;
  border: 1px solid #cfc3ae;
  border-radius: 8px;
  padding: 0 10px;
  font: inherit;
  color: #18211a;
}
.public-job-cv-section {
  display: grid;
  gap: 12px;
}
.public-job-cv-section h2 {
  margin-bottom: 0;
}
.public-job-cv-section p {
  margin: 0;
}
.public-job-cv-upload {
  display: grid;
  gap: 10px;
}
.public-job-cv-upload input {
  width: 100%;
  min-width: 0;
}
.public-job-terms {
  margin: 0;
  color: #7a6f5d;
  font-size: 13px;
  line-height: 1.45;
}
.public-job-muted {
  color: #5f665b;
}
.public-job-login-modal-wrap {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 20px;
}
.public-job-login-modal-scrim {
  position: absolute;
  inset: 0;
  z-index: 0;
  border: 0;
  background: rgba(24, 33, 26, 0.48);
}
.public-job-login-modal {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  width: min(440px, calc(100vw - 24px));
  display: grid;
  gap: 14px;
  background: #fffdf8;
  border: 1px solid #ddd3c2;
  border-radius: 8px;
  padding: 24px;
  box-shadow: 0 24px 80px rgba(24, 33, 26, 0.28);
}
.public-job-login-modal h2 {
  margin: 0;
  font-size: 28px;
  line-height: 1.1;
  letter-spacing: 0;
}
.public-job-login-modal p {
  margin: 0;
  color: #364233;
  line-height: 1.5;
}
.public-job-login-modal-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  height: 32px;
  border: 1px solid #ddd3c2;
  border-radius: 8px;
  background: #fffdf8;
  color: #364233;
  font: inherit;
  font-weight: 900;
  cursor: pointer;
}
@media (max-width: 820px) {
  .public-job-layout {
    grid-template-columns: 1fr;
  }
  .public-job-title-block h1 {
    font-size: 42px;
  }
}
`
