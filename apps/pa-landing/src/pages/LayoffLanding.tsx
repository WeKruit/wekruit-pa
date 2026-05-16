/**
 * LayoffLanding — `/` for layoff.wekruit.com.
 *
 * TSX port of the Claude Design `wekruit-layoff-design/project/landing.jsx`
 * bundle. Renders the hero + rolling layoff banner + live preview table +
 * "How this works" + FAQ + footer. Hand-built — does not reuse the iter33
 * Landing.tsx (candidate.wekruit.com), which has different chrome.
 *
 * Nav contract from the user screenshot 2026-05-16:
 *   Open interviews → /open   (scraped non-collab jobs board, PR #76)
 *   Pipeline        → /me     (CandidateMe)
 *   Profile         → /me/profile
 */
import { Link, useNavigate } from "react-router-dom"
import { useEffect, useState } from "react"
import "../styles/wekruit-tokens.css"

// ----- Sample TALENT (kept inline since shared.jsx isn't bundled) ---------
// Mirrors the design's TALENT array — purely illustrative for the preview
// table (Phase 87 anonymous-supply visualization is downstream of v2.0
// candidate-retention marketplace; this is the static teaser).
interface TalentRow {
  id: number
  first: string
  last: string
  company: string
  function: string
  title: string
  location: string
  added: string
  verified: boolean
}
const TALENT: TalentRow[] = [
  { id: 1, first: "Maya", last: "C", company: "Meta", function: "Product", title: "Senior PM, Reality Labs", location: "San Francisco", added: "2h", verified: true },
  { id: 2, first: "Daniel", last: "O", company: "Google", function: "Engineering", title: "Staff SWE, Search Infra", location: "New York", added: "6h", verified: true },
  { id: 3, first: "Priya", last: "R", company: "Tesla", function: "Design", title: "Lead Product Designer", location: "Austin", added: "1d", verified: true },
  { id: 4, first: "Marcus", last: "B", company: "Stripe", function: "Engineering", title: "Senior SWE, Payments", location: "Remote · US", added: "1d", verified: true },
  { id: 5, first: "Jen", last: "T", company: "Salesforce", function: "GTM", title: "Enterprise AE", location: "Chicago", added: "2d", verified: true },
  { id: 6, first: "Sam", last: "L", company: "Amazon", function: "Product", title: "PM II, AWS", location: "Seattle", added: "2d", verified: false },
  { id: 7, first: "Lina", last: "K", company: "Microsoft", function: "Engineering", title: "Principal SWE, Copilot", location: "Remote · US", added: "3d", verified: true },
  { id: 8, first: "Tobi", last: "A", company: "Twilio", function: "GTM", title: "Head of CS", location: "Boston", added: "3d", verified: true },
  { id: 9, first: "Rishi", last: "D", company: "Discord", function: "Design", title: "Senior Brand Designer", location: "Los Angeles", added: "4d", verified: true },
]

const LAYOFF_COMPANIES = [
  "Meta", "Google", "Tesla", "Stripe", "Salesforce", "Amazon", "Microsoft",
  "Snap", "Discord", "Spotify", "Atlassian", "GitHub", "Twilio", "Cisco",
]

// ------------------------------------------------------------- atoms ----

function Dot({ color = "var(--ink)", pulse = false }: { color?: string; pulse?: boolean }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 8, height: 8 }}>
      {pulse && (
        <span
          style={{
            position: "absolute",
            inset: -4,
            borderRadius: 999,
            background: color,
            opacity: 0.25,
            animation: "wko-pulse 2s ease-in-out infinite",
          }}
        />
      )}
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color, display: "inline-block" }} />
    </span>
  )
}

