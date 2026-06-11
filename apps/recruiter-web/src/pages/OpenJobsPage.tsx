import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { SiteHeader } from "../components/SiteHeader.js"
import "../styles/open-jobs.css"
import { fetchCollabJobs, type CollabJob } from "../lib/recruiter-board-api.js"

const CHECKLIST_KIND_LABELS: Record<string, string> = {
  hard: "Hard requirements",
  fit: "Fit signals",
  bonus: "Bonus signals",
  anti: "Anti-signals",
}

function renderJdBody(body?: string | null, items?: string[]) {
  if (items && items.length > 0) {
    return <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
  }
  if (body) return <p>{body}</p>
  return null
}

function JobCard({ job }: { job: CollabJob }) {
  const { label, culture, checklist, interviewProcess } = job.recruiterBoard

  return (
    <article className="oj-card">
      <div className="oj-card__header">
        <h2>{job.title}</h2>
        <span className="oj-card__company">{label.company}</span>
      </div>
      <div className="oj-card__meta">
        <span>{label.location}</span>
        {job.compSummary && <span>{job.compSummary}</span>}
      </div>
      {label.pills.length > 0 && (
        <div className="oj-card__pills">
          {label.pills.map((pill, i) => (
            <span key={i} className={`oj-pill is-${pill.tone ?? "neutral"}`}>{pill.text}</span>
          ))}
        </div>
      )}

      {/* Culture */}
      {(culture.bet || (culture.bullets && culture.bullets.length > 0)) && (
        <div className="oj-card__culture">
          {culture.bet && <p className="oj-card__bet">{culture.bet}</p>}
          {culture.bullets && culture.bullets.length > 0 && (
            <ul className="oj-card__culture-list">
              {culture.bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* JD blocks */}
      {job.jdBlocks.length > 0 && (
        <div className="oj-card__jd">
          {job.jdBlocks.map((block, i) => (
            <section key={i} className="oj-card__jd-block">
              <h3>{block.heading}</h3>
              {renderJdBody(block.body, block.items)}
            </section>
          ))}
        </div>
      )}

      {/* Full checklist */}
      {checklist.groups.length > 0 && (
        <div className="oj-card__checklist">
          {checklist.groups.map((group) => (
            <div key={group.kind} className="oj-card__check-group">
              <h4 className={`oj-card__check-heading is-${group.kind}`}>
                {CHECKLIST_KIND_LABELS[group.kind] ?? group.kind}
              </h4>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>{item.text}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Interview process */}
      {interviewProcess && (
        <div className="oj-card__interview">
          <h4>Interview process</h4>
          <p>{interviewProcess}</p>
        </div>
      )}

      <Link to={`/recruiters/job/${job.jobId}`} className="oj-card__cta">
        Submit candidates →
      </Link>
    </article>
  )
}

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
      <SiteHeader />

      <main className="oj-main">
        <div className="oj-hero">
          <h1>Open roles</h1>
          <p>Browse active WeKruit collab roles. Sign in to submit candidates.</p>
        </div>

        {error && <p className="oj-error">Could not load jobs: {error}</p>}

        {!jobs && !error && <p className="oj-loading">Loading roles…</p>}

        {jobs && jobs.length === 0 && <p className="oj-empty">No open roles right now. Check back soon.</p>}

        {jobs && jobs.length > 0 && (
          <div className="oj-list">
            {jobs.map((job) => <JobCard key={job.jobId} job={job} />)}
          </div>
        )}
      </main>
    </div>
  )
}
