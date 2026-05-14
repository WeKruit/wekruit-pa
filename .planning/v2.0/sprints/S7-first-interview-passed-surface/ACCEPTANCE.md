# S7 Acceptance

This ledger starts pending and must be filled with exact commands/results before
S7 is called complete.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S7-first-interview-passed-surface` | `codex/v2-S7-first-interview-passed-surface` | PASS |
| Base | `git log --oneline -3` | starts from merged S6 and reconciles current `origin/main` before PR | Initial worktree from `16ab52b`; rebased over `66917fc feat(v2): external candidate supply intake V1 (#29)`; final PR base reconciles `dcd2ace fix(v2): external-supply deploy-unblock + post-ship evidence (#31)` | PASS |
| Executor plans | collect and integrate AGENT_PLAN outputs | no code before plans | A-E plans recorded in `EXECUTOR-PLANS.md`; lead decisions integrated in `PLAN.md` before product code edits | PASS |
| Core contracts tests | `pnpm --filter @pa/core-types test` | S7 contracts/reducers pass | PASS, 75 tests after rebase over external-supply main | PASS |
| Core contracts typecheck | `pnpm --filter @pa/core-types typecheck` | TS contracts compile | PASS | PASS |
| Persistence tests | `pnpm --filter @pa/pa-persistence test` | S7 snapshot/state helpers pass | PASS, 143 tests after rebase over external-supply main | PASS |
| Persistence typecheck | `pnpm --filter @pa/pa-persistence typecheck` | persistence compiles | PASS | PASS |
| Functions focused tests | `node --import tsx --test apps/pa-landing/src/lib/candidate-job-status.test.ts apps/functions/src/identity/candidate-matches-api.test.ts apps/functions/src/prescreen-outcome-service.test.ts apps/functions/src/prescreen-terminal-action.test.ts apps/functions/src/__tests__/admin-passed-candidates.test.ts apps/dashboard-web/src/pages/__tests__/PassedCandidates.test.ts` | direct/outbound PASS/NOT_PASS/PAUSE paths pass | PASS, 25 tests | PASS |
| Functions full tests | `pnpm --filter @pa/functions test`; Firebase predeploy reran same suite | functions suite passes | PASS, 1,333 tests after refreshing workspace links for `@pa/external-supply`; deploy predeploy reran 1,333 tests PASS | PASS |
| Functions typecheck/build | `pnpm --filter @pa/functions typecheck`; `pnpm --filter @pa/functions build`; Firebase predeploy | functions compile and bundle | PASS; PASS; deploy predeploy typecheck/build PASS | PASS |
| Dashboard tests/build | `pnpm --filter @pa/dashboard-web typecheck`; `pnpm --filter @pa/dashboard-web test`; `pnpm --filter @pa/dashboard-web build`; Firebase hosting predeploy | passed-candidates UI compiles and behavior passes | PASS; PASS, 58 tests; PASS with Vite chunk warning only; hosting predeploy PASS | PASS |
| Landing tests/build | `npx tsx --test apps/pa-landing/src/lib/candidate-job-status.test.ts apps/functions/src/identity/candidate-matches-api.test.ts`; `pnpm --filter @pa/landing typecheck`; `pnpm --filter @pa/landing build` | candidate status/direct path compiles | PASS, 8 tests; PASS; PASS with Vite chunk warning only | PASS |
| S7 eval harness | `node --import tsx --test tests/eval/s7-first-interview-passed-surface/*.test.ts` | direct + outbound interview completion, PASS visible, NOT_PASS/PAUSE invisible | PASS, 6 tests; see `artifacts/eval-summary.json` | PASS |
| Static/safety guards | `node tests/eval/s7-first-interview-passed-surface/static-guards.mjs`; S6 policy regression tests | no broad employer browsing, no candidate routes on admin, no live outbound side effect | PASS, 12 files scanned; S6 policy eval PASS, 5 tests | PASS |
| Diff hygiene | `git diff --check` | no whitespace errors | PASS | PASS |
| Deploy | `env PATH=/Users/adam/.nvm/versions/node/v22.22.0/bin:... PA_DASHBOARD_VITE_ENV_FILE=apps/dashboard-web/.env.pa-firebase-generated VITE_CV_INGEST_URL=https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest FIREBASE_CLI_SKIP_UPDATE_CHECK=1 node_modules/.bin/firebase deploy --only functions:pa-orchestrator:paAdminPassedCandidatesSnapshot,functions:pa-orchestrator:paCandidateListMatches,functions:pa-orchestrator:paSendblueWebhook,functions:pa-orchestrator:onPaInbound,functions:pa-orchestrator:paMessageCoalescer,hosting:pa-dashboard,hosting:pa-landing --project wekruit-5f89b --non-interactive` | deploy complete | PASS. Created `paAdminPassedCandidatesSnapshot`; updated `paCandidateListMatches`, `paSendblueWebhook`, `onPaInbound`, `paMessageCoalescer`; released `https://wekruit-pa.web.app` and `https://wekruit-pa-landing.web.app`. First all-functions attempt exposed the missing external-supply optional-secret deploy unblock; final PR base includes #31 for that unrelated surface, and S7 used a targeted deploy. | PASS |
| Live route regressions | `curl -sS -i https://candidate.wekruit.com/j/s7-smoke`; `curl -sS -i https://wekruit-pa.web.app/j/s7-smoke`; `curl -sS -i https://wekruit-pa.web.app/admin/passed-candidates` | existing domains remain healthy | candidate job route HTTP 200; admin `/j/s7-smoke` HTTP 301 to `https://candidate.wekruit.com/j/s7-smoke`; admin passed-candidates route HTTP 200 | PASS |
| Callable auth-block smoke | `curl -sS -i https://us-central1-wekruit-5f89b.cloudfunctions.net/paAdminPassedCandidatesSnapshot -H 'Content-Type: application/json' -d '{"data":{"jobId":"s7-smoke"}}'` | admin-only callable rejects anonymous callers | HTTP 403 `{"error":{"message":"admin only","status":"PERMISSION_DENIED"}}` | PASS |
| No-contact live count smoke | Firestore count before/after non-sending route/auth smoke using repo service account | no live outbound writes | production `pa-outbound` stayed `190 -> 190`; offline fake-Firestore eval stayed `0 -> 0` | PASS |

## Hard Fail Conditions

- Match score blocks first interview for direct or outbound candidate entry.
- NOT_PASS creates or exposes an employer-visible profile.
- PAUSE creates or exposes an employer-visible profile.
- Admin/employer surface reads broad candidate pools instead of passed
  snapshots.
- Candidate routes move back to `wekruit-pa.web.app`.
- PASS snapshot exposes raw PII without consent state.
- S7 tests or smoke create live outbound without explicit approval.
