/**
 * Partner API documentation portal — /docs/partner/:token
 *
 * Token-gated: the URL path segment is SHA-256-hashed client-side and
 * compared against DOC_TOKEN_SHA256. Only the hash ships in the bundle;
 * the plaintext token lives in the share link WeKruit hands to partners.
 * Wrong/missing token renders a 404-look page (no hint docs exist).
 *
 * Covers both partner-facing APIs (one shared API key):
 *   - Jobs API   GET /api/v1/partner/jobs?source=collab  (paPublicOpenJobs)
 *   - Users API  GET /api/v1/partner/users               (paPartnerUsersApi)
 *
 * Content sources of truth:
 *   apps/functions/docs/PUBLIC-JOBS-API.md
 *   docs/partner-api/partner-users-api-v1.md
 */
import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"

// sha256("wk6123eb3eca3cb6efdd5dd5af5110") — rotate by replacing this hash.
const DOC_TOKEN_SHA256 = "a4a8e7eb3c0712e6ec0c60da9d54da97eb46ea3bceb9b62f4aa115130cae00f8"

const STYLES = `
body.apidoc-bg { background: #fff; }
.apidoc-shell {
  display: flex;
  max-width: 1180px;
  margin: 0 auto;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #1e293b;
  line-height: 1.6;
}
/* Hard reset against the landing global stylesheet (wekruit-tokens.css paints
   every <code> cream-on-ink with padding, and all headings serif). This page
   must be visually self-contained, so neutralize those globals in-scope and
   re-declare the doc styles below with .apidoc-shell-prefixed specificity. */
.apidoc-shell code, .apidoc-shell kbd, .apidoc-shell samp {
  background: transparent;
  padding: 0;
  border-radius: 0;
  color: inherit;
  font-family: "SF Mono", "Fira Code", Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.apidoc-shell h1, .apidoc-shell h2, .apidoc-shell h3 {
  font-family: inherit;
  letter-spacing: normal;
}
.apidoc-shell .apidoc-h1 { font-weight: 700; }
.apidoc-shell .apidoc-h2 { font-weight: 700; }
.apidoc-shell .apidoc-h3 { font-weight: 600; }
.apidoc-shell .apidoc-endpoint code { color: #e2e8f0; background: transparent; padding: 0; }
.apidoc-shell .apidoc-inline-code {
  background: #f1f5f9;
  border-radius: 4px;
  padding: 0.12em 0.35em;
  color: #be185d;
}
.apidoc-shell .apidoc-table code {
  background: #f1f5f9;
  border-radius: 3px;
  padding: 0.1em 0.3em;
  color: #be185d;
  white-space: nowrap;
}
.apidoc-notfound h1 { font-family: system-ui, sans-serif; }
.apidoc-nav {
  position: sticky;
  top: 0;
  align-self: flex-start;
  width: 230px;
  flex-shrink: 0;
  padding: 2rem 1rem 2rem 1.25rem;
  height: 100vh;
  overflow-y: auto;
  border-right: 1px solid #e2e8f0;
}
.apidoc-nav-brand { font-weight: 700; font-size: 1.02em; color: #0f172a; margin-bottom: 0.1rem; }
.apidoc-nav-sub { font-size: 0.78em; color: #64748b; margin-bottom: 1.4rem; }
.apidoc-nav-group { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8; font-weight: 600; margin: 1.1rem 0 0.35rem; }
.apidoc-nav a {
  display: block;
  padding: 0.28rem 0.5rem;
  border-radius: 5px;
  color: #334155;
  text-decoration: none;
  font-size: 0.88em;
}
.apidoc-nav a:hover { background: #f1f5f9; color: #0f172a; }
.apidoc-main {
  flex: 1;
  min-width: 0;
  padding: 2rem 2rem 5rem;
}
.apidoc-eyebrow { color: #64748b; font-size: 0.8em; margin: 0; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
.apidoc-h1 { margin: 0.4rem 0 0.2rem; font-size: 1.7em; color: #0f172a; }
.apidoc-meta { margin: 0; color: #64748b; font-size: 0.88em; }
.apidoc-section { margin-top: 2.6rem; scroll-margin-top: 1.5rem; }
.apidoc-h2 { font-size: 1.3em; color: #0f172a; margin: 0 0 0.6rem; padding-bottom: 0.35rem; border-bottom: 1px solid #e2e8f0; }
.apidoc-h3 { font-size: 1.02em; color: #0f172a; margin: 1.4rem 0 0.4rem; }
.apidoc-p { margin: 0.5rem 0; color: #334155; }
.apidoc-ul { padding-left: 1.4rem; margin: 0.5rem 0; }
.apidoc-ul li { margin: 0.3rem 0; color: #334155; }
.apidoc-endpoint {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  background: #0f172a;
  border-radius: 8px;
  padding: 0.7rem 1rem;
  margin: 0.7rem 0;
  overflow-x: auto;
}
.apidoc-method {
  background: #16a34a;
  color: #fff;
  font-weight: 700;
  font-size: 0.72em;
  letter-spacing: 0.04em;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  flex-shrink: 0;
}
.apidoc-endpoint code {
  color: #e2e8f0;
  font-family: "SF Mono", "Fira Code", Menlo, Consolas, monospace;
  font-size: 0.88em;
  white-space: nowrap;
}
.apidoc-code {
  display: block;
  background: #0f172a;
  border-radius: 8px;
  padding: 0.9rem 1.1rem;
  font-family: "SF Mono", "Fira Code", Menlo, Consolas, monospace;
  font-size: 0.82em;
  overflow-x: auto;
  white-space: pre;
  color: #e2e8f0;
  margin: 0.6rem 0;
  line-height: 1.55;
}
.apidoc-inline-code {
  background: #f1f5f9;
  border-radius: 4px;
  padding: 0.12em 0.35em;
  font-family: "SF Mono", "Fira Code", Menlo, Consolas, monospace;
  font-size: 0.87em;
  color: #be185d;
}
.apidoc-table { width: 100%; border-collapse: collapse; margin: 0.6rem 0 1rem; font-size: 0.88em; }
.apidoc-table th {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 2px solid #cbd5e1;
  color: #0f172a;
  font-weight: 600;
  background: #f8fafc;
  white-space: nowrap;
}
.apidoc-table td { padding: 0.45rem 0.6rem; border-bottom: 1px solid #e2e8f0; color: #334155; vertical-align: top; }
.apidoc-table tr:last-child td { border-bottom: none; }
.apidoc-table code {
  background: #f1f5f9;
  border-radius: 3px;
  padding: 0.1em 0.3em;
  font-family: "SF Mono", "Fira Code", Menlo, Consolas, monospace;
  font-size: 0.9em;
  color: #be185d;
  white-space: nowrap;
}
.apidoc-note {
  background: #fffbeb;
  border-left: 3px solid #f59e0b;
  padding: 0.65rem 1rem;
  border-radius: 0 6px 6px 0;
  margin: 0.7rem 0;
  font-size: 0.92em;
  color: #92400e;
}
.apidoc-note-blue {
  background: #eff6ff;
  border-left: 3px solid #3b82f6;
  padding: 0.65rem 1rem;
  border-radius: 0 6px 6px 0;
  margin: 0.7rem 0;
  font-size: 0.92em;
  color: #1e40af;
}
.apidoc-footer { margin-top: 3.5rem; padding-top: 1rem; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 0.82em; }
.apidoc-notfound {
  min-height: 70vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-family: system-ui, sans-serif;
  color: #475569;
  gap: 0.4rem;
}
.apidoc-notfound h1 { font-size: 2.4em; margin: 0; color: #0f172a; }
@media (max-width: 880px) {
  .apidoc-shell { flex-direction: column; }
  .apidoc-nav {
    position: static;
    width: auto;
    height: auto;
    border-right: none;
    border-bottom: 1px solid #e2e8f0;
    padding: 1.2rem 1.25rem 0.8rem;
  }
  .apidoc-nav-links { display: flex; flex-wrap: wrap; gap: 0.2rem 0.4rem; }
  .apidoc-nav-group { width: 100%; margin: 0.5rem 0 0.1rem; }
  .apidoc-main { padding: 1.2rem 1rem 4rem; }
  .apidoc-table { font-size: 0.78em; }
  .apidoc-code { font-size: 0.74em; }
}
`

