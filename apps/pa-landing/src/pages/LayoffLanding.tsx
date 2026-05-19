/**
 * LayoffLanding — `/` for layoff.wekruit.com.
 *
 * Faithful TSX port of wekruit-layoff-design/project/landing.jsx (Claude
 * Design bundle 2026-05-18). Renders the cream WeKruit · Open landing:
 *   - "WeKruit · Open" wordmark
 *   - Nav: For candidates / Add your name
 *   - Hero: "Laid off? We've got you." centered with "Add your name — 60 sec"
 *   - Rolling layoff company marquee
 *   - Preview talent table (Firestore-backed rows, last 3 dimmed under a fade)
 *   - "How this works" 4-step section
 *   - FAQ grid
 *   - Footer
 *
 * Primary CTA wires to /onboarding (source flag resolved client-side via
 * lib/source.ts — see Onboarding.tsx).
 */
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import "../styles/wekruit-tokens.css"

type TalentRow = {
  id: string
  firstName: string
  lastInitial: string
  lastCompany: string
  function: string | null
  jobTitle: string
  location: string
  joinedAtIso: string
  verified: boolean
}

type PreviewResponse = {
  ok: true
  count: number
  totalAvailable: number
  joinedThisWeek: number
  rows: TalentRow[]
}

type PreviewState = {
  data: PreviewResponse | null
  loading: boolean
  error: string | null
}

const LAYOFF_PREVIEW_URL =
  import.meta.env.VITE_LAYOFF_PREVIEW_URL ||
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicLayoffPreview"

function isPreviewResponse(value: unknown): value is PreviewResponse {
  const v = value as Partial<PreviewResponse> | null
  return Boolean(v && v.ok === true && Array.isArray(v.rows))
}

function useLayoffPreview(): PreviewState {
  const [state, setState] = useState<PreviewState>({ data: null, loading: true, error: null })

  useEffect(() => {
    const ac = new AbortController()
    async function load() {
      try {
        const resp = await fetch(`${LAYOFF_PREVIEW_URL}?limit=9`, { signal: ac.signal })
        if (!resp.ok) throw new Error(`preview_http_${resp.status}`)
        const json = await resp.json()
        if (!isPreviewResponse(json)) throw new Error("preview_bad_shape")
        setState({ data: json, loading: false, error: null })
      } catch (err) {
        if (ac.signal.aborted) return
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    void load()
    return () => ac.abort()
  }, [])

  return state
}

function formatAgo(min: number): string {
  if (min < 60) return `${Math.max(1, min)}m`
  if (min < 60 * 24) return `${Math.floor(min / 60)}h`
  return `${Math.floor(min / 1440)}d`
}

function formatJoinedAgo(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "today"
  const min = Math.max(1, Math.floor((Date.now() - ms) / 60_000))
  return formatAgo(min)
}

const LAYOFF_COMPANIES = [
  "Meta", "Google", "Tesla", "Stripe", "Salesforce", "Amazon", "Microsoft",
  "Snap", "Discord", "Spotify", "Atlassian", "GitHub", "Twilio", "Cisco",
]

export default function LayoffLanding() {
  const preview = useLayoffPreview()
  return (
    <main>
      <Nav current="landing" />
      <Hero preview={preview} />
      <PreviewSection preview={preview} />
      <HowItWorks />
      <FAQSection />
      <Footer />
      <Animations />
    </main>
  )
}

// =========================================================================
// Hero
// =========================================================================
function Hero({ preview }: { preview: PreviewState }) {
  return (
    <section
      style={{
        position: "relative",
        background: "var(--halo-hero, var(--cream))",
        marginTop: -72,
        paddingTop: 64 + 72,
        paddingBottom: 56,
        overflow: "hidden",
      }}
    >
      <div className="container-narrow" style={{ textAlign: "center", position: "relative", zIndex: 1, marginInline: "auto", maxWidth: 760, paddingInline: 24 }}>
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
            textWrap: "balance",
          }}
        >
          Laid off? We've <em style={{ fontStyle: "italic" }}>got</em> you.
        </h1>
        <p
          style={{
            marginTop: 22,
            marginInline: "auto",
            maxWidth: 520,
            fontFamily: "var(--font-sans)",
            fontSize: "clamp(17px, 1.4vw, 20px)",
            lineHeight: 1.45,
            color: "var(--ink-2)",
          }}
        >
          Interviews lined up in about a week.{" "}
          <strong style={{ color: "var(--ink)", fontWeight: 500 }}>We make the intros by hand.</strong>
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 28, flexWrap: "wrap" }}>
          <Link to="/onboarding" className="btn btn--primary btn--lg" style={{ textDecoration: "none" }}>
            Add your name — 60 sec
          </Link>
        </div>
        <HeroCounter preview={preview} />

        <div
          style={{
            marginTop: 48,
            paddingTop: 28,
            borderTop: "1px solid rgba(45,26,10,0.08)",
            position: "relative",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16, justifyContent: "center", marginBottom: 18 }}>
            <span className="eyebrow" style={{ whiteSpace: "nowrap", opacity: 0.7 }}>From recent layoffs at</span>
          </div>
          <RollingBanner />
        </div>
      </div>
    </section>
  )
}

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
              style={{
                width: 4,
                height: 4,
                borderRadius: 999,
                background: "var(--peach-300)",
                opacity: 0.6,
              }}
            />
          </span>
        ))}
      </div>
    </div>
  )
}

