# S0 - Baseline Integration

This is an autonomous sprint plan for WeKruit v2.0. It follows
`.planning/AUTONOMOUS-SPRINT-HARNESS.md` and must be kept current while work
proceeds.

## Purpose / Big Picture

S0 establishes a trusted baseline for autonomous v2.0 work. After S0, a lead
agent can start S1 from repo files alone, knowing the branch, product locks,
domain split, tests, curl checks, dirty state, and next execution rules.

## Observable Outcome

The observable outcome is a complete planning and verification packet:

- `.planning/v2.0/sprints/S0-baseline-integration/CONTEXT.md`
- `.planning/v2.0/sprints/S0-baseline-integration/PLAN.md`
- `.planning/v2.0/sprints/S0-baseline-integration/EXECUTOR-PLANS.md`
- `.planning/v2.0/sprints/S0-baseline-integration/ACCEPTANCE.md`
- `.planning/v2.0/sprints/S0-baseline-integration/SUMMARY.md`

The packet must record exact test and curl results. It must also identify the
next sprint trigger for S1.

## Current Repo Orientation

The current S0 execution worktree is:

```text
/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/v2-S0-baseline-integration
```

It was created from updated `main`:

```text
codex/v2-S0-baseline-integration at 23b9adb258fd10171e62cb8ba5030d5ba08dc3d0
```

The canonical product memory is `README.md`. The operating authority is
`CLAUDE.md`. The non-Claude agent TL;DR is `AGENTS.md`. The strategic sprint
roadmap is `.planning/MILESTONE-v2.0-candidate-retention-marketplace.md`. The
autonomous execution harness is `.planning/AUTONOMOUS-SPRINT-HARNESS.md`.

S0 is primarily a planning and verification sprint. Runtime code edits are not
expected.

After S0 lands, every implementation sprint must start from updated `main` in a
fresh worktree:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git worktree add .claude/worktrees/v2-S<N>-<slug> -b codex/v2-S<N>-<slug> main
cd .claude/worktrees/v2-S<N>-<slug>
```

## Locked Invariants And Non-Goals

Locked invariants:

- Candidate profile is global.
- Job state is per-job.
- Match score cannot block the first interview.
- Candidate flow must stay on candidate domain.
- Employer surface is passed-profile-only.
- v1.6 matching/tagging decisions are not re-litigated.
- Sendblue outreach safety is required before live outbound expansion.

Non-goals:

- No S1 schema implementation.
- No candidate claim flow.
- No employer bulk upload implementation.
- No new matching algorithm.
- No new outreach policy.
- No deploy unless S0 discovers a blocking config drift and Adam approves it.

## Data Model And Ownership

S0 should not add collections or fields. It should verify that later data model
work has a place to start.

The S1 lead will own these future primitives:

- global candidate profile
- identity handles
- candidate-job edge
- correction events
- employer-visible passed profile snapshot
- flywheel events

S0 must not pre-implement them.

## UI Surface Map

S0 verifies current surfaces:

- Candidate landing: `https://candidate.wekruit.com/`
- Public job page: `https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer`
- Admin stale candidate job URL redirects to candidate domain.
- Existing admin pages remain admin-only.

No UI changes are planned in S0.

## Backend/API/Service Map

S0 verifies current services:

- `paPublicCvIngest` responds with expected validation error on empty JSON.
- `pa-orchestrator` tests are green.
- `apps/functions` tests are green.

No backend service changes are planned in S0.

## Executor Topology

S0 needs planning/review executors, not implementation executors.

| Executor | Responsibility | Write scope |
|---|---|---|
| Repo State | classify branch, commits, dirty state | S0 docs only |
| Test Harness | define and verify test/curl commands | S0 docs only |
| Domain/Deploy State | verify candidate/admin split and live URL expectations | S0 docs only |
| Roadmap Consistency | confirm README, CLAUDE, AGENTS, roadmap, harness agree | S0 docs only |

No executor may edit runtime code in S0 without lead approval and an updated
plan.

## Agent Plan Handshake

