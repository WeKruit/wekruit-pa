/**
 * AudienceToggle — segmented pill in the header that flips between candidate
 * marketing (/) and employer marketing (/employers). Active state derived
 * from the current route via react-router useLocation.
 *
 * Lives in its own file so it can be imported by both CandidateLogin (which
 * defines CandidateShell) and Sequence (where it was originally drafted)
 * without creating an import cycle.
 *
 * Style: .wk-aud / .wk-aud__tab in src/styles/wekruit-pages.css.
 */
import { useLocation, useNavigate } from "react-router-dom"

export function AudienceToggle() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const isEmployer = pathname.startsWith("/employers")
  return (
    <div className="wk-aud" role="tablist" aria-label="Audience">
      <button
        type="button"
        role="tab"
        aria-selected={!isEmployer}
        className={`wk-aud__tab${!isEmployer ? " is-active" : ""}`}
        onClick={() => navigate("/")}
      >
        For candidates
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={isEmployer}
        className={`wk-aud__tab${isEmployer ? " is-active" : ""}`}
        onClick={() => navigate("/employers")}
      >
        For companies
      </button>
    </div>
  )
}
