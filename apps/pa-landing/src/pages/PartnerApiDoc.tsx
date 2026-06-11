import { useEffect } from "react"

const STYLES = `
body.apidoc-bg {
  max-width: 780px;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.6;
  color: #1e293b;
  background: #fff;
}
.apidoc-header { border-bottom: 2px solid #0f172a; padding-bottom: 1rem; margin-bottom: 2rem; }
.apidoc-eyebrow { color: #64748b; font-size: 0.82em; margin: 0; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
.apidoc-h1 { margin: 0.5rem 0 0; font-size: 1.65em; color: #0f172a; }
.apidoc-meta { margin: 0.4rem 0 0; color: #64748b; font-size: 0.85em; }
.apidoc-section { margin-bottom: 2rem; }
.apidoc-h2 { font-size: 1.2em; color: #0f172a; margin-bottom: 0.5rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.3rem; }
.apidoc-h3 { font-size: 1.05em; color: #334155; margin: 1rem 0 0.4rem; }
.apidoc-p { margin: 0.5rem 0; color: #334155; }
.apidoc-ul { padding-left: 1.4rem; margin: 0.5rem 0; }
.apidoc-ul li { margin: 0.3rem 0; color: #334155; }
.apidoc-code {
  display: block;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 0.8rem 1rem;
  font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
  font-size: 0.85em;
  overflow-x: auto;
  white-space: pre;
  color: #1e293b;
  margin: 0.5rem 0;
  line-height: 1.5;
}
.apidoc-inline-code {
  background: #f1f5f9;
  border-radius: 3px;
  padding: 0.15em 0.35em;
  font-family: "SF Mono", "Fira Code", Menlo, Consolas, monospace;
  font-size: 0.88em;
  color: #0f172a;
}
.apidoc-table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.5rem 0 1rem;
  font-size: 0.9em;
}
.apidoc-table th {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 2px solid #cbd5e1;
  color: #0f172a;
  font-weight: 600;
  background: #f8fafc;
}
.apidoc-table td {
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid #e2e8f0;
  color: #334155;
  vertical-align: top;
}
.apidoc-table tr:last-child td { border-bottom: none; }
.apidoc-table code {
  background: #f1f5f9;
  border-radius: 3px;
  padding: 0.1em 0.3em;
  font-family: "SF Mono", "Fira Code", Menlo, Consolas, monospace;
  font-size: 0.9em;
}
.apidoc-hr { border: none; border-top: 1px solid #e2e8f0; margin: 1.5rem 0; }
.apidoc-footer {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid #e2e8f0;
  color: #94a3b8;
  font-size: 0.82em;
}
.apidoc-note {
  background: #fffbeb;
  border-left: 3px solid #f59e0b;
  padding: 0.6rem 1rem;
  border-radius: 0 4px 4px 0;
  margin: 0.5rem 0;
  font-size: 0.92em;
  color: #92400e;
}
@media (max-width: 640px) {
  body.apidoc-bg { padding: 1rem 0.75rem 3rem; }
  .apidoc-table { font-size: 0.82em; }
  .apidoc-code { font-size: 0.78em; padding: 0.6rem; }
}
`

const C = ({ children }: { children: string }) => (
  <code className="apidoc-inline-code">{children}</code>
)

