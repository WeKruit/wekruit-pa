/**
 * YcStartupSchool.tsx — `/yc-startup` on wekruit.com.
 *
 * Funnel page for YC Startup School attendees: sign in / build one WeKruit
 * profile (reuses the existing /onboarding + /login flow, source-tagged
 * `yc_startup_school`), then get matched with founders — either as a
 * candidate for an open role or to talk with them about what they're
 * building. Founder cards come from the SAME cached pa-jobs raw query the
 * homepage hero uses (shared TanStack key — zero extra Firestore reads).
 *
 * Visual language intentionally echoes an event microsite (cream, mono type,
 * orange sun, marquee ticker) while staying on WeKruit brand tokens. This is
 * a WeKruit page FOR Startup School attendees — it does not claim to be a
 * Y Combinator property, and it fabricates no speakers, dates, or counts.
 */
import { useEffect } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { trackEvent } from "../lib/analytics.js"
import { stickExplicitSource } from "../lib/source.js"
import { formatPublicJobType } from "../lib/public-job-labels.js"
import {
  PUBLIC_PA_JOBS_RAW_LIMIT,
  PUBLIC_PA_JOBS_RAW_QUERY_KEY,
  fetchPublicPaJobsRaw,
  type PublicPaJobsRawRow,
} from "../lib/public-jobs.js"
import { OPEN_JOBS_STALE_TIME_MS, OPEN_JOBS_GC_TIME_MS } from "../lib/open-jobs.js"

const YC_SOURCE = "yc_startup_school" as const
const ONBOARDING_HREF = `/onboarding?source=${YC_SOURCE}`

interface FounderCard {
  id: string
  company: string
  title: string
  founder?: string
  founderTitle?: string
  location?: string
  jobType?: string
  collaborated: boolean
}

interface RawFounderDoc {
  title?: string
  companyName?: string
  location?: string
  jobType?: string
  wekruitCollaborationStatus?: "collaborated" | "not_collaborated"
  hiringManagerName?: string
  hiringManagerTitle?: string
  prescreenConfig?: { jobType?: string }
}

// Module-level select so TanStack memoizes on stable fn identity (mirrors
// Landing's selectHeroJobs — both surfaces share one cached raw read).
function selectFounderCards(rows: PublicPaJobsRawRow[]): FounderCard[] {
  return rows
    .map((row) => {
      const data = row.data as RawFounderDoc
      return {
        id: row.id,
        company: data.companyName ?? "Confidential startup",
        title: data.title ?? "Open role",
        founder: data.hiringManagerName,
        founderTitle: data.hiringManagerTitle,
        location: data.location,
        jobType: formatPublicJobType(data.jobType ?? data.prescreenConfig?.jobType),
        collaborated: data.wekruitCollaborationStatus === "collaborated",
      }
    })
    .sort((a, b) => {
      if (a.collaborated !== b.collaborated) return a.collaborated ? -1 : 1
      return `${a.company} ${a.title}`.localeCompare(`${b.company} ${b.title}`)
    })
}

const TICKER_PHRASE = "STARTUP SCHOOL ATTENDEES × FOUNDERS · WEKRUIT · "

