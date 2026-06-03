/**
 * Privacy & Terms page — preserves exact content from the prior static
 * apps/pa-landing/public/legal/index.html. Linked from the landing footer
 * and the public job page footer.
 */
import { useEffect } from "react"

const STYLES = `
body.legal-bg {
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.55;
  color: #0f172a;
  background: #fff;
}
.legal-header { border-bottom: 1px solid #e2e8f0; padding-bottom: 1rem; margin-bottom: 1.5rem; }
.legal-eyebrow { color: #64748b; font-size: 0.85em; margin: 0; text-transform: uppercase; letter-spacing: 0.04em; }
.legal-h1 { margin: 0.4rem 0 0 0; font-size: 1.7em; }
.legal-h1, .legal-h2 { color: #0f172a; }
.legal-meta { margin: 0.4rem 0 0 0; color: #64748b; font-size: 0.85em; }
.legal-section { margin-bottom: 1.6rem; }
.legal-h2 { font-size: 1.15em; margin-bottom: 0.4rem; }
.legal-section p, .legal-section li { color: #1e293b; }
.legal-link { color: #0369a1; }
.legal-footer {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid #e2e8f0;
  color: #94a3b8;
  font-size: 0.85em;
}
`

export default function Legal() {
  useEffect(() => {
    document.body.classList.add("legal-bg")
    document.title = "Privacy & Terms — Claire (WeKruit)"
    return () => {
      document.body.classList.remove("legal-bg")
    }
  }, [])

  return (
    <>
      <style>{STYLES}</style>
      <header className="legal-header">
        <p className="legal-eyebrow">wekruit · personal-assistant</p>
        <h1 className="legal-h1">Privacy &amp; Terms</h1>
        <p className="legal-meta">Version v1.1 · Last updated May 27, 2026</p>
      </header>

      <section className="legal-section">
        <h2 className="legal-h2">What this is</h2>
        <p>
          Claire is a personal-assistant agent that talks with you over iMessage / SMS to help with
          job search, interview prep, and referrals. She remembers parts of your conversation so
          she can surface relevant jobs and follow up later.
        </p>
      </section>

      <section className="legal-section">
        <h2 className="legal-h2">What we store</h2>
        <ul>
          <li>Your iMessage chat history with Claire (encrypted in transit, stored in Firestore)</li>
          <li>Onboarding answers you choose to share: target role, years of experience, visa status, location preferences</li>
          <li>Your résumé / CV when you send one</li>
          <li>Optional contact email if you opt in to the email verification step</li>
          <li>Memory facts Claire extracts (e.g. "user is a senior frontend engineer in NYC")</li>
        </ul>
      </section>

      <section className="legal-section">
        <h2 className="legal-h2">What we don't store</h2>
        <ul>
          <li>Government IDs, SSN, payment info, passwords — please don't send these</li>
          <li>Verification codes — only a one-way hash is kept while the code is active</li>
          <li>Phone-book contacts of other people</li>
        </ul>
      </section>

      <section className="legal-section">
        <h2 className="legal-h2">Who can see your data</h2>
        <p>
          The wekruit team operates Claire and may read conversations to debug issues, improve
          quality, and respond to support requests. Operators may pause Claire's auto-replies in
          your conversation and respond manually as part of human-in-the-loop. We do not sell your
          data to third parties.
        </p>
        <p>
          <b>Partner referrals.</b> If you arrived at WeKruit through a referral link from a
          partner site (such as a layoff-tracking service that included{" "}
          <code>?source=&lt;partner&gt;</code> in the URL you clicked), we share your candidacy
          progress with that partner. Specifically: your email, name, the jobs you've started
          pre-screening for, and the status of each pre-screen (in progress / passed / not
          passed / paused). We do not share your résumé, conversation transcript, or other
          sensitive details with the partner. You can request that we stop sharing by emailing{" "}
          <a className="legal-link" href="mailto:hello@wekruit.com">hello@wekruit.com</a>.
        </p>
      </section>

      <section className="legal-section">
        <h2 className="legal-h2">Your choices</h2>
        <ul>
          <li>
            <b>Decline memory:</b> reply "no" / "decline" to the privacy prompt — Claire will keep
            chatting but won't store memory beyond the message log.
          </li>
          <li>
            <b>Stop:</b> reply "stop" / "停止" / "停止提醒" any time and Claire pauses outbound
            nudges.
          </li>
          <li>
            <b>Delete memory:</b> reply "清空记忆" or "clear memory" and Claire wipes her stored
            facts.
          </li>
          <li>
            <b>Email questions:</b>{" "}
            <a className="legal-link" href="mailto:hello@wekruit.com">
              hello@wekruit.com
            </a>
            .
          </li>
        </ul>
      </section>

      <section className="legal-section">
        <h2 className="legal-h2">Partners we share with</h2>
        <p>Current referral partners:</p>
        <ul>
          <li>
            <a className="legal-link" href="https://layoffhedge.com" target="_blank" rel="noreferrer">
              layoffhedge.com
            </a>
            {" "}— layoff-tracking and job-discovery service.
          </li>
        </ul>
        <p>
          When we add a new partner, this list is updated in the same release that adds the
          partner's referral link support.
        </p>
      </section>

      <section className="legal-section">
        <h2 className="legal-h2">Beta caveats</h2>
        <p>
          You're using a closed beta. The product can change without notice. Replies are generated
          by a language model and can be wrong — never act on advice without verifying. Don't send
          anything you're not OK being read by an operator.
        </p>
      </section>

      <footer className="legal-footer">
        <p>
          © 2026 wekruit · operated from the United States ·{" "}
          <a className="legal-link" href="/">
            back to landing
          </a>
        </p>
      </footer>
    </>
  )
}