function Avatar({ name }: { name: string }) {
  const initial = (name || "?")[0]
  const hues = ["var(--peach-100)", "var(--peach-200)", "var(--cream-2)", "var(--success-bg)", "var(--warning-bg)"]
  const hue = hues[(name || "A").charCodeAt(0) % hues.length]
  return (
    <span
      style={{
        width: 32,
        height: 32,
        borderRadius: "50%",
        background: hue,
        border: "1px solid var(--border)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-serif)",
        fontSize: 15,
        color: "var(--ink)",
      }}
    >
      {initial}
    </span>
  )
}

function LinkedInIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.95v5.66H9.36V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.26 2.37 4.26 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.99 0 1.78-.77 1.78-1.72V1.72C24 .77 23.21 0 22.22 0z" />
    </svg>
  )
}

function VerifiedBadge({ small }: { small?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: small ? 11 : 12,
        color: "var(--success)",
        fontWeight: 500,
      }}
      title="Verified via work email + LinkedIn"
    >
      <svg width={small ? 11 : 12} height={small ? 11 : 12} viewBox="0 0 16 16" aria-hidden>
        <path d="M8 1l1.8 1.6 2.4-.3.6 2.3 2.2 1-1 2.2.7 2.3-2.1 1.1-.3 2.4-2.4-.1L8 14.9 6.1 13.4l-2.4.1-.3-2.4L1.3 10l.7-2.3-1-2.2 2.2-1 .6-2.3 2.4.3L8 1zm-1 9.4l4-4-1-1L7 8.4 5.5 6.9l-1 1L7 10.4z" fill="currentColor" />
      </svg>
      Verified
    </span>
  )
}

// ------------------------------------------------------------- chrome ---

function Wordmark() {
  return (
    <Link
      to="/"
      style={{
        textDecoration: "none",
        display: "inline-flex",
        alignItems: "baseline",
        gap: 8,
        color: "var(--ink)",
      }}
    >
      <span style={{ fontFamily: "var(--font-serif)", fontSize: 28, letterSpacing: "-0.02em", fontWeight: 500 }}>
        We<em style={{ fontStyle: "italic", fontWeight: 400 }}>kruit</em>
      </span>
    </Link>
  )
}

function Nav() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16)
    window.addEventListener("scroll", onScroll)
    return () => window.removeEventListener("scroll", onScroll)
  }, [])
  const linkStyle: React.CSSProperties = {
    fontFamily: "var(--font-sans)",
    fontSize: 15,
    color: "var(--ink-2)",
    textDecoration: "none",
    letterSpacing: "-0.005em",
  }
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: scrolled ? "rgba(245,237,227,.82)" : "transparent",
        backdropFilter: scrolled ? "blur(12px)" : "none",
        WebkitBackdropFilter: scrolled ? "blur(12px)" : "none",
        borderBottom: scrolled ? "1px solid var(--border)" : "1px solid transparent",
        transition: "background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)",
      }}
    >
      <div
        className="container"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 72 }}
      >
        <Wordmark />
        <nav style={{ display: "flex", gap: 36, alignItems: "center" }}>
          <Link to="/open" style={linkStyle}>Open interviews</Link>
          <Link to="/me" style={linkStyle}>Pipeline</Link>
          <Link to="/me/profile" style={linkStyle}>Profile</Link>
        </nav>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link to="/login" style={linkStyle}>Sign in</Link>
          <Link to="/login" className="btn btn--primary btn--sm">Add your name</Link>
        </div>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--border)", marginTop: "var(--sp-9)" }}>
      <div
        className="container"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "40px 24px",
          gap: 24,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <Wordmark />
          <span className="caption" style={{ color: "var(--ink-3)" }}>A quiet list for people between things.</span>
        </div>
        <div style={{ display: "flex", gap: 28, alignItems: "center" }}>
          <span className="caption">Built by WeKruit</span>
          <Link className="caption" style={{ color: "var(--ink-3)" }} to="/legal">Privacy</Link>
          <Link className="caption" style={{ color: "var(--ink-3)" }} to="/legal">Terms</Link>
          <a className="caption" style={{ color: "var(--ink-3)" }} href="mailto:hello@wekruit.com">hello@wekruit.com</a>
        </div>
      </div>
    </footer>
  )
}

