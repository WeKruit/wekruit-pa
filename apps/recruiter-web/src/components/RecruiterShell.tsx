/**
 * RecruiterShell — the single app chrome for every recruiter page (Open roles,
 * Role page, Submissions). One persistent left sidebar so the recruiter surface
 * feels like one app instead of two different layouts. Pages render their own
 * content as `children` inside the scrollable main area.
 */
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { signOut } from "firebase/auth"
import "../styles/recruiter-workspace.css"
import { auth } from "../lib/firebase.js"
import { useRecruiterSession } from "../lib/recruiter-session-context.js"
import { updateRecruiterPreferences } from "../lib/recruiter-board-api.js"

const ICON_ROLES = (
  <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="3.5" width="13" height="11" rx="2" />
    <path d="M2.5 7h13" />
  </svg>
)
const ICON_SUBS = (
  <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 2.5h7l3 3V15a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 4 15z" />
    <path d="M6.5 9l1.5 1.5L11.5 7" />
  </svg>
)

export function RecruiterShell({
  children,
  openRolesCount,
  submissionsCount,
  submissionsWarn,
}: {
  children: ReactNode
  openRolesCount?: number
  submissionsCount?: number
  submissionsWarn?: boolean
}) {
  const { session } = useRecruiterSession()
  const location = useLocation()
  const recruiter = session?.recruiter ?? null

  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem("wk_recruiter_sidebar_collapsed") === "1" } catch { return false }
  })
  const toggleCollapsed = () => setCollapsed((c) => {
    const next = !c
    try { window.localStorage.setItem("wk_recruiter_sidebar_collapsed", next ? "1" : "0") } catch { /* private mode */ }
    return next
  })

  const onRoles =
    location.pathname === "/" ||
    location.pathname === "/recruiters/jobs" ||
    location.pathname.startsWith("/recruiters/job")
  const onSubs = location.pathname === "/recruiters"

  const [emailOn, setEmailOn] = useState(recruiter?.notificationPreferences?.submissionUpdatesEmail !== false)
  const [emailSaving, setEmailSaving] = useState(false)
  useEffect(() => {
    setEmailOn(recruiter?.notificationPreferences?.submissionUpdatesEmail !== false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recruiter?.recruiterId])

  const toggleEmail = async () => {
    if (emailSaving) return
    const next = !emailOn
    setEmailOn(next)
    setEmailSaving(true)
    try {
      await updateRecruiterPreferences({ notificationPreferences: { submissionUpdatesEmail: next } })
    } catch {
      setEmailOn(!next)
    } finally {
      setEmailSaving(false)
    }
  }
  const handleSignOut = () => { void signOut(auth()).catch(() => undefined) }
  const initial = (recruiter?.name || recruiter?.email || "R").trim().charAt(0).toUpperCase()

  return (
    <div className={`rw-root${collapsed ? " is-collapsed" : ""}`}>
      <aside className="rw-aside">
        <div className="rw-brand">
          <span className="rw-brand-mark">W</span>
          <span className="rw-brand-name"><strong>WeKruit</strong><em>Recruiter</em></span>
          <button
            type="button"
            className="rw-collapse-btn"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>

        <nav className="rw-nav">
          <Link to="/recruiters/jobs" className={`rw-nav-item ${onRoles ? "is-active" : ""}`} title="Open roles">
            <span className="rw-nav-label"><span className="rw-nav-icon">{ICON_ROLES}</span><span>Open roles</span></span>
            {typeof openRolesCount === "number" && <span className="rw-nav-count">{openRolesCount}</span>}
          </Link>
          <Link to="/recruiters" className={`rw-nav-item ${onSubs ? "is-active" : ""}`} title="Submissions">
            <span className="rw-nav-label"><span className="rw-nav-icon">{ICON_SUBS}</span><span>Submissions</span></span>
            {typeof submissionsCount === "number" && (
              <span className={`rw-nav-count ${submissionsWarn ? "is-warn" : ""}`}>{submissionsCount}</span>
            )}
          </Link>
        </nav>

        <div className="rw-aside-foot">
          {recruiter ? (
            <>
              <div className="rw-email-card">
                <span className="rw-email-card-copy"><strong>Email updates</strong><em>Status &amp; feedback</em></span>
                <button
                  type="button"
                  className={`rw-toggle ${emailOn ? "is-on" : ""}`}
                  onClick={() => void toggleEmail()}
                  aria-label="Toggle email updates"
                  disabled={emailSaving}
                >
                  <span className="rw-toggle-knob" />
                </button>
              </div>
              <div className="rw-user">
                <span className="rw-user-avatar">{initial}</span>
                <span className="rw-user-meta">
                  <strong>{recruiter.name || "Recruiter"}</strong>
                  <em>{recruiter.email}</em>
                </span>
              </div>
              <button type="button" className="rw-signout" onClick={handleSignOut}>Sign out</button>
            </>
          ) : (
            <Link to="/recruiters" className="rw-signout" style={{ textDecoration: "none", textAlign: "center" }}>
              Sign in
            </Link>
          )}
        </div>
      </aside>

      <main className="rw-shell-main rw-sc">{children}</main>
    </div>
  )
}
