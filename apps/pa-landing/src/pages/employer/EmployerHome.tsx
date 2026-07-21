/**
 * EmployerHome — /employer/home "your reqs" home for a returning employer.
 *
 * Phase 4: before this, a returning employer landed on the static /employers
 * marketing page with no record of what they'd set up. This page reads the
 * employer's OWN pilot reqs (paEmployerMyReqs, keyed by the self-asserted
 * onboarding work email persisted in the wizard localStorage) and the
 * server-mirrored wizard progress (paEmployerOnboardingState), so a returning
 * employer has a real home: their reqs, status, and links back into the wizard
 * + the live passed-candidate inbox.
 *
 * HONEST SCOPE: there is no real employer auth on this public flow yet. The
 * email is self-asserted (read from the wizard's localStorage state, or typed
 * here if missing). These callables return only this employer's own non-PII req
 * metadata; the passed inbox (separate page) is consent-gated + PII-redacted.
 *
 * Reuses the wk-token design system (cream + serif + peach) so it matches the
 * employer onboarding wizard, not the admin console.
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react"
import { Link } from "react-router-dom"
import {
  employerMyReqs,
  employerOnboardingState,
  type EmployerReqRow,
} from "../../lib/onboarding-api.js"
import {
  loadWizardState,
  normalizeEmployerEmail,
  saveWizardState,
} from "../../lib/employer-onboarding-state.js"
import "../../styles/wekruit-tokens.css"

function prettyStatus(status: string): string {
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function prettyDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

export default function EmployerHome() {
  // Hydrate the employer email from the wizard's persisted state.
  const [email, setEmail] = useState<string>(() => {
    const s = loadWizardState()
    return normalizeEmployerEmail(s.employerEmail) ?? ""
  })
  const [emailInput, setEmailInput] = useState<string>(email)
  const [reqs, setReqs] = useState<EmployerReqRow[] | null>(null)
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle")
  const [error, setError] = useState<string | null>(null)
  const [serverActiveStep, setServerActiveStep] = useState<number | null>(null)

  const load = useCallback(async (resolvedEmail: string) => {
    const normalized = normalizeEmployerEmail(resolvedEmail)
    if (!normalized) {
      setStatus("error")
      setError("Enter the work email you onboarded with.")
      return
    }
    setStatus("loading")
    setError(null)
    try {
      const [reqsOut, stateOut] = await Promise.all([
        employerMyReqs(normalized),
        employerOnboardingState({ mode: "get", employerEmail: normalized }).catch(() => null),
      ])
      setReqs(reqsOut.reqs)
      setServerActiveStep(
        stateOut?.found && typeof stateOut.state?.activeStep === "number"
          ? stateOut.state.activeStep
          : null,
      )
      setStatus("done")
      // Persist the resolved email back into the wizard state so the wizard +
      // inbox keep using the same key.
      const s = loadWizardState()
      saveWizardState({ ...s, employerEmail: normalized })
    } catch (err) {
      setStatus("error")
      setError(
        err instanceof Error ? err.message : "Couldn't load your reqs. Try again in a moment.",
      )
    }
  }, [])

  useEffect(() => {
    if (email) void load(email)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSubmitEmail = useCallback(() => {
    const normalized = normalizeEmployerEmail(emailInput)
    if (!normalized) {
      setError("Enter a valid work email.")
      return
    }
    setEmail(normalized)
    void load(normalized)
  }, [emailInput, load])

  return (
    <main style={{ background: "var(--cream)", minHeight: "100vh" }}>
      <HomeHeader />

      <section style={{ paddingTop: "clamp(36px, 7vw, 56px)", paddingBottom: 28 }}>
        <div className="container-narrow" style={{ maxWidth: 980 }}>
          <span className="eyebrow" style={{ color: "var(--live)" }}>
            Your WeKruit home
          </span>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontSize: "clamp(32px, 7vw, 44px)",
              lineHeight: 1.08,
              letterSpacing: "-0.01em",
              color: "var(--ink)",
              margin: "12px 0 0",
            }}
          >
            Your pilot reqs &amp; passed candidates.
          </h1>
          {email ? (
            <p style={{ color: "var(--ink-2)", margin: "12px 0 0", fontSize: "var(--fs-lead)" }}>
              Keyed to <strong>{email}</strong>.{" "}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ marginLeft: 6 }}
                onClick={() => {
                  setEmail("")
                  setReqs(null)
                  setStatus("idle")
                }}
              >
                Use a different email
              </button>
            </p>
          ) : null}
        </div>
      </section>

      <section style={{ paddingBottom: 96 }}>
        <div className="container-narrow" style={{ maxWidth: 980 }}>
          {!email ? (
            <div style={card}>
              <h2 style={cardTitle}>Find your home</h2>
              <p style={{ color: "var(--ink-2)", margin: "0 0 14px" }}>
                Enter the work email you onboarded with to see your reqs.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSubmitEmail()
                  }}
                  placeholder="you@company.com"
                  style={{ ...inputBase, flex: "1 1 260px" }}
                />
                <button type="button" className="btn btn--primary" onClick={onSubmitEmail}>
                  Load my reqs
                </button>
              </div>
              {error ? <p style={errorText}>{error}</p> : null}
            </div>
          ) : status === "loading" ? (
            <div style={card}>
              <p style={{ color: "var(--ink-2)", margin: 0 }}>Loading your reqs…</p>
            </div>
          ) : status === "error" ? (
            <div style={card}>
              <p style={errorText}>{error}</p>
              <button type="button" className="btn btn--secondary" onClick={() => load(email)}>
                Retry
              </button>
            </div>
          ) : reqs && reqs.length > 0 ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 12 }}>
                <h2 style={{ ...cardTitle, margin: 0 }}>
                  {reqs.length} {reqs.length === 1 ? "pilot req" : "pilot reqs"}
                </h2>
                <div style={{ display: "flex", gap: 10 }}>
                  <Link to="/employers/inbox" className="btn btn--secondary btn--sm" style={{ textDecoration: "none" }}>
                    Passed inbox
                  </Link>
                  <Link to="/employer/onboarding" className="btn btn--primary btn--sm" style={{ textDecoration: "none" }}>
                    {serverActiveStep != null ? "Resume setup" : "Add a req"}
                  </Link>
                </div>
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                {reqs.map((r) => (
                  <li key={r.reqId} style={reqRow}>
                    <div style={{ minWidth: 0 }}>
                      <div style={reqTitle}>{r.title || "Untitled role"}</div>
                      <div style={reqMeta}>
                        {r.companyName ? `${r.companyName} · ` : ""}
                        Created {prettyDate(r.createdAt)}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                      <span style={statusChip}>{prettyStatus(r.status)}</span>
                      <Link
                        to={`/employers/inbox?jobId=${encodeURIComponent(r.reqId)}`}
                        className="btn btn--ghost btn--sm"
                        style={{ textDecoration: "none" }}
                      >
                        View passes
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div style={card}>
              <h2 style={cardTitle}>No reqs yet</h2>
              <p style={{ color: "var(--ink-2)", margin: "0 0 16px" }}>
                You haven&apos;t calibrated a pilot req under this email yet. Start one and
                Claire turns it into a screened, consented pass record.
              </p>
              <Link to="/employer/onboarding" className="btn btn--primary" style={{ textDecoration: "none" }}>
                {serverActiveStep != null ? "Resume setup" : "Calibrate your first req"}
              </Link>
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

function HomeHeader() {
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
          to="/employers"
          style={{ textDecoration: "none", display: "inline-flex", alignItems: "baseline", gap: 8, color: "var(--ink)" }}
        >
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 500 }}>WeKruit</span>
          <em style={{ fontFamily: "var(--font-serif)", fontSize: 20, fontStyle: "italic", color: "var(--ink-2)" }}>
            Employers
          </em>
        </Link>
        <Link to="/employers/inbox" className="btn btn--ghost btn--sm" style={{ textDecoration: "none" }}>
          Passed inbox →
        </Link>
      </div>
    </header>
  )
}

// ---- styles -----------------------------------------------------------------

const card: CSSProperties = {
  background: "var(--cream-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-lg, 16px)",
  padding: 24,
}
const cardTitle: CSSProperties = {
  fontFamily: "var(--font-serif)",
  fontWeight: 400,
  fontSize: 22,
  color: "var(--ink)",
  margin: "0 0 8px",
}
const inputBase: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md, 10px)",
  padding: "11px 14px",
  fontSize: 15,
  color: "var(--ink)",
  background: "var(--cream)",
}
const errorText: CSSProperties = { color: "var(--danger, #b3261e)", margin: "12px 0 0", fontSize: 14 }
const reqRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  background: "var(--cream-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md, 12px)",
  padding: "16px 18px",
}
const reqTitle: CSSProperties = {
  fontFamily: "var(--font-serif)",
  fontSize: 18,
  color: "var(--ink)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}
const reqMeta: CSSProperties = { fontSize: 13, color: "var(--ink-3)", marginTop: 3 }
const statusChip: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--ink-2)",
  background: "var(--peach-50, var(--cream))",
  border: "1px solid var(--peach-200, var(--border))",
  borderRadius: "var(--r-pill)",
  padding: "4px 10px",
  whiteSpace: "nowrap",
}
