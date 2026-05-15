// WeKruit Console — new sidebar built on the cream/espresso shell.
// 6-section IA mapped to existing /admin/** routes. Each section
// collapses; state persists to localStorage under `console-side-<id>`.
// HITL counts surface on the section header even when collapsed.

import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Icon } from "./Icon.js"

export type NavItem = {
  to: string
  label: string
  count?: number
  hitl?: boolean
  end?: boolean
}

export type NavSectionDef = {
  id: string
  label: string
  icon: string
  items: NavItem[]
  defaultOpen?: boolean
}

export const CONSOLE_NAV: NavSectionDef[] = [
  {
    id: "candidates",
    label: "Candidates",
    icon: "users",
    defaultOpen: true,
    items: [
      { to: "/conversations", label: "All candidates" },
      { to: "/admin/passed-candidates", label: "Passed candidates" },
      { to: "/admin/identity-conflicts", label: "Identity conflicts", hitl: true },
      { to: "/match/candidates", label: "Reverse match" },
      { to: "/admin/bulk-resumes", label: "Bulk resumes" },
    ],
  },
  {
    id: "jobs",
    label: "Jobs",
    icon: "briefcase",
    items: [
      { to: "/admin/external-supply/jobs", label: "Companies · Jobs" },
      { to: "/admin/job-prescreen", label: "Prescreen config" },
      { to: "/admin/job-enrichment", label: "Enrichment review", hitl: true },
      { to: "/admin/ats-inbound", label: "ATS inbound" },
    ],
  },
  {
    id: "matches",
    label: "Matches",
    icon: "zap",
    items: [
      { to: "/admin/match-debug", label: "Match debug" },
      { to: "/match/weights", label: "Weights" },
      { to: "/match/weights/test", label: "Weights · dry run" },
      { to: "/match/explainer-history", label: "Explainer history" },
      { to: "/match/explainer-test", label: "Explainer test" },
    ],
  },
  {
    id: "outreach",
    label: "Outreach",
    icon: "send",
    items: [
      { to: "/admin/outreach-ops", label: "Outreach ops" },
      { to: "/admin/sendblue-pool", label: "Sendblue pool" },
      { to: "/admin/external-supply", label: "External supply", end: true },
      { to: "/admin/external-supply/outreach", label: "Outreach campaigns" },
      { to: "/admin/external-supply/sync", label: "Instantly sync" },
      { to: "/admin/external-supply/audit", label: "Audit" },
    ],
  },
  {
    id: "quality",
    label: "Quality",
    icon: "beaker",
    items: [
      { to: "/eval/voice-review", label: "Voice review" },
      { to: "/eval/n-round-sim", label: "N-round sim" },
      { to: "/admin/flywheel-eval", label: "Flywheel eval" },
      { to: "/admin/qa-evaluator", label: "QA evaluator" },
      { to: "/admin/prescreen-feedback", label: "Prescreen feedback" },
      { to: "/admin/external-supply/review", label: "Review queue" },
      { to: "/admin/external-supply/evaluations", label: "Evaluations" },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    icon: "settings",
    items: [
      { to: "/admin/prescreen-sessions", label: "Prescreen sessions" },
      { to: "/admin/flags", label: "Flags" },
      { to: "/admin/canonical-tags", label: "Canonical tags" },
      { to: "/agents", label: "Agents" },
      { to: "/agent/playbooks", label: "Playbooks" },
      { to: "/agent/personas", label: "Personas" },
      { to: "/admin/handbook", label: "Handbook" },
      { to: "/admin/onboarding-questions", label: "Onboarding questions" },
      { to: "/admin/launch-readiness", label: "Launch readiness" },
      { to: "/admin/upstream-templates", label: "Upstream templates" },
      { to: "/admin/downstream-triggers", label: "Downstream triggers" },
      { to: "/triggers", label: "Triggers" },
      { to: "/beta", label: "Beta allowlist" },
      { to: "/abuse", label: "Abuse" },
    ],
  },
]

export function Sidebar({
  userEmail,
  hitlCounts,
  onSignOut,
}: {
  userEmail: string
  hitlCounts?: Record<string, number>
  onSignOut: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const path = location.pathname

  return (
    <aside className="side">
      <div className="side__brand">
        <div>
          <div className="side__wordmark">WeKruit</div>
          <div className="side__product">PA Console</div>
        </div>
      </div>

      {CONSOLE_NAV.map((section) => (
        <SidebarSection
          key={section.id}
          section={section}
          path={path}
          onNavigate={(to) => navigate(to)}
          hitlCounts={hitlCounts}
        />
      ))}

      <div className="side__footer">
        <div className="side__avatar">{initials(userEmail)}</div>
        <div className="side__who">
          <div className="side__email" title={userEmail}>
            {userEmail}
          </div>
        </div>
        <button className="side__signout" title="Sign out" onClick={onSignOut} type="button">
          <Icon name="log_out" size={15} />
        </button>
      </div>
    </aside>
  )
}

function initials(email: string): string {
  if (!email) return "??"
  const local = email.split("@")[0] || ""
  const parts = local.split(/[._-]/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return (local.slice(0, 2) || "??").toUpperCase()
}

function isActivePath(path: string, to: string, end?: boolean): boolean {
  if (end) return path === to
  return path === to || path.startsWith(to + "/")
}

function SidebarSection({
  section,
  path,
  onNavigate,
  hitlCounts,
}: {
  section: NavSectionDef
  path: string
  onNavigate: (to: string) => void
  hitlCounts?: Record<string, number>
}) {
  const hasActive = section.items.some((it) => isActivePath(path, it.to, it.end))
  const storageKey = `console-side-${section.id}`
  const stored = typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null
  const initial =
    stored === null ? !!(section.defaultOpen || hasActive) : stored === "open"
  const [open, setOpen] = useState(initial)

  useEffect(() => {
    if (hasActive && !open) setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive])

  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      window.localStorage.setItem(storageKey, next ? "open" : "closed")
    } catch {
      /* ignore */
    }
  }

  const totalHitl = section.items.reduce((n, it) => {
    if (!it.hitl) return n
    const c = (hitlCounts && hitlCounts[it.to]) ?? it.count ?? 0
    return n + c
  }, 0)

  return (
    <div className="side__section" data-open={open}>
      <div className="side__section-head" onClick={toggle}>
        <Icon name="chev_r" size={10} className="side__chev" />
        <Icon name={section.icon} size={13} style={{ color: "var(--ink-3)" }} />
        <span style={{ flex: 1 }}>{section.label}</span>
        {totalHitl > 0 && (
          <span className="side__count side__count--hitl">{totalHitl}</span>
        )}
      </div>
      {open && (
        <div className="side__section-body">
          {section.items.map((item) => {
            const active = isActivePath(path, item.to, item.end)
            const count = (hitlCounts && hitlCounts[item.to]) ?? item.count ?? 0
            return (
              <button
                key={item.to}
                className="side__link"
                aria-current={active ? "page" : undefined}
                onClick={() => onNavigate(item.to)}
                type="button"
              >
                <span>{item.label}</span>
                {count > 0 && (
                  <span className={`side__count ${item.hitl ? "side__count--hitl" : ""}`}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