The lead must ask each executor for `AGENT_PLAN` before any work beyond docs.
Draft prompts are in `EXECUTOR-PLANS.md`.

The lead must integrate executor plans and explicitly answer:

- Are write scopes disjoint?
- Do any plans touch runtime code?
- Are the six sanity checks enough for S0?
- Do docs point to the same roadmap/harness?
- Are S1 entry criteria clear?

Lead integration note after executor `AGENT_PLAN` responses:

- Write scopes are disjoint because all executors returned read-only plans and
  the lead owns the S0 docs edits.
- No executor plan touches runtime code, deploys, mutates data, or sends live
  outbound.
- The S0 acceptance checks remain sufficient for a baseline sprint: branch and
  dirty-state inspection, pa-orchestrator tests, functions tests, candidate
  landing curl, public job curl, admin redirect curl, public CV ingest
  validation curl, and canonical doc cross-reference.
- Domain/Deploy State owns expected live URL behavior; Test Harness owns test
  command expectations; Repo State owns branch/dirty classification; Roadmap
  Consistency owns canonical doc consistency. The lead records the final
  consolidated acceptance evidence.
- `.planning/V2-GOAL-PROMPT.md` is included in the final cross-reference check
  because the canonical docs reference it.
- Historical references to `claude/frosty-wozniak-84b965` are baseline context;
  the actual S0 closeout branch is `codex/v2-S0-baseline-integration`.

## Milestones

M0.1: S0 directory and required documents exist.

M0.2: Executor plan prompts are written.

M0.3: Six v1.9 sanity checks are re-run and recorded.

M0.4: Dirty state and branch state are recorded.

M0.5: Canonical docs cross-reference blueprint, roadmap, and autonomous harness.

M0.6: `SUMMARY.md` records S1 entry conditions.

## Concrete Steps

1. Confirm branch:

   ```bash
   git branch --show-current
   ```

   Expected: `codex/v2-S0-baseline-integration`.

2. Confirm dirty state:

   ```bash
   git status --short
   ```

   Expected during S0 closeout: only S0 docs/artifacts edited in the dedicated
   worktree.

3. Re-run orchestrator tests:

   ```bash
   pnpm --filter pa-orchestrator test
   ```

   Expected: all tests pass. Previous baseline was 1479/1479.

4. Re-run functions tests:

   ```bash
   cd apps/functions && pnpm test
   ```

   Expected: all tests pass. Previous baseline was 1143/1143; fresh S0
   closeout count is 1168/1168 after recent test additions.

5. Re-run candidate landing curl:

   ```bash
   curl -sI https://candidate.wekruit.com/
   ```

   Expected: HTTP 200.

6. Re-run public job curl:

   ```bash
   curl -sI https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer
   ```

   Expected: HTTP 200.

7. Re-run admin redirect curl:

   ```bash
   curl -sI https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer
   ```

   Expected: HTTP 301 with `location:
   https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer`.

8. Re-run public CV ingest validation curl:

   ```bash
   curl -s -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest \
     -H 'content-type: application/json' \
     -d '{}'
   ```

   Expected: `{"ok":false,"reason":"missing_userId_or_tempUserId"}`.

9. Update `ACCEPTANCE.md` with actual outputs.

10. Write `SUMMARY.md` with S1 trigger.

## Verification Harness

S0 verification is intentionally small:

- branch and dirty-state inspection
- two test commands
- four curl checks
- cross-reference check with `rg`

No live SMS, no Sendblue outbound, no paid eval, and no data mutation beyond
normal test behavior.

## HITL And Flywheel

S0 creates no candidate-facing HITL event. It prepares the harness that S8 will
use to turn HITL corrections into eval/flywheel data.

## Safety And Privacy

S0 must not print raw production PII. If curl/test output includes PII, redact
before writing artifacts.

S0 must not run live outbound or mutate production candidate state.

## Idempotence And Recovery

All S0 commands are safe to re-run. If tests fail, record:

- exact command
- first failing test
- current branch
- dirty state
- whether failure is reproducible
- next verification step

If curl checks fail, record:

