# S0 Acceptance

This file records S0 verification.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S0-baseline-integration` | `codex/v2-S0-baseline-integration` | PASS |
| Head | `git rev-parse HEAD` | `23b9adb258fd10171e62cb8ba5030d5ba08dc3d0` | `23b9adb258fd10171e62cb8ba5030d5ba08dc3d0` | PASS |
| Dirty state | `git status --short --branch` | only S0 docs and minimal test/build-harness scripts edited | S0 `ACCEPTANCE.md`, `CONTEXT.md`, `EXECUTOR-PLANS.md`, `PLAN.md`, `SUMMARY.md`, plus `apps/functions/package.json`, `apps/job-rec/package.json`, `packages/pa-job-tag-enricher/package.json`, `packages/pa-orchestrator/package.json`, and `pnpm-lock.yaml` | PASS |
| Worktree install | `pnpm install --frozen-lockfile` | lockfile install succeeds in S0 worktree | exit 0; reused lockfile/store; Node 22 engine warnings under local Node v25.6.1 | PASS |
| Orchestrator tests | `pnpm --filter pa-orchestrator test` | all pass, prior baseline 1479/1479 | first clean-worktree run failed 1153/1175 due missing built workspace deps; after `pretest` dependency-build fix: 1479/1479 pass, 0 fail | PASS |
| Functions tests | `cd apps/functions && pnpm test` | all pass | first clean-worktree run failed 921/939 due missing built workspace deps; sandbox rerun hit EPERM writing ignored `dist/`; escalated rerun after `pretest` dependency-build fix: 1168/1168 pass, 0 fail | PASS |
| Job-rec isolated build | `pnpm --filter @pa/job-rec build` | build succeeds from clean worktree | first GitHub Actions run failed because `job-rec` imported local packages before their `dist/` outputs existed; after `prebuild` dependency-build fix, local rerun passed | PASS |
| Monorepo build | `pnpm -r build` | recursive build succeeds | first GitHub Actions run failed because `@pa/job-tag-enricher` imported `openai` without declaring it; after adding the dependency and lockfile update, local rerun passed | PASS |
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
M packages/pa-job-tag-enricher/package.json
M packages/pa-orchestrator/package.json
M pnpm-lock.yaml
```

Ignored generated artifacts from `pnpm install` and package builds include
`node_modules/` and workspace `dist/` directories; they are not part of the
commit.

S0 harness fixes:

- `packages/pa-orchestrator/package.json`: `pretest` now builds all local
  workspace packages that `pa-orchestrator` imports via `dist/`.
- `apps/functions/package.json`: `pretest` now builds local workspace packages
  imported by functions tests.
- `apps/job-rec/package.json`: `prebuild` now builds local workspace packages
  imported by the isolated `@pa/job-rec` build.
- `packages/pa-job-tag-enricher/package.json`: declares its direct `openai`
  dependency.
- `pnpm-lock.yaml`: updated from the current workspace graph; this adds the
  `openai` importer entry and removes the stale `apps/candidate-web` importer
  because that directory is not present in the workspace.

No deploy, live SMS, Sendblue outbound, production data mutation, paid eval, or
PII-printing action was performed during S0.
