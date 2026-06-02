/**
 * EmployerSignup — /employer passed-profile role intake.
 *
 * Thin form → openRegisterEmployer callable → Firestore + Mailgun email to admin.
 * The user-facing frame must match /employers: employers send a role brief,
 * Claire screens candidates, and WeKruit returns consented passed profiles.
 */
import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { registerEmployer, type EmployerSignupInput } from "../lib/onboarding-api.js"
import "../styles/wekruit-tokens.css"

type Stage =
  | "pre-seed"
  | "seed"
  | "series-a"
  | "series-b"
  | "series-c-plus"
  | "public"
  | "other"

const STAGE_OPTIONS: { value: Stage; label: string }[] = [
  { value: "pre-seed", label: "Pre-seed" },
  { value: "seed", label: "Seed" },
  { value: "series-a", label: "Series A" },
  { value: "series-b", label: "Series B" },
  { value: "series-c-plus", label: "Series C+" },
  { value: "public", label: "Public" },
  { value: "other", label: "Other" },
]

type FormState = {
  companyName: string
  companyLinkedin: string
  workEmail: string
  contactName: string
  roleAtCompany: string
  stage: Stage | ""
  rolesHiring: string
  notes: string
}

const EMPTY_FORM: FormState = {
  companyName: "",
  companyLinkedin: "",
  workEmail: "",
  contactName: "",
  roleAtCompany: "",
  stage: "",
  rolesHiring: "",
  notes: "",
}

export default function EmployerSignup() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }))

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.companyName.trim() || !form.workEmail.trim() || !form.contactName.trim()) {
      setError("Company name, your name, and work email are required.")
      return
    }
    if (!form.workEmail.includes("@")) {
      setError("That doesn't look like a valid email.")
      return
    }
    setSubmitting(true)
    try {
      const payload: EmployerSignupInput = {
        companyName: form.companyName.trim(),
        companyLinkedin: form.companyLinkedin.trim(),
        workEmail: form.workEmail.trim().toLowerCase(),
        stage: form.stage || "other",
        roleAtCompany: form.roleAtCompany.trim(),
        rolesHiring: form.rolesHiring
          .split(/[,\n]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        contactName: form.contactName.trim(),
        notes: form.notes.trim() || undefined,
      }
      await registerEmployer(payload)
      setDone(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong."
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main style={{ background: "var(--cream)", minHeight: "100vh" }}>
      <Header />
      <section
        style={{
          paddingTop: 56,
          paddingBottom: 96,
          background: "var(--halo-hero, var(--cream))",
        }}
      >
        <div
          className="container-narrow"
          style={{ maxWidth: 640, marginInline: "auto", paddingInline: 24 }}
        >
          <div className="eyebrow" style={{ marginBottom: 18 }}>Passed-profile role intake</div>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontSize: "clamp(36px, 4.4vw, 56px)",
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
              color: "var(--ink)",
              margin: 0,
              textWrap: "balance",
            }}
          >
            Send a role brief. Claire screens before you meet anyone.
          </h1>
          <p
            style={{
              marginTop: 18,
              maxWidth: 520,
              fontFamily: "var(--font-sans)",
              fontSize: "clamp(16px, 1.3vw, 18px)",
              lineHeight: 1.5,
              color: "var(--ink-2)",
            }}
          >
            Tell us the role, must-haves, and context behind the brief. WeKruit reviews it,
            Claire screens against the evidence, and you only see consented passed profiles
            with the transcript and risks attached.
          </p>

          {done ? <SuccessCard email={form.workEmail} /> : (
            <form
              onSubmit={onSubmit}
              style={{
                marginTop: 36,
                background: "var(--cream-3)",
                border: "1px solid var(--border)",
                borderRadius: "var(--r-lg)",
                boxShadow: "var(--shadow-md)",
                padding: 28,
                display: "flex",
                flexDirection: "column",
                gap: 16,
              }}
            >
              <Row>
                <Field
                  label="Company name *"
                  value={form.companyName}
                  onChange={(v) => update("companyName", v)}
                  placeholder="Acme, Inc."
                />
                <Field
                  label="Stage"
                  value={form.stage}
                  onChange={(v) => update("stage", v as Stage | "")}
                  as="select"
                  options={STAGE_OPTIONS}
                />
              </Row>
              <Row>
                <Field
                  label="Your name *"
                  value={form.contactName}
                  onChange={(v) => update("contactName", v)}
                  placeholder="Jane Doe"
                />
                <Field
                  label="Your role"
                  value={form.roleAtCompany}
                  onChange={(v) => update("roleAtCompany", v)}
                  placeholder="Head of Talent"
                />
              </Row>
              <Field
                label="Work email *"
                value={form.workEmail}
                onChange={(v) => update("workEmail", v)}
                placeholder="jane@acme.com"
                type="email"
              />
              <Field
                label="Company LinkedIn"
                value={form.companyLinkedin}
                onChange={(v) => update("companyLinkedin", v)}
                placeholder="https://www.linkedin.com/company/acme"
              />
              <Field
                label="Primary role brief"
                value={form.rolesHiring}
                onChange={(v) => update("rolesHiring", v)}
                placeholder="Senior PM for Claude APIs; SF hybrid; $220k-$290k base"
                helper="One role per line if you are opening more than one search."
              />
              <Field
                label="Must-haves"
                value={form.notes}
                onChange={(v) => update("notes", v)}
                placeholder="Founder-mode judgment, API product depth, comp band, location, risks Claire should probe."
                as="textarea"
              />

              {error && (
                <div
                  role="alert"
                  style={{
                    padding: "10px 14px",
                    background: "var(--danger-bg, #fde8e8)",
                    border: "1px solid var(--danger, #c0392b)",
                    color: "var(--danger, #c0392b)",
                    borderRadius: "var(--r-md)",
                    fontSize: 14,
                  }}
                >
                  {error}
                </div>
              )}

              <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 4 }}>
                <Link to="/" className="btn btn--ghost" style={{ textDecoration: "none" }}>
                  Cancel
                </Link>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={submitting}
                  style={{ minWidth: 160 }}
                >
                  {submitting ? "Sending..." : "Send role brief"}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
      <Footer />
    </main>
  )
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 16,
      }}
    >
      {children}
    </div>
  )
}

