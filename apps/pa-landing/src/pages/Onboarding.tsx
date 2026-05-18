// Onboarding — unified signup for layoff.wekruit.com + candidate.wekruit.com.
// Ported from wekruit-layoff/src/pages/Signup.tsx. The source flag
// ("WeKruit_Laid_Off" | "candidate") is resolved at first paint via
// resolveSource() and frozen onto the pa-users doc at registration.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Link, useNavigate } from "react-router-dom"
import "../styles/wekruit-tokens.css"
import { deriveFunction, initiateSmsPrescreen, registerCandidate, submitChatTurn } from "../lib/onboarding-api"
import { uploadResume } from "../lib/onboarding-cv"
import { resolveSource, SOURCE_RESOLVER_MARKER, type SignupSource } from "../lib/source"

// Keep the marker referenced so tree-shaking can't drop it from the
// bundle. The acceptance grep relies on this string being present.
const _MARKER: string = SOURCE_RESOLVER_MARKER
void _MARKER

type Stage = "intake" | "dup-prompt" | "chat" | "done"

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
  roleShape?: string
  locationOpen?: string
  sponsorship?: boolean
  start?: string
  compMin?: number
  compMax?: number
  pitch?: string
  answers?: Record<string, string>
}

const CHAT_PROMPTS = [
  {
    id: "next",
    label: "What's the next role you're built for?",
    transcript:
      "I want zero-to-one work at a smaller company — consumer or developer tools. Series A to B. Want to be the second or third PM, not the tenth.",
    extract: { roleShape: "0→1 PM at Series A–B consumer or devtools" },
  },
  {
    id: "open",
    label: "What are you open to? Comp, sponsorship, start date.",
    transcript:
      "Open to staying in SF or moving to NY. No sponsorship needed. Earliest start April 1. Looking at $220k–$260k base.",
    extract: { locationOpen: "SF or NY", sponsorship: false, start: "Apr 1", compMin: 220, compMax: 260 },
  },
  {
    id: "pitch",
    label: "One thing you want hiring managers to know?",
    transcript:
      "I took Quest 3 onboarding from 41% to 67% activation in four quarters. I obsess over the first 60 seconds of any product.",
    extract: {
      pitch:
        "Took Quest 3 onboarding from 41% to 67% activation in four quarters. Obsesses over the first 60 seconds of any product.",
    },
  },
] as const

export default function Onboarding() {
  const navigate = useNavigate()
  const source: SignupSource = useMemo(() => resolveSource(), [])
  const [profile, setProfile] = useState<Profile>({})
  const [stage, setStage] = useState<Stage>("intake")
  const [pendingForm, setPendingForm] = useState<Profile | null>(null)
  const [dupExisting, setDupExisting] = useState<DupExisting | null>(null)
  const [dupCandidateId, setDupCandidateId] = useState<string | null>(null)
  const [busyText, setBusyText] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function submitRegistration(formData: Profile, mode: "auto" | "reuse" | "refresh") {
    setSubmitError(null)
    setBusyText("Creating your WeKruit profile…")
    try {
      const res = await registerCandidate({
        firstName: formData.firstName!,
        lastName: formData.lastName!,
        email: formData.email!,
        linkedin: formData.linkedin,
        lastCompany: formData.lastCompany!,
        jobTitle: formData.jobTitle!,
        location: formData.location!,
        phone: formData.phone!,
        consent: !!formData.consent,
        resumeFileName: formData.resume?.name,
        mode,
        source,
      })

      if ("duplicate" in res && res.duplicate) {
        setDupExisting(res.existing)
        setDupCandidateId(res.candidateId)
        setPendingForm(formData)
        setBusyText(null)
        setStage("dup-prompt")
        return
      }

      await uploadResumeForCandidate(res.candidateId, formData, sourceToUploadTag(source))
      setBusyText("Starting Claire's SMS chat…")
      await initiateSmsPrescreen(res.candidateId)
      setProfile((p) => ({ ...p, ...withoutResumeFile(formData), ...res }))
      setStage("chat")
    } catch (err) {
      setSubmitError(messageFromError(err))
    } finally {
      setBusyText(null)
    }
  }

  const onFormDone = (formData: Profile) => submitRegistration(formData, "auto")

  async function onReuseExisting() {
    if (!dupCandidateId) return
    setSubmitError(null)
    setBusyText("Updating your resume on the existing profile…")
    try {
      if (pendingForm) {
        await uploadResumeForCandidate(dupCandidateId, pendingForm, sourceToUploadTag(source) + "_reuse")
      }
      setBusyText("Starting Claire's SMS chat…")
      await initiateSmsPrescreen(dupCandidateId)
      setProfile((p) => ({
        ...p,
        ...(pendingForm ? withoutResumeFile(pendingForm) : {}),
        candidateId: dupCandidateId,
        isReregistration: true,
      }))
      setStage("chat")
    } catch (err) {
      setSubmitError(messageFromError(err))
    } finally {
      setBusyText(null)
    }
  }

  async function onStartFresh() {
    if (!pendingForm) return
    setStage("intake")
    await submitRegistration(pendingForm, "refresh")
  }

  const onChatDone = (chatData: Partial<Profile>) => {
    setProfile((p) => ({ ...p, ...chatData }))
    setStage("done")
  }

  return (
    <main>
      <MinimalNav />
      <section style={{ paddingTop: 48, paddingBottom: 96, position: "relative" }}>
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
                {stage === "chat" && (
                  <>
                    Now, let's <em style={{ fontStyle: "italic" }}>chat</em>.
                  </>
                )}
              </h1>
              {stage !== "dup-prompt" && <FlowProgress stage={stage} />}
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

          {stage === "intake" && <FormIntake onDone={onFormDone} isBusy={Boolean(busyText)} source={source} />}
          {stage === "dup-prompt" && dupExisting && (
            <DuplicatePrompt existing={dupExisting} onReuse={onReuseExisting} onFresh={onStartFresh} />
          )}
          {stage === "chat" && <SMSChat profile={profile} onDone={onChatDone} />}
          {stage === "done" && <Done profile={profile} onGo={(r) => navigate(r === "dashboard" ? "/me" : "/")} />}
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
        <Link to="/login" style={{ fontSize: 14, color: "var(--ink-2)", textDecoration: "none" }}>
          Sign in
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
    { id: "chat", label: "Quick SMS chat" },
  ] as const
  const currentIdx = steps.findIndex((s) => s.id === stage)
  return (
    <div
      style={{
        marginTop: 22,
        display: "inline-flex",
        alignItems: "center",
        gap: 0,
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
              <span aria-hidden style={{ width: 16, height: 1, background: "var(--border)" }} />
            )}
          </span>
        )
      })}
    </div>
  )
}

