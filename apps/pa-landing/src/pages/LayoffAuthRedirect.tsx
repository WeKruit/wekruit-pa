import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import {
  onboardingDestination,
  parseLoginNextPath,
  redirectToCandidatePortal,
} from "../lib/browser-identity.js"
import { peekSource } from "../lib/source.js"
import "../styles/wekruit-tokens.css"

/**
 * layoff.wekruit.com/login — Firebase Auth lives on candidate.wekruit.com.
 * Bounce to candidate-origin login with a safe in-app `next` path.
 */
export default function LayoffAuthRedirect() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const next = parseLoginNextPath(params.get("next"), onboardingDestination(peekSource())).to

  useEffect(() => {
    redirectToCandidatePortal(next)
  }, [next])

  return (
    <main>
      <section style={{ paddingTop: 96, paddingBottom: 96 }}>
        <div
          className="container-prose"
          style={{ maxWidth: 760, marginInline: "auto", paddingInline: 24, textAlign: "center" }}
        >
          <p style={{ color: "var(--ink-2)" }}>Redirecting to sign in…</p>
        </div>
      </section>
    </main>
  )
}
