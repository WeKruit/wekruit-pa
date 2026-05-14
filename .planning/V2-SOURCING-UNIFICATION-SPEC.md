# V2 Sourcing Unification — Execution Spec

Date: 2026-05-14
Owner: claude (P8 closure)
Status: ready-to-execute (all decisions locked below)

## North Star

Unify candidate enrichment under **wekruit-core-service-cloud-function** `sourcing` service. Every external candidate (Lessie xlsx, Juicebox, Coresignal, GitHub) lands in one schema (`sourcing-*` collections) with one HTTP API. wekruit-pa dashboard reads this canonical view. No more parallel taxonomies, no more per-batch tag drift.

## Decision lock (resolved 2026-05-14)

| # | Decision | Locked answer |
|---|---|---|
| 1 | Start P1? | **YES** — execute end-to-end without re-asking |
| 2 | BrightData key | Adam will rotate. **DO NOT use `1f6bf2cf-760b-4178-874f-4391a6af8d23`** in any deploy / commit / secret-set. Wait for new key in chat before P1.3 |
| 3 | Schema sharing | pnpm workspace cross-repo — `packages/sourcing-types` in core-service, symlinked / referenced from wekruit-pa via `file:` dep. NO npm publish in V2. NO hand-copy |
| 4 | Codex branch merge | **Agent reviews + opens PR + merges after green CI**. Adam can revert if unhappy |

## Five-phase execution

### P1 — Land core-service sourcing service in prod (target 60 min)

1. Clone WeKruit/wekruit-core-service-cloud-function into a sibling worktree (NOT inside wekruit-pa).
2. `git checkout codex/website-shared-tags-integration-plan`.
3. Run `pnpm install && pnpm run build && pnpm run typecheck && pnpm test`. Fix lint/type errors that block green. **Do NOT --no-verify.**
4. Compare branch ↔ main: `git diff --stat main..HEAD`. Generate a one-page summary (top files by LOC, new collections, new HTTP routes, new env vars).
5. Open PR core-service `codex/website-shared-tags-integration-plan` → `main`. Wait for CI green.
6. Merge PR with squash. Pull main.
7. Wait for Adam to send rotated BrightData key in chat.
8. Set Firebase secret on `wekruit-5f89b`: `firebase functions:secrets:set BRIGHT_DATA_API_KEY` (read from stdin, do NOT echo key into shell history).
9. Deploy `sourcingApi` CF: `cd <core-service> && pnpm run deploy --only functions:sourcingApi` (or repo-specific deploy script).
10. Smoke: `curl -fsS https://<region>-wekruit-5f89b.cloudfunctions.net/sourcingApi/api/sourcing/health` — paste JSON output as evidence.
11. Commit closure summary to `.planning/external-supply-v2/P1-CLOSURE.md` in wekruit-pa.

### P2 — Bridge wekruit-pa CreateBatch → core-service (target 90 min)

1. Add core-service base URL to `apps/functions/src/external-supply/config.ts`: env `SOURCING_API_BASE_URL`.
2. Mint a CF-to-CF service-account token (use existing `getAdminAuthToken` pattern from `paAtsInboundWebhook`) for HMAC or bearer auth on the core-service side. Add `SOURCING_API_BEARER` secret.
3. In `apps/functions/src/external-supply/import.ts:paExternalSupplyCreateBatch`, after persisting `pa-external-sourcing-batches/{batchId}` + records, fan out: `POST <base>/api/sourcing/source-records:batchUpsert` with mapped payload.
4. Persist response `{ sourcingRunId, recordIds[] }` on batch doc: `pa-external-sourcing-batches/{batchId}.sourcing = { runId, syncedAt }`.
5. Add idempotency: if `sourcing.runId` already set, skip fan-out (do not double-upsert).
6. Write `apps/functions/tests/external-supply/sourcing-bridge.test.ts` (node:test) — mocks core-service HTTP and asserts payload shape + idempotency.
7. `pnpm --filter pa-orchestrator test` green.
8. Deploy `paExternalSupplyCreateBatch` (targeted): `firebase deploy --only "functions:pa-orchestrator:paExternalSupplyCreateBatch" --project wekruit-5f89b --non-interactive`.
9. Live smoke: re-upload one of the existing rain lessie xlsx (or `bruh just help me seed this` fixture) via dashboard, then verify in Firestore: `pa-external-sourcing-batches/{newBatchId}.sourcing.runId` populated + `sourcing-source-runs/{runId}` exists in core-service.
10. Paste both Firestore doc snapshots as evidence.

### P3 — Dashboard "Run LinkedIn enrich" button (target 90 min)

1. Add admin CF `apps/functions/src/external-supply/sourcing-vendor-lookup.ts` exporting `paExternalSupplySourcingVendorLookup` (callable, `requireExternalSupplyAdmin`).
2. CF body: `POST <base>/api/sourcing/approved-entities/:id/vendor-profile-lookup:run`. Map `recordId` ↔ `approvedEntityId` via the `sourcingRunId` linkage written in P2.
3. In `apps/dashboard-web/src/pages/external-supply/BatchCandidates.tsx` (drawer): add "Run LinkedIn enrich" button next to "Open LinkedIn". Disabled if no linkedinUrl.
4. On click: call CF, show spinner, on success refetch + render `enrichment.vendor.linkedin.*` fields (`headline`, `currentPosition`, `experience[]`, `education[]`).
5. Add a "Last enriched: <ts>" line in drawer header.
6. Deploy CF + dashboard. Smoke: pick one rain candidate that has linkedinUrl, click button, paste BrightData JSON snippet (key fields only) as evidence + screenshot.

