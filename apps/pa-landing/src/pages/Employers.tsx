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
// Sample preview data — one fully-fleshed generic passed profile plus
// 4 stubs. Once the employer dashboard connects to live PASS events from
// PreScreenPipeline, replace this with a Firestore query against
// pass-snapshots/{employerId}/{jobId}.
// ────────────────────────────────────────────────────────────────────────────

type PassedProfile = {
  id: string
  name: string
  initials: string
  tone: "warm" | "moss" | "slate"
  headline: string
  role: string
  pass: "Strong pass" | "Pass" | "Pass with reservations"
  reviewBadge: "Evidence ready" | "Risk noted" | "Sample pass record"
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

type InboxRolePacket = {
  role: string
  scope: string
  hardFilters: string
  mustHaves: string
  evidenceProbes: string
  calibrationBar: string
  introOwner: string
}

const SAMPLE_PASS_RECORD = "Sample pass record"

const SAMPLE_INBOX_ROLE_PACKET: InboxRolePacket = {
  role: "Founder-mode product platform lead",
  scope: "Developer platform role where Claire must prove API product judgment, billing/tiering ownership, and SF hybrid fit before any pass reaches the hiring team.",
  hardFilters: "5+y product ownership, developer-facing APIs, SF hybrid availability, comp inside approved band, no sponsorship required.",
  mustHaves: "API product depth, billing/tiering ownership, SF hybrid fit, and a concrete roadmap tradeoff tied to customer evidence.",
  evidenceProbes: "Roadmap tradeoff, tiering decision, customer evidence, and what the candidate would cut from this brief.",
  calibrationBar: "Strong pass ties platform depth, customer evidence, P&L ownership, and role-specific tradeoffs together. False positive lists launches without decision ownership.",
  introOwner: "Product lead reviews the pass record and owns the next interview step within two business days.",
}

const EMP_PASSED: PassedProfile[] = [
  {
    id: "pp-sample-candidate",
    name: "Sample candidate",
    initials: "SC",
    tone: "warm",
    headline: "Senior PM · developer platform · 7y",
    role: "Developer platform lead",
    pass: "Strong pass",
    reviewBadge: "Evidence ready",
    summary:
      "Built and shipped two 0→1 developer platform products at growth-stage companies. " +
      "Owns API roadmap decisions end-to-end and has scaled a billing/tiering surface from " +
      "300M to 11B calls/month. Wants infrastructure scope, not feature work, and is ready to talk now.",
    passReason:
      "This candidate cleared every must-have on the brief: 5+y product, ships against a P&L, has shipped " +
      "developer-facing APIs at scale, and lives in SF. Their answer to the “what would you cut " +
      "from the current roadmap” question was specific and tied to the role brief. " +
      "They have one active interview elsewhere, so the hiring team should decide quickly.",
    evidence: [
      { tag: "Shipped 2 API products at scale", source: "Resume · developer platform roles" },
      { tag: "Owns roadmap + P&L", source: "Interview · Q4" },
      { tag: "Tiering / billing depth", source: "Interview · Q7" },
      { tag: "Understands the role brief", source: "Interview · Q9" },
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
      "One active interview elsewhere (loop closes Friday)",
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
        q: "What's the weakest part of this developer platform brief?",
        a:
          "The current brief asks for platform depth but doesn't separate API quality from " +
          "billing and onboarding. I'd make the first interview prove which one matters most, " +
          "then cut any roadmap item that doesn't support that wedge.",
      },
      {
        q: "Tell me about a tiering decision you actually owned.",
        a:
          "I moved a developer product off seat-based pricing to consumption with a small monthly floor. " +
          "Bookings dropped one quarter then doubled the next. Took heat for two months. " +
          "Wouldn't change it.",
      },
      {
        q: "Why now? Why this role specifically?",
        a:
          "I'm done with feature-grid PM work. I want a roadmap that ships against safety " +
          "evals and a technical org I have to earn the trust of. This brief sounds like " +
          "the actual job, not a feature backlog.",
      },
    ],
    consent: "Sample candidate consented to share this profile with this hiring team only.",
  },
  {
    id: "pp-sample-engineer",
    name: "Sample engineer",
    initials: "SE",
    tone: "slate",
    headline: "Staff SWE · Inference / GPU",
    role: "Staff Software Engineer, Inference",
    pass: "Pass",
    reviewBadge: SAMPLE_PASS_RECORD,
  },
  {
    id: "pp-sample-designer",
    name: "Sample designer",
    initials: "SD",
    tone: "warm",
    headline: "Principal Designer · AI surfaces",
    role: "Principal Product Designer, AI",
    pass: "Strong pass",
    reviewBadge: SAMPLE_PASS_RECORD,
  },
  {
    id: "pp-sample-gtm",
    name: "Sample GTM lead",
    initials: "SG",
    tone: "moss",
    headline: "GTM · stablecoin · 9y",
    role: "GTM Lead, Stablecoin",
    pass: "Pass with reservations",
    reviewBadge: "Risk noted",
  },
  {
    id: "pp-sample-systems-engineer",
    name: "Sample systems engineer",
    initials: "SS",
    tone: "slate",
    headline: "Editor-core SWE · ex-VSCode",
    role: "Senior Engineer, Editor Core",
    pass: "Pass",
    reviewBadge: SAMPLE_PASS_RECORD,
  },
]

