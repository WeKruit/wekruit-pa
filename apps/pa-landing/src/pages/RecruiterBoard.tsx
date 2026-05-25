/**
 * Recruiter board landing — /recruiters
 *
 * Lists every WeKruit collab role. Recruiters open one, fill the candidate
 * fields + checklist, and submit. Backed by paCollabJobsList CF.
 */
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import "../styles/recruiter-board.css"
import { fetchCollabJobs, type CollabJob } from "../lib/recruiter-board-api.js"

export default function RecruiterBoard() {
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchCollabJobs()
      .then((list) => setJobs(list))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  const companyCount = jobs ? new Set(jobs.map((j) => j.recruiterBoard.label.companyCode)).size : 0

  return (
    <div className="rb-page">
      <header className="rb-header">
        <h1>WeKruit Recruiter Job Board</h1>
        <p>
          <strong>$10K+ placement fee per hire.</strong> Open a role, review the JD, send candidates back with the checklist filled in.
        </p>
      </header>

      <main className="rb-main">
        <div className="rb-payout">
          <strong>$10K+ placement fee per hire</strong>{" "}
          <span className="dim">· paid on candidate signing &amp; start · higher payouts on senior roles</span>
        </div>

        <div className="rb-instructions">
          <strong>How this works — for the recruiters we partner with:</strong>
          <ol>
            <li>Open any role below — each has its own URL you can bookmark or share with your team.</li>
            <li>Read the JD on top. The checklist underneath is what makes a candidate a real fit.</li>
            <li>For every candidate, fill in the candidate fields and tick every box that applies.</li>
            <li>Hit <em>Submit candidate</em>, we get the full checklist + your contact, and circle back.</li>
          </ol>
          <span className="small">Your in-progress checklist is saved in your browser so you can come back to it later.</span>
        </div>

        {error && <div className="rb-state error">Could not load roles: {error}</div>}
        {!jobs && !error && <div className="rb-state">Loading open roles…</div>}

        {jobs && jobs.length === 0 && (
          <div className="rb-state">No active collab roles right now. Check back soon.</div>
        )}

        {jobs && jobs.length > 0 && (
          <>
            <div className="rb-grid">
              {jobs.map((job) => (
                <Link key={job.jobId} to={`/recruiters/job/${job.jobId}`} className="rb-card">
                  <div className="num">
                    Co. {job.recruiterBoard.label.companyCode} · sort {job.recruiterBoard.sortOrder}
                  </div>
                  <div className="ttl">{job.title}</div>
                  <div className="meta">
                    {job.recruiterBoard.label.company.replace(/^Co\.\s*[A-Z]\s*·\s*/, "")} · {job.recruiterBoard.label.location}
                  </div>
                </Link>
              ))}
            </div>
            <p style={{ marginTop: 24, color: "#8a8a82", fontSize: 12 }}>
              {jobs.length} roles across {companyCount} collab companies. State saved in your browser.
            </p>
          </>
        )}
      </main>
    </div>
  )
}
