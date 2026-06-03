/**
 * EmployerSignup — /employer passed-profile role intake.
 *
 * Thin form → openRegisterEmployer callable → Firestore + Mailgun email to admin.
 * The user-facing frame must match /employers: employers send a role brief,
 * Claire screens candidates, and WeKruit returns consented passed profiles.
 */
import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react"
import { Link } from "react-router-dom"
import {
  EMPLOYER_PACKET_STARTERS,
  applyEmployerPacketStarter,
  buildEmployerSignupPayload,
  deriveEmployerPacketPreview,
  validateEmployerSignupForm,
  type EmployerPacketPreview as EmployerPacketPreviewModel,
  type EmployerPacketStarterId,
  type EmployerSignupFormState,
  type EmployerSignupStage,
} from "../lib/employer-signup-model.js"
import {
  deriveEmployerSignupReadiness,
  type EmployerSignupReadinessSummary,
} from "../lib/employer-signup-readiness.js"
import { registerEmployer } from "../lib/onboarding-api.js"
import "../styles/wekruit-tokens.css"

const STAGE_OPTIONS: { value: EmployerSignupStage; label: string }[] = [
  { value: "pre-seed", label: "Pre-seed" },
  { value: "seed", label: "Seed" },
  { value: "series-a", label: "Series A" },
  { value: "series-b", label: "Series B" },
  { value: "series-c-plus", label: "Series C+" },
  { value: "public", label: "Public" },
  { value: "other", label: "Other" },
]

const EMPTY_FORM: EmployerSignupFormState = {
  companyName: "",
  companyLinkedin: "",
  workEmail: "",
  contactName: "",
  roleAtCompany: "",
  stage: "",
  rolesHiring: "",
  hardFilters: "",
  screeningQuestions: "",
  calibrationExamples: "",
  feedbackLoop: "",
  introHandoff: "",
  notes: "",
}

export default function EmployerSignup() {
  const [form, setForm] = useState<EmployerSignupFormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const readiness = deriveEmployerSignupReadiness(form)
  const packetPreview = deriveEmployerPacketPreview(form)

  const update = <K extends keyof EmployerSignupFormState>(k: K, v: EmployerSignupFormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }))

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const validationError = validateEmployerSignupForm(form)
    if (validationError) {
      setError(validationError)
      return
    }
    setSubmitting(true)
    try {
      await registerEmployer(buildEmployerSignupPayload(form))
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
              fontSize: 44,
              lineHeight: 1.05,
              letterSpacing: 0,
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
              fontSize: 17,
              lineHeight: 1.5,
              color: "var(--ink-2)",
            }}
          >
            Tell us the role, must-haves, hard filters, evidence probes, calibration examples,
            feedback loop, and intro handoff behind the brief. WeKruit reviews it, Claire screens
            against the evidence, and you only see consented passed profiles with the transcript
            and risks attached.
          </p>

          {done ? <SuccessCard email={form.workEmail} /> : (
            <>
              <EmployerPacketStarters
                onApply={(starterId) => {
                  setForm((prev) => applyEmployerPacketStarter(prev, starterId))
                }}
              />
              <EmployerPacketReadiness summary={readiness} />
              <EmployerPacketPreview preview={packetPreview} />
              <EmployerCalibrationLoop />
              <form
                onSubmit={onSubmit}
                style={{
                  marginTop: 20,
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
                    onChange={(v) => update("stage", v as EmployerSignupStage | "")}
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
                  label="Primary role brief *"
                  value={form.rolesHiring}
                  onChange={(v) => update("rolesHiring", v)}
                  placeholder="Senior PM for developer platform; SF hybrid; $220k-$290k base"
                  helper="Start with the one role Claire should screen against first."
                />
                <Field
                  label="Hard filters *"
                  value={form.hardFilters}
                  onChange={(v) => update("hardFilters", v)}
                  placeholder="Requires US work authorization; SF hybrid three days per week"
                  helper="List what must stop a pass before Claire screens."
                  as="textarea"
                />
                <Field
                  label="Screening questions *"
                  value={form.screeningQuestions}
                  onChange={(v) => update("screeningQuestions", v)}
                  placeholder="Describe a platform tradeoff you owned; what evidence proves they can handle infra ambiguity?"
                  helper="List the evidence Claire should elicit in the first interview."
                  as="textarea"
                />
                <Field
                  label="Calibration examples *"
                  value={form.calibrationExamples}
                  onChange={(v) => update("calibrationExamples", v)}
                  placeholder="Strong pass: shipped a developer platform pricing migration under real customer load. False positive: only owned internal tooling without external developer users."
                  helper="Name what a strong pass and false positive look like before Claire screens."
                  as="textarea"
                />
                <Field
                  label="Must-haves *"
                  value={form.notes}
                  onChange={(v) => update("notes", v)}
                  placeholder="Founder-mode judgment, API product depth, comp band, location, must-haves Claire should probe."
                  as="textarea"
                />
                <Field
                  label="Feedback loop *"
                  value={form.feedbackLoop}
                  onChange={(v) => update("feedbackLoop", v)}
                  placeholder="After every accepted or rejected intro, Alex posts the pass/no-pass reason and one correction signal in the WeKruit thread."
                  helper="Define how the hiring team's pass/no-pass signal gets back to Claire after each passed profile."
                  as="textarea"
                />
                <Field
                  label="Intro handoff *"
                  value={form.introHandoff}
                  onChange={(v) => update("introHandoff", v)}
                  placeholder="If we accept the intro, route the candidate to Alex for a hiring-manager screen within two business days."
                  helper="Define the accepted intro owner and real next step after a pass."
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
            </>
          )}
        </div>
      </section>
      <Footer />
    </main>
  )
}