// ---------------------------------------------------------- rolling -----

function RollingBanner() {
  const items = [...LAYOFF_COMPANIES, ...LAYOFF_COMPANIES]
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        maskImage: "linear-gradient(90deg, transparent 0%, black 8%, black 92%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(90deg, transparent 0%, black 8%, black 92%, transparent 100%)",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          gap: 56,
          whiteSpace: "nowrap",
          animation: "wko-marquee 40s linear infinite",
          paddingLeft: 28,
        }}
      >
        {items.map((name, i) => (
          <span
            key={i}
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 22,
              color: "var(--ink)",
              letterSpacing: "-0.01em",
              opacity: 0.7,
              display: "inline-flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            {name}
            <span
              aria-hidden
              style={{ width: 4, height: 4, borderRadius: 999, background: "var(--peach-300)", opacity: 0.6 }}
            />
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------- preview ----

function PreviewTable() {
  const navigate = useNavigate()
  return (
    <div
      style={{
        position: "relative",
        background: "var(--cream-3)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        boxShadow: "var(--shadow-md)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1.2fr 1fr 1.6fr 1.2fr 0.8fr 0.6fr",
          padding: "16px 24px",
          borderBottom: "1px solid var(--border)",
          background: "var(--cream-2)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        <div>Name</div>
        <div>Last company</div>
        <div>Function</div>
        <div>Title</div>
        <div>Location</div>
        <div>Added</div>
        <div style={{ textAlign: "right" }}>Contact</div>
      </div>
      <div>
        {TALENT.map((p, i) => <PreviewRow key={p.id} p={p} dim={i >= 6} />)}
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 180,
          background: "linear-gradient(180deg, transparent 0%, var(--cream) 90%)",
          pointerEvents: "none",
        }}
      />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 28, display: "flex", justifyContent: "center" }}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => navigate("/open")}
        >
          See all open interviews →
        </button>
      </div>
    </div>
  )
}

function PreviewRow({ p, dim }: { p: TalentRow; dim: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "1.4fr 1.2fr 1fr 1.6fr 1.2fr 0.8fr 0.6fr",
        padding: "18px 24px",
        borderBottom: "1px solid var(--border)",
        alignItems: "center",
        background: hover ? "var(--cream-2)" : "transparent",
        transition: "background var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease)",
        opacity: dim ? 0.7 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Avatar name={p.first} />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--ink)", fontSize: 15 }}>{p.first} {p.last}.</span>
          {p.verified && <VerifiedBadge small />}
        </div>
      </div>
      <div style={{ color: "var(--ink)", fontSize: 14 }}>{p.company}</div>
      <div style={{ fontSize: 14, color: "var(--ink-2)" }}>{p.function}</div>
      <div style={{ fontSize: 14, color: "var(--ink)" }}>{p.title}</div>
      <div style={{ fontSize: 14, color: "var(--ink-2)" }}>{p.location}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)" }}>{p.added}</div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, color: "var(--ink-3)" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: "var(--r-pill)",
            background: "var(--cream-2)",
          }}
        >
          <LinkedInIcon size={13} />
        </span>
      </div>
    </div>
  )
}

// ----------------------------------------------------------- step + FAQ

