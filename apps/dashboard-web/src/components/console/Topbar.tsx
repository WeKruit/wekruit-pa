// WeKruit Console — sticky topbar with breadcrumbs + cmd-K hint + bell.
// Crumbs are derived from the current pathname so every page gets them
// for free; pages can still mount their own <Crumbs> inside the page
// body when a richer trail (e.g. Company → Job → Candidate) is needed.

import { useMemo } from "react"
import { Link, useLocation } from "react-router-dom"
import { Icon } from "./Icon.js"
import { CONSOLE_NAV } from "./Sidebar.js"

const SEG_LABELS: Record<string, string> = {
  admin: "Admin",
  external: "External supply",
  "external-supply": "External supply",
  match: "Matches",
  matches: "Matches",
  eval: "Quality",
  agent: "Platform",
  agents: "Agents",
  users: "Candidates",
  conversations: "Candidates",
  beta: "Beta",
  abuse: "Abuse",
  triggers: "Triggers",
  "job-prescreen": "Prescreen config",
  "job-enrichment": "Enrichment review",
  "prescreen-ops": "Prescreen ops",
  "prescreen-sessions": "Prescreen sessions",
  "prescreen-feedback": "Prescreen feedback",
  "ats-inbound": "ATS inbound",
  "bulk-resumes": "Bulk resumes",
  "outreach-ops": "Outreach ops",
  "sendblue-pool": "Sendblue pool",
  "match-debug": "Match debug",
  "passed-candidates": "Passed candidates",
  "identity-conflicts": "Identity conflicts",
  "canonical-tags": "Canonical tags",
  "qa-evaluator": "QA evaluator",
  "flywheel-eval": "Flywheel eval",
  "launch-readiness": "Launch readiness",
  "voice-review": "Voice review",
  "n-round-sim": "N-round sim",
  flags: "Flags",
  handbook: "Handbook",
  "onboarding-questions": "Onboarding questions",
  "practice-question-bank": "Practice question bank",
  playbooks: "Playbooks",
  personas: "Personas",
  weights: "Weights",
  candidates: "Candidates",
  jobs: "Jobs",
  batches: "Batches",
  evaluations: "Evaluations",
  outreach: "Outreach",
  sync: "Sync",
  audit: "Audit",
  research: "Research",
  review: "Review queue",
  new: "New",
  "tag-snapshots": "Tag snapshots",
  "agent-ranking": "Agent ranking",
  "explainer-history": "Explainer history",
  "explainer-test": "Explainer test",
  "upstream-templates": "Upstream templates",
  "downstream-triggers": "Downstream triggers",
}

function label(seg: string): string {
  return SEG_LABELS[seg] || seg.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase())
}

function findSectionLabel(path: string): string | null {
  for (const sec of CONSOLE_NAV) {
    if (sec.items.some((it) => path === it.to || path.startsWith(it.to + "/"))) {
      return sec.label
    }
  }
  return null
}

export function Topbar() {
  const location = useLocation()
  const crumbs = useMemo(() => {
    const segs = location.pathname.split("/").filter(Boolean)
    if (segs.length === 0) return [{ label: "Home", to: "/" }]
    const out: { label: string; to: string }[] = [{ label: "Home", to: "/" }]
    const section = findSectionLabel(location.pathname)
    if (section) out.push({ label: section, to: "" })
    // Use the last 2 path segments as the leaf trail (avoids long IDs).
    const tail = segs.slice(-2)
    let acc = ""
    for (const s of segs) {
      acc += "/" + s
    }
    let runAcc = ""
    for (const s of segs) {
      runAcc += "/" + s
      if (tail.includes(s)) out.push({ label: label(s), to: runAcc })
    }
    return out
  }, [location.pathname])

  return (
    <header className="topbar">
      <div className="crumbs">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1
          if (i > 0) {
            return (
              <span key={`sep-${i}`} style={{ display: "contents" }}>
                <Icon name="chev_r" size={12} className="crumbs__sep" />
                {isLast || !c.to ? (
                  <span className={isLast ? "crumbs__leaf" : undefined}>{c.label}</span>
                ) : (
                  <Link to={c.to}>{c.label}</Link>
                )}
              </span>
            )
          }
          return c.to ? (
            <Link key={i} to={c.to}>
              {c.label}
            </Link>
          ) : (
            <span key={i}>{c.label}</span>
          )
        })}
      </div>

      <button className="topbar__cmd" type="button" disabled title="Command palette (coming soon)">
        <Icon name="search" size={12} />
        Search
        <span className="topbar__kbd">⌘K</span>
      </button>

      <button className="topbar__icon-btn" type="button" title="Notifications">
        <Icon name="bell" size={15} />
      </button>
    </header>
  )
}