### P4 — wekruit-scraping GitHub bridge (target 120 min)

1. In wekruit-scraping sibling worktree, `git checkout codex/website-shared-tags-integration-plan`. Run `pytest` baseline.
2. Audit `researcher/pipeline/sourcing_client.py` (154 lines, already drafted) and `sourcing_records.py` (349 lines). Fix any obvious bugs.
3. Wire `github/github_contributors.py:get_user_profile` output through `sourcing_client.batch_upsert_source_records(...)` — one row per GitHub user with evidence `{ kind: "github_profile", url, bio, blog, twitter_username, public_repos, followers }`.
4. Add `scripts/sourcing_upload_file.py` CLI smoke: run against a 5-user GitHub fixture, target prod core-service (with bearer token from env).
5. Verify in Firestore `sourcing-source-records` that 5 rows landed with kind=github.
6. Open PR wekruit-scraping `codex/website-shared-tags-integration-plan` → `main`. Merge after green.

### P5 — Dashboard canonical read switch (target 180 min)

1. In `apps/dashboard-web/src/lib/external-supply-client.ts`, add `listSourcingCandidates(batchId)` reading `sourcing-source-records` via `pa-external-sourcing-batches.sourcing.runId` join. Keep old `listBatchCandidates` as fallback.
2. Add feature flag (URL param `?canonical=1`) in `BatchCandidates.tsx` to switch readers.
3. Verify parity: counts match, rubric chips render, link chips render, Match badge renders. Take side-by-side screenshots.
4. Flip default to canonical reader. Mark `pa-external-candidate-records` as "staging-only" in a CLAUDE.md note.
5. Deploy dashboard. Verify rain batch still renders correctly post-flip.

## Hard rules (Adam directives, non-negotiable)

- **No `--no-verify`**. Fix root cause.
- **No "please run this yourself"**. Agent runs deploys.
- **No claim "done" without paste-output evidence** at every phase boundary.
- **No force-push** on main of any repo.
- **BrightData key ONLY from rotated value Adam sends post-spec-publication**. The leaked `1f6bf2cf-...` value is dead; do not use it anywhere.
- **Caveman + alibaba 🟠 旁白** throughout.
- **Real e2e** — UI smoke alone is insufficient. Cite Firestore doc snapshots / HTTP responses.

## Per-phase closure file

Each phase produces `.planning/external-supply-v2/P{N}-CLOSURE.md` with:
- commands run + output
- Firestore evidence
- PR / merge SHA
- next-phase entry conditions

## Operational anchors (reproduced for self-containment)

```bash
# Firebase auth (wekruit-pa repo)
export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
  grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"

# Functions deploy (full)
cd apps/functions && pnpm run deploy

# Functions deploy (targeted)
firebase deploy --only "functions:pa-orchestrator:<name>" --project wekruit-5f89b --non-interactive

# Dashboard deploy
PA_DASHBOARD_VITE_ENV_FILE=apps/dashboard-web/.env.production.local \
  firebase deploy --only hosting:pa-dashboard --project wekruit-5f89b --non-interactive

# Set Firebase secret without echoing into shell history
firebase functions:secrets:set BRIGHT_DATA_API_KEY --project wekruit-5f89b
# (paste value when prompted; do NOT pass via --data-file from chat)
```

## Sibling repo paths (assumed; agent verifies)

- `/Users/adam/Desktop/WeKruit/wekruit-core-service-cloud-function`
- `/Users/adam/Desktop/WeKruit/wekruit-scraping`

If absent, agent clones from `git@github.com:WeKruit/<repo>.git` into `/Users/adam/Desktop/WeKruit/`.

## Definition of Done

- All 5 phases closed with `P{N}-CLOSURE.md` evidence.
- core-service + wekruit-scraping `codex/website-shared-tags-integration-plan` merged to main.
- `sourcingApi` CF live on `wekruit-5f89b`, `/api/sourcing/health` returns 200.
- Re-uploading a rain lessie xlsx populates BOTH `pa-external-candidate-records` (legacy) AND `sourcing-source-records` (canonical).
- "Run LinkedIn enrich" button works end-to-end on at least 1 prod candidate, with BrightData JSON visible in drawer.
- GitHub fixture batch lands in `sourcing-source-records`.
- Dashboard canonical reader flipped on by default for rain batch.
- Closure PR opened on wekruit-pa main with `.planning/external-supply-v2/` evidence.

## Failure protocol

If any phase exceeds 2× target time:
1. Pause execution.
2. Write `P{N}-BLOCKED.md` with: what was tried, what failed (exact error), 3 candidate root causes, recommended unblock.
3. Ping Adam with the blocked-file path. Do NOT default-bounce ("you re-run this").
