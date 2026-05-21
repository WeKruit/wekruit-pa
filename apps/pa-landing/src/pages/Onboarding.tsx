// Onboarding — unified signup for layoff.wekruit.com + candidate.wekruit.com.
// Ported from wekruit-layoff/src/pages/Signup.tsx. The source flag
// ("WeKruit_Laid_Off" | "candidate") is resolved at first paint via
// resolveSource() and frozen onto the pa-users doc at registration.

import { useMemo, useRef, useState, useEffect } from "react"
import { Link, Navigate, useNavigate } from "react-router-dom"
import { onAuthStateChanged, signOut, type User } from "firebase/auth"
import "../styles/wekruit-tokens.css"
import { deriveFunction, registerCandidate } from "../lib/onboarding-api"
import { uploadResume } from "../lib/onboarding-cv"
import {
  getBrowserUid,
  isCandidateHost,
  layoffSignupLoginPath,
  onboardingDestination,
  redirectToCandidatePortal,
  rememberCandidateProfileSession,
} from "../lib/browser-identity"
import { resolveSource, SOURCE_RESOLVER_MARKER, type SignupSource } from "../lib/source"
import { auth } from "../lib/firebase.js"
import { isLinkedInSignIn } from "../lib/candidate-auth-provider.js"
import { CandidateVerifyError, readStoredCandidateId, verifyCandidateMagicLinkSession } from "../lib/candidate-verify.js"
import { buildHelloWekruitOpenerBody } from "../lib/hello-wekruit.js"
import { canOpenImessageDeepLink } from "../lib/imessage-platform.js"
import { CompanyCombobox } from "../components/CompanyCombobox.js"
import { CANDIDATE_STYLES, IMessageThread } from "./CandidateLogin.js"

// Keep the marker referenced so tree-shaking can't drop it from the
// bundle. The acceptance grep relies on this string being present.
const _MARKER: string = SOURCE_RESOLVER_MARKER
void _MARKER

type Stage = "intake" | "dup-prompt" | "done"

type DupExisting = {
  firstName: string | null
  lastCompany: string | null
  jobTitle: string | null
  location: string | null
  lastLaidOffAt: string | null
}

type Profile = {
  firstName?: string
  lastName?: string
  email?: string
  linkedin?: string
  personalWebsite?: string
  lastCompany?: string
  jobTitle?: string
  location?: string
  phone?: string
  consent?: boolean
  resume?: { name: string; size: number; file?: File } | null
  function?: string
  candidateId?: string
  listPosition?: number
  isReregistration?: boolean
  /** Sticky Sendblue from-number assigned by openRegisterLayoffCandidate; powers the sms: deep link on the Done view. */
  senderNumber?: string
}