type FieldProps = {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  helper?: string
  as?: "input" | "textarea" | "select"
  options?: { value: string; label: string }[]
}

function Field({ label, value, onChange, placeholder, type = "text", helper, as = "input", options }: FieldProps) {
  // The shared `.input` / `.textarea` / `.select` classes (wekruit-tokens.css)
  // already handle the empty-vs-filled visual: dashed cream border when
  // :placeholder-shown, solid white when filled. Inline overrides only
  // box-sizing + width so the grid layout stays predictable.
  const sharedStyle: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
  }
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          color: "var(--ink-2)",
          fontWeight: 500,
          letterSpacing: "-0.005em",
        }}
      >
        {label}
      </span>
      {as === "textarea" ? (
        <textarea
          className="textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={4}
          style={{ ...sharedStyle, resize: "vertical" }}
        />
      ) : as === "select" ? (
        <select
          className="select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={sharedStyle}
        >
          <option value="">Select…</option>
          {options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input"
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={sharedStyle}
        />
      )}
      {helper && (
        <span style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-sans)" }}>
          {helper}
        </span>
      )}
    </label>
  )
}

function SuccessCard({ email }: { email: string }) {
  return (
    <div
      style={{
        marginTop: 36,
        background: "var(--cream-3)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        padding: 32,
        textAlign: "center",
      }}
    >
      <h2
        style={{
          fontFamily: "var(--font-serif)",
          fontWeight: 400,
          fontSize: 28,
          letterSpacing: "-0.02em",
          margin: "0 0 12px",
        }}
      >
        Got it.
      </h2>
      <p style={{ color: "var(--ink-2)", margin: "0 0 18px", maxWidth: 440, marginInline: "auto" }}>
        We have sent the role brief to the WeKruit team. We will reach out at <strong>{email}</strong> within
        a business day to confirm the brief before Claire screens candidates.
      </p>
      <Link to="/" className="btn btn--primary" style={{ textDecoration: "none" }}>
        Back to home
      </Link>
    </div>
  )
}

function Header() {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "rgba(245,237,227,.82)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        className="container"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 72,
          maxWidth: 1280,
          marginInline: "auto",
          paddingInline: 24,
        }}
      >
        <Link
          to="/"
          style={{ textDecoration: "none", display: "inline-flex", alignItems: "baseline", gap: 8, color: "var(--ink)" }}
        >
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 22, letterSpacing: "-0.02em", fontWeight: 500 }}>
            WeKruit
          </span>
          <span
            aria-hidden
            style={{ display: "inline-block", width: 4, height: 4, borderRadius: 999, background: "var(--peach-300)", alignSelf: "center" }}
          />
          <em
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 20,
              fontStyle: "italic",
              fontWeight: 400,
              color: "var(--ink-2)",
            }}
          >
            Employers
          </em>
        </Link>
        <Link to="/" className="btn btn--ghost btn--sm" style={{ textDecoration: "none" }}>
          ← For candidates
        </Link>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--border)" }}>
      <div
        className="container"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "32px 24px",
          gap: 24,
          flexWrap: "wrap",
          maxWidth: 1280,
          marginInline: "auto",
        }}
      >
        <span className="caption" style={{ color: "var(--ink-3)" }}>
          Passed-profile hiring, with Claire screening first.
        </span>
        <a className="caption" style={{ color: "var(--ink-3)" }} href="mailto:hello@wekruit.com">
          hello@wekruit.com
        </a>
      </div>
    </footer>
  )
}
