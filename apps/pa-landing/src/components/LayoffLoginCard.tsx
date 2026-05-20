import { Link } from "react-router-dom"
import { LayoffPageShell } from "./LayoffPageShell.js"

type Props = {
  status: "idle" | "google" | "linkedin" | "signing_in" | "error"
  error: string | null
  busy: boolean
  onGoogle: () => void
  onLinkedIn: () => void
  onRetry: () => void
}

export function LayoffLoginCard({ status, error, busy, onGoogle, onLinkedIn, onRetry }: Props) {
  const signingIn = status === "signing_in"

  return (
    <LayoffPageShell hideSignupCta>
      <section
        style={{
          minHeight: "calc(100vh - 72px)",
          background: "var(--halo-hero)",
          padding: "56px 24px 96px",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
        }}
      >
        <div
          className="card"
          style={{
            width: "100%",
            maxWidth: 420,
            padding: "36px 32px 32px",
            boxShadow: "var(--shadow-lg)",
            borderRadius: "var(--r-lg)",
          }}
        >
          <p className="eyebrow" style={{ marginBottom: 14 }}>
            WeKruit Open
          </p>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontSize: "clamp(32px, 5vw, 40px)",
              lineHeight: 1.08,
              letterSpacing: "-0.02em",
              margin: "0 0 12px",
              color: "var(--ink)",
            }}
          >
            Add your name — <em className="accent">60 sec.</em>
          </h1>
          <p
            style={{
              margin: "0 0 28px",
              fontSize: "var(--fs-body-sm)",
              lineHeight: 1.55,
              color: "var(--ink-2)",
            }}
          >
            {signingIn
              ? "Confirming your sign-in and opening onboarding…"
              : "Continue with Google to finish your profile — resume and your Claire intro in iMessage."}
          </p>

          {signingIn ? (
            <p style={{ margin: "0 0 20px", fontSize: 14, color: "var(--ink-3)" }}>Signing you in…</p>
          ) : null}

          <div style={{ display: "grid", gap: 10 }}>
            <button
              type="button"
              className="btn btn--primary btn--lg"
              style={{ width: "100%" }}
              onClick={onGoogle}
              disabled={busy}
            >
              {status === "google" ? "Opening Google…" : "Continue with Google"}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--lg"
              style={{ width: "100%" }}
              onClick={onLinkedIn}
              disabled={busy}
            >
              {status === "linkedin" ? "Opening LinkedIn…" : "Continue with LinkedIn"}
            </button>
          </div>

          {error ? (
            <p
              style={{
                margin: "20px 0 0",
                fontSize: 14,
                lineHeight: 1.5,
                color: "var(--danger)",
              }}
            >
              {error}{" "}
              <button
                type="button"
                onClick={onRetry}
                style={{
                  background: "none",
                  border: 0,
                  padding: 0,
                  color: "var(--ink)",
                  textDecoration: "underline",
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
                Try again
              </button>
            </p>
          ) : null}

          <p style={{ margin: "24px 0 0", textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
            <Link to="/" style={{ color: "var(--ink-2)", textDecoration: "none" }}>
              ← Back to landing
            </Link>
          </p>
        </div>
      </section>
    </LayoffPageShell>
  )
}
