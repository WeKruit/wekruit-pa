/**
 * iter31 — public privacy + terms page served at /legal.
 *
 * Linked from the onboarding ToS step (Q_PROMPTS.ask_q_tos) so biz testers
 * can review before replying "agree". Unauthenticated route — must render
 * outside the dashboard auth wall.
 *
 * Adam directive 2026-05-04 ("1. email verification & privacy + terms"):
 * placeholder copy that is honest about the v1 scope. Adam can iterate by
 * editing this file directly; the URL stays stable.
 */
export default function Legal() {
  const updatedAt = "May 27, 2026"
  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "2rem 1.25rem 4rem",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        lineHeight: 1.55,
        color: "#0f172a",
      }}
    >
      <header style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "1rem", marginBottom: "1.5rem" }}>
        <p style={{ color: "#64748b", fontSize: "0.85em", margin: 0, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          wekruit · personal-assistant
        </p>
        <h1 style={{ margin: "0.4rem 0 0 0", fontSize: "1.7em" }}>Privacy &amp; Terms</h1>
        <p style={{ margin: "0.4rem 0 0 0", color: "#64748b", fontSize: "0.85em" }}>
          Version v1.1 · Last updated {updatedAt}
        </p>
      </header>

      <section style={{ marginBottom: "1.6rem" }}>
        <h2 style={{ fontSize: "1.15em", marginBottom: "0.4rem" }}>What this is</h2>
        <p>
          Claire is a personal-assistant agent that talks with you over iMessage / SMS to help with
          job search, interview prep, and referrals. She remembers parts of your conversation so
          she can surface relevant jobs and follow up later.
        </p>
      </section>

      <section style={{ marginBottom: "1.6rem" }}>
        <h2 style={{ fontSize: "1.15em", marginBottom: "0.4rem" }}>What we store</h2>
        <ul>
          <li>Your iMessage chat history with Claire (encrypted in transit, stored in Firestore)</li>
          <li>Onboarding answers you choose to share: target role, years of experience, visa status, location preferences</li>
          <li>Your résumé / CV when you send one</li>
          <li>Optional contact email if you opt in to the email verification step</li>
          <li>Memory facts Claire extracts (e.g. "user is a senior frontend engineer in NYC")</li>
        </ul>
      </section>

      <section style={{ marginBottom: "1.6rem" }}>
        <h2 style={{ fontSize: "1.15em", marginBottom: "0.4rem" }}>What we don't store</h2>
        <ul>
          <li>Government IDs, SSN, payment info, passwords — please don't send these</li>
          <li>Verification codes — only a one-way hash is kept while the code is active</li>
          <li>Phone-book contacts of other people</li>
        </ul>
      </section>

      <section style={{ marginBottom: "1.6rem" }}>
        <h2 style={{ fontSize: "1.15em", marginBottom: "0.4rem" }}>Who can see your data</h2>
        <p>
          The wekruit team operates Claire and may read conversations to debug issues, improve quality,
          and respond to support requests. Operators may pause Claire's auto-replies in your conversation
          and respond manually as part of human-in-the-loop. We do not sell your data to third parties.
        </p>
        <p>
          <b>Partner referrals.</b> If you arrived at WeKruit through a referral link from a partner
          site (such as a layoff-tracking service that included <code>?source=&lt;partner&gt;</code> in
          the URL you clicked), we share your candidacy progress with that partner. Specifically: your
          email, name, the jobs you've started pre-screening for, and the status of each pre-screen
          (in progress / passed / not passed / paused). We do not share your résumé, conversation
          transcript, or other sensitive details with the partner. You can request that we stop
          sharing by emailing <a href="mailto:hello@wekruit.com">hello@wekruit.com</a>.
        </p>
      </section>

      <section style={{ marginBottom: "1.6rem" }}>
        <h2 style={{ fontSize: "1.15em", marginBottom: "0.4rem" }}>Your choices</h2>
        <ul>
          <li>
            <b>Decline memory:</b> reply "no" / "decline" to the privacy prompt — Claire will keep
            chatting but won't store memory beyond the message log.
          </li>
          <li>
            <b>Stop:</b> reply "stop" / "停止" / "停止提醒" any time and Claire pauses outbound nudges.
          </li>
          <li>
            <b>Delete memory:</b> reply "清空记忆" or "clear memory" and Claire wipes her stored facts.
          </li>
          <li>
            <b>Email questions:</b> <a href="mailto:hello@wekruit.com">hello@wekruit.com</a>.
          </li>
        </ul>
      </section>

      <section style={{ marginBottom: "1.6rem" }}>
        <h2 style={{ fontSize: "1.15em", marginBottom: "0.4rem" }}>Partners we share with</h2>
        <p>Current referral partners:</p>
        <ul>
          <li>
            <a href="https://layoffhedge.com" target="_blank" rel="noreferrer">
              layoffhedge.com
            </a>{" "}
            — layoff-tracking and job-discovery service.
          </li>
        </ul>
        <p>
          When we add a new partner, this list is updated in the same release that adds the partner's
          referral link support.
        </p>
      </section>

      <section style={{ marginBottom: "1.6rem" }}>
        <h2 style={{ fontSize: "1.15em", marginBottom: "0.4rem" }}>Beta caveats</h2>
        <p>
          You're using a closed beta. The product can change without notice. Replies are generated by
          a language model and can be wrong — never act on advice without verifying. Don't send
          anything you're not OK being read by an operator.
        </p>
      </section>

      <footer style={{ marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid #e2e8f0", color: "#94a3b8", fontSize: "0.85em" }}>
        <p>© 2026 wekruit · operated from the United States</p>
      </footer>
    </div>
  )
}
