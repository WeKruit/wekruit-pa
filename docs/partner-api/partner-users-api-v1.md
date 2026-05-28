# WeKruit Partner Users API — v1

Programmatic access to the candidacy status of the candidates you referred to
WeKruit. You see only the candidates attributed to your referral source; no
other partner's candidates are ever returned.

---

## Base

```
GET https://wekruit.com/api/v1/partner/users
```

- HTTPS only.
- `GET` only (an `OPTIONS` preflight is supported for browsers).
- JSON response.

## Authentication

Send your API key in the `X-API-Key` request header:

```
X-API-Key: key_layoffhedge_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- The key is issued to you out of band. Treat it as a secret — do not embed it
  in client-side code or commit it to source control.
- The key encodes your partner identity. The API automatically scopes every
  response to your candidates only.
- Server-to-server calls (no browser `Origin` header) are authenticated by the
  key alone. Browser calls must originate from an allow-listed origin —
  contact us to register one.

## Query parameters

All optional.

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Page size. Clamped to `1..200`. |
| `cursor` | string | — | Opaque pagination cursor. Pass the `nextCursor` value from the previous response to get the next page. |
| `status` | string (CSV) | — | Filter to candidates who have at least one job in one of these states. Comma-separated. See [Job states](#job-states). Example: `status=passed,prescreen_started`. |
| `since` | string (ISO 8601) | — | Return only candidates with at least one job whose status changed at or after this timestamp. Example: `since=2026-05-01T00:00:00Z`. |

## Response

`200 OK`

```json
{
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
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA1LTI3VDEwOjAwOjAwWiIsImRvY0lkIjoidUMifQ",
  "hasMore": false,
  "generatedAt": "2026-05-28T16:00:00.000Z",
  "partner": "layoffhedge",
  "apiVersion": "v1"
}
```

### Top-level fields

| Field | Type | Description |
|---|---|---|
| `users` | array | The page of candidates, newest registration first. |
| `nextCursor` | string \| absent | Present only when `hasMore` is `true`. Pass it back as `?cursor=` to fetch the next page. |
| `hasMore` | boolean | `true` if more pages exist. |
| `generatedAt` | string (ISO 8601) | When the response was produced. |
| `partner` | string | Your partner identifier (derived from your key). |
| `apiVersion` | string | API version, currently `v1`. |

### User object

| Field | Type | Description |
|---|---|---|
| `email` | string | The candidate's email. Use this to match against your own records. |
| `name` | string \| absent | Display name, if the candidate provided one. |
| `wekruitUserId` | string | WeKruit's stable internal id for the candidate. Useful as a join key across calls. |
| `registeredAt` | string (ISO 8601) | When the candidate first registered with WeKruit. |
| `lifecycleState` | string \| absent | The candidate's global lifecycle state (e.g. `claimed`, `profile_ready`). Informational. |
| `jobs` | array | The jobs this candidate has been matched to / is progressing through. |
| `summary` | object | Convenience aggregates over `jobs` (see below). |

### Job object

| Field | Type | Description |
|---|---|---|
| `jobId` | string | WeKruit job id. |
| `jobTitle` | string | Job title. `"Unknown role"` if the job record is unavailable. |
| `company` | string | Hiring company name (may be empty). |
| `state` | string | The candidate's status for this job. See [Job states](#job-states). |
| `stateUpdatedAt` | string (ISO 8601) | When the status last changed. |
| `prescreenSessionId` | string \| absent | Id of the latest pre-screen session for this candidate+job, if one exists. |
| `wekruitJobUrl` | string | Canonical WeKruit page for the job. |

### Summary object

| Field | Type | Description |
|---|---|---|
| `totalJobs` | integer | Number of jobs in `jobs`. |
| `passedJobs` | integer | Jobs in state `passed`. |
| `notPassedJobs` | integer | Jobs in state `not_passed`. |
| `activePrescreens` | integer | Jobs in state `prescreen_started`, `prescreen_review_pending`, or `paused`. |
| `employerVisibleJobs` | integer | Jobs in state `employer_visible`. |

## Job states

A candidate's status for a given job is one of:

| State | Meaning |
|---|---|
| `candidate_matched` | Matched to the job; not yet contacted. |
| `outbound_queued` | Outreach queued. |
| `outbound_sent` | Outreach sent to the candidate. |
| `candidate_interested` | Candidate replied with interest. |
| `prescreen_started` | First interview (pre-screen) in progress. |
| `prescreen_review_pending` | Pre-screen complete; under review. |
| `passed` | Candidate passed the pre-screen. |
| `not_passed` | Candidate did not pass this job's pre-screen (still eligible for other jobs). |
| `paused` | Temporarily paused (ambiguous answer, manual review, etc.). |
| `employer_visible` | Passed profile is visible to the employer. |
| `archived` | Closed for this job (job filled, candidate declined, or stale). |

## Pagination

Iterate until `hasMore` is `false`:

```
GET /api/v1/partner/users?limit=100
  -> { ..., "hasMore": true, "nextCursor": "AAA" }
GET /api/v1/partner/users?limit=100&cursor=AAA
  -> { ..., "hasMore": true, "nextCursor": "BBB" }
GET /api/v1/partner/users?limit=100&cursor=BBB
  -> { ..., "hasMore": false }   // last page; no nextCursor
```

Cursors are opaque — do not parse or construct them; only echo back the value
we return. A cursor remains valid across new registrations (results are
ordered by registration time, newest first).

## Errors

Error responses use `{ "ok": false, "reason": "<code>" }`.

| HTTP | `reason` | Cause |
|---|---|---|
| `401` | `missing_api_key` | No `X-API-Key` header. |
| `401` | `invalid_api_key` | Key not recognized. |
| `401` | `invalid_api_key_format` | Key is malformed. |
| `403` | `key_partner_mismatch` | Key does not map to a known partner. |
| `403` | `origin_not_allowed` | Browser `Origin` is not allow-listed. |
| `400` | `invalid_query` | Bad `limit`, `status`, `since`, or `cursor`. |
| `500` | `internal_error` | Transient server error — retry with backoff. |

## Freshness

Responses may be cached for up to ~60 seconds. Polling more frequently than
once per minute will not yield fresher data. We recommend polling every few
minutes.

## Example

```bash
curl -s \
  -H "X-API-Key: $WEKRUIT_PARTNER_API_KEY" \
  "https://wekruit.com/api/v1/partner/users?limit=50&status=passed,prescreen_started"
```

```bash
# Page through all candidates:
cursor=""
while : ; do
  resp=$(curl -s -H "X-API-Key: $WEKRUIT_PARTNER_API_KEY" \
    "https://wekruit.com/api/v1/partner/users?limit=100${cursor:+&cursor=$cursor}")
  echo "$resp" | jq '.users[] | {email, jobs: [.jobs[] | {jobId, state}]}'
  more=$(echo "$resp" | jq -r '.hasMore')
  [ "$more" = "true" ] || break
  cursor=$(echo "$resp" | jq -r '.nextCursor')
done
```

## Notes

- We return your candidates' email, name, job-level status, and pre-screen
  session id. We do **not** share résumés, interview transcripts, phone
  numbers, or other sensitive profile details.
- A `not_passed` result for one job does not remove the candidate from the
  marketplace; they remain eligible for other roles.
- Questions / origin allow-listing / key rotation: contact your WeKruit
  point of contact.
