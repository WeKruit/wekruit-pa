# Partner Users API + Privacy Disclosure — Design Spec

**Status:** draft, design approved by Adam (2026-05-27)
**Author:** Claude
**Scope:** new public HTTP Cloud Function exposing partner-referred user candidacy status (initial partner: `layoffhedge`), plus parallel privacy-policy update disclosing the data-sharing relationship.

## 1. Problem

We just shipped `?source=layoffhedge` attribution capture — every candidate
who arrives from layoffhedge.com is stamped with `pa-users.source = "layoffhedge"`
on first signup (PR #222, merged `48a67841`).

Layoffhedge has no programmatic way to see what happened to those candidates
afterwards. They cannot see:

- which of their referrals actually registered
- which jobs each referral has been pre-screened for
- the status of each pre-screen (passed / not_passed / in-progress)
- whether any of their referrals progressed to employer-visible

Today the only place that data lives is our admin dashboard (`paAdminPassedCandidatesSnapshot`
+ per-job views), which requires `@wekruit.com` sign-in. Partners cannot reach
it.

## 2. Goal

Expose a single authenticated HTTPS endpoint that layoffhedge (and future
partners using the same enum-extension pattern) can poll to retrieve their
referred candidates' candidacy progress.

Each partner sees ONLY their own attributed candidates. Cross-partner data
leakage is blocked at the auth layer by deriving the source filter from the
API key prefix.

## 3. Non-Goals

- Webhook push (poll-only v1).
- Real-time candidate updates (60s snapshot cache acceptable).
- Write operations (partner cannot mark candidates as no-show etc.).
- Resume content / transcript bodies (PII tier 2 — not exposed).
- Multi-partner DPA template (legal handles per partner).
- Per-call rate limiting beyond Firebase's built-in (defer to v2 if abused).
- Backfill of pre-ship attribution: only `source == "layoffhedge"` data is
  returnable; pre-PR-#222 layoffhedge traffic was bucketed as `candidate`
  and is unrecoverable.

## 4. Architecture

### 4.1 New HTTPS Cloud Function — `apps/functions/src/partner-users-api.ts`

```
GET https://<wekruit-domain>/api/v1/partner/users
Headers:
  X-API-Key: key_<partnerSource>_<random>
Query (all optional):
  status   = csv of CandidateJobState values; default: all
  since    = ISO 8601 timestamp; default: all
  cursor   = opaque base64; default: first page
  limit    = integer 1..200; default: 50
```

The function is a new HTTP `onRequest` handler exported from
`apps/functions/src/index.ts` as `paPartnerUsersApi`. Region `us-central1`,
512 MiB memory, max instances 10 (low expected traffic).

### 4.2 Auth — `verifyPartnerKey()`

Reuses the constant-time CSV-compare pattern from `verifyCollabAuth` in
`apps/functions/src/public-open-jobs.ts:527`. **Reuses the SAME secret as the
job API** — `PA_PUBLIC_COLLAB_API_KEYS` (Adam directive 2026-05-27: "we already
have a key… why a new one"). One key per partner; the key layoffhedge already
holds for the job API also authorizes this users feed, scoped to their source.
No new secret to provision → no pre-deploy secret-creation step.

```
Secret: PA_PUBLIC_COLLAB_API_KEYS  (shared with paPublicOpenJobs)
Format: CSV of keys, each shaped `key_<partnerSource>_<random>`
Example: "key_layoffhedge_abc123def456,key_partnerB_xyz789..."
```

**Security note (Adam-owned tradeoff):** because the secret is shared with the
job API, every holder of a job-API key can also call the users feed — but only
for their OWN source bucket (per-partner isolation via key-prefix parse still
holds). Acceptable while layoffhedge is the only external partner. If a future
job-API partner must NOT see candidate PII, split secrets at that point.

Key prefix parsing:

```ts
const PARTNER_KEY_RE = /^key_([a-z][a-z0-9_]+)_[A-Za-z0-9]+$/
const match = PARTNER_KEY_RE.exec(apiKey)
if (!match) return { ok: false, reason: "invalid_api_key_format" }
const partnerSource = match[1]
if (!isPaUserSource(partnerSource)) return { ok: false, reason: "key_partner_mismatch" }
```

The `isPaUserSource` check anchors the key vocabulary to the canonical
`PA_USER_SOURCES` enum from PR #222 — a key for an unknown partner source
fails at the gate, preventing typo-driven data exposure.

Origin allowlist via `PA_PUBLIC_COLLAB_ORIGINS` (reused — server-to-server
calls with no `Origin` header are accepted on key alone, matching the
existing public-open-jobs convention).

### 4.3 Query layer

```ts
async function fetchPartnerUsers(args: {
  db: Firestore
  partnerSource: PaUserSource
  status?: CandidateJobState[]
  since?: string  // ISO 8601
  cursor?: { createdAtMs: number; docId: string }
  limit: number
}): Promise<PartnerUsersResponse>
```

Two-stage query:

1. **Users page** — `pa-users` collection:
   ```
   where source == partnerSource
   orderBy createdAt desc, __name__ desc
   startAfter cursor.createdAtMs, cursor.docId   // when cursor present
   limit N+1                                      // N+1 to detect hasMore
   ```
   Returns up to `limit` user docs. The extra row drives `hasMore`.

2. **Per-user job states** — for each returned user, in parallel
   (`Promise.all` with a soft cap of 25 concurrent):
   ```
   pa-candidate-job-states
   where candidateId == user.id
   orderBy stateUpdatedAt desc
   limit 50  // per-user cap; flagged in response if hit
   ```

3. **Optional state filter** — `?status=passed,prescreen_started` filters
   the per-user job-states list AFTER the read (cheap; small per-user list).
   `since` is applied to `stateUpdatedAt` similarly.

4. **Job title hydration** — for each returned job-state, look up
   `pa-jobs/{jobId}.title` and `pa-jobs/{jobId}.company`. Cached per request
   (one batch read per page) so a candidate appearing in 5 jobs only triggers
   `min(5, distinct jobIds)` job-doc reads at the page level.

5. **Latest prescreen session ID** — per-user-job lookup the latest
   `pa-prescreen-sessions` doc where `candidateId == user.id and jobId ==
   job.jobId`, ordered by `updatedAt desc limit 1`. Return only the session
   `id` field; the partner can correlate against their own records. (No
   denormalized turn count is currently maintained on the session doc, so we
   do NOT promise `prescreenTurnsCount` in the response — the partner gets
   the session id + the `CandidateJobState` which is the authoritative
   progress signal anyway.)

### 4.4 Response shape

```json
{
  "users": [
    {
      "email": "candidate@example.com",
      "name": "Jane Doe",
      "wekruitUserId": "GR17ggfRiyEdE5a2JWaf",
      "registeredAt": "2026-05-27T22:09:17Z",
      "lifecycleState": "claimed",
      "jobs": [
        {
          "jobId": "hs-10996795-invoko-product-manager",
          "jobTitle": "Product Manager",
          "company": "Invoko",
          "state": "prescreen_started",
          "stateUpdatedAt": "2026-05-28T15:42:11Z",
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
  "nextCursor": "eyJjcmVhdGVkQXRNcyI6MTc3OTkyMTUzNzE4NSwiZG9jSWQiOiJHUjE3...",
  "hasMore": false,
  "generatedAt": "2026-05-28T16:00:00Z",
  "partner": "layoffhedge",
  "apiVersion": "v1"
}
```

PII fields explicitly opted in by Adam's brainstorm decision 2026-05-27:
- `email` — verified email handle from `pa-users.email` or magic-link claim
- `name` — display name from `pa-users.displayName` (omitted if null)

Tier-2 fields explicitly NOT included (out of scope for partner API):
- `phoneE164` / `linkedinUrl`
- resume URL / parsed resume content
- prescreen transcript turns
- memory facts / conversation extracts
- visa status / salary preference / location preference (candidate's own
  preferences, not partner business)

### 4.5 Cursor

Opaque base64 of `{ createdAtMs: number; docId: string }`. Encoded with the
same `Buffer.from(JSON.stringify(payload)).toString("base64url")` pattern
used in `paPublicOpenJobs`. Decoded with schema validation — malformed cursor
returns 400 `invalid_query`.

### 4.6 Caching

60s LRU module-scope cache keyed by
`(partnerSource, status-csv, since, cursor, limit)`. Matches `paPublicOpenJobs`
`SNAPSHOT_TTL_MS`. Partners polling at 1/min get fresh data; faster polling
hits cache. Cache survives within a warm instance only; cold start = fresh query.

### 4.7 Error contract

| HTTP | Reason | Cause |
|---|---|---|
| 401 | `missing_api_key` | header missing |
| 401 | `invalid_api_key` | key not in CSV |
| 401 | `invalid_api_key_format` | key shape doesn't match `key_<source>_<random>` |
| 403 | `key_partner_mismatch` | parsed prefix is not a valid `PaUserSource` |
| 403 | `origin_not_allowed` | `Origin` header set but not in `PA_PUBLIC_COLLAB_ORIGINS` |
| 400 | `invalid_query` | bad cursor / limit out of range / unknown status enum |
| 500 | `internal_error` | uncaught; logged with request fingerprint (`req.headers["x-api-key"]` SHA-256 truncated) |

CORS: respond to `OPTIONS` preflight with `Access-Control-Allow-Origin: *`
(server-to-server is the dominant case; the Origin gate above still applies
to browsers).

### 4.8 Observability

Structured log lines (Cloud Logging):

```
paPartnerUsersApi ok          partner=layoffhedge users=12 hasMore=true latency_ms=180
paPartnerUsersApi auth_fail   reason=invalid_api_key_format key_fp=abc123 origin=https://layoffhedge.com
paPartnerUsersApi query_fail  reason=invalid_query field=cursor partner=layoffhedge
```

`key_fp` = first 8 hex chars of `sha256(apiKey)` — enough to disambiguate
which key is failing without logging the secret.

## 5. Legal / Privacy Updates

Parallel to the code work, two surfaces need amended copy:

### 5.1 `apps/pa-landing/src/pages/Legal.tsx` (candidate.wekruit.com /legal)

Extend the existing **"Who can see your data"** section with a new paragraph:

> **Partner referrals.** If you arrived at WeKruit through a referral link from a partner site (such as a layoff-tracking service that included `?source=<partner>` in the URL you clicked), we share your candidacy progress with that partner. Specifically: your email, name, the jobs you've started pre-screening for, and the status of each pre-screen (in progress / passed / not passed / paused). We do not share your résumé, conversation transcript, or other sensitive details with the partner. You can request that we stop sharing by emailing hello@wekruit.com.

Append a new section near the bottom **"Partners we share with"** that maintains a list (initially: `layoffhedge.com`). When a new partner is added (new `PA_USER_SOURCES` enum value), this list MUST be updated in the same PR as the enum extension.

Bump `Version v1.0 · Last updated May 5, 2026` to `v1.1 · Last updated May 27, 2026`.

### 5.2 `apps/dashboard-web/src/pages/Legal.tsx` (admin domain `wekruit-pa.web.app/legal`)

Read the file: it is a near-verbatim copy of the pa-landing Legal page (same sections in the same order, slightly different styling). Apply the SAME two amendments as §5.1 (Partner referrals paragraph in "Who can see your data"; new "Partners we share with" section; version bump). Reason: business testers and admin-onboarded candidates may also be the audience for this URL — keep the two copies in sync.

### 5.3 `layoff.wekruit.com/legal`

Verified 2026-05-27: `firebase.json` `layoff` target shares the same `public: "apps/pa-landing/dist"` build output as the `pa-landing` target (only the hosting headers differ). So a single edit to `apps/pa-landing/src/pages/Legal.tsx` automatically propagates to both `candidate.wekruit.com/legal` and `layoff.wekruit.com/legal` after the pa-landing hosting deploy. No separate file to edit.

## 6. File Structure (new + modified)

| File | Action | Responsibility |
|---|---|---|
| `apps/functions/src/partner-users-api.ts` | **create** | HTTP handler + auth + query layer + response shaping. |
| `apps/functions/src/__tests__/partner-users-api.test.ts` | **create** | Unit/integration coverage. |
| `apps/functions/src/index.ts` | **modify** | Add `export { paPartnerUsersApi } from "./partner-users-api.js"`. |
| `firebase.json` | **modify** (maybe) | Add hosting rewrite `^/api/v1/partner/users` → `paPartnerUsersApi`. (Or accept the raw cloudfunctions.net URL — see §7.) |
| `apps/pa-landing/src/pages/Legal.tsx` | **modify** | Add "Partner referrals" paragraph + "Partners we share with" section + version bump. |
| `docs/superpowers/specs/2026-05-27-partner-users-api-design.md` | (this file) | spec |
| `docs/superpowers/plans/2026-05-27-partner-users-api.md` | **create** | implementation plan (next step) |

## 7. Endpoint URL Decision

Two viable forms:

1. **Direct CF URL**: `https://papartnerusersapi-evm6xq7jyq-uc.a.run.app/`
   - Pro: zero hosting config; immediate after deploy
   - Con: ugly; reveals internal infra; cache headers tied to CF defaults
2. **Hosting rewrite via wekruit.com**: `https://wekruit.com/api/v1/partner/users`
   - Pro: clean; matches partner expectations; allows CDN caching at the hosting layer
   - Con: requires `firebase.json` rewrite + the `pa-landing` hosting site already serves wekruit.com, so layoff.wekruit.com would NOT get this route

**Decision: hosting rewrite.** Add to `firebase.json` `pa-landing` site rewrites. The new rule MUST come BEFORE the existing `"source": "**", "destination": "/index.html"` catch-all (Firebase Hosting picks the first matching rewrite):

```json
"rewrites": [
  {
    "source": "/api/v1/partner/users",
    "function": { "functionId": "paPartnerUsersApi", "region": "us-central1" }
  },
  {
    "source": "**",
    "destination": "/index.html"
  }
]
```

`candidate.wekruit.com`, `pa.wekruit.com`, and apex `wekruit.com` all CNAME
to the same `wekruit-pa-landing` hosting site, so any of those resolves the
API URL. The `layoff` target shares the same dist but does NOT need the
rewrite (the function is not partner-facing on the layoff domain) — keep
the rewrite under `pa-landing` only, NOT under `layoff`.

Document the canonical form as `https://wekruit.com/api/v1/partner/users`
in the partner-facing API docs (not in this repo).

## 8. Compatibility & Migration

- New endpoint; no existing consumer.
- **No new secret.** Reuses `PA_PUBLIC_COLLAB_API_KEYS` (already provisioned for
  the job API). If layoffhedge already holds a `key_layoffhedge_<random>` key in
  that secret, the deploy works immediately with zero pre-deploy provisioning.
  Verify the existing key's prefix is exactly `key_layoffhedge_…`; if their
  current job-API key uses a different slug, add a `key_layoffhedge_<random>`
  entry to the existing CSV secret (one `gcloud`/console edit, not a new secret).
- Any key value is communicated out-of-band to the partner (encrypted message;
  not in any git commit or log).
- Subsequent partners follow the same recipe: add their slug to `PA_USER_SOURCES`
  + add a `key_<slug>_<random>` entry to the existing CSV secret + update
  `Legal.tsx` partners list.

## 9. Risk & Mitigation

| Risk | Mitigation |
|---|---|
| Key leaks via partner-side log / repo / etc. | Constant-time compare; key fingerprint logged on auth_fail; rotation via secret update (no code change). One key = one partner, so revoke = remove that one line from CSV. |
| Partner enumerates candidate emails to scrape | Per-partner data isolation (key prefix = source filter); rate limiting via Cloud Run max instances; 60s snapshot cache; pagination cap (limit ≤ 200). |
| Schema drift on `pa-candidate-job-states` breaks response | Hard typed via `CandidateJobStateDocSchema` parse; failures fall back to `archived` with a logged warn — partner gets the doc but with a degraded state instead of a 500. |
| `pa-jobs` doc missing for a referenced jobId | Job title hydration uses `?? "Unknown role"`; partner sees the row, just without a title. Better than dropping the row. |
| Cursor stable across schema changes | Cursor encodes only `createdAtMs + docId` — both immutable. No schema reference. |
| Partner queries with explosive page size | `limit` clamped to `[1, 200]` server-side; default 50. |
| GDPR / privacy push back from candidates | §5 legal updates land in same PR; opt-out path via `hello@wekruit.com`. |
| Stale read after candidate revoke / delete | 60s cache; partner sees old row for up to a minute. Acceptable per Adam's design (analytics, not real-time). |

## 10. Test Plan

### 10.1 Unit

- `verifyPartnerKey()` — valid key, missing header, invalid format, unknown source, constant-time pass (run multiple invalid keys and assert no early-exit timing leak — basic check via repeated calls).
- `parseQuery()` — limit clamping, status csv parsing, since ISO parsing, cursor base64 round-trip.
- `buildResponse()` — given a synthetic Firestore result set, produces the documented JSON shape with PII fields populated and tier-2 fields absent.

### 10.2 Integration (FakeFirestore)

- Pollution test: 3 layoffhedge users + 2 candidate users + 1 admin user. API returns exactly the 3 layoffhedge users.
- Pagination: 5 layoffhedge users, limit=2 → 3 pages, hasMore monotonically false at end.
- Status filter: `?status=passed` returns only users with ≥1 `passed` job-state.
- Since filter: `?since=2026-05-28T00:00:00Z` returns only users with state changes after that ISO time.
- Cross-partner isolation: a `key_layoffheaven_...` key returns zero rows from a fixture full of `layoffhedge` users (and vice versa).

### 10.3 Live deploy verification

- After deploy: probe via `curl -H "X-API-Key: <test-key>" https://wekruit.com/api/v1/partner/users` and confirm 200 + non-empty body.
- Negative: omit header → 401; wrong key → 401; mismatched origin → 403.

## 11. Rollout

1. Land code + tests + legal copy in one PR.
2. Predeploy gate green (orchestrator + functions + landing).
3. Confirm layoffhedge has a `key_layoffhedge_<random>` entry in the EXISTING
   `PA_PUBLIC_COLLAB_API_KEYS` secret. If not, add one (edit the existing CSV
   secret — no new secret to create). The function attaches the secret via
   `defineSecret("PA_PUBLIC_COLLAB_API_KEYS")` already used by the job API.
4. Deploy:
   - `firebase deploy --only functions:pa-orchestrator:paPartnerUsersApi`
   - `firebase deploy --only hosting:pa-landing` (picks up the rewrite)
5. Live probe (see §10.3) using layoffhedge's existing key.
6. If a NEW key value was added in step 3, transmit it to layoffhedge via
   password manager / encrypted message — NOT email, NOT chat. Out of band.
   If they already had the key (from job-API onboarding), nothing to send.
7. Mark v1 GA.

## 12. Open Questions

None at design time. Resolved decisions:

1. **Auth pattern** → CSV key with prefix-derived partner; new secret separate from job-API keys (Adam confirmed reuse-the-key-API-pattern, not reuse-the-secret-value).
2. **PII tier** → Email + name returned; transcript / resume / memory NOT returned (Adam 2026-05-27).
3. **Endpoint shape** → single fat endpoint with embedded jobs[] (Adam 2026-05-27).
4. **Hosting rewrite** → `wekruit.com/api/v1/partner/users` (clean URL, CDN-cacheable).
5. **layoff.wekruit.com legal** → out of scope; defer until verified whether shared or separate file.
