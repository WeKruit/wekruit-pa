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
 * Visual language: WeKruit brand (Newsreader serif display, Hanken Grotesk
 * body, cream + peach-halo palette, lifted warm cards) carrying event-microsite
 * STRUCTURE cues (corner hero + sun arc, mono /SECTION slugs, marquee ticker,
 * big display closer) — a mix, not a YC clone (Adam 2026-07-20). This is a
 * WeKruit page FOR Startup School attendees — it does not claim to be a
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
  // Partner chip only differentiates when the list is MIXED — when every live
  // role is a WeKruit partner (the common case today) 33 identical chips are
  // pure noise, so the section copy carries the fact instead.
  const partnerChipMeaningful = founders.some((f) => !f.collaborated)

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
          <a href="#how" className="ycs-pill">
            HOW
          </a>
          <Link to="/market" className="ycs-pill">
            ALL ROLES
          </Link>
        </nav>
        <div className="ycs-nav-right">
          <Link to="/login" className="ycs-signin">
            SIGN IN
          </Link>
          <Link to={ONBOARDING_HREF} className="ycs-btn ycs-btn--solid ycs-btn--nav">
            Get matched
          </Link>
        </div>
      </header>

      <section className="ycs-hero">
        <div className="ycs-hero-corner ycs-hero-corner--left">
          <h1>
            YC Startup School,
            <br />
            <em>matched.</em>
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
          <h2>For attendees</h2>
          <p>OF YC STARTUP SCHOOL 2026</p>
        </div>
      </section>

      {founders.length > 0 ? (
        <p className="ycs-hero-live">
          <span className="ycs-hero-live-dot" aria-hidden="true" />
          {founders.length} live roles from founders on WeKruit right now
        </p>
      ) : null}

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
            nothing to re-upload, nothing to re-type. No chasing either: Claire texts you right here (and emails
            you) when a founder match pops.
          </p>
          <div className="ycs-cta-row">
            <Link
              to={ONBOARDING_HREF}
              className="ycs-btn ycs-btn--solid"
              onClick={() => void trackEvent("yc_startup_cta", { cta: "join" })}
            >
              Join as a candidate →
            </Link>
            <a
              href="#founders"
              className="ycs-btn"
              onClick={() => void trackEvent("yc_startup_cta", { cta: "talk" })}
            >
              Talk to founders ↓
            </a>
          </div>
        </section>

        <section id="founders" className="ycs-card">
          <p className="ycs-slug">/FOUNDERS</p>
          <h3>Startups you can match with right now</h3>
          <p>
            Live public roles from WeKruit partner startups. Open one to see the brief — Claire starts the
            conversation with the founder&rsquo;s team from there.
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
                  <span className="ycs-founder-company">
                    {f.company}
                    {f.collaborated && partnerChipMeaningful ? (
                      <span className="ycs-founder-chip">WeKruit partner</span>
                    ) : null}
                  </span>
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

        <section id="how" className="ycs-card">
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
              opens the thread with the founder&rsquo;s team — and until a match pops, there&rsquo;s nothing to
              chase: she texts and emails you when it does.
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
          Meet the people
          <br />
          building <em>what&rsquo;s next</em>
        </p>
        <Link to={ONBOARDING_HREF} className="ycs-btn ycs-btn--solid ycs-btn--big">
          Get matched →
        </Link>
      </section>

      <footer className="ycs-footer">
        <span>WEKRUIT × YC STARTUP SCHOOL ATTENDEES</span>
        <nav className="ycs-footer-links" aria-label="WeKruit">
          <Link to="/" className="ycs-inline-link">
            WEKRUIT
          </Link>
          <Link to="/market" className="ycs-inline-link">
            ALL ROLES
          </Link>
          <Link to="/me" className="ycs-inline-link">
            MY WEKRUIT
          </Link>
          <Link to="/employers" className="ycs-inline-link">
            FOR EMPLOYERS
          </Link>
          <Link to="/legal" className="ycs-inline-link">
            LEGAL
          </Link>
        </nav>
        <span>NOT AFFILIATED WITH Y COMBINATOR</span>
      </footer>
    </div>
  )
}

