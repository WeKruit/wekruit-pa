# P1 Closure — core-service sourcing service live on prod

Date: 2026-05-14
Owner: claude
Status: GREEN with incident debrief

## What shipped

PR: https://github.com/WeKruit/wekruit-core-service-cloud-function/pull/1
Merge commit: `1a66661789b3e0675e3484b23801e2ba8a581f67`
Merged at: 2026-05-14T17:41:34Z

Function deployed to prod (`wekruit-5f89b`):
- `core-service:sourcing-api` (HTTP, us-central1, nodejs20, 2nd Gen)
- Public URLs:
  - https://us-central1-wekruit-5f89b.cloudfunctions.net/sourcing-api/api/sourcing/health
  - https://sourcing-api-evm6xq7jyq-uc.a.run.app/api/sourcing/health (Cloud Run v2)

Restored from incident (see Incident below):
- `core-service:outbound-api`
- `core-service:outbound-retell-webhook`
- `core-service:outbound-send-reminder`
- `core-service:outbound-start-call`
- `core-service:matching-api`

## Smoke evidence

```
$ curl -fsS "https://us-central1-wekruit-5f89b.cloudfunctions.net/sourcing-api/api/sourcing/health"
{"ok":true,"service":"sourcing","runtime":"firebase-functions"}

$ curl -i -fsS "https://us-central1-wekruit-5f89b.cloudfunctions.net/sourcing-api/api/sourcing/source-runs"
HTTP/2 200
content-type: application/json; charset=utf-8
{"data":[],"total":0}
```

## Branch correction (vs spec)

Spec said: `codex/website-shared-tags-integration-plan`. Actual branch: `codex/sourcing-e2e-firebase`. See P1-PRECHECK.md.

## Scope correction (vs spec)

Spec assumed BrightData + OpenAI enrichment routes existed. They do **not** exist on the merged branch. Sourcing service today provides: ingest + dedup + human review + approved-entity write. Enrichment is a separate sprint (task #24).

## Conflict resolution

Merged `origin/main` into `codex/sourcing-e2e-firebase` resolving 6 conflicts with union strategy:

| File | Resolution |
|---|---|
| `src/index.ts` | Both `sourcing` (always-on) and `matching` (gated by `CORE_SERVICE_EXPORT_MODE !== 'sourcing'`) |
| `src/bootstrap/secrets.ts` | All outbound + matching secrets kept |
| `src/shared/firestore/collections.ts` | Union of `sourcing-*` + `matching-*` collection maps |
| `package.json` | Main's `npx-firebase-tools` scripts + `node --test` runner + supabase/openai deps + branch's `build:sourcing-bundle` + `deploy:web*` |
| `ARCHITECTURE.md` | Both services documented |
| `README.md` | Both services documented |

Pre-existing matching test failures (`POST /match`, `POST /api/v1/matching/recommendations`) verified to fail on `origin/main` before merge — not introduced by P1.

## Incident — function deletion + restore

### Timeline (UTC)
- 17:41 PR #1 merged to main
- ~17:42 First deploy attempt using `firebase.sourcing.json` (isolated bundle, `deploy/sourcing-functions`)
- ~17:43 Firebase saw "codebase=core-service has only sourcing-api in this source tree" and **deleted** the other 5 functions in that codebase: `outbound-api`, `outbound-retell-webhook`, `outbound-send-reminder`, `outbound-start-call`, `matching-api`
- 17:43 Detected via deploy log "Successful delete operation"
- ~17:45 Full main re-deploy initiated using default `firebase.json` (source `.`)
- ~17:47 All 5 functions restored (Successful create operation)
- ~17:48 Smoke tests green

### Impact
- ~5 min window where outbound + matching functions were absent on prod
- These functions had been deployed but their active traffic status is unknown. CLAUDE.md does not list core-service in user-facing prod path (wekruit-pa pa-orchestrator is the user-facing system, untouched throughout)
- All OUTBOUND_* + MATCHING_* secrets remained intact in Secret Manager — restore needed no manual secret config

### Root cause
Firebase Functions treats `codebase` (set in `firebase.json` functions config) as the unit of incremental deploy. Deploying any subset of functions with `codebase: "core-service"` causes Firebase to:
1. Add functions present in the source dir
2. **Delete** functions associated with that codebase that are absent from the source dir

The `firebase.sourcing.json` bundle's `lib/index.js` exports only `{ sourcing: { api: sourcingApi } }` — so Firebase deleted outbound + matching.

### Prevention going forward
- **For prod deploys**: always use `firebase.json` (full src) unless intentionally tearing down a service
- **Isolated sourcing deploy** (`firebase.sourcing.json`) is for **staging-only** preview deploys
- **OR**: split sourcing into a separate codebase name (e.g. `codebase: "core-service-sourcing"`) so isolated deploys don't affect peer services
- Adding ADR note to repo recommended before next isolated deploy attempt

## Open

- Hosting site `wekruit-sourcing` only exists on staging (`wekruit-dev-env`). No prod hosting deployed (operator console = staging-only for now). Function URLs are directly reachable for CF-to-CF use.
- BrightData key gating: not needed for P1-P5 scope (no BrightData calls). Deferred to enrichment sprint.

## Done criteria check

| Check | Status |
|---|---|
| PR merged to core-service main | ✅ #1 merged 17:41 |
| sourcing-api deployed to wekruit-5f89b | ✅ |
| /api/sourcing/health returns 200 | ✅ `{"ok":true,...}` |
| Restore deleted peer functions | ✅ outbound-* + matching-api back |
| Closure file written | ✅ this file |
