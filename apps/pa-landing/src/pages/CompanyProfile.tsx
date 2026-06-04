import { useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { CandidateShell, Icon } from "./CandidateLogin.js"
import { formatPublicJobType } from "../lib/public-job-labels.js"
import {
  listPublicJobOpeningsByCompany,
  type PublicCompanyProfile,
  type PublicJobOpening,
} from "../lib/public-jobs.js"

function extractCompanySummary(jobs: PublicJobOpening[], profile?: PublicCompanyProfile): string {
  if (profile?.tagline) return profile.tagline
  if (profile?.about) return profile.about
  const company = jobs[0]?.company
  const roleCount = jobs.length
  if (company) {
    const roleText = roleCount === 1 ? "public role" : "public roles"
    return `Explore ${roleCount} ${roleText} at ${company}. Choose a role when you want Claire to screen your profile against that team's actual bar.`
  }
  return "Role briefs and company details are shared through the WeKruit interview process."
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
}

export default function CompanyProfile() {
  const { companyId } = useParams<{ companyId: string }>()
  const jobsQuery = useQuery({
    queryKey: ["company-profile", companyId],
    queryFn: () => listPublicJobOpeningsByCompany(companyId!, 32),
    enabled: Boolean(companyId),
    staleTime: 5 * 60 * 1000,
  })

  if (!companyId) return <CompanyEmpty />
  if (jobsQuery.isLoading) return <CompanyLoading />
  if (jobsQuery.isError) return <CompanyEmpty message={jobsQuery.error instanceof Error ? jobsQuery.error.message : String(jobsQuery.error)} />
  const jobs = jobsQuery.data ?? []
  if (!jobs.length) return <CompanyEmpty />

  return <CompanyProfileLayout jobs={jobs} />
}

function CompanyProfileLayout({ jobs }: { jobs: PublicJobOpening[] }) {
  const firstJob = jobs[0]!
  const company = firstJob.company
  const profile = useMemo(
    () => jobs.find((job) => job.companyProfile)?.companyProfile,
    [jobs],
  )
  const summary = useMemo(() => extractCompanySummary(jobs, profile), [jobs, profile])
  const collaborated = jobs.some((job) => job.collaborated)
  const locations = profile?.hqLocation ? [profile.hqLocation] : unique(jobs.map((job) => job.location))
  const industries = profile?.industryLabels?.length ? profile.industryLabels : firstJob.industrySector
  const heroMeta = [
    locations[0],
    profile?.teamSize ? `${profile.teamSize} employees` : undefined,
    profile?.funding?.stage && profile.funding.totalRaised
      ? `${profile.funding.stage} - ${profile.funding.totalRaised}`
      : profile?.funding?.stage,
    profile?.foundedYear ? `Founded ${profile.foundedYear}` : undefined,
  ].filter((item): item is string => Boolean(item))

  return (
    <CandidateShell>
      <style>{COMPANY_PROFILE_STYLES}</style>
      <main className="wk-company">
        <section className="wk-company-hero">
          <div className="wk-container wk-company-hero__grid">
            <div className="wk-company-main">
              <Link className="wk-company-back" to="/market">
                <Icon name="arrow-left" size={16} stroke={1.8} /> Market
              </Link>
              <div className="wk-company-title-row">
                <div className="wk-company-logo" aria-hidden="true">{company[0]?.toUpperCase() ?? "?"}</div>
                <div>
                  <p className="wk-eyebrow">
                    Company profile
                    {collaborated ? <> · <span className="wk-company-collab">WeKruit collaborated</span></> : null}
                  </p>
                  <h1>{company}</h1>
                </div>
              </div>
              <p className="wk-company-summary">{summary}</p>
              <div className="wk-company-chips">
                {heroMeta.map((item) => <span key={item}>{item}</span>)}
              </div>
              <CompanyHeroRoleCta job={firstJob} company={company} roleCount={jobs.length} />
              {profile?.websiteUrl ? (
                <a className="wk-company-website" href={profile.websiteUrl} target="_blank" rel="noreferrer">
                  Company website <Icon name="arrow-right" size={15} stroke={1.8} />
                </a>
              ) : null}

              <CompanyScreeningContract company={company} />

              <section className="wk-company-roles" aria-labelledby="company-open-roles">
                <div className="wk-company-section-head">
                  <p className="wk-eyebrow">Open positions</p>
                  <h2 id="company-open-roles">Roles at {company}</h2>
                </div>
                <div className="wk-company-role-list">
                  {jobs.map((job) => (
                    <Link
                      className="wk-company-role"
                      to={`/j/${job.id}`}
                      key={job.id}
                      aria-label={`Start Claire interview for ${job.title}`}
                    >
                      <span>
                        <strong>{job.title}</strong>
                        <em>{[job.location, formatPublicJobType(job.jobType)].filter(Boolean).join("  ")}</em>
                      </span>
                      <span className="wk-company-role__action">
                        Start Claire interview <Icon name="arrow-right" size={15} stroke={1.8} />
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            </div>

            <aside className="wk-company-side">
              <div className="wk-company-panel">
                <p className="wk-eyebrow">Company details</p>
                <CompanyFact label="Location" value={locations.join(", ") || "Shared during screen"} />
                {profile?.teamSize ? <CompanyFact label="Team size" value={profile.teamSize} /> : null}
                {industries.length ? <CompanyFact label="Industry" value={industries.join(", ")} /> : null}
              </div>
              {(profile?.funding?.totalRaised || profile?.funding?.stage) ? (
                <div className="wk-company-panel">
                  <p className="wk-eyebrow">Funding</p>
                  {profile.funding.totalRaised ? <CompanyFact label="Total raised" value={profile.funding.totalRaised} /> : null}
                  {profile.funding.stage ? <CompanyFact label="Last stage" value={profile.funding.stage} /> : null}
                </div>
              ) : null}
              {profile?.founders?.length ? (
                <div className="wk-company-panel">
                  <p className="wk-eyebrow">Founders</p>
                  <div className="wk-company-founders">
                    {profile.founders.map((founder) => (
                      <div className="wk-company-founder" key={founder.name}>
                        <div className="wk-company-founder__avatar" aria-hidden="true">{founder.name[0]}</div>
                        <span>
                          <strong>{founder.name}</strong>
                          {founder.title ? <em>{founder.title}</em> : null}
                          {founder.linkedinUrl ? (
                            <a href={founder.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn</a>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="wk-company-panel wk-company-panel--process">
                <p className="wk-eyebrow">WeKruit process</p>
                <ol>
                  <li>Claire confirms role fit with you.</li>
                  <li>Only candidates who pass and consent get shared.</li>
                  <li>If there is mutual interest, the first chat gets booked.</li>
                </ol>
              </div>
            </aside>
          </div>
        </section>
      </main>
    </CandidateShell>
  )
}

function CompanyHeroRoleCta({ job, company, roleCount }: { job: PublicJobOpening; company: string; roleCount: number }) {
  return (
    <section className="wk-company-hero-cta" aria-label={`Start Claire interview for ${company}`}>
      <div>
        <p className="wk-eyebrow">Claire-ready role</p>
        <strong>{job.title}</strong>
        <em>{[job.location, formatPublicJobType(job.jobType)].filter(Boolean).join("  ")}</em>
      </div>
      <div className="wk-company-hero-cta__actions">
        <Link className="wk-btn wk-btn--primary wk-company-hero-cta__primary" to={`/j/${job.id}`}>
          Start Claire interview <Icon name="arrow-right" size={16} stroke={1.8} />
        </Link>
        {roleCount > 1 ? (
          <a className="wk-company-hero-cta__secondary" href="#company-open-roles">
            See {roleCount} roles
          </a>
        ) : null}
      </div>
    </section>
  )
}

function CompanyScreeningContract({ company }: { company: string }) {
  const checks = [
    {
      title: "Nearest-work evidence",
      body: "Claire asks for the closest shipped work before treating a selected role as a fit.",
    },
    {
      title: "Role constraints",
      body: "Location, compensation, timing, work authorization, and must-have evidence are checked before any pass.",
    },
    {
      title: "Durable profile context",
      body: "Claire carries your WeKruit profile, constraints, and corrections into this company screen instead of starting from a fresh application.",
    },
    {
      title: "Consent before sharing",
      body: "Hiring teams only see candidate-approved evidence after Claire completes the role screen.",
    },
  ]

  return (
    <section className="wk-company-screen" aria-label="Claire company screening contract">
      <div className="wk-company-screen__intro">
        <p className="wk-eyebrow">What Claire will test</p>
        <h2>{company} becomes a Claire screen.</h2>
        <p>Start a role when you want Claire to test your profile against this company's actual bar.</p>
      </div>
      <div className="wk-company-screen__list">
        {checks.map((check) => (
          <div className="wk-company-screen__row" key={check.title}>
            <strong>{check.title}</strong>
            <p>{check.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function CompanyFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="wk-company-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function CompanyLoading() {
  return (
    <CandidateShell>
      <style>{COMPANY_PROFILE_STYLES}</style>
      <main className="wk-company wk-container wk-company-state">
        <p className="wk-eyebrow">Company profile</p>
        <h1>Loading company profile...</h1>
      </main>
    </CandidateShell>
  )
}

function CompanyEmpty({ message }: { message?: string }) {
  return (
    <CandidateShell>
      <style>{COMPANY_PROFILE_STYLES}</style>
      <main className="wk-company wk-container wk-company-state">
        <p className="wk-eyebrow">Company profile</p>
        <h1>This company profile is not open.</h1>
        <p>{message ?? "There are no public WeKruit roles for this company yet."}</p>
        <Link className="wk-btn wk-btn--primary" to="/market">
          Open market <Icon name="arrow-right" size={16} stroke={1.8} />
        </Link>
      </main>
    </CandidateShell>
  )
}

const COMPANY_PROFILE_STYLES = `
.wk-company {
  min-height: 100vh;
  background:
    radial-gradient(ellipse 78% 58% at 52% 12%, rgba(246, 214, 190, 0.42), transparent 62%),
    var(--wk-cream);
  color: var(--wk-ink);
}
.wk-company-hero { padding: 48px 0 72px; }
.wk-company-hero__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  gap: 60px;
  align-items: start;
}
.wk-company-main { display: grid; gap: 26px; min-width: 0; }
.wk-company-back,
.wk-company-website {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--wk-ink-3);
  text-decoration: none;
  font-size: 14px;
  font-weight: 600;
}
.wk-company-back:hover,
.wk-company-website:hover { color: var(--wk-ink); }
.wk-company-title-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 18px;
  align-items: center;
}
.wk-company-logo {
  width: 58px;
  height: 58px;
  border-radius: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #101514;
  color: var(--wk-cream);
  font-family: 'Newsreader', serif;
  font-size: 30px;
  line-height: 1;
  box-shadow: 0 10px 24px rgba(16, 21, 20, 0.18);
}
.wk-company h1 {
  margin: 6px 0 0;
  font-family: 'Newsreader', serif;
  font-size: clamp(54px, 7vw, 88px);
  font-weight: 400;
  line-height: 0.95;
}
.wk-company-summary {
  max-width: 760px;
  margin: 0;
  color: var(--wk-ink-2);
  font-size: clamp(17px, 1.5vw, 20px);
  line-height: 1.55;
}
.wk-company-collab { color: var(--wk-live); font-weight: 650; }
.wk-company-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.wk-company-chips span {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  padding: 7px 12px;
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-pill);
  background: rgba(255, 252, 247, 0.72);
  color: var(--wk-ink-2);
  font-size: 14px;
}
.wk-company-hero-cta {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 18px;
  align-items: center;
  padding: 18px 20px;
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  background: rgba(255, 252, 247, 0.78);
  box-shadow: 0 10px 28px -18px rgba(45, 26, 10, 0.22);
}
.wk-company-hero-cta > div:first-child {
  min-width: 0;
  display: grid;
  gap: 7px;
}
.wk-company-hero-cta strong {
  color: var(--wk-ink);
  font-family: 'Newsreader', serif;
  font-size: clamp(24px, 2.4vw, 32px);
  font-weight: 400;
  line-height: 1.05;
}
.wk-company-hero-cta em {
  color: var(--wk-ink-3);
  font-style: normal;
  font-size: 13.5px;
  line-height: 1.35;
}
.wk-company-hero-cta__actions {
  display: grid;
  justify-items: end;
  gap: 8px;
}
.wk-company-hero-cta__primary {
  white-space: nowrap;
}
.wk-company-hero-cta__secondary {
  color: var(--wk-ink-3);
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
}
.wk-company-hero-cta__secondary:hover { color: var(--wk-ink); }
.wk-company-screen {
  display: grid;
  gap: 20px;
  padding: 28px 0;
  border-top: 1px solid var(--wk-border);
  border-bottom: 1px solid var(--wk-border);
}
.wk-company-screen__intro {
  display: grid;
  gap: 8px;
}
.wk-company-screen h2 {
  margin: 0;
  color: var(--wk-ink);
  font-family: 'Newsreader', serif;
  font-size: 34px;
  font-weight: 400;
  line-height: 1.04;
}
.wk-company-screen__intro p:not(.wk-eyebrow),
.wk-company-screen__row p {
  margin: 0;
  color: var(--wk-ink-2);
  font-size: 15px;
  line-height: 1.55;
}
.wk-company-screen__list {
  display: grid;
  border-top: 1px solid var(--wk-border);
}
.wk-company-screen__row {
  display: grid;
  grid-template-columns: minmax(136px, 0.42fr) minmax(0, 1fr);
  gap: 18px;
  padding: 16px 0;
  border-bottom: 1px solid var(--wk-border);
}
.wk-company-screen__row strong {
  color: var(--wk-ink);
  font-size: 14px;
  font-weight: 650;
  line-height: 1.35;
}
.wk-company-roles {
  display: grid;
  gap: 18px;
  padding-top: 24px;
  border-top: 1px solid var(--wk-border);
}
.wk-company-section-head { display: grid; gap: 5px; }
.wk-company-section-head h2 {
  margin: 0;
  color: var(--wk-ink);
  font-family: 'Newsreader', serif;
  font-size: clamp(34px, 4vw, 54px);
  font-weight: 400;
  line-height: 1.04;
}
.wk-company-role-list { display: grid; gap: 12px; }
.wk-company-role {
  min-height: 86px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  padding: 18px 20px;
  color: var(--wk-ink);
  text-decoration: none;
  background: rgba(255, 252, 247, 0.74);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  transition:
    transform 180ms var(--wk-ease),
    border-color 180ms var(--wk-ease),
    background 180ms var(--wk-ease);
}
.wk-company-role:hover {
  transform: translateY(-1px);
  border-color: rgba(45, 26, 10, 0.24);
  background: var(--wk-cream-3);
}
.wk-company-role span {
  min-width: 0;
  display: grid;
  gap: 8px;
}
.wk-company-role strong {
  overflow-wrap: anywhere;
  font-family: 'Newsreader', serif;
  font-size: clamp(22px, 2vw, 29px);
  font-weight: 400;
  line-height: 1.08;
}
.wk-company-role em {
  color: var(--wk-ink-3);
  font-style: normal;
  font-size: 14px;
  line-height: 1.35;
}
.wk-company-role__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 34px;
  padding: 7px 12px;
  border: 1px solid var(--wk-peach-200);
  border-radius: var(--wk-r-pill);
  background: var(--wk-peach-100);
  color: var(--wk-ink);
  font-size: 13px;
  font-weight: 650;
  line-height: 1.1;
  white-space: nowrap;
}
.wk-company-side {
  display: grid;
  gap: 16px;
  position: sticky;
  top: 96px;
}
.wk-company-panel {
  display: grid;
  gap: 0;
  padding: 20px 22px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  box-shadow: 0 8px 24px -10px rgba(45, 26, 10, 0.12);
}
.wk-company-fact {
  display: grid;
  gap: 4px;
  padding: 14px 0;
  border-top: 1px solid var(--wk-border);
}
.wk-company-fact:first-of-type { border-top: 0; }
.wk-company-fact span {
  color: var(--wk-ink-3);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.wk-company-fact strong {
  color: var(--wk-ink);
  font-size: 15px;
  font-weight: 650;
  line-height: 1.35;
}
.wk-company-founders { display: grid; gap: 14px; padding-top: 14px; }
.wk-company-founder {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  align-items: center;
}
.wk-company-founder__avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--wk-ink);
  color: var(--wk-cream);
  font-size: 15px;
  font-weight: 650;
}
.wk-company-founder span { display: grid; gap: 2px; min-width: 0; }
.wk-company-founder strong { color: var(--wk-ink); font-size: 15px; line-height: 1.25; }
.wk-company-founder em { color: var(--wk-ink-3); font-style: normal; font-size: 13px; line-height: 1.35; }
.wk-company-founder a { color: var(--wk-ink-2); font-size: 13px; font-weight: 600; text-decoration: none; }
.wk-company-founder a:hover { color: var(--wk-ink); }
.wk-company-panel--process ol {
  margin: 12px 0 0;
  padding-left: 20px;
  display: grid;
  gap: 10px;
  color: var(--wk-ink-2);
  font-size: 14px;
  line-height: 1.45;
}
.wk-company-state {
  padding: 80px 24px;
  display: grid;
  gap: 16px;
  max-width: 760px;
}
.wk-company-state h1 {
  margin: 0;
  font-family: 'Newsreader', serif;
  font-size: clamp(40px, 6vw, 72px);
  font-weight: 400;
  line-height: 0.98;
}
.wk-company-state p { color: var(--wk-ink-2); margin: 0; }

@media (max-width: 920px) {
  .wk-company-hero { padding-top: 32px; }
  .wk-company-hero__grid { grid-template-columns: 1fr; gap: 32px; }
  .wk-company-side { position: static; }
}

@media (max-width: 560px) {
  .wk-company-title-row { grid-template-columns: 1fr; gap: 14px; }
  .wk-company-logo { width: 50px; height: 50px; border-radius: 12px; font-size: 26px; }
  .wk-company-hero-cta {
    grid-template-columns: 1fr;
    gap: 14px;
    padding: 16px;
  }
  .wk-company-hero-cta__actions { justify-items: stretch; }
  .wk-company-hero-cta__primary { width: 100%; justify-content: center; }
  .wk-company-screen { padding: 24px 0; }
  .wk-company-screen h2 { font-size: 29px; }
  .wk-company-screen__row { grid-template-columns: 1fr; gap: 7px; }
  .wk-company-role { grid-template-columns: 1fr; padding: 16px; min-height: 78px; }
  .wk-company-role__action { justify-self: start; white-space: normal; text-align: left; }
}
`