const YCS_STYLES = `
.ycs {
  --ycs-orange: #D9541F;          /* warm burnt orange — accent, not the whole page */
  --ycs-orange-soft: rgba(217, 84, 31, 0.10);
  min-height: 100vh;
  background: var(--cream, #F5EDE3);
  color: var(--ink, #2D1A0A);
  font-family: var(--font-sans, 'Hanken Grotesk', -apple-system, sans-serif);
  letter-spacing: 0.005em;
}
.ycs a { color: inherit; text-decoration: none; }
/* WeKruit voice: serif display for headings; mono ONLY for slugs/labels/ticker. */
.ycs h1, .ycs h2, .ycs h3 { font-family: var(--font-serif, 'Newsreader', Georgia, serif); font-weight: 400; }
.ycs-slug, .ycs-signin, .ycs-pill, .ycs-hero-corner--right p, .ycs-founder-meta,
.ycs-founder-go, .ycs-ticker-track span, .ycs-footer, .ycs-sun-copy {
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
}

/* Solid sticky nav — NO backdrop-filter/color-mix: blur on sticky elements breaks
   full-page screenshot stitching (blank strips) and costs Safari paint time. */
.ycs-nav {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px clamp(16px, 4vw, 48px);
  background: var(--cream, #F5EDE3);
  border-bottom: 1px solid var(--border, #E3D6C3);
}
.ycs-nav-right { display: flex; align-items: center; gap: 16px; }
.ycs .ycs-btn--nav { padding: 9px 18px; font-size: 13px; }
.ycs .ycs-mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--ink, #2D1A0A);
  color: var(--cream, #F5EDE3);
  font-family: var(--font-serif, Georgia, serif);
  font-weight: 600;
  font-size: 20px;
}
.ycs-nav-pills { display: flex; gap: 10px; }
.ycs-pill {
  padding: 8px 18px;
  border: 1px solid var(--border-strong, #C9B69E);
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.1em;
  transition: border-color 120ms ease, background 120ms ease;
}
.ycs-pill:hover { border-color: var(--ink, #2D1A0A); background: var(--ycs-orange-soft); }
.ycs-signin { font-size: 12px; letter-spacing: 0.14em; }
.ycs-signin:hover { color: var(--ycs-orange); }

.ycs-hero {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: start;
  gap: 16px;
  padding: 34px clamp(16px, 4vw, 48px) 0;
  min-height: 380px;
  background: var(--halo-hero, var(--cream, #F5EDE3));
}
.ycs-hero-corner h1 {
  margin: 0;
  font-size: clamp(30px, 3.4vw, 46px);
  line-height: 1.08;
  letter-spacing: -0.01em;
}
.ycs-hero-corner h1 em, .ycs-closer em { font-style: italic; color: var(--ycs-orange); }
.ycs-hero-corner--right { text-align: right; }
.ycs-hero-corner--right h2 { margin: 0; font-size: clamp(22px, 2.4vw, 32px); font-style: italic; }
.ycs-hero-corner--right p { margin: 10px 0 0; font-size: 11px; letter-spacing: 0.16em; color: var(--ink-3, #897462); }
.ycs-hero-sub { margin: 12px 0 0; font-size: 14px; color: var(--ink-2, #5A4636); }

.ycs-sun {
  position: relative;
  width: clamp(260px, 40vw, 540px);
  height: clamp(200px, 29vw, 370px);
  overflow: hidden;
  display: grid;
  place-items: end center;
}
.ycs-sun-core {
  position: absolute;
  inset: 0;
  background:
    repeating-linear-gradient(90deg, rgba(245, 237, 227, 0.22) 0 1px, transparent 1px 30px),
    radial-gradient(circle at 50% 100%,
      var(--ycs-orange) 0%,
      #E8845A 40%,
      var(--peach-300, #E8A988) 56%,
      var(--peach-glow, rgba(232,169,136,0.55)) 68%,
      transparent 78%);
  border-radius: 50% 50% 0 0 / 100% 100% 0 0;
}
.ycs-sun-copy {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 8px;
  padding-bottom: 26px;
  color: var(--cream, #F5EDE3);
  text-align: center;
}
.ycs-sun-big { font-size: clamp(44px, 6.4vw, 88px); font-weight: 700; line-height: 0.95; }
.ycs-sun-label { font-size: clamp(12px, 1.3vw, 17px); letter-spacing: 0.5em; }
.ycs-sun-tick { font-size: 11px; letter-spacing: 0.16em; opacity: 0.92; }

.ycs-rule { border-top: 1px solid var(--border, #E3D6C3); }

.ycs-hero-live {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0;
  padding: 12px 16px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  letter-spacing: 0.12em;
  color: var(--ink-2, #5A4636);
  background: var(--cream-2, #EFE4D4);
  border-bottom: 1px solid var(--border, #E3D6C3);
}
.ycs-hero-live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success, #4F6B3C);
  box-shadow: 0 0 0 3px rgba(79, 107, 60, 0.18);
}

.ycs-main {
  display: grid;
  gap: 26px;
  max-width: 1020px;
  margin: 0 auto;
  padding: 44px clamp(16px, 4vw, 48px) 64px;
}
.ycs-card {
  border: 1px solid var(--border, #E3D6C3);
  border-radius: 20px;
  padding: clamp(24px, 4vw, 44px);
  background: var(--cream-3, #FAF5EC);
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(45, 26, 10, 0.06));
}
.ycs-slug { margin: 0 0 16px; font-size: 11px; letter-spacing: 0.2em; color: var(--ycs-orange); }
.ycs-card h3 { margin: 0 0 14px; font-size: clamp(24px, 2.6vw, 32px); line-height: 1.2; }
.ycs-card p, .ycs-card li { font-size: 15.5px; line-height: 1.65; color: var(--ink-2, #5A4636); }
.ycs-card p { margin: 0 0 14px; }
.ycs-card strong { color: var(--ink, #2D1A0A); }
.ycs-card ul, .ycs-steps { margin: 0 0 14px; padding-left: 20px; display: grid; gap: 10px; }
.ycs-steps { list-style: none; padding-left: 0; }
.ycs-strong { font-weight: 700; color: var(--ink, #2D1A0A); }
.ycs-muted { color: var(--ink-3, #897462); }
.ycs-inline-link { text-decoration: underline; text-underline-offset: 3px; }
.ycs-inline-link:hover { color: var(--ycs-orange); }

.ycs-cta-row { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 22px; }
.ycs-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 13px 26px;
  border: 1px solid var(--border-strong, #C9B69E);
  border-radius: 999px;
  font-size: 15px;
  font-weight: 600;
  color: var(--ink, #2D1A0A);
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease;
}
.ycs-btn:hover { border-color: var(--ycs-orange); background: var(--ycs-orange-soft); transform: translateY(-1px); }
/* .ycs a { color: inherit } is 0-1-1 — these must be 0-2-0 to actually win. */
.ycs .ycs-btn--solid { background: var(--ink, #2D1A0A); border-color: var(--ink, #2D1A0A); color: var(--cream, #F5EDE3); }
.ycs .ycs-btn--solid:hover { background: var(--ycs-orange); border-color: var(--ycs-orange); color: #FFF8F0; }
.ycs-btn--big { padding: 16px 36px; font-size: 17px; }

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
  border: 1px solid var(--border, #E3D6C3);
  border-radius: 14px;
  background: var(--cream, #F5EDE3);
  transition: border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
}
.ycs-founder:hover {
  border-color: var(--border-strong, #C9B69E);
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(45, 26, 10, 0.08);
}
.ycs-founder-company {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-family: var(--font-serif, Georgia, serif);
  font-weight: 500;
  font-size: 18px;
}
.ycs-founder-chip {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--success-bg, #E6E9D9);
  color: var(--success, #4F6B3C);
}
.ycs-founder-role { font-size: 14px; color: var(--ink-2, #5A4636); }
.ycs-founder-person { font-size: 13px; color: var(--ink-2, #5A4636); }
.ycs-founder-meta { font-size: 11px; letter-spacing: 0.04em; color: var(--ink-3, #897462); }
.ycs-founder-go { margin-top: 8px; font-size: 11px; letter-spacing: 0.14em; color: var(--ycs-orange); }

.ycs-ticker {
  overflow: hidden;
  border-top: 1px solid var(--border, #E3D6C3);
  border-bottom: 1px solid var(--border, #E3D6C3);
  padding: 13px 0;
  background: var(--cream-2, #EFE4D4);
}
.ycs-ticker-track { display: flex; white-space: nowrap; animation: ycs-marquee 40s linear infinite; }
.ycs-ticker-track span { font-size: 12px; letter-spacing: 0.14em; padding-right: 8px; color: var(--ink-2, #5A4636); }
@keyframes ycs-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) { .ycs-ticker-track { animation: none; } }

.ycs-closer {
  display: grid;
  justify-items: center;
  gap: 30px;
  padding: 96px 20px;
  text-align: center;
  background: var(--halo-cta, var(--cream, #F5EDE3));
}
.ycs-closer p {
  margin: 0;
  font-family: var(--font-serif, 'Newsreader', Georgia, serif);
  font-size: clamp(40px, 7vw, 92px);
  font-weight: 400;
  line-height: 1.04;
  letter-spacing: -0.015em;
  color: var(--ink, #2D1A0A);
}
.ycs-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  align-items: center;
  justify-content: space-between;
  padding: 22px clamp(16px, 4vw, 48px);
  border-top: 1px solid var(--border, #E3D6C3);
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--ink-3, #897462);
}
.ycs-footer-links { display: flex; flex-wrap: wrap; gap: 8px 20px; }

@media (max-width: 780px) {
  .ycs-hero { grid-template-columns: 1fr; justify-items: center; text-align: center; min-height: 0; }
  .ycs-hero-corner--right { text-align: center; }
  .ycs-nav-pills { display: none; }
  .ycs-signin { display: none; }
}
`
