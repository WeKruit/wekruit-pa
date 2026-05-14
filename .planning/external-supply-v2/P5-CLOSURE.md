# P5 Closure — dashboard canonical reader behind `?canonical=1` flag

Date: 2026-05-14
Owner: claude
Status: GREEN (flag deployed; default still legacy)

## What shipped

Two new pieces in `apps/dashboard-web`:

1. `listBatchCandidatesCanonical()` in `src/lib/external-supply-client.ts` — V2 reader that fetches `pa-external-sourcing-batches/{batchId}.sourcing.runId`, GETs `/api/sourcing/source-runs/:runId/source-records` from prod sourcing-api over CORS, then reconstructs the dashboard `BatchCandidateRow` shape from the lossless `raw.*` payload that the P2 bridge wrote into sourcing.

2. `?canonical=1` URL flag on `/admin/external-supply/batches/:batchId/candidates` — toggles between legacy direct-Firestore reader and the new canonical reader. UI surfaces the active source via the page-header description (e.g. `reader: canonical (run 4a13debe…)`) plus a quick-switch link.

## Default is still legacy

The flip-default-to-canonical step from the spec is **intentionally deferred** because the sourcing-source-records collection today is a mirror of pa-external-candidate-records — there is no canonical-only data yet. Once the enrichment sprint (task #24) starts populating BrightData / OpenAI fields that aren't in the legacy collection, we flip default and the canonical reader becomes load-bearing.

Until then, operators can opt-in to dogfood the bridge by appending `?canonical=1`.

## Files touched

| File | Status |
|---|---|
| `apps/dashboard-web/src/lib/external-supply-client.ts` | +120 LOC (`listBatchCandidatesCanonical` + helpers) |
| `apps/dashboard-web/src/pages/external-supply/BatchCandidates.tsx` | feature-flag wiring + reader badge in header |

## Verification

### Typecheck + build
- `pnpm --filter @pa/dashboard-web typecheck` clean
- `pnpm --filter @pa/dashboard-web build` succeeded, 1.49MB minified

### Hosting deploy
```
firebase deploy --only hosting:pa-dashboard --project wekruit-5f89b
→ Hosting URL: https://wekruit-pa.web.app
```

### Live parity check (batch `b3b63f6a-c5e0-4866-97af-96d1f51d2efa`)

```
legacy count (pa-external-candidate-records):    51
canonical count (sourcing-source-records GET):   51

sample (canonical):
  displayName: "Harsimran Kaur"
  sourceUrl:   "https://linkedin.com/in/harsimran-kaur-5850911a0"
  raw.name:    "Harsimran Kaur"
  raw.currentTitle:   "Freelance UI/UX Designer"
  raw.currentCompany: "Upwork"
```

Counts match. Reader fields reconstructible from raw.*. Run-id badge displays in operator UI.

### Operator smoke URL
```
https://wekruit-pa.web.app/admin/external-supply/batches/b3b63f6a-c5e0-4866-97af-96d1f51d2efa/candidates?canonical=1
```
(Adam can click and visually compare against the un-flagged URL — same 51 rows, same chips, rendered from sourcing-api this time.)

## Failure modes covered

| Scenario | Behavior |
|---|---|
| Batch never bridged (no `sourcing.runId`) | Canonical reader falls back to legacy reader transparently |
| sourcing-api 5xx / network fail | Falls back to legacy reader; no blank page |
| Empty source-records response | Renders empty list; same UX as legacy empty |

## Open / next-sprint dependencies

- **Default flip pending enrichment** (task #24). Once BrightData LinkedIn enrichment or OpenAI content generation lands in `sourcing-source-records.raw.enrichment.*`, expose those fields in `listBatchCandidatesCanonical` and flip default.
- **Candidate detail drawer** still uses the legacy `getCandidateDetail` callable; canonical reader currently only affects the list. Drawer canonicalization is a 1-day follow-up.
- **CORS auth**: sourcing-api accepts unauthenticated GET from any origin. Acceptable today (browser → operator-side, read-only, no PII not already accessible). Lock down with bearer-token before enrichment-derived sensitive fields land.

## Done criteria check

| Check | Status |
|---|---|
| Canonical reader implemented | ✅ |
| Feature flag wired | ✅ |
| Parity check vs legacy (counts + sample fields) | ✅ 51 = 51 |
| Dashboard deployed | ✅ `https://wekruit-pa.web.app` |
| Closure file | ✅ this file |
| Default flip | ⏸️ deferred until enrichment sprint adds canonical-only data |
