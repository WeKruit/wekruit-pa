# S9 Local Validation - 2026-05-14

## Passed

- `pnpm --filter @pa/core-types test` - 79 tests passed.
- `pnpm --filter @pa/core-types typecheck` - passed.
- `pnpm --filter @pa/pa-persistence test` - 150 tests passed.
- `pnpm --filter @pa/pa-persistence typecheck` - passed.
- `pnpm --filter @pa/functions test` - 1346 tests passed.
- `pnpm --filter @pa/functions typecheck` - passed.
- `pnpm --filter @pa/dashboard-web test` - 67 tests passed.
- `pnpm --filter @pa/dashboard-web typecheck` - passed.
- `node --import tsx --test apps/pa-landing/src/lib/candidate-privacy-request.test.ts` - 2 tests passed.
- `pnpm --filter @pa/landing typecheck` - passed.
- `pnpm --dir tests/eval/s9-production-hardening-scale test` - 5 tests passed; static guard scanned 20 files.
- `node --import tsx --test tests/eval/s5-two-way-matching/*.test.ts` - 3 tests passed.
- `node --import tsx --test tests/eval/s6-outreach-platform/*.test.ts` - 23 tests passed.
- `node --import tsx --test tests/eval/s7-first-interview-passed-surface/*.test.ts` - 6 tests passed.
- `pnpm --dir tests/eval/s8-flywheel-hitl-eval test` - 10 tests passed; static guard passed.
- `pnpm --filter @pa/functions build` - passed.
- `pnpm --filter @pa/dashboard-web build` - passed with existing Vite bundle-size warnings.
- `pnpm --filter @pa/landing build` - passed with existing Vite bundle-size warning.
- `git diff --check` - passed.

## Still Pending

- Firebase deploy for changed functions and hosting targets.
- Live no-contact smoke with route/auth/count checks and `pa-outbound` before/after proof.
