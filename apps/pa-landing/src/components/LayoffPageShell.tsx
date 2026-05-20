import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { layoffSignupLoginPath } from "../lib/browser-identity.js"
import "../styles/wekruit-tokens.css"

function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <Link
      to="/"
      style={{ textDecoration: "none", display: "inline-flex", alignItems: "baseline", gap: 8, color: "var(--ink)" }}
    >
      <span style={{ fontFamily: "var(--font-serif)", fontSize: size, letterSpacing: "-0.02em", fontWeight: 500 }}>
        WeKruit
      </span>
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 4,
          height: 4,
          borderRadius: 999,
          background: "var(--peach-300)",
          alignSelf: "center",
        }}
      />
      <em
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: size - 2,
          fontStyle: "italic",
          fontWeight: 400,
          color: "var(--ink-2)",
        }}
      >
        Open
      </em>
    </Link>
  )
}

/** Layoff.wekruit.com chrome — matches LayoffLanding nav, not candidate Open marketplace shell. */
export function LayoffPageShell({
  children,
  hideSignupCta = false,
}: {
  children: ReactNode
  hideSignupCta?: boolean
}) {
  const linkStyle = {
    fontFamily: "var(--font-sans)",
    fontSize: 14,
    color: "var(--ink-2)",
    fontWeight: 400,
    textDecoration: "none",
    letterSpacing: "-0.005em",
  } as const

  return (
    <div style={{ minHeight: "100vh", background: "var(--cream)" }}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "rgba(245,237,227,.92)",
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
          <Wordmark />
          <nav style={{ display: "flex", gap: 32, alignItems: "center" }}>
            <Link to="/" style={linkStyle}>
              For candidates
            </Link>
            <Link to="/employer" style={linkStyle}>
              For employers
            </Link>
          </nav>
          {hideSignupCta ? (
            <span style={{ width: 120 }} aria-hidden />
          ) : (
            <Link to={layoffSignupLoginPath()} className="btn btn--primary btn--sm" style={{ textDecoration: "none" }}>
              Add your name
            </Link>
          )}
        </div>
      </header>
      <main>{children}</main>
    </div>
  )
}