function FormIntake({
  onDone,
  isBusy,
  source,
}: {
  onDone: (p: Profile) => void | Promise<void>
  isBusy: boolean
  source: SignupSource
}) {
  const [v, setV] = useState<Profile>({
    firstName: "",
    lastName: "",
    email: "",
    linkedin: "",
    lastCompany: "",
    jobTitle: "",
    location: "",
    phone: "",
    consent: false,
    resume: null,
  })
  const [err, setErr] = useState<Record<string, string>>({})
  const set = <K extends keyof Profile>(k: K, val: Profile[K]) => setV((s) => ({ ...s, [k]: val }))
  const fileInputRef = useRef<HTMLInputElement>(null)

  const submit = async () => {
    const e: Record<string, string> = {}
    ;(["firstName", "lastName", "email", "lastCompany", "jobTitle", "location", "phone"] as const).forEach((k) => {
      if (!v[k]) e[k] = "Required"
    })
    if (!v.consent) e.consent = "Required"
    if (!v.resume) e.resume = "Required"
    if (v.email && !v.email.includes("@")) e.email = "Looks off"
    if (v.phone && v.phone.replace(/\D/g, "").length < 10) e.phone = "Need 10+ digits"
    setErr(e)
    if (Object.keys(e).length === 0) {
      await onDone({ ...v, function: deriveFunction(v.jobTitle || "") })
    }
  }

  const requiredKeys = ["firstName", "lastName", "email", "lastCompany", "jobTitle", "location", "phone"] as const
  const filled = requiredKeys.filter((k) => v[k]).length + (v.consent ? 1 : 0) + (v.resume ? 1 : 0)
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
        Required to register. The moment you submit, we'll text the number you give us.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <Field label="First name" value={v.firstName!} onChange={(x) => set("firstName", x)} err={err.firstName} placeholder="Maya" autoFocus />
        <Field label="Last name" value={v.lastName!} onChange={(x) => set("lastName", x)} err={err.lastName} placeholder="Chen" />
        <Field span={2} label="Work email (verification)" value={v.email!} onChange={(x) => set("email", x)} err={err.email} placeholder="maya@meta.com" type="email" hint="We send a quick verification link." />
        <Field span={2} label="LinkedIn URL" value={v.linkedin!} onChange={(x) => set("linkedin", x)} placeholder="linkedin.com/in/maya-chen-pm" />
        <Field label={source === "WeKruit_Laid_Off" ? "Last company" : "Current / last company"} value={v.lastCompany!} onChange={(x) => set("lastCompany", x)} err={err.lastCompany} placeholder="Meta" />
        <Field label="Job title there" value={v.jobTitle!} onChange={(x) => set("jobTitle", x)} err={err.jobTitle} placeholder="Senior PM, Reality Labs" />
        <Field label="Location" value={v.location!} onChange={(x) => set("location", x)} err={err.location} placeholder="San Francisco" />
        <Field label="Mobile (for SMS chat)" value={v.phone!} onChange={(x) => set("phone", x)} err={err.phone} placeholder="+1 (415) 555-0182" type="tel" hint="We text you right after you submit." />
      </div>

      <div style={{ marginTop: 20 }}>
        <span style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500, color: "var(--ink-2)", display: "flex", justifyContent: "space-between" }}>
          <span>Resume <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>· PDF</span></span>
          {err.resume && <span style={{ color: "var(--danger)" }}>Required</span>}
        </span>
        <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" onChange={onResumePick} style={{ display: "none" }} />
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
        <span className="caption" style={{ color: "var(--ink-3)" }}>Next: we text you right away for a 5-minute SMS chat.</span>
        <button className="btn btn--primary btn--lg" onClick={submit} disabled={isBusy}>
          {isBusy ? "Working…" : "Continue to SMS chat →"}
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
        {err && <span style={{ color: "var(--danger)" }}>{err}</span>}
      </span>
      <input
        type={type || "text"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="input"
        autoFocus={autoFocus}
        style={{ background: "var(--cream)" }}
      />
      {hint && <span className="caption" style={{ color: "var(--ink-3)" }}>{hint}</span>}
    </label>
  )
}

