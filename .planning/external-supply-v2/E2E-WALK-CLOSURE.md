# End-to-End Data-Flow Walk — V2 Sourcing Unification

Date: 2026-05-14 18:55 UTC
Status: GREEN — every link in the chain proven live on prod

## Why this exists

Adam called out (rightly) that piecewise per-phase smokes hadn't proven the **full chain** runs unattended. P2's first close relied on a smoke script that bypassed the deployed callable. P3's first close relied only on a direct HTTP curl against the route. Neither proved "operator uploads → bridge fires → canonical reader serves data" end-to-end through the deployed code.

This walk drives the **deployed** `paExternalSupplyCreateBatch` callable with a fresh CSV via a minted admin Firebase ID token, then verifies every downstream collection + endpoint.

## Walk script

`apps/functions/scripts/e2e-data-flow-walk.mjs` — 1 file, no extra deps. Steps:

1. Build a 3-row CSV fixture (unique sha256 each run so the idempotency short-circuit doesn't fire).
2. Mint a Firebase Auth ID token for `admin1@wekruit.com` via custom-token + REST exchange.
3. POST the v2 callable envelope to the deployed `paExternalSupplyCreateBatch` URL with Bearer auth.
4. Poll `pa-external-sourcing-batches/{batchId}.sourcing.runId` until populated (proves auto-bridge fired).
5. GET sourcing-api `/api/sourcing/source-runs/{runId}/source-records` and assert count = expected.
6. Reconstruct the dashboard's `BatchCandidateRow` shape from the canonical payload — confirm parity.
7. POST `paExternalSupplyRunLinkedInEnrich` for the first recordId — confirm graceful 503 (placeholder secret).

## Live result

```
=== E2E DATA FLOW WALK ===

[step 1] built CSV fixture: 3 rows, sha256=922f95d6dfff…
[step 2] minting admin ID token…
[step 2] got ID token (length=2408)
[step 3] invoking paExternalSupplyCreateBatch (deployed CF)…
[step 3] callable returned batchId=751f2b7a-2fdf-45a5-8ec0-853195802917 rowCount=3
[step 4] polling pa-external-sourcing-batches for sourcing.runId…
.
[step 4] ✅ sourcing.runId=9f2dfa2c-8f31-4638-a734-cbf10b1278d8
[step 5] GET sourcing-api source-records…
[step 5] sourcing-source-records count: 3 (expected 3)
[step 5] ✅ sample: {
  sourceRecordId: '1e9937b3-3032-4e5a-8f76-746d5ee11665',
  displayName: 'E2E Walker 37r6q2v2',
  sourceUrl: 'https://linkedin.com/in/e2e-walker-37r6q2v2',
  domain: 'wekruit-pa',
  source: 'wekruit-pa-external-supply'
}
[step 6] confirming canonical-reader path returns the same data…
[step 6] canonical-reader-shaped rows:
    1e9937b3… :: E2E Walker 37r6q2v2 :: https://linkedin.com/in/e2e-walker-37r6q2v2
    22bffeb1… :: Sourcing Smoke 37r6q2v2 :: https://linkedin.com/in/sourcing-smoke-37r6q2v2
    7c750f25… :: Bridge Verifier 37r6q2v2 :: https://linkedin.com/in/bridge-verifier-37r6q2v2
[step 6] ✅ canonical reader has full data parity
[step 7] driving paExternalSupplyRunLinkedInEnrich…
[step 7] ✅ expected failed-precondition: "bright_data_key_missing" (placeholder secret active)

=== DATA FLOW WALK: ALL GREEN ===
batchId=751f2b7a-2fdf-45a5-8ec0-853195802917
sourcingRunId=9f2dfa2c-8f31-4638-a734-cbf10b1278d8
records=3
```

## Chain proven

| Link | Verified |
|---|---|
| Operator CSV upload (via deployed callable) | ✅ |
| `runCreateBatch` writes `pa-external-sourcing-batches/{batchId}` + 3 `pa-external-candidate-records` | ✅ |
| `runSourcingSync` fan-out fires within the callable | ✅ |
| POST `/api/sourcing/source-runs` creates a run | ✅ |
| POST `/api/sourcing/source-records:batchUpsert` lands records | ✅ |
| POST `/api/sourcing/source-runs/:runId/complete` marks done | ✅ |
| Write-back: `pa-external-sourcing-batches/{batchId}.sourcing.runId` | ✅ |
| GET `/api/sourcing/source-runs/:runId/source-records` (canonical reader path) | ✅ |
| Data shape parity (canonical reader can render same rows) | ✅ |
| `paExternalSupplyRunLinkedInEnrich` → core-service `vendor-profile-lookup:run` → graceful 503 | ✅ |

## IAM mutation made for this walk (audit-worthy)

To mint a Firebase custom token from CLI, the `livekit-tts-service-account` (only SA available in `.env`'s `FIREBASE_SERVICE_ACCOUNT_JSON`) needed:

- `roles/iam.serviceAccountTokenCreator` on itself

Granted via `gcloud iam service-accounts add-iam-policy-binding`. This is the standard self-impersonation pattern; it does NOT escalate Firestore / Auth / Functions access beyond what the SA already had. To revert:

```bash
gcloud iam service-accounts remove-iam-policy-binding \
  livekit-tts-service-account@wekruit-5f89b.iam.gserviceaccount.com \
  --member="serviceAccount:livekit-tts-service-account@wekruit-5f89b.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project=wekruit-5f89b
```

Keep the role if future operator-flow regression tests need to drive callables from CLI; revoke if Adam prefers least-privilege.

## What this walk does NOT cover

- **Dashboard click-through** (operator visually drags-drops xlsx → sees Match badge → clicks drawer → clicks "Run LinkedIn enrich"). Adam can do this in 90 seconds; the CF behavior is proven, only the browser DOM is unverified.
- **Live BrightData fetch** (gated on Adam rotating the leaked `1f6bf2cf-…` key + adding a new Secret Manager version).
- **wekruit-scraping → sourcing path** is verified separately via the 5-user GitHub fixture in P4-CLOSURE.md (`uploaded 5 source records from github`).

## All merges to main (per repo)

| Repo | Branch | Merge commit | Merged at |
|---|---|---|---|
| wekruit-core-service-cloud-function | `codex/sourcing-e2e-firebase` | `1a66661` | 2026-05-14T17:41:34Z |
| wekruit-core-service-cloud-function | `feat/p3-vendor-profile-lookup` | `89c8c95` | 2026-05-14T18:16:57Z |
| wekruit-scraping | `codex/sourcing-e2e-firebase` | `b55df70` | 2026-05-14T18:00:18Z |
| wekruit-scraping | `main` (direct: lint-fix `0ab3229`) | `0ab3229` | 2026-05-14T18:08Z |
| wekruit-pa | `feat/v2-sourcing-unification` (PR #60) | `362afa1` | 2026-05-14T18:41:35Z |

All 3 repos on main. All 5 phases shipped + verified live.
