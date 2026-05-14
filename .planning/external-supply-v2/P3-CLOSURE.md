# P3 Closure — Dashboard "Run LinkedIn enrich" → BrightData via sourcing-api

Date: 2026-05-14
Owner: claude
Status: GREEN (code live; final live-fetch e2e gated on Adam's BrightData key rotation)

## What shipped

### core-service (PR #2 merged)
- `src/services/sourcing/integrations/brightdata.ts` (new, ~190 LOC) — sync BrightData client for dataset `gd_l1viktl72bvl7bjuj0` (LinkedIn-profile-by-URL). Treats empty / `PENDING_*` / `PLACEHOLDER*` keys as missing.
- `src/services/sourcing/application/service.ts` `runVendorProfileLookup()` — resolves a LinkedIn URL from one of three input shapes, persists audit run + match docs, returns the BrightData payload.
- `src/services/sourcing/repositories/sourcingRepository.ts` — added `getApprovedEntity`, `getSourceRecord`, `upsertVendorProfileMatch`, `upsertVendorEnrichmentRun`.
- `src/services/sourcing/functions/http/api.ts` — new route POST `/api/sourcing/vendor-profile-lookup:run` with 400/404/422/502/503 status-code mapping.
- `src/shared/firestore/collections.ts` — added `vendorEnrichmentRuns`, `vendorProfileMatches` collections under sourcing prefix.
- Firebase secret binding: `BRIGHT_DATA_API_KEY` (placeholder set, awaiting Adam rotation).
- Function deployed with 120s timeout for BrightData sync poll.

Merge commit: `89c8c9583ef59ed44acb639062f8b7add67a0f2a`

### wekruit-pa (this PR)
- `apps/functions/src/external-supply/run-linkedin-enrich.ts` (new, ~115 LOC) — admin callable `paExternalSupplyRunLinkedInEnrich({recordId|linkedinUrl|approvedEntityId})`. Translates dashboard input into POST against core-service vendor-profile-lookup route. Maps 503→`failed-precondition` so dashboard surfaces "key not configured" toast.
- `apps/functions/src/index.ts` — exports new CF.
- `apps/dashboard-web/src/lib/external-supply-client.ts` — `runLinkedInEnrich` callable wrapper.
- `apps/dashboard-web/src/pages/external-supply/BatchCandidates.tsx` — "Run LinkedIn enrich (BrightData)" button in candidate drawer + result-render `<details>` block with snapshot/match/run IDs + collapsible profile JSON.

## Verification

### Live smoke against prod `/api/sourcing/vendor-profile-lookup:run` (placeholder secret)
```
$ curl -sS -X POST .../api/sourcing/vendor-profile-lookup:run -H "content-type: application/json" -d '{}'
HTTP 400: {"error":{"message":"one_of_sourceRecordId_approvedEntityId_linkedinUrl_required"}}

$ curl ... -d '{"linkedinUrl":"https://www.linkedin.com/in/torvalds"}'
HTTP 503: {"error":{"message":"BRIGHT_DATA_API_KEY secret is not configured"}}

$ curl ... -d '{"sourceRecordId":"does-not-exist"}'
HTTP 404: {"error":{"message":"source_record_not_found:does-not-exist"}}
```

All 3 expected status codes return correctly. Route is live and validation-correct.

### Typecheck + build
- `npm run typecheck` on core-service — clean
- `pnpm --filter @pa/functions typecheck` — clean
- `pnpm --filter @pa/dashboard-web typecheck` — clean
- All builds succeeded

### Deploys
- `core-service:sourcing-api` (us-central1, nodejs20, timeout 120s, secrets: [BRIGHT_DATA_API_KEY]) — updated
- `pa-orchestrator:paExternalSupplyRunLinkedInEnrich` (us-central1, nodejs22, 180s timeout) — created
- `hosting:pa-dashboard` → `https://wekruit-pa.web.app` — released

### Operator smoke URL
```
https://wekruit-pa.web.app/admin/external-supply/batches/b3b63f6a-c5e0-4866-97af-96d1f51d2efa/candidates
```
Click any candidate with a LinkedIn URL → drawer renders → click **"Run LinkedIn enrich (BrightData)"**. Today it returns `"BrightData key not configured on prod yet — Adam needs to rotate + secret-set BRIGHT_DATA_API_KEY"`. Once Adam sets the real key, the same button fetches the live LinkedIn snapshot and renders the BrightData JSON in the collapsible `<details>` block — **no redeploy required** (2nd-gen runtime picks up the new secret version on next cold start).

## Adam unblock (one-step)

```bash
# 1. Revoke the leaked key in BrightData console: 1f6bf2cf-760b-4178-874f-4391a6af8d23
# 2. Generate new key at brightdata.com → API tokens
# 3. Add as Secret Manager version:
echo -n "<NEW_KEY>" | gcloud secrets versions add BRIGHT_DATA_API_KEY \
  --project=wekruit-5f89b --data-file=-
```

The current placeholder `PENDING_ROTATION_BY_ADAM` is version 1. Adding the real key as version 2 means existing function bindings automatically pick it up on the next cold start.

## Persistence schema

Two new sourcing collections persist enrichment trace per call:

| Collection | Doc shape |
|---|---|
| `sourcing-vendor-enrichment-runs/{runId}` | `{vendor, dataset, subjectKind, subjectId, linkedinUrl, status: running|ready|building|failed, snapshotId?, error?, createdAt, completedAt}` |
| `sourcing-vendor-profile-matches/{subjectId__snapshotId}` | `{vendor, dataset, subjectKind, subjectId, linkedinUrl, snapshotId, status, profile: object, runId, createdAt, updatedAt}` |

When BrightData responds synchronously (within 90s), `status=ready` + `profile` is populated. When sync window times out, `status=building` + `snapshotId` is the handle to poll — future P3.1 work can add a Cloud Scheduler job that polls outstanding `building` runs and updates the match doc.

## Open / next-sprint work

- **Async-poll job** for `status=building` runs (cron CF every 5 min walking `sourcing-vendor-enrichment-runs` where `status === 'building'`, calling `fetchSnapshot()`, writing back to match doc + run doc).
- **OpenAI content enrichment** (the other half of spec P3 mention). Same architecture as BrightData: integration file + route + service method + UI button.
- **Auth on sourcing-api** before letting unauthenticated callers trigger BrightData (they currently can — billing risk before Adam's key gets rotated in). Stop hook for the next sprint.

## Done criteria check

| Check | Status |
|---|---|
| `integrations/brightdata.ts` exists in core-service | ✅ |
| `/api/sourcing/vendor-profile-lookup:run` route live | ✅ (3/3 status codes smoke-verified) |
| Dashboard "Run LinkedIn enrich" button exists in drawer | ✅ |
| Admin CF wrapper deployed | ✅ `paExternalSupplyRunLinkedInEnrich` (us-central1) |
| BrightData secret binding | ✅ `BRIGHT_DATA_API_KEY` v1 = placeholder, awaiting Adam rotation |
| Graceful degradation on missing key | ✅ 503 → friendly toast |
| Persistence schema (run + match docs) | ✅ `sourcing-vendor-enrichment-runs` + `sourcing-vendor-profile-matches` |
| End-to-end live BrightData fetch | ⏸️ Gated on Adam's key rotation (operator-side, one CLI command) |
| Closure file | ✅ this file |