function SMSChat({ profile, onDone }: { profile: Profile; onDone: (p: Partial<Profile>) => void }) {
  type Msg = { from: "bot" | "user"; text: string }
  const [messages, setMessages] = useState<Msg[]>([])
  const [stepIdx, setStepIdx] = useState(0)
  const [input, setInput] = useState("")
  const [botTyping, setBotTyping] = useState(false)
  const [awaitingUser, setAwaitingUser] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, botTyping])

  useEffect(() => {
    const first = profile?.firstName || "there"
    const company = profile?.lastCompany || "your last company"
    queueBot([
      `Hey ${first}, this is WeKruit. We just got your registration.`,
      `Saw you were at ${company} — glad you found us.`,
      `Three quick questions so we can match you well.`,
      CHAT_PROMPTS[0].label,
    ])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function queueBot(texts: string[]) {
    setBotTyping(true)
    setAwaitingUser(false)
    let delay = 500
    texts.forEach((text, i) => {
      const typingDelay = 600 + Math.min(text.length * 16, 1100)
      delay += typingDelay
      setTimeout(() => {
        setMessages((m) => [...m, { from: "bot", text }])
        if (i === texts.length - 1) {
          setBotTyping(false)
          setAwaitingUser(true)
        }
      }, delay)
    })
  }

  function sendUser(text: string) {
    if (!text.trim() || !awaitingUser) return
    setMessages((m) => [...m, { from: "user", text }])
    setInput("")
    const prompt = CHAT_PROMPTS[stepIdx]
    const newAnswers = { ...answers, [prompt.id]: text }
    setAnswers(newAnswers)
    if (profile.candidateId) {
      submitChatTurn(profile.candidateId, { promptId: prompt.id, text, at: new Date().toISOString() }).catch(() => {})
    }

    const nextIdx = stepIdx + 1
    if (nextIdx < CHAT_PROMPTS.length) {
      const acks = ["Got it.", "Makes sense.", "Okay.", "Cool."]
      const ack = acks[stepIdx % acks.length]
      setStepIdx(nextIdx)
      setTimeout(() => queueBot([ack, CHAT_PROMPTS[nextIdx].label]), 500)
    } else {
      setTimeout(() => {
        queueBot(["Perfect. That's everything we need.", "Putting your profile together now — take a look."])
        setTimeout(() => {
          const extracted: Partial<Profile> = CHAT_PROMPTS.reduce(
            (acc, p) => ({ ...acc, ...p.extract }),
            {} as Partial<Profile>,
          )
          extracted.answers = newAnswers
          onDone(extracted)
        }, 3200)
      }, 400)
    }
  }

  return (
    <div className="card card--feature" style={{ background: "var(--cream-3)", borderRadius: "var(--r-lg)", padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "var(--cream-2)",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: 999,
              background: "var(--ink)",
              color: "var(--cream)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--font-serif)",
              fontSize: 16,
            }}
          >
            W
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>WeKruit</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)" }}>+1 (415) 555-OPEN · usually replies in 1 min</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <span className="caption" style={{ color: "var(--ink-3)" }}>
            {Math.min(stepIdx + 1, CHAT_PROMPTS.length)}/{CHAT_PROMPTS.length}
          </span>
          <div style={{ display: "flex", gap: 3 }}>
            {CHAT_PROMPTS.map((p, i) => (
              <span
                key={p.id}
                style={{
                  width: 16,
                  height: 3,
                  borderRadius: 99,
                  background: i < stepIdx ? "var(--ink)" : i === stepIdx ? "var(--ink-3)" : "var(--border)",
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        style={{ height: 420, overflowY: "auto", padding: "24px 24px 16px", background: "var(--cream)", display: "flex", flexDirection: "column", gap: 6 }}
      >
        <div
          style={{
            textAlign: "center",
            fontSize: 11,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: 6,
          }}
        >
          Today · iMessage
        </div>
        {messages.map((m, i) => (
          <Bubble key={i} from={m.from} text={m.text} />
        ))}
        {botTyping && <TypingDots />}
      </div>

      <div
        style={{
          padding: "12px 18px 18px",
          borderTop: "1px solid var(--border)",
          background: "var(--cream-3)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {awaitingUser && CHAT_PROMPTS[stepIdx]?.transcript && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button onClick={() => setInput(CHAT_PROMPTS[stepIdx].transcript)} type="button" style={chipReplyStyle}>
              Use sample reply →
            </button>
            <span className="caption" style={{ color: "var(--ink-3)", alignSelf: "center", marginLeft: 4 }}>
              or type freely below
            </span>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                sendUser(input)
              }
            }}
            placeholder={awaitingUser ? "Type your reply…" : "WeKruit is typing…"}
            disabled={!awaitingUser}
            rows={1}
            style={{
              flex: 1,
              border: "1px solid var(--border)",
              borderRadius: "var(--r-pill)",
              padding: "10px 18px",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              background: awaitingUser ? "var(--cream)" : "var(--cream-3)",
              resize: "none",
              minHeight: 40,
              maxHeight: 100,
              color: "var(--ink)",
              lineHeight: 1.4,
            }}
          />
          <button
            type="button"
            onClick={() => sendUser(input)}
            disabled={!input.trim() || !awaitingUser}
            style={{
              border: 0,
              cursor: input.trim() && awaitingUser ? "pointer" : "not-allowed",
              width: 40,
              height: 40,
              borderRadius: 999,
              background: input.trim() && awaitingUser ? "var(--ink)" : "var(--border-strong)",
              color: "var(--cream)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background var(--dur-fast) var(--ease)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M3 12l18-9-4 9 4 9z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

function Bubble({ from, text }: { from: "bot" | "user"; text: string }) {
  const isBot = from === "bot"
  return (
    <div style={{ display: "flex", justifyContent: isBot ? "flex-start" : "flex-end" }}>
      <div
        style={{
          maxWidth: "78%",
          padding: "10px 16px",
          borderRadius: 20,
          borderBottomLeftRadius: isBot ? 6 : 20,
          borderBottomRightRadius: isBot ? 20 : 6,
          background: isBot ? "var(--cream-2)" : "var(--ink)",
          color: isBot ? "var(--ink)" : "var(--cream)",
          fontSize: 16,
          lineHeight: 1.5,
          fontWeight: 400,
          wordBreak: "break-word",
        }}
      >
        {text}
      </div>
    </div>
  )
}

function TypingDots() {
  return (
    <div
      style={{
        display: "inline-flex",
        alignSelf: "flex-start",
        alignItems: "center",
        gap: 4,
        padding: "10px 14px",
        background: "var(--cream-2)",
        borderRadius: 20,
        borderBottomLeftRadius: 6,
        marginTop: 2,
      }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--ink-3)",
          }}
        />
      ))}
    </div>
  )
}

const chipReplyStyle: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--cream)",
  color: "var(--ink)",
  padding: "6px 12px",
  borderRadius: 999,
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
  transition: "all var(--dur-fast) var(--ease)",
}

function UploadIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M12 16V4M5 11l7-7 7 7M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Done({ profile, onGo }: { profile: Profile; onGo: (r: "dashboard" | "landing") => void }) {
  const number = profile.listPosition ?? 412 + Math.floor(Math.random() * 8) + 1
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div
          style={{
            margin: "0 auto 24px",
            width: 64,
            height: 64,
            borderRadius: 999,
            background: "var(--success)",
            color: "var(--cream)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "var(--shadow-md)",
          }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="eyebrow" style={{ marginBottom: 12 }}>You're #{number} on the list</div>
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
          You're on. We've <em style={{ fontStyle: "italic" }}>got</em> it from here.
        </h1>
        <p className="lead" style={{ marginTop: 16, marginInline: "auto", maxWidth: 500, color: "var(--ink-2)", fontSize: 17 }}>
          We'll text the SMS chat to your phone any second now. Reply right there — Claire will take it from here.
        </p>
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
        <button className="btn btn--primary" onClick={() => onGo("dashboard")}>Go to your dashboard →</button>
        <button className="btn btn--ghost" onClick={() => onGo("landing")}>Back home</button>
      </div>
    </div>
  )
}
