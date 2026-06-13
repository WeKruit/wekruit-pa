import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { RecruiterShell } from "../components/RecruiterShell.js"
import "../styles/open-jobs.css"
import { fetchCollabJobs, type CollabJob } from "../lib/recruiter-board-api.js"

// Mirror of the backend priority sort so the board orders correctly even on a
// stale/cached response: urgent → high → normal → paused, ranked floats up.
const PRIORITY_TIER_WEIGHT: Record<string, number> = { urgent: 0, high: 1_000, normal: 2_000, paused: 3_000 }
function priorityScore(job: CollabJob): number {
  const p = job.recruiterBoard.priority
  const base = p ? (PRIORITY_TIER_WEIGHT[p.tier] ?? 2_000) : 2_000
  const rank = p?.rank != null ? p.rank : 999
  return base + rank
}

const PRIORITY_BADGE: Record<string, { label: string; cls: string }> = {
  urgent: { label: "Urgent", cls: "is-urgent" },
  high: { label: "High priority", cls: "is-high" },
  paused: { label: "Paused", cls: "is-paused" },
}

// Display company name without the " · <description>" suffix the board bakes
// into the label, so the filter dropdown shows clean names.
function companyName(job: CollabJob): string {
  const c = job.recruiterBoard.label.company ?? ""
  const sep = c.indexOf(" · ")
  return (sep >= 0 ? c.slice(0, sep) : c).trim()
}

export default function OpenJobsPage() {
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [company, setCompany] = useState<string>("") // "" = all companies

  useEffect(() => {
    fetchCollabJobs()
      .then((list) => setJobs(list.filter((j) => j.recruiterBoard.active)))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  const companies = useMemo(() => {
    if (!jobs) return []
    const set = new Set<string>()
    for (const j of jobs) {
      const n = companyName(j)
      if (n) set.add(n)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [jobs])

  const visible = useMemo(() => {
    if (!jobs) return []
    const filtered = company ? jobs.filter((j) => companyName(j) === company) : jobs
    return [...filtered].sort((a, b) => {
      const pa = priorityScore(a)
      const pb = priorityScore(b)
      if (pa !== pb) return pa - pb
      return a.recruiterBoard.sortOrder - b.recruiterBoard.sortOrder
    })
  }, [jobs, company])

  return (
    <RecruiterShell openRolesCount={jobs?.length}>
      <main className="oj-main">
        <div className="oj-hero">
          <h1>Open roles</h1>
          <p>Browse active WeKruit collab roles. Sign in to submit candidates.</p>
        </div>

        {error && <p className="oj-error">Could not load jobs: {error}</p>}

        {!jobs && !error && <p className="oj-loading">Loading roles…</p>}

        {jobs && jobs.length > 0 && (
          <div className="oj-toolbar">
            <label className="oj-filter">
              <span className="oj-filter__label">Company</span>
              <select
                className="oj-filter__select"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              >
                <option value="">All companies ({jobs.length})</option>
                {companies.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <span className="oj-toolbar__count">
              {visible.length} {visible.length === 1 ? "role" : "roles"}
              {company ? ` at ${company}` : ""}
            </span>
            {company && (
              <button type="button" className="oj-filter__clear" onClick={() => setCompany("")}>
                Clear
              </button>
            )}
          </div>
        )}

        {jobs && jobs.length === 0 && <p className="oj-empty">No open roles right now. Check back soon.</p>}

        {jobs && jobs.length > 0 && visible.length === 0 && (
          <p className="oj-empty">No roles match this filter.</p>
        )}

        {visible.length > 0 && (
          <div className="oj-grid">
            {visible.map((job) => {
              const badge = job.recruiterBoard.priority
                ? PRIORITY_BADGE[job.recruiterBoard.priority.tier]
                : undefined
              return (
                <Link key={job.jobId} to={`/recruiters/job/${job.jobId}`} className="oj-card">
                  {badge && <span className={`oj-priority ${badge.cls}`}>{badge.label}</span>}
                  <div className="oj-card__header">
                    <h2>{job.title}</h2>
                    {job.companyWebsite ? (
                      <a
                        className="oj-card__company oj-card__company--link"
                        href={job.companyWebsite}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {job.recruiterBoard.label.company} ↗
                      </a>
                    ) : (
                      <span className="oj-card__company">{job.recruiterBoard.label.company}</span>
                    )}
                  </div>
                  <div className="oj-card__meta">
                    <span>{job.recruiterBoard.label.location}</span>
                    {job.compSummary && <span>{job.compSummary}</span>}
                  </div>
                  {job.recruiterBoard.label.pills.length > 0 && (
                    <div className="oj-card__pills">
                      {job.recruiterBoard.label.pills.map((pill, i) => (
                        <span key={i} className={`oj-pill is-${pill.tone ?? "neutral"}`}>{pill.text}</span>
                      ))}
                    </div>
                  )}
                  <p className="oj-card__bet">{job.recruiterBoard.culture.bet}</p>
                  <div className="oj-card__checklist-summary">
                    {job.recruiterBoard.checklist.groups.map((group) => (
                      <span key={group.kind} className={`oj-chip is-${group.kind}`}>
                        {group.kind === "hard" ? "Hard" : group.kind === "fit" ? "Fit" : group.kind === "bonus" ? "Bonus" : "Anti"} · {group.items.length}
                      </span>
                    ))}
                  </div>
                  <span className="oj-card__cta">View role brief →</span>
                </Link>
              )
            })}
          </div>
        )}
      </main>
    </RecruiterShell>
  )
}
