// Onboarding — unified signup for layoff.wekruit.com + candidate.wekruit.com.
// Ported from wekruit-layoff/src/pages/Signup.tsx. The source flag
// ("WeKruit_Laid_Off" | "candidate") is resolved at first paint via
// resolveSource() and frozen onto the pa-users doc at registration.

import { useMemo, useRef, useState, useEffect, type FormEvent } from "react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { onAuthStateChanged, signOut, type User } from "firebase/auth"
import { clearSsoCookie } from "../lib/cross-domain-sso.js"
import "../styles/wekruit-tokens.css"
import { deriveFunction, registerCandidate, type RegisterInput } from "../lib/onboarding-api"
import { uploadResume } from "../lib/onboarding-cv"
import {
  getBrowserUid,
  isCandidateHost,
  layoffSignupLoginPath,
  onboardingDestination,
  redirectToCandidatePortal,
  rememberCandidateProfileSession,
  rememberOnboardingIntentForPath,
  resolveExplicitOnboardingReturnPath,
} from "../lib/browser-identity"
import { resolveSource, SOURCE_RESOLVER_MARKER, stickSourceFromLoginNext, type SignupSource } from "../lib/source"
import { auth } from "../lib/firebase.js"
import { trackEvent } from "../lib/analytics.js"
import { isLinkedInSignIn } from "../lib/candidate-auth-provider.js"
import { CandidateVerifyError, readStoredCandidateId, shouldSignOutOnVerifyError, verifyCandidateMagicLinkSession } from "../lib/candidate-verify.js"
import { startCandidatePhoneLink, verifyCandidatePhoneLink } from "../lib/candidate-phone-link.js"
import { buildHelloWekruitOpenerBody, buildWekruitJobOpenerBody } from "../lib/hello-wekruit.js"
import { canOpenImessageDeepLink } from "../lib/imessage-platform.js"
import { CompanyCombobox } from "../components/CompanyCombobox.js"
import { CANDIDATE_STYLES, Icon, IMessageThread } from "./CandidateLogin.js"
import { canonicalPublicJobId } from "../lib/public-job-slugs.js"

// Keep the marker referenced so tree-shaking can't drop it from the
// bundle. The acceptance grep relies on this string being present.
const _MARKER: string = SOURCE_RESOLVER_MARKER
void _MARKER

