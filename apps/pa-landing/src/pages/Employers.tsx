/**
 * Employers.tsx — `/employers` marketing landing + `/employers/inbox`
 * passed-profile preview.
 *
 * WeKruit's employer surface is **passed-profile only** — never an ATS,
 * never a candidate browser. The narrative mirrors the v2.0 Candidate
 * Retention Marketplace product lock (CLAUDE.md): employers see passed
 * profiles plus the transcript that produced them; everything else
 * stays behind Claire's wall.
 *
 * Visual system: editorial cream + espresso + warm terracotta confidence
 * accent, shared with the candidate side via wekruit-tokens.css + the
 * .wk-shell scope from CandidateLogin.tsx. Page-specific classes live in
 * src/styles/wekruit-pages.css (imported by main.tsx).
 *
 * Exports:
 *   - default Employers       → /employers
 *   - named EmployersInbox    → /employers/inbox
 */
import { useEffect, useState, type ReactNode } from "react"
import { Link, useNavigate } from "react-router-dom"
import {
  Avatar,
  CANDIDATE_STYLES,
  Icon,
  PulseDot,
  WekruitLogo,
} from "./CandidateLogin.js"
import { AudienceToggle } from "../components/AudienceToggle.js"
import { EmployerSequence } from "../components/Sequence.js"

// ────────────────────────────────────────────────────────────────────────────
// Mock data — one fully-fleshed passed profile (Maya Okafor) plus 4 stubs.
// Sourced from the 2026-05-26 design handoff. Once the employer dashboard
// connects to live PASS events from PreScreenPipeline, replace this with a
// Firestore query against pass-snapshots/{employerId}/{jobId}.
// ────────────────────────────────────────────────────────────────────────────

type PassedProfile = {
  id: string
  name: string
  initials: string
  tone: "warm" | "moss" | "slate"
  headline: string
  role: string
  pass: "Strong pass" | "Pass" | "Pass with reservations"
  passedMin: number
  score: number
  summary?: string
  passReason?: string
  evidence?: { tag: string; source: string }[]
  requirementsMet?: string[]
  risks?: string[]
  fit?: {
    compAsked: string
    compRange: string
    visa: string
    location: string
    start: string
  }
  transcript?: { q: string; a: string }[]
  consent?: string
}