export default function YcStartupSchool() {
  useEffect(() => {
    // Arrival on this page IS the attribution event — stick the source cookie
    // so /onboarding, /login and /j/:jobId nav from here register the user as
    // yc_startup_school even when the link carries no ?source= param.
    stickExplicitSource(YC_SOURCE)
    void trackEvent("partner_page_view", { source: YC_SOURCE, path: "/yc-startup" })
  }, [])

  const foundersQuery = useQuery({
    queryKey: PUBLIC_PA_JOBS_RAW_QUERY_KEY,
    queryFn: () => fetchPublicPaJobsRaw(PUBLIC_PA_JOBS_RAW_LIMIT),
    select: selectFounderCards,
    staleTime: OPEN_JOBS_STALE_TIME_MS,
    gcTime: OPEN_JOBS_GC_TIME_MS,
    retry: false,
  })
  const founders = foundersQuery.data ?? []

  useEffect(() => {
    function scrollToHash() {
      const hash = window.location.hash.replace(/^#/, "")
      if (!hash) return
      setTimeout(() => {
        document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" })
      }, 60)
    }
    scrollToHash()
    window.addEventListener("hashchange", scrollToHash)
    return () => window.removeEventListener("hashchange", scrollToHash)
  }, [])

  return (
    <div className="ycs">
      <style>{YCS_STYLES}</style>

      <header className="ycs-nav">
        <Link to="/" className="ycs-mark" aria-label="WeKruit home">
          W
        </Link>
        <nav className="ycs-nav-pills">
          <a href="#about" className="ycs-pill">
            ABOUT
          </a>
          <a href="#founders" className="ycs-pill">
            FOUNDERS
          </a>
        </nav>
        <Link to="/login" className="ycs-signin">
          SIGN IN
        </Link>
      </header>

      <section className="ycs-hero">
        <div className="ycs-hero-corner ycs-hero-corner--left">
          <h1>
            YC STARTUP
            <br />
            SCHOOL
          </h1>
          <p className="ycs-hero-sub">founder matching by WeKruit</p>
        </div>
        <div className="ycs-sun" aria-hidden="true">
          <div className="ycs-sun-core" />
          <div className="ycs-sun-copy">
            <span className="ycs-sun-big">MEET</span>
            <span className="ycs-sun-label">F O U N D E R S</span>
            <span className="ycs-sun-tick">interests × experience</span>
          </div>
        </div>
        <div className="ycs-hero-corner ycs-hero-corner--right">
          <h2>FOR ATTENDEES</h2>
          <p>OF YC STARTUP SCHOOL 2026</p>
        </div>
      </section>

      <div className="ycs-rule" />

      <main className="ycs-main">
        <section id="about" className="ycs-card">
          <p className="ycs-slug">/ABOUT</p>
          <h3>Going to Startup School? Leave with more than notes.</h3>
          <p>
            WeKruit matches Startup School attendees with founders who are actively building. You sign in once,
            share your résumé, and Claire — your WeKruit recruiter on iMessage — learns your interests and
            experience. When a founder&rsquo;s startup lines up with both, she makes the introduction.
          </p>
          <p className="ycs-strong">Two ways to meet a founder</p>
          <ul>
            <li>
              <strong>Join as a candidate.</strong> Match with open roles at founder-led startups. Claire runs the
              first interview over text, and your passed profile carries the evidence to the founder.
            </li>
            <li>
              <strong>Talk to a founder.</strong> Pick a startup below and start the conversation about what
              they&rsquo;re building — no application, no cover letter.
            </li>
          </ul>
          <p>
            One profile does both. If you already have a WeKruit profile, sign in and it keeps working here —
            nothing to re-upload, nothing to re-type.
          </p>
          <div className="ycs-cta-row">
            <Link
              to={ONBOARDING_HREF}
              className="ycs-btn ycs-btn--solid"
              onClick={() => void trackEvent("yc_startup_cta", { cta: "join" })}
            >
              JOIN AS A CANDIDATE →
            </Link>
            <a
              href="#founders"
              className="ycs-btn"
              onClick={() => void trackEvent("yc_startup_cta", { cta: "talk" })}
            >
              TALK TO FOUNDERS ↓
            </a>
          </div>
        </section>

        <section id="founders" className="ycs-card">
          <p className="ycs-slug">/FOUNDERS</p>
          <h3>Startups you can match with right now</h3>
          <p>
            Live public roles on WeKruit. Open one to see the brief — Claire starts the conversation with the
            founder&rsquo;s team from there.
          </p>
          {foundersQuery.isPending ? (
            <p className="ycs-muted">Loading live startups…</p>
          ) : foundersQuery.isError ? (
            <p className="ycs-muted">
              Couldn&rsquo;t load startups right now.{" "}
              <Link to="/market" className="ycs-inline-link">
                Browse the open market
              </Link>{" "}
              instead.
            </p>
          ) : founders.length === 0 ? (
            <p className="ycs-muted">
              No public roles are open right now.{" "}
              <Link to={ONBOARDING_HREF} className="ycs-inline-link">
                Create your profile
              </Link>{" "}
              and Claire will text you when a founder match opens.
            </p>
          ) : (
            <div className="ycs-grid">
              {founders.map((f) => (
                <Link key={f.id} to={`/j/${f.id}?source=${YC_SOURCE}`} className="ycs-founder">
                  <span className="ycs-founder-company">{f.company}</span>
                  <span className="ycs-founder-role">{f.title}</span>
                  {f.founder ? (
                    <span className="ycs-founder-person">
                      {f.founder}
                      {f.founderTitle ? ` · ${f.founderTitle}` : ""}
                    </span>
                  ) : null}
                  <span className="ycs-founder-meta">
                    {[f.location, f.jobType].filter(Boolean).join(" · ") || "Details inside"}
                  </span>
                  <span className="ycs-founder-go">TALK / APPLY →</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="ycs-card">
          <p className="ycs-slug">/HOW</p>
          <h3>How matching works</h3>
          <ol className="ycs-steps">
            <li>
              <strong>01 — Sign in.</strong> Email magic link or LinkedIn. Returning WeKruit users keep their
              existing profile.
            </li>
            <li>
              <strong>02 — One profile.</strong> Résumé + a short chat with Claire builds one WeKruit profile that
              keeps working across roles.
            </li>
            <li>
              <strong>03 — Match.</strong> Your interests and experience are matched against what each founder is
              building and hiring for.
            </li>
            <li>
              <strong>04 — Meet.</strong> As a candidate, Claire starts the first interview. Just talking? She
              opens the thread with the founder&rsquo;s team.
            </li>
          </ol>
        </section>
      </main>

      <div className="ycs-ticker" aria-hidden="true">
        <div className="ycs-ticker-track">
          <span>{TICKER_PHRASE.repeat(6)}</span>
          <span>{TICKER_PHRASE.repeat(6)}</span>
        </div>
      </div>

      <section className="ycs-closer">
        <p>
          MEET THE PEOPLE
          <br />
          BUILDING
          <br />
          WHAT&rsquo;S NEXT
        </p>
        <Link to={ONBOARDING_HREF} className="ycs-btn ycs-btn--solid ycs-btn--big">
          GET MATCHED →
        </Link>
      </section>

      <footer className="ycs-footer">
        <span>WEKRUIT × YC STARTUP SCHOOL ATTENDEES</span>
        <span>
          <Link to="/legal" className="ycs-inline-link">
            LEGAL
          </Link>{" "}
          · NOT AFFILIATED WITH Y COMBINATOR
        </span>
      </footer>
    </div>
  )
}

const YCS_STYLES = `
.ycs {
  --ycs-cream: #F5F1E3;
  --ycs-ink: #2D1A0A;
  --ycs-orange: #EE5B2B;
  --ycs-orange-soft: rgba(238, 91, 43, 0.14);
  --ycs-line: rgba(45, 26, 10, 0.22);
  min-height: 100vh;
  background: var(--ycs-cream);
  color: var(--ycs-ink);
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
  letter-spacing: 0.01em;
}
.ycs a { color: inherit; text-decoration: none; }
/* Global wekruit-pages.css styles h1-h3 with the serif family — this page is
   deliberately full-mono (event-microsite look), so re-assert the family. */
.ycs h1, .ycs h2, .ycs h3, .ycs p, .ycs li, .ycs ol, .ycs ul, .ycs a, .ycs span {
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
}

.ycs-nav {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px clamp(16px, 4vw, 48px);
  background: color-mix(in srgb, var(--ycs-cream) 88%, transparent);
  backdrop-filter: blur(6px);
}
.ycs-mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  background: var(--ycs-orange);
  color: var(--ycs-cream);
  font-weight: 700;
  font-size: 20px;
}
.ycs-nav-pills { display: flex; gap: 10px; }
.ycs-pill {
  padding: 8px 18px;
  border: 1px solid var(--ycs-line);
  border-radius: 999px;
  font-size: 13px;
  transition: border-color 120ms ease, background 120ms ease;
}
.ycs-pill:hover { border-color: var(--ycs-ink); background: var(--ycs-orange-soft); }
.ycs-signin { font-size: 13px; letter-spacing: 0.12em; }
.ycs-signin:hover { color: var(--ycs-orange); }

.ycs-hero {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: start;
  gap: 16px;
  padding: 28px clamp(16px, 4vw, 48px) 0;
  min-height: 380px;
}
.ycs-hero-corner h1, .ycs-hero-corner h2 {
  margin: 0;
  font-size: clamp(22px, 2.6vw, 34px);
  font-weight: 500;
  line-height: 1.3;
}
.ycs-hero-corner--right { text-align: right; }
.ycs-hero-corner--right h2 { font-size: clamp(18px, 2.2vw, 28px); }
.ycs-hero-corner--right p { margin: 8px 0 0; font-size: 12px; letter-spacing: 0.14em; }
.ycs-hero-sub { margin: 10px 0 0; font-size: 13px; color: rgba(45,26,10,0.65); }

.ycs-sun {
  position: relative;
  width: clamp(260px, 42vw, 560px);
  height: clamp(200px, 30vw, 380px);
  overflow: hidden;
  display: grid;
  place-items: end center;
}
.ycs-sun-core {
  position: absolute;
  inset: 0;
  background:
    repeating-linear-gradient(90deg, rgba(245,241,227,0.28) 0 1px, transparent 1px 28px),
    radial-gradient(circle at 50% 100%, var(--ycs-orange) 0%, #F07A44 42%, rgba(240,122,68,0.55) 62%, transparent 74%);
  border-radius: 50% 50% 0 0 / 100% 100% 0 0;
}
.ycs-sun-copy {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 8px;
  padding-bottom: 26px;
  color: var(--ycs-cream);
  text-align: center;
}
.ycs-sun-big { font-size: clamp(48px, 7vw, 96px); font-weight: 700; line-height: 0.95; }
.ycs-sun-label { font-size: clamp(13px, 1.4vw, 18px); letter-spacing: 0.5em; }
.ycs-sun-tick { font-size: 12px; letter-spacing: 0.16em; opacity: 0.9; }

.ycs-rule { border-top: 1px solid var(--ycs-line); }

.ycs-main {
  display: grid;
  gap: 28px;
  max-width: 1020px;
  margin: 0 auto;
  padding: 44px clamp(16px, 4vw, 48px) 64px;
}
.ycs-card {
  border: 1px solid var(--ycs-line);
  border-radius: 22px;
  padding: clamp(24px, 4vw, 44px);
  background: transparent;
}
.ycs-slug { margin: 0 0 18px; font-size: 12px; letter-spacing: 0.18em; color: rgba(45,26,10,0.6); }
.ycs-card h3 { margin: 0 0 14px; font-size: clamp(19px, 2vw, 24px); font-weight: 700; line-height: 1.35; }
.ycs-card p, .ycs-card li { font-size: 14.5px; line-height: 1.7; }
.ycs-card p { margin: 0 0 14px; }
.ycs-card ul, .ycs-steps { margin: 0 0 14px; padding-left: 20px; display: grid; gap: 10px; }
.ycs-steps { list-style: none; padding-left: 0; }
.ycs-strong { font-weight: 700; }
.ycs-muted { color: rgba(45,26,10,0.6); }
.ycs-inline-link { text-decoration: underline; text-underline-offset: 3px; }
.ycs-inline-link:hover { color: var(--ycs-orange); }

.ycs-cta-row { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 22px; }
.ycs-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 13px 24px;
  border: 1px solid var(--ycs-ink);
  border-radius: 999px;
  font-size: 13px;
  letter-spacing: 0.08em;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.ycs-btn:hover { background: var(--ycs-orange-soft); border-color: var(--ycs-orange); }
.ycs-btn--solid { background: var(--ycs-orange); border-color: var(--ycs-orange); color: var(--ycs-cream); }
.ycs-btn--solid:hover { background: #D44E20; color: var(--ycs-cream); }
.ycs-btn--big { padding: 16px 34px; font-size: 15px; }

.ycs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
  margin-top: 20px;
}
.ycs-founder {
  display: grid;
  gap: 6px;
  padding: 18px;
  border: 1px solid var(--ycs-line);
  border-radius: 16px;
  transition: border-color 120ms ease, transform 120ms ease;
}
.ycs-founder:hover { border-color: var(--ycs-orange); transform: translateY(-2px); }
.ycs-founder-company { font-weight: 700; font-size: 15px; }
.ycs-founder-role { font-size: 13.5px; }
.ycs-founder-person { font-size: 12.5px; color: rgba(45,26,10,0.7); }
.ycs-founder-meta { font-size: 12px; color: rgba(45,26,10,0.55); }
.ycs-founder-go { margin-top: 8px; font-size: 11.5px; letter-spacing: 0.14em; color: var(--ycs-orange); }

.ycs-ticker { overflow: hidden; border-top: 1px solid var(--ycs-line); border-bottom: 1px solid var(--ycs-line); padding: 14px 0; }
.ycs-ticker-track { display: flex; white-space: nowrap; animation: ycs-marquee 40s linear infinite; }
.ycs-ticker-track span { font-size: 13px; letter-spacing: 0.14em; padding-right: 8px; }
@keyframes ycs-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) { .ycs-ticker-track { animation: none; } }

.ycs-closer { display: grid; justify-items: center; gap: 30px; padding: 90px 20px; text-align: center; }
.ycs-closer p {
  margin: 0;
  font-size: clamp(40px, 8vw, 104px);
  font-weight: 700;
  line-height: 1.02;
  color: var(--ycs-orange);
}
.ycs-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  padding: 22px clamp(16px, 4vw, 48px);
  border-top: 1px solid var(--ycs-line);
  font-size: 11.5px;
  letter-spacing: 0.1em;
  color: rgba(45,26,10,0.65);
}

@media (max-width: 780px) {
  .ycs-hero { grid-template-columns: 1fr; justify-items: center; text-align: center; min-height: 0; }
  .ycs-hero-corner--right { text-align: center; }
  .ycs-nav-pills { display: none; }
}
`
