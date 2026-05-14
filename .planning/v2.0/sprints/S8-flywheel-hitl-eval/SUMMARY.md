# S8 Summary

**Status:** Implementation integrated, deployed, live non-sending smoke passed,
and merged in PR #33.
**Date:** 2026-05-14.

## Current State

- Branch: `codex/v2-S8-flywheel-hitl-eval`.
- Base: `2c48792 feat(v2): add S7 first-interview passed surface (#32)`.
- S8 selected as next unblocked roadmap sprint after S7 merged.
- Initial context, plan, acceptance ledger, and executor-plan ledger created.
- Wave A landed shared `EvalArtifact` contracts, `pa-eval-artifacts`
  collection ownership, event extensions for candidate behavior/corrections,
  append-only artifact persistence, and correction-to-artifact writer support.
- Wave B landed flywheel functions:
  - redacted feedback/correction event builders;
  - deterministic correction-to-artifact materialization;
  - correction onCreate artifact trigger;
  - dry-run marketplace simulation;
  - admin eval snapshot callable;
  - candidate profile correction callable.
- Wave C landed `/admin/flywheel-eval` as a read-only admin surface for
  artifact, correction, feedback, and status inspection.
- Wave D landed an open-ended `/me/profile` candidate correction panel wired to
  the same correction-event stream.
- Wave E landed the S8 eval/scenario/static-guard harness.
- Focused and regression verification passed:
  - `pnpm --filter @pa/core-types test` -> 76 pass / 0 fail.
  - `pnpm --filter @pa/core-types typecheck` -> pass.
  - `pnpm --filter @pa/pa-persistence test` -> 146 pass / 0 fail.
  - `pnpm --filter @pa/pa-persistence typecheck` -> pass.
  - S8 focused functions tests -> 6 pass / 0 fail.
  - `pnpm --filter @pa/dashboard-web test -- FlywheelEval` -> 63 pass / 0 fail.
  - Candidate correction wrapper test -> 2 pass / 0 fail.
  - `pnpm --dir tests/eval/s8-flywheel-hitl-eval test` -> 10 pass / 0 fail.
  - S8 static guard -> passed, 18 files scanned.
  - S5/S6/S7 eval regression subset -> 3 + 23 + 6 pass / 0 fail.
  - `pnpm --filter @pa/functions typecheck`, `build`, and `test` -> pass;
    full functions test reported 1339 pass / 0 fail.
  - `pnpm --filter @pa/dashboard-web typecheck` and `build` -> pass.
  - `pnpm --filter @pa/landing build` -> pass.
- Worktree-local `node_modules` was installed with
  `pnpm install --frozen-lockfile` so this worktree resolves `@pa/core-types`
  to branch-local dist instead of the parent repo's stale package build.
- Firebase deploy passed after generating the gitignored dashboard Vite env from
  Firebase web config and preserving `VITE_CV_INGEST_URL` for landing:
  functions, `hosting:pa-dashboard`, and `hosting:pa-landing`.
- New S8 functions deployed:
  - `paAdminFlywheelEvalSnapshot`
  - `paCandidateProfileCorrection`
  - `paFlywheelCorrectionEvalArtifact`
- Live route/auth/count smoke passed:
  - candidate job route: 200 on `https://candidate.wekruit.com/j/5063962007`;
  - candidate profile route: 200 on `https://candidate.wekruit.com/me/profile`;
  - admin flywheel route: 200 on `https://wekruit-pa.web.app/admin/flywheel-eval`;
  - admin `/j/5063962007`: 301 to candidate domain;
  - unauth admin callable: 403;
  - unauth candidate correction callable: 401;
  - `pa-outbound` stayed `190 -> 190`.

## Next Gate

S9 has started from updated `main` on branch
`codex/v2-S9-production-hardening-scale`.