function Step({
  n,
  title,
  body,
  meta,
  last,
  emphasis,
}: {
  n: string
  title: string
  body: string
  meta: string
  last?: boolean
  emphasis?: boolean
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "64px 1fr",
        gap: 24,
        paddingTop: 32,
        paddingBottom: 32,
        borderBottom: last ? "none" : "1px solid var(--border)",
        position: "relative",
        background: emphasis ? "linear-gradient(90deg, var(--peach-50) 0%, transparent 70%)" : "transparent",
        marginLeft: emphasis ? -24 : 0,
        marginRight: emphasis ? -24 : 0,
        paddingLeft: emphasis ? 24 : 0,
        paddingRight: emphasis ? 24 : 0,
        borderRadius: emphasis ? "var(--r-md)" : 0,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: emphasis ? 56 : 44,
          fontWeight: emphasis ? 600 : 400,
          lineHeight: 1,
          color: "var(--ink)",
          letterSpacing: "-0.02em",
        }}
      >
        {n}
      </div>
      <div>
        <h3
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: emphasis ? 24 : 22,
            fontWeight: emphasis ? 700 : 600,
            margin: "4px 0 8px",
            letterSpacing: "-0.015em",
          }}
        >
          {title}
        </h3>
        <p style={{ color: "var(--ink-2)", margin: 0, maxWidth: 540, fontSize: emphasis ? 16 : 15 }}>{body}</p>
        <div style={{ marginTop: 12, display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: emphasis ? "var(--ink)" : "var(--ink-3)",
              fontWeight: emphasis ? 600 : 400,
              padding: "4px 10px",
              background: emphasis ? "var(--cream)" : "var(--cream-3)",
              border: "1px solid " + (emphasis ? "var(--border-strong)" : "var(--border)"),
              borderRadius: "var(--r-pill)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {emphasis && <Dot pulse color="var(--success)" />}
            {meta}
          </span>
        </div>
      </div>
    </div>
  )
}

function FAQ({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <h3 style={{ fontFamily: "var(--font-sans)", fontSize: 18, fontWeight: 600, margin: "0 0 10px", letterSpacing: "-0.01em" }}>
        {q}
      </h3>
      <p style={{ margin: 0, fontSize: 15, color: "var(--ink-2)", lineHeight: 1.55 }}>{a}</p>
    </div>
  )
}

// ----------------------------------------------------------- main ------

