# WeKruit Public Jobs API (v1)

Public HTTP endpoint exposing WeKruit job listings to external surfaces. Two modes:

| Mode | Source collection | Auth | Use case |
|---|---|---|---|
| `scraped` *(default)* | `matching-jobs` | None | WeKruit-internal `/open` Hunting List (browse-only, third-party companies) |
| `collab` | `pa-jobs` + `pa-companies` | API key + Origin allowlist | **External partner syndication** — paid WeKruit-collab jobs only |

If you are an external partner integrating WeKruit jobs into your own product, you want **`source=collab`**.

---

## Endpoint

```
GET https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicOpenJobs
```

Returns `application/json`. Supports `OPTIONS` for CORS preflight. Other methods → `405`.

---

## Authentication (collab mode only)

Send the API key in **either**:

- Query string: `?apiKey=<your_key>`
- Header: `X-WeKruit-Api-Key: <your_key>`

Header is preferred (does not appear in CDN logs / browser history). The key is checked in constant time against the `PA_PUBLIC_COLLAB_API_KEYS` Firebase secret (CSV of valid keys).

If you call the endpoint from a browser, your `Origin` header must be in `PA_PUBLIC_COLLAB_ORIGINS` (CSV). Server-to-server calls (no `Origin`) skip the origin check and pass on a valid key alone.

Errors:

| Status | Body | Meaning |
|---|---|---|
| `401` | `{"ok":false,"reason":"missing_api_key"}` | No key sent |
| `401` | `{"ok":false,"reason":"invalid_api_key"}` | Key not in allowlist |
| `403` | `{"ok":false,"reason":"origin_not_allowed"}` | Browser `Origin` not allowlisted |
| `503` | `{"ok":false,"reason":"collab_mode_not_configured"}` | Server-side secrets unset (contact WeKruit) |

> **Key rotation.** WeKruit may issue a second key, ask you to switch, then revoke the first. Both keys are valid during overlap. Coordinate via your WeKruit contact.

---

## Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `source` | `scraped` \| `collab` | `scraped` | Use `collab` for partner syndication. |
| `limit` | int `[1, 200]` | `60` | Rows per page. |
| `cursor` | base64url | — | Opaque forward-only cursor. Pass back the prior response's `nextCursor`. |
| `offset` | int `[0, 2000]` | `0` | Legacy. Cursor takes precedence when present. |
| `freshDays` | int `[1, 365]` | `45` | Only return jobs whose `firstSeenAt` is within this many days. |
| `function` | csv | — | Filter by `roleFunction` (canonical, e.g. `software_engineering,product`). |
| `level` | csv | — | Filter by `seniorityLevel` (e.g. `senior,staff`). |
| `location` | csv | — | Substring match against `location` and `locationRaw`. Case-insensitive. |
| `remoteOnly` | `true`/`1` | `false` | Only rows where `remote=true`. |
| `search` | string | — | Substring match across title/company/function/location/summary. |

Filters compose with AND. Multi-value csv params compose with OR within the param.

---

## Response shape

```jsonc
{
  "ok": true,
  "apiVersion": "v1",
  "source": "collab",
  "generatedAt": "2026-05-27T14:03:11.842Z",
  "count": 24,                     // rows in this page
  "scanned": 87,                   // docs scanned to build snapshot
  "total": 41,                     // TRUE catalog size (count() aggregate over the base query)
  "totalIsApprox": true,           // true when `total` is the aggregate (pre-filter, catalog-wide)
  "filteredTotal": 41,             // exact match count inside this scan window (use for offset paging)
  "offset": 0,                     // legacy; reflects request param
  "limit": 24,
  "hasMore": true,
  "nextCursor": "eyJmcyI6MTcxNTAwMDAwMDAwMCwiaWQiOiJyYWluLXh5ei0wMDEifQ",
  "cached": true,                  // X-Cache mirror; true if snapshot reused
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
      "summary": "Build the iOS app from scratch with our 4-person founding team.",
      "industrySector": ["consumer_apps"],
      "remote": true,
      "sponsorship": null,
      "firstSeenAt": "2026-05-26T14:03:11.000Z",
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
}
```

### Field semantics

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Firestore doc id. Treat as opaque. |
| `wekruitUrl` | yes | **Partner pages MUST link to this URL** (not `atsApplyUrl`). WeKruit owns the candidate funnel. |
| `title` | yes | Job title. |
| `company` | yes | Company display name (free-form). |
| `function` | no | One of the 17 canonical `roleFunction` enums. Absent if uncategorized. |
| `level` | no | Canonical `seniorityLevel`. |
| `location` | no | First canonical bucket from `locationBuckets` (e.g. `new_york`, `remote_us`). |
| `locationRaw` | no | Raw human-readable location. |
| `comp` | no | Formatted salary range (`$180–240k`, `$150k+`) or undefined. |
| `posted` | no | Human-readable age (`3h`, `2d`, `1w`). |
| `summary` | no | First non-empty descriptive line, stripped of markdown. |
| `industrySector` | no | Array of canonical `industrySector` enums. |
| `remote` | yes | `true` if any location bucket / raw location matches `remote`. |
| `sponsorship` | no | `true` if employer sponsors visas, `false` if not, `null` if unknown. |
| `firstSeenAt` | no | ISO timestamp. Used for cursor pagination + freshness. |
| `collaborated` | collab only | Always `true` in collab mode (filter requires it). |
| `companyProfile` | collab only | Hydrated from `pa-companies`. Optional fields — partner should treat all as nullable. |