// =========================================================================
// Preview Section
// =========================================================================
function HeroCounter({ preview }: { preview: PreviewState }) {
  const count = preview.data?.totalAvailable ?? 0
  const weekly = preview.data?.joinedThisWeek ?? 0
  const label = preview.loading
    ? "Refreshing verified operators"
    : preview.error
      ? "Verified operators · updating daily"
      : `${count} verified operators · ${weekly} joined this week · updated daily`
  return (
    <div style={{ marginTop: 18, display: "inline-flex", alignItems: "center", gap: 8, color: "var(--ink-3)" }}>
      <Dot color="var(--success)" />
      <span className="caption">
        {label}
      </span>
    </div>
  )
}

function PreviewSection({ preview }: { preview: PreviewState }) {
  const visible = preview.data?.rows ?? []
  const count = preview.data?.totalAvailable ?? visible.length
  const freshness = preview.loading
    ? "refreshing"
    : preview.error
      ? "temporarily unavailable"
      : "refreshed from verified list"
  return (
    <section id="preview" style={{ paddingTop: 32, paddingBottom: 96 }}>
      <div className="container" style={{ maxWidth: 1280, marginInline: "auto", paddingInline: 24 }}>
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
            <Dot pulse color="var(--success)" /> Currently available · {count} people · {freshness}
          </div>
        </div>
        <PreviewTable rows={visible} count={count} loading={preview.loading} error={preview.error} />
      </div>
    </section>
  )
}

function PreviewTable({
  rows,
  count,
  loading,
  error,
}: {
  rows: TalentRow[]
  count: number
  loading: boolean
  error: string | null
}) {
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
        {rows.length > 0 ? (
          rows.map((p, i) => (
            <PreviewRow key={p.id} p={p} dim={i >= 6} />
          ))
        ) : (
          <div style={{ padding: "28px 24px", color: "var(--ink-2)", fontSize: 14 }}>
            {loading ? "Refreshing verified operators..." : error ? "The verified list is updating. Check back shortly." : "No verified operators available yet."}
          </div>
        )}
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
        <Avatar name={p.firstName} />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--ink)", fontSize: 15 }}>
            {p.firstName} {p.lastInitial ? `${p.lastInitial}.` : ""}
          </span>
          {p.verified && <VerifiedBadge small />}
        </div>
      </div>
      <div style={{ color: "var(--ink)", fontSize: 14 }}>{p.lastCompany}</div>
      <div style={{ fontSize: 14, color: "var(--ink-2)" }}>{p.function ?? "Other"}</div>
      <div style={{ fontSize: 14, color: "var(--ink)" }}>{p.jobTitle}</div>
      <div style={{ fontSize: 14, color: "var(--ink-2)" }}>{p.location}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)" }}>{formatJoinedAgo(p.joinedAtIso)}</div>
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

