import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { listPublicJobOpenings, type PublicJobOpening } from "../lib/public-jobs.js"
import { CandidateShell } from "./CandidateLogin.js"

type JobsState =
  | { status: "loading" }
  | { status: "ready"; jobs: PublicJobOpening[] }
  | { status: "error"; message: string }

export default function Landing() {
  const [state, setState] = useState<JobsState>({ status: "loading" })

  useEffect(() => {
    try {
      const utm = new URLSearchParams(location.search)
      sessionStorage.setItem(
        "pa_landing_visit",
        JSON.stringify({
          ts: new Date().toISOString(),
          ref: document.referrer || null,
          src: utm.get("src") || null,
          ua: navigator.userAgent.slice(0, 200),
        })
      )
    } catch {
      // sessionStorage blocked; non-fatal.
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const jobs = await listPublicJobOpenings()
        if (!cancelled) setState({ status: "ready", jobs })
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <CandidateShell wide>
      <style>{LANDING_STYLES}</style>
      <main className="home-shell" aria-labelledby="home-title">
        <section className="home-hero">
          <p className="candidate-kicker">Candidate marketplace</p>
          <h1 id="home-title">Find the next role Claire can help you interview for.</h1>
          <p>
            Browse open roles, upload your resume once, and start the first interview over iMessage
            from the job page.
          </p>
        </section>

        <section className="home-jobs" aria-labelledby="home-jobs-title">
          <div className="home-section-heading">
            <div>
              <p className="candidate-kicker">Open roles</p>
              <h2 id="home-jobs-title">Available jobs</h2>
            </div>
            <Link className="candidate-secondary-button" to="/me/matches">My matches</Link>
          </div>
          {state.status === "loading" ? <JobListSkeleton /> : null}
          {state.status === "error" ? (
            <div className="home-empty">
              <h3>Jobs unavailable</h3>
              <p>{state.message}</p>
            </div>
          ) : null}
          {state.status === "ready" ? <JobList jobs={state.jobs} /> : null}
        </section>
      </main>
    </CandidateShell>
  )
}

function JobList({ jobs }: { jobs: PublicJobOpening[] }) {
  if (jobs.length === 0) {
    return (
      <div className="home-empty">
        <h3>No public jobs are open right now</h3>
        <p>Check your matches from your candidate profile when new roles are published.</p>
        <Link className="candidate-primary-link" to="/me/matches">View matches</Link>
      </div>
    )
  }
  return (
    <div className="home-job-grid">
      {jobs.map((job) => (
        <Link className="home-job-card" key={job.id} to={`/j/${job.id}`} aria-label={`Open ${job.title}`}>
          <div>
            <p className="home-job-company">{job.company}</p>
            <h3>{job.title}</h3>
            <p className="home-job-meta">
              {[job.location, job.salaryRange, job.jobType].filter(Boolean).join(" · ")}
            </p>
          </div>
          {job.description ? <p className="home-job-description">{job.description}</p> : null}
          <TagRow values={[...job.roleFunction, ...job.industrySector, ...job.requiredSkills].slice(0, 4)} />
          <span className="home-job-action">View job</span>
        </Link>
      ))}
    </div>
  )
}

function TagRow({ values }: { values: string[] }) {
  if (values.length === 0) return null
  return (
    <div className="home-job-tags">
      {values.map((value) => (
        <span key={value}>{value}</span>
      ))}
    </div>
  )
}

function JobListSkeleton() {
  return (
    <div className="home-job-grid" aria-label="Loading jobs">
      {[0, 1, 2].map((idx) => (
        <div className="home-job-card home-job-card-loading" key={idx}>
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  )
}

const LANDING_STYLES = `
.home-shell {
  max-width: 1040px;
  margin: 0 auto;
  display: grid;
  gap: 28px;
}
.home-hero {
  max-width: 760px;
  padding: 28px 0 8px;
}
.home-hero h1 {
  margin: 0;
  max-width: 720px;
  font-size: clamp(34px, 7vw, 64px);
  line-height: 0.98;
  letter-spacing: 0;
}
.home-hero p:last-child {
  max-width: 650px;
  margin: 18px 0 0;
  color: #364233;
  font-size: 18px;
  line-height: 1.55;
}
.home-jobs {
  display: grid;
  gap: 16px;
}
.home-section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}
.home-section-heading h2 {
  margin: 0;
  font-size: 28px;
  letter-spacing: 0;
}
.home-job-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.home-job-card {
  min-height: 248px;
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  gap: 14px;
  padding: 18px;
  border: 1px solid #ddd3c2;
  border-radius: 8px;
  background: #fffdf8;
  color: #18211a;
  text-decoration: none;
}
.home-job-card:hover,
.home-job-card:focus-visible {
  border-color: #2f6f4f;
  outline: none;
}
.home-job-company,
.home-job-meta,
.home-job-description {
  margin: 0;
  color: #5f665b;
}
.home-job-company {
  color: #46624c;
  font-weight: 800;
}
.home-job-card h3 {
  margin: 6px 0;
  font-size: 22px;
  line-height: 1.2;
  letter-spacing: 0;
}
.home-job-meta,
.home-job-description {
  line-height: 1.45;
}
.home-job-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 28px;
}
.home-job-tags span {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 9px;
  border-radius: 8px;
  background: #edf5ee;
  color: #24543c;
  font-size: 12px;
  font-weight: 800;
}
.home-job-action {
  color: #2f6f4f;
  font-weight: 900;
}
.home-empty {
  display: grid;
  gap: 10px;
  padding: 22px;
  border: 1px solid #ddd3c2;
  border-radius: 8px;
  background: #fffdf8;
}
.home-empty h3,
.home-empty p {
  margin: 0;
}
.home-empty p {
  color: #5f665b;
}
.home-job-card-loading {
  min-height: 180px;
}
.home-job-card-loading span {
  display: block;
  height: 16px;
  border-radius: 8px;
  background: #eee6d8;
}
.home-job-card-loading span:nth-child(1) { width: 46%; }
.home-job-card-loading span:nth-child(2) { width: 78%; height: 28px; }
.home-job-card-loading span:nth-child(3) { width: 62%; }
@media (max-width: 680px) {
  .home-section-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .home-hero {
    padding-top: 10px;
  }
  .home-hero p:last-child {
    font-size: 16px;
  }
}
`
