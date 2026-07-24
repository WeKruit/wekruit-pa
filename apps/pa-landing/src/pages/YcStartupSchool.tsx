/**
 * YcStartupSchool.tsx - `/yc-startup` on wekruit.com.
 *
 * Funnel page for YC Startup School attendees. The page routes people into the
 * existing login/onboarding flow with `yc_startup_school` attribution, but the
 * message is SF people matching rather than hiring search.
 */
import { useEffect } from "react"
import { Link } from "react-router-dom"
import { trackEvent } from "../lib/analytics.js"
import { stickExplicitSource } from "../lib/source.js"

const YC_SOURCE = "yc_startup_school" as const
const ONBOARDING_HREF = `/onboarding?source=${YC_SOURCE}`
const LOGIN_HREF = `/login?next=${encodeURIComponent(ONBOARDING_HREF)}`
const TICKER_COPY = "STARTUP SCHOOL ATTENDEES x WEKRUIT x "

export default function YcStartupSchool() {
  useEffect(() => {
    stickExplicitSource(YC_SOURCE)
    void trackEvent("partner_page_view", { source: YC_SOURCE, path: "/yc-startup" })
  }, [])

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
          <img src="/wekruit-logo.png" alt="" aria-hidden="true" />
        </Link>
        <div className="ycs-event-chip" aria-label="For attendees of YC Startup School 2026">
          <span>For attendees</span>
          <small>OF YC STARTUP SCHOOL 2026</small>
          <small>MATCHING WHEN THERE'S FIT</small>
        </div>
        <div className="ycs-nav-right">
          <Link to={LOGIN_HREF} className="ycs-signin">SIGN IN</Link>
          <Link to={ONBOARDING_HREF} className="ycs-btn ycs-btn--solid ycs-btn--nav">Meet people</Link>
        </div>
      </header>

      <section className="ycs-hero">
        <div className="ycs-hero-corner ycs-hero-corner--left">
          <h1>
            YC Startup School,<br />
            <em>matched.</em>
          </h1>
          <p className="ycs-hero-sub">people matching by WeKruit</p>
        </div>
        <div className="ycs-sun" aria-hidden="true">
          <div className="ycs-sun-core" />
          <div className="ycs-sun-copy">
            <span className="ycs-sun-big">MEET</span>
            <span className="ycs-sun-label">P E O P L E</span>
            <span className="ycs-sun-tick">interests x experience</span>
          </div>
        </div>
        <div className="ycs-hero-corner ycs-hero-corner--right" aria-hidden="true" />
      </section>

      <div className="ycs-rule" />

      <main className="ycs-main">
        <section id="about" className="ycs-card">
          <p className="ycs-slug">/ABOUT</p>
          <h3>Going to Startup School? Leave with the right SF network.</h3>
          <p>
            WeKruit helps Startup School attendees meet the people who can make
            the week count: founders, investors, operators, and other builders
            across San Francisco. Tell Claire what you are building, what you are
            curious about, and who would make the trip more useful.
          </p>
          <p className="ycs-strong">One context layer for better conversations</p>
          <p>
            Claire keeps that context in iMessage and uses it to suggest high-signal
            conversations while you are in SF. Less random networking, more people
            who understand your stage, market, and questions before you meet.
          </p>
          <p className="ycs-strong">WeKruit handles the matching</p>
          <p>
            Sign in and give Claire a quick intro of what you are building, and right
            after that we will use it to match you with relevant Startup School
            people instead of dropping you into a generic attendee list.
          </p>
          <div className="ycs-cta-row">
            <Link
              to={ONBOARDING_HREF}
              className="ycs-btn ycs-btn--solid"
              onClick={() => void trackEvent("yc_startup_cta", { cta: "join" })}
            >
              Start yapping -&gt;
            </Link>
          </div>
        </section>

        <section id="how" className="ycs-card">
          <p className="ycs-slug">/HOW</p>
          <h3>How people matching works</h3>
          <ol className="ycs-steps">
            <li><strong>01 - Sign in.</strong> Email magic link or LinkedIn. Returning WeKruit users keep their existing profile.</li>
            <li><strong>02 - Share context.</strong> Tell Claire what you are building, who you want to learn from, and what kind of conversations would change the trip. Claire uses that context to match you with relevant Startup School people.</li>
            <li><strong>03 - Match people.</strong> Claire looks for founders, investors, and operators in SF with overlapping interests or useful context.</li>
            <li><strong>04 - Meet in SF.</strong> When there is a strong reason to talk, Claire helps open the next step with context already attached.</li>
          </ol>
        </section>
      </main>

      <div className="ycs-ticker" aria-hidden="true">
        <div className="ycs-ticker-track">
          <span>{TICKER_COPY.repeat(6)}</span>
          <span>{TICKER_COPY.repeat(6)}</span>
        </div>
      </div>

      <section className="ycs-closer">
        <p>
          Meet the people<br />
          building <em>what&apos;s next</em>
        </p>
        <Link to={ONBOARDING_HREF} className="ycs-btn ycs-btn--solid ycs-btn--big">Meet people -&gt;</Link>
      </section>

      <footer className="ycs-footer">
        <span>WEKRUIT x YC STARTUP SCHOOL ATTENDEES</span>
        <nav className="ycs-footer-links" aria-label="WeKruit">
          <Link to="/" className="ycs-inline-link">WEKRUIT</Link>
          <Link to="/me" className="ycs-inline-link">MY WEKRUIT</Link>
          <Link to="/employers" className="ycs-inline-link">FOR EMPLOYERS</Link>
          <Link to="/legal" className="ycs-inline-link">LEGAL</Link>
        </nav>
        <span>NOT AFFILIATED WITH Y COMBINATOR</span>
      </footer>
    </div>
  )
}