const ONBOARDING_PHONE_LINK_STYLES = `
.wk-onboarding-phone-link {
  margin: 0 0 18px;
  padding: 18px;
  border: 1px solid rgba(190, 116, 72, 0.28);
  border-radius: var(--r-md);
  background: linear-gradient(180deg, rgba(255, 248, 235, 0.96), rgba(245, 237, 227, 0.98));
  box-shadow: var(--shadow-sm);
}
.wk-onboarding-phone-link__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
}
.wk-onboarding-phone-link__kicker {
  display: block;
  margin-bottom: 6px;
  color: #9f5d36;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}
.wk-onboarding-phone-link h2 {
  margin: 0;
  color: var(--ink);
  font-family: var(--font-serif);
  font-size: 25px;
  font-weight: 400;
  letter-spacing: 0;
  line-height: 1.12;
}
.wk-onboarding-phone-link p {
  margin: 7px 0 0;
  color: var(--ink-2);
  font-size: 14px;
  line-height: 1.45;
}
.wk-onboarding-phone-link__trigger {
  min-height: 44px;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.wk-onboarding-phone-link__panel {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid rgba(201, 182, 158, 0.6);
  display: grid;
  gap: 12px;
}
.wk-onboarding-phone-link__form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: end;
}
.wk-onboarding-phone-link__field {
  display: grid;
  gap: 6px;
  color: var(--ink-3);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}
.wk-onboarding-phone-link__field input {
  width: 100%;
  min-width: 0;
  height: 44px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: rgba(255, 253, 248, 0.72);
  color: var(--ink);
  font: 600 15px/1 var(--font-sans);
  outline: none;
  padding: 0 12px;
}
.wk-onboarding-phone-link__field input:focus {
  border-color: #9f5d36;
  box-shadow: 0 0 0 3px rgba(190, 116, 72, 0.14);
}
.wk-onboarding-phone-link__field input:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}
.wk-onboarding-phone-link__message {
  margin: 0;
  color: var(--success);
  font-size: 13px;
  font-weight: 650;
  line-height: 1.35;
}
.wk-onboarding-phone-link__message.is-error {
  color: var(--danger);
}
.wk-onboarding-phone-link__close {
  justify-self: start;
  border: 0;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  font: 700 13px/1.2 var(--font-sans);
  padding: 2px 0;
}
.wk-onboarding-phone-link__close:hover:not(:disabled) {
  color: var(--ink);
  text-decoration: underline;
}
.wk-onboarding-phone-link__close:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
@media (max-width: 640px) {
  .wk-onboarding-phone-link {
    padding: 14px;
  }
  .wk-onboarding-phone-link__body,
  .wk-onboarding-phone-link__form {
    grid-template-columns: 1fr;
  }
  .wk-onboarding-phone-link__trigger,
  .wk-onboarding-phone-link__form .btn {
    width: 100%;
    justify-content: center;
  }
  .wk-onboarding-phone-link h2 {
    font-size: 22px;
  }
}
`

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
  const [searchParams] = useSearchParams()
  const returnPath = useMemo(() => resolveExplicitOnboardingReturnPath(searchParams.get("next")), [searchParams])
  const source: SignupSource = useMemo(() => {
    if (returnPath) stickSourceFromLoginNext(returnPath)
    return resolveSource()
  }, [returnPath])
  const loginNextPath = useMemo(() => {
    const base = onboardingDestination(source)
    if (!returnPath) return base
    return `${base}${base.includes("?") ? "&" : "?"}next=${encodeURIComponent(returnPath)}`
  }, [returnPath, source])
  const returnJobId = useMemo(() => {
    if (!returnPath) return null
    const match = returnPath.match(/^\/j\/([^/?#]+)(?:\/cv)?$/)
    return match?.[1] ? canonicalPublicJobId(match[1]) : null
  }, [returnPath])
  const isJobInterview = Boolean(returnJobId)
  const sourceEyebrow = isJobInterview
    ? "Claire keeps the role context attached"
    : source === "WeKruit_Laid_Off"
      ? "WeKruit Open · for people between things"
      : "WeKruit · meet your AI recruiter"

  useEffect(() => {
    const rawNext = searchParams.get("next")
    if (!returnPath || rawNext === returnPath) return
    const nextParams = new URLSearchParams(searchParams)
    nextParams.set("next", returnPath)
    navigate(`/onboarding?${nextParams.toString()}`, { replace: true })
  }, [navigate, returnPath, searchParams])

  useEffect(() => {
    rememberOnboardingIntentForPath(returnPath ?? onboardingDestination(source))
  }, [returnPath, source])
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined)
  const [authReady, setAuthReady] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  // Bumped by the inline Retry button to re-run session verification after a
  // transient (non-auth) failure without destroying the signed-in session.
  const [verifyAttempt, setVerifyAttempt] = useState(0)
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
            if (returnPath) {
              navigate(returnPath, { replace: true })
              return
            }
            if (isCandidateHost()) {
              navigate("/me", { replace: true })
            } else {
              setStage("done")
            }
            return
          }
          if (verified.intakeComplete) {
            if (returnPath) {
              navigate(returnPath, { replace: true })
              return
            }
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
          if (shouldSignOutOnVerifyError(err)) {
            // Auth-class failure (email_not_verified / missing_verified_email /
            // not_signed_in / 401 / 403): the session itself is bad, so sign
            // out and let /login own the next attempt.
            try {
              await clearSsoCookie()
              await signOut(auth())
            } catch {
              // Login owns the next auth attempt.
            }
            navigate(`/login?next=${encodeURIComponent(loginNextPath)}`, { replace: true })
          }
          // Transient failure (network / 5xx / verify_failed): KEEP the
          // session. The inline verifyError notice renders with a Retry
          // button — destroying a valid session here was the login loop.
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authUser, loginNextPath, navigate, returnPath, source, verifyAttempt])

  if (!authReady || authUser === undefined) {
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
    return <Navigate to={`/login?next=${encodeURIComponent(loginNextPath)}`} replace />
  }

  if (!intakeChecked) {
    return (
      <main>
        <style>{ONBOARDING_PHONE_LINK_STYLES}</style>
        <MinimalNav />
        <section className="onboarding-section" style={{ paddingTop: 48, paddingBottom: 96, position: "relative" }}>
          <div className="container-prose" style={{ maxWidth: 760, marginInline: "auto", paddingInline: 24 }}>
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
                Already talked to <em style={{ fontStyle: "italic" }}>Claire</em>?
              </h1>
              <p
                style={{
                  margin: "14px auto 0",
                  maxWidth: 560,
                  color: "var(--ink-2)",
                  fontSize: 15,
                  lineHeight: 1.5,
                }}
              >
                If your phone already has a Claire conversation, verify that number and open the same candidate profile instead of starting onboarding again.
              </p>
            </div>
            <OnboardingPhoneThreadLink authUser={authUser} onLinked={onPhoneThreadLinked} />
            <StepNotice tone="busy" text="Checking whether this sign-in already has a WeKruit profile..." />
          </div>
        </section>
        <MinimalFooter />
      </main>
    )
  }

  async function submitRegistration(formData: Profile, mode: "auto" | "reuse" | "refresh") {
    setSubmitError(null)
    setBusyText("Creating your WeKruit profile…")
    try {
      const isLayoff = source === "WeKruit_Laid_Off"
      const lastCompany = formData.lastCompany?.trim()
      const input: RegisterInput = {
        firstName: formData.firstName!,
        lastName: formData.lastName!,
        email: formData.email!,
        linkedin: formData.linkedin?.trim() || undefined,
        personalWebsite: formData.personalWebsite?.trim() || undefined,
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
      }
      if (lastCompany) input.lastCompany = lastCompany
      const res = await registerCandidate(input)

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
        void trackEvent("cv_upload_submitted")
        await uploadResumeForCandidate(res.candidateId, formData, sourceToUploadTag(source))
      }
      // No server-side SMS push here: the candidate opens iMessage and sends
      // the prefilled opener themselves, which also binds their phone.
      setProfile((p) => ({ ...p, ...withoutResumeFile(formData), ...res }))
      if (returnPath) {
        setStage("done")
        return
      }
      setStage("done")
    } catch (err) {
      setSubmitError(messageFromError(err))
    } finally {
      setBusyText(null)
    }
  }

  const onFormDone = (formData: Profile) => submitRegistration(formData, "auto")

  function onPhoneThreadLinked(candidateId: string) {
    setClaireConversationStarted(true)
    setPortalReady(true)
    setProfile((p) => ({ ...p, candidateId }))
    if (returnPath) {
      navigate(returnPath, { replace: true })
      return
    }
    if (!isCandidateHost()) {
      redirectToCandidatePortal("/me")
      return
    }
    navigate("/me", { replace: true })
  }

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
      <style>{ONBOARDING_PHONE_LINK_STYLES}</style>
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
                    {isJobInterview ? (
                      <>
                        Keep this role with <em style={{ fontStyle: "italic" }}>Claire</em>.
                      </>
                    ) : (
                      <>
                        Build your Claire <em style={{ fontStyle: "italic" }}>profile</em>.
                      </>
                    )}
                  </>
                )}
              </h1>
              {stage !== "dup-prompt" && <FlowProgress stage={stage} isJobInterview={isJobInterview} />}
              {verifyError ? (
                <div>
                  <StepNotice tone="error" text={verifyError} />
                  <button
                    type="button"
                    className="wk-btn wk-btn--ghost wk-btn--sm"
                    onClick={() => {
                      setVerifyError(null)
                      setVerifyAttempt((n) => n + 1)
                    }}
                  >
                    Retry verification
                  </button>
                </div>
              ) : null}
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
                  {sourceEyebrow}
                </p>
              )}
            </div>
          )}

          {busyText && <StepNotice tone="busy" text={busyText} />}
          {submitError && <StepNotice tone="error" text={submitError} />}

          {stage === "intake" && (
            <>
              <OnboardingPhoneThreadLink authUser={authUser} onLinked={onPhoneThreadLinked} />
              <FormIntake
                onDone={onFormDone}
                isBusy={Boolean(busyText)}
                source={source}
                authUser={authUser}
                linkedinLinkedViaOauth={linkedinLinkedViaOauth}
                isJobInterview={isJobInterview}
              />
            </>
          )}
          {stage === "dup-prompt" && dupExisting && (
            <DuplicatePrompt existing={dupExisting} onReuse={onReuseExisting} onFresh={onStartFresh} />
          )}
          {stage === "done" && (
            <Done
              profile={profile}
              showProfileLink={portalReady}
              returnJobId={returnJobId}
              claireConversationStarted={claireConversationStarted}
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
      {!isError && <span className="wk-inline-spinner wk-inline-spinner--ink" aria-hidden />}
      <span>{text}</span>
    </div>
  )
}

