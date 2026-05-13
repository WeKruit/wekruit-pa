# S6 Artifacts

Store S6 dry-run outputs, curl logs, screenshots, eval reports, and deployment
evidence here.

## 2026-05-13 Local Evidence

- `node --import tsx --test tests/eval/s6-outreach-platform/*.test.ts`
  - Result: PASS, 23 tests, 0 failures, duration 577.578834ms.
  - Scope: policy matrix, dry-run no-enqueue boundary, live-approved dependency seam, and static provider/legacy-route guard.
- `node tests/eval/s6-outreach-platform/static-guards.mjs`
  - Result: PASS, 12 files scanned.
- `pnpm --filter @pa/core-types test`
  - Result: PASS, 19 tests, 0 failures.
- `pnpm --filter @pa/pa-broker test`
  - Result: PASS, 14 tests, 0 failures.
- `pnpm --filter @pa/pa-persistence test`
  - Result: PASS, 125 tests, 0 failures.
- `pnpm --filter @pa/functions test`
  - Result: PASS, 1231 tests, 0 failures.
- `pnpm --filter @pa/dashboard-web test`
  - Result: PASS, 44 tests, 0 failures.
- Typecheck/build gates:
  - `pnpm --filter @pa/core-types typecheck`: PASS.
  - `pnpm --filter @pa/pa-persistence typecheck`: PASS.
  - `pnpm --filter @pa/functions typecheck && pnpm --filter @pa/functions build`: PASS.
  - `pnpm --filter @pa/dashboard-web typecheck`: PASS.
  - `pnpm --filter @pa/dashboard-web build`: PASS.
- `git diff --check`
  - Result: PASS.

## 2026-05-13 Deploy And Non-Sending Smoke

- Broad functions deploy:
  - Command: `FIREBASE_CLI_SKIP_UPDATE_CHECK=1 node_modules/.bin/firebase deploy --only functions --project wekruit-5f89b --non-interactive`.
  - Result: FLAG. Firebase predeploy reran smoke/build/typecheck/full functions tests (`1231` tests, `0` failures), and `paAdminOutreachOpsSnapshot` updated successfully, but the command exited 2 because 17 unrelated functions hit Cloud Run regional memory quota.
- Targeted S6 functions deploy:
  - Command: `FIREBASE_CLI_SKIP_UPDATE_CHECK=1 node_modules/.bin/firebase deploy --only functions:pa-orchestrator:paAdminOutreachOpsSnapshot --project wekruit-5f89b --non-interactive`.
  - Result: PASS. Firebase predeploy reran smoke/build/typecheck/full functions tests (`1231` tests, `0` failures), `paAdminOutreachOpsSnapshot` updated successfully, and Firebase reported deploy complete.
- Dashboard hosting:
  - First attempt without `PA_DASHBOARD_VITE_ENV_FILE` failed at Vite env injection because required `VITE_FIREBASE_*` keys were not loaded.
  - Rerun command: `PA_DASHBOARD_VITE_ENV_FILE=apps/dashboard-web/.env.production.local FIREBASE_CLI_SKIP_UPDATE_CHECK=1 ./node_modules/.bin/firebase deploy --only hosting:pa-dashboard --project wekruit-5f89b --non-interactive`.
  - Result: PASS. Hosting released to `https://wekruit-pa.web.app`.
- Non-sending smoke:
  - Firestore count before smoke: `pa-outbound=190`.
  - `https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` -> HTTP 200.
  - `https://wekruit-pa.web.app/j/s6-smoke-job` -> HTTP 301 to `https://candidate.wekruit.com/j/s6-smoke-job`.
  - `https://wekruit-pa.web.app/admin/outreach-ops` -> HTTP 200.
  - Unauthenticated `POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paAdminOutreachOpsSnapshot` -> HTTP 403 `admin only`.
  - Post-targeted-deploy unauthenticated callable probe still returned HTTP 403 `admin only`.
  - Post-targeted-deploy Firestore count after unauth callable probe: `pa-outbound=190`; `pa-outbound-invites=0`.