const YCS_STYLES = `
.ycs {
  --ycs-orange: #D9541F;
  --ycs-orange-soft: rgba(217, 84, 31, 0.10);
  min-height: 100vh;
  background: var(--cream, #F5EDE3);
  color: var(--ink, #2D1A0A);
  font-family: var(--font-sans, 'Hanken Grotesk', -apple-system, sans-serif);
  letter-spacing: 0.005em;
}
.ycs a { color: inherit; text-decoration: none; }
.ycs h1, .ycs h2, .ycs h3 { font-family: var(--font-serif, 'Newsreader', Georgia, serif); font-weight: 400; }
.ycs-slug, .ycs-signin, .ycs-pill, .ycs-hero-corner--right p,
.ycs-ticker-track span, .ycs-footer, .ycs-sun-copy {
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
}

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
  width: 28px;
  height: 40px;
  color: var(--ink, #2D1A0A);
}
.ycs .ycs-mark img {
  display: block;
  width: 28px;
  height: 40px;
  object-fit: contain;
}
.ycs-event-chip {
  display: grid;
  justify-items: center;
  gap: 3px;
  min-width: 230px;
  margin: 0 auto;
  text-align: center;
}
.ycs-event-chip span {
  font-family: var(--font-serif, Georgia, serif);
  font-size: 17px;
  font-style: italic;
  line-height: 1;
  color: var(--ink, #2D1A0A);
}
.ycs-event-chip small {
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--ink-3, #897462);
}
.ycs-signin { font-size: 12px; letter-spacing: 0.14em; }
.ycs-signin:hover { color: var(--ycs-orange); }

.ycs-hero {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: start;
  justify-content: space-between;
  padding: 22px clamp(16px, 4vw, 48px);
  border-top: 1px solid var(--border, #E3D6C3);
  overflow: hidden;
  background: var(--cream, #F5EDE3);
}
.ycs-hero-corner h1 {
  margin: 0;
  font-size: clamp(30px, 3.4vw, 46px);
  line-height: 1.08;
  letter-spacing: 0;
}
.ycs-hero-corner h1 em, .ycs-closer em { font-style: italic; color: var(--ycs-orange); }
.ycs-hero-corner--right { text-align: right; }
.ycs-hero-sub { margin: 12px 0 0; font-size: 14px; color: var(--ink-2, #5A4636); }

.ycs-sun {
  position: relative;
  align-self: end;
  width: clamp(320px, 48vw, 760px);
  height: clamp(220px, 30vw, 420px);
  overflow: visible;
  display: grid;
  place-items: end center;
  margin-bottom: -22px;
}
.ycs-sun-core {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 100%;
  height: 100%;
  transform: translateX(-50%);
  background:
    repeating-linear-gradient(90deg, rgba(245, 237, 227, 0.18) 0 1px, transparent 1px 28px),
    radial-gradient(circle at 50% 100%,
      var(--ycs-orange) 0%,
      #F04E1B 38%,
      rgba(240, 78, 27, 0.75) 52%,
      rgba(232, 169, 136, 0.42) 67%,
      rgba(245, 237, 227, 0) 82%);
  border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  filter: blur(10px);
}
.ycs-sun-copy {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 8px;
  padding-bottom: 32px;
  color: var(--cream, #F5EDE3);
  text-align: center;
}
.ycs-sun-big {
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
  font-size: clamp(44px, 6.4vw, 88px);
  font-weight: 700;
  line-height: 0.95;
  letter-spacing: 0.04em;
}
.ycs-sun-label { font-size: clamp(12px, 1.3vw, 17px); letter-spacing: 0.5em; }
.ycs-sun-tick { font-size: 11px; letter-spacing: 0.16em; opacity: 0.92; }

.ycs-rule { border-top: 1px solid var(--border, #E3D6C3); }

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
.ycs-steps { margin: 0 0 14px; padding-left: 0; display: grid; gap: 10px; list-style: none; }
.ycs-strong { font-weight: 700; color: var(--ink, #2D1A0A); }
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
.ycs .ycs-btn--solid { background: var(--ink, #2D1A0A); border-color: var(--ink, #2D1A0A); color: var(--cream, #F5EDE3); }
.ycs .ycs-btn--solid:hover { background: var(--ycs-orange); border-color: var(--ycs-orange); color: #FFF8F0; }
.ycs-btn--big { padding: 16px 36px; font-size: 17px; }

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
  letter-spacing: 0;
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

@media (max-width: 1040px) {
  .ycs-event-chip { display: none; }
}

@media (max-width: 780px) {
  .ycs-hero { grid-template-columns: 1fr; justify-items: center; text-align: center; min-height: 0; row-gap: 16px; }
  .ycs-hero-corner--right { display: none; }
  .ycs-signin { display: none; }
  .ycs-sun { width: min(100vw, 540px); margin-bottom: -22px; }
}
`