- exact URL
- status code
- headers/body snippet
- whether DNS, hosting, redirect, or function behavior appears to be the issue

## Progress

- [x] (2026-05-13) v2.0 blueprint written to `README.md`, `CLAUDE.md`, and `AGENTS.md`.
- [x] (2026-05-13) v2.0 roadmap written to `.planning/MILESTONE-v2.0-candidate-retention-marketplace.md`.
- [x] (2026-05-13) autonomous sprint harness written to `.planning/AUTONOMOUS-SPRINT-HARNESS.md`.
- [x] (2026-05-13) S0 context and plan initialized.
- [x] Executor plans requested and integrated.
- [x] S0 acceptance checks re-run and recorded.
- [x] S0 summary written.

## Decision Log

- Decision: S0 is a baseline integration sprint, not a product implementation sprint.
  Rationale: v2.0 is large enough that autonomous execution needs a verified base before S1 schema work.
  Date/Author: 2026-05-13 / lead agent.

- Decision: Executors must return `AGENT_PLAN` before implementation.
  Rationale: `/goal` needs explicit planning, write-scope isolation, and acceptance gates before autonomous parallel work.
  Date/Author: 2026-05-13 / lead agent.

- Decision: S0 may include minimal test-harness script fixes when required to
  make the documented acceptance commands pass from a clean worktree.
  Rationale: the first test runs failed before product assertions because
  workspace `dist/` outputs were missing; the correct fix is making the test
  commands build their declared local package dependencies.
  Date/Author: 2026-05-13 / lead agent.

- Decision: S0 may include minimal package metadata fixes when required by the
  PR acceptance build.
  Rationale: `@pa/job-tag-enricher` imported `openai` without declaring it, and
  `@pa/agent-runtime` imported Firestore types from `firebase-admin` without
  declaring it.
  Date/Author: 2026-05-13 / lead agent.

- Decision: S0 may include minimal build-order fixes when required by the PR
  acceptance build.
  Rationale: the original multi-workspace npm commands allowed CI to compile
  packages before their local dependency `dist/` outputs existed, and
  `agent-runtime`'s library build included a test-only import of
  `@pa/pa-connectors`, creating a production build-order cycle.
  Date/Author: 2026-05-13 / lead agent.

## Surprises And Discoveries

- Observation: Current dirty state in the dedicated S0 worktree is limited to
  S0 docs plus package test/build scripts, direct dependency declarations,
  one tsconfig build-scope correction, and the generated lockfile update.
  Evidence: `git status --short --branch`.

- Observation: A clean worktree did not have built workspace `dist/` outputs,
  so the original test commands were not self-contained.
  Evidence: first `pnpm --filter pa-orchestrator test` failed 1153/1175 with
  missing `@pa/pa-broker`, `@pa/pa-persistence`, and `@pa/pa-safety` modules;
  first `apps/functions` test failed 921/939 with missing
  `@pa/pa-orchestrator`, `@pa/job-rec`, and `@pa/job-tag-enricher` modules.

- Observation: The `apps/functions` sandbox rerun hit EPERM while TypeScript
  was writing ignored `dist/` outputs. The same command passed when rerun with
  escalated filesystem permissions.
  Evidence: final `cd apps/functions && pnpm test` returned 1168/1168 pass.

- Observation: The initial PR checks exposed two CI-only build reproducibility
  gaps that local S0 test commands did not cover: direct dependencies were
  missing for packages compiled by `pnpm -r build`, and multi-workspace npm
  commands did not guarantee dependency order in CI.
  Evidence: local reruns of `pnpm --filter @pa/job-rec build`, `pnpm -r
  build`, `pnpm --filter pa-orchestrator test`, and `cd apps/functions && pnpm
  test` all passed after the package metadata and build-order fixes.

## Outcomes And Retrospective

S0 is accepted. The v2.0 baseline is now recorded from the dedicated
`codex/v2-S0-baseline-integration` worktree, executor plans are integrated, and
the required local tests plus live curl checks are green.

S1 can start from updated `main` after this S0 closeout lands. The next sprint
is S1 - Marketplace Data Foundation.
