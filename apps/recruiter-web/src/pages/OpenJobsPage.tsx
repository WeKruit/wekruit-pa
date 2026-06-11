import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import "../styles/open-jobs.css"
import { fetchCollabJobs, type CollabJob } from "../lib/recruiter-board-api.js"

export default function OpenJobsPage() {
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchCollabJobs()
      .then((list) => setJobs(list.filter((j) => j.recruiterBoard.active).sort((a, b) => a.recruiterBoard.sortOrder - b.recruiterBoard.sortOrder)))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  return (
    <div className="oj-page">
      <header className="oj-topbar">
        <div className="oj-brand">
          <span className="oj-brand__icon">W</span>
          <span className="oj-brand__text">WeKruit<span className="oj-brand__sub">Recruiter</span></span>
        </div>
        <Link to="/recruiters" className="oj-topbar__signin">Sign in</Link>
      </header>

      <main className="oj-main">
        <div className="oj-hero">
          <h1>Open roles</h1>
          <p>Browse active WeKruit collab roles. Sign in to submit candidates.</p>
        </div>

        {error && <p className="oj-error">Could not load jobs: {error}</p>}

        {!jobs && !error && <p className="oj-loading">Loading roles…</p>}

        {jobs && jobs.length === 0 && <p className="oj-empty">No open roles right now. Check back soon.</p>}

        {jobs && jobs.length > 0 && (
          <div className="oj-grid">
            {jobs.map((job) => (
              <Link key={job.jobId} to={`/recruiters/job/${job.jobId}`} className="oj-card">
                <div className="oj-card__header">
                  <h2>{job.title}</h2>
                  <span className="oj-card__company">{job.recruiterBoard.label.company}</span>
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
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
