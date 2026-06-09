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

// IA 2026-05-18 — three tiers, ranking top→bottom by daily-touch frequency:
//   1) OPERATIONS  — run the business (Candidates, Jobs, Employers, Outreach)
//   2) TRAINING / EVAL — improve Claire (Matching, Eval, Claire content)
//   3) PLATFORM — rare admin (Flags, Triggers, Launch readiness, Beta, Abuse)
// Each section caps at ≤8 items; previously the 16-item Platform group bloat
// hid Employer role packets + Companies + Agents content inside one wall.
export const CONSOLE_NAV: NavSectionDef[] = [
  // ───────────── Tier 1: OPERATIONS ─────────────
  {
    id: "candidates",
    label: "Candidates",
    icon: "users",
    defaultOpen: true,
    items: [
      { to: "/admin/candidates", label: "All candidates", end: true },
      { to: "/admin/passed-candidates", label: "Passed candidates" },
      { to: "/admin/identity-conflicts", label: "Identity conflicts", hitl: true },
      { to: "/conversations", label: "iMessage conversations" },
      { to: "/match/candidates", label: "Reverse match" },
      { to: "/admin/bulk-resumes", label: "Bulk resumes" },
      { to: "/admin/delete-user", label: "Delete user (danger)" },
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
    id: "recruiters",
    label: "Recruiters",
    icon: "user_check",
    defaultOpen: true,
    items: [
      { to: "/admin/recruiter-access", label: "Recruiter invites" },
      { to: "/admin/recruiter-roles", label: "Roles" },
      { to: "/admin/recruiter-quality", label: "Quality review", hitl: true },
      { to: "/admin/recruiter-applications", label: "Applications", hitl: true },
      { to: "/admin/recruiter-sourced", label: "Sourced candidates", hitl: true },
      { to: "/admin/recruiter-feedback", label: "Role feedback", hitl: true },
      { to: "/admin/recruiter-questions", label: "Role questions", hitl: true },
      { to: "/admin/recruiter-submissions", label: "Submissions", hitl: true },
    ],
  },
  {
    id: "employers",
    label: "Employers",
    icon: "shield",
    defaultOpen: true,
    items: [
      { to: "/admin/layoff-employers", label: "Role packets", hitl: true },
      { to: "/admin/companies", label: "Companies directory" },
    ],
  },
  {
    id: "outreach",
    label: "Outreach",
    icon: "send",
    items: [
      { to: "/admin/outreach-ops", label: "Outreach ops" },
      { to: "/admin/pending-outbound", label: "Pending outbound", hitl: true },
      { to: "/admin/external-supply", label: "External supply", end: true },
      { to: "/admin/external-supply/outreach", label: "Outreach campaigns" },
      { to: "/admin/external-supply/sync", label: "Instantly sync" },
      { to: "/admin/external-supply/audit", label: "Audit" },
      { to: "/admin/coresignal-playground", label: "Coresignal · Agentic search" },
      { to: "/admin/voice-test-dial", label: "Voice test dial" },
      { to: "/admin/qr-campaigns", label: "QR campaigns" },
    ],
  },
  // ───────────── Tier 2: TRAINING / EVAL ─────────────
  {
    id: "matching",
    label: "Matching",
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
    id: "eval",
    label: "Eval",
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
    id: "claire",
    label: "Claire content",
    icon: "cpu",
    items: [
      { to: "/agents", label: "Agents" },
      { to: "/agent/playbooks", label: "Playbooks" },
      { to: "/agent/personas", label: "Personas" },
      { to: "/admin/handbook", label: "Handbook" },
      { to: "/admin/onboarding-questions", label: "Onboarding questions" },
      { to: "/admin/practice-question-bank", label: "Practice questions" },
      { to: "/admin/upstream-templates", label: "Upstream templates" },
      { to: "/admin/downstream-triggers", label: "Downstream triggers" },
      { to: "/admin/canonical-tags", label: "Canonical tags" },
    ],
  },
  // ───────────── Tier 3: PLATFORM ─────────────
  {
    id: "platform",
    label: "Platform",
    icon: "settings",
    items: [
      { to: "/admin/sendblue-pool", label: "Sendblue numbers" },
      { to: "/admin/flags", label: "Flags" },
      { to: "/triggers", label: "Triggers" },
      { to: "/admin/prescreen-sessions", label: "Prescreen sessions" },
      { to: "/admin/launch-readiness", label: "Launch readiness" },
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
