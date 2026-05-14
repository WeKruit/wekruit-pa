/**
 * Candidate home page.
 *
 * This route is the front door to the same candidate journey as `/j/:jobId`.
 * Keep it visually aligned with the public job, login, profile, and matches
 * surfaces instead of sending candidates straight to a generic SMS deep link.
 */
import { useEffect } from "react"

const FEATURED_JOB_ID = "hs-11005382-invoko-product-designer"
const FEATURED_JOB_PATH = `/j/${FEATURED_JOB_ID}`

const STYLES = `
* { box-sizing: border-box; }
body.candidate-home-bg {
  margin: 0;
  min-height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: #f6f2ea;
  color: #1f2a23;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.candidate-home-shell {
  width: min(760px, 100%);
  margin: 0 auto;
  padding: 28px 20px 40px;
}
.candidate-home-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 48px;
}
.candidate-home-wordmark {
  font-size: 1.1rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: #1f2a23;
  text-decoration: none;
}
.candidate-home-nav {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 0.92rem;
}
.candidate-home-nav a {
  color: #5f665b;
  text-decoration: none;
}
.candidate-home-nav a:hover {
  color: #1f2a23;
}
.candidate-home-badge {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  margin-bottom: 18px;
  padding: 6px 12px;
  border: 1px solid #d7cebe;
  border-radius: 999px;
  background: #fffaf0;
  color: #6f6251;
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.candidate-home-h1 {
  max-width: 690px;
  margin: 0;
  color: #172018;
  font-size: clamp(2.8rem, 9vw, 5.8rem);
  line-height: 0.95;
  letter-spacing: 0;
  font-weight: 850;
}
.candidate-home-accent {
  color: #2f6f4f;
}
.candidate-home-lede {
  max-width: 620px;
  margin: 24px 0 0;
  color: #5f665b;
  font-size: clamp(1.05rem, 2.4vw, 1.35rem);
  line-height: 1.55;
}
.candidate-home-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 34px;
}
.candidate-home-primary,
.candidate-home-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 52px;
  padding: 0 22px;
  border-radius: 999px;
  font-size: 1rem;
  font-weight: 800;
  text-decoration: none;
}
.candidate-home-primary {
  background: #2f6f4f;
  color: #fff7df;
  box-shadow: 0 12px 28px rgba(47, 111, 79, 0.18);
}
.candidate-home-primary:hover {
  background: #25593f;
}
.candidate-home-secondary {
  border: 1px solid #d7cebe;
  background: #fffdf8;
  color: #2f6f4f;
}
.candidate-home-secondary:hover {
  border-color: #2f6f4f;
}
.candidate-home-job {
  margin-top: 42px;
  padding: 24px;
  border: 1px solid #e3dccd;
  border-radius: 18px;
  background: #fffaf0;
}
.candidate-home-job-eyebrow {
  margin: 0 0 8px;
  color: #7a6f5d;
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.candidate-home-job-title {
  margin: 0;
  font-size: clamp(1.4rem, 4vw, 2rem);
  line-height: 1.1;
  color: #172018;
}
.candidate-home-job-meta {
  margin: 8px 0 0;
  color: #5f665b;
}
.candidate-home-job-copy {
  margin: 16px 0 0;
  color: #3f4a42;
  line-height: 1.55;
}
.candidate-home-footer {
  margin-top: 48px;
  color: #8a7d68;
  font-size: 0.85rem;
}
.candidate-home-footer a {
  color: #5f665b;
}
@media (max-width: 560px) {
  .candidate-home-shell {
    padding: 22px 16px 32px;
  }
  .candidate-home-header {
    margin-bottom: 34px;
  }
  .candidate-home-nav {
    font-size: 0.86rem;
  }
  .candidate-home-primary,
  .candidate-home-secondary {
    width: 100%;
  }
}
`

export default function Landing() {
  useEffect(() => {
    document.body.classList.add("candidate-home-bg")
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
      // sessionStorage blocked - non-fatal
    }
    return () => {
      document.body.classList.remove("candidate-home-bg")
    }
  }, [])

  return (
    <>
      <style>{STYLES}</style>
      <main className="candidate-home-shell">
        <header className="candidate-home-header">
          <a className="candidate-home-wordmark" href="/">
            WeKruit
          </a>
          <nav className="candidate-home-nav" aria-label="Candidate navigation">
            <a href="/me/matches">Matches</a>
            <a href="/me/profile">Profile</a>
          </nav>
        </header>

        <section aria-labelledby="candidate-home-title">
          <span className="candidate-home-badge">Candidate marketplace</span>
          <h1 id="candidate-home-title" className="candidate-home-h1">
            Start with a real role. <span className="candidate-home-accent">Claire handles the screen.</span>
          </h1>
          <p className="candidate-home-lede">
            Browse the current public role, upload your resume on the job page, then continue with Claire over iMessage.
          </p>
          <div className="candidate-home-actions">
            <a className="candidate-home-primary" href={FEATURED_JOB_PATH}>
              View current role
            </a>
            <a className="candidate-home-secondary" href="sms:+13054507715&body=hi">
              Text Claire
            </a>
          </div>
        </section>

        <a className="candidate-home-job" href={FEATURED_JOB_PATH} style={{ display: "block", textDecoration: "none" }}>
          <p className="candidate-home-job-eyebrow">Open now</p>
          <h2 className="candidate-home-job-title">Product Designer</h2>
          <p className="candidate-home-job-meta">Invoko · Candidate pre-screen available</p>
          <p className="candidate-home-job-copy">
            This opens the same public job page candidates use to read the role, upload a CV, and start the 5-minute screen.
          </p>
        </a>

        <footer className="candidate-home-footer">
          <a href="/legal">Privacy &amp; Terms</a>
        </footer>
      </main>
    </>
  )
}
