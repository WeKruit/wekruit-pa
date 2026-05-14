# P2 Closure — wekruit-pa CreateBatch fan-out to sourcing-api

Date: 2026-05-14
Owner: claude
Status: GREEN

## What shipped

Bridge module: `apps/functions/src/external-supply/sourcing-bridge.ts` (new, ~245 LOC).

Wired into `paExternalSupplyCreateBatch` (`apps/functions/src/external-supply/import.ts`) so every new external-supply batch fans out POST→/api/sourcing/source-runs, batchUpsert (chunked at 100), then /complete; writes `sourcing.runId` back to `pa-external-sourcing-batches/{batchId}.sourcing`.

Idempotent: re-running the bridge for a batch that already carries `sourcing.runId` is a no-op.

Best-effort: bridge failures are caught in the callable and only logged — the wekruit-pa batch persistence is the source of truth, and the bridge replays on next run.

## Files touched

| File | Status | Notes |
|---|---|---|
| `apps/functions/src/external-supply/sourcing-bridge.ts` | new | run + mapRecord + Firestore IO + URL resolver |
| `apps/functions/src/external-supply/sourcing-bridge.test.ts` | new | 6 cases: happy / chunking / idempotency / create-fail / chunk-fail / empty |
| `apps/functions/src/external-supply/import.ts` | modified | import + await bridge in callable post-runCreateBatch |
| `apps/functions/scripts/smoke-sourcing-bridge.mjs` | new | live smoke against prod |

## Verification

### Unit tests
```
✔ runSourcingSync — happy path: creates run, batch-upserts, completes, marks batch
✔ runSourcingSync — chunks records at 100 per upsert call
✔ runSourcingSync — idempotent when batch already has sourcing.runId
✔ runSourcingSync — failed create-run returns failed without writing back
✔ runSourcingSync — batchUpsert failure on chunk 2 returns failed mid-way
✔ runSourcingSync — empty batch is a no-op success
ℹ tests 6 pass 6 fail 0
```

### Predeploy gate
- 165 external-supply tests pass (165/165)
- typecheck clean
- predeploy-smoke OK

### Targeted prod deploy
```
firebase deploy --only "functions:pa-orchestrator:paExternalSupplyCreateBatch" --project wekruit-5f89b
→ Successful update operation
```

### Live smoke against prod
```
$ node apps/functions/scripts/smoke-sourcing-bridge.mjs
[smoke] picked batch b3b63f6a-c5e0-4866-97af-96d1f51d2efa (source=manual_csv, rowCount=51)
[smoke] loaded 51 candidate records
[smoke] POST https://us-central1-wekruit-5f89b.cloudfunctions.net/sourcing-api/api/sourcing/source-runs
[smoke] created sourcing runId=4a13debe-f3ec-4f2e-8088-3af0a6eb4b7d
[smoke] batchUpsert 1..51 -> {"data":{"sourceRun":{"id":"4a13de...","sourceName":"wekruit-pa-external-supply"...
[smoke] completed run -> {"data":{"id":"4a13debe-...","sourceName":"wekruit-pa-external-supply"...
[smoke] sourcing-source-records?runId=4a13debe-... -> count=51 (expected 51)
[smoke] writeback: {"smoke":true,"runId":"4a13debe-f3ec-4f2e-8088-3af0a6eb4b7d","syncedAt":"2026-05-14T17:58:57.202Z"}
[smoke] ✅ PASS
```

## Mapping contract

| wekruit-pa `ExternalCandidateRecord` field | sourcing `sourceRecordUpsert` field |
|---|---|
| `recordId` | `sourceRecordId`, `sourceNativeId` |
| `name` | `displayName`, `raw.name` |
| `canonicalLinkedInUrl` | `sourceUrl`, `raw.linkedinUrl` |
| `currentCompany` | `institution`, `raw.currentCompany` |
| `currentTitle` / `location` / `experience` / `education` / `emails` / `enrichment` / etc. | `raw.*` (lossless) |
| (always) | `entityType: 'person'`, `domain: 'wekruit-pa'`, `source: 'wekruit-pa-external-supply'` |

`storagePath` is intentionally NOT set — sourcing-api enforces a `sourcing/raw/` prefix, but wekruit-pa stores files under `external-supply/...`. We send file metadata into `raw` instead.

## Open

- **No auth** on sourcing-api routes yet. Currently CF-to-CF calls go through unauthenticated HTTPS. Acceptable for sprint scope but flagged for the enrichment sprint (task #24): add bearer-token auth to sourcing-api + Firebase Secret for the wekruit-pa CF to read.
- **Pre-P2 batches** (any batch created before this deploy) are unsynced. The smoke script can be re-run with `node apps/functions/scripts/smoke-sourcing-bridge.mjs <batchId>` for each. Future: schedule a one-shot backfill CF.

## Done criteria check

| Check | Status |
|---|---|
| Bridge module + tests | ✅ 6/6 |
| Hooked into paExternalSupplyCreateBatch | ✅ |
| Predeploy gate green | ✅ 165 tests |
| Deployed to prod (targeted) | ✅ |
| Live smoke: 51 records sourced + writeback | ✅ |
| `pa-external-sourcing-batches/{batchId}.sourcing` populated | ✅ |
| `sourcing-source-records` populated via prod API GET | ✅ |
| Closure file | ✅ this file |