type OnboardingPhoneLinkState =
  | { status: "idle"; message: string | null; requestId?: undefined; phoneMasked?: undefined }
  | { status: "sending_code"; message: string | null; requestId?: undefined; phoneMasked?: undefined }
  | { status: "code_sent"; message: string; requestId: string; phoneMasked: string }
  | { status: "verifying"; message: string; requestId: string; phoneMasked: string }
  | { status: "linked"; message: string; requestId?: string; phoneMasked?: string }
  | { status: "error"; message: string; requestId?: string; phoneMasked?: string }

function OnboardingPhoneThreadLink({
  authUser,
  onLinked,
}: {
  authUser: User
  onLinked: (candidateId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [phone, setPhone] = useState("")
  const [code, setCode] = useState("")
  const [state, setState] = useState<OnboardingPhoneLinkState>({
    status: "idle",
    message: null,
  })
  const busy = state.status === "sending_code" || state.status === "verifying"
  const digits = phone.replace(/\D/g, "")
  const canSend = digits.length >= 7 && !busy
  const canVerify = state.status === "code_sent" && code.length === 6 && !busy

  async function onStart(e: FormEvent) {
    e.preventDefault()
    if (!canSend) return
    setState({ status: "sending_code", message: "Sending a code to the phone thread Claire already knows..." })
    try {
      const result = await startCandidatePhoneLink(phone)
      if (!result.ok) {
        setState({ status: "error", message: result.message })
        return
      }
      setCode("")
      setState({
        status: "code_sent",
        requestId: result.requestId,
        phoneMasked: result.phoneMasked,
        message: `Code sent to ${result.phoneMasked}. Enter it here to connect this web account.`,
      })
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Could not send the code. Try again in a moment.",
      })
    }
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault()
    if (state.status !== "code_sent" || !canVerify) return
    const { requestId, phoneMasked } = state
    setState({ status: "verifying", requestId, phoneMasked, message: "Checking the code with Claire's phone thread..." })
    try {
      const result = await verifyCandidatePhoneLink(requestId, code)
      if (!result.ok) {
        setState({ status: "code_sent", requestId, phoneMasked, message: result.message })
        return
      }
      setState({
        status: "linked",
        phoneMasked: result.phoneMasked,
        message: "Claire's phone thread is connected. Opening the profile Claire already knows...",
      })
      onLinked(result.candidateId)
    } catch (err) {
      setState({
        status: "code_sent",
        requestId,
        phoneMasked,
        message: err instanceof Error ? err.message : "Could not verify the code. Try again.",
      })
    }
  }

  return (
    <section className={`wk-onboarding-phone-link${open ? " is-open" : ""}`} aria-label="Connect an existing Claire phone thread">
      <div className="wk-onboarding-phone-link__body">
        <div>
          <span className="wk-onboarding-phone-link__kicker">Already talked with Claire?</span>
          <h2>Skip onboarding with your phone thread.</h2>
          <p>
            Verify the phone number Claire already knows. This login opens the same candidate profile, so you do not have to fill onboarding again.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--secondary wk-onboarding-phone-link__trigger"
          onClick={() => {
            setOpen(true)
            if (state.status === "idle") {
              setState({ status: "idle", message: `Signed in as ${authUser.email ?? "this account"}. Enter the phone you used with Claire.` })
            }
          }}
          disabled={busy}
        >
          <Icon name="message" size={16} stroke={2} />
          <span>I've texted Claire</span>
        </button>
      </div>

      {open ? (
        <div className="wk-onboarding-phone-link__panel">
          <form className="wk-onboarding-phone-link__form" onSubmit={onStart}>
            <label className="wk-onboarding-phone-link__field">
              <span>Phone used with Claire</span>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 415 555 0100"
                disabled={busy}
              />
            </label>
            <button type="submit" className="btn btn--secondary" disabled={!canSend}>
              {state.status === "sending_code" ? "Sending code..." : "Text me a code"}
            </button>
          </form>

          {(state.status === "code_sent" || state.status === "verifying") ? (
            <form className="wk-onboarding-phone-link__form" onSubmit={onVerify}>
              <label className="wk-onboarding-phone-link__field">
                <span>Verification code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  disabled={busy}
                />
              </label>
              <button type="submit" className="btn btn--primary" disabled={!canVerify}>
                {state.status === "verifying" ? "Connecting..." : "Connect Claire thread"}
              </button>
            </form>
          ) : null}

          {state.message ? (
            <p className={`wk-onboarding-phone-link__message${state.status === "error" ? " is-error" : ""}`} aria-live="polite">
              {state.message}
            </p>
          ) : null}
          <button type="button" className="wk-onboarding-phone-link__close" onClick={() => setOpen(false)} disabled={busy}>
            Use normal onboarding
          </button>
        </div>
      ) : null}
    </section>
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
        <strong style={{ color: "var(--ink)" }}>Use latest info</strong> — Replace your old info with what you just entered.
      </div>

      <div style={{ marginTop: 22, display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <button className="btn btn--secondary" onClick={onFresh}>Use latest info</button>
        <button className="btn btn--primary" onClick={onReuse}>Use previous profile →</button>
      </div>
    </div>
  )
}

function FlowProgress({ stage, isJobInterview }: { stage: Stage; isJobInterview: boolean }) {
  const steps = isJobInterview
    ? ([
        { id: "intake", label: "Profile + role context" },
        { id: "done", label: "Claire role interview" },
      ] as const)
    : ([
        { id: "intake", label: "Claire profile" },
        { id: "done", label: "Claire iMessage" },
      ] as const)
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
  isJobInterview,
}: {
  onDone: (p: Profile) => void | Promise<void>
  isBusy: boolean
  source: SignupSource
  authUser: User
  linkedinLinkedViaOauth: boolean
  isJobInterview: boolean
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
  const [formError, setFormError] = useState<string | null>(null)
  const [localBusy, setLocalBusy] = useState(false)
  const set = <K extends keyof Profile>(k: K, val: Profile[K]) => setV((s) => ({ ...s, [k]: val }))
  const fileInputRef = useRef<HTMLInputElement>(null)
  const busy = isBusy || localBusy

  const submit = async () => {
    if (busy) return
    const e: Record<string, string> = {}
    ;(["firstName", "lastName", "email"] as const).forEach((k) => {
      if (!v[k]) e[k] = "Required"
    })
    if (isLayoff && !v.lastCompany?.trim()) e.lastCompany = "Required"
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
      setFormError(null)
      setLocalBusy(true)
      try {
        await onDone({
          ...v,
          lastCompany: v.lastCompany?.trim() || undefined,
          function: deriveFunction(v.jobTitle || ""),
        })
      } finally {
        setLocalBusy(false)
      }
    } else {
      setFormError("Finish the highlighted fields before continuing.")
    }
  }

  const requiredKeys = ["firstName", "lastName", "email"] as const
  const profilePathSatisfied =
    Boolean(v.resume) ||
    Boolean(v.personalWebsite?.trim()) ||
    (!skipLinkedinField && Boolean(v.linkedin?.trim())) ||
    skipLinkedinField
  const filled =
    requiredKeys.filter((k) => v[k]).length +
    (isLayoff && v.lastCompany?.trim() ? 1 : 0) +
    (v.consent ? 1 : 0) +
    (profilePathSatisfied ? 1 : 0)
  const total = requiredKeys.length + (isLayoff ? 1 : 0) + 2

  const onResumePick: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0]
    if (file) set("resume", { name: file.name, size: file.size, file })
  }

  const consentText =
    source === "WeKruit_Laid_Off"
      ? "I confirm I was laid off in the last 6 months and I'm okay with verified WeKruit employers seeing my name, last company, and pitch. I can hide my resume and remove my profile anytime."
      : "I'm okay with verified WeKruit employers seeing my name, profile details, and pitch. I can hide my resume and remove my profile anytime."

  return (
    <div className="card card--feature" style={{ background: "var(--cream-3)", borderRadius: "var(--r-lg)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, marginBottom: 6, flexWrap: "wrap" }}>
        <span className="eyebrow" style={{ whiteSpace: "nowrap" }}>
          {isJobInterview ? "Step 1 · Role context" : "Step 1 · Claire profile"}
        </span>
        <span className="caption" style={{ color: "var(--ink-3)", whiteSpace: "nowrap" }}>{filled} of {total} · ~60 sec</span>
      </div>
      <p style={{ marginTop: 4, marginBottom: 18, fontSize: 14, color: "var(--ink-2)" }}>
        {isLayoff
          ? "Tell us the basics. After you submit, you'll open iMessage to say hello to Claire — that's when we link your phone."
          : isJobInterview
            ? skipLinkedinField
              ? "Claire already has the role path; add the evidence she needs while the role context stays attached. LinkedIn is linked from sign-in, so a resume or site is enough to continue the same role interview in iMessage."
              : "Claire already has the role path; add the evidence she needs while the role context stays attached. Share a resume, LinkedIn, or site, then continue the same role interview in iMessage."
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
          hint={isLayoff ? "Pick from suggestions or type any company name." : "Optional if your resume already shows it."}
          optional={!isLayoff}
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
        <span className="caption" style={{ color: "var(--ink-3)" }}>
          Next: {isJobInterview ? "Continue this role interview with Claire in iMessage." : "Talk to Claire in iMessage."}
        </span>
        {formError && (
          <span role="alert" style={{ width: "100%", color: "var(--danger)", fontSize: 13 }}>
            {formError}
          </span>
        )}
        <button className="btn btn--primary btn--lg" onClick={submit} disabled={busy}>
          {busy ? (
            <>
              <span className="wk-inline-spinner" aria-hidden />
              Creating profile…
            </>
          ) : (
            "Save & continue →"
          )}
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
  returnJobId,
  claireConversationStarted,
  onGo,
}: {
  profile: Profile
  showProfileLink: boolean
  returnJobId: string | null
  claireConversationStarted: boolean
  onGo: (r: "dashboard" | "landing") => void
}) {
  const number = profile.listPosition
  const openerBody = returnJobId
    ? buildWekruitJobOpenerBody(returnJobId)
    : profile.candidateId
      ? buildHelloWekruitOpenerBody(profile.candidateId)
      : buildHelloWekruitOpenerBody("")
  const isJobInterview = Boolean(returnJobId)
  const continuingClaireConversation = claireConversationStarted || isJobInterview
  const imessageAvailable = canOpenImessageDeepLink()
  const smsHref =
    imessageAvailable && profile.senderNumber
      ? `sms:${profile.senderNumber}?&body=${encodeURIComponent(openerBody)}`
      : null
  const primaryActionLabel = continuingClaireConversation ? "Continue with Claire" : "Open Claire in iMessage"
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
          {continuingClaireConversation ? "Continue with Claire in iMessage." : "Open Claire in iMessage."}
        </h1>
        <p className="lead claire-handoff__copy">
          {imessageAvailable ? (
            <>
              {isJobInterview
                ? "Your profile and this role are connected. Send the pre-filled code exactly as shown; Claire will continue the role interview from there."
                : claireConversationStarted
                  ? "Claire already has your thread. Send the pre-filled code exactly as shown if this page asks for it; she will pick up from the existing conversation."
                : "Your resume and profile are saved. Open iMessage and send the pre-filled code exactly as shown."}
            </>
          ) : (
            <>
              iMessage deep links work on iPhone, iPad, and Mac. Open this page on an Apple device to start your chat with Claire.
            </>
          )}
        </p>

        <div className="claire-handoff__actions">
          {smsHref ? (
            <a className="btn btn--primary btn--lg" href={smsHref}>
              {primaryActionLabel}
            </a>
          ) : !imessageAvailable ? (
            <p className="caption claire-handoff__fallback">
              Android and Windows can't open iMessage deep links. Use Safari on your iPhone or Mac, or email hello@wekruit.com for help.
            </p>
          ) : (
            <span className="caption claire-handoff__fallback">
              We hit a hiccup assigning your Claire line. Email hello@wekruit.com and we&apos;ll get you started.
            </span>
          )}
          {!isJobInterview && showProfileLink ? (
            <button className="btn btn--secondary" onClick={() => onGo("dashboard")}>Profile</button>
          ) : null}
          {!isJobInterview ? (
            <button className="btn btn--ghost" onClick={() => onGo("landing")}>Home</button>
          ) : null}
        </div>
        {smsHref ? (
          <p className="claire-handoff__note">
            Don&apos;t edit the text or delete the code. Claire uses it to connect this phone to your WeKruit profile
            {isJobInterview ? " and this role." : "."}
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
              { from: "claire", text: isJobInterview ? "Got it — I found your profile and this role." : "Got it — I found your profile." },
              { from: "claire", text: isJobInterview ? "I’ll continue the role interview from here." : claireConversationStarted ? "I’ll pick up from our existing thread." : "First question: what matters most in your next company: career growth, compensation, stability, mission, learning, or something else?" },
            ]}
          />
        </div>
      </aside>

      <div className="claire-handoff__checks" aria-label="Setup status">
        <span>Resume saved</span>
        <span>Profile linked</span>
        <span>{claireConversationStarted ? "Claire thread found" : "Claire ready"}</span>
      </div>
    </div>
  )
}
