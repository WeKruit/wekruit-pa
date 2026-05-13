# S7 Acceptance

This ledger starts pending and must be filled with exact commands/results before
S7 is called complete.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S7-first-interview-passed-surface` | `codex/v2-S7-first-interview-passed-surface` | PASS |
| Base | `git log --oneline -1` | starts from merged S6 commit `16ab52b` | `16ab52b feat(v2): add S6 outreach platform (#30)` | PASS |
| Executor plans | collect and integrate AGENT_PLAN outputs | no code before plans | A-E plans recorded in `EXECUTOR-PLANS.md`; lead decisions integrated in `PLAN.md` before product code edits | PASS |
| Core contracts tests | `pnpm --filter @pa/core-types test` | S7 contracts/reducers pass | PASS, 21 tests | PASS |
| Core contracts typecheck | `pnpm --filter @pa/core-types typecheck` | TS contracts compile | PASS | PASS |
| Persistence tests | `pnpm --filter @pa/pa-persistence test` | S7 snapshot/state helpers pass | PASS, 129 tests | PASS |
| Persistence typecheck | `pnpm --filter @pa/pa-persistence typecheck` | persistence compiles | PASS | PASS |
| Functions focused tests | `node --import tsx --test apps/pa-landing/src/lib/candidate-job-status.test.ts apps/functions/src/identity/candidate-matches-api.test.ts apps/functions/src/prescreen-outcome-service.test.ts apps/functions/src/prescreen-terminal-action.test.ts apps/functions/src/__tests__/admin-passed-candidates.test.ts apps/dashboard-web/src/pages/__tests__/PassedCandidates.test.ts` | direct/outbound PASS/NOT_PASS/PAUSE paths pass | PASS, 25 tests | PASS |
| Functions full tests | `pnpm --filter @pa/functions test` | functions suite passes | PASS, 1,237 tests | PASS |
| Functions typecheck/build | `pnpm --filter @pa/functions typecheck`; `pnpm --filter @pa/functions build` | functions compile and bundle | PASS; PASS | PASS |
| Dashboard tests/build | `pnpm --filter @pa/dashboard-web typecheck`; `pnpm --filter @pa/dashboard-web test`; `pnpm --filter @pa/dashboard-web build` | passed-candidates UI compiles and behavior passes | PASS; PASS, 47 tests; PASS with Vite chunk warning only | PASS |
| Landing tests/build | `npx tsx --test apps/pa-landing/src/lib/candidate-job-status.test.ts apps/functions/src/identity/candidate-matches-api.test.ts`; `pnpm --filter @pa/landing typecheck`; `pnpm --filter @pa/landing build` | candidate status/direct path compiles | PASS, 8 tests; PASS; PASS with Vite chunk warning only | PASS |
| S7 eval harness | `node --import tsx --test tests/eval/s7-first-interview-passed-surface/*.test.ts` | direct + outbound interview completion, PASS visible, NOT_PASS/PAUSE invisible | PASS, 6 tests; see `artifacts/eval-summary.json` | PASS |
| Static/safety guards | `node tests/eval/s7-first-interview-passed-surface/static-guards.mjs`; S6 policy regression tests | no broad employer browsing, no candidate routes on admin, no live outbound side effect | PASS, 12 files scanned; S6 policy eval PASS, 5 tests | PASS |
| Diff hygiene | `git diff --check` | no whitespace errors | PASS | PASS |
| Deploy | Firebase deploy if functions/hosting changed | deploy complete | pending | PENDING |
| Live route regressions | candidate/admin curl checks | existing domains remain healthy | pending | PENDING |
| Callable auth-block smoke | unauth passed-candidates callable probe | admin-only callable rejects anonymous callers | pending | PENDING |
| No-contact live count smoke | Firestore count before/after non-sending smoke | no live outbound writes | Offline fake-Firestore count stayed `0 -> 0`; live production count pending with deploy smoke because no live outbound was approved | PENDING |

## Hard Fail Conditions

- Match score blocks first interview for direct or outbound candidate entry.
- NOT_PASS creates or exposes an employer-visible profile.
- PAUSE creates or exposes an employer-visible profile.
- Admin/employer surface reads broad candidate pools instead of passed
  snapshots.
- Candidate routes move back to `wekruit-pa.web.app`.
- PASS snapshot exposes raw PII without consent state.
- S7 tests or smoke create live outbound without explicit approval.
