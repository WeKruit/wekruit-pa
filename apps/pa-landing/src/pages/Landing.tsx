/**
 * Landing.tsx — `/` candidate-facing landing.
 *
 * Sections: Hero → How it works → Live interviews → Trust signals.
 * Shared atoms (PulseDot, LiveStatusPill, Avatar, CompanyMark, IMessageThread,
 * Icon, CandidateShell) come from CandidateLogin.tsx.
 *
 * Keeps the original Firebase fetch (pa-jobs collection) intact —
 * job cards are re-themed but use the same PublicJobListItem shape.
 */
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { collection, getDocs, limit, query, where } from "firebase/firestore"
import { useQueryClient } from "@tanstack/react-query"
import { db } from "../lib/firebase.js"
import { trackEvent } from "../lib/analytics.js"
import { formatPublicJobType } from "../lib/public-job-labels.js"
import { listPublicJobOpenings } from "../lib/public-jobs.js"
import {
  CandidateShell,
  PulseDot,
  LiveStatusPill,
  Avatar,
  CompanyMark,
  IMessageThread,
  Icon,
} from "./CandidateLogin.js"
import { CandidateSequence } from "../components/Sequence.js"

interface PublicJobListDoc {
  publicVisible?: boolean
  wekruitCollaborationStatus?: "collaborated" | "not_collaborated"
  title?: string
  companyId?: string
  companyName?: string
  location?: string
  jobType?: string
  prescreenConfig?: {
    level1Reveal?: { salaryRange?: string }
    jobType?: string
  }
  /** Optional hiring-manager fields — populated by recruiter intake when present. */
  hiringManagerName?: string
  hiringManagerTitle?: string
  hiringManagerOnline?: boolean
  /** Optional employer-provided interview capacity; never synthesized. */
  interviewSeats?: number
}

interface PublicJobListItem {
  id: string
  title: string
  company: string
  location?: string
  salary?: string
  jobType?: string
  collaborated: boolean
  hiringManager: { name?: string; title?: string; online: boolean }
  /** Deterministic visual props derived from id so the same job always looks the same. */
  logo: string
  logoBg: string
  tone: "warm" | "moss" | "slate"
}

type JobsState =
  | { status: "loading" }
  | { status: "ready"; jobs: PublicJobListItem[] }
  | { status: "error"; message: string }

const LOGO_BG_POOL = ["#2A1812", "#0F1B2D", "#5E6AD2", "#635BFF", "#0D0D0D", "#1A1A1A", "#374151", "#7C2D12"]
const TONE_POOL: Array<"warm" | "moss" | "slate"> = ["warm", "slate", "moss"]
const ALLIANCE_LOGO_URL =
  "https://images.prismic.io/alliance/fe454d0e-2b43-41ff-b606-133e6465cd9b_alliance-logo-animated-white.gif?auto=false&fit=max&w=128&q=75"

function djb2(s: string): number {
  let h = 5381 >>> 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0
  return h
}

function normalizeJob(id: string, data: PublicJobListDoc): PublicJobListItem {
  const company = data.companyName ?? "Confidential employer"
  const h = djb2(id || company)
  return {
    id,
    title: data.title ?? "Open role",
    company,
    location: data.location,
    salary: data.prescreenConfig?.level1Reveal?.salaryRange,
    jobType: formatPublicJobType(data.jobType ?? data.prescreenConfig?.jobType),
    collaborated: data.wekruitCollaborationStatus === "collaborated",
    hiringManager: {
      name: data.hiringManagerName,
      title: data.hiringManagerTitle,
      online: data.hiringManagerOnline === true,
    },
    logo: (company[0] ?? "?").toUpperCase(),
    logoBg: LOGO_BG_POOL[h % LOGO_BG_POOL.length],
    tone: TONE_POOL[h % TONE_POOL.length],
  }
}