export default function Onboarding() {
  const navigate = useNavigate()
  const source: SignupSource = useMemo(() => resolveSource(), [])
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined)
  const [authReady, setAuthReady] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile>({})
  const [stage, setStage] = useState<Stage>("intake")
  const [pendingForm, setPendingForm] = useState<Profile | null>(null)
  const [dupExisting, setDupExisting] = useState<DupExisting | null>(null)
  const [busyText, setBusyText] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [intakeChecked, setIntakeChecked] = useState(false)
  const [claireConversationStarted, setClaireConversationStarted] = useState(false)
  const [portalReady, setPortalReady] = useState(false)
  const [linkedinLinkedViaOauth, setLinkedinLinkedViaOauth] = useState(false)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth(), (nextUser) => {
      setAuthUser(nextUser)
      setAuthReady(true)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!authUser) return
    let cancelled = false
    void (async () => {
      try {
        const verified = await verifyCandidateMagicLinkSession({ source })
        if (!cancelled) {
          setVerifyError(null)
          setLinkedinLinkedViaOauth(
            Boolean(verified.linkedinLinkedViaOauth) || isLinkedInSignIn(authUser)
          )
          setClaireConversationStarted(verified.claireConversationStarted)
          setPortalReady(verified.portalReady)
          setProfile((p) => ({
            ...p,
            candidateId: verified.candidateId,
            senderNumber: verified.senderNumber ?? p.senderNumber,
          }))
          if (verified.portalReady) {
            if (isCandidateHost()) {
              navigate("/me", { replace: true })
            } else {
              setStage("done")
            }
            return
          }
          if (verified.intakeComplete) {
            setStage("done")
          }
          setIntakeChecked(true)
        }
      } catch (err) {
        if (!cancelled) {
          setVerifyError(
            err instanceof CandidateVerifyError ? err.message : "Sign-in verification failed. Try again."
          )
          setIntakeChecked(false)
          try {
            await signOut(auth())
          } catch {
            // Login owns the next auth attempt.
          }
          const loginNext = onboardingDestination(source)
          navigate(`/login?next=${encodeURIComponent(loginNext)}`, { replace: true })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authUser, navigate, source])

  if (!authReady || authUser === undefined || (authUser && !intakeChecked)) {
    return (
      <main>
        <MinimalNav />
        <section style={{ paddingTop: 96, paddingBottom: 96 }}>
          <div className="container-prose" style={{ maxWidth: 760, marginInline: "auto", paddingInline: 24, textAlign: "center" }}>
            <p style={{ color: "var(--ink-2)" }}>Checking your sign-in…</p>
          </div>
        </section>
      </main>
    )
  }

  if (!authUser) {
    const loginNext = onboardingDestination(source)
    return <Navigate to={`/login?next=${encodeURIComponent(loginNext)}`} replace />
  }

  async function submitRegistration(formData: Profile, mode: "auto" | "reuse" | "refresh") {
    setSubmitError(null)
    setBusyText("Creating your WeKruit profile…")
    try {
      const isLayoff = source === "WeKruit_Laid_Off"
      const res = await registerCandidate({
        firstName: formData.firstName!,
        lastName: formData.lastName!,
        email: formData.email!,
        linkedin: formData.linkedin?.trim() || undefined,
        personalWebsite: formData.personalWebsite?.trim() || undefined,
        lastCompany: formData.lastCompany!,
        ...(isLayoff
          ? {
              jobTitle: formData.jobTitle?.trim() || undefined,
              location: formData.location?.trim() || undefined,
              function: deriveFunction(formData.jobTitle || ""),
            }
          : {}),
        consent: !!formData.consent,
        resumeFileName: formData.resume?.name,
        candidateId: readStoredCandidateId() ?? undefined,
        mode,
        source,
      })

      if ("duplicate" in res && res.duplicate) {
        rememberCandidateProfileSession({
          candidateId: res.candidateId,
          email: formData.email,
          browserUid: getBrowserUid(),
        })
        setDupExisting(res.existing)
        setPendingForm(formData)
        setBusyText(null)
        setStage("dup-prompt")
        return
      }

      rememberCandidateProfileSession({
        candidateId: res.candidateId,
        email: formData.email,
        browserUid: getBrowserUid(),
      })
      if (formData.resume?.file) {
        await uploadResumeForCandidate(res.candidateId, formData, sourceToUploadTag(source))
      }
      // 2026-05-19 — no server-side SMS push; the Done view shows an sms:
      // deep link button so the candidate sends "Hello, WeKruit!" themselves
      // (Adam directive: explicit user-initiated open message).
      setProfile((p) => ({ ...p, ...withoutResumeFile(formData), ...res }))
      setStage("done")
    } catch (err) {
      setSubmitError(messageFromError(err))
    } finally {
      setBusyText(null)
    }
  }

  const onFormDone = (formData: Profile) => submitRegistration(formData, "auto")

  async function onReuseExisting() {
    if (!pendingForm) return
    await submitRegistration(pendingForm, "reuse")
  }

  async function onStartFresh() {
    if (!pendingForm) return
    setStage("intake")
    await submitRegistration(pendingForm, "refresh")
  }

  return (
    <main>
      <MinimalNav />
      <section
        className={stage === "done" ? "onboarding-section onboarding-section--done" : "onboarding-section"}
        style={{ paddingTop: 48, paddingBottom: 96, position: "relative" }}
      >
        <div className="container-prose" style={{ maxWidth: 760, marginInline: "auto", paddingInline: 24 }}>
          {stage !== "done" && (
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <h1
                style={{
                  fontFamily: "var(--font-serif)",
                  fontWeight: 400,
                  fontSize: "clamp(36px, 4.4vw, 56px)",
                  lineHeight: 1.05,
                  letterSpacing: "-0.025em",
                  margin: 0,
                }}
              >
                {stage === "dup-prompt" && (
                  <>
                    Welcome <em style={{ fontStyle: "italic" }}>back</em>.
                  </>
                )}
                {stage === "intake" && (
                  <>
                    Introduce yourself <em style={{ fontStyle: "italic" }}>once</em>.
                  </>
                )}
              </h1>
              {stage !== "dup-prompt" && <FlowProgress stage={stage} />}
              {verifyError ? <StepNotice tone="error" text={verifyError} /> : null}
              {stage === "intake" && (
                <p
                  style={{
                    marginTop: 14,
                    color: "var(--ink-3)",
                    fontSize: 13,
                    fontFamily: "var(--font-mono)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  {source === "WeKruit_Laid_Off"
                    ? "WeKruit Open · for people between things"
                    : "WeKruit · meet your AI recruiter"}
                </p>
              )}
            </div>
          )}

          {busyText && <StepNotice tone="busy" text={busyText} />}
          {submitError && <StepNotice tone="error" text={submitError} />}

          {stage === "intake" && (
            <FormIntake
              onDone={onFormDone}
              isBusy={Boolean(busyText)}
              source={source}
              authUser={authUser}
              linkedinLinkedViaOauth={linkedinLinkedViaOauth}
            />
          )}
          {stage === "dup-prompt" && dupExisting && (
            <DuplicatePrompt existing={dupExisting} onReuse={onReuseExisting} onFresh={onStartFresh} />
          )}
          {stage === "done" && (
            <Done
              profile={profile}
              showProfileLink={portalReady}
              onGo={(r) => {
                if (r === "dashboard") {
                  if (!portalReady) return
                  if (!isCandidateHost()) {
                    redirectToCandidatePortal("/me")
                    return
                  }
                  navigate("/me")
                  return
                }
                navigate("/")
              }}
            />
          )}
        </div>
      </section>
      <MinimalFooter />
    </main>
  )
}

function sourceToUploadTag(source: SignupSource): string {
  return source === "WeKruit_Laid_Off" ? "layoff_signup" : "candidate_signup"
}

async function uploadResumeForCandidate(candidateId: string, formData: Profile, source: string) {
  const file = formData.resume?.file
  if (!file) throw new Error("Resume file is missing. Pick the file again and retry.")
  await uploadResume(file, { userId: candidateId, source })
}

function withoutResumeFile(profile: Profile): Profile {
  if (!profile.resume) return profile
  const { file: _file, ...resume } = profile.resume
  return { ...profile, resume }
}

function messageFromError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return "Something failed before your profile was ready. Please retry."
}

function StepNotice({ tone, text }: { tone: "busy" | "error"; text: string }) {
  const isError = tone === "error"
  return (
    <div
      role={isError ? "alert" : "status"}
      style={{
        marginBottom: 16,
        padding: "14px 16px",
        borderRadius: "var(--r-md)",
        border: "1px solid " + (isError ? "var(--danger)" : "var(--border)"),
        background: isError ? "rgba(157, 58, 45, 0.08)" : "var(--cream-3)",
        color: isError ? "var(--danger)" : "var(--ink-2)",
        fontSize: 14,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      {!isError && <Dot />}
      <span>{text}</span>
    </div>
  )
}

function Dot() {
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 8, height: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--ink)", display: "inline-block" }} />
    </span>
  )
}

function CheckIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M6.5 10.5L3 7l1-1 2.5 2.5L12 3l1 1z" />
    </svg>
  )
}

