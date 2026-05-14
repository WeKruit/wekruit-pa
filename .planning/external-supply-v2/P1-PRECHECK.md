# P1 Precheck — Spec vs Reality (2026-05-14)

## Branch name correction

Spec says: `codex/website-shared-tags-integration-plan`
Reality: branch **does not exist** on either core-service or scraping repos.

Real canonical branch (both repos): **`codex/sourcing-e2e-firebase`**.

| Repo | Latest commit | Diff vs main |
|---|---|---|
| wekruit-core-service-cloud-function | `79ab498 Point sourcing deploys at dedicated hosting site` | 37 files, 7396 insertions (NOT 13k) |
| wekruit-scraping | `315f92c Add sourcing design context` | 5 commits ahead, sourcing_client.py + sourcing_records.py + sourcing_upload_file.py |

## Actual core-service `src/services/sourcing/` contents

```
src/services/sourcing/
├── application/{dedup.ts 173, extraction.ts 216, service.ts 480}.ts
├── domain/records.ts (206 lines)
├── functions/http/api.ts (183 lines)
└── repositories/sourcingRepository.ts (216 lines)
Total: 1474 LOC
```

Hosting config: `/api/sourcing/**` rewrites → CF `sourcing-api`. Dedicated hosting site.

## Actual HTTP routes that EXIST

- GET `/health`, GET `/api/sourcing/health`
- GET/POST `/api/sourcing/source-runs`
- GET `/api/sourcing/source-runs/:runId/source-records`
- POST `/api/sourcing/source-records:batchUpsert`  ← **P2 uses this**
- POST `/api/sourcing/source-runs/:runId/complete`
- GET `/api/sourcing/dedup-candidates`
- POST `/api/sourcing/review-labels`
- GET `/api/sourcing/approved-entities`

## Routes that DO NOT EXIST (spec assumed they did)

- POST `/api/sourcing/approved-entities/:id/vendor-profile-lookup:run` ← P3 dead
- POST `/api/sourcing/approved-entities/:id/enrichment:generate` ← P3 dead

## Files that DO NOT EXIST in branch (spec said they did)

- `integrations/brightdata.ts` (spec said 783 lines)
- `integrations/openai.ts` (spec said 302 lines)
- `application/enrichment.ts` (spec said 570 lines)
- `application/linkedin.ts`

## Decision: descope P3, re-anchor P5

P3 ("Run LinkedIn enrich" button → BrightData) is **not 90 min of UI wire-up**. It is **6-8h of building integrations from scratch** (brightdata.ts + openai.ts + new vendor-profile-lookup route + service method + repository + UI). That's a separate sprint.

**Revised plan**:
- P1 — Ship **what exists**: ingest + dedup + review-label pipeline. Land core sourcing service in prod. ✅ unchanged.
- P2 — Bridge wekruit-pa `paExternalSupplyCreateBatch` → `/api/sourcing/source-records:batchUpsert`. ✅ unchanged.
- ~~P3 — Run LinkedIn enrich button~~ **DESCOPED**. Logged as separate sprint `V2-SOURCING-ENRICHMENT-SPRINT.md` (to write). Build brightdata.ts + openai.ts + route + UI in a dedicated sprint.
- P4 — wekruit-scraping merge + GitHub fixture smoke. ✅ unchanged.
- P5 — Dashboard canonical reader flip to `sourcing-source-records` (NOT `sourcing-candidate-profiles` since that collection isn't populated yet — no enrichment pipeline). ✅ adjusted.

## What "done" means for this sprint (revised)

- Core-service `codex/sourcing-e2e-firebase` merged → main, sourcing-api deployed.
- Every wekruit-pa external-supply batch upsert lands in `sourcing-source-records`.
- Dashboard browses rain batch via canonical sourcing-source-records reader.
- Scraping repo merged + GitHub fixture lands 5 rows in `sourcing-source-records`.
- BrightData enrichment = next sprint.

## What is NOT blocked

- Adam's rotated BrightData key is **not needed for P1-P5 revised**. No BrightData calls until enrichment sprint. Can still set the Firebase secret pre-emptively, but it's not a P1 gate anymore.