const ROLE_PACKET_ITEMS = [
  {
    tag: "01",
    title: "Hard filters",
    body: "The constraints that must stop a pass before Claire screens: location, authorization, comp, stage, and true non-negotiables.",
  },
  {
    tag: "02",
    title: "Evidence probes",
    body: "The questions Claire should use to pull out concrete work, tradeoffs, and risk signals in the first interview.",
  },
  {
    tag: "03",
    title: "Calibration examples",
    body: "What a strong pass looks like, and what false positives should be rejected before they reach the hiring team.",
  },
  {
    tag: "04",
    title: "Feedback loop",
    body: "Where accepted or rejected intro feedback goes back to WeKruit so the next pass record gets tighter.",
  },
  {
    tag: "05",
    title: "Intro handoff",
    body: "The real owner and next step when your team accepts a consented passed profile.",
  },
]

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
                <Avatar name="Sample hiring team" size={32} tone="slate" />
              </button>
            ) : (
              <>
                <Link to="/employer" className="wk-header__signin">Role intake</Link>
                <Link to="/employer" className="wk-btn wk-btn--ink wk-btn--sm">
                  Start role intake
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
// Hero animated preview — sample passed-profile card. Drives the
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
        <Avatar name="Sample hiring team" size={44} tone="warm" />
        <div className="wk-emp-prev__top-body">
          <div className="wk-emp-prev__name">Sample role packet</div>
          <div className="wk-emp-prev__role">Employer view · passed-profile only</div>
        </div>
        <span className={`wk-emp-prev__pass${t >= 1 ? " is-in" : ""}`}>
          <Icon name="check" size={12} stroke={2.4} /> Pass record
        </span>
      </div>

      <div className={`wk-emp-prev__quote${t >= 2 ? " is-in" : ""}`}>
        <span className="wk-emp-prev__qmark">&ldquo;</span>
        You receive the pass reason, risks, fit notes, and transcript excerpts before accepting an intro.
      </div>

      <ul className={`wk-emp-prev__steps${t >= 3 ? " is-in" : ""}`} aria-label="What Claire did">
        <li><span className="wk-emp-prev__tick"><Icon name="check" size={9} stroke={2.6} /></span>Brief approved</li>
        <li><span className="wk-emp-prev__tick"><Icon name="check" size={9} stroke={2.6} /></span>Screened</li>
        <li><span className="wk-emp-prev__tick"><Icon name="check" size={9} stroke={2.6} /></span>Passed</li>
        <li><span className="wk-emp-prev__tick"><Icon name="check" size={9} stroke={2.6} /></span>Consent confirmed</li>
      </ul>

      <div className="wk-emp-prev__foot">
        <span className="wk-emp-prev__stamp">Sample preview · employers only see consented passes</span>
        <span className="wk-emp-prev__score">Preview</span>
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

function EmployerRolePacketPreview() {
  return (
    <section className="wk-section wk-section--emp-packet" aria-label="Role packet before screening">
      <div className="wk-container">
        <div className="wk-emp-packet">
          <div className="wk-emp-packet__intro">
            <p className="wk-eyebrow">
              <PulseDot size={7} /> Role packet before screening
            </p>
            <h2 className="wk-section__h2">What the first role brief needs.</h2>
            <p className="wk-emp-packet__copy">
              Claire should not start from a loose title. The first role starts with the packet
              WeKruit needs to approve the brief, screen against evidence, and send only consented
              passed profiles.
            </p>
            <Link to="/employer" className="wk-btn wk-btn--primary wk-btn--lg">
              Start role intake <Icon name="arrow-right" size={16} stroke={2} />
            </Link>
          </div>
          <div className="wk-emp-packet__grid">
            {ROLE_PACKET_ITEMS.map((item) => (
              <article key={item.tag} className="wk-emp-packet__item">
                <span className="wk-emp-packet__tag">{item.tag}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
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
              <PulseDot size={7} /> For employers · Sample passed-profile preview
            </p>
            <h1 className="wk-emp-hero__h1">
              Meet candidates <em className="wk-accent">after</em> the first interview.
            </h1>
            <p className="wk-emp-hero__lede">
              Send us a role. Claire turns the brief into screened, consented pass records —
              you review the evidence, risks, fit notes, and transcript before deciding who to meet.
            </p>
            <div className="wk-emp-hero__cta">
              <button
                type="button"
                className="wk-btn wk-btn--primary wk-btn--lg"
                onClick={() => navigate("/employer")}
              >
                Start role intake <Icon name="arrow-right" size={16} stroke={2} />
              </button>
              <Link to="/employers/inbox" className="wk-link wk-emp-hero__how">
                See a sample pass <Icon name="arrow-right" size={14} stroke={2} />
              </Link>
            </div>
            <div className="wk-emp-hero__proof">
              <span className="wk-emp-hero__metric">
                <strong>Passed profiles only</strong> no ATS, no candidate browser
              </span>
              <span className="wk-emp-hero__metric">
                <strong>Passed profiles plus the transcript</strong> before any intro
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
            <span className="wk-emp-band__num">Brief</span>
            <span className="wk-emp-band__lbl">Role requirements approved first</span>
          </div>
          <div className="wk-emp-band__stat">
            <span className="wk-emp-band__num">Screen</span>
            <span className="wk-emp-band__lbl">Claire interviews against the brief</span>
          </div>
          <div className="wk-emp-band__stat">
            <span className="wk-emp-band__num">Pass</span>
            <span className="wk-emp-band__lbl">Evidence and risks ship together</span>
          </div>
          <div className="wk-emp-band__stat">
            <span className="wk-emp-band__num">Consent</span>
            <span className="wk-emp-band__lbl">Candidate share consent is explicit</span>
          </div>
        </div>
      </section>

      <EmployerRolePacketPreview />

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
                <li><span className="wk-emp-compare__check"><Icon name="check" size={11} stroke={2.5} /></span> A compact queue of passed profiles — that&apos;s it.</li>
                <li><span className="wk-emp-compare__check"><Icon name="check" size={11} stroke={2.5} /></span> Each one has a transcript and Claire&apos;s verdict.</li>
                <li><span className="wk-emp-compare__check"><Icon name="check" size={11} stroke={2.5} /></span> Match evidence is cited. Risks are not hidden.</li>
                <li><span className="wk-emp-compare__check"><Icon name="check" size={11} stroke={2.5} /></span> You decide whether to accept the intro.</li>
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
              body="Send the role packet: role brief, hard filters, evidence probes, calibration examples, feedback loop, and intro handoff."
            />
            <EmpFlowStep
              n="02" title="WeKruit confirms the packet"
              body="We verify scope, terms, must-haves, comp band, visa stance, and deal-breakers before Claire screens against the approved brief."
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
              body="Summary, pass reason, evidence, risks, fit, transcript. Review the pass record and decide whether this candidate should enter your normal interview process."
            />
          </ol>
          <p className="wk-emp-flow__note">
            <PulseDot size={6} /> Steps 03 &amp; 04 happen behind a wall. Candidates never know who you are until you accept the intro.
          </p>
        </div>
      </section>

      {/* Use-case fit — scope-safe stage and team guidance */}
      <section className="wk-section wk-section--emp-fit">
        <div className="wk-container">
          <header className="wk-section__head wk-section__head--center">
            <p className="wk-eyebrow">Where WeKruit fits</p>
            <h2 className="wk-section__h2">Use it where a résumé screen is too weak.</h2>
          </header>

          <div className="wk-emp-fit">
            <article className="wk-emp-fit__card">
              <span className="wk-emp-fit__tag">01</span>
              <h3>Founder-led or high-context roles</h3>
              <p>
                Use WeKruit when candidates need to understand your stage, wedge, and constraints
                before meeting the hiring team. Start with one approved role brief.
              </p>
            </article>
            <article className="wk-emp-fit__card">
              <span className="wk-emp-fit__tag">02</span>
              <h3>Specialized roles where evidence matters</h3>
              <p>
                Developer platform, AI infra, risk, design systems, and GTM wedge roles are better after Claire probes for concrete work examples and risks.
              </p>
            </article>
            <article className="wk-emp-fit__card">
              <span className="wk-emp-fit__tag">03</span>
              <h3>Teams with an existing interview process</h3>
              <p>
                WeKruit sends a pass record into your normal loop. Your team owns scheduling, interview loops, and final decisions.
              </p>
            </article>
            <article className="wk-emp-fit__card wk-emp-fit__card--limit">
              <span className="wk-emp-fit__tag">Scope</span>
              <h3>Not bulk requisition filling</h3>
              <p>
                WeKruit is not an ATS replacement or a candidate browser. Keep it scoped to roles
                where the first interview should be earned with evidence.
              </p>
            </article>
          </div>
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
                Calibration goes back to WeKruit before the next pass if the evidence misses your bar.
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
              Open a sample pass record: summary, pass reason, evidence, risks, comp fit, and transcript excerpts.
              The employer sees the candidate only after the screen is complete and share consent is clear.
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

      {/* FAQ — scope-safe operating model */}
      <section className="wk-section">
        <div className="wk-container">
          <header className="wk-section__head wk-section__head--center">
            <p className="wk-eyebrow">Employer operating model</p>
            <h2 className="wk-section__h2">
              What WeKruit is. <em className="wk-accent">And what it is not.</em>
            </h2>
          </header>

          <div className="wk-emp-faq" aria-label="Employer operating model FAQ">
            <article className="wk-emp-faq__item">
              <h3>What does WeKruit send to employers?</h3>
              <p>
                We send consented passed profiles only: summary, pass reason, cited evidence,
                risks, fit notes, and transcript excerpts tied to the approved role brief.
              </p>
            </article>
            <article className="wk-emp-faq__item">
              <h3>Can employers browse candidates?</h3>
              <p>
                No. WeKruit is not an ATS and not a candidate browser. Candidates stay behind
                Claire&apos;s wall until they pass a role screen and consent to share.
              </p>
            </article>
            <article className="wk-emp-faq__item">
              <h3>What happens after we accept a pass?</h3>
              <p>
                You decide whether this candidate should enter your normal interview process.
                Your team owns scheduling, interview loops, and the hiring decision.
              </p>
            </article>
            <article className="wk-emp-faq__item">
              <h3>How are scope and terms handled?</h3>
              <p>
                Start with one role brief. WeKruit confirms scope and terms before Claire screens,
                then screens only against the approved brief.
              </p>
            </article>
            <article className="wk-emp-faq__item">
              <h3>What if the evidence misses our bar?</h3>
              <p>
                Calibration goes back to WeKruit before the next pass so the role brief, hard
                filters, and evidence probes get tighter.
              </p>
            </article>
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
                Start with one role <Icon name="arrow-right" size={16} stroke={2} />
              </button>
              <a
                href="mailto:hello@wekruit.com?subject=Book%20a%2015-min%20call"
                className="wk-btn wk-btn--secondary wk-btn--lg"
              >
                Book a 15-min call
              </a>
            </div>
            <p className="wk-final-cta__fine">
              Start with one role brief. WeKruit confirms scope and terms before Claire screens candidates.
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
              <p className="wk-eyebrow"><PulseDot size={6} /> Inbox · sample role · Developer platform lead</p>
              <h1 className="wk-emp-inbox__h1">
                Sample passed profiles.
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
              <span className="wk-emp-inbox__list-count">Preview</span>
            </header>
            <ul className="wk-emp-inbox__rows">
              {EMP_PASSED.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`wk-emp-row${p.id === activeId ? " is-active" : ""}`}
                    aria-label={`Preview ${p.name} pass record`}
                    aria-pressed={p.id === activeId}
                    onClick={() => setActiveId(p.id)}
                  >
                    <Avatar name={p.name} size={36} tone={p.tone} />
                    <div className="wk-emp-row__body">
                      <div className="wk-emp-row__top">
                        <span className="wk-emp-row__name">{p.name}</span>
                        <span className="wk-emp-row__time">{SAMPLE_PASS_RECORD}</span>
                      </div>
                      <div className="wk-emp-row__meta">{p.headline}</div>
                      <div className="wk-emp-row__chips">
                        <span className={`wk-emp-row__pass${p.pass === "Strong pass" ? " is-strong" : ""}`}>
                          {p.pass}
                        </span>
                        <span className={`wk-emp-row__badge${p.reviewBadge === "Risk noted" ? " is-risk" : ""}`}>
                          {p.reviewBadge}
                        </span>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="wk-emp-inbox__pool">
              <Icon name="sparkle" size={14} stroke={1.6} />
              <div>
                <strong>Other candidates stay hidden</strong> while Claire screens for this role.
                <br />
                <span>You see only passed profiles after consent is ready.</span>
              </div>
            </div>
          </aside>

          <section className="wk-emp-detail">
            <EmployerInboxRolePacket packet={SAMPLE_INBOX_ROLE_PACKET} />
            {active.summary ? <EmpPassedDetail c={active} /> : <EmpPassedDetailLite c={active} />}
          </section>
        </div>
      </div>
    </EmployerShell>
  )
}

function EmployerInboxRolePacket({ packet }: { packet: InboxRolePacket }) {
  const rows = [
    ["Hard filters before pass", packet.hardFilters],
    ["Must-haves Claire verified", packet.mustHaves],
    ["Evidence probes Claire asked", packet.evidenceProbes],
    ["Calibration bar", packet.calibrationBar],
    ["Intro owner", packet.introOwner],
  ] as const

  return (
    <section className="wk-emp-inbox-packet" aria-labelledby="wk-emp-inbox-packet-title">
      <div className="wk-emp-inbox-packet__head">
        <div>
          <p className="wk-eyebrow">Approved role packet</p>
          <h2 id="wk-emp-inbox-packet-title">What Claire screened against</h2>
          <p>{packet.role}</p>
        </div>
        <Link to="/employer" className="wk-btn wk-btn--primary wk-btn--sm">
          Start role intake <Icon name="arrow-right" size={14} stroke={2} />
        </Link>
      </div>
      <p className="wk-emp-inbox-packet__scope">{packet.scope}</p>
      <dl className="wk-emp-inbox-packet__rows">
        {rows.map(([label, value]) => (
          <div key={label} className="wk-emp-inbox-packet__row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="wk-emp-inbox-packet__note">Sample packet only. The real product starts by collecting this role packet before Claire screens.</p>
    </section>
  )
}

function EmpPassedDetail({ c }: { c: PassedProfile }) {
  return (
    <article className="wk-emp-pp">
      <header className="wk-emp-pp__head">
        <Avatar name={c.name} size={72} tone={c.tone} />
        <div className="wk-emp-pp__head-body">
          <p className="wk-eyebrow">Passed by Claire · {SAMPLE_PASS_RECORD}</p>
          <h2 className="wk-emp-pp__name">{c.name}</h2>
          <p className="wk-emp-pp__meta">{c.headline} · for <strong>{c.role}</strong></p>
        </div>
        <div className="wk-emp-pp__head-side">
          <span className={`wk-emp-pp__pass${c.pass === "Strong pass" ? " is-strong" : ""}`}>
            <Icon name="check" size={12} stroke={2.4} /> {c.pass}
          </span>
          <span className={`wk-emp-pp__badge${c.reviewBadge === "Risk noted" ? " is-risk" : ""}`}>
            {c.reviewBadge}
          </span>
        </div>
      </header>

      <div className="wk-emp-pp__actions wk-emp-pp__actions--sample" aria-label="Sample employer actions">
        <span className="wk-emp-pp__action-chip wk-emp-pp__action-chip--primary">
          <Icon name="check" size={14} stroke={2} /> Accept intro after consent
        </span>
        <span className="wk-emp-pp__action-chip">Review evidence</span>
        <span className="wk-emp-pp__action-chip">Calibration goes back to WeKruit</span>
        <span className="wk-emp-pp__exp">
          <Icon name="lock" size={12} stroke={2} /> Consent shown in sample
        </span>
        <span className="wk-emp-pp__sample">Sample actions only</span>
      </div>

      <section className="wk-emp-pp__sec">
        <h3 className="wk-emp-pp__h">Summary</h3>
        <p className="wk-emp-pp__sum">{c.summary}</p>
      </section>

      <section className="wk-emp-pp__sec">
        <h3 className="wk-emp-pp__h">Why Claire passed this candidate</h3>
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
          <span className="wk-link wk-emp-pp__full">Open sample transcript excerpt</span>
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

      <section className="wk-emp-pp__sec wk-emp-pp__calibration">
        <div className="wk-emp-pp__h-row">
          <h3 className="wk-emp-pp__h">Calibration packet</h3>
          <span className="wk-emp-pp__sample">Sample calibration</span>
        </div>
        <div className="wk-emp-pp__cal-grid">
          <article className="wk-emp-pp__cal-card">
            <span className="wk-emp-pp__cal-kicker">Feedback loop</span>
            <h4>Hiring-team feedback captured as evidence</h4>
            <p>
              Accept or reject reasons go back to WeKruit against the approved role brief.
              Candidate notes stay protected; the next screen gets tighter.
            </p>
          </article>
          <article className="wk-emp-pp__cal-card">
            <span className="wk-emp-pp__cal-kicker">What changes before the next pass</span>
            <ul className="wk-emp-pp__cal-list">
              <li>Tighten evidence probes</li>
              <li>Update hard filters</li>
              <li>Record candidate risk calibration</li>
            </ul>
          </article>
        </div>
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
          <p className="wk-eyebrow">Passed · {SAMPLE_PASS_RECORD}</p>
          <h2 className="wk-emp-pp__name">{c.name}</h2>
          <p className="wk-emp-pp__meta">{c.headline} · for <strong>{c.role}</strong></p>
        </div>
        <div className="wk-emp-pp__head-side">
          <span className={`wk-emp-pp__pass${c.pass === "Strong pass" ? " is-strong" : ""}`}>
            <Icon name="check" size={12} stroke={2.4} /> {c.pass}
          </span>
          <span className={`wk-emp-pp__badge${c.reviewBadge === "Risk noted" ? " is-risk" : ""}`}>
            {c.reviewBadge}
          </span>
        </div>
      </header>
      <section className="wk-emp-pp__sec wk-emp-pp__lite-body">
        <p className="wk-emp-pp__lite-msg">
          This preview follows one passed profile end-to-end. Click <strong>Sample candidate</strong> in the rail to see the
          full operational view — summary, pass reason, evidence, risks, fit, and transcript excerpts.
        </p>
      </section>
    </article>
  )
}