function EmployerPacketStarters({ onApply }: { onApply: (starterId: EmployerPacketStarterId) => void }) {
  return (
    <section
      aria-label="Editable role packet starters"
      style={{
        marginTop: 28,
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        background: "var(--cream-3)",
        padding: 18,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          color: "var(--ink-3)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0,
        }}
      >
        Start from a screenable packet
      </div>
      <h2
        style={{
          margin: "4px 0 0",
          fontFamily: "var(--font-serif)",
          fontWeight: 400,
          fontSize: 24,
          lineHeight: 1.12,
          color: "var(--ink)",
          letterSpacing: 0,
        }}
      >
        Pick the closest role shape, then edit the details.
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))",
          gap: 10,
          marginTop: 14,
        }}
      >
        {EMPLOYER_PACKET_STARTERS.map((starter) => (
          <article
            key={starter.id}
            style={{
              minWidth: 0,
              border: "1px solid var(--border)",
              borderRadius: "var(--r-md)",
              background: "rgba(255, 255, 255, 0.66)",
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <strong
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 14,
                lineHeight: 1.25,
                color: "var(--ink)",
              }}
            >
              {starter.label}
            </strong>
            <p
              style={{
                margin: 0,
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                lineHeight: 1.42,
                color: "var(--ink-2)",
              }}
            >
              {starter.summary}
            </p>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onApply(starter.id)}
              style={{
                marginTop: "auto",
                width: "100%",
                justifyContent: "center",
              }}
            >
              Use as editable structure
            </button>
          </article>
        ))}
      </div>
    </section>
  )
}

function EmployerCalibrationLoop() {
  const steps = [
    {
      label: "Review the role packet",
      body: "WeKruit checks the role brief, hard filters, evidence probes, calibration examples, feedback loop, and intro handoff before Claire screens.",
    },
    {
      label: "Screen with Claire",
      body: "No candidate is shared until they pass the role screen and consent.",
    },
    {
      label: "Return hiring-team signal",
      body: "Each accepted or rejected intro feeds one correction back into Claire so the next pass/no-pass boundary gets sharper.",
    },
  ]

  return (
    <section
      aria-label="Role calibration loop"
      style={{
        marginTop: 14,
        background: "var(--cream-3)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        padding: 18,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          color: "var(--ink-3)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0,
        }}
      >
        After you send the packet
      </div>
      <h2
        style={{
          margin: "4px 0 0",
          fontFamily: "var(--font-serif)",
          fontWeight: 400,
          fontSize: 24,
          lineHeight: 1.12,
          color: "var(--ink)",
          letterSpacing: 0,
        }}
      >
        Calibration loop
      </h2>
      <p
        style={{
          margin: "8px 0 0",
          fontFamily: "var(--font-sans)",
          fontSize: 14,
          lineHeight: 1.45,
          color: "var(--ink-2)",
        }}
      >
        The packet becomes the working contract for Claire, the hiring team, and WeKruit review.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
          marginTop: 14,
        }}
      >
        {steps.map((step, index) => (
          <article
            key={step.label}
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--r-md)",
              background: "rgba(255, 255, 255, 0.62)",
              padding: 12,
              minWidth: 0,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                width: 24,
                height: 24,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "999px",
                background: "var(--ink)",
                color: "var(--cream-1)",
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              {index + 1}
            </span>
            <strong
              style={{
                display: "block",
                marginTop: 10,
                fontFamily: "var(--font-sans)",
                fontSize: 14,
                lineHeight: 1.25,
                color: "var(--ink)",
              }}
            >
              {step.label}
            </strong>
            <p
              style={{
                margin: "6px 0 0",
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                lineHeight: 1.42,
                color: "var(--ink-2)",
              }}
            >
              {step.body}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}

function EmployerPacketPreview({ preview }: { preview: EmployerPacketPreviewModel }) {
  return (
    <section
      aria-label="Live Claire packet preview"
      style={{
        marginTop: 14,
        background: "var(--cream-3)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        padding: 18,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              color: "var(--ink-3)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0,
            }}
          >
            Claire screening contract
          </div>
          <h2
            style={{
              margin: "4px 0 0",
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontSize: 24,
              lineHeight: 1.12,
              color: "var(--ink)",
              letterSpacing: 0,
            }}
          >
            What WeKruit reviews
          </h2>
        </div>
        <div
          aria-label={`${preview.completedCount} of ${preview.totalCount} Claire packet sections complete`}
          style={{
            flex: "0 0 auto",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            background: preview.ready ? "var(--success-bg)" : "var(--cream-2)",
            color: preview.ready ? "var(--success)" : "var(--ink-2)",
            padding: "8px 10px",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          {preview.completedCount}/{preview.totalCount} complete
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: 10,
          marginTop: 16,
        }}
      >
        {preview.sections.map((section) => (
          <article
            key={section.id}
            style={{
              border: `1px solid ${section.complete ? "rgba(95, 119, 73, 0.26)" : "var(--border)"}`,
              borderRadius: "var(--r-md)",
              background: section.complete ? "rgba(255, 255, 255, 0.72)" : "rgba(255, 255, 255, 0.48)",
              padding: 12,
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                marginBottom: 6,
              }}
            >
              <strong
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  lineHeight: 1.25,
                  color: "var(--ink)",
                }}
              >
                {section.label}
              </strong>
              <span
                style={{
                  flex: "0 0 auto",
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: section.complete ? "var(--success)" : "var(--ink-4)",
                }}
              />
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                lineHeight: 1.42,
                color: section.complete ? "var(--ink-2)" : "var(--ink-3)",
              }}
            >
              {section.value}
            </pre>
          </article>
        ))}
      </div>
    </section>
  )
}