export default function PartnerApiDoc() {
  useEffect(() => {
    document.body.classList.add("apidoc-bg")
    document.title = "Partner Users API v1 — WeKruit"
    return () => { document.body.classList.remove("apidoc-bg") }
  }, [])

  return (
    <>
      <style>{STYLES}</style>

      <header className="apidoc-header">
        <p className="apidoc-eyebrow">WeKruit Partner Integration</p>
        <h1 className="apidoc-h1">Partner Users API — v1</h1>
        <p className="apidoc-meta">Programmatic access to the candidacy status of the candidates you referred to WeKruit.</p>
      </header>

      {/* ── Base ────────────────────────────────── */}
      <section className="apidoc-section">
        <h2 className="apidoc-h2">Base URL</h2>
        <pre className="apidoc-code">GET https://wekruit.com/api/v1/partner/users</pre>
        <ul className="apidoc-ul">
          <li>HTTPS only.</li>
          <li><C>GET</C> only (an <C>OPTIONS</C> preflight is supported for browsers).</li>
          <li>JSON response.</li>
        </ul>
      </section>

      {/* ── Auth ────────────────────────────────── */}
      <section className="apidoc-section">
        <h2 className="apidoc-h2">Authentication</h2>
        <p className="apidoc-p">Send your API key in the <C>X-API-Key</C> request header:</p>
        <pre className="apidoc-code">X-API-Key: key_layoffhedge_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</pre>
        <ul className="apidoc-ul">
          <li>The key is issued to you out of band. Treat it as a secret — do not embed it in client-side code or commit it to source control.</li>
          <li>The key encodes your partner identity. The API automatically scopes every response to your candidates only.</li>
          <li>Server-to-server calls (no browser <C>Origin</C> header) are authenticated by the key alone. Browser calls must originate from an allow-listed origin — contact us to register one.</li>
        </ul>
      </section>

      {/* ── Query params ────────────────────────── */}
      <section className="apidoc-section">
        <h2 className="apidoc-h2">Query Parameters</h2>
        <p className="apidoc-p">All optional.</p>
        <table className="apidoc-table">
          <thead>
            <tr><th>Param</th><th>Type</th><th>Default</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td><code>limit</code></td><td>integer</td><td><code>50</code></td><td>Page size. Clamped to <code>1..200</code>.</td></tr>
            <tr><td><code>cursor</code></td><td>string</td><td>—</td><td>Opaque pagination cursor. Pass the <code>nextCursor</code> value from the previous response to get the next page.</td></tr>
            <tr><td><code>status</code></td><td>string (CSV)</td><td>—</td><td>Filter to candidates who have at least one job in one of these states. Comma-separated. See <a href="#job-states">Job states</a>. Example: <code>status=passed,prescreen_started</code>.</td></tr>
            <tr><td><code>since</code></td><td>string (ISO 8601)</td><td>—</td><td>Return only candidates with at least one job whose status changed at or after this timestamp. Example: <code>since=2026-05-01T00:00:00Z</code>.</td></tr>
          </tbody>
        </table>
      </section>

      {/* ── Response ────────────────────────────── */}
      <section className="apidoc-section">
        <h2 className="apidoc-h2">Response</h2>
        <p className="apidoc-p"><C>200 OK</C></p>
        <pre className="apidoc-code">{`{
  "users": [
    {
      "email": "candidate@example.com",
      "name": "Jane Doe",
      "wekruitUserId": "GR17ggfRiyEdE5a2JWaf",
      "registeredAt": "2026-05-27T22:09:17.000Z",
      "lifecycleState": "claimed",
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

        <h3 className="apidoc-h3">Top-level fields</h3>
        <table className="apidoc-table">
          <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>users</code></td><td>array</td><td>Page of candidates, newest registration first.</td></tr>
            <tr><td><code>nextCursor</code></td><td>string | absent</td><td>Present only when <code>hasMore</code> is <code>true</code>. Pass it back as <code>?cursor=</code> to fetch the next page.</td></tr>
            <tr><td><code>hasMore</code></td><td>boolean</td><td><code>true</code> if more pages exist.</td></tr>
            <tr><td><code>generatedAt</code></td><td>string (ISO 8601)</td><td>When the response was produced.</td></tr>
            <tr><td><code>partner</code></td><td>string</td><td>Your partner identifier (derived from your key).</td></tr>
            <tr><td><code>apiVersion</code></td><td>string</td><td>API version, currently <code>v1</code>.</td></tr>
          </tbody>
        </table>

        <h3 className="apidoc-h3">User object</h3>
        <table className="apidoc-table">
          <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>email</code></td><td>string</td><td>The candidate's email. Use this to match against your own records.</td></tr>
            <tr><td><code>name</code></td><td>string | absent</td><td>Display name, if the candidate provided one.</td></tr>
            <tr><td><code>wekruitUserId</code></td><td>string</td><td>WeKruit's stable internal id for the candidate. Useful as a join key across calls.</td></tr>
            <tr><td><code>registeredAt</code></td><td>string (ISO 8601)</td><td>When the candidate first registered with WeKruit.</td></tr>
            <tr><td><code>lifecycleState</code></td><td>string | absent</td><td>Candidate's global lifecycle state (e.g. <code>claimed</code>, <code>profile_ready</code>).</td></tr>
            <tr><td><code>jobs</code></td><td>array</td><td>Jobs this candidate has been matched to / is progressing through.</td></tr>
            <tr><td><code>summary</code></td><td>object</td><td>Convenience aggregates over <code>jobs</code>.</td></tr>
          </tbody>
        </table>

        <h3 className="apidoc-h3">Job object</h3>
        <table className="apidoc-table">
          <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>jobId</code></td><td>string</td><td>WeKruit job id.</td></tr>
            <tr><td><code>jobTitle</code></td><td>string</td><td>Job title. <code>"Unknown role"</code> if unavailable.</td></tr>
            <tr><td><code>company</code></td><td>string</td><td>Hiring company name (may be empty).</td></tr>
            <tr><td><code>state</code></td><td>string</td><td>Candidate's status for this job. See <a href="#job-states">Job states</a>.</td></tr>
            <tr><td><code>stateUpdatedAt</code></td><td>string (ISO 8601)</td><td>When the status last changed.</td></tr>
            <tr><td><code>prescreenSessionId</code></td><td>string | absent</td><td>Id of the latest pre-screen session for this candidate+job, if one exists.</td></tr>
            <tr><td><code>wekruitJobUrl</code></td><td>string</td><td>Canonical WeKruit page for the job.</td></tr>
          </tbody>
        </table>

        <h3 className="apidoc-h3">Summary object</h3>
        <table className="apidoc-table">
          <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>totalJobs</code></td><td>integer</td><td>Number of jobs in <code>jobs</code>.</td></tr>
            <tr><td><code>passedJobs</code></td><td>integer</td><td>Jobs in state <code>passed</code>.</td></tr>
            <tr><td><code>notPassedJobs</code></td><td>integer</td><td>Jobs in state <code>not_passed</code>.</td></tr>
            <tr><td><code>activePrescreens</code></td><td>integer</td><td>Jobs in state <code>prescreen_started</code>, <code>prescreen_review_pending</code>, or <code>paused</code>.</td></tr>
            <tr><td><code>employerVisibleJobs</code></td><td>integer</td><td>Jobs in state <code>employer_visible</code>.</td></tr>
          </tbody>
        </table>
      </section>

      {/* ── Job states ──────────────────────────── */}
      <section className="apidoc-section" id="job-states">
        <h2 className="apidoc-h2">Job States</h2>
        <p className="apidoc-p">A candidate's status for a given job is one of:</p>
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
            <tr><td><code>not_passed</code></td><td>Candidate did not pass this job's pre-screen (still eligible for other jobs).</td></tr>
            <tr><td><code>paused</code></td><td>Temporarily paused (ambiguous answer, manual review, etc.).</td></tr>
            <tr><td><code>employer_visible</code></td><td>Passed profile is visible to the employer.</td></tr>
            <tr><td><code>archived</code></td><td>Closed for this job (job filled, candidate declined, or stale).</td></tr>
          </tbody>
        </table>
      </section>

      {/* ── Pagination ──────────────────────────── */}
      <section className="apidoc-section">
        <h2 className="apidoc-h2">Pagination</h2>
        <p className="apidoc-p">Iterate until <C>hasMore</C> is <C>false</C>:</p>
        <pre className="apidoc-code">{`GET /api/v1/partner/users?limit=100
  -> { ..., "hasMore": true, "nextCursor": "AAA" }
GET /api/v1/partner/users?limit=100&cursor=AAA
  -> { ..., "hasMore": true, "nextCursor": "BBB" }
GET /api/v1/partner/users?limit=100&cursor=BBB
  -> { ..., "hasMore": false }   // last page; no nextCursor`}</pre>
        <div className="apidoc-note">
          Cursors are opaque — do not parse or construct them. Only echo back the value we return. A cursor remains valid across new registrations (results are ordered by registration time, newest first).
        </div>
      </section>

      {/* ── Errors ──────────────────────────────── */}
      <section className="apidoc-section">
        <h2 className="apidoc-h2">Errors</h2>
        <p className="apidoc-p">Error responses use <C>{`{ "ok": false, "reason": "<code>" }`}</C>.</p>
        <table className="apidoc-table">
          <thead><tr><th>HTTP</th><th><code>reason</code></th><th>Cause</th></tr></thead>
          <tbody>
            <tr><td>401</td><td><code>missing_api_key</code></td><td>No <code>X-API-Key</code> header.</td></tr>
            <tr><td>401</td><td><code>invalid_api_key</code></td><td>Key not recognized.</td></tr>
            <tr><td>401</td><td><code>invalid_api_key_format</code></td><td>Key is malformed.</td></tr>
            <tr><td>403</td><td><code>key_partner_mismatch</code></td><td>Key does not map to a known partner.</td></tr>
            <tr><td>403</td><td><code>origin_not_allowed</code></td><td>Browser <code>Origin</code> is not allow-listed.</td></tr>
            <tr><td>400</td><td><code>invalid_query</code></td><td>Bad <code>limit</code>, <code>status</code>, <code>since</code>, or <code>cursor</code>.</td></tr>
            <tr><td>500</td><td><code>internal_error</code></td><td>Transient server error — retry with backoff.</td></tr>
          </tbody>
        </table>
      </section>

      {/* ── Freshness ───────────────────────────── */}
      <section className="apidoc-section">
        <h2 className="apidoc-h2">Freshness</h2>
        <p className="apidoc-p">Responses may be cached for up to ~60 seconds. Polling more frequently than once per minute will not yield fresher data. We recommend polling every few minutes.</p>
      </section>

      {/* ── Examples ────────────────────────────── */}
      <section className="apidoc-section">
        <h2 className="apidoc-h2">Examples</h2>

        <h3 className="apidoc-h3">Single request</h3>
        <pre className="apidoc-code">{`curl -s \\
  -H "X-API-Key: $WEKRUIT_PARTNER_API_KEY" \\
  "https://wekruit.com/api/v1/partner/users?limit=50&status=passed,prescreen_started"`}</pre>

        <h3 className="apidoc-h3">Page through all candidates</h3>
        <pre className="apidoc-code">{`cursor=""
while : ; do
  resp=$(curl -s -H "X-API-Key: $WEKRUIT_PARTNER_API_KEY" \\
    "https://wekruit.com/api/v1/partner/users?limit=100\${cursor:+&cursor=$cursor}")
  echo "$resp" | jq '.users[] | {email, jobs: [.jobs[] | {jobId, state}]}'
  more=$(echo "$resp" | jq -r '.hasMore')
  [ "$more" = "true" ] || break
  cursor=$(echo "$resp" | jq -r '.nextCursor')
done`}</pre>
      </section>

      {/* ── Notes ───────────────────────────────── */}
      <section className="apidoc-section">
        <h2 className="apidoc-h2">Notes</h2>
        <ul className="apidoc-ul">
          <li>We return your candidates' email, name, job-level status, and pre-screen session id. We do <strong>not</strong> share resumes, interview transcripts, phone numbers, or other sensitive profile details.</li>
          <li>A <C>not_passed</C> result for one job does not remove the candidate from the marketplace; they remain eligible for other roles.</li>
          <li>Questions / origin allow-listing / key rotation: contact your WeKruit point of contact.</li>
        </ul>
      </section>

      <footer className="apidoc-footer">
        WeKruit, Inc. &middot; API v1 &middot; <a href="https://wekruit.com" style={{ color: "#64748b" }}>wekruit.com</a>
      </footer>
    </>
  )
}
