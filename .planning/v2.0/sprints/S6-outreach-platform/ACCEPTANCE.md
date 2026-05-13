# S6 Acceptance

This ledger starts pending and must be filled with exact commands/results before
S6 is called complete.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S6-outreach-platform` | `codex/v2-S6-outreach-platform` | PASS |
| Base | `git log --oneline -1` | starts from merged S5 commit `16705a5` | `16705a5 feat(v2): add S5 two-way matching` | PASS |
| Executor plans | collect and integrate AGENT_PLAN outputs | no code before plans | plans recorded in `EXECUTOR-PLANS.md`; lead integration note recorded in `PLAN.md` | PASS |
| Core contracts tests | `pnpm --filter @pa/core-types test` | outreach contracts pass | 19 tests, 0 failures | PASS |
| Core contracts typecheck | `pnpm --filter @pa/core-types typecheck` | TS contracts compile | exit 0 | PASS |
| Broker tests | `pnpm --filter @pa/pa-broker test` | outbound outbox idempotency and broker helpers pass | 14 tests, 0 failures | PASS |
| Persistence tests | `pnpm --filter @pa/pa-persistence test` | invite/idempotency/state transitions pass | 125 tests, 0 failures | PASS |
| Persistence typecheck | `pnpm --filter @pa/pa-persistence typecheck` | persistence package compiles | exit 0 | PASS |
| S6 outreach eval/static guard | `node --import tsx --test tests/eval/s6-outreach-platform/*.test.ts` | dry-run and blocked decisions do not enqueue; approved live seam enqueues once; static guards pass | 23 tests, 0 failures | PASS |
| Standalone static guard | `node tests/eval/s6-outreach-platform/static-guards.mjs` | no direct Sendblue/provider or legacy reverse-match primary path | `S6 static guard passed (12 files scanned).` | PASS |
| Functions tests | `pnpm --filter @pa/functions test` | policy/queue/capacity behavior passes | 1231 tests, 0 failures | PASS |
| Functions typecheck/build | `pnpm --filter @pa/functions typecheck && pnpm --filter @pa/functions build` | functions compile and bundle | exit 0; `lib/index.js` bundled | PASS |
| Dashboard tests/build | `pnpm --filter @pa/dashboard-web test`; `typecheck`; `build` | Outreach Ops UI compiles and helper tests pass | 44 tests, 0 failures; typecheck exit 0; Vite build exit 0 | PASS |
| Diff hygiene | `git diff --check` | no whitespace errors | exit 0 | PASS |
| No direct Sendblue static guard | `node --import tsx --test tests/eval/s6-outreach-platform/*.test.ts` | no bypass of existing outbox | `S6 outreach path has no direct provider send or legacy bulk route` PASS inside eval run | PASS |
| No unapproved bulk-send smoke | `node --import tsx --test tests/eval/s6-outreach-platform/*.test.ts` | no live outbound without approval | dry-run/blocked matrix did not enqueue; live-approved high match enqueued through injected dependency seam exactly once | PASS |
| Broad functions deploy caveat | `FIREBASE_CLI_SKIP_UPDATE_CHECK=1 node_modules/.bin/firebase deploy --only functions --project wekruit-5f89b --non-interactive` | record whether project-wide deploy is clean | Predeploy smoke/build/typecheck/full functions test passed; `pa-orchestrator:paAdminOutreachOpsSnapshot(us-central1)` updated successfully; command exited 2 because 17 unrelated functions hit Cloud Run regional memory quota | FLAG |
| Targeted functions deploy - S6 target | `FIREBASE_CLI_SKIP_UPDATE_CHECK=1 node_modules/.bin/firebase deploy --only functions:pa-orchestrator:paAdminOutreachOpsSnapshot --project wekruit-5f89b --non-interactive` | S6 function deploy exits cleanly | Predeploy smoke/build/typecheck/full functions test passed; `pa-orchestrator:paAdminOutreachOpsSnapshot(us-central1)` successful update; Firebase reported deploy complete | PASS |
| Dashboard hosting deploy | `PA_DASHBOARD_VITE_ENV_FILE=apps/dashboard-web/.env.production.local FIREBASE_CLI_SKIP_UPDATE_CHECK=1 ./node_modules/.bin/firebase deploy --only hosting:pa-dashboard --project wekruit-5f89b --non-interactive` | admin hosting deploys | Deployed `https://wekruit-pa.web.app`; first plain hosting deploy failed on missing Vite env until `PA_DASHBOARD_VITE_ENV_FILE` was set explicitly | PASS |
| Live route regressions | curl checks | existing domains remain healthy | `admin_outreach 200 https://wekruit-pa.web.app/admin/outreach-ops`; admin stale `/j/s6-smoke-job` returns HTTP 301 to `https://candidate.wekruit.com/j/s6-smoke-job`; `candidate_job 200 https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | PASS |
| Callable auth-block smoke | unauth POST to `https://us-central1-wekruit-5f89b.cloudfunctions.net/paAdminOutreachOpsSnapshot` after targeted deploy | admin-only callable rejects anonymous callers | HTTP 403 `{"error":{"message":"admin only","status":"PERMISSION_DENIED"}}` | PASS |
| No-contact live count smoke | Firestore aggregate count before/after unauth callable probe after targeted deploy | no live outbound writes | before `{pa-outbound:190, pa-outbound-invites:0}`; after `{pa-outbound:190, pa-outbound-invites:0}` | PASS |

## Hard Fail Conditions

- S6 sends live outbound without a policy decision row and explicit dry-run/live
  boundary.
- S6 bypasses `pa-outbound`/Sendblue outbox and calls Sendblue directly.
- A stopped, opted-out, paused, or recently declined candidate is queued.
- Duplicate company/role/job outreach is queued for the same candidate.
- Capacity is documented but not enforced.
- Candidate routes move to admin domain.
- Match score blocks first interview once a candidate enters a job flow.
