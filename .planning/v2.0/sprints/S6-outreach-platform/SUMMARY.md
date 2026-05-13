# S6 Summary

**Status:** Implemented, S6 target deployed, and non-sending smoke verified. PR/checks/merge pending. Broad project-wide functions deploy is flagged on unrelated Cloud Run regional memory quota.
**Date:** 2026-05-13.

## Current State

- Branch: `codex/v2-S6-outreach-platform`.
- Base: `16705a5 feat(v2): add S5 two-way matching`.
- Worktree was created from `origin/main` without touching the dirty main
  checkout.
- Executor plans are integrated in `EXECUTOR-PLANS.md`.
- S6 contracts, policy evaluator, dry-run/live queue service seam, Sendblue
  capacity gate, invite persistence, admin snapshot callable, read-only
  Outreach Ops UI, and S6 eval/static guards are implemented.
- Local gates are green:
  - `pnpm --filter @pa/core-types test` -> 19 pass.
  - `pnpm --filter @pa/core-types typecheck` -> pass.
  - `pnpm --filter @pa/pa-broker test` -> 14 pass.
  - `pnpm --filter @pa/pa-persistence test` -> 125 pass.
  - `pnpm --filter @pa/pa-persistence typecheck` -> pass.
  - `pnpm --filter @pa/functions test` -> 1231 pass.
  - `pnpm --filter @pa/functions typecheck && pnpm --filter @pa/functions build` -> pass.
  - `pnpm --filter @pa/dashboard-web test` -> 44 pass.
  - `pnpm --filter @pa/dashboard-web typecheck` -> pass.
  - `pnpm --filter @pa/dashboard-web build` -> pass.
  - `node --import tsx --test tests/eval/s6-outreach-platform/*.test.ts` -> 23 pass.
  - `node tests/eval/s6-outreach-platform/static-guards.mjs` -> pass, 12 files scanned.
  - `git diff --check` -> pass.
- Deploy/smoke evidence:
  - Broad `firebase deploy --only functions` predeploy passed, and `paAdminOutreachOpsSnapshot` updated successfully, but the command exited 2 because 17 unrelated functions hit Cloud Run regional memory quota.
  - Targeted `firebase deploy --only functions:pa-orchestrator:paAdminOutreachOpsSnapshot` passed cleanly after Firebase predeploy reran smoke/build/typecheck/full functions test.
  - Dashboard hosting deployed to `https://wekruit-pa.web.app` after retrying with `PA_DASHBOARD_VITE_ENV_FILE=apps/dashboard-web/.env.production.local`.
  - Non-sending smoke passed: candidate job route 200, admin `/admin/outreach-ops` route 200, admin `/j/...` route 301s to `candidate.wekruit.com`, unauth admin callable returns 403, `pa-outbound` stayed `190 -> 190`, and final `pa-outbound-invites=0`.

## Next Gate

Open PR from `codex/v2-S6-outreach-platform`, verify PR checks, then merge.