> **Fields NOT exposed in collab mode** (by design): `atsApplyUrl`, `source` (job-board provenance), `prescreenConfig.questions`, `recruiterBoard`, `publicId`, `hiringManager*`, `interviewSeats`, `fundingRounds`, internal scoring.

---

## Caching (REQUIRED — partner contract)

WeKruit pays per Firestore read. **You must honor the caching contract** or risk rate limiting / key revocation.

### Server response headers

```
Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600
ETag: "v1-a4f8c12e7b6d3f4a8e9c1234"
Vary: Accept-Encoding, Origin, X-WeKruit-Api-Key
X-Cache: HIT | MISS
```

### Required client behavior

1. **Respect `Cache-Control`.** Most HTTP clients (axios, fetch with `cache: 'default'`, requests, curl) do this automatically. If you're building your own cache, store responses for at least 60 seconds before refetching the same query.

2. **Use ETag revalidation.** Store the `ETag` from every response. On next refetch of the same query, send:

   ```
   If-None-Match: "v1-a4f8c12e7b6d3f4a8e9c1234"
   ```

   If nothing changed, you'll get `304 Not Modified` with no body. Reuse your cached payload.

3. **Don't poll faster than 60s** for the same query. Use webhook subscriptions (contact WeKruit) if you need lower latency for new postings.

4. **Cursor pagination is forward-only.** Walk pages once to ingest the catalog, then refetch from no-cursor periodically (every 1-6 hours) to catch new postings + retire stale ones.

5. **Treat `429` as back-off.** If you see one, sleep at least 60 seconds and try again with the same `If-None-Match`.

### Recommended client cache TTL

| Use case | TTL |
|---|---|
| Backend ingestion → your own DB | 5-15 min between refetches; nightly full cursor walk |
| Frontend rendering | 60 s (your CDN) + always-fresh on user demand |
| Listing widget embedded in partner site | 5 min CDN cache; revalidate with ETag |

---

## Pagination protocol

### Initial walk (ingest)

```
GET /paPublicOpenJobs?source=collab&limit=100
→ rows[0..99], nextCursor: "eyJ...", hasMore: true

GET /paPublicOpenJobs?source=collab&limit=100&cursor=eyJ...
→ rows[100..199], nextCursor: "eyJ...", hasMore: true

… repeat until hasMore=false …

GET /paPublicOpenJobs?source=collab&limit=100&cursor=eyJ...
→ rows[N..], nextCursor: null, hasMore: false
```

### Refresh (periodic)