const C = ({ children }: { children: string }) => (
  <code className="apidoc-inline-code">{children}</code>
)

const Endpoint = ({ url }: { url: string }) => (
  <div className="apidoc-endpoint">
    <span className="apidoc-method">GET</span>
    <code>{url}</code>
  </div>
)

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function NotFound() {
  return (
    <div className="apidoc-notfound">
      <h1>404</h1>
      <p>This page could not be found.</p>
      <a href="/" style={{ color: "#0369a1" }}>Go to wekruit.com</a>
    </div>
  )
}

export default function PartnerApiDoc() {
  const { token } = useParams<{ token: string }>()
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    document.body.classList.add("apidoc-bg")
    // tokens css paints <html> cream; overscroll/short pages would reveal it
    // around this white page, so pin it white while mounted.
    const prevHtmlBg = document.documentElement.style.backgroundColor
    document.documentElement.style.backgroundColor = "#fff"
    return () => {
      document.body.classList.remove("apidoc-bg")
      document.documentElement.style.backgroundColor = prevHtmlBg
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!token) {
      setAuthed(false)
      return
    }
    sha256Hex(token)
      .then((hex) => { if (!cancelled) setAuthed(hex === DOC_TOKEN_SHA256) })
      .catch(() => { if (!cancelled) setAuthed(false) })
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    document.title = authed
      ? "Partner API Documentation — WeKruit"
      : "WeKruit"
  }, [authed])

  if (authed === null) return <style>{STYLES}</style>
  if (!authed) return (<><style>{STYLES}</style><NotFound /></>)

  return (
    <>
      <style>{STYLES}</style>
      <div className="apidoc-shell">

        {/* ───────────────────────── sidebar ── */}
        <nav className="apidoc-nav">
          <div className="apidoc-nav-brand">WeKruit</div>
          <div className="apidoc-nav-sub">Partner API · v1</div>
          <div className="apidoc-nav-links">
            <div className="apidoc-nav-group">Start here</div>
            <a href="#overview">Overview</a>
            <a href="#authentication">Authentication</a>
            <a href="#attribution">Referral attribution</a>
            <div className="apidoc-nav-group">Jobs API</div>
            <a href="#jobs-api">Endpoint &amp; params</a>
            <a href="#jobs-response">Response</a>
            <a href="#jobs-caching">Caching contract</a>
            <div className="apidoc-nav-group">Users API</div>
            <a href="#users-api">Endpoint &amp; params</a>
            <a href="#users-response">Response</a>
            <a href="#job-states">Job states</a>
            <div className="apidoc-nav-group">Reference</div>
            <a href="#pagination">Pagination</a>
            <a href="#errors">Errors</a>
            <a href="#examples">Examples</a>
            <a href="#versioning">Versioning &amp; limits</a>
            <a href="#contact">Contact</a>
          </div>
        </nav>

        {/* ───────────────────────── content ── */}
        <main className="apidoc-main">
          <p className="apidoc-eyebrow">WeKruit Partner Integration</p>
          <h1 className="apidoc-h1">Partner API Documentation</h1>
          <p className="apidoc-meta">v1 · Everything you need to syndicate WeKruit jobs and track your referred candidates.</p>

          {/* ── Overview ── */}
          <section className="apidoc-section" id="overview">
            <h2 className="apidoc-h2">Overview</h2>
            <p className="apidoc-p">Two REST APIs, one API key:</p>
            <table className="apidoc-table">
              <thead><tr><th>API</th><th>Endpoint</th><th>What it gives you</th></tr></thead>
              <tbody>
                <tr>
                  <td><strong>Jobs API</strong></td>
                  <td><code>GET /api/v1/partner/jobs</code></td>
                  <td>Live WeKruit-collaborated job listings (title, company, comp, location, company profile) for display on your own surfaces.</td>
                </tr>
                <tr>
                  <td><strong>Users API</strong></td>
                  <td><code>GET /api/v1/partner/users</code></td>
                  <td>Status of every candidate you referred: registration, per-job interview progress, pass/fail outcomes.</td>
                </tr>
              </tbody>
            </table>
            <p className="apidoc-p">Base URL for both: <C>https://wekruit.com</C>. HTTPS only, JSON responses, <C>GET</C> only (<C>OPTIONS</C> preflight supported).</p>
            <div className="apidoc-note-blue">
              <strong>The integration loop:</strong> pull jobs from the Jobs API → display them with links to each job's <C>wekruitUrl</C> plus your source tag → candidates click through, register, and interview with WeKruit → track their progress in the Users API.
            </div>
          </section>

          {/* ── Authentication ── */}
          <section className="apidoc-section" id="authentication">
            <h2 className="apidoc-h2">Authentication</h2>
            <p className="apidoc-p">One API key works for both APIs. It is issued to you out of band — treat it as a secret. Do not embed it in client-side code or commit it to source control.</p>
            <p className="apidoc-p">The header name differs per API:</p>
            <table className="apidoc-table">
              <thead><tr><th>API</th><th>How to send the key</th></tr></thead>
              <tbody>
                <tr><td>Jobs API</td><td><code>X-WeKruit-Api-Key: &lt;key&gt;</code> header (preferred) or <code>?apiKey=&lt;key&gt;</code> query param</td></tr>
                <tr><td>Users API</td><td><code>X-API-Key: &lt;key&gt;</code> header</td></tr>
              </tbody>
            </table>
            <ul className="apidoc-ul">
              <li>The key encodes your partner identity — the Users API automatically scopes every response to your candidates only.</li>
              <li>Server-to-server calls (no browser <C>Origin</C> header) are authenticated by the key alone.</li>
              <li>Browser calls must originate from an allow-listed origin — contact us to register yours.</li>
              <li>Key rotation: we may issue a second key, ask you to switch, then revoke the first. Both stay valid during the overlap.</li>
            </ul>
          </section>

          {/* ── Attribution ── */}
          <section className="apidoc-section" id="attribution">
            <h2 className="apidoc-h2">Referral attribution</h2>
            <p className="apidoc-p">For a candidate to show up in <em>your</em> Users API feed, their first visit to WeKruit must carry your source tag. Append <C>?source=&lt;your-partner-id&gt;</C> to every WeKruit link you publish:</p>
            <pre className="apidoc-code">{`https://wekruit.com/j/<jobId>?source=layoffhedge
https://wekruit.com/?source=layoffhedge`}</pre>
            <ul className="apidoc-ul">
              <li>The Jobs API returns each job's canonical page as <C>wekruitUrl</C> — append your <C>?source=</C> tag before rendering the link.</li>
              <li>Attribution is first-touch and sticky: it is recorded when the candidate first signs up and never reassigned afterward.</li>
              <li>The candidate experience is identical with or without the tag — no extra steps, no different UX.</li>
            </ul>
            <div className="apidoc-note">
              Links without your <C>?source=</C> tag produce sign-ups that are <strong>not</strong> attributed to you and will not appear in your Users API feed. This is the one integration detail you cannot skip.
            </div>
          </section>

          {/* ── Jobs API ── */}
          <section className="apidoc-section" id="jobs-api">
            <h2 className="apidoc-h2">Jobs API</h2>
            <Endpoint url="https://wekruit.com/api/v1/partner/jobs?source=collab" />
            <p className="apidoc-p">Returns sanitized, partner-safe rows for jobs WeKruit actively collaborates on, hydrated with company profile data (logo, stage, employee range).</p>
            <div className="apidoc-note">
              Always pass <C>source=collab</C>. Without it the endpoint serves a different, unauthenticated public surface that is not the partner feed.
            </div>

            <h3 className="apidoc-h3">Query parameters</h3>
            <table className="apidoc-table">
              <thead><tr><th>Param</th><th>Type</th><th>Default</th><th>Description</th></tr></thead>
              <tbody>
                <tr><td><code>source</code></td><td>string</td><td>—</td><td><strong>Required for partners:</strong> <code>collab</code>.</td></tr>
                <tr><td><code>limit</code></td><td>int 1..200</td><td><code>60</code></td><td>Rows per page.</td></tr>
                <tr><td><code>cursor</code></td><td>string</td><td>—</td><td>Opaque forward-only cursor. Pass back the prior response's <code>nextCursor</code>.</td></tr>
                <tr><td><code>freshDays</code></td><td>int 1..365</td><td><code>45</code></td><td>Only jobs first seen within this many days.</td></tr>
                <tr><td><code>function</code></td><td>CSV</td><td>—</td><td>Filter by role function, e.g. <code>software_engineering,product</code>.</td></tr>
                <tr><td><code>level</code></td><td>CSV</td><td>—</td><td>Filter by seniority, e.g. <code>senior,staff</code>.</td></tr>
                <tr><td><code>location</code></td><td>CSV</td><td>—</td><td>Case-insensitive substring match on location.</td></tr>
                <tr><td><code>remoteOnly</code></td><td><code>true</code>/<code>1</code></td><td><code>false</code></td><td>Only remote roles.</td></tr>
                <tr><td><code>search</code></td><td>string</td><td>—</td><td>Substring match across title / company / function / location / summary.</td></tr>
              </tbody>
            </table>
            <p className="apidoc-p">Filters compose with AND; multi-value CSV params compose with OR within the param.</p>
          </section>

          {/* ── Jobs response ── */}
          <section className="apidoc-section" id="jobs-response">
            <h3 className="apidoc-h3" style={{ fontSize: "1.15em" }}>Jobs API — response</h3>
            <pre className="apidoc-code">{`{
  "ok": true,
  "apiVersion": "v1",
  "source": "collab",
  "generatedAt": "2026-06-10T14:03:11.842Z",
  "count": 24,
  "total": 41,
  "limit": 24,
  "hasMore": true,
  "nextCursor": "eyJmcyI6...",
  "rows": [
    {
      "id": "rain-xyz-swe-001",
      "wekruitUrl": "https://wekruit.com/j/rain-xyz-swe-001",
      "title": "Senior iOS Engineer",
      "company": "Rain XYZ",
      "function": "software_engineering",
      "level": "senior",
      "location": "remote_us",
      "locationRaw": "Remote · US",
      "comp": "$180–240k",
      "posted": "1d",
      "summary": "Build the iOS app from scratch with our founding team.",
      "industrySector": ["consumer_apps"],
      "remote": true,
      "sponsorship": null,
      "firstSeenAt": "2026-06-09T14:03:11.000Z",
      "collaborated": true,
      "companyProfile": {
        "displayName": "Rain XYZ",
        "logoUrl": "https://logo.clearbit.com/rain.xyz",
        "hqLocation": "New York, NY",
        "employeeRange": "11-50",
        "industry": "Consumer apps",
        "companyStage": "seed",
        "companyTags": ["consumer", "mobile"]
      }
    }
  ]
}`}</pre>

            <h3 className="apidoc-h3">Row fields</h3>
            <table className="apidoc-table">
              <thead><tr><th>Field</th><th>Always</th><th>Notes</th></tr></thead>
              <tbody>
                <tr><td><code>id</code></td><td>yes</td><td>Stable job id. Treat as opaque; upsert by it on your side.</td></tr>
                <tr><td><code>wekruitUrl</code></td><td>yes</td><td><strong>Your pages must link here</strong> (with your <code>?source=</code> tag). Direct apply URLs are intentionally not exposed.</td></tr>
                <tr><td><code>title</code> / <code>company</code></td><td>yes</td><td>Display strings.</td></tr>
                <tr><td><code>function</code> / <code>level</code></td><td>no</td><td>Canonical role-function / seniority enums.</td></tr>
                <tr><td><code>location</code> / <code>locationRaw</code></td><td>no</td><td>Canonical bucket (e.g. <code>new_york</code>, <code>remote_us</code>) / human-readable string.</td></tr>
                <tr><td><code>comp</code></td><td>no</td><td>Formatted salary range, e.g. <code>$180–240k</code>.</td></tr>
                <tr><td><code>posted</code></td><td>no</td><td>Human-readable age: <code>3h</code>, <code>2d</code>, <code>1w</code>.</td></tr>
                <tr><td><code>summary</code></td><td>no</td><td>First descriptive line, markdown-stripped.</td></tr>
                <tr><td><code>remote</code></td><td>yes</td><td>Boolean.</td></tr>
                <tr><td><code>sponsorship</code></td><td>no</td><td><code>true</code> = sponsors visas, <code>false</code> = does not, <code>null</code> = unknown.</td></tr>
                <tr><td><code>companyProfile</code></td><td>no</td><td>Logo, HQ, stage, employee range. Treat every field as nullable.</td></tr>
              </tbody>
            </table>
          </section>

          {/* ── Jobs caching ── */}
          <section className="apidoc-section" id="jobs-caching">
            <h3 className="apidoc-h3" style={{ fontSize: "1.15em" }}>Jobs API — caching contract (required)</h3>
            <p className="apidoc-p">Responses carry:</p>
            <pre className="apidoc-code">{`Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600
ETag: "v1-a4f8c12e7b6d3f4a8e9c1234"`}</pre>
            <ul className="apidoc-ul">
              <li>Don't refetch the same query more than once per 60 seconds.</li>
              <li>Store the <C>ETag</C>; send <C>If-None-Match</C> on refetch — a <C>304</C> means reuse your cached payload.</li>
              <li>For ingestion: walk the cursor once to load the catalog, then refresh from no-cursor every 1–6 hours.</li>
              <li>Treat a <C>429</C> as back-off: sleep ≥60s, retry with the same <C>If-None-Match</C>.</li>
            </ul>
          </section>

          {/* ── Users API ── */}
          <section className="apidoc-section" id="users-api">
            <h2 className="apidoc-h2">Users API</h2>
            <Endpoint url="https://wekruit.com/api/v1/partner/users" />
            <p className="apidoc-p">Returns the candidates attributed to your referral source — registration info plus per-job interview progress. You only ever see your own candidates.</p>
            <div className="apidoc-note-blue">
              A candidate counts as yours if <strong>either</strong> their durable account <code>source</code> <strong>or</strong> their entry-time <code>entrySource</code> is you. So a candidate who reached WeKruit another way first, then later clicked your tagged link, still shows up — matched on <code>entrySource</code>, with <code>attributedVia: "entry"</code>.
            </div>

            <h3 className="apidoc-h3">Query parameters</h3>
            <table className="apidoc-table">
              <thead><tr><th>Param</th><th>Type</th><th>Default</th><th>Description</th></tr></thead>
              <tbody>
                <tr><td><code>limit</code></td><td>int 1..200</td><td><code>50</code></td><td>Page size.</td></tr>
                <tr><td><code>cursor</code></td><td>string</td><td>—</td><td>Opaque cursor from the prior response's <code>nextCursor</code>.</td></tr>
                <tr><td><code>status</code></td><td>CSV</td><td>—</td><td>Only candidates with ≥1 job in one of these states. See <a href="#job-states">Job states</a>. Example: <code>status=passed,prescreen_started</code>.</td></tr>
                <tr><td><code>since</code></td><td>ISO 8601</td><td>—</td><td>Only candidates with ≥1 job whose status changed at or after this time. Example: <code>since=2026-05-01T00:00:00Z</code>.</td></tr>
              </tbody>
            </table>
          </section>

          {/* ── Users response ── */}
          <section className="apidoc-section" id="users-response">
            <h3 className="apidoc-h3" style={{ fontSize: "1.15em" }}>Users API — response</h3>
            <pre className="apidoc-code">{`{
  "users": [
    {
      "email": "candidate@example.com",
      "name": "Jane Doe",
      "wekruitUserId": "GR17ggfRiyEdE5a2JWaf",
      "registeredAt": "2026-05-27T22:09:17.000Z",
      "lifecycleState": "claimed",
      "source": "candidate",
      "entrySource": "layoffhedge",
      "entryJobId": "hs-10996795-invoko-product-manager",
      "attributedVia": "entry",
      "jobs": [
        {
          "jobId": "hs-10996795-invoko-product-manager",
          "jobTitle": "Product Manager",
          "company": "invoko.ai",
          "state": "prescreen_started",
          "stateUpdatedAt": "2026-05-28T15:42:11.000Z",
          "prescreenSessionId": "pss_abc123",
          "wekruitJobUrl": "https://wekruit.com/j/hs-10996795-invoko-product-manager"
        }
      ],
      "summary": {
        "totalJobs": 1,
        "passedJobs": 0,
        "notPassedJobs": 0,
        "activePrescreens": 1,
        "employerVisibleJobs": 0
      }
    }
  ],
  "nextCursor": "eyJjcm...",
  "hasMore": false,
  "generatedAt": "2026-05-28T16:00:00.000Z",
  "partner": "layoffhedge",
  "apiVersion": "v1"
}`}</pre>

            <h3 className="apidoc-h3">User object</h3>
            <table className="apidoc-table">
              <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
              <tbody>
                <tr><td><code>email</code></td><td>string</td><td>Candidate email — match against your own records.</td></tr>
                <tr><td><code>name</code></td><td>string | absent</td><td>Display name if provided.</td></tr>
                <tr><td><code>wekruitUserId</code></td><td>string</td><td>Stable internal id — join key across calls.</td></tr>
                <tr><td><code>registeredAt</code></td><td>ISO 8601</td><td>First registration with WeKruit.</td></tr>
                <tr><td><code>lifecycleState</code></td><td>string | absent</td><td>Global lifecycle state, e.g. <code>claimed</code>, <code>profile_ready</code>. Informational.</td></tr>
                <tr><td><code>source</code></td><td>string | absent</td><td>The candidate's durable account source. May <em>not</em> be you if they first reached WeKruit another way before clicking your link — that's what <code>entrySource</code> is for.</td></tr>
                <tr><td><code>entrySource</code></td><td>string | absent</td><td>The source captured when the candidate <strong>entered through a tagged link</strong>. When this is you, the referral is yours even if <code>source</code> shows something else.</td></tr>
                <tr><td><code>entryJobId</code></td><td>string | absent</td><td>The job page the candidate entered through.</td></tr>
                <tr><td><code>attributedVia</code></td><td>string</td><td>How they matched you: <code>top_level</code> (durable source), <code>entry</code> (entry link only), or <code>both</code>.</td></tr>
                <tr><td><code>jobs[]</code></td><td>array</td><td>Per-job progress (below).</td></tr>
                <tr><td><code>summary</code></td><td>object</td><td><code>totalJobs</code>, <code>passedJobs</code>, <code>notPassedJobs</code>, <code>activePrescreens</code>, <code>employerVisibleJobs</code>.</td></tr>
              </tbody>
            </table>

            <h3 className="apidoc-h3">Job entry</h3>
            <table className="apidoc-table">
              <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
              <tbody>
                <tr><td><code>jobId</code></td><td>string</td><td>WeKruit job id — joins to the Jobs API <code>id</code>.</td></tr>
                <tr><td><code>jobTitle</code> / <code>company</code></td><td>string</td><td>Display strings.</td></tr>
                <tr><td><code>state</code></td><td>string</td><td>See <a href="#job-states">Job states</a>.</td></tr>
                <tr><td><code>stateUpdatedAt</code></td><td>ISO 8601</td><td>Last status change.</td></tr>
                <tr><td><code>prescreenSessionId</code></td><td>string | absent</td><td>Latest pre-screen session id, if any.</td></tr>
                <tr><td><code>wekruitJobUrl</code></td><td>string</td><td>Canonical job page.</td></tr>
              </tbody>
            </table>
          </section>

          {/* ── Job states ── */}
          <section className="apidoc-section" id="job-states">
            <h3 className="apidoc-h3" style={{ fontSize: "1.15em" }}>Job states</h3>
            <table className="apidoc-table">
              <thead><tr><th>State</th><th>Meaning</th></tr></thead>
              <tbody>
                <tr><td><code>candidate_matched</code></td><td>Matched to the job; not yet contacted.</td></tr>
                <tr><td><code>outbound_queued</code></td><td>Outreach queued.</td></tr>
                <tr><td><code>outbound_sent</code></td><td>Outreach sent to the candidate.</td></tr>
                <tr><td><code>candidate_interested</code></td><td>Candidate replied with interest.</td></tr>
                <tr><td><code>prescreen_started</code></td><td>First interview (pre-screen) in progress.</td></tr>
                <tr><td><code>prescreen_review_pending</code></td><td>Pre-screen complete; under review.</td></tr>
                <tr><td><code>passed</code></td><td>Candidate passed the pre-screen.</td></tr>
                <tr><td><code>not_passed</code></td><td>Did not pass this job's pre-screen (still eligible for other jobs).</td></tr>
                <tr><td><code>paused</code></td><td>Temporarily paused (ambiguous answer, manual review, etc.).</td></tr>
                <tr><td><code>employer_visible</code></td><td>Passed profile visible to the employer.</td></tr>
                <tr><td><code>archived</code></td><td>Closed for this job (filled, declined, or stale).</td></tr>
              </tbody>
            </table>
          </section>

          {/* ── Pagination ── */}
          <section className="apidoc-section" id="pagination">
            <h2 className="apidoc-h2">Pagination</h2>
            <p className="apidoc-p">Both APIs paginate the same way — iterate until <C>hasMore</C> is <C>false</C>:</p>
            <pre className="apidoc-code">{`GET <endpoint>?limit=100
  -> { ..., "hasMore": true, "nextCursor": "AAA" }
GET <endpoint>?limit=100&cursor=AAA
  -> { ..., "hasMore": true, "nextCursor": "BBB" }
GET <endpoint>?limit=100&cursor=BBB
  -> { ..., "hasMore": false }   // last page`}</pre>
            <ul className="apidoc-ul">
              <li>Cursors are opaque — never parse or construct them; only echo back the value we return.</li>
              <li>Users API ordering: registration time, newest first. Jobs API ordering: <C>firstSeenAt</C>, newest first.</li>
              <li>Jobs API cursors can dangle if a job rotates out of the active set — the API then silently restarts from the first page. Always upsert by <C>id</C>.</li>
            </ul>
          </section>

          {/* ── Errors ── */}
          <section className="apidoc-section" id="errors">
            <h2 className="apidoc-h2">Errors</h2>
            <p className="apidoc-p">Error responses use <C>{`{ "ok": false, "reason": "<code>" }`}</C>.</p>
            <table className="apidoc-table">
              <thead><tr><th>HTTP</th><th><code>reason</code></th><th>API</th><th>Cause</th></tr></thead>
              <tbody>
                <tr><td>401</td><td><code>missing_api_key</code></td><td>both</td><td>No key sent.</td></tr>
                <tr><td>401</td><td><code>invalid_api_key</code></td><td>both</td><td>Key not recognized.</td></tr>
                <tr><td>401</td><td><code>invalid_api_key_format</code></td><td>users</td><td>Key malformed.</td></tr>
                <tr><td>403</td><td><code>key_partner_mismatch</code></td><td>users</td><td>Key does not map to a known partner.</td></tr>
                <tr><td>403</td><td><code>origin_not_allowed</code></td><td>both</td><td>Browser <code>Origin</code> not allow-listed.</td></tr>
                <tr><td>400</td><td><code>invalid_query</code></td><td>users</td><td>Bad <code>limit</code>, <code>status</code>, <code>since</code>, or <code>cursor</code>.</td></tr>
                <tr><td>405</td><td><code>method_not_allowed</code></td><td>both</td><td>Use <code>GET</code>.</td></tr>
                <tr><td>304</td><td><em>(no body)</em></td><td>jobs</td><td>ETag match — reuse your cached payload.</td></tr>
                <tr><td>500</td><td><code>internal_error</code></td><td>both</td><td>Transient — retry with backoff.</td></tr>
              </tbody>
            </table>
          </section>

          {/* ── Examples ── */}
          <section className="apidoc-section" id="examples">
            <h2 className="apidoc-h2">Examples</h2>

            <h3 className="apidoc-h3">Fetch collab jobs (curl)</h3>
            <pre className="apidoc-code">{`curl -sS \\
  -H "X-WeKruit-Api-Key: $WEKRUIT_PARTNER_KEY" \\
  "https://wekruit.com/api/v1/partner/jobs?source=collab&limit=100" \\
  | jq '.rows[] | {id, title, company, comp, wekruitUrl}'`}</pre>

            <h3 className="apidoc-h3">Fetch your referred candidates (curl)</h3>
            <pre className="apidoc-code">{`curl -sS \\
  -H "X-API-Key: $WEKRUIT_PARTNER_KEY" \\
  "https://wekruit.com/api/v1/partner/users?limit=50&status=passed,prescreen_started" \\
  | jq '.users[] | {email, jobs: [.jobs[] | {jobId, state}]}'`}</pre>

            <h3 className="apidoc-h3">Page through everything (bash)</h3>
            <pre className="apidoc-code">{`cursor=""
while : ; do
  resp=$(curl -s -H "X-API-Key: $WEKRUIT_PARTNER_KEY" \\
    "https://wekruit.com/api/v1/partner/users?limit=100\${cursor:+&cursor=$cursor}")
  echo "$resp" | jq '.users[] | {email, jobs: [.jobs[] | {jobId, state}]}'
  [ "$(echo "$resp" | jq -r '.hasMore')" = "true" ] || break
  cursor=$(echo "$resp" | jq -r '.nextCursor')
done`}</pre>

            <h3 className="apidoc-h3">Ingest jobs into your DB (Node.js)</h3>
            <pre className="apidoc-code">{`const BASE = "https://wekruit.com/api/v1/partner/jobs"

async function fetchAllJobs() {
  const rows = []
  let cursor = null
  do {
    const url = new URL(BASE)
    url.searchParams.set("source", "collab")
    url.searchParams.set("limit", "100")
    if (cursor) url.searchParams.set("cursor", cursor)
    const res = await fetch(url, {
      headers: { "X-WeKruit-Api-Key": process.env.WEKRUIT_PARTNER_KEY },
    })
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`)
    const body = await res.json()
    rows.push(...body.rows)
    cursor = body.hasMore ? body.nextCursor : null
  } while (cursor)
  return rows  // upsert by row.id; link to row.wekruitUrl + "?source=layoffhedge"
}`}</pre>
          </section>

          {/* ── Versioning & limits ── */}
          <section className="apidoc-section" id="versioning">
            <h2 className="apidoc-h2">Versioning, freshness &amp; limits</h2>
            <ul className="apidoc-ul">
              <li><C>apiVersion: "v1"</C> is the current stable contract. Additive changes (new optional fields, new params) ship without notice — treat unknown fields as ignorable. Breaking changes bump the version; v1 stays live ≥30 days alongside v2.</li>
              <li>Users API responses may be cached up to ~60 seconds — poll every few minutes at most.</li>
              <li>No hard per-key rate limit today. Guardrails: same query ≤1/min, ≤8 concurrent connections, finish cursor walks within ~5 minutes.</li>
              <li>Privacy: the Users API returns email, name, job-level status, and pre-screen session id only. Resumes, interview transcripts, and phone numbers are never shared. A <C>not_passed</C> on one job does not remove a candidate from the marketplace.</li>
            </ul>
          </section>

          {/* ── Contact ── */}
          <section className="apidoc-section" id="contact">
            <h2 className="apidoc-h2">Contact</h2>
            <ul className="apidoc-ul">
              <li>Email: <a href="mailto:admin1@wekruit.com" style={{ color: "#0369a1" }}>admin1@wekruit.com</a></li>
              <li>Key issuance, rotation, and origin allow-listing: your WeKruit point of contact.</li>
              <li>Bug reports: include the request URL, response status, and <C>generatedAt</C> timestamp.</li>
            </ul>
          </section>

          <footer className="apidoc-footer">
            WeKruit, Inc. · Partner API v1 · This documentation is confidential — do not redistribute the link.
          </footer>
        </main>
      </div>
    </>
  )
}
