import { Link, useLocation } from "react-router-dom"
import "../styles/site-header.css"
import { useRecruiterSession } from "../lib/recruiter-session-context.js"

export function SiteHeader() {
  const { session, authReady } = useRecruiterSession()
  const location = useLocation()
  const isJobs = location.pathname === "/recruiters/jobs" || location.pathname === "/"

  return (
    <header className="sh">
      <Link to="/recruiters/jobs" className="sh__brand">
        <span className="sh__icon">W</span>
        <span className="sh__name">WeKruit<span className="sh__sub">Recruiter</span></span>
      </Link>
      <nav className="sh__nav">
        <Link to="/recruiters/jobs" className={`sh__link${isJobs ? " is-active" : ""}`}>Open roles</Link>
        {authReady && session ? (
          <Link to="/recruiters" className={`sh__link${!isJobs ? " is-active" : ""}`}>My workspace</Link>
        ) : (
          <Link to="/recruiters" className="sh__link sh__link--cta">Sign in</Link>
        )}
      </nav>
    </header>
  )
}