Restart from no cursor every 1-6 hours to catch new postings, retire deleted ones, and pick up updates. Cursors may **dangle** if the underlying doc rotates out of the active snapshot — in that case the API silently restarts from offset 0 (you'll see the same first page again). Always idempotently upsert by `id` on your side.

### Paging signal

`hasMore` + `nextCursor` are the ONLY paging signals. Do **not** derive "more
pages" from `total` — since 2026-06-11 `total` is the catalog-wide count()
aggregate (it exceeds the browsable scan window). `filteredTotal` is the exact
in-window match count if you need offset math.

### Stable ordering

Rows are ordered by `firstSeenAt DESC`. Ties may shuffle within ~1 ms. Treat ordering as stable enough for cursor walks but never as a primary sort key on your side.

---

## Error responses

| Status | Shape | Notes |
|---|---|---|
| `200` | `{ok: true, ...}` | Success. |
| `304` | *(no body)* | ETag match. Use your cached payload. |
| `401` | `{ok: false, reason: "missing_api_key" \| "invalid_api_key"}` | Auth failure. |
| `403` | `{ok: false, reason: "origin_not_allowed"}` | Origin denied. |
| `405` | `{ok: false, reason: "method_not_allowed"}` | Use GET. |
| `503` | `{ok: false, reason: "collab_mode_not_configured"}` | Server-side secrets unset — contact WeKruit. |
| `500` | `{ok: false, reason: "<error message>"}` | Server error. Back off + retry. |

---

## Examples

### curl (server-to-server)

```bash
curl -sS \
  -H "X-WeKruit-Api-Key: $WEKRUIT_PARTNER_KEY" \
  -H 'Accept: application/json' \
  'https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicOpenJobs?source=collab&limit=100' \
  | jq '.rows[] | {id, title, company, wekruitUrl, comp}'
```

### curl with ETag revalidation

```bash
# First call
curl -sS -D headers.txt \
  -H "X-WeKruit-Api-Key: $WEKRUIT_PARTNER_KEY" \
  'https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicOpenJobs?source=collab&limit=100' \
  > page1.json
ETAG=$(grep -i '^etag:' headers.txt | cut -d' ' -f2- | tr -d '\r')

# Revalidate later
curl -sS -w '\nstatus: %{http_code}\n' \
  -H "X-WeKruit-Api-Key: $WEKRUIT_PARTNER_KEY" \
  -H "If-None-Match: $ETAG" \
  'https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicOpenJobs?source=collab&limit=100'
# → status: 304 (no body) if unchanged
```

### Node.js

```ts
import { fetch } from "undici"

const BASE = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicOpenJobs"

interface JobRow {
  id: string
  wekruitUrl: string
  title: string
  company: string
  comp?: string
  companyProfile?: { logoUrl?: string | null; companyStage?: string }
  // ... see field semantics above
}

interface PageResp {
  ok: true
  apiVersion: "v1"
  rows: JobRow[]
  hasMore: boolean
  nextCursor: string | null
}

const cache = new Map<string, { etag: string; rows: JobRow[] }>()

async function fetchAll(): Promise<JobRow[]> {
  const acc: JobRow[] = []
  let cursor: string | null = null
  do {
    const url = new URL(BASE)
    url.searchParams.set("source", "collab")
    url.searchParams.set("limit", "100")
    if (cursor) url.searchParams.set("cursor", cursor)

    const cacheKey = url.toString()
    const prior = cache.get(cacheKey)
    const headers: Record<string, string> = {
      "X-WeKruit-Api-Key": process.env.WEKRUIT_PARTNER_KEY!,
    }
    if (prior) headers["If-None-Match"] = prior.etag

    const res = await fetch(url, { headers })
    if (res.status === 304 && prior) {
      acc.push(...prior.rows)
      cursor = null // 304 means no change on this page; advance based on prior nextCursor if you tracked it
      break
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as PageResp
    const etag = res.headers.get("etag")
    if (etag) cache.set(cacheKey, { etag, rows: body.rows })
    acc.push(...body.rows)
    cursor = body.nextCursor
  } while (cursor)
  return acc
}
```

### Python

```python
import os, requests

BASE = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicOpenJobs"
HEADERS = {"X-WeKruit-Api-Key": os.environ["WEKRUIT_PARTNER_KEY"]}

def fetch_all():
    rows = []
    cursor = None
    while True:
        params = {"source": "collab", "limit": 100}
        if cursor:
            params["cursor"] = cursor
        r = requests.get(BASE, headers=HEADERS, params=params, timeout=30)
        r.raise_for_status()
        body = r.json()
        rows.extend(body["rows"])
        if not body["hasMore"]:
            break
        cursor = body["nextCursor"]
    return rows
```

---

## Versioning

- `apiVersion: "v1"` is the current stable contract.
- **Additive changes** (new optional fields on rows, new query params) are non-breaking and ship without notice. Always treat unknown fields as ignorable.
- **Breaking changes** (renames, removals, semantic changes) bump `apiVersion`. WeKruit will reach out before the bump and keep `v1` live alongside `v2` for at least 30 days.

---

## Rate guidance

There is no hard per-key rate limit today. WeKruit monitors usage and will reach out if a partner is generating excessive Firestore reads. Stay within these guardrails:

- Don't refetch the same query more than once per minute (per-region client).
- Don't open more than 8 concurrent connections to the endpoint.
- Walk cursor pagination to completion within 5 minutes of starting; don't park half-finished walks indefinitely.

---

## Contact

- Slack: `#wekruit-partners` (request access via your WeKruit point of contact)
- Email: `admin1@wekruit.com`
- Bug report: include the request URL, response status, ETag, and `generatedAt` timestamp.

---

## Server-side setup (WeKruit ops only)

Set the secrets before deploy:

```bash
# Partner API keys (CSV)
firebase functions:secrets:set PA_PUBLIC_COLLAB_API_KEYS --project wekruit-5f89b
# Paste: key_partnerA_<32chars>,key_partnerB_<32chars>

# Allowed browser Origins (CSV, or "*" to disable)
firebase functions:secrets:set PA_PUBLIC_COLLAB_ORIGINS --project wekruit-5f89b
# Paste: https://partner.com,https://staging.partner.com
# Or: *

# Redeploy the CF to pick up the secret bindings
cd apps/functions && pnpm run deploy
# Or scoped: firebase deploy --only functions:pa-orchestrator:paPublicOpenJobs --project wekruit-5f89b --non-interactive
```

To rotate a key without downtime:
1. Append the new key to the CSV; redeploy.
2. Notify partner; have them switch over.
3. Remove the old key from the CSV; redeploy.

Implementation: [apps/functions/src/public-open-jobs.ts](../src/public-open-jobs.ts). Tests: [apps/functions/src/__tests__/public-open-jobs.test.ts](../src/__tests__/public-open-jobs.test.ts).
