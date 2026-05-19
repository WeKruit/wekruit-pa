/**
 * Candidate-facing public job page.
 *
 * Route: /j/:jobId
 *
 * Contract: a signed-out candidate can inspect the role, but starting Claire
 * must first attach the job flow to a durable WeKruit candidate profile.
 *
 * Visual layer (PublicJobLayout / PublicJobLoading / PublicJob404 + styles)
 * lives at the bottom of this file. All Firebase/auth/CV-upload/prescreen
 * logic above is unchanged — only the rendering shell is new.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithCustomToken,
  signInWithPopup,
  signInWithRedirect,
  type User,
} from "firebase/auth"
import { doc, getDoc, setDoc } from "firebase/firestore"
import { httpsCallable } from "firebase/functions"
import { auth, db, functions } from "../lib/firebase.js"
import {
  CLAIM_EMAIL_KEY,
  GLOBAL_UID_KEY,
  getBrowserUid,
  readStoredValue,
  rememberStoredValue,
} from "../lib/browser-identity"
import {
  CandidateShell,
  PulseDot,
  LiveStatusPill,
  Avatar,
  CompanyMark,
  Icon,
} from "./CandidateLogin.js"

const CV_INGEST_URL = import.meta.env.VITE_CV_INGEST_URL ?? ""
const EMAIL_STORAGE_KEY = CLAIM_EMAIL_KEY
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
  /** v2.4: collaboration flag — gates the "WeKruit collaborated" badge. */
  wekruitCollaborationStatus?: "collaborated" | "not_collaborated"
  prescreenConfig?: PrescreenConfig
  descriptionMd?: string
  location?: string
  /** Top-level title used by rain / externally seeded jobs without prescreenConfig. */
  title?: string
  companyId?: string
  companyName?: string
  rawLocation?: string
  /** Optional recruiter-intake hiring-manager fields. */
  hiringManagerName?: string
  hiringManagerTitle?: string
  hiringManagerOnline?: boolean
  hiringManagerPhotoUrl?: string
  /** Optional precomputed seat count; falls back to a small deterministic default. */
  interviewSeats?: number
}

interface PoolNumber {
  number: string
  status: "active" | "paused"
}

type LoginStatus = "idle" | "google" | "linkedin" | "email" | "sent" | "error"
type ResumeGateStatus = "needs_resume_upload" | "resume_processing" | "ready"
type ResumeGateState =
  | { status: "idle" | "loading" }
  | {
      status: "ready"
      gate: {
        ok: true
        candidateId: string
        status: ResumeGateStatus
        hasResume: boolean
        labelsReady: boolean
        resumeArtifactId?: string
        parsedResumeId?: string
      }
    }
  | { status: "error"; message: string }
type ResumeGateResult = Extract<ResumeGateState, { status: "ready" }>["gate"]

const LOGO_BG_POOL = ["#2A1812", "#0F1B2D", "#5E6AD2", "#635BFF", "#0D0D0D", "#1A1A1A", "#374151", "#7C2D12"]
const TONE_POOL: Array<"warm" | "moss" | "slate"> = ["warm", "slate", "moss"]

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