const EMP_PASSED: PassedProfile[] = [
  {
    id: "pp-maya-okafor",
    name: "Maya Okafor",
    initials: "MO",
    tone: "warm",
    headline: "Senior PM · AI infrastructure · 7y",
    role: "Senior Product Manager, Claude APIs",
    pass: "Strong pass",
    passedMin: 14,
    score: 92,
    summary:
      "Built and shipped two 0→1 AI platform products at Linear and Replit. " +
      "Owns developer-facing API roadmaps end-to-end and has scaled a billing/tiering surface from " +
      "300M to 11B calls/month. Wants infrastructure scope, not feature work, and is ready to talk now.",
    passReason:
      "Maya cleared every must-have on the brief: 5+y product, ships against a P&L, has shipped " +
      "developer-facing AI APIs at scale, and lives in SF. Her answer to the “what would you cut " +
      "from the current roadmap” question was specific and showed she'd read your changelog. " +
      "She has one active interview elsewhere — Anthropic should move this week.",
    evidence: [
      { tag: "Shipped 2 AI APIs at scale", source: "Resume · Linear, Replit" },
      { tag: "Owns roadmap + P&L", source: "Interview · Q4" },
      { tag: "Tiering / billing depth", source: "Interview · Q7" },
      { tag: "Reads your changelog", source: "Interview · Q9" },
      { tag: "Calm under ambiguity", source: "Claire's read" },
    ],
    requirementsMet: [
      "5+y PM, developer-facing",
      "Shipped APIs at scale",
      "Owned billing / tiering",
      "Comfortable with research orgs",
      "SF · willing to come in 3d/wk",
    ],
    risks: [
      "Hasn't directly managed a team (has led pods, not headcount)",
      "Wants infra scope — would walk if pushed to consumer surface",
      "One active interview at Perplexity (loop closes Friday)",
    ],
    fit: {
      compAsked: "$240k base · willing on equity",
      compRange: "$220k – $290k base",
      visa: "US citizen — no sponsorship",
      location: "SF · 3 days/wk in office OK",
      start: "4 weeks notice",
    },
    transcript: [
      {
        q: "What's the worst part of the current Claude API surface?",
        a:
          "The streaming response shape is fine until you try to do tool-use inside a " +
          "long-running agent. You end up parsing two different envelopes and clients " +
          "drift. I'd ship a single typed event stream and burn the rest.",
      },
      {
        q: "Tell me about a tiering decision you actually owned.",
        a:
          "At Replit I moved us off seat-based to consumption with a small monthly floor. " +
          "Bookings dropped one quarter then doubled the next. Took heat for two months. " +
          "Wouldn't change it.",
      },
      {
        q: "Why now? Why Anthropic specifically?",
        a:
          "I'm done with feature-grid PM work. I want a roadmap that ships against safety " +
          "evals and a research org I have to earn the trust of. Anthropic's the only " +
          "place where that's the actual job.",
      },
    ],
    consent: "Maya consented to share this profile with Anthropic only.",
  },
  {
    id: "pp-daniel-park",
    name: "Daniel Park",
    initials: "DP",
    tone: "slate",
    headline: "Staff SWE · Inference / GPU",
    role: "Staff Software Engineer, Inference",
    pass: "Pass",
    passedMin: 64,
    score: 87,
  },
  {
    id: "pp-priya-shah",
    name: "Priya Shah",
    initials: "PS",
    tone: "warm",
    headline: "Principal Designer · AI surfaces",
    role: "Principal Product Designer, AI",
    pass: "Strong pass",
    passedMin: 180,
    score: 94,
  },
  {
    id: "pp-jordan-reyes",
    name: "Jordan Reyes",
    initials: "JR",
    tone: "moss",
    headline: "GTM · stablecoin · 9y",
    role: "GTM Lead, Stablecoin",
    pass: "Pass with reservations",
    passedMin: 320,
    score: 76,
  },
  {
    id: "pp-lin-wei",
    name: "Lin Wei",
    initials: "LW",
    tone: "slate",
    headline: "Editor-core SWE · ex-VSCode",
    role: "Senior Engineer, Editor Core",
    pass: "Pass",
    passedMin: 1180,
    score: 84,
  },
]

function formatPassedAgo(min: number): string {
  if (min < 60) return `${min}m`
  if (min < 60 * 24) return `${Math.round(min / 60)}h`
  return `${Math.round(min / (60 * 24))}d`
}

// ────────────────────────────────────────────────────────────────────────────
// EmployerShell — small variant of CandidateShell for /employers/*.
// Injects CANDIDATE_STYLES so .wk-btn / .wk-container / .wk-eyebrow /
// .wk-pulsedot all work; layers .wk-shell--emp class so the page-level
// header tweak from wekruit-pages.css applies.
// ────────────────────────────────────────────────────────────────────────────

