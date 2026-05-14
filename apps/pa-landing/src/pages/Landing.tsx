import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { collection, doc, getDoc, getDocs, limit, query, where } from "firebase/firestore"
import { db } from "../lib/firebase.js"
import { CandidateShell } from "./CandidateLogin.js"

interface PublicJobListDoc {
  publicVisible?: boolean
  /** v2.4 (2026-05-14): explicit collaboration flag — drives the "WeKruit
   *  collaborated" badge. Inferred-from-publicVisible is forbidden per
   *  the job-lifecycle contract. */
  wekruitCollaborationStatus?: "collaborated" | "not_collaborated"
  /** Top-level title — set on rain / external-supply jobs that don't use prescreenConfig. */
  title?: string
  companyId?: string
  companyName?: string
  rawLocation?: string
  prescreenConfig?: {
    jobTitle?: string
    company?: string
    jobType?: string
    region?: string
    level1Reveal?: {
      salaryRange?: string
    }
  }
  location?: string
}

interface PublicJobListItem {
  id: string
  title: string
  company: string
  location?: string
  salary?: string
  jobType?: string
  collaborated: boolean
}

type JobsState =
  | { status: "loading" }
  | { status: "ready"; jobs: PublicJobListItem[] }
  | { status: "error"; message: string }

export default function Landing() {
  const [state, setState] = useState<JobsState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const snap = await getDocs(query(collection(db(), "pa-jobs"), where("publicVisible", "==", true), limit(48)))
        // Resolve company display name: prescreenConfig.company → top-level
        // companyName → pa-companies/{companyId}.name lookup → "Confidential
        // employer" fallback. Cache pa-companies fetches across rows.
        const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() as PublicJobListDoc }))
        const companyIds = Array.from(
          new Set(
            docs
              .filter((d) => !d.data.prescreenConfig?.company && !d.data.companyName && d.data.companyId)
              .map((d) => d.data.companyId!),
          ),
        )
        const companyNameById = new Map<string, string>()
        await Promise.all(
          companyIds.map(async (cid) => {
            try {
              const cs = await getDoc(doc(db(), "pa-companies", cid))
              if (cs.exists()) {
                const cd = cs.data() as { name?: string }
                if (typeof cd.name === "string") companyNameById.set(cid, cd.name)
              }
            } catch {
              // ignore — falls through to fallback
            }
          }),
        )
        const jobs = docs
          .map(({ id, data }) => {
            const cfg = data.prescreenConfig ?? {}
            const title = cfg.jobTitle ?? data.title ?? "Open role"
            const companyName =
              cfg.company ??
              data.companyName ??
              (data.companyId ? companyNameById.get(data.companyId) : undefined) ??
              "Confidential employer"
            return {
              id,
              title,
              company: companyName,
              location: data.location ?? data.rawLocation ?? cfg.region,
              salary: cfg.level1Reveal?.salaryRange,
              jobType: cfg.jobType,
              collaborated: data.wekruitCollaborationStatus === "collaborated",
            }
          })
          .sort((a, b) => `${a.company} ${a.title}`.localeCompare(`${b.company} ${b.title}`))
        if (!cancelled) setState({ status: "ready", jobs })
      } catch (err) {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <CandidateShell>
      <style>{LANDING_STYLES}</style>
      <main className="landing-app">
        <section className="landing-hero">
          <div>
            <p className="candidate-kicker">Candidate marketplace</p>
            <h1>Open jobs that start with Claire</h1>
            <p>
              Browse active WeKruit roles, sign in once, and start the first screen over iMessage.
            </p>
          </div>
          <Link className="candidate-secondary-button" to="/me">View profile</Link>
        </section>

        <section className="landing-jobs-section" aria-labelledby="landing-jobs-title">
          <div className="landing-section-heading">
            <h2 id="landing-jobs-title">Open roles</h2>
            <span>{state.status === "ready" ? `${state.jobs.length} live` : "Loading"}</span>
          </div>
          {state.status === "loading" ? <p className="landing-muted">Loading jobs.</p> : null}
          {state.status === "error" ? <p className="candidate-error">{state.message}</p> : null}
          {state.status === "ready" && state.jobs.length === 0 ? (
            <p className="landing-muted">No public roles are open right now.</p>
          ) : null}
          {state.status === "ready" && state.jobs.length > 0 ? (
            <div className="landing-job-list">
              {state.jobs.map((job) => (
                <article className="landing-job-card" key={job.id}>
                  <div>
                    <div className="landing-job-badges">
                      <span>Open role</span>
                      {job.collaborated ? <span>WeKruit collaborated</span> : null}
                    </div>
                    <h3>{job.title}</h3>
                    <p>{job.company}{job.location ? ` · ${job.location}` : ""}</p>
                  </div>
                  {job.salary || job.jobType ? (
                    <p className="landing-job-meta">{[job.jobType, job.salary].filter(Boolean).join(" · ")}</p>
                  ) : null}
                  <Link className="candidate-primary-link" to={`/j/${job.id}`}>View role</Link>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      </main>
    </CandidateShell>
  )
}

const LANDING_STYLES = `
.landing-app {
  max-width: 980px;
  margin: 0 auto;
  display: grid;
  gap: 24px;
}
.landing-hero {
  display: flex;
  gap: 20px;
  align-items: flex-end;
  justify-content: space-between;
  border-bottom: 1px solid #ddd3c2;
  padding-bottom: 22px;
}
.landing-hero h1 {
  max-width: 660px;
  margin: 0;
  font-size: clamp(38px, 7vw, 64px);
  line-height: 1;
  letter-spacing: 0;
}
.landing-hero p:not(.candidate-kicker) {
  max-width: 620px;
  margin: 14px 0 0;
  color: #364233;
  font-size: 18px;
  line-height: 1.45;
}
.landing-jobs-section {
  display: grid;
  gap: 14px;
}
.landing-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.landing-section-heading h2 {
  margin: 0;
  font-size: 24px;
  line-height: 1.2;
  letter-spacing: 0;
}
.landing-section-heading span {
  color: #5f665b;
  font-weight: 800;
}
.landing-job-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.landing-job-card {
  display: grid;
  gap: 12px;
  align-content: start;
  background: #fffdf8;
  border: 1px solid #ddd3c2;
  border-radius: 8px;
  padding: 18px;
}
.landing-job-card h3 {
  margin: 12px 0 6px;
  font-size: 22px;
  line-height: 1.2;
  letter-spacing: 0;
}
.landing-job-card p {
  margin: 0;
  color: #364233;
  line-height: 1.45;
}
.landing-job-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.landing-job-badges span {
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  padding: 0 9px;
  border-radius: 8px;
  background: #f0eee8;
  color: #364233;
  font-size: 12px;
  font-weight: 900;
}
.landing-job-badges span:last-child {
  background: #dff4eb;
  border: 1px solid #b8dfd1;
  color: #24543c;
}
.landing-job-meta {
  color: #16643b;
  font-weight: 800;
}
.landing-muted {
  color: #5f665b;
}
@media (max-width: 760px) {
  .landing-hero {
    display: grid;
    align-items: start;
  }
  .landing-job-list {
    grid-template-columns: 1fr;
  }
}
`
