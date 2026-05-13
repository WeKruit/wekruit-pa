# S0 Acceptance

This file records S0 verification.

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Branch | `git branch --show-current` | `codex/v2-S0-baseline-integration` | `codex/v2-S0-baseline-integration` | PASS |
| Head | `git rev-parse HEAD` | `23b9adb258fd10171e62cb8ba5030d5ba08dc3d0` | `23b9adb258fd10171e62cb8ba5030d5ba08dc3d0` | PASS |
| Dirty state | `git status --short --branch` | dedicated S0 worktree only; no unrelated root checkout changes touched | S0 branch edits are limited to planning docs, package/build-harness metadata, one external-benchmarks typecheck fix, and agent-registry stale test expectation updates | PASS |
| Worktree install | `pnpm install --frozen-lockfile` | lockfile install succeeds in S0 worktree | exit 0; reused lockfile/store; Node 22 engine warnings under local Node v25.6.1 | PASS |
| Orchestrator tests | `pnpm --filter pa-orchestrator test` | all pass, prior baseline 1479/1479 | first clean-worktree run failed 1153/1175 due missing built workspace deps; after `pretest` dependency-build fix: 1479/1479 pass, 0 fail | PASS |
| Functions tests | `cd apps/functions && pnpm test` | all pass | first clean-worktree run failed 921/939 due missing built workspace deps; sandbox rerun hit EPERM writing ignored `dist/`; escalated rerun after `pretest` dependency-build fix: 1168/1168 pass, 0 fail | PASS |
| Job-rec isolated build | `pnpm --filter @pa/job-rec build` | build succeeds from clean worktree | first GitHub Actions run failed because `job-rec` imported local packages before their `dist/` outputs existed; after explicit sequential `prebuild`, clean temp worktree `/private/tmp/wekruit-s0-ci-c667ffa` rerun passed | PASS |
| Monorepo build | `pnpm -r build` | recursive build succeeds | first GitHub Actions run failed because `@pa/job-tag-enricher` imported `openai` without declaring it; second run exposed `agent-runtime` missing direct `firebase-admin` plus test-only connector import in library build; clean temp worktree exposed `@pa/pa-resume-parser` missing direct `openai` and `@pa/functions` missing direct `zod`; after metadata/tsconfig fixes, clean temp worktree `/private/tmp/wekruit-s0-ci-c667ffa` rerun passed | PASS |
| Monorepo typecheck | `pnpm -r typecheck` | recursive typecheck succeeds | PR rerun exposed `apps/eval/external-benchmarks/lib/sf-client.mjs` JSDoc and catch narrowing issues; later GitHub check `25810771791` exposed the missing `@pa/functions` `@types/express` declaration; after both fixes, local recursive rerun passed | PASS |
| Functions typecheck PR repair | `pnpm --filter @pa/functions typecheck` | functions package typecheck succeeds from declared direct dependencies | GitHub check `25810771791` failed because `src/health.ts` imports `Response` from `express` without a direct type declaration. Added `@types/express` to `apps/functions/package.json`; local rerun passed with Node 22 engine warning under local Node v25.6.1 | PASS |
| Frozen lockfile after PR repair | `pnpm install --frozen-lockfile` | package manifests and lockfile are consistent | exit 0; lockfile records the `apps/functions` `@types/express@4.17.25` importer entry | PASS |
| Direct tsx package tests | `pnpm --filter @pa/agent-runtime test`; `pnpm --filter @pa/pa-broker test`; `pnpm --filter @pa/agent-registry test`; `pnpm --filter @pa/pa-connectors test`; `pnpm --filter @pa/pa-safety test` | packages using `node --import tsx` resolve `tsx` from direct package devDependencies | GitHub check `25811839921` failed because clean CI could not resolve `tsx` from `@pa/agent-runtime` and `@pa/pa-broker`; added direct `tsx` devDependencies to all workspace packages with `tsx` test scripts and no direct declaration. Local targeted reruns passed: agent-runtime 45/45, pa-broker 13/13, agent-registry 52/52, pa-connectors 22/22, pa-safety 87 pass and 1 gated live smoke skipped | PASS |
| Agent runtime test-cycle PR repair | `pnpm --filter @pa/agent-runtime test`; `NODE_ENV=test PA_DASHBOARD_ENV=test pnpm -r test` | agent-runtime tests succeed without reverse importing connector packages; recursive tests succeed on the repaired branch head | GitHub check `25812146097` failed because `openai-agents-adapter.test.ts` imported `@pa/pa-connectors`, creating a clean-install missing dependency and package cycle. Replaced that import with a local strict Zod fixture; local targeted rerun passed 45/45, and local recursive rerun on `f564cb8` passed with `apps/functions` still reporting 1168/1168 pass | PASS |
| Monorepo tests | `NODE_ENV=test PA_DASHBOARD_ENV=test pnpm -r test` | recursive tests succeed | full recursive run exposed stale hardcoded `agent-registry` test counts after metadata expansion; after deriving counts from current metadata/keys, local rerun passed; `apps/functions` still reports 1168/1168 pass | PASS |
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
M apps/eval/external-benchmarks/lib/sf-client.mjs
M apps/functions/package.json
M apps/job-rec/package.json
M packages/agent-registry/package.json
M packages/agent-registry/src/skill-defaults.ts
M packages/agent-registry/src/skill-schema.test.ts
M packages/agent-runtime/package.json
M packages/agent-runtime/tsconfig.json
M packages/pa-broker/package.json
M packages/pa-connectors/package.json
M packages/pa-job-tag-enricher/package.json
M packages/pa-orchestrator/package.json
M packages/pa-resume-parser/package.json
M packages/pa-safety/package.json
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
- `apps/functions/package.json`: declares its direct `@types/express`
  devDependency because `src/health.ts` imports `Response` from `express` and
  clean CI typechecking cannot rely on transitive Firebase types.
- `packages/agent-registry/package.json`, `packages/agent-runtime/package.json`,
  `packages/pa-broker/package.json`, `packages/pa-connectors/package.json`, and
  `packages/pa-safety/package.json`: declare direct `tsx` devDependencies
  because their test scripts invoke `node --import tsx` and clean CI package
  roots cannot rely on transitive or hoisted test runtimes.
- `apps/eval/external-benchmarks/lib/sf-client.mjs`: declares timeout options
  in JSDoc and narrows caught errors before checking `name`, keeping recursive
  JS typechecking clean.
- `packages/agent-registry/src/skill-schema.test.ts` and
  `packages/agent-registry/src/skill-defaults.ts`: remove stale hardcoded
  skill-count assumptions from tests/comments so current metadata expansion is
  validated directly.
- `packages/agent-runtime/src/openai-agents-adapter.test.ts`: uses a local
  strict Zod fixture for SDK wrapping tests instead of importing the
  `@pa/pa-connectors` registry, keeping package tests cycle-free in clean CI.
- `pnpm-lock.yaml`: updated from the current workspace graph; this adds the
  `openai`, `firebase-admin`, `zod`, `@types/express`, and `tsx` importer
  entries and removes the stale `apps/candidate-web` importer because that
  directory is not present in the workspace.

No deploy, live SMS, Sendblue outbound, production data mutation, paid eval, or
PII-printing action was performed during S0.