function EmployerShell({ children, signedIn = false }: { children: ReactNode; signedIn?: boolean }) {
  return (
    <div className={`wk-shell wk-shell--emp${signedIn ? " wk-shell--emp-app" : ""}`}>
      <style>{CANDIDATE_STYLES}</style>
      <header className="wk-header wk-header--emp">
        <div className="wk-header__inner">
          <Link to="/employers" className="wk-header__brand" aria-label="WeKruit Employers">
            <WekruitLogo size={22} />
          </Link>
          {signedIn ? null : <AudienceToggle />}
          <nav className="wk-nav" aria-label="Employer navigation">
            <Link to="/employers" className="wk-nav__link">How it works</Link>
            <Link to="/employers/inbox" className="wk-nav__link">Inbox preview</Link>
          </nav>
          <div className="wk-header__cta">
            {signedIn ? (
              <button className="wk-appbar__user" type="button" aria-label="Account">
                <Avatar name="Anthropic Hiring" size={32} tone="slate" />
              </button>
            ) : (
              <>
                <Link to="/employer" className="wk-header__signin">Sign in</Link>
                <Link to="/employer" className="wk-btn wk-btn--ink wk-btn--sm">
                  Send us a role
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="wk-main">{children}</main>
      {!signedIn ? (
        <footer className="wk-footer">
          <div className="wk-footer__inner">
            <div className="wk-footer__brand">
              <WekruitLogo size={20} />
              <span className="wk-footer__tag">Passed-profile-only hiring marketplace.</span>
            </div>
            <nav className="wk-footer__nav">
              <Link to="/">For candidates</Link>
              <Link to="/legal">Privacy</Link>
              <Link to="/legal">Terms</Link>
              <a href="mailto:hello@wekruit.com">hello@wekruit.com</a>
            </nav>
          </div>
        </footer>
      ) : null}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Hero animated preview — Monica @ Invoko customer-proof card. Drives the
// staged opacity reveal via a `useEffect` setTimeout chain (no IntersectionObserver
// needed — the card is above the fold). Match this with the design bundle's
// EmpPassedPreview timings.
// ────────────────────────────────────────────────────────────────────────────

function EmpPassedPreview() {
  const [t, setT] = useState(0)
  useEffect(() => {
    const timers = [
      window.setTimeout(() => setT(1), 280),
      window.setTimeout(() => setT(2), 620),
      window.setTimeout(() => setT(3), 980),
      window.setTimeout(() => setT(4), 1320),
    ]
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [])
  return (
    <div className="wk-emp-prev">
      <div className="wk-emp-prev__top">
        <Avatar name="Monica Lin" size={44} tone="warm" />
        <div className="wk-emp-prev__top-body">
          <div className="wk-emp-prev__name">Monica Lin</div>
          <div className="wk-emp-prev__role">Founder · Invoko.ai · Series A</div>
        </div>
        <span className={`wk-emp-prev__pass${t >= 1 ? " is-in" : ""}`}>
          <Icon name="check" size={12} stroke={2.4} /> 13 interviews → 8 hires
        </span>
      </div>

      <div className={`wk-emp-prev__quote${t >= 2 ? " is-in" : ""}`}>
        <span className="wk-emp-prev__qmark">&ldquo;</span>
        I never opened a résumé. 13 interviews, 8 hires, 45 days.
      </div>

      <ul className={`wk-emp-prev__steps${t >= 3 ? " is-in" : ""}`} aria-label="What Claire did">
        <li><span className="wk-emp-prev__tick"><Icon name="check" size={9} stroke={2.6} /></span>Sourced</li>
        <li><span className="wk-emp-prev__tick"><Icon name="check" size={9} stroke={2.6} /></span>Screened</li>
        <li><span className="wk-emp-prev__tick"><Icon name="check" size={9} stroke={2.6} /></span>Matched</li>
        <li><span className="wk-emp-prev__tick"><Icon name="check" size={9} stroke={2.6} /></span>Prescreened</li>
      </ul>

      <div className="wk-emp-prev__foot">
        <span className="wk-emp-prev__stamp">Claire did all of this · Monica only interviewed</span>
        <span className="wk-emp-prev__score">$13M Series A</span>
      </div>
    </div>
  )
}

function EmpPassedStack({ rows }: { rows: PassedProfile[] }) {
  return (
    <ul className="wk-emp-stack">
      {rows.map((r) => (
        <li key={r.id} className="wk-emp-stack__row">
          <Avatar name={r.name} size={36} tone={r.tone} />
          <div className="wk-emp-stack__body">
            <div className="wk-emp-stack__name">{r.name}</div>
            <div className="wk-emp-stack__meta">{r.headline}</div>
          </div>
          <span className={`wk-emp-stack__pass${r.pass === "Strong pass" ? " is-strong" : ""}`}>
            {r.pass}
          </span>
        </li>
      ))}
    </ul>
  )
}

function EmpFlowStep({
  n, title, body, mute = false,
}: { n: string; title: string; body: string; mute?: boolean }) {
  return (
    <li className={`wk-emp-flow__step${mute ? " is-mute" : ""}`}>
      <span className="wk-emp-flow__num">{n}</span>
      <div className="wk-emp-flow__body">
        <h3 className="wk-emp-flow__title">{title}</h3>
        <p className="wk-emp-flow__copy">{body}</p>
      </div>
      {mute ? (
        <span className="wk-emp-flow__hidden">
          <Icon name="lock" size={11} stroke={2} /> Behind the wall
        </span>
      ) : null}
    </li>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /employers — marketing landing
// ────────────────────────────────────────────────────────────────────────────

export default function Employers() {
  const navigate = useNavigate()
  return (
    <EmployerShell>
      {/* Hero */}
      <section className="wk-emp-hero">
        <div className="wk-container wk-emp-hero__grid">
          <div className="wk-emp-hero__copy">
            <p className="wk-eyebrow">
              <PulseDot size={7} /> For employers · passed-profile only
            </p>
            <h1 className="wk-emp-hero__h1">
              Meet candidates <em className="wk-accent">after</em> the first interview.
            </h1>
            <p className="wk-emp-hero__lede">
              Cold reach. Screen. Match. Interview. Score. <strong>Claire runs the whole funnel</strong> —
              you only review the passes and run the final interview yourself.
            </p>
            <div className="wk-emp-hero__cta">
              <button
                type="button"
                className="wk-btn wk-btn--primary wk-btn--lg"
                onClick={() => navigate("/employer")}
              >
                Send us your first role <Icon name="arrow-right" size={16} stroke={2} />
              </button>
              <Link to="/employers/inbox" className="wk-link wk-emp-hero__how">
                See a sample pass <Icon name="arrow-right" size={14} stroke={2} />
              </Link>
            </div>
            <div className="wk-emp-hero__proof">
              <span className="wk-emp-hero__metric">
                <strong>1,247</strong> candidates Claire is interviewing this week
              </span>
              <span className="wk-emp-hero__metric">
                <strong>92%</strong> of passes lead to a real intro
              </span>
            </div>
          </div>

          <div className="wk-emp-hero__visual">
            <EmpPassedPreview />
          </div>
        </div>
      </section>

      {/* Marketplace proof band */}
      <section className="wk-emp-band">
        <div className="wk-container wk-emp-band__row">
          <div className="wk-emp-band__stat">
            <span className="wk-emp-band__num">1,247</span>
            <span className="wk-emp-band__lbl">In-interview right now</span>
          </div>
          <div className="wk-emp-band__stat">
            <span className="wk-emp-band__num">≈ 6.4 hrs</span>
            <span className="wk-emp-band__lbl">From role intake to first pass</span>
          </div>
          <div className="wk-emp-band__stat">
            <span className="wk-emp-band__num">14%</span>
            <span className="wk-emp-band__lbl">Of interviewed candidates pass</span>
          </div>
          <div className="wk-emp-band__stat">
            <span className="wk-emp-band__num">86%</span>
            <span className="wk-emp-band__lbl">Pass → onsite conversion</span>
          </div>
        </div>
      </section>

      {/* The shift — pile vs inbox */}
      <section className="wk-section">
        <div className="wk-container">
          <header className="wk-section__head wk-section__head--center">
            <p className="wk-eyebrow">The shift</p>
            <h2 className="wk-section__h2">
              Trade the pile for an <em className="wk-accent">inbox</em>.
            </h2>
          </header>

          <div className="wk-emp-compare">
            <article className="wk-emp-compare__col wk-emp-compare__col--pile">
              <h3 className="wk-emp-compare__h">Without WeKruit</h3>
              <ul className="wk-emp-compare__list">
                <li><span className="wk-emp-compare__x"><Icon name="check" size={11} stroke={2.5} /></span> 400 applicants. Most never read your JD.</li>
                <li><span className="wk-emp-compare__x"><Icon name="check" size={11} stroke={2.5} /></span> Recruiter screens for hours, then hands you a list.</li>
                <li><span className="wk-emp-compare__x"><Icon name="check" size={11} stroke={2.5} /></span> Take-home goes unanswered for a week.</li>
                <li><span className="wk-emp-compare__x"><Icon name="check" size={11} stroke={2.5} /></span> One offer. Three weeks of back-channel.</li>
                <li><span className="wk-emp-compare__x"><Icon name="check" size={11} stroke={2.5} /></span> Rejected candidates ghost forever.</li>
              </ul>
            </article>

            <article className="wk-emp-compare__col wk-emp-compare__col--inbox">
              <div className="wk-emp-compare__pill">With WeKruit</div>
              <h3 className="wk-emp-compare__h">An inbox of passes</h3>
              <ul className="wk-emp-compare__list">
                <li><span className="wk-emp-compare__check"><Icon name="check" size={11} stroke={2.5} /></span> Three to five passed profiles a week — that&apos;s it.</li>
                <li><span className="wk-emp-compare__check"><Icon name="check" size={11} stroke={2.5} /></span> Each one has a transcript and Claire&apos;s verdict.</li>
                <li><span className="wk-emp-compare__check"><Icon name="check" size={11} stroke={2.5} /></span> Match evidence is cited. Risks are not hidden.</li>
                <li><span className="wk-emp-compare__check"><Icon name="check" size={11} stroke={2.5} /></span> First intro lands on your calendar in 48 hrs.</li>
                <li><span className="wk-emp-compare__check"><Icon name="check" size={11} stroke={2.5} /></span> NOT_PASS stays in the pool for the next role.</li>
              </ul>
            </article>
          </div>
        </div>
      </section>

      {/* Sequence: 4-card elegant "what we do" */}
      <EmployerSequence />

      {/* How it works — 5-step flow */}
      <section className="wk-section" id="how">
        <div className="wk-container">
          <header className="wk-section__head">
            <p className="wk-eyebrow">From role intake to passed profile</p>
            <h2 className="wk-section__h2">
              Five steps. <em className="wk-accent">You</em> never see step three.
            </h2>
          </header>
          <ol className="wk-emp-flow">
            <EmpFlowStep
              n="01" title="Role enters WeKruit"
              body="Send Claire the JD or just the role title. We resolve the rest from your team, stack, and stage."
            />
            <EmpFlowStep
              n="02" title="We enrich the brief"
              body="Level, must-haves, nice-to-haves, comp band, visa stance, deal-breakers. You approve once."
            />
            <EmpFlowStep
              n="03" title="Claire matches existing candidates"
              body="Pulled from the WeKruit pool — people Claire's already interviewed for adjacent roles."
              mute
            />
            <EmpFlowStep
              n="04" title="Claire interviews on iMessage"
              body="Real conversations, on the candidate's schedule. Structured questions, free-form follow-ups."
              mute
            />
            <EmpFlowStep
              n="05" title="You see only passed profiles"
              body="Summary, pass reason, evidence, risks, fit, transcript. Decline, schedule, or ask Claire to dig deeper."
            />
          </ol>
          <p className="wk-emp-flow__note">
            <PulseDot size={6} /> Steps 03 &amp; 04 happen behind a wall. Candidates never know who you are until you accept the intro.
          </p>
        </div>
      </section>

      {/* Trust band */}
      <section className="wk-section wk-section--trust">
        <div className="wk-container">
          <header className="wk-section__head wk-section__head--center">
            <p className="wk-eyebrow">Built for high-trust hiring</p>
            <h2 className="wk-section__h2">
              Evidence, not vibes. <em className="wk-accent">Privacy</em>, not surveillance.
            </h2>
          </header>

          <div className="wk-emp-trust">
            <article className="wk-emp-trust__card">
              <span className="wk-emp-trust__ico" aria-hidden="true">
                <Icon name="bolt" size={18} stroke={1.6} />
              </span>
              <h3>Auditable interviews</h3>
              <p>
                Every pass ships with the transcript, structured rubric answers, and Claire&apos;s reasoning.
                Argue with her if you disagree — she&apos;ll re-interview.
              </p>
            </article>
            <article className="wk-emp-trust__card">
              <span className="wk-emp-trust__ico" aria-hidden="true">
                <Icon name="lock" size={18} stroke={1.6} />
              </span>
              <h3>Privacy by default</h3>
              <p>
                Candidates are anonymous until they pass <em>and</em> consent. We never expose a CV to an
                employer who hasn&apos;t been approved for it.
              </p>
            </article>
            <article className="wk-emp-trust__card">
              <span className="wk-emp-trust__ico" aria-hidden="true">
                <Icon name="sparkle" size={18} stroke={1.6} />
              </span>
              <h3>NOT_PASS is retained</h3>
              <p>
                The candidates who don&apos;t fit this role stay with Claire for the next one. We don&apos;t burn
                people on a bad match; we wait for a real one.
              </p>
            </article>
          </div>
        </div>
      </section>

      {/* Peek — stack teaser */}
      <section className="wk-section wk-section--peek">
        <div className="wk-container wk-emp-peek">
          <div className="wk-emp-peek__copy">
            <p className="wk-eyebrow">A pass, opened up</p>
            <h2 className="wk-section__h2">
              Less applicant noise. <em className="wk-accent">More</em> first interviews worth taking.
            </h2>
            <p className="wk-emp-peek__sub">
              Open one of Maya&apos;s pass — the full record Claire shipped to Anthropic after a 38-minute iMessage interview.
              Summary, pass reason, evidence, risks, comp fit, transcript excerpts. Decide in five minutes.
            </p>
            <button
              type="button"
              className="wk-btn wk-btn--primary wk-btn--lg"
              onClick={() => navigate("/employers/inbox")}
            >
              Open the inbox <Icon name="arrow-right" size={16} stroke={2} />
            </button>
          </div>
          <div className="wk-emp-peek__visual">
            <EmpPassedStack rows={EMP_PASSED.slice(0, 4)} />
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="wk-section wk-section--trust">
        <div className="wk-container">
          <div className="wk-final-cta">
            <h3 className="wk-final-cta__h">
              Stop sorting résumés. <em className="wk-accent">Just run the interview.</em>
            </h3>
            <div className="wk-emp-final__row">
              <button
                type="button"
                className="wk-btn wk-btn--primary wk-btn--lg"
                onClick={() => navigate("/employer")}
              >
                Get your first 3 passes <Icon name="arrow-right" size={16} stroke={2} />
              </button>
              <a
                href="mailto:hello@wekruit.com?subject=Book%20a%2015-min%20call"
                className="wk-btn wk-btn--secondary wk-btn--lg"
              >
                Book a 15-min call
              </a>
            </div>
            <p className="wk-final-cta__fine">
              Free trial. We invoice only on signed offers. No retainers, no exclusivity.
            </p>
          </div>
        </div>
      </section>
    </EmployerShell>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// /employers/inbox — passed profile detail preview
// ────────────────────────────────────────────────────────────────────────────

export function EmployersInbox() {
  const [activeId, setActiveId] = useState(EMP_PASSED[0].id)
  const active = EMP_PASSED.find((p) => p.id === activeId) ?? EMP_PASSED[0]
  return (
    <EmployerShell signedIn>
      <div className="wk-emp-inbox">
        <div className="wk-emp-inbox__bar">
          <div className="wk-container wk-emp-inbox__bar-inner">
            <div>
              <p className="wk-eyebrow"><PulseDot size={6} /> Inbox · Anthropic · Senior PM, Claude APIs</p>
              <h1 className="wk-emp-inbox__h1">
                <em className="wk-accent">5</em> passes this week.
              </h1>
            </div>
            <div className="wk-emp-inbox__hint">
              <Icon name="lock" size={13} stroke={1.8} />
              <span>Showing only candidates Claire has passed and who have consented to share with you.</span>
            </div>
          </div>
        </div>

        <div className="wk-container wk-emp-inbox__grid">
          <aside className="wk-emp-inbox__list">
            <header className="wk-emp-inbox__list-head">
              <span className="wk-eyebrow">Passes</span>
              <span className="wk-emp-inbox__list-count">5 new</span>
            </header>
            <ul className="wk-emp-inbox__rows">
              {EMP_PASSED.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`wk-emp-row${p.id === activeId ? " is-active" : ""}`}
                    onClick={() => setActiveId(p.id)}
                  >
                    <Avatar name={p.name} size={36} tone={p.tone} />
                    <div className="wk-emp-row__body">
                      <div className="wk-emp-row__top">
                        <span className="wk-emp-row__name">{p.name}</span>
                        <span className="wk-emp-row__time">{formatPassedAgo(p.passedMin)}</span>
                      </div>
                      <div className="wk-emp-row__meta">{p.headline}</div>
                      <div className="wk-emp-row__chips">
                        <span className={`wk-emp-row__pass${p.pass === "Strong pass" ? " is-strong" : ""}`}>
                          {p.pass}
                        </span>
                        <span className="wk-emp-row__score">Match {p.score}</span>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="wk-emp-inbox__pool">
              <Icon name="sparkle" size={14} stroke={1.6} />
              <div>
                <strong>14 more candidates</strong> are mid-interview with Claire for this role.
                <br />
                <span>You&apos;ll see them here when they pass.</span>
              </div>
            </div>
          </aside>

          <section className="wk-emp-detail">
            {active.summary ? <EmpPassedDetail c={active} /> : <EmpPassedDetailLite c={active} />}
          </section>
        </div>
      </div>
    </EmployerShell>
  )
}

function EmpPassedDetail({ c }: { c: PassedProfile }) {
  return (
    <article className="wk-emp-pp">
      <header className="wk-emp-pp__head">
        <Avatar name={c.name} size={72} tone={c.tone} />
        <div className="wk-emp-pp__head-body">
          <p className="wk-eyebrow">Passed by Claire · {formatPassedAgo(c.passedMin)} ago</p>
          <h2 className="wk-emp-pp__name">{c.name}</h2>
          <p className="wk-emp-pp__meta">{c.headline} · for <strong>{c.role}</strong></p>
        </div>
        <div className="wk-emp-pp__head-side">
          <span className={`wk-emp-pp__pass${c.pass === "Strong pass" ? " is-strong" : ""}`}>
            <Icon name="check" size={12} stroke={2.4} /> {c.pass}
          </span>
          <span className="wk-emp-pp__score">Match {c.score}</span>
        </div>
      </header>

      <div className="wk-emp-pp__actions">
        <button type="button" className="wk-btn wk-btn--primary">
          <Icon name="calendar" size={14} stroke={2} /> Schedule intro
        </button>
        <button type="button" className="wk-btn wk-btn--secondary">Decline with note</button>
        <button type="button" className="wk-btn wk-btn--ghost">Ask Claire to dig deeper</button>
        <span className="wk-emp-pp__exp">
          <Icon name="clock" size={12} stroke={2} /> Consent expires in 5d
        </span>
      </div>

      <section className="wk-emp-pp__sec">
        <h3 className="wk-emp-pp__h">Summary</h3>
        <p className="wk-emp-pp__sum">{c.summary}</p>
      </section>

      <section className="wk-emp-pp__sec">
        <h3 className="wk-emp-pp__h">Why Claire passed her</h3>
        <div className="wk-emp-pp__verdict">
          <div className="wk-emp-pp__verdict-by">
            <Avatar name="Claire" size={28} tone="warm" />
            <span><strong>Claire</strong> · WeKruit recruiter</span>
          </div>
          <p>{c.passReason}</p>
        </div>
      </section>

      <section className="wk-emp-pp__sec">
        <h3 className="wk-emp-pp__h">Match evidence</h3>
        <p className="wk-emp-pp__hint">Five tags Claire is confident on. Each one cites the source.</p>
        <ul className="wk-emp-pp__evidence">
          {c.evidence!.map((e) => (
            <li key={e.tag} className="wk-emp-pp__ev">
              <span className="wk-emp-pp__ev-tag">{e.tag}</span>
              <span className="wk-emp-pp__ev-src">{e.source}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="wk-emp-pp__sec wk-emp-pp__split">
        <div>
          <h3 className="wk-emp-pp__h">Requirements met</h3>
          <ul className="wk-emp-pp__req">
            {c.requirementsMet!.map((r) => (
              <li key={r}>
                <span className="wk-emp-pp__check">
                  <Icon name="check" size={10} stroke={2.6} />
                </span>
                {r}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="wk-emp-pp__h">Open risks</h3>
          <ul className="wk-emp-pp__risk">
            {c.risks!.map((r) => (
              <li key={r}>
                <span className="wk-emp-pp__warn">!</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="wk-emp-pp__sec">
        <h3 className="wk-emp-pp__h">Comp / visa / location fit</h3>
        <dl className="wk-emp-pp__fit">
          <div>
            <dt>Comp asked</dt>
            <dd>{c.fit!.compAsked}</dd>
            <span className="wk-emp-pp__fit-note">Inside your band ({c.fit!.compRange})</span>
          </div>
          <div>
            <dt>Visa</dt>
            <dd>{c.fit!.visa}</dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd>{c.fit!.location}</dd>
          </div>
          <div>
            <dt>Earliest start</dt>
            <dd>{c.fit!.start}</dd>
          </div>
        </dl>
      </section>

      <section className="wk-emp-pp__sec">
        <div className="wk-emp-pp__h-row">
          <h3 className="wk-emp-pp__h">Transcript excerpts</h3>
          <a href="#full-transcript" onClick={(e) => e.preventDefault()} className="wk-link wk-emp-pp__full">
            Open full transcript (38 min)
          </a>
        </div>
        <ol className="wk-emp-pp__transcript">
          {c.transcript!.map((t, i) => (
            <li key={i} className="wk-emp-pp__tx">
              <div className="wk-emp-pp__tx-q">
                <span className="wk-emp-pp__tx-by">Claire</span>
                <p>{t.q}</p>
              </div>
              <div className="wk-emp-pp__tx-a">
                <span className="wk-emp-pp__tx-by">{c.name.split(" ")[0]}</span>
                <p>{t.a}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="wk-emp-pp__consent">
        <Icon name="lock" size={13} stroke={1.8} />
        <span>{c.consent}</span>
      </footer>
    </article>
  )
}

function EmpPassedDetailLite({ c }: { c: PassedProfile }) {
  return (
    <article className="wk-emp-pp wk-emp-pp--lite">
      <header className="wk-emp-pp__head">
        <Avatar name={c.name} size={72} tone={c.tone} />
        <div className="wk-emp-pp__head-body">
          <p className="wk-eyebrow">Passed · {formatPassedAgo(c.passedMin)} ago</p>
          <h2 className="wk-emp-pp__name">{c.name}</h2>
          <p className="wk-emp-pp__meta">{c.headline} · for <strong>{c.role}</strong></p>
        </div>
        <div className="wk-emp-pp__head-side">
          <span className={`wk-emp-pp__pass${c.pass === "Strong pass" ? " is-strong" : ""}`}>
            <Icon name="check" size={12} stroke={2.4} /> {c.pass}
          </span>
          <span className="wk-emp-pp__score">Match {c.score}</span>
        </div>
      </header>
      <section className="wk-emp-pp__sec wk-emp-pp__lite-body">
        <p className="wk-emp-pp__lite-msg">
          We mocked one passed profile end-to-end. Click <strong>Maya Okafor</strong> in the rail to see the
          full operational view — summary, pass reason, evidence, risks, fit, and transcript excerpts.
        </p>
      </section>
    </article>
  )
}