export default function Landing() {
  const [state, setState] = useState<JobsState>({ status: "loading" })
  const queryClient = useQueryClient()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const snap = await getDocs(
          query(collection(db(), "pa-jobs"), where("publicVisible", "==", true), limit(48)),
        )
        const jobs: PublicJobListItem[] = snap.docs
          .map((d) => normalizeJob(d.id, d.data() as PublicJobListDoc))
          .sort((a, b) => `${a.company} ${a.title}`.localeCompare(`${b.company} ${b.title}`))
        if (!cancelled) setState({ status: "ready", jobs })
      } catch (err) {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Hash anchor scroll. Triggered on:
  //   1. Initial mount when URL contains a hash (e.g. /#how from cross-route nav).
  //   2. `hashchange` events (back/forward navigation).
  // Header's HowItWorksLink handles same-page clicks directly; this covers
  // the cross-route case where react-router-dom mounts Landing fresh.
  useEffect(() => {
    function scrollToHash() {
      const hash = window.location.hash.replace(/^#/, "")
      if (!hash) return
      // Wait a tick so CandidateSequence has rendered before measuring offset.
      setTimeout(() => {
        document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" })
      }, 60)
    }
    scrollToHash()
    window.addEventListener("hashchange", scrollToHash)
    return () => window.removeEventListener("hashchange", scrollToHash)
  }, [])

  // Idle-prefetch market data while the user is reading the landing hero.
  // The market shares the QueryClient configured in main.tsx (staleTime=5min),
  // so clicking "Open market" repaints instantly from cache instead of waiting
  // on a cold CF + Firestore read.
  // Wrapped in requestIdleCallback so it never competes with the hero paint.
  useEffect(() => {
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    }
    const run = () => {
      // Tracked roles — paPublicOpenJobs CF, matching the market tracked-feed
      // filters so the cache can be reused after the candidate opens /market.
      void queryClient.prefetchQuery({
        queryKey: ["open-jobs", {
          limit: 80, freshDays: 45,
          function: [], level: [], location: [],
          remoteOnly: false, search: "",
        }],
        queryFn: async () => {
          const url =
            (import.meta.env.VITE_OPEN_JOBS_URL ??
              "https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicOpenJobs") +
            "?limit=80&freshDays=45"
          const r = await fetch(url)
          if (!r.ok) throw new Error(`open-jobs ${r.status}`)
          const body = (await r.json()) as { ok: boolean; rows: unknown[]; reason?: string }
          if (!body.ok) throw new Error(body.reason ?? "open-jobs failed")
          return body.rows
        },
        staleTime: 5 * 60 * 1000,
      })
      // Public WeKruit role briefs — pa-jobs publicVisible, reused by /market.
      void queryClient.prefetchQuery({
        queryKey: ["pa-jobs-public-openings", 24],
        queryFn: () => listPublicJobOpenings(24),
        staleTime: 5 * 60 * 1000,
      })
    }
    if (typeof win.requestIdleCallback === "function") {
      win.requestIdleCallback(run, { timeout: 1500 })
    } else {
      window.setTimeout(run, 600)
    }
  }, [queryClient])

  const jobs = state.status === "ready" ? state.jobs : []
  return (
    <CandidateShell hero>
      <style>{LANDING_STYLES}</style>

      {/* ── Hero ─────────────────────────────────────────── */}
      <section className="wk-hero">
        <div className="wk-container wk-hero__grid">
          <div className="wk-hero__copy">
            <AllianceBackedBadge />
            <p className="wk-eyebrow">
              <PulseDot size={7} /> Skip the application. Interview.
            </p>
            <h1 className="wk-hero__h1" aria-label="You don't apply. You interview.">
              <span>You don&apos;t <em className="wk-accent">apply.</em></span>
              <span>You interview.</span>
            </h1>
            <p className="wk-hero__lede">
              Upload your résumé once. Claire — your WeKruit recruiter on iMessage —
              builds one WeKruit profile that keeps working across roles. When a role matches,
              Claire starts the first interview; your passed profile carries the evidence.
            </p>
            <div className="wk-hero__cta">
              <Link to="/onboarding" className="wk-btn wk-btn--primary wk-btn--lg" onClick={() => void trackEvent("landing_cta_click", { cta: "hero_interview_claire" })}>
                Interview with Claire
                <Icon name="arrow-right" size={16} stroke={2} />
              </Link>
              <Link to="/market" className="wk-btn wk-btn--secondary wk-btn--lg">
                Open market
                <Icon name="arrow-right" size={16} stroke={2} />
              </Link>
              <a
                href="#interviews"
                className="wk-hero__browse"
                onClick={(e) => {
                  e.preventDefault()
                  document.getElementById("interviews")?.scrollIntoView({ behavior: "smooth", block: "start" })
                }}
              >
                Browse public roles <Icon name="arrow-down" size={14} stroke={2} />
              </a>
            </div>
            <div className="wk-hero__proof">
              <Avatar name="MC" size={26} tone="warm" />
              <Avatar name="DP" size={26} tone="slate" />
              <Avatar name="PS" size={26} tone="warm" />
              <Avatar name="JR" size={26} tone="moss" />
              <span>
                {state.status === "ready" && jobs.length > 0 ? (
                  <>
                    <strong>{jobs.length}</strong> public roles Claire can screen against.
                  </>
                ) : (
                  <>
                    <strong>Claire interviews against real role briefs</strong> before a passed profile goes out.
                  </>
                )}
              </span>
            </div>
            <p className="wk-hero__market-note">
              Tracked roles are source evidence, not applications. Use roles as signal before Claire chases anything.
            </p>
          </div>

          <div className="wk-hero__visual">
            <IMessageThread
              phoneFrame
              messages={[
                { from: "claire", text: "Hey — Claire from WeKruit. Mind if I ask three quick questions?" },
                { from: "user",   text: "Go for it." },
                { from: "claire", text: "What's your dream role?" },
                { from: "user",   text: "Senior PM at an AI infra startup. NYC. $180k+." },
              ]}
            />
            <div className="wk-hero__caption">
              <PulseDot size={6} />
              <span>Claire keeps the interview in iMessage.</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── What Claire does — 4-card editorial sequence (2026-05-26 design drop)
           Replaces the older 3-step "How it works" cards. Same conceptual slot,
           richer artifacts (résumé scan, iMessage prescreen, live feed of skips,
           passed profile) with the Standout-style inline verb pill.
           id="how" so the header nav "How it works" → /#how anchor scrolls here. */}
      <section id="how">
        <CandidateSequence />
      </section>

      {/* ── Public roles ──────────────────────────────── */}
      <section className="wk-section wk-section--live" id="interviews">
        <div className="wk-container">
          <header className="wk-section__head wk-section__head--row">
            <div>
              <p className="wk-eyebrow"><PulseDot size={6} /> Public roles</p>
              <h2 className="wk-section__h2">Public roles Claire can screen against.</h2>
            </div>
            {state.status === "ready" ? (
              <p className="wk-section__sub">
                <strong>{jobs.length} public roles</strong> · Claire starts the interview, then passed profiles go to the hiring team.
              </p>
            ) : null}
          </header>

          {state.status === "loading" ? <p className="wk-muted">Loading public roles…</p> : null}
          {state.status === "error" ? <p className="wk-error">{state.message}</p> : null}
          {state.status === "ready" && jobs.length === 0 ? (
            <p className="wk-muted">No public WeKruit roles are open right now. Keep your profile current; Claire can screen when a real role opens.</p>
          ) : null}

          {state.status === "ready" && jobs.length > 0 ? (
            <div className="wk-joblist">
              {jobs.map((j) => <JobCard key={j.id} job={j} />)}
            </div>
          ) : null}
        </div>
      </section>

      {/* ── Product proof ────────────────────────────────── */}
      <section className="wk-section wk-section--trust">
        <div className="wk-container">
          <header className="wk-section__head wk-section__head--center">
            <p className="wk-eyebrow">What Claire can prove</p>
            <h2 className="wk-section__h2">Evidence before introductions.</h2>
          </header>

          <div className="wk-proof-grid">
            <article className="wk-proof-card">
              <span className="wk-proof-card__icon" aria-hidden="true">
                <Icon name="check" size={18} stroke={2} />
              </span>
              <h3>Evidence packet</h3>
              <p>
                Each passed profile carries the pass reason, risks, fit notes, and transcript excerpts
                the hiring team needs to judge signal without replaying the whole screen.
              </p>
            </article>
            <article className="wk-proof-card">
              <span className="wk-proof-card__icon" aria-hidden="true">
                <Icon name="shield" size={18} stroke={2} />
              </span>
              <h3>Candidate-controlled sharing</h3>
              <p>
                Claire shares a profile only after the role screen is passed and the candidate has
                enough context to decide whether that employer should see their profile.
              </p>
            </article>
            <article className="wk-proof-card">
              <span className="wk-proof-card__icon" aria-hidden="true">
                <Icon name="sparkle" size={18} stroke={2} />
              </span>
              <h3>Profile memory</h3>
              <p>
                Every role conversation updates the durable candidate profile, so a not-pass can
                sharpen future matching instead of burning the candidate.
              </p>
            </article>
          </div>

          <section className="wk-candidate-faq" aria-labelledby="wk-candidate-faq-title">
            <div className="wk-candidate-faq__head">
              <p className="wk-eyebrow">Candidate operating model</p>
              <h2 id="wk-candidate-faq-title">What happens after Claire knows you.</h2>
            </div>
            <div className="wk-candidate-faq__grid">
              <article className="wk-candidate-faq__item">
                <h3>Who sees my profile?</h3>
                <p>
                  Only employers for roles you pass and consent to share with. Claire keeps your
                  profile private until a real role screen creates evidence worth sending.
                </p>
              </article>
              <article className="wk-candidate-faq__item">
                <h3>What if I do not pass a role screen?</h3>
                <p>
                  A not-pass is role-specific. Your global profile stays in the pool, and the
                  conversation sharpens future matching instead of burning your WeKruit account.
                </p>
              </article>
              <article className="wk-candidate-faq__item">
                <h3>Does Claire apply for me?</h3>
                <p>
                  Public roles are role briefs Claire can interview against, not applications.
                  Once you enter a role flow, Claire starts the first interview; match score is not a hard stop.
                </p>
              </article>
              <article className="wk-candidate-faq__item">
                <h3>How do corrections stick?</h3>
                <p>
                  Corrections update your durable profile and preferences, so salary, location,
                  visa, role function, and industry constraints can follow you across future screens.
                </p>
              </article>
            </div>
          </section>

          <div className="wk-final-cta">
            <h3 className="wk-final-cta__h">Stop applying. Start with Claire.</h3>
            <Link to="/onboarding" className="wk-btn wk-btn--primary wk-btn--lg">
              Interview with Claire
              <Icon name="arrow-right" size={16} stroke={2} />
            </Link>
            <p className="wk-final-cta__fine">
              Free for candidates. We're paid by employers when they hire you.
            </p>
          </div>
        </div>
      </section>
    </CandidateShell>
  )
}