function EmployerPacketReadiness({ summary }: { summary: EmployerSignupReadinessSummary }) {
  return (
    <section
      aria-label="Role packet readiness"
      style={{
        marginTop: 28,
        background: "rgba(250, 245, 236, 0.78)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        padding: 18,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              color: "var(--ink-3)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0,
            }}
          >
            Before Claire screens
          </div>
          <h2
            style={{
              margin: "4px 0 0",
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontSize: 24,
              lineHeight: 1.12,
              color: "var(--ink)",
              letterSpacing: 0,
            }}
          >
            Role packet
          </h2>
          <p
            style={{
              margin: "8px 0 0",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              lineHeight: 1.45,
              color: "var(--ink-2)",
            }}
          >
            Complete these before WeKruit approves the role brief and Claire screens candidates.
          </p>
        </div>
        <div
          aria-label={`${summary.completedCount} of ${summary.totalCount} role packet items ready`}
          style={{
            flex: "0 0 auto",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            background: summary.ready ? "var(--success-bg)" : "var(--cream-2)",
            color: summary.ready ? "var(--success)" : "var(--ink-2)",
            padding: "8px 10px",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          {summary.completedCount}/{summary.totalCount} ready
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))",
          gap: 8,
          marginTop: 16,
        }}
      >
        {summary.items.map((item) => (
          <div
            key={item.id}
            style={{
              minHeight: 44,
              border: `1px solid ${item.complete ? "var(--success-bg)" : "var(--border)"}`,
              borderRadius: "var(--r-md)",
              background: item.complete ? "rgba(230, 233, 217, 0.72)" : "var(--cream-3)",
              padding: "9px 10px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                flex: "0 0 auto",
                background: item.complete ? "var(--success)" : "var(--ink-4)",
              }}
            />
            <span
              style={{
                minWidth: 0,
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                fontWeight: 650,
                color: item.complete ? "var(--success)" : "var(--ink-2)",
                lineHeight: 1.2,
                overflowWrap: "anywhere",
              }}
            >
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </section>
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
          letterSpacing: 0,
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
          letterSpacing: 0,
          margin: "0 0 12px",
        }}
      >
        Got it.
      </h2>
      <p style={{ color: "var(--ink-2)", margin: "0 0 18px", maxWidth: 440, marginInline: "auto" }}>
        We have sent the role brief to the WeKruit team. We will reach out at <strong>{email}</strong>{" "}
        within a business day to confirm the hard filters, evidence probes, calibration examples,
        feedback loop, intro handoff, and must-have evidence before Claire screens candidates.
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
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 22, letterSpacing: 0, fontWeight: 500 }}>
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