export default function LayoffLanding() {
  return (
    <main style={{ background: "var(--cream)", minHeight: "100vh", fontFamily: "var(--font-sans)", color: "var(--ink)" }}>
      <Nav />

      {/* HERO */}
      <section
        style={{
          position: "relative",
          background: "var(--halo-hero)",
          marginTop: -72,
          paddingTop: 64 + 72,
          paddingBottom: 56,
          overflow: "hidden",
        }}
      >
        <div className="container-narrow" style={{ textAlign: "center", position: "relative", zIndex: 1 }}>
          <div className="eyebrow" style={{ marginBottom: 18 }}>From WeKruit</div>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontSize: "clamp(48px, 6vw, 84px)",
              lineHeight: 1.02,
              letterSpacing: "-0.025em",
              color: "var(--ink)",
              margin: 0,
            }}
          >
            Laid off? We&apos;ve <em style={{ fontStyle: "italic" }}>got</em> you.
          </h1>
          <p
            style={{
              marginTop: 22,
              marginInline: "auto",
              maxWidth: 560,
              fontSize: "clamp(17px, 1.4vw, 20px)",
              lineHeight: 1.45,
              color: "var(--ink-2)",
            }}
          >
            A small, verified list of operators ready for what&apos;s next.{" "}
            <strong style={{ color: "var(--ink)", fontWeight: 500 }}>We make the intros by hand.</strong>
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 28, flexWrap: "wrap" }}>
            <Link to="/login" className="btn btn--primary btn--lg">Add your name — 60 sec</Link>
            <Link to="/open" className="btn btn--secondary btn--lg">Browse open interviews</Link>
          </div>
          <div style={{ marginTop: 18, display: "inline-flex", alignItems: "center", gap: 8, color: "var(--ink-3)" }}>
            <Dot color="var(--success)" />
            <span className="caption">412 verified operators · 18 joined this week</span>
          </div>

          <div style={{ marginTop: 48, paddingTop: 28, borderTop: "1px solid rgba(45,26,10,0.08)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, justifyContent: "center", marginBottom: 18 }}>
              <span className="eyebrow" style={{ whiteSpace: "nowrap", opacity: 0.7 }}>From recent layoffs at</span>
            </div>
            <RollingBanner />
          </div>
        </div>
      </section>

      {/* PREVIEW */}
      <section id="preview" style={{ paddingTop: 32, paddingBottom: 96 }}>
        <div className="container">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 24,
              marginBottom: 20,
              flexWrap: "wrap",
            }}
          >
            <div className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <Dot pulse color="var(--success)" /> Currently available · 412 people · updated 11 min ago
            </div>
            <Link to="/open" className="btn btn--ghost btn--sm">Open interviews →</Link>
          </div>
          <PreviewTable />
        </div>
      </section>

      {/* HOW THIS WORKS */}
      <section
        style={{
          paddingTop: 80,
          paddingBottom: 96,
          background: "var(--cream-2)",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div className="container">
          <div className="how-grid" style={{ display: "grid", gap: 64, alignItems: "start" }}>
            <div className="how-sticky">
              <div className="eyebrow" style={{ marginBottom: 16 }}>How this works</div>
              <h2
                style={{
                  fontFamily: "var(--font-serif)",
                  fontWeight: 400,
                  fontSize: "clamp(32px, 3.6vw, 48px)",
                  lineHeight: 1.05,
                  letterSpacing: "-0.02em",
                  margin: 0,
                }}
              >
                Register once. We <em style={{ fontStyle: "italic" }}>text</em> you the rest.
              </h2>
              <p style={{ marginTop: 20, color: "var(--ink-2)", maxWidth: 420 }}>
                No applications. No portals. You register, we text you to learn what you want, and we make the intros ourselves.
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <Step
                n="1"
                title="Register and upload your resume"
                body="Seven fields and a resume. About 60 seconds. We use your work email and LinkedIn to verify the layoff — no public 'open to work' green ring, no posting on your behalf."
                meta="60 sec · resume + 7 fields"
              />
              <Step
                n="2"
                title="We verify quickly"
                body="A quiet check against your last work email and LinkedIn. Usually within a few hours."
                meta="Same day"
              />
              <Step
                n="3"
                title="Claire texts you immediately"
                body="The moment you finish the form, Claire — your WeKruit recruiter on iMessage — texts your number. A five-minute conversation so we understand what you actually want."
                meta="Right after you submit · ~5 min SMS"
                emphasis
              />
              <Step
                n="4"
                title="We make the warm intros"
                body="If your profile fits one of our roles, we email-introduce you directly. Either way, you skip the portal."
                meta="Warm intros only"
                last
              />
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section style={{ paddingTop: 112, paddingBottom: 48 }}>
        <div className="container">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 40 }}>
            <FAQ
              q="Who can join?"
              a="If you were laid off in the last 6 months from a company we can verify, you're in. We verify via your old work email or LinkedIn — usually within a day."
            />
            <FAQ
              q="What's public, what's private?"
              a="Your first name, last initial, last company, title, function, location, start date, comp range, and short pitch are public to logged-in employers. Your full name, email, and resume are private until you choose to share."
            />
            <FAQ
              q="How is this different from a job board?"
              a="There are no job postings here. We point you at the right people, by hand. The list itself is the signal — small, verified, built to make warm intros easy."
            />
            <FAQ
              q="Is it free?"
              a="Yes, for candidates. Always. Employers pay only when a hire works out — it's how we keep the list honest and the noise out."
            />
          </div>
        </div>
      </section>

      <Footer />

      <style>{`
        .how-grid { grid-template-columns: 1fr 1.4fr; }
        .how-sticky { position: sticky; top: 96px; }
        @media (max-width: 900px) {
          .how-grid { grid-template-columns: 1fr; }
          .how-sticky { position: static; }
        }
      `}</style>
    </main>
  )
}