// =========================================================================
// How this works
// =========================================================================
function HowItWorks() {
  return (
    <section
      style={{
        paddingTop: 80,
        paddingBottom: 96,
        background: "var(--cream-2)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="container" style={{ maxWidth: 1280, marginInline: "auto", paddingInline: 24 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 64, alignItems: "start" }}>
          <div style={{ position: "sticky", top: 96 }}>
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
            <Step n="2" title="We verify quickly" body="A quiet check against your last work email and LinkedIn. Usually within a few hours." meta="Same day" />
            <Step
              n="3"
              title="We text you immediately for a quick chat"
              body="The moment you finish the form, WeKruit texts your number. A five-minute SMS conversation so we understand what you actually want — function, stage, location, comp, sponsorship. That's it."
              meta="Right after you submit · ~5 min SMS"
              emphasis
            />
            <Step
              n="4"
              title="We make the warm intros"
              body="If your profile fits one of our roles, we email-introduce you directly. Employers can also message you on the list. Either way, you skip the portal."
              meta="Warm intros only"
              last
            />
          </div>
        </div>
      </div>
    </section>
  )
}

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
        background: emphasis ? "linear-gradient(90deg, var(--peach-50, var(--cream-3)) 0%, transparent 70%)" : "transparent",
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
        <p
          style={{
            color: "var(--ink-2)",
            margin: 0,
            maxWidth: 540,
            fontSize: emphasis ? 16 : 15,
          }}
        >
          {body}
        </p>
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

// =========================================================================
// FAQ
// =========================================================================
function FAQSection() {
  return (
    <section style={{ paddingTop: 112, paddingBottom: 48 }}>
      <div className="container" style={{ maxWidth: 1280, marginInline: "auto", paddingInline: 24 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 40 }}>
          <FAQ
            q="Who can join?"
            a="If you were laid off in the last 6 months from a company we can verify, you're in. We verify via your old work email or LinkedIn. We'll review and mark you verified — usually within a day."
          />
          <FAQ
            q="What's public, what's private?"
            a="Your first name, last initial, last company, title, function, location, start date, comp range, and short pitch are public to logged-in employers. Your full name, email, and resume are private until you choose to share."
          />
          <FAQ
            q="How is this different from a job board?"
            a="There are no job postings here. We point you at the right people, by hand. The list itself is the signal — it's small, verified, and built to make warm intros easy."
          />
          <FAQ
            q="Is it free?"
            a="Yes, for candidates. Always. Employers pay only when a hire works out — it's how we keep the list honest and the noise out."
          />
        </div>
      </div>
    </section>
  )
}

function FAQ({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <h3 style={{ fontFamily: "var(--font-sans)", fontSize: 18, fontWeight: 600, margin: "0 0 10px", letterSpacing: "-0.01em" }}>{q}</h3>
      <p style={{ margin: 0, fontSize: 15, color: "var(--ink-2)", lineHeight: 1.55 }}>{a}</p>
    </div>
  )
}

// =========================================================================
// Chrome (Wordmark, Nav, Footer) + primitives
// =========================================================================
function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <Link
      to="/"
      style={{ textDecoration: "none", display: "inline-flex", alignItems: "baseline", gap: 8, color: "var(--ink)" }}
    >
      <span style={{ fontFamily: "var(--font-serif)", fontSize: size, letterSpacing: "-0.02em", fontWeight: 500 }}>WeKruit</span>
      <span aria-hidden style={{ display: "inline-block", width: 4, height: 4, borderRadius: 999, background: "var(--peach-300)", alignSelf: "center" }} />
      <em style={{ fontFamily: "var(--font-serif)", fontSize: size - 2, fontStyle: "italic", fontWeight: 400, color: "var(--ink-2)" }}>Open</em>
    </Link>
  )
}

function Nav({ current }: { current?: string }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16)
    window.addEventListener("scroll", onScroll)
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  const linkStyle = (active: boolean) => ({
    fontFamily: "var(--font-sans)",
    fontSize: 14,
    color: active ? "var(--ink)" : "var(--ink-2)",
    fontWeight: active ? 500 : 400,
    textDecoration: "none",
    letterSpacing: "-0.005em",
    cursor: "pointer",
    transition: "color var(--dur-fast) var(--ease)",
    whiteSpace: "nowrap" as const,
  })

  // Layoff site is a two-page product for launch: landing and onboarding.
  // No employer signup, marketplace browse, or cross-host links from layoff.
  const navItems: { to: string; label: string; id: string }[] = [
    { to: "/", label: "For candidates", id: "landing" },
  ]

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
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 72, maxWidth: 1280, marginInline: "auto", paddingInline: 24 }}
      >
        <Wordmark />
        <nav style={{ display: "flex", gap: 32, alignItems: "center" }}>
          {navItems.map((it) => (
            <Link key={it.id} to={it.to} style={linkStyle(current === it.id)}>
              {it.label}
            </Link>
          ))}
        </nav>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link to="/onboarding" className="btn btn--primary btn--sm" style={{ textDecoration: "none" }}>
            Add your name
          </Link>
        </div>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--border)", marginTop: "var(--sp-9, 96px)" }}>
      <div
        className="container"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "40px 24px", gap: 24, flexWrap: "wrap", maxWidth: 1280, marginInline: "auto" }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <Wordmark size={18} />
          <span className="caption" style={{ color: "var(--ink-3)" }}>
            A quiet list for people between things.
          </span>
        </div>
        <div style={{ display: "flex", gap: 28, alignItems: "center" }}>
          <span className="caption">Built by WeKruit</span>
          <a className="caption" style={{ color: "var(--ink-3)" }} href="mailto:hello@wekruit.com">hello@wekruit.com</a>
        </div>
      </div>
    </footer>
  )
}

function Dot({ color = "var(--ink)", pulse }: { color?: string; pulse?: boolean }) {
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
        letterSpacing: "-0.005em",
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

function LinkedInIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.95v5.66H9.36V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.26 2.37 4.26 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.99 0 1.78-.77 1.78-1.72V1.72C24 .77 23.21 0 22.22 0z" />
    </svg>
  )
}

function Animations() {
  return (
    <style>{`
      @keyframes wko-marquee {
        from { transform: translateX(0); }
        to   { transform: translateX(-50%); }
      }
      @keyframes wko-pulse {
        0%, 100% { transform: scale(0.9); opacity: 0.25; }
        50%      { transform: scale(1.6); opacity: 0; }
      }
    `}</style>
  )
}
