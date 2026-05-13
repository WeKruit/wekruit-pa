/**
 * Claire CTA landing page — preserves the exact black-gradient look from
 * the prior static apps/pa-landing/public/index.html (iter33 spec 2026-05-05).
 *
 * Lives at `/` of the candidate Vite SPA (apps/pa-landing). Same site also
 * serves `/legal`, `/j/:jobId`, `/j/:jobId/cv`. Default URL:
 * https://wekruit-pa-landing.web.app. Custom domains: candidate.wekruit.com,
 * pa.wekruit.com (both CNAME → wekruit-pa-landing.web.app via Cloudflare).
 */
import { useEffect } from "react"

const STYLES = `
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; }
body.landing-bg {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: linear-gradient(180deg, #0a0a0a 0%, #1a1a1a 100%);
  color: #fafafa;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 24px;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.landing-wrap {
  max-width: 480px;
  width: 100%;
  text-align: center;
  animation: landing-fade 0.6s ease;
}
@keyframes landing-fade {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.landing-badge {
  display: inline-block;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 6px 12px;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 999px;
  color: rgba(255,255,255,0.7);
  margin-bottom: 24px;
  text-transform: uppercase;
}
.landing-h1 {
  font-size: clamp(32px, 6vw, 44px);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
  margin-bottom: 16px;
}
.landing-accent {
  background: linear-gradient(135deg, #34d399, #06b6d4);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.landing-lede {
  font-size: 17px;
  line-height: 1.5;
  color: rgba(255,255,255,0.72);
  margin-bottom: 36px;
}
.landing-cta {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 18px 32px;
  font-size: 17px;
  font-weight: 600;
  color: #0a0a0a;
  background: #fafafa;
  border: none;
  border-radius: 14px;
  cursor: pointer;
  text-decoration: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
  box-shadow: 0 4px 14px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05);
  -webkit-tap-highlight-color: transparent;
}
.landing-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.1); }
.landing-cta:active { transform: translateY(0); background: #e5e5e5; }
.landing-cta svg { width: 20px; height: 20px; }
.landing-hint {
  margin-top: 18px;
  font-size: 13px;
  color: rgba(255,255,255,0.4);
}
.landing-number {
  margin-top: 24px;
  font-size: 13px;
  color: rgba(255,255,255,0.55);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: 0.02em;
}
.landing-number a {
  color: rgba(255,255,255,0.85);
  text-decoration: none;
  border-bottom: 1px dashed rgba(255,255,255,0.3);
}
.landing-footer {
  position: absolute;
  bottom: 24px;
  font-size: 12px;
  color: rgba(255,255,255,0.35);
}
.landing-footer a { color: rgba(255,255,255,0.55); text-decoration: none; }
.landing-footer a:hover { color: rgba(255,255,255,0.8); }
@media (prefers-color-scheme: light) {
  body.landing-bg { background: linear-gradient(180deg, #fafafa 0%, #e5e5e5 100%); color: #0a0a0a; }
  .landing-badge { border-color: rgba(0,0,0,0.12); color: rgba(0,0,0,0.6); }
  .landing-lede { color: rgba(0,0,0,0.65); }
  .landing-cta { color: #fafafa; background: #0a0a0a; box-shadow: 0 4px 14px rgba(0,0,0,0.15); }
  .landing-cta:active { background: #1a1a1a; }
  .landing-hint, .landing-number { color: rgba(0,0,0,0.45); }
  .landing-number a { color: rgba(0,0,0,0.75); border-bottom-color: rgba(0,0,0,0.25); }
  .landing-footer { color: rgba(0,0,0,0.4); }
  .landing-footer a { color: rgba(0,0,0,0.6); }
}
`

export default function Landing() {
  useEffect(() => {
    // Apply landing-specific body background (other routes use default).
    document.body.classList.add("landing-bg")
    // iter33 — light analytics breadcrumb.
    try {
      const utm = new URLSearchParams(location.search)
      sessionStorage.setItem(
        "pa_landing_visit",
        JSON.stringify({
          ts: new Date().toISOString(),
          ref: document.referrer || null,
          src: utm.get("src") || null,
          ua: navigator.userAgent.slice(0, 200),
        })
      )
    } catch {
      // sessionStorage blocked — non-fatal
    }
    return () => {
      document.body.classList.remove("landing-bg")
    }
  }, [])

  return (
    <>
      <style>{STYLES}</style>
      <main className="landing-wrap">
        <span className="landing-badge">Beta · iMessage only</span>
        <h1 className="landing-h1">
          Text <span className="landing-accent">Claire</span>.<br />
          Land your next job.
        </h1>
        <p className="landing-lede">
          Skip the apply-and-pray. Claire finds matches, drafts intros, surfaces referrals — over
          iMessage. Like texting a friend who knows the market.
        </p>
        <a
          className="landing-cta"
          href="sms:+13054507715&body=hi"
          onClick={(e) => {
            const el = e.currentTarget
            el.style.transform = "translateY(0)"
            el.style.background = "#34d399"
            setTimeout(() => {
              el.style.background = ""
            }, 200)
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Text Claire on iMessage
        </a>
        <div className="landing-hint">Tap from your iPhone — opens the Messages app prefilled with "hi"</div>
        <div className="landing-number">
          or text{" "}
          <a href="sms:+13054507715&body=hi">+1 (305) 450-7715</a>
        </div>
      </main>
      <footer className="landing-footer">
        Built by <a href="https://wekruit.com" target="_blank" rel="noopener noreferrer">WeKruit</a>
        {" · "}
        <a href="/legal">Privacy &amp; Terms</a>
      </footer>
    </>
  )
}