function AllianceBackedBadge() {
  return (
    <a
      className="wk-alliance-badge"
      href="https://alliance.xyz/"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Backed by Alliance"
    >
      <span className="wk-alliance-badge__mark" aria-hidden="true">
        <img src={ALLIANCE_LOGO_URL} alt="" decoding="async" />
      </span>
      <span className="wk-alliance-badge__copy">
        <span className="wk-alliance-badge__label">Backed by <strong>Alliance</strong></span>
      </span>
    </a>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// StepCard
// ────────────────────────────────────────────────────────────────────────────

function StepCard({
  n, title, icon, body, footer,
}: {
  n: string
  title: string
  icon: "message" | "sparkle" | "calendar"
  body: string
  footer: string
}) {
  return (
    <article className="wk-step">
      <div className="wk-step__head">
        <span className="wk-step__num">{n}</span>
        <span className="wk-step__icon" aria-hidden="true"><Icon name={icon} size={20} stroke={1.5} /></span>
      </div>
      <h3 className="wk-step__title">{title}</h3>
      <p className="wk-step__body">{body}</p>
      <p className="wk-step__footer">{footer}</p>
    </article>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// JobCard — re-themed live interview card
// ────────────────────────────────────────────────────────────────────────────

function JobCard({ job }: { job: PublicJobListItem }) {
  return (
    <Link to={`/j/${job.id}`} className="wk-jobcard" aria-label={`Start Claire interview for ${job.title} at ${job.company}`}>
      <div className="wk-jobcard__top">
        <CompanyMark logo={job.logo} bg={job.logoBg} size={44} />
        {job.hiringManager.online ? (
          <LiveStatusPill>Claire role interview</LiveStatusPill>
        ) : (
          <span className="wk-jobcard__offline">
            <span className="wk-jobcard__dot" /> Role brief available
          </span>
        )}
      </div>
      <h3 className="wk-jobcard__title">{job.title}</h3>
      <p className="wk-jobcard__company">
        {job.company}{job.location ? <> · <span>{job.location}</span></> : null}
      </p>
      <div className="wk-jobcard__chips">
        {job.jobType ? <span className="wk-chip">{job.jobType}</span> : null}
        {job.salary ? <span className="wk-chip wk-chip--strong">{job.salary}</span> : null}
        {job.collaborated ? (
          <span className="wk-chip wk-chip--collab">
            <Icon name="check" size={12} stroke={2.2} /> WeKruit collaborated
          </span>
        ) : null}
      </div>
      {job.hiringManager.name ? (
        <div className="wk-jobcard__hm">
          <Avatar name={job.hiringManager.name} size={28} tone={job.tone} />
          <span className="wk-jobcard__hm-name">
            Hiring context from <strong>{job.hiringManager.name}</strong>
            {job.hiringManager.title ? ` · ${job.hiringManager.title}` : ""}
          </span>
        </div>
      ) : null}
      <div className="wk-jobcard__footer">
        <span className="wk-jobcard__seats">
          Claire starts with the role interview
        </span>
        <span className="wk-btn wk-btn--primary wk-btn--block wk-jobcard__cta">
          Interview with Claire
          <Icon name="arrow-right" size={16} stroke={2} />
        </span>
      </div>
    </Link>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Styles
// ────────────────────────────────────────────────────────────────────────────

const LANDING_STYLES = `
.wk-muted { color: var(--wk-ink-3); }

/* Hero ------------------------------------------------------------------ */
.wk-hero { padding: 36px 0 44px; position: relative; }
.wk-hero__grid {
  display: grid;
  grid-template-columns: 1.05fr 0.95fr;
  gap: 48px;
  align-items: start;
}
.wk-hero__h1 {
  --wk-hero-title-leading: 1.14;
  --wk-hero-title-row-gap: 5px;
  font-family: 'Newsreader', serif;
  font-weight: 400;
  display: flex;
  flex-direction: column;
  gap: var(--wk-hero-title-row-gap);
  max-width: min(100%, 620px);
  font-size: 52px;
  line-height: var(--wk-hero-title-leading);
  letter-spacing: 0;
  color: var(--wk-ink);
  margin: 18px 0 24px;
  text-wrap: balance;
  overflow: visible;
}
.wk-hero__h1 > span {
  display: block;
  line-height: var(--wk-hero-title-leading);
  white-space: nowrap;
}
.wk-hero__h1 .wk-accent {
  display: inline-block;
  line-height: var(--wk-hero-title-leading);
  padding-bottom: 0.03em;
}
.wk-hero__lede {
  font-size: clamp(16.5px, 1.35vw, 18px);
  line-height: 1.46;
  color: var(--wk-ink-2);
  margin: 0 0 22px;
  max-width: 500px;
  text-wrap: pretty;
}
.wk-hero__cta {
  display: flex; align-items: center; gap: 10px;
  flex-wrap: wrap; margin-bottom: 22px;
}
.wk-hero__browse {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--wk-ink-2);
  text-decoration: none;
  font-weight: 500; font-size: 13.5px;
  transition: color 200ms var(--wk-ease);
}
.wk-hero__browse:hover { color: var(--wk-ink); }
.wk-hero__proof {
  display: inline-flex; align-items: center; gap: 14px;
  color: var(--wk-ink-3); font-size: 13.5px;
}
.wk-hero__proof strong { color: var(--wk-ink-2); font-weight: 600; }
.wk-hero__proof > .wk-avatar { margin-right: -10px; box-shadow: inset 0 0 0 1px rgba(45,26,10,.08), 0 0 0 2px var(--wk-cream-3); }
.wk-hero__market-note {
  max-width: 520px;
  margin: 14px 0 0;
  color: var(--wk-ink-3);
  font-size: 13.5px;
  line-height: 1.5;
}
.wk-alliance-badge {
  display: flex;
  align-items: center;
  gap: 11px;
  max-width: 100%;
  width: fit-content;
  margin-bottom: 14px;
  padding: 5px 10px 5px 5px;
  border-radius: var(--wk-r-pill);
  border: 1px solid rgba(45, 26, 10, 0.09);
  background: rgba(255, 252, 246, 0.48);
  color: inherit;
  text-decoration: none;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.52),
    0 10px 24px -22px rgba(45, 26, 10, 0.30);
  transition:
    border-color 180ms var(--wk-ease),
    background 180ms var(--wk-ease),
    box-shadow 220ms var(--wk-ease),
    transform 220ms var(--wk-ease);
}
.wk-alliance-badge:hover,
.wk-alliance-badge:focus-visible {
  border-color: rgba(45, 26, 10, 0.16);
  background: rgba(255, 252, 246, 0.72);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.66),
    0 12px 26px -22px rgba(45, 26, 10, 0.36);
  transform: translateY(-1px);
  outline: none;
}
.wk-alliance-badge:focus-visible {
  box-shadow:
    0 0 0 2px var(--wk-cream),
    0 0 0 4px var(--wk-ink),
    0 12px 26px -22px rgba(45, 26, 10, 0.36);
}
.wk-alliance-badge__mark {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: #19120B;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.wk-alliance-badge__mark img {
  width: 14px;
  height: 14px;
  display: block;
}
.wk-alliance-badge__copy {
  display: grid;
  gap: 4px;
  min-width: 0;
  line-height: 1.05;
}
.wk-alliance-badge__label {
  color: var(--wk-ink-2);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  white-space: nowrap;
}
.wk-alliance-badge__label strong {
  color: var(--wk-ink);
  font-weight: 650;
}
.wk-hero__visual { display: flex; flex-direction: column; align-items: center; gap: 9px; margin-top: -20px; }
.wk-hero__caption {
  display: inline-flex; align-items: center; gap: 8px;
  color: var(--wk-ink-3); font-size: 13px;
}
.wk-hero__visual .wk-imsg-thread__body { min-height: 160px; }
.wk-hero__visual .wk-imsg-phone { max-width: 320px; }
.wk-hero-packet {
  position: relative;
  z-index: 2;
  width: min(100%, 390px);
  margin-top: 0;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid rgba(38, 91, 77, 0.18);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.82), rgba(255, 252, 246, 0.74)),
    rgba(236, 247, 240, 0.68);
  box-shadow: 0 16px 34px -28px rgba(45, 26, 10, 0.34);
}
.wk-hero-packet__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 7px;
  border-bottom: 1px solid rgba(38, 91, 77, 0.14);
}
.wk-hero-packet__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--wk-live);
  font-size: 12.5px;
  font-weight: 700;
}
.wk-hero-packet__role {
  color: var(--wk-ink-3);
  font-size: 12.5px;
  font-weight: 600;
}
.wk-hero-packet__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  padding-top: 8px;
}
.wk-hero-packet__item {
  min-width: 0;
  display: grid;
  gap: 4px;
  padding: 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.58);
  border: 1px solid rgba(45, 26, 10, 0.07);
}
.wk-hero-packet__item--wide { grid-column: auto; }
.wk-hero-packet__item strong {
  color: var(--wk-ink);
  font-size: 12px;
  line-height: 1.22;
  font-weight: 700;
}
.wk-hero-packet__item span {
  color: var(--wk-ink-2);
  font-size: 12px;
  line-height: 1.34;
}

/* Sections -------------------------------------------------------------- */
.wk-section { padding: 80px 0; background: var(--wk-cream); position: relative; }
.wk-section--live { background: var(--wk-cream-2); }
.wk-section--trust {
  padding-top: 96px; padding-bottom: 120px;
  background:
    radial-gradient(ellipse 90% 70% at 50% 100%, var(--wk-peach-glow) 0%, transparent 60%),
    var(--wk-cream);
}
.wk-section__head { display: grid; gap: 8px; margin-bottom: 48px; }
.wk-section__head--row {
  display: flex; align-items: flex-end; justify-content: space-between;
  flex-wrap: wrap; gap: 16px;
}
.wk-section__head--center { text-align: center; justify-items: center; margin-bottom: 32px; }
.wk-section__h2 {
  font-family: 'Newsreader', serif;
  font-weight: 400;
  font-size: clamp(34px, 4.4vw, 56px);
  line-height: 1.14; letter-spacing: 0;
  color: var(--wk-ink); margin: 0;
  text-wrap: balance; max-width: 760px;
}
.wk-section__sub { color: var(--wk-ink-3); font-size: 14.5px; margin: 0; }
.wk-section__sub strong { color: var(--wk-live); font-weight: 600; }

/* Steps ----------------------------------------------------------------- */
.wk-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
}
.wk-step {
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-lg);
  padding: 32px 28px 28px;
  display: flex; flex-direction: column; gap: 14px;
  transition: border-color 200ms var(--wk-ease),
              box-shadow 320ms var(--wk-ease),
              transform 320ms var(--wk-ease);
}
.wk-step:hover {
  border-color: var(--wk-border-strong);
  box-shadow: 0 8px 24px -8px rgba(45,26,10,.10);
  transform: translateY(-2px);
}
.wk-step__head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.wk-step__num {
  font-family: 'Newsreader', serif;
  font-style: italic; font-weight: 400;
  font-size: 28px; line-height: 1;
  color: var(--wk-peach-300);
}
.wk-step__icon {
  display: inline-flex; width: 38px; height: 38px;
  align-items: center; justify-content: center;
  border-radius: 50%;
  background: var(--wk-cream-2);
  color: var(--wk-ink-2);
}
.wk-step__title {
  font-family: 'Newsreader', serif;
  font-weight: 400; font-size: 26px;
  line-height: 1.15; letter-spacing: -0.018em;
  color: var(--wk-ink); margin: 0;
}
.wk-step__body { color: var(--wk-ink-2); font-size: 15.5px; line-height: 1.55; margin: 0; flex: 1; }
.wk-step__footer {
  color: var(--wk-ink-3); font-size: 13px; font-weight: 500;
  margin: 8px 0 0; padding-top: 14px;
  border-top: 1px solid var(--wk-border);
  letter-spacing: -0.005em;
}

/* Job list -------------------------------------------------------------- */
.wk-joblist {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 18px;
}
.wk-jobcard {
  display: flex; flex-direction: column; gap: 12px;
  padding: 22px;
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  text-decoration: none; color: inherit;
  transition: border-color 200ms var(--wk-ease),
              box-shadow 320ms var(--wk-ease),
              transform 320ms var(--wk-ease);
}
.wk-jobcard:hover, .wk-jobcard:focus-visible {
  border-color: var(--wk-live-border);
  box-shadow: 0 2px 0 0 rgba(154,68,33,.06), 0 10px 24px -14px rgba(154,68,33,.20);
  transform: translateY(-2px);
  outline: none;
}
.wk-jobcard__top {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.wk-jobcard__offline {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 11px 5px 9px;
  border-radius: var(--wk-r-pill);
  background: var(--wk-cream-2);
  border: 1px solid var(--wk-border);
  color: var(--wk-ink-3);
  font-size: 12.5px; font-weight: 500;
}
.wk-jobcard__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--wk-ink-4); display: inline-block; }
.wk-jobcard__title {
  font-family: 'Newsreader', serif;
  font-weight: 400; font-size: 22px;
  line-height: 1.18; letter-spacing: -0.018em;
  color: var(--wk-ink); margin: 4px 0 0;
}
.wk-jobcard__company { margin: 0; color: var(--wk-ink-2); font-size: 14.5px; }
.wk-jobcard__company span { color: var(--wk-ink-3); }
.wk-jobcard__chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.wk-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 9px; border-radius: var(--wk-r-pill);
  background: var(--wk-cream-2); color: var(--wk-ink-2);
  border: 1px solid var(--wk-border);
  font-size: 12.5px; font-weight: 500; line-height: 1.4;
}
.wk-chip--strong { color: var(--wk-ink); font-weight: 600; }
.wk-chip--collab { background: var(--wk-live-soft); border-color: var(--wk-live-border); color: var(--wk-live); }
.wk-jobcard__hm {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 0 0;
  border-top: 1px dashed var(--wk-border);
  margin-top: 6px;
}
.wk-jobcard__hm-name { color: var(--wk-ink-2); font-size: 13.5px; line-height: 1.3; }
.wk-jobcard__hm-name strong { color: var(--wk-ink); font-weight: 600; }
.wk-jobcard__footer { display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
.wk-jobcard__seats { color: var(--wk-ink-3); font-size: 12.5px; font-weight: 500; }
.wk-jobcard__cta { pointer-events: none; }
.wk-jobcard:hover .wk-jobcard__cta { background: #1C0F04; }

/* Product proof --------------------------------------------------------- */
.wk-proof-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  margin: 0 0 64px;
}
.wk-proof-card {
  min-height: 240px;
  display: grid;
  align-content: start;
  gap: 16px;
  padding: 24px;
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-lg);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.88), rgba(255,255,255,0.62)),
    var(--wk-cream);
  box-shadow: var(--wk-shadow-soft);
}
.wk-proof-card__icon {
  width: 36px; height: 36px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 12px;
  background: var(--wk-brown-soft);
  color: var(--wk-brown);
  border: 1px solid rgba(122, 82, 46, 0.18);
}
.wk-proof-card h3 {
  margin: 0;
  color: var(--wk-ink);
  font-size: 18px;
  line-height: 1.25;
  font-weight: 650;
}
.wk-proof-card p {
  margin: 0;
  color: var(--wk-ink-2);
  font-size: 14.5px;
  line-height: 1.62;
}

.wk-candidate-faq {
  max-width: 1040px;
  margin: 0 auto 64px;
  padding: 28px 0 0;
  border-top: 1px solid var(--wk-border);
}
.wk-candidate-faq__head {
  display: grid;
  gap: 10px;
  justify-items: center;
  text-align: center;
  margin-bottom: 24px;
}
.wk-candidate-faq__head h2 {
  font-family: 'Newsreader', serif;
  font-weight: 400;
  font-size: clamp(30px, 3.8vw, 48px);
  line-height: 1.14;
  letter-spacing: 0;
  color: var(--wk-ink);
  margin: 0;
  text-wrap: balance;
}
.wk-candidate-faq__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.wk-candidate-faq__item {
  min-height: 164px;
  padding: 22px;
  border: 1px solid var(--wk-border);
  border-radius: 8px;
  background: var(--wk-cream-3);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wk-candidate-faq__item:nth-child(1) { border-color: rgba(38, 91, 77, 0.20); background: rgba(236, 247, 240, 0.74); }
.wk-candidate-faq__item:nth-child(2) { border-color: rgba(93, 104, 139, 0.20); background: rgba(241, 244, 251, 0.84); }
.wk-candidate-faq__item:nth-child(3) { border-color: rgba(122, 82, 46, 0.18); background: rgba(255, 249, 239, 0.88); }
.wk-candidate-faq__item:nth-child(4) { border-color: rgba(127, 82, 100, 0.18); background: rgba(250, 240, 244, 0.70); }
.wk-candidate-faq__item h3 {
  margin: 0;
  color: var(--wk-ink);
  font-size: 17px;
  line-height: 1.28;
  letter-spacing: 0;
  font-weight: 650;
}
.wk-candidate-faq__item p {
  margin: 0;
  color: var(--wk-ink-2);
  font-size: 14.5px;
  line-height: 1.58;
}

.wk-final-cta {
  max-width: 560px; margin: 0 auto;
  text-align: center; display: grid; gap: 20px; justify-items: center;
}
.wk-final-cta__h {
  font-family: 'Newsreader', serif; font-weight: 400;
  font-size: clamp(30px, 3.4vw, 44px);
  line-height: 1.14; letter-spacing: 0;
  color: var(--wk-ink); margin: 0;
  text-wrap: balance;
}
.wk-final-cta__fine { color: var(--wk-ink-3); font-size: 13.5px; margin: 0; }

/* Mobile ---------------------------------------------------------------- */
@media (max-width: 1180px) {
  .wk-hero__h1 { font-size: 50px; }
}
@media (max-width: 980px) {
  .wk-hero { padding: 28px 0 40px; }
  .wk-hero__grid {
    grid-template-columns: minmax(0, 1fr) minmax(280px, 0.78fr);
    gap: 36px;
    align-items: start;
  }
  .wk-hero__h1 { --wk-hero-title-leading: 1.16; --wk-hero-title-row-gap: 5px; font-size: 44px; }
  .wk-hero__visual { margin-top: 0; padding-top: 24px; }
  .wk-hero-packet { max-width: 320px; margin-top: 0; padding: 12px; }
  .wk-hero-packet__grid { grid-template-columns: 1fr; gap: 7px; }
  .wk-steps { grid-template-columns: 1fr; }
  .wk-joblist { grid-template-columns: 1fr; }
  .wk-proof-grid { grid-template-columns: 1fr; margin-bottom: 48px; }
  .wk-proof-card { min-height: 0; }
  .wk-candidate-faq { margin-bottom: 48px; }
  .wk-candidate-faq__grid { grid-template-columns: 1fr; }
  .wk-candidate-faq__item { min-height: 0; }
}
@media (max-width: 760px) {
  .wk-hero__grid { grid-template-columns: 1fr; gap: 40px; }
  .wk-hero__visual {
    display: none;
  }
  .wk-hero__visual .wk-imsg-phone { max-width: 360px; }
  .wk-hero-packet { max-width: 360px; }
}
@media (max-width: 600px) {
  .wk-section { padding: 56px 0; }
  .wk-section__head { margin-bottom: 28px; }
  .wk-proof-card { padding: 20px; }
  .wk-hero__h1 { --wk-hero-title-leading: 1.18; --wk-hero-title-row-gap: 5px; font-size: 35px; }
  .wk-hero__cta { gap: 12px; }
  .wk-hero__browse { flex-basis: 100%; }
  .wk-hero-packet__head { align-items: flex-start; flex-direction: column; gap: 5px; }
  .wk-hero-packet__item { padding: 9px; }
}
@media (max-width: 360px) {
  .wk-hero__h1 { font-size: 32px; }
}
`
