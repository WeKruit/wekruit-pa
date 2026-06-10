// WeKruit Console — new sidebar built on the cream/espresso shell.
// Two-mode IA mapped to existing /admin/** routes. Each section
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
  mode: "ops" | "dev"
  items: NavItem[]
  defaultOpen?: boolean
}

export type NavMode = NavSectionDef["mode"]

// IA 2026-06-09 — two modes behind an [Ops | Dev] segmented toggle:
//   OPS — the founder-facing daily loop (Prescreen, Candidates, Jobs,
//         Recruiters; ~19 items total) shown by default.
//   DEV — everything else (Employers, Outreach, Matching, Eval, Claire
//         content, Platform) behind the Dev segment.
// CONSOLE_NAV stays ONE array (Topbar breadcrumbs walk it); the Sidebar
// filters by the active mode and auto-switches when the current route
// lives in the hidden mode.
export const CONSOLE_NAV: NavSectionDef[] = [
  // ───────────── OPS ─────────────
  {
    id: "prescreen",
    label: "Prescreen",
    icon: "list_check",
    mode: "ops",
    defaultOpen: true,
    items: [
      // hitl on the jobs board only — both prescreen routes carry the same
      // pending-review count, so flagging both would double the section total.
      { to: "/admin/prescreen-ops", label: "Jobs board", hitl: true },
      { to: "/admin/prescreen-sessions", label: "All sessions" },
    ],
  },
  {
    id: "candidates",
    label: "Candidates",
    icon: "users",
    mode: "ops",
    defaultOpen: true,
    items: [
      { to: "/admin/candidates", label: "All candidates", end: true },
      { to: "/admin/passed-candidates", label: "Passed candidates" },
      { to: "/admin/identity-conflicts", label: "Identity conflicts", hitl: true },
      { to: "/conversations", label: "iMessage conversations" },
    ],
  },
  {
    id: "jobs",
    label: "Jobs",
    icon: "briefcase",
    mode: "ops",
    defaultOpen: true,
    items: [
      { to: "/admin/external-supply/jobs", label: "Companies · Jobs" },
      { to: "/admin/companies", label: "Companies directory" },
      { to: "/admin/job-prescreen", label: "Prescreen config" },
      { to: "/admin/job-enrichment", label: "Enrichment review", hitl: true },
      { to: "/admin/ats-inbound", label: "ATS inbound" },
    ],
  },
  {
    id: "recruiters",
    label: "Recruiters",
    icon: "user_check",
    mode: "ops",
    // 2026-06-09 — consolidated into the Recruiter hub. The old per-surface
    // routes stay alive in App.tsx; only the nav slims.
    items: [
      { to: "/admin/recruiter-hub", label: "Recruiter hub", hitl: true },
      { to: "/admin/recruiter-access", label: "Invites & roster" },
    ],
  },
  // ───────────── DEV ─────────────
  {
    id: "employers",
    label: "Employers",
    icon: "shield",
    mode: "dev",
    defaultOpen: true,
    items: [
      { to: "/admin/layoff-employers", label: "Layoff signups", hitl: true },
    ],
  },
  {
    id: "outreach",
    label: "Outreach",
    icon: "send",
    mode: "dev",
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
  {
    id: "matching",
    label: "Matching",
    icon: "zap",
    mode: "dev",
    items: [
      { to: "/admin/match-debug", label: "Match debug" },
      { to: "/match/weights", label: "Weights" },
      { to: "/match/weights/test", label: "Weights · dry run" },
      { to: "/match/explainer-history", label: "Explainer history" },
      { to: "/match/explainer-test", label: "Explainer test" },
      { to: "/match/candidates", label: "Reverse match" },
    ],
  },
  {
    id: "eval",
    label: "Eval",
    icon: "beaker",
    mode: "dev",
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
    mode: "dev",
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
  {
    id: "platform",
    label: "Platform",
    icon: "settings",
    mode: "dev",
    items: [
      { to: "/admin/sendblue-pool", label: "Sendblue numbers" },
      { to: "/admin/flags", label: "Flags" },
      { to: "/triggers", label: "Triggers" },
      { to: "/admin/launch-readiness", label: "Launch readiness" },
      { to: "/beta", label: "Beta allowlist" },
      { to: "/abuse", label: "Abuse" },
      { to: "/admin/bulk-resumes", label: "Bulk resumes" },
      { to: "/admin/delete-user", label: "Delete user (danger)" },
    ],
  },
]

const MODE_STORAGE_KEY = "console-nav-mode"

function modeHasActive(mode: NavMode, path: string): boolean {
  return CONSOLE_NAV.some(
    (sec) => sec.mode === mode && sec.items.some((it) => isActivePath(path, it.to, it.end)),
  )
}

function modeHitlTotal(mode: NavMode, hitlCounts?: Record<string, number>): number {
  return CONSOLE_NAV.reduce((n, sec) => {
    if (sec.mode !== mode) return n
    return (
      n +
      sec.items.reduce((m, it) => {
        if (!it.hitl) return m
        return m + ((hitlCounts && hitlCounts[it.to]) ?? it.count ?? 0)
      }, 0)
    )
  }, 0)
}

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

  const storedMode =
    typeof window !== "undefined" ? window.localStorage.getItem(MODE_STORAGE_KEY) : null
  const [mode, setMode] = useState<NavMode>(storedMode === "dev" ? "dev" : "ops")
  const inactiveMode: NavMode = mode === "ops" ? "dev" : "ops"

  useEffect(() => {
    if (!modeHasActive(mode, path) && modeHasActive(inactiveMode, path)) setMode(inactiveMode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const pickMode = (next: NavMode) => {
    setMode(next)
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }

  const inactiveHitl = modeHitlTotal(inactiveMode, hitlCounts)

  return (
    <aside className="side">
      <div className="side__brand">
        <div>
          <div className="side__wordmark">WeKruit</div>
          <div className="side__product">PA Console</div>
        </div>
      </div>

      <div className="side__mode" role="tablist" aria-label="Console mode">
        {(["ops", "dev"] as const).map((m) => (
          <button
            key={m}
            className="side__mode-seg"
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => pickMode(m)}
          >
            {m === "ops" ? "Ops" : "Dev"}
            {m === inactiveMode && inactiveHitl > 0 && (
              <span className="side__count side__count--hitl">{inactiveHitl}</span>
            )}
          </button>
        ))}
      </div>

      {CONSOLE_NAV.filter((section) => section.mode === mode).map((section) => (
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
      <button type="button" className="side__section-head" aria-expanded={open} onClick={toggle}>
        <Icon name="chev_r" size={10} className="side__chev" />
        <Icon name={section.icon} size={13} style={{ color: "var(--ink-3)" }} />
        <span style={{ flex: 1, textAlign: "left" }}>{section.label}</span>
        {totalHitl > 0 && (
          <span className="side__count side__count--hitl">{totalHitl}</span>
        )}
      </button>
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