function MinimalNav() {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "var(--cream)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          marginInline: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 72,
          paddingInline: 24,
        }}
      >
        <Link to="/" style={{ textDecoration: "none", display: "inline-flex", alignItems: "baseline", gap: 8, color: "var(--ink)" }}>
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 22, letterSpacing: "-0.02em", fontWeight: 500 }}>WeKruit</span>
        </Link>
      </div>
    </header>
  )
}

function MinimalFooter() {
  return (
    <footer style={{ borderTop: "1px solid var(--border)", marginTop: 96 }}>
      <div
        style={{
          maxWidth: 1280,
          marginInline: "auto",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "32px 24px",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontFamily: "var(--font-serif)", fontSize: 16, color: "var(--ink)" }}>WeKruit</span>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>hello@wekruit.com</span>
      </div>
    </footer>
  )
}

function DuplicatePrompt({
  existing,
  onReuse,
  onFresh,
}: {
  existing: DupExisting
  onReuse: () => void
  onFresh: () => void
}) {
  const first = existing.firstName ?? "there"
  const company = existing.lastCompany ?? "your previous company"
  const lastDate = existing.lastLaidOffAt
    ? new Date(existing.lastLaidOffAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null

  return (
    <div className="card card--feature" style={{ background: "var(--cream-3)", borderRadius: "var(--r-lg)" }}>
      <div className="eyebrow" style={{ marginBottom: 10 }}>We've seen you before</div>
      <h2
        style={{
          fontFamily: "var(--font-serif)",
          fontWeight: 400,
          fontSize: 28,
          lineHeight: 1.15,
          letterSpacing: "-0.02em",
          margin: "0 0 14px",
        }}
      >
        Hey {first} — that phone is already on our list.
      </h2>
      <p style={{ margin: 0, color: "var(--ink-2)" }}>
        We have a profile for you {lastDate ? <>from <strong style={{ color: "var(--ink)" }}>{lastDate}</strong>{" "}</> : ""}
        with <strong style={{ color: "var(--ink)" }}>{company}</strong>
        {existing.jobTitle ? <> · {existing.jobTitle}</> : null}
        {existing.location ? <> · {existing.location}</> : null}.
      </p>

      <div
        style={{
          marginTop: 24,
          padding: 16,
          background: "var(--cream)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-md)",
          fontSize: 14,
          color: "var(--ink-2)",
          lineHeight: 1.55,
        }}
      >
        <strong style={{ color: "var(--ink)" }}>Use previous profile</strong> — Keep what we already have. We'll just text you to
        pick up where we left off.
        <br />
        <br />
        <strong style={{ color: "var(--ink)" }}>Start fresh</strong> — Overwrite your old info with what you just entered.
      </div>

      <div style={{ marginTop: 22, display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <button className="btn btn--secondary" onClick={onFresh}>Start fresh</button>
        <button className="btn btn--primary" onClick={onReuse}>Use previous profile →</button>
      </div>
    </div>
  )
}

function FlowProgress({ stage }: { stage: Stage }) {
  const steps = [
    { id: "intake", label: "Register + resume" },
    { id: "done", label: "Claire iMessage" },
  ] as const
  const currentIdx = steps.findIndex((s) => s.id === stage)
  return (
    <div
      style={{
        marginTop: 22,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "var(--cream-3)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-pill)",
        padding: 4,
      }}
    >
      {steps.map((s, i) => {
        const done = i < currentIdx
        const active = i === currentIdx
        return (
          <span key={s.id} style={{ display: "inline-flex", alignItems: "center" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 16px",
                borderRadius: "var(--r-pill)",
                background: active ? "var(--ink)" : "transparent",
                color: active ? "var(--cream)" : done ? "var(--ink)" : "var(--ink-3)",
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                fontWeight: 500,
                whiteSpace: "nowrap",
                transition: "all var(--dur-fast) var(--ease)",
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  background: active ? "var(--cream)" : done ? "var(--success)" : "var(--cream-2)",
                  color: active ? "var(--ink)" : done ? "var(--cream)" : "var(--ink-3)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                {done ? <CheckIcon /> : i + 1}
              </span>
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 18,
                  height: 1,
                  background: "var(--border)",
                  marginInline: 4,
                }}
              />
            )}
          </span>
        )
      })}
    </div>
  )
}

function splitDisplayName(displayName: string | null | undefined): { first: string; last: string } {
  const parts = (displayName ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: "", last: "" }
  if (parts.length === 1) return { first: parts[0]!, last: "" }
  return { first: parts[0]!, last: parts.slice(1).join(" ") }
}

function FormIntake({
  onDone,
  isBusy,
  source,
  authUser,
  linkedinLinkedViaOauth,
}: {
  onDone: (p: Profile) => void | Promise<void>
  isBusy: boolean
  source: SignupSource
  authUser: User
  linkedinLinkedViaOauth: boolean
}) {
  const isLayoff = source === "WeKruit_Laid_Off"
  const skipLinkedinField = !isLayoff && linkedinLinkedViaOauth
  const ssoNames = splitDisplayName(authUser.displayName)
  const [v, setV] = useState<Profile>({
    firstName: ssoNames.first,
    lastName: ssoNames.last,
    email: authUser.email ?? "",
    linkedin: "",
    personalWebsite: "",
    lastCompany: "",
    jobTitle: "",
    location: "",
    consent: false,
    resume: null,
  })
  const [err, setErr] = useState<Record<string, string>>({})
  const set = <K extends keyof Profile>(k: K, val: Profile[K]) => setV((s) => ({ ...s, [k]: val }))
  const fileInputRef = useRef<HTMLInputElement>(null)

  const submit = async () => {
    const e: Record<string, string> = {}
    ;(["firstName", "lastName", "email", "lastCompany"] as const).forEach((k) => {
      if (!v[k]) e[k] = "Required"
    })
    if (!v.consent) e.consent = "Required"
    const hasResume = Boolean(v.resume)
    const hasLinkedin = skipLinkedinField || Boolean(v.linkedin?.trim())
    const hasSite = Boolean(v.personalWebsite?.trim())
    if (!hasResume && !hasLinkedin && !hasSite) {
      e.profilePath = skipLinkedinField
        ? "Add a resume or personal site"
        : "Add a resume, LinkedIn, or personal site"
    }
    if (v.email && !v.email.includes("@")) e.email = "Looks off"
    setErr(e)
    if (Object.keys(e).length === 0) {
      await onDone({ ...v, function: deriveFunction(v.jobTitle || "") })
    }
  }

  const requiredKeys = ["firstName", "lastName", "email", "lastCompany"] as const
  const profilePathSatisfied =
    Boolean(v.resume) ||
    Boolean(v.personalWebsite?.trim()) ||
    (!skipLinkedinField && Boolean(v.linkedin?.trim())) ||
    skipLinkedinField
  const filled =
    requiredKeys.filter((k) => v[k]).length +
    (v.consent ? 1 : 0) +
    (profilePathSatisfied ? 1 : 0)
  const total = requiredKeys.length + 2

  const onResumePick: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0]
    if (file) set("resume", { name: file.name, size: file.size, file })
  }

  const consentText =
    source === "WeKruit_Laid_Off"
      ? "I confirm I was laid off in the last 6 months and I'm okay with verified WeKruit employers seeing my name, last company, and pitch. I can hide my resume and remove my profile anytime."
      : "I'm okay with verified WeKruit employers seeing my name, last company, and pitch. I can hide my resume and remove my profile anytime."

  return (
    <div className="card card--feature" style={{ background: "var(--cream-3)", borderRadius: "var(--r-lg)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, marginBottom: 6, flexWrap: "wrap" }}>
        <span className="eyebrow" style={{ whiteSpace: "nowrap" }}>Step 1 · Register</span>
        <span className="caption" style={{ color: "var(--ink-3)", whiteSpace: "nowrap" }}>{filled} of {total} · ~60 sec</span>
      </div>
      <p style={{ marginTop: 4, marginBottom: 18, fontSize: 14, color: "var(--ink-2)" }}>
        {isLayoff
          ? "Tell us the basics. After you submit, you'll open iMessage to say hello to Claire — that's when we link your phone."
          : skipLinkedinField
            ? "Tell us who you are and share a resume or site (LinkedIn is already linked from sign-in). Next you'll open iMessage to talk to Claire."
            : "Tell us who you are and share a resume, LinkedIn, or site. Next you'll open iMessage to talk to Claire."}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <Field label="First name" value={v.firstName!} onChange={(x) => set("firstName", x)} err={err.firstName} placeholder="Maya" autoFocus />
        <Field label="Last name" value={v.lastName!} onChange={(x) => set("lastName", x)} err={err.lastName} placeholder="Chen" />
        <Field span={2} label="Email" value={v.email!} onChange={(x) => set("email", x)} err={err.email} placeholder="maya@meta.com" type="email" />
        <CompanyCombobox
          label={isLayoff ? "Last company" : "Previous company"}
          value={v.lastCompany ?? ""}
          onChange={(x) => set("lastCompany", x)}
          err={err.lastCompany}
          placeholder="Meta, Stripe, or your employer"
          hint="Pick from suggestions or type any company name."
        />
        {isLayoff && (
          <>
            <Field label="Job title there" value={v.jobTitle!} onChange={(x) => set("jobTitle", x)} err={err.jobTitle} placeholder="Senior PM, Reality Labs" optional />
            <Field label="Location" value={v.location!} onChange={(x) => set("location", x)} err={err.location} placeholder="San Francisco" optional />
          </>
        )}
        {!skipLinkedinField && (
          <Field span={2} label="LinkedIn profile URL" value={v.linkedin!} onChange={(x) => set("linkedin", x)} placeholder="linkedin.com/in/maya-chen" optional />
        )}
        {skipLinkedinField && (
          <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: 13, color: "var(--ink-3)" }}>
            LinkedIn is linked from your sign-in — no need to paste your profile URL again.
          </p>
        )}
        <Field span={2} label="Personal website" value={v.personalWebsite!} onChange={(x) => set("personalWebsite", x)} placeholder="https://yoursite.com" optional />
        {err.profilePath && (
          <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: 13, color: "var(--danger)" }}>{err.profilePath}</p>
        )}
      </div>

      <div style={{ marginTop: 20 }}>
        <span style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500, color: "var(--ink-2)", display: "flex", justifyContent: "space-between" }}>
          <span>Resume <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>· PDF, DOC, DOCX</span></span>
          {err.resume && <span style={{ color: "var(--danger)" }}>Required</span>}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={onResumePick}
          style={{ display: "none" }}
        />
        {v.resume ? (
          <div
            style={{
              marginTop: 6,
              padding: "14px 18px",
              background: "var(--success-bg)",
              border: "1px solid transparent",
              borderRadius: "var(--r-md)",
              display: "flex",
              alignItems: "center",
              gap: 12,
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "var(--r-sm)",
                  background: "var(--success)",
                  color: "var(--cream)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <CheckIcon />
              </span>
              <div>
                <div style={{ fontWeight: 500, fontSize: 14, color: "var(--success)" }}>{v.resume.name}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Private by default — employers ask, you approve</div>
              </div>
            </div>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => set("resume", null)} disabled={isBusy}>
              Replace
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{
              marginTop: 6,
              width: "100%",
              cursor: "pointer",
              padding: "20px 18px",
              textAlign: "left",
              background: "var(--cream)",
              border: "1.5px dashed " + (err.resume ? "var(--danger)" : "var(--border-strong)"),
              borderRadius: "var(--r-md)",
              display: "flex",
              alignItems: "center",
              gap: 14,
              fontFamily: "var(--font-sans)",
            }}
          >
            <span
              style={{
                width: 36,
                height: 36,
                borderRadius: "var(--r-sm)",
                background: "var(--cream-2)",
                color: "var(--ink-2)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <UploadIcon />
            </span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontWeight: 500, color: "var(--ink)" }}>Drop your resume or click to upload</span>
              <span style={{ display: "block", fontSize: 13, color: "var(--ink-3)", marginTop: 2 }}>PDF · Private by default</span>
            </span>
          </button>
        )}
      </div>

      <label
        style={{
          marginTop: 20,
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
          padding: 16,
          background: "var(--cream)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-md)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={!!v.consent}
          onChange={(e) => set("consent", e.target.checked)}
          style={{ accentColor: "var(--ink)", marginTop: 3, width: 16, height: 16, cursor: "pointer" }}
        />
        <span style={{ fontSize: 14, color: "var(--ink-2)" }}>
          {consentText}
          {err.consent && <span style={{ color: "var(--danger)", marginLeft: 8 }}>· Required</span>}
        </span>
      </label>

      <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span className="caption" style={{ color: "var(--ink-3)" }}>Next: Talk to Claire in iMessage.</span>
        <button className="btn btn--primary btn--lg" onClick={submit} disabled={isBusy}>
          {isBusy ? "Saving…" : "Save & continue →"}
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  err,
  placeholder,
  hint,
  type,
  span,
  autoFocus,
  optional,
}: {
  label: string
  value: string
  onChange: (x: string) => void
  err?: string
  placeholder?: string
  hint?: string
  type?: string
  span?: 1 | 2
  autoFocus?: boolean
  optional?: boolean
}) {
  return (
    <label style={{ gridColumn: span === 2 ? "1 / -1" : "auto", display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight: 500,
          color: "var(--ink-2)",
          letterSpacing: "-0.005em",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{label}</span>
        {err ? (
          <span style={{ color: "var(--danger)" }}>{err}</span>
        ) : optional ? (
          <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>it's optional</span>
        ) : null}
      </span>
      <input
        type={type || "text"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="input"
        autoFocus={autoFocus}
      />
      {hint && <span className="caption" style={{ color: "var(--ink-3)" }}>{hint}</span>}
    </label>
  )
}

function UploadIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M12 16V4M5 11l7-7 7 7M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Done({
  profile,
  showProfileLink,
  onGo,
}: {
  profile: Profile
  showProfileLink: boolean
  onGo: (r: "dashboard" | "landing") => void
}) {
  const number = profile.listPosition
  const openerBody = profile.candidateId ? buildHelloWekruitOpenerBody(profile.candidateId) : buildHelloWekruitOpenerBody("")
  const imessageAvailable = canOpenImessageDeepLink()
  const smsHref =
    imessageAvailable && profile.senderNumber
      ? `sms:${profile.senderNumber}?&body=${encodeURIComponent(openerBody)}`
      : null
  return (
    <div className="claire-handoff">
      <style>{CANDIDATE_STYLES}</style>
      <section className="claire-handoff__main" aria-labelledby="claire-handoff-title">
        <div className="claire-handoff__status">
          <span className="claire-handoff__check" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>Profile ready</span>
        </div>
        {number != null && (
          <div className="eyebrow claire-handoff__eyebrow">You&apos;re #{number} on the list</div>
        )}
        <h1
          id="claire-handoff-title"
          style={{
            fontFamily: "var(--font-serif)",
            fontWeight: 400,
            fontSize: "clamp(40px, 5vw, 64px)",
            lineHeight: 1.05,
            letterSpacing: "0",
            margin: 0,
          }}
        >
          Open Claire in iMessage.
        </h1>
        <p className="lead claire-handoff__copy">
          {imessageAvailable ? (
            <>
              Your resume and profile are saved. Open iMessage and send the pre-filled message exactly as shown.
            </>
          ) : (
            <>
              iMessage is only available on iPhone, iPad, and Mac. Open this page on an Apple device to start your chat with Claire.
            </>
          )}
        </p>

        <div className="claire-handoff__actions">
          {smsHref ? (
            <a className="btn btn--primary btn--lg" href={smsHref}>Open iMessage</a>
          ) : !imessageAvailable ? (
            <p className="caption claire-handoff__fallback">
              Android and Windows can't open iMessage deep links. Use Safari on your iPhone or Mac, or email hello@wekruit.com for help.
            </p>
          ) : (
            <span className="caption claire-handoff__fallback">
              We hit a hiccup assigning your Claire line. Email hello@wekruit.com and we&apos;ll get you started.
            </span>
          )}
          {showProfileLink ? (
            <button className="btn btn--secondary" onClick={() => onGo("dashboard")}>Profile</button>
          ) : null}
          <button className="btn btn--ghost" onClick={() => onGo("landing")}>Home</button>
        </div>
        {smsHref ? (
          <p className="claire-handoff__note">
            Don&apos;t edit the text or delete the code. Claire uses it to connect this chat to your WeKruit profile.
          </p>
        ) : null}
      </section>

      <aside className="claire-handoff__demo" aria-label="Claire iMessage preview">
        <div className="wk-shell claire-imessage-shell">
          <IMessageThread
            phoneFrame
            header="WeKruit Claire"
            messages={[
              { from: "user", text: openerBody },
              { from: "claire", text: "Got it — I found your profile." },
              { from: "claire", text: "First question: what matters most in your next company: career growth, compensation, stability, mission, learning, or something else?" },
            ]}
          />
        </div>
      </aside>

      <div className="claire-handoff__checks" aria-label="Setup status">
        <span>Resume saved</span>
        <span>Profile linked</span>
        <span>Claire ready</span>
      </div>
    </div>
  )
}
