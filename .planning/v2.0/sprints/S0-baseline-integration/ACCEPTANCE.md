# S0 Acceptance

This file records S0 verification.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S0-baseline-integration` | `codex/v2-S0-baseline-integration` | PASS |
| Head | `git rev-parse HEAD` | `23b9adb258fd10171e62cb8ba5030d5ba08dc3d0` | `23b9adb258fd10171e62cb8ba5030d5ba08dc3d0` | PASS |
| Dirty state | `git status --short --branch` | only S0 docs and minimal test/build-harness scripts edited | S0 `ACCEPTANCE.md`, `CONTEXT.md`, `EXECUTOR-PLANS.md`, `PLAN.md`, `SUMMARY.md`, plus `apps/functions/package.json`, `apps/job-rec/package.json`, `packages/agent-runtime/package.json`, `packages/agent-runtime/tsconfig.json`, `packages/pa-job-tag-enricher/package.json`, `packages/pa-orchestrator/package.json`, `packages/pa-resume-parser/package.json`, and `pnpm-lock.yaml` | PASS |
| Worktree install | `pnpm install --frozen-lockfile` | lockfile install succeeds in S0 worktree | exit 0; reused lockfile/store; Node 22 engine warnings under local Node v25.6.1 | PASS |
| Orchestrator tests | `pnpm --filter pa-orchestrator test` | all pass, prior baseline 1479/1479 | first clean-worktree run failed 1153/1175 due missing built workspace deps; after `pretest` dependency-build fix: 1479/1479 pass, 0 fail | PASS |
| Functions tests | `cd apps/functions && pnpm test` | all pass | first clean-worktree run failed 921/939 due missing built workspace deps; sandbox rerun hit EPERM writing ignored `dist/`; escalated rerun after `pretest` dependency-build fix: 1168/1168 pass, 0 fail | PASS |
| Job-rec isolated build | `pnpm --filter @pa/job-rec build` | build succeeds from clean worktree | first GitHub Actions run failed because `job-rec` imported local packages before their `dist/` outputs existed; after explicit sequential `prebuild`, clean temp worktree `/private/tmp/wekruit-s0-ci-c667ffa` rerun passed | PASS |
| Monorepo build | `pnpm -r build` | recursive build succeeds | first GitHub Actions run failed because `@pa/job-tag-enricher` imported `openai` without declaring it; second run exposed `agent-runtime` missing direct `firebase-admin` plus test-only connector import in library build; clean temp worktree exposed `@pa/pa-resume-parser` missing direct `openai` and `@pa/functions` missing direct `zod`; after metadata/tsconfig fixes, clean temp worktree `/private/tmp/wekruit-s0-ci-c667ffa` rerun passed | PASS |
| Candidate landing | `curl -sI https://candidate.wekruit.com/` | HTTP 200 | sandbox curl first failed DNS exit 6; approved `curl -sS -i -I` returned `HTTP/2 200` | PASS |
| Public job page | `curl -sI https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | HTTP 200 | sandbox curl first failed DNS exit 6; approved `curl -sS -i -I` returned `HTTP/2 200` | PASS |
| Admin redirect | `curl -sI https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer` | HTTP 301 to candidate domain | approved `curl -sS -i -I` returned `HTTP/2 301` with `location: https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer` | PASS |
| Public CV ingest validation | `curl -s -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest -H 'content-type: application/json' -d '{}'` | `{"ok":false,"reason":"missing_userId_or_tempUserId"}` | approved `curl -sS -i -X POST ... -d '{}'` returned `HTTP/2 400` and `{"ok":false,"reason":"missing_userId_or_tempUserId"}` | PASS |
| Doc cross-reference | `rg -n "Product Blueprint|Candidate Retention Marketplace|AUTONOMOUS-SPRINT-HARNESS|MILESTONE-v2.0|V2-GOAL-PROMPT|candidate\\.wekruit\\.com|pa\\.wekruit\\.com|wekruit-pa\\.web\\.app|first interview|passed-profile|NOT_PASS|Sendblue" ...` | canonical docs point to blueprint, roadmap, harness, V2 prompt, domain split, and product locks | references found in README.md, CLAUDE.md, AGENTS.md, milestone, harness, V2 prompt, and S0 docs; no contradictory lock found | PASS |

## Hard Fail Conditions

- Candidate route appears on admin domain as primary route.
- First interview is blocked by match score.
- Employer sees a not-passed candidate.
- Raw PII is used as public document id.
- Live outbound is sent during S0.
- Costed eval/live run starts during S0.
- Runtime code is edited without updating S0 plan.

## Evidence

Branch and head:

```text
codex/v2-S0-baseline-integration
23b9adb258fd10171e62cb8ba5030d5ba08dc3d0
```

Final S0 branch changed files:

```text
M .planning/v2.0/sprints/S0-baseline-integration/ACCEPTANCE.md
M .planning/v2.0/sprints/S0-baseline-integration/CONTEXT.md
M .planning/v2.0/sprints/S0-baseline-integration/EXECUTOR-PLANS.md
M .planning/v2.0/sprints/S0-baseline-integration/PLAN.md
M .planning/v2.0/sprints/S0-baseline-integration/SUMMARY.md
M apps/functions/package.json
M apps/job-rec/package.json
M packages/agent-runtime/package.json
M packages/agent-runtime/tsconfig.json
M packages/pa-job-tag-enricher/package.json
M packages/pa-orchestrator/package.json
M packages/pa-resume-parser/package.json
M pnpm-lock.yaml
```

Ignored generated artifacts from `pnpm install` and package builds include
`node_modules/` and workspace `dist/` directories; they are not part of the
commit.

S0 harness fixes:

- `packages/pa-orchestrator/package.json`: `pretest` now builds local
  workspace packages sequentially in dependency order.
- `apps/functions/package.json`: `pretest` now builds local workspace packages
  sequentially in dependency order.
- `apps/job-rec/package.json`: `prebuild` now builds local workspace packages
  sequentially in dependency order for the isolated `@pa/job-rec` build.
- `packages/agent-runtime/package.json`: declares its direct `firebase-admin`
  dependency for Firestore type imports.
- `packages/agent-runtime/tsconfig.json`: excludes `*.test.ts` from the
  library build so test-only connector registry imports do not create a
  production build-order cycle.
- `packages/pa-job-tag-enricher/package.json`: declares its direct `openai`
  dependency.
- `packages/pa-resume-parser/package.json`: declares its direct `openai`
  dependency for the Responses provider dynamic import.
- `apps/functions/package.json`: declares its direct `zod` dependency for
  function modules bundled by `apps/functions/build.mjs`.
- `pnpm-lock.yaml`: updated from the current workspace graph; this adds the
  `openai`, `firebase-admin`, and `zod` importer entries and removes the stale
  `apps/candidate-web` importer because that directory is not present in the
  workspace.

No deploy, live SMS, Sendblue outbound, production data mutation, paid eval, or
PII-printing action was performed during S0.
