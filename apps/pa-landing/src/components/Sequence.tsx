/**
 * Sequence.tsx — the elegant 4-card "what we do" sequence (Standout-inspired)
 * ported from the 2026-05-26 Claude Design handoff bundle.
 *
 * Two surfaces share the same SequenceCard frame:
 *   • <CandidateSequence /> — Claire works for the candidate (/ — Landing)
 *   • <EmployerSequence />  — WeKruit ships passed profiles (/employers)
 *
 * Each card is: [eyebrow] → [serif headline with inline verb pill] → [sub]
 * stacked over a tall artifact stage (peach radial halo + dot grid).
 *
 * Also exports <AudienceToggle /> — the candidates/companies switcher that
 * lives in the header on both surfaces.
 *
 * Styles ship in src/styles/wekruit-pages.css (imported by main.tsx) under
 * the .seq-* / .wk-aud-* prefixes.
 */
import { Link } from "react-router-dom"
import { PulseDot } from "../pages/CandidateLogin.js"
export { AudienceToggle } from "./AudienceToggle.js"

// ────────────────────────────────────────────────────────────────────────────
// SeqGlyph — tiny 14px inline SVG icon set used by the headline verb pill.
// Note: sequence.css hides svg via `.seq-verb svg { display: none }` — the
// glyph is kept in the DOM for semantic markup only, the highlight comes from
// the background gradient on the text.
// ────────────────────────────────────────────────────────────────────────────

type GlyphName = "doc" | "message" | "bolt" | "calendar" | "search" | "check" | "filter" | "user"