function getOrCreateRequestedUserId(_jobId: string): string {
  const existingGlobal = readStoredValue(GLOBAL_UID_KEY)
  if (existingGlobal) return existingGlobal
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i)
    if (k && k.startsWith("wkr_rid_")) {
      const v = window.localStorage.getItem(k)
      if (v) {
        rememberStoredValue(GLOBAL_UID_KEY, v)
        return v
      }
    }
  }
  return getBrowserUid()
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
  const [resolvedCompanyName, setResolvedCompanyName] = useState<string | null>(null)
  const [pool, setPool] = useState<PoolNumber[] | null>(null)
  const [smsClicked, setSmsClicked] = useState(false)
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [loginPromptOpen, setLoginPromptOpen] = useState(false)
  const [loginPromptDismissed, setLoginPromptDismissed] = useState(false)
  const [loginEmail, setLoginEmail] = useState("")
  const [loginStatus, setLoginStatus] = useState<LoginStatus>("idle")
  const [loginError, setLoginError] = useState<string | null>(null)
  const [resumeGate, setResumeGate] = useState<ResumeGateState>({ status: "idle" })

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
        // Resolve company display name from pa-companies/{companyId} when the
        // job doc lacks prescreenConfig.company / companyName denormalization
        // (true for rain / externally seeded seeded jobs).
        if (!data.prescreenConfig?.company && !data.companyName && data.companyId) {
          try {
            const companySnap = await getDoc(doc(db(), "pa-companies", data.companyId))
            if (companySnap.exists()) {
              const cd = companySnap.data() as { name?: string }
              if (typeof cd.name === "string") setResolvedCompanyName(cd.name)
            }
          } catch {
            // ignore — fallback to "Confidential employer" below
          }
        }
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

  async function refreshResumeGate() {
    if (!user) {
      setResumeGate({ status: "idle" })
      return
    }
    setResumeGate({ status: "loading" })
    try {
      const checkGate = httpsCallable<{ browserUid?: string | null }, ResumeGateResult>(
        functions(),
        "paCandidateResumeGateStatus"
      )
      const result = await checkGate({ browserUid: requestedUserId })
      setResumeGate({ status: "ready", gate: result.data })
    } catch (err) {
      setResumeGate({ status: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }

  useEffect(() => {
    if (!user) {
      setResumeGate({ status: "idle" })
      return
    }
    let cancelled = false
    setResumeGate({ status: "loading" })
    void (async () => {
      try {
        const checkGate = httpsCallable<{ browserUid?: string | null }, ResumeGateResult>(
          functions(),
          "paCandidateResumeGateStatus"
        )
        const result = await checkGate({ browserUid: requestedUserId })
        if (!cancelled) setResumeGate({ status: "ready", gate: result.data })
      } catch (err) {
        if (!cancelled) setResumeGate({ status: "error", message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [requestedUserId, user])

  useEffect(() => {
    const candidateId = resumeGate.status === "ready" ? resumeGate.gate.candidateId : null
    if (!candidateId || !jobId) return
    void setDoc(doc(db(), "pa-prescreen-pending-invites", candidateId), {
      jobId,
      requestedUserId: candidateId,
      browserUid: requestedUserId,
      createdAt: new Date().toISOString(),
    }).catch(() => undefined)
  }, [jobId, requestedUserId, resumeGate])

  async function startProviderSignIn(kind: "google" | "linkedin") {
    setLoginStatus(kind)
    setLoginError(null)
    if (kind === "linkedin") {
      const returnTo = `${window.location.origin}${nextPath}`
      window.location.assign(`${LINKEDIN_AUTH_START_URL}?returnTo=${encodeURIComponent(returnTo)}`)
      return
    }
    const provider = createGoogleProvider()
    let willRedirect = false
    try {
      const cred = await signInWithPopup(auth(), provider)
      setUser(cred.user)
      setLoginStatus("idle")
      setLoginPromptOpen(false)
      setLoginPromptDismissed(true)
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: string }).code)
          : ""
      if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
        willRedirect = true
        await signInWithRedirect(auth(), createGoogleProvider())
        return
      }
      setLoginStatus("error")
      setLoginError(code === "auth/popup-closed-by-user" ? "Sign-in cancelled." : err instanceof Error ? err.message : String(err))
    } finally {
      if (!willRedirect && loginStatus === "google") setLoginStatus("idle")
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
      rememberStoredValue(EMAIL_STORAGE_KEY, email)
      setLoginStatus("sent")
    } catch (err) {
      setLoginStatus("error")
      setLoginError(err instanceof Error ? err.message : String(err))
    }
  }

  function renderLoginControls(location: "panel" | "modal") {
    return (
      <div className={`wk-pj-login wk-pj-login--${location}`}>
        <button
          type="button"
          className="wk-btn wk-btn--ink wk-btn--block"
          onClick={() => void startProviderSignIn("google")}
          disabled={loginStatus === "google" || loginStatus === "linkedin" || loginStatus === "email"}
        >
          {loginStatus === "google" ? "Opening Google…" : "Continue with Google"}
        </button>
        <button
          type="button"
          className="wk-btn wk-btn--linkedin wk-btn--block"
          onClick={() => void startProviderSignIn("linkedin")}
          disabled={loginStatus === "google" || loginStatus === "linkedin" || loginStatus === "email"}
        >
          {loginStatus === "linkedin" ? "Opening LinkedIn…" : "Continue with LinkedIn"}
        </button>
        <div className="wk-pj-login__divider"><span>or magic link</span></div>
        <form className="wk-pj-login__email" onSubmit={(e) => void sendEmailLink(e)}>
          <label htmlFor={`job-login-email-${location}`}>Email</label>
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
            <button type="submit" className="wk-btn wk-btn--primary" disabled={loginStatus === "email"}>
              {loginStatus === "email" ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
        {loginStatus === "sent" ? (
          <p className="wk-success">Check {cleanEmail(loginEmail)} for your sign-in link.</p>
        ) : null}
        {loginError ? <p className="wk-error">{loginError}</p> : null}
      </div>
    )
  }

  if (loading || user === undefined) {
    return <PublicJobLoading />
  }

  if (err || !job) {
    return <PublicJob404 message={err ?? undefined} />
  }

  // Canonical pa-jobs shape (normalize-pa-jobs.ts) — display reads
  // top-level fields only; prescreenConfig keeps the screening salary range.
  const cfg = job.prescreenConfig ?? {}
  const jobTitle = job.title ?? cfg.jobTitle ?? "Open role"
  const company = job.companyName ?? resolvedCompanyName ?? "Confidential employer"
  const location = job.location ?? cfg.region
  const salary = cfg.level1Reveal?.salaryRange
  const resumeGateValue = resumeGate.status === "ready" ? resumeGate.gate : null
  const uploadUserId = resumeGateValue?.candidateId
  const smsUserId = resumeGateValue?.candidateId ?? requestedUserId
  const sendNumber = pickPoolNumber(pool, smsUserId)
  const smsBody = `WeKruit_${jobId}_${smsUserId}_Job`
  const smsHref = sendNumber ? `sms:${sendNumber}?body=${encodeURIComponent(smsBody)}` : null

  const h = hashStringToUint(jobId || company)
  const view: PaJobView = {
    jobTitle,
    company,
    location,
    salary,
    jobType: cfg.jobType,
    descriptionMd: job.descriptionMd,
    collaborated: job.wekruitCollaborationStatus === "collaborated",
    hiringManager: job.hiringManagerName
      ? {
          name: job.hiringManagerName,
          title: job.hiringManagerTitle,
          online: job.hiringManagerOnline ?? true,
          photoUrl: job.hiringManagerPhotoUrl,
        }
      : undefined,
    interviewSeats: job.interviewSeats ?? ((h % 4) + 1),
    logo: (company[0] ?? "?").toUpperCase(),
    logoBg: LOGO_BG_POOL[h % LOGO_BG_POOL.length],
    tone: TONE_POOL[h % TONE_POOL.length],
  }

  const startSlot = user ? (
    <PrescreenStartGate
      gateState={resumeGate}
      smsHref={smsHref}
      smsClicked={smsClicked}
      onSmsClick={() => setSmsClicked(true)}
      onRefresh={() => void refreshResumeGate()}
    />
  ) : (
    <>
      <p className="wk-pj-card__copy">
        Sign in first so this interview attaches to your WeKruit candidate profile. Then this page
        unlocks iMessage for Claire.
      </p>
      {renderLoginControls("panel")}
    </>
  )

  const cvSlot = (
    <InlineCvSection
      jobId={jobId!}
      requestedUserId={requestedUserId}
      uploadUserId={uploadUserId}
      userSignedIn={Boolean(user)}
      gateStatus={resumeGateValue?.status}
      onUploaded={() => void refreshResumeGate()}
    />
  )

  const smsHint = (
    <>
      <Icon name="lock" size={13} stroke={1.6} />
      By starting, you agree to our <Link className="wk-link" to="/legal">privacy &amp; terms</Link>.
      {sendNumber ? ` WeKruit will text you from ${sendNumber}.` : ""}
    </>
  )

  return (
    <>
      <PublicJobLayout job={view} startSlot={startSlot} cvSlot={cvSlot} smsHint={smsHint} />
      {loginPromptOpen && !user ? (
        <div className="wk-pj-modal-wrap" role="presentation">
          <style>{PUBLIC_JOB_STYLES}</style>
          <button
            className="wk-pj-modal-scrim"
            type="button"
            aria-label="Close sign-in prompt"
            onClick={() => {
              setLoginPromptDismissed(true)
              setLoginPromptOpen(false)
            }}
          />
          <aside
            className="wk-pj-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="public-job-login-modal-title"
          >
            <button
              className="wk-pj-modal__close"
              type="button"
              aria-label="Close"
              onClick={() => {
                setLoginPromptDismissed(true)
                setLoginPromptOpen(false)
              }}
            >
              ×
            </button>
            <p className="wk-eyebrow">WeKruit candidate profile</p>
            <h2 id="public-job-login-modal-title" className="wk-pj-modal__h">
              Sign in to start this role with <em className="wk-accent">Claire.</em>
            </h2>
            <p className="wk-pj-modal__sub">
              We attach this interview to your candidate profile first, then unlock iMessage for
              this job.
            </p>
            {renderLoginControls("modal")}
          </aside>
        </div>
      ) : null}
    </>
  )
}

interface InlineCvSectionProps {
  jobId: string
  requestedUserId: string
  uploadUserId?: string
  userSignedIn: boolean
  gateStatus?: ResumeGateStatus
  onUploaded: () => void
}

function PrescreenStartGate({
  gateState,
  smsHref,
  smsClicked,
  onSmsClick,
  onRefresh,
}: {
  gateState: ResumeGateState
  smsHref: string | null
  smsClicked: boolean
  onSmsClick: () => void
  onRefresh: () => void
}) {
  if (gateState.status === "loading" || gateState.status === "idle") {
    return (
      <>
        <p className="wk-pj-card__copy">Checking your candidate profile and resume status.</p>
        <div className="wk-pj-disabled">Checking resume…</div>
      </>
    )
  }
  if (gateState.status === "error") {
    return (
      <>
        <p className="wk-pj-card__copy">
          We hit a temporary profile check issue. Your interview is still locked until your
          profile and resume are verified.
        </p>
        <button className="wk-btn wk-btn--secondary wk-btn--block" type="button" onClick={onRefresh}>
          Check profile again
        </button>
        <p className="wk-pj-card__note">If you have not uploaded a resume yet, add it below first.</p>
      </>
    )
  }
  if (gateState.status !== "ready") return null
  const gate = gateState.gate
  if (gate.status === "needs_resume_upload") {
    return (
      <>
        <p className="wk-pj-card__copy">
          Add your resume first. We'll parse it, label your profile, then unlock Claire's
          5-minute screen for this role.
        </p>
        <div className="wk-pj-disabled">Upload resume to continue</div>
      </>
    )
  }
  if (gate.status === "resume_processing") {
    return (
      <>
        <p className="wk-pj-card__copy">
          Your resume is being parsed and labeled. Claire's 5-minute screen unlocks after that
          finishes.
        </p>
        <ProcessSteps activeStep={3} />
        <button className="wk-btn wk-btn--secondary wk-btn--block" type="button" onClick={onRefresh}>
          Check again
        </button>
      </>
    )
  }
  return (
    <>
      <p className="wk-pj-card__copy">
        Claire will ask a few quick role-fit questions over iMessage, attached to your
        WeKruit candidate profile.
      </p>
      {smsHref ? (
        <a className="wk-btn wk-btn--primary wk-btn--block" href={smsHref} onClick={onSmsClick}>
          Open in iMessage <Icon name="arrow-right" size={16} stroke={2} />
        </a>
      ) : (
        <p className="wk-error">WeKruit messaging is temporarily unavailable.</p>
      )}
      {smsClicked ? (
        <p className="wk-success">Continue in iMessage to answer Claire.</p>
      ) : null}
    </>
  )
}

function InlineCvSection({
  jobId,
  requestedUserId,
  uploadUserId,
  userSignedIn,
  gateStatus,
  onUploaded,
}: InlineCvSectionProps) {
  if (!userSignedIn) {
    return (
      <div className="wk-pj-cv">
        <p className="wk-eyebrow">Resume</p>
        <p className="wk-pj-card__copy">Sign in first so your resume attaches to your WeKruit candidate profile.</p>
      </div>
    )
  }
  if (gateStatus === "ready") {
    return <p className="wk-success">We have your resume on file.</p>
  }
  if (gateStatus === "resume_processing") {
    return (
      <div className="wk-pj-cv">
        <p className="wk-eyebrow">Resume</p>
        <p className="wk-pj-card__copy">Resume uploaded. We are finishing parsing and labeling before the employer screen opens.</p>
        <ProcessSteps activeStep={3} />
      </div>
    )
  }
  return (
    <div className="wk-pj-cv">
      <p className="wk-eyebrow">Resume</p>
      <p className="wk-pj-card__copy">PDF or DOCX, under 5 MB. We will use it to tailor the pre-screen.</p>
      <InlineCvUpload
        jobId={jobId}
        requestedUserId={requestedUserId}
        uploadUserId={uploadUserId}
        onUploaded={onUploaded}
      />
    </div>
  )
}

interface InlineCvUploadProps {
  jobId: string
  requestedUserId: string
  uploadUserId?: string
  onUploaded: () => void
}

function InlineCvUpload({ jobId, requestedUserId, uploadUserId, onUploaded }: InlineCvUploadProps) {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<"idle" | "uploading" | "ok" | "err">("idle")
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<{ resumeId?: string; resumeArtifactId?: string } | null>(null)

  useEffect(() => {
    setStatus("idle")
    setErrMsg(null)
    setUploadResult(null)
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
    if (!uploadUserId) {
      setStatus("err")
      setErrMsg("Sign in again before uploading your resume.")
      return
    }
    try {
      setStatus("uploading")
      setErrMsg(null)
      const b64 = await fileToBase64(file)
      const res = await fetch(CV_INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: uploadUserId,
          browserUid: requestedUserId,
          resumeBase64: b64,
          resumeName: file.name,
          jobIdContext: jobId,
          source: "public_job_page",
        }),
      })
      if (!res.ok) {
        let reason = `Upload failed (${res.status})`
        try {
          const body = (await res.json()) as { reason?: string }
          if (body.reason) reason = friendlyUploadError(body.reason, res.status)
        } catch {
          // Keep the HTTP fallback.
        }
        setStatus("err")
        setErrMsg(reason)
        return
      }
      const body = (await res.json().catch(() => ({}))) as {
        resumeId?: string
        resumeArtifactId?: string
      }
      setUploadResult({
        resumeId: body.resumeId,
        resumeArtifactId: body.resumeArtifactId,
      })
      setStatus("ok")
      onUploaded()
    } catch (err) {
      setStatus("err")
      setErrMsg("We could not upload the resume. Check your connection and try again.")
    }
  }

  const activeStep = status === "ok" ? 4 : status === "uploading" ? 3 : file ? 1 : 0

  return (
    <form onSubmit={onSubmit} className="wk-pj-upload">
      <input
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={status === "uploading" || status === "ok"}
      />
      <div className="wk-pj-upload__panel" aria-live="polite">
        <p className="wk-pj-upload__status">
          {uploadStatusText(status, file, uploadResult)}
        </p>
        <ProcessSteps activeStep={activeStep} />
      </div>
      <button
        type="submit"
        className="wk-btn wk-btn--primary wk-btn--block"
        disabled={!file || status === "uploading" || status === "ok"}
      >
        {status === "uploading" ? "Uploading…" : "Upload"}
      </button>
      {status === "err" && errMsg ? <p className="wk-error">{errMsg}</p> : null}
    </form>
  )
}

function uploadStatusText(
  status: "idle" | "uploading" | "ok" | "err",
  file: File | null,
  uploadResult: { resumeId?: string; resumeArtifactId?: string } | null
): string {
  if (status === "uploading") {
    return "Uploading, parsing, and labeling your resume. This can take around 20-40 seconds."
  }
  if (status === "ok") {
    return uploadResult?.resumeId
      ? "Resume parsed. Checking whether Claire's screen is ready to unlock."
      : "Upload received. Checking whether Claire's screen is ready to unlock."
  }
  if (status === "err") return "Resume upload did not finish."
  return file ? `${file.name} selected. Upload it to continue.` : "Choose a PDF or DOCX resume to start."
}

function friendlyUploadError(reason: string, status: number): string {
  switch (reason) {
    case "not_a_pdf":
    case "unsupported_resume_format":
      return "Use a text-based PDF or DOCX resume."
    case "docx_parse_failed":
      return "We could not read this DOCX. Try exporting it as a text-based PDF."
    case "resume_too_large":
      return "Use a resume under 5 MB."
    case "llm_parse_failed":
    case "pdf_parse_failed":
      return "We could not read this resume. Try a cleaner text-based PDF."
    case "identity_conflict":
      return "This resume appears to belong to another profile. Use the resume for this signed-in account."
    case "missing_userId_or_tempUserId":
      return "Sign in again before uploading your resume."
    default:
      return `Upload failed (${status}). Try again.`
  }
}

function ProcessSteps({ activeStep }: { activeStep: number }) {
  const steps = ["Select file", "Upload", "Parse resume", "Unlock screen"]
  return (
    <ol className="wk-pj-steps" aria-label="Resume upload progress">
      {steps.map((step, index) => {
        const number = index + 1
        const state = activeStep >= number ? "complete" : activeStep === number - 1 ? "active" : "pending"
        return (
          <li key={step} className={`wk-pj-steps__item wk-pj-steps__item--${state}`}>
            <span>{number}</span>
            {step}
          </li>
        )
      })}
    </ol>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Visual layer — editorial hero + sticky side card.
// Slots host the existing CV / prescreen / login UI so the auth + upload logic
// above stays untouched.
// ────────────────────────────────────────────────────────────────────────────

interface PaJobView {
  jobTitle: string
  company: string
  location?: string
  salary?: string
  jobType?: string
  descriptionMd?: string
  collaborated: boolean
  hiringManager?: {
    name?: string
    title?: string
    online?: boolean
    photoUrl?: string
  }
  interviewSeats?: number
  logo: string
  logoBg: string
  tone: "warm" | "moss" | "slate"
}

interface PublicJobLayoutProps {
  job: PaJobView
  startSlot: ReactNode
  cvSlot: ReactNode
  smsHint?: ReactNode
}

export function PublicJobLayout({ job, startSlot, cvSlot, smsHint }: PublicJobLayoutProps) {
  const hm = job.hiringManager
  const hmFirst = hm?.name?.split(" ")[0]
  const seats = job.interviewSeats ?? 3

  return (
    <CandidateShell>
      <style>{PUBLIC_JOB_STYLES}</style>

      <div className="wk-pj">
        <div className="wk-container wk-pj__top">
          <Link to="/" className="wk-pj__back">
            <Icon name="arrow-left" size={14} stroke={2} /> Back to open interviews
          </Link>
        </div>

        <section className="wk-pj-hero">
          <div className="wk-container wk-pj-hero__grid">
            <div className="wk-pj-hero__copy">
              <div className="wk-pj-hero__company">
                <CompanyMark logo={job.logo} bg={job.logoBg} size={56} />
                <div className="wk-pj-hero__company-text">
                  <p className="wk-eyebrow">
                    Interview · {job.company}
                    {job.collaborated ? <> · <span className="wk-pj-collab">WeKruit collaborated</span></> : null}
                  </p>
                  <h1 className="wk-pj-hero__role">{job.jobTitle}</h1>
                </div>
              </div>
              <p className="wk-pj-hero__lede">
                You're not applying. You're interviewing — directly with the hiring manager once
                Claire confirms you're a fit. Five minutes with Claire, then a calendar invite.
                That's the whole loop.
              </p>

              {hm?.name ? (
                <div className="wk-pj-hm">
                  <Avatar name={hm.name} src={hm.photoUrl} size={64} tone={job.tone} />
                  <div className="wk-pj-hm__body">
                    <p className="wk-eyebrow">Your interviewer</p>
                    <h2 className="wk-pj-hm__name">Interview with {hm.name}</h2>
                    <p className="wk-pj-hm__title">
                      {hm.title}{job.company ? ` · ${job.company}` : ""}
                    </p>
                  </div>
                  {hm.online ? <LiveStatusPill>Online now</LiveStatusPill> : null}
                </div>
              ) : null}

              <ul className="wk-pj-bullets">
                <li>
                  <span className="wk-pj-bullets__icon"><Icon name="clock" size={16} stroke={1.6} /></span>
                  <div>
                    <strong>15-minute video call</strong>
                    <p>Real conversation about the role and your fit. No coding test.</p>
                  </div>
                </li>
                <li>
                  <span className="wk-pj-bullets__icon"><Icon name="video" size={16} stroke={1.6} /></span>
                  <div>
                    <strong>Direct{hmFirst ? ` with ${hmFirst}` : " with the hiring manager"}</strong>
                    <p>No recruiter screen, no take-home, no panel. You and the decision-maker.</p>
                  </div>
                </li>
                <li>
                  <span className="wk-pj-bullets__icon"><Icon name="check" size={16} stroke={2} /></span>
                  <div>
                    <strong>Claire screens you first</strong>
                    <p>
                      Pass and you go straight to {hmFirst ? `${hmFirst}'s` : "the hiring manager's"} calendar
                      — usually within 48 hours.
                    </p>
                  </div>
                </li>
              </ul>
            </div>

            <aside className="wk-pj-side">
              <div className="wk-pj-card">
                <div className="wk-pj-card__head">
                  <p className="wk-eyebrow">Start your interview</p>
                  <h3 className="wk-pj-card__title">Five minutes with Claire</h3>
                </div>
                <div className="wk-pj-card__slot">{cvSlot}</div>
                <div className="wk-pj-card__slot">{startSlot}</div>
                {smsHint ? (
                  <p className="wk-pj-fine">{smsHint}</p>
                ) : (
                  <p className="wk-pj-fine">
                    <Icon name="lock" size={13} stroke={1.6} /> Your résumé stays private.
                    Employers only see your profile after you pass Claire's screen.
                  </p>
                )}
              </div>

              <div className="wk-pj-side-meta">
                {job.location ? (
                  <span className="wk-pj-side-meta__row">
                    <Icon name="pin" size={14} stroke={1.6} /> {job.location}
                  </span>
                ) : null}
                {job.salary ? (
                  <span className="wk-pj-side-meta__row">
                    <Icon name="bolt" size={14} stroke={1.6} /> {job.salary}
                  </span>
                ) : null}
                {job.jobType ? (
                  <span className="wk-pj-side-meta__row">
                    <Icon name="sparkle" size={14} stroke={1.6} /> {job.jobType}
                  </span>
                ) : null}
                <span className="wk-pj-side-meta__row">
                  <Icon name="calendar" size={14} stroke={1.6} />
                  {seats} interview {seats === 1 ? "seat" : "seats"} this week
                </span>
                {job.collaborated ? (
                  <span className="wk-pj-side-meta__row">
                    <PulseDot size={6} /> WeKruit collaborated with this team
                  </span>
                ) : null}
              </div>
            </aside>
          </div>
        </section>

        {job.descriptionMd ? (
          <section className="wk-pj-body">
            <div className="wk-container wk-pj-body__grid">
              <div className="wk-pj-body__main">
                <h2 className="wk-pj-body__h2">About this role.</h2>
                <div className="wk-pj-copy">{job.descriptionMd}</div>
              </div>
              <aside className="wk-pj-body__aside">
                <p className="wk-eyebrow">Process</p>
                <ol className="wk-pj-process">
                  <li><strong>Claire screen.</strong> 5 min, iMessage.</li>
                  <li><strong>15 min{hmFirst ? ` with ${hmFirst}` : ""}.</strong> Video.</li>
                  <li><strong>Working session.</strong> 90 min, paid.</li>
                  <li><strong>Offer.</strong> Same week if it's a match.</li>
                </ol>
              </aside>
            </div>
          </section>
        ) : null}
      </div>
    </CandidateShell>
  )
}

export function PublicJobLoading() {
  return (
    <CandidateShell>
      <style>{PUBLIC_JOB_STYLES}</style>
      <div className="wk-pj-loading wk-container">
        <p className="wk-eyebrow">Interview</p>
        <h1 className="wk-pj-hero__role">Loading…</h1>
        <p className="wk-pj-hero__lede">Pulling the role and your interview status.</p>
      </div>
    </CandidateShell>
  )
}

export function PublicJob404({ message }: { message?: string }) {
  return (
    <CandidateShell>
      <style>{PUBLIC_JOB_STYLES}</style>
      <div className="wk-pj-404 wk-container">
        <p className="wk-eyebrow">404</p>
        <h1 className="wk-pj-hero__role">
          That interview <em className="wk-accent">isn't</em> open.
        </h1>
        <p className="wk-pj-hero__lede">{message ?? "It may have filled or been pulled back."}</p>
        <Link to="/" className="wk-btn wk-btn--primary">
          See open interviews <Icon name="arrow-right" size={16} stroke={2} />
        </Link>
      </div>
    </CandidateShell>
  )
}

export const PUBLIC_JOB_STYLES = `
.wk-pj { background: var(--wk-cream); padding-bottom: 32px; }
.wk-pj__top { padding-top: 24px; }
.wk-pj__back {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--wk-ink-3); text-decoration: none;
  font-size: 14px; font-weight: 500;
  transition: color 200ms var(--wk-ease);
}
.wk-pj__back:hover { color: var(--wk-ink); }

.wk-pj-collab { color: var(--wk-live); font-weight: 600; }

/* Hero ----------------------------------------------------------------- */
.wk-pj-hero {
  background:
    radial-gradient(ellipse 80% 70% at 50% 30%, var(--wk-peach-glow) 0%, transparent 60%),
    radial-gradient(ellipse 60% 50% at 0% 50%, rgba(246,214,190,.45) 0%, transparent 55%),
    radial-gradient(ellipse 60% 50% at 100% 50%, rgba(246,214,190,.45) 0%, transparent 55%),
    var(--wk-cream);
  padding: 32px 0 80px;
}
.wk-pj-hero__grid {
  display: grid;
  grid-template-columns: 1.05fr 0.95fr;
  gap: 56px; align-items: start;
}
.wk-pj-hero__copy { display: flex; flex-direction: column; gap: 28px; }
.wk-pj-hero__company { display: flex; align-items: center; gap: 14px; }
.wk-pj-hero__company-text { min-width: 0; flex: 1; }
.wk-pj-hero__role {
  font-family: 'Newsreader', serif;
  font-weight: 400;
  font-size: clamp(34px, 4.8vw, 56px);
  line-height: 1.05;
  letter-spacing: -0.024em;
  color: var(--wk-ink);
  margin: 6px 0 0;
  text-wrap: balance;
}
.wk-pj-hero__lede {
  font-size: clamp(16.5px, 1.4vw, 18.5px);
  line-height: 1.5; color: var(--wk-ink-2);
  max-width: 580px; margin: 0;
}

.wk-pj-hm {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center; gap: 18px;
  padding: 20px 22px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
}
.wk-pj-hm__body { min-width: 0; }
.wk-pj-hm__name {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 24px; line-height: 1.15;
  letter-spacing: -0.02em; color: var(--wk-ink);
  margin: 4px 0;
}
.wk-pj-hm__title { color: var(--wk-ink-3); font-size: 14px; margin: 0; }

.wk-pj-bullets {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: 14px;
}
.wk-pj-bullets li {
  display: grid; grid-template-columns: 32px 1fr; gap: 14px; align-items: start;
}
.wk-pj-bullets__icon {
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--wk-cream-2); color: var(--wk-ink-2);
  display: inline-flex; align-items: center; justify-content: center;
}
.wk-pj-bullets li strong {
  display: block; color: var(--wk-ink); font-weight: 600;
  font-size: 15.5px; margin-bottom: 2px;
}
.wk-pj-bullets li p { margin: 0; color: var(--wk-ink-2); font-size: 14.5px; line-height: 1.45; }

/* Side ----------------------------------------------------------------- */
.wk-pj-side { display: flex; flex-direction: column; gap: 14px; }
.wk-pj-card {
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-lg);
  padding: 24px;
  display: flex; flex-direction: column; gap: 18px;
  box-shadow: 0 8px 24px -8px rgba(45,26,10,.10);
}
.wk-pj-card__head { display: grid; gap: 4px; }
.wk-pj-card__title {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: 26px; line-height: 1.15;
  letter-spacing: -0.02em; color: var(--wk-ink); margin: 0;
}
.wk-pj-card__slot { display: grid; gap: 10px; }
.wk-pj-card__copy { color: var(--wk-ink-2); font-size: 14.5px; line-height: 1.5; margin: 0; }
.wk-pj-card__note { color: var(--wk-ink-3); font-size: 13px; margin: 0; }
.wk-pj-fine {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--wk-ink-3); font-size: 12.5px;
  margin: 0; text-align: left; line-height: 1.5;
  flex-wrap: wrap;
}
.wk-pj-fine a, .wk-pj-fine .wk-link { color: var(--wk-ink-2); }

.wk-pj-disabled {
  min-height: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0 16px; border-radius: var(--wk-r-pill);
  background: var(--wk-cream-2); color: var(--wk-ink-3);
  border: 1px solid var(--wk-border);
  font-size: 14px; font-weight: 500;
}

.wk-pj-side-meta {
  display: flex; flex-direction: column; gap: 8px;
  padding: 16px 22px;
  background: var(--wk-cream-2);
  border-radius: var(--wk-r-md);
  border: 1px solid var(--wk-border);
}
.wk-pj-side-meta__row {
  display: inline-flex; align-items: center; gap: 8px;
  color: var(--wk-ink-2); font-size: 13.5px;
}
.wk-pj-side-meta__row svg { color: var(--wk-ink-3); }

/* Inline login controls inside the start card ------------------------- */
.wk-pj-login { display: grid; gap: 10px; }
.wk-pj-login__divider {
  display: flex; align-items: center; gap: 10px;
  color: var(--wk-ink-3); font-size: 11.5px; margin: 2px 0;
  text-transform: uppercase; letter-spacing: 0.08em;
}
.wk-pj-login__divider::before,
.wk-pj-login__divider::after {
  content: ""; flex: 1; height: 1px; background: var(--wk-border);
}
.wk-pj-login__email { display: grid; gap: 6px; }
.wk-pj-login__email label {
  color: var(--wk-ink-2); font-size: 12.5px; font-weight: 500;
}
.wk-pj-login__email > div {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px;
}
.wk-pj-login__email input {
  min-width: 0;
  font-family: inherit; font-size: 14.5px;
  color: var(--wk-ink); background: var(--wk-cream);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  padding: 10px 12px;
  transition: border-color 200ms var(--wk-ease);
}
.wk-pj-login__email input:focus {
  outline: none; border-color: var(--wk-ink);
  box-shadow: 0 0 0 3px rgba(45,26,10,.08);
}

/* CV upload card ------------------------------------------------------- */
.wk-pj-cv { display: grid; gap: 10px; }
.wk-pj-upload { display: grid; gap: 10px; }
.wk-pj-upload input[type="file"] {
  font-family: inherit; font-size: 13.5px;
  color: var(--wk-ink-2);
}
.wk-pj-upload__panel {
  display: grid; gap: 10px;
  padding: 12px 14px;
  background: var(--wk-cream-2);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
}
.wk-pj-upload__status {
  margin: 0; color: var(--wk-ink-2); font-size: 13.5px; line-height: 1.45;
}
.wk-pj-steps {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: 6px;
}
.wk-pj-steps__item {
  display: grid; grid-template-columns: 22px minmax(0, 1fr);
  gap: 8px; align-items: center;
  color: var(--wk-ink-3); font-size: 12.5px; font-weight: 500;
}
.wk-pj-steps__item span {
  width: 22px; height: 22px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--wk-border);
  background: var(--wk-cream-3);
  color: var(--wk-ink-3); font-size: 11.5px;
}
.wk-pj-steps__item--complete,
.wk-pj-steps__item--active { color: var(--wk-ink); }
.wk-pj-steps__item--complete span,
.wk-pj-steps__item--active span {
  background: var(--wk-ink); border-color: var(--wk-ink); color: var(--wk-cream);
}

/* Body ----------------------------------------------------------------- */
.wk-pj-body { padding: 64px 0 0; }
.wk-pj-body__grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 56px; }
.wk-pj-body__h2 {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: clamp(28px, 3.4vw, 40px);
  line-height: 1.1; letter-spacing: -0.02em;
  color: var(--wk-ink); margin: 0 0 20px;
}
.wk-pj-copy {
  color: var(--wk-ink-2); font-size: 16.5px; line-height: 1.6;
  white-space: pre-wrap; max-width: 60ch;
}
.wk-pj-body__aside {
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  padding: 24px; align-self: start;
  position: sticky; top: 96px;
}
.wk-pj-process {
  list-style: none; padding: 0; margin: 8px 0 0;
  counter-reset: step;
  display: grid; gap: 12px;
}
.wk-pj-process li {
  counter-increment: step;
  padding-left: 30px; position: relative;
  color: var(--wk-ink-2); font-size: 14.5px;
}
.wk-pj-process li::before {
  content: counter(step, decimal-leading-zero);
  position: absolute; left: 0; top: 0;
  font-family: 'Newsreader', serif; font-style: italic;
  font-weight: 400; font-size: 14px;
  color: var(--wk-peach-300); letter-spacing: -0.01em;
}
.wk-pj-process strong { color: var(--wk-ink); font-weight: 600; }

.wk-pj-loading, .wk-pj-404 {
  padding: 80px 24px;
  display: grid; gap: 16px;
  max-width: 720px;
  text-align: left;
}

/* Login modal --------------------------------------------------------- */
.wk-pj-modal-wrap {
  position: fixed; inset: 0; z-index: 40;
  display: grid; place-items: center;
  padding: 20px;
}
.wk-pj-modal-scrim {
  position: absolute; inset: 0; z-index: 0;
  border: 0; cursor: pointer;
  background: rgba(45,26,10,.42);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.wk-pj-modal {
  position: relative; z-index: 1;
  box-sizing: border-box;
  width: min(460px, calc(100vw - 24px));
  display: grid; gap: 14px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-lg);
  padding: 28px;
  box-shadow: 0 24px 80px rgba(45,26,10,.28);
}
.wk-pj-modal__h {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: clamp(24px, 3vw, 30px);
  line-height: 1.1; letter-spacing: -0.022em;
  color: var(--wk-ink); margin: 4px 0 0;
}
.wk-pj-modal__sub {
  color: var(--wk-ink-2); font-size: 14.5px; line-height: 1.5; margin: 0;
}
.wk-pj-modal__close {
  position: absolute; top: 12px; right: 12px;
  width: 32px; height: 32px; border-radius: 50%;
  border: 1px solid var(--wk-border);
  background: var(--wk-cream); color: var(--wk-ink-2);
  font: inherit; font-size: 18px; line-height: 1;
  cursor: pointer;
  transition: background 200ms var(--wk-ease), color 200ms var(--wk-ease);
}
.wk-pj-modal__close:hover { background: var(--wk-ink); color: var(--wk-cream); }

/* Mobile --------------------------------------------------------------- */
@media (max-width: 980px) {
  .wk-pj-hero__grid { grid-template-columns: 1fr; gap: 32px; }
  .wk-pj-body__grid { grid-template-columns: 1fr; gap: 32px; }
  .wk-pj-body__aside { position: static; }
  .wk-pj-hm { grid-template-columns: auto 1fr; }
  .wk-pj-hm .wk-live-pill { grid-column: 1 / -1; justify-self: start; }
}
`