function SeqGlyph({ name }: { name: GlyphName }) {
  const cp = {
    width: 14, height: 14, viewBox: "0 0 16 16", fill: "none",
    stroke: "currentColor", strokeWidth: 1.6,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
  }
  switch (name) {
    case "doc":
      return (
        <svg {...cp}>
          <path d="M4 2.5h5.5L12 5v8.5H4z" />
          <path d="M9.5 2.5V5H12" />
          <path d="M6 8h4M6 10.5h3" />
        </svg>
      )
    case "message":
      return (
        <svg {...cp}>
          <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.5V11.5h-.5a2 2 0 0 1-2-2z" />
          <path d="M5.5 6.5h5M5.5 8.5h3" />
        </svg>
      )
    case "bolt":
      return <svg {...cp}><path d="M9 1.5L3.5 9h4l-1 5.5L13 7h-4z" /></svg>
    case "calendar":
      return (
        <svg {...cp}>
          <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
          <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
        </svg>
      )
    case "search":
      return (
        <svg {...cp}>
          <circle cx="7" cy="7" r="4" />
          <path d="M10 10l3.5 3.5" />
        </svg>
      )
    case "check":
      return <svg {...cp}><path d="M3 8.5l3 3 7-7" /></svg>
    case "filter":
      return <svg {...cp}><path d="M2.5 3h11l-4 5v5l-3-1V8z" /></svg>
    case "user":
      return (
        <svg {...cp}>
          <circle cx="8" cy="6" r="2.5" />
          <path d="M3 13.5c.8-2.5 3-3.5 5-3.5s4.2 1 5 3.5" />
        </svg>
      )
    default:
      return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SequenceCard — the shared 4-card frame. `verbIcon` + `verbText` become the
// inline italic-on-peach highlight inside the serif headline.
// ────────────────────────────────────────────────────────────────────────────

function SequenceCard({
  eyebrow, before, verbIcon, verbText, after, sub, children,
}: {
  eyebrow: string
  before: string
  verbIcon: GlyphName
  verbText: string
  after: string
  sub: string
  children: React.ReactNode
}) {
  return (
    <article className="seq-card">
      <div className="seq-card__art">
        <div className="seq-card__art-dots" aria-hidden="true" />
        <div className="seq-card__art-halo" aria-hidden="true" />
        <div className="seq-card__art-stage">{children}</div>
      </div>
      <div className="seq-card__body">
        <p className="seq-card__eyebrow">{eyebrow}</p>
        <h3 className="seq-card__headline">
          {before}{" "}
          <span className="seq-verb">
            <SeqGlyph name={verbIcon} />
            <span className="seq-verb__text">{verbText}</span>
          </span>{" "}
          {after}
        </h3>
        <p className="seq-card__sub">{sub}</p>
      </div>
    </article>
  )
}

function ArtifactStack() {
  return (
    <div className="seq-stack" aria-hidden="true">
      <span className="seq-stack__layer seq-stack__layer--3" />
      <span className="seq-stack__layer seq-stack__layer--2" />
      <span className="seq-stack__layer seq-stack__layer--1" />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Candidate artifacts — 4 scenes for /
// ────────────────────────────────────────────────────────────────────────────

function ArtCandReads() {
  return (
    <>
      <ArtifactStack />
      <div className="seq-resume" role="presentation">
        <header className="seq-resume__head">
          <span className="seq-resume__ava">M</span>
          <div>
            <div className="seq-resume__name">Sample candidate</div>
            <div className="seq-resume__role">Senior Product Manager</div>
          </div>
        </header>
        <div className="seq-resume__lines">
          <span className="seq-resume__l w85" />
          <span className="seq-resume__l w70" />
          <span className="seq-resume__l w90" />
          <span className="seq-resume__l w55" />
          <span className="seq-resume__l w80" />
        </div>
        <div className="seq-resume__scan" aria-hidden="true" />
      </div>
      <span className="seq-chip seq-chip--tl">Senior PM</span>
      <span className="seq-chip seq-chip--tr">AI infra</span>
      <span className="seq-chip seq-chip--br">$220k+ · SF</span>
    </>
  )
}

function ArtCandPrescreens() {
  return (
    <div className="seq-imsg" role="presentation">
      <div className="seq-imsg__msg seq-imsg__msg--in">What roles excite you most right now?</div>
      <div className="seq-imsg__msg seq-imsg__msg--out">AI infra. APIs, not features.</div>
      <div className="seq-imsg__msg seq-imsg__msg--in">Comp floor? Visa?</div>
      <div className="seq-imsg__typing" aria-hidden="true">
        <span /><span /><span />
      </div>
      <span className="seq-pill seq-pill--auto">Claire · iMessage</span>
    </div>
  )
}

function ArtCandSkips() {
  const rows = [
    { co: "Payments platform", role: "Sr PM, billing", state: "skip", why: "comp below floor", tone: "ink" },
    { co: "AI infra platform", role: "Sr PM, developer APIs", state: "match", why: "clear evidence · surfaced", tone: "warm" },
    { co: "Data warehouse", role: "Staff PM, analytics", state: "skip", why: "not your domain", tone: "moss" },
    { co: "Productivity suite", role: "Sr PM, editor", state: "skip", why: "not a step up", tone: "slate" },
    { co: "Developer platform", role: "Sr PM, infra", state: "match", why: "role brief fit · surfaced", tone: "ink" },
  ] as const
  return (
    <div className="seq-feed" role="presentation">
      <header className="seq-feed__head">
        <span className="seq-feed__title">Sample feed · Claire</span>
        <span className="seq-feed__time">Preview</span>
      </header>
      <ul className="seq-feed__rows">
        {rows.map((r, i) => (
          <li key={i} className={`seq-feed__row seq-feed__row--${r.state}`}>
            <span className={`seq-feed__co seq-feed__co--${r.tone}`}>{r.co[0]}</span>
            <div className="seq-feed__body">
              <div className="seq-feed__role">
                <span className="seq-feed__role-co">{r.co}</span>{" "}
                <span className="seq-feed__role-sep">·</span> {r.role}
              </div>
              <div className="seq-feed__why">{r.why}</div>
            </div>
            <span className={`seq-feed__tag seq-feed__tag--${r.state}`}>
              {r.state === "skip" ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2 5l2 2 4-4" />
                </svg>
              )}
            </span>
          </li>
        ))}
      </ul>
      <footer className="seq-feed__foot">
        <span><strong>Most</strong> skipped</span>
        <span className="seq-feed__foot-sep" />
        <span><strong>Only clear fits</strong> surfaced</span>
      </footer>
    </div>
  )
}

function ArtCandInterview() {
  return (
    <div className="seq-cal" role="presentation">
      <div className="seq-cal__strip" aria-hidden="true">
        {["MON", "TUE", "WED", "THU", "FRI"].map((d, i) => (
          <span key={d} className={`seq-cal__day${i === 1 ? " is-picked" : ""}`}>
            <em>{d}</em>
            <strong>{12 + i}</strong>
          </span>
        ))}
      </div>
      <div className="seq-cal__slot">
        <div className="seq-cal__slot-time">
          <span className="seq-cal__hh">PASS<em>ED</em></span>
          <span className="seq-cal__dur">Claire interview · evidence ready</span>
        </div>
        <div className="seq-cal__slot-with">
          <span className="seq-cal__ava">S</span>
          <div>
            <strong>Sample candidate</strong>
            <span>Profile, transcript, and risks prepared</span>
          </div>
        </div>
      </div>
      <span className="seq-pill seq-pill--ok">
        <SeqGlyph name="check" />
        Passed profile
      </span>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Employer artifacts — 4 scenes for /employers
// ────────────────────────────────────────────────────────────────────────────

function ArtEmpHears() {
  return (
    <>
      <ArtifactStack />
      <div className="seq-brief" role="presentation">
        <header className="seq-brief__head">
          <span className="seq-brief__co">S</span>
          <span className="seq-brief__head-text">Sr PM · sample role</span>
        </header>
        <section className="seq-brief__section">
          <span className="seq-brief__label">On paper</span>
          <div className="seq-brief__chips">
            <span className="seq-brief__chip">5+y PM</span>
            <span className="seq-brief__chip">SF · 3d/wk</span>
            <span className="seq-brief__chip">$220–290k</span>
          </div>
        </section>
        <section className="seq-brief__section">
          <span className="seq-brief__label seq-brief__label--deep">What you actually need</span>
          <div className="seq-brief__chips">
            <span className="seq-brief__chip seq-brief__chip--trait">ships under ambiguity</span>
            <span className="seq-brief__chip seq-brief__chip--trait">owns the P&amp;L</span>
            <span className="seq-brief__chip seq-brief__chip--trait">founder-mode</span>
          </div>
        </section>
      </div>
    </>
  )
}

function ArtEmpLooks() {
  return (
    <div className="seq-reveal" role="presentation">
      <article className="seq-reveal__paper">
        <header className="seq-reveal__paper-head">
          <span className="seq-reveal__paper-ava">S</span>
          <div>
            <div className="seq-reveal__paper-name">Sample candidate</div>
            <div className="seq-reveal__paper-meta">Senior PM · platform product · 7y</div>
          </div>
        </header>
        <div className="seq-reveal__paper-body">
          <span className="seq-reveal__redact w95" />
          <span className="seq-reveal__redact w70" />
          <span className="seq-reveal__redact w85" />
          <span className="seq-reveal__redact w55" />
        </div>
        <span className="seq-reveal__paper-label">surface</span>
      </article>
      <div className="seq-reveal__bridge" aria-hidden="true">
        <span className="seq-reveal__bridge-line" />
        <span className="seq-reveal__bridge-arrow">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7h8M8 4l3 3-3 3" />
          </svg>
        </span>
      </div>
      <article className="seq-reveal__transcript">
        <span className="seq-reveal__t-by">Interview · Q9</span>
        <p className="seq-reveal__t-quote">
          &ldquo;I rebuilt our entire pricing model. Founder said no. I shipped it anyway.
          He thanked me six months later.&rdquo;
        </p>
        <span className="seq-reveal__t-tag">Owns risk ✓</span>
      </article>
    </div>
  )
}

function ArtEmpAtScale() {
  const screeningPlan = [
    { init: "RB", name: "Role brief approved", role: "Must-haves, comp, location, deal-breakers", tone: "warm" },
    { init: "EP", name: "Evidence probes", role: "Questions tied to founder-mode and API depth", tone: "slate" },
    { init: "RF", name: "Risk follow-ups", role: "Scope mismatch, timing, competing loops", tone: "moss" },
    { init: "CG", name: "Consent gate", role: "Employer sees the pass only after share consent", tone: "warm" },
  ] as const
  return (
    <div className="seq-live" role="presentation">
      <header className="seq-live__head">
        <span className="seq-live__pulse" aria-hidden="true" />
        <span className="seq-live__hgroup">
          <strong>Role brief approved</strong>
          <span>Claire screens against the evidence plan</span>
        </span>
        <span className="seq-live__queued">Sample plan</span>
      </header>
      <ul className="seq-live__rows">
        {screeningPlan.map((r, i) => (
          <li key={i} className="seq-live__row">
            <span className={`seq-live__ava seq-live__ava--${r.tone}`}>{r.init}</span>
            <div className="seq-live__body">
              <div className="seq-live__row-top">
                <span className="seq-live__name">{r.name}</span>
                <span className="seq-live__status">Ready</span>
              </div>
              <div className="seq-live__role">{r.role}</div>
              <span className="seq-live__bar" aria-hidden="true" />
            </div>
            <span className="seq-live__done" aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5l2 2 4-4" />
              </svg>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ArtEmpDelivers() {
  return (
    <div className="seq-pp" role="presentation">
      <article className="seq-pp__card seq-pp__card--3">
        <span className="seq-pp__ava">SD</span>
        <div className="seq-pp__body">
          <div className="seq-pp__name">Sample designer</div>
          <div className="seq-pp__meta">Principal Designer · AI surfaces</div>
        </div>
      </article>
      <article className="seq-pp__card seq-pp__card--2">
        <span className="seq-pp__ava">SE</span>
        <div className="seq-pp__body">
          <div className="seq-pp__name">Sample engineer</div>
          <div className="seq-pp__meta">Staff SWE · Inference / GPU</div>
        </div>
      </article>
      <article className="seq-pp__card seq-pp__card--1 is-focused">
        <header className="seq-pp__head">
          <span className="seq-pp__ava-lg">SC</span>
          <div>
            <div className="seq-pp__name">Sample candidate</div>
            <div className="seq-pp__meta">Senior PM · AI infra · 7y</div>
          </div>
          <span className="seq-pill seq-pill--ok">
            <SeqGlyph name="check" />
            Strong pass
          </span>
        </header>
        <div className="seq-pp__row">
          <span className="seq-pp__chip">$240k asked · in band</span>
          <span className="seq-pp__chip">SF · 3d/wk OK</span>
          <span className="seq-pp__evidence">Evidence ready</span>
        </div>
        <div className="seq-pp__quote">
          &ldquo;I&apos;m done with feature-grid PM. I want a roadmap that ships against safety evals.&rdquo;
        </div>
      </article>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Public exports — drop these into pages.
// ────────────────────────────────────────────────────────────────────────────

export function CandidateSequence() {
  return (
    <section className="seq" aria-label="What Claire does for you">
      <div className="wk-container">
        <header className="seq__head">
          <p className="wk-eyebrow seq__eyebrow">
            <PulseDot size={7} /> Claire-first interviews
          </p>
          <h2 className="seq__h2">
            Less noise. <em className="wk-accent">Better evidence.</em>
          </h2>
          <p className="seq__sub">
            You don&apos;t apply, you don&apos;t chase job boards, and you don&apos;t get spammed.
            Claire reads what you want, skips the 99% that don&apos;t fit, and starts
            the first interview when a role matches. If you pass, WeKruit sends
            the hiring team your profile, transcript, and evidence.
          </p>
        </header>
        <div className="seq__grid">
          <SequenceCard
            eyebrow="01 · Reads"
            before="Claire"
            verbIcon="doc"
            verbText="reads"
            after="who you actually are."
            sub="Five concrete signals from your résumé — role, scope, comp floor, visa, geography. Confirmed, not crawled."
          >
            <ArtCandReads />
          </SequenceCard>

          <SequenceCard
            eyebrow="02 · Asks"
            before="Then she"
            verbIcon="message"
            verbText="asks"
            after="what's not on paper."
            sub="A 4–7 minute conversation on iMessage. What you actually want next — depth, comp floor, deal-breakers, timing."
          >
            <ArtCandPrescreens />
          </SequenceCard>

          <SequenceCard
            eyebrow="03 · Skips"
            before="And"
            verbIcon="filter"
            verbText="skips"
            after="the 99% you'd never take."
            sub="Most jobs aren't yours. Claire reads the boards, the private listings, and the not-yet-posted — and surfaces only the few you'd actually open."
          >
            <ArtCandSkips />
          </SequenceCard>

          <SequenceCard
            eyebrow="04 · Sends"
            before="Until one fits — and she"
            verbIcon="check"
            verbText="sends"
            after="your passed profile."
            sub="First step: Claire's role interview in iMessage. If you pass, WeKruit sends the profile, transcript, and evidence to the hiring team."
          >
            <ArtCandInterview />
          </SequenceCard>
        </div>
      </div>
    </section>
  )
}

export function EmployerSequence() {
  return (
    <section className="seq seq--emp" aria-label="Why startup hiring is hard, and how we fix it">
      <div className="wk-container">
        <header className="seq__head">
          <p className="wk-eyebrow seq__eyebrow">
            <PulseDot size={7} /> Why startup hiring is hard
          </p>
          <h2 className="seq__h2">
            The signal you need <em className="wk-accent">isn't on the résumé.</em>
          </h2>
          <p className="seq__sub">
            Startup hiring needs traits a CV will never show — founder-mode operating,
            real shipping under ambiguity, the ability to own a P&amp;L decision and
            walk out when it&apos;s wrong. The only way to surface those is a real
            conversation. We run them at scale, so you only meet the people who actually have it.
          </p>
        </header>
        <div className="seq__grid">
          <SequenceCard
            eyebrow="01 · Hears"
            before="We"
            verbIcon="filter"
            verbText="hear"
            after="the brief that's not on the JD."
            sub="Beyond the must-haves — scrappy operating, ownership under risk, founder-mode thinking. We absorb what your hiring manager actually means."
          >
            <ArtEmpHears />
          </SequenceCard>

          <SequenceCard
            eyebrow="02 · Looks"
            before="Then we"
            verbIcon="search"
            verbText="look"
            after="past the résumé."
            sub="A CV is a surface. The real signal is how they think, what they shipped, why they left — extracted in conversation, not crawled from LinkedIn."
          >
            <ArtEmpLooks />
          </SequenceCard>

          <SequenceCard
            eyebrow="03 · Interviews"
            before="Claire"
            verbIcon="message"
            verbText="interviews"
            after="against the role brief."
            sub="Structured conversations, follow-up questions, and scored evidence for the traits your company actually needs."
          >
            <ArtEmpAtScale />
          </SequenceCard>

          <SequenceCard
            eyebrow="04 · Sends"
            before="You only see the"
            verbIcon="check"
            verbText="few"
            after="who actually passed."
            sub="Each pass includes summary, pass reason, evidence, risks, and the transcript that made Claire call it."
          >
            <ArtEmpDelivers />
          </SequenceCard>
        </div>
      </div>
    </section>
  )
}

// Linked icon — kept here for callers that want to render a "skip to employers"
// CTA from inside the candidate sequence without pulling in CandidateLogin.
// Currently unused; exported in case Landing.tsx wants to embed inline.
export function EmployersCTA() {
  return (
    <Link to="/employers" className="wk-link">
      See the employer view →
    </Link>
  )
}
