# S0 Executor Plans

This file is the plan handshake ledger. Per
`.planning/AUTONOMOUS-SPRINT-HARNESS.md`, executors must return `AGENT_PLAN`
before implementation. S0 is docs/test verification only unless the lead updates
the plan.

## Shared Executor Instruction

Use this prefix for every S0 executor:

```text
You are not alone in the codebase. Other executors may work in parallel.
Do not revert unrelated changes. Do not edit outside your assigned write scope.
Return AGENT_PLAN only. Do not implement yet.
```

## Executor 1: Repo State

Prompt:

```text
You are Executor Repo State for WeKruit v2.0 sprint S0.

Read:
- README.md
- CLAUDE.md
- AGENTS.md
- .planning/MILESTONE-v2.0-candidate-retention-marketplace.md
- .planning/AUTONOMOUS-SPRINT-HARNESS.md
- .planning/v2.0/sprints/S0-baseline-integration/CONTEXT.md
- .planning/v2.0/sprints/S0-baseline-integration/PLAN.md

Your responsibility:
Verify current branch, latest commits, dirty state, and whether any dirty files
are outside the S0 docs/planning scope.

Exclusive write scope:
- .planning/v2.0/sprints/S0-baseline-integration/ACCEPTANCE.md
- .planning/v2.0/sprints/S0-baseline-integration/artifacts/repo-state.txt

Shared files you may read but not edit:
- all repo files

You are not alone in the codebase. Other executors may work in parallel.
Do not revert unrelated changes. Do not edit outside your assigned write scope.
Return AGENT_PLAN only. Do not implement yet.

Use this exact format:

AGENT_PLAN
Executor:
Objective:
Files to read:
Exclusive write scope:
Shared files needed:
Dependencies on other executors:
Proposed steps:
Tests/evals to add or run:
Safety/privacy checks:
Stop conditions:
Expected artifacts:
Questions for lead:
```

AGENT_PLAN response:

```text
AGENT_PLAN
Executor:
Repo State
Objective:
Verify and report current S0 worktree state: branch, HEAD, latest commits,
dirty state, and whether dirty files are outside the S0 docs/planning scope.
Files to read:
README.md; CLAUDE.md; AGENTS.md;
.planning/MILESTONE-v2.0-candidate-retention-marketplace.md;
.planning/AUTONOMOUS-SPRINT-HARNESS.md;
.planning/v2.0/sprints/S0-baseline-integration/CONTEXT.md;
.planning/v2.0/sprints/S0-baseline-integration/PLAN.md.
Exclusive write scope:
None.
Shared files needed:
All repo files read-only if needed for status/path classification.
Dependencies on other executors:
None for repo-state verification; lead integrates with Test Harness,
Domain/Deploy State, and Roadmap Consistency outputs.
Proposed steps:
Confirm worktree path, branch, HEAD, recent commits, dirty state, untracked
files, and classify any dirty paths. Flag old frosty worktree references as
historical baseline context.
Tests/evals to add or run:
No tests added. Read-only git inspection only.
Safety/privacy checks:
No file edits, deploy, live curl, production data reads, secrets, or PII.
Do not revert or clean dirty state.
Stop conditions:
Stop if dirty runtime files appear outside S0 scope or branch/HEAD diverges
from the intended S0 baseline.
Expected artifacts:
Lead records verified branch, HEAD, commits, and dirty-state classification in
S0 acceptance/summary docs.
Questions for lead:
Replace older expected branch/worktree references with current Codex worktree,
while preserving them only as historical baseline context.
```

## Executor 2: Test Harness

Prompt:

```text
You are Executor Test Harness for WeKruit v2.0 sprint S0.

Read:
- README.md
- CLAUDE.md
- AGENTS.md
- .planning/HANDOFF-TO-LEAD-2026-05-13.md
- .planning/V19-FULL-FLOW-TEST.md
- .planning/AUTONOMOUS-SPRINT-HARNESS.md
- .planning/v2.0/sprints/S0-baseline-integration/CONTEXT.md
- .planning/v2.0/sprints/S0-baseline-integration/PLAN.md

Your responsibility:
Verify the exact test commands for pa-orchestrator and apps/functions, expected
pass counts, and how failures should be recorded.

Exclusive write scope:
- .planning/v2.0/sprints/S0-baseline-integration/ACCEPTANCE.md
- .planning/v2.0/sprints/S0-baseline-integration/artifacts/test-harness.txt

Shared files you may read but not edit:
- packages/pa-orchestrator/package.json
- apps/functions/package.json
- .planning/HANDOFF-TO-LEAD-2026-05-13.md
- .planning/V19-FULL-FLOW-TEST.md

You are not alone in the codebase. Other executors may work in parallel.
Do not revert unrelated changes. Do not edit outside your assigned write scope.
Return AGENT_PLAN only. Do not implement yet.

Use this exact format:

AGENT_PLAN
Executor:
Objective:
Files to read:
Exclusive write scope:
Shared files needed:
Dependencies on other executors:
Proposed steps:
Tests/evals to add or run:
Safety/privacy checks:
Stop conditions:
Expected artifacts:
Questions for lead:
```

AGENT_PLAN response:

```text
AGENT_PLAN
Executor:
Test Harness
Objective:
Verify the canonical pa-orchestrator and apps/functions test commands, expected
pass counts, and failure-recording rules for S0 without editing files.
Files to read:
README.md; CLAUDE.md; AGENTS.md; .planning/HANDOFF-TO-LEAD-2026-05-13.md;
.planning/V19-FULL-FLOW-TEST.md; .planning/AUTONOMOUS-SPRINT-HARNESS.md;
.planning/v2.0/sprints/S0-baseline-integration/CONTEXT.md;
.planning/v2.0/sprints/S0-baseline-integration/PLAN.md;
packages/pa-orchestrator/package.json; apps/functions/package.json.
Exclusive write scope:
None.
Shared files needed:
Package test scripts plus S0 acceptance and summary files, read-only for the
executor.
Dependencies on other executors:
Repo State provides branch/dirty state. Domain/Deploy State owns live URL curl
expectations. Lead writes final acceptance evidence.
Proposed steps:
Treat `pnpm --filter pa-orchestrator test` and `cd apps/functions && pnpm test`
as the S0 commands. Use current expected counts 1479/1479 and 1143/1143. Record
failure details with command, first failing test, branch, dirty state,
reproducibility, and next verification step.
Tests/evals to add or run:
No tests added. Later S0 run commands are the two documented test commands.
Safety/privacy checks:
Do not print raw production PII, run live SMS/Sendblue, mutate production
candidate state, deploy, or edit runtime code.
Stop conditions:
Stop if package scripts differ from documented commands, actual pass counts
differ, output exposes raw PII, or branch/dirty state is unavailable.
Expected artifacts:
Lead records actual test rows in ACCEPTANCE.md and SUMMARY.md.
Questions for lead:
Treat older CLAUDE.md 1458/1139 count as stale if still present, but use fresh
S0 command output as authoritative.
```

## Executor 3: Domain/Deploy State

Prompt:

```text
You are Executor Domain/Deploy State for WeKruit v2.0 sprint S0.

Read:
- README.md
- CLAUDE.md
- AGENTS.md
- firebase.json
- .planning/HANDOFF-TO-LEAD-2026-05-13.md
- .planning/AUTONOMOUS-SPRINT-HARNESS.md
- .planning/v2.0/sprints/S0-baseline-integration/CONTEXT.md
- .planning/v2.0/sprints/S0-baseline-integration/PLAN.md

Your responsibility:
Verify candidate/admin domain split expectations and the four curl checks.

Exclusive write scope:
- .planning/v2.0/sprints/S0-baseline-integration/ACCEPTANCE.md
- .planning/v2.0/sprints/S0-baseline-integration/artifacts/domain-deploy-state.txt

Shared files you may read but not edit:
- firebase.json
- apps/pa-landing
- apps/dashboard-web

You are not alone in the codebase. Other executors may work in parallel.
Do not revert unrelated changes. Do not edit outside your assigned write scope.
Return AGENT_PLAN only. Do not implement yet.

Use this exact format:

AGENT_PLAN
Executor:
Objective:
Files to read:
Exclusive write scope:
Shared files needed:
Dependencies on other executors:
Proposed steps:
Tests/evals to add or run:
Safety/privacy checks:
Stop conditions:
Expected artifacts:
Questions for lead:
```

AGENT_PLAN response:

```text
AGENT_PLAN
Executor:
Domain/Deploy State
Objective:
Verify the locked candidate/admin hosting split and plan the four S0 live curl
checks without editing runtime or planning files.
Files to read:
README.md; CLAUDE.md; AGENTS.md; firebase.json;
.planning/HANDOFF-TO-LEAD-2026-05-13.md;
.planning/AUTONOMOUS-SPRINT-HARNESS.md;
.planning/v2.0/sprints/S0-baseline-integration/CONTEXT.md;
.planning/v2.0/sprints/S0-baseline-integration/PLAN.md;
apps/pa-landing/src/main.tsx; apps/dashboard-web/src/App.tsx.
Exclusive write scope:
None.
Shared files needed:
firebase.json; apps/pa-landing; apps/dashboard-web.
Dependencies on other executors:
Test Harness or lead records final command outputs. Repo State confirms branch
and dirty state before curl evidence is accepted.
Proposed steps:
Confirm Firebase Hosting targets, pa-dashboard `/j/:rest*` 301 redirect,
pa-landing ownership of `/`, `/legal`, `/j/:jobId`, `/j/:jobId/cv`, and run the
four S0 curl checks exactly as listed in PLAN.md.
Tests/evals to add or run:
`curl -sI https://candidate.wekruit.com/`; `curl -sI
https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer`; `curl -sI
https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer`; `curl -s -X
POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest -H
'content-type: application/json' -d '{}'`.
Safety/privacy checks:
Do not send live SMS, mutate Firestore, deploy, expose raw PII, or follow
redirects in a way that hides the expected admin-domain 301.
Stop conditions:
Stop if live curl output differs, `/j/*` renders on admin domain, candidate DNS
or SSL fails, or paPublicCvIngest returns a non-validation response.
Expected artifacts:
Lead records each command, observed status/body or Location header, pass/fail,
and failure classification if applicable.
Questions for lead:
Lead will run and record raw curl snippets in the consolidated ACCEPTANCE.md.
```

## Executor 4: Roadmap Consistency

Prompt:

```text
You are Executor Roadmap Consistency for WeKruit v2.0 sprint S0.

Read:
- README.md
- CLAUDE.md
- AGENTS.md
- .planning/MILESTONE-v2.0-candidate-retention-marketplace.md
- .planning/AUTONOMOUS-SPRINT-HARNESS.md
- .planning/v2.0/sprints/S0-baseline-integration/CONTEXT.md
- .planning/v2.0/sprints/S0-baseline-integration/PLAN.md

Your responsibility:
Verify that canonical product memory, roadmap, autonomous harness, and agent
operating docs all point to each other consistently.

Exclusive write scope:
- .planning/v2.0/sprints/S0-baseline-integration/ACCEPTANCE.md
- .planning/v2.0/sprints/S0-baseline-integration/artifacts/roadmap-consistency.txt

Shared files you may read but not edit:
- README.md
- CLAUDE.md
- AGENTS.md
- .planning/MILESTONE-v2.0-candidate-retention-marketplace.md
- .planning/AUTONOMOUS-SPRINT-HARNESS.md

You are not alone in the codebase. Other executors may work in parallel.
Do not revert unrelated changes. Do not edit outside your assigned write scope.
Return AGENT_PLAN only. Do not implement yet.

Use this exact format:

AGENT_PLAN
Executor:
Objective:
Files to read:
Exclusive write scope:
Shared files needed:
Dependencies on other executors:
Proposed steps:
Tests/evals to add or run:
Safety/privacy checks:
Stop conditions:
Expected artifacts:
Questions for lead:
```

AGENT_PLAN response:

```text
AGENT_PLAN
Executor:
Roadmap Consistency
Objective:
Verify that README, CLAUDE, AGENTS, v2.0 roadmap, autonomous harness, and S0
docs consistently point to the same product blueprint, sprint roadmap, harness
rules, executor-plan flow, domain split, and S1 entry assumptions.
Files to read:
README.md; CLAUDE.md; AGENTS.md;
.planning/MILESTONE-v2.0-candidate-retention-marketplace.md;
.planning/AUTONOMOUS-SPRINT-HARNESS.md;
.planning/v2.0/sprints/S0-baseline-integration/CONTEXT.md;
.planning/v2.0/sprints/S0-baseline-integration/PLAN.md.
Exclusive write scope:
None.
Shared files needed:
The canonical docs and S0 docs listed above.
Dependencies on other executors:
Repo State ties findings to the correct baseline. Domain/Deploy State confirms
live URL expectations. Test Harness confirms acceptance checks.
Proposed steps:
Check cross-links among README, CLAUDE.md, AGENTS.md, roadmap, harness, and S0
docs; compare product invariants; compare S0 acceptance criteria and S1 entry
criteria; report any drift.
Tests/evals to add or run:
No tests added. Run read-only `rg` checks for Product Blueprint, Candidate
Retention Marketplace, autonomous harness, roadmap, V2 prompt, candidate/admin
domains, first interview, passed-profile, NOT_PASS, and Sendblue references.
Safety/privacy checks:
No PII, live calls, deploys, data mutation, outbound, or file edits.
Stop conditions:
Stop if a required doc is missing, editing is required, or executor acceptance
interpretations conflict.
Expected artifacts:
Lead records cross-reference result in S0 acceptance/summary docs.
Questions for lead:
Include `.planning/V2-GOAL-PROMPT.md` in final consistency verification because
canonical docs reference it.
```

## Lead Integration Note

Executor `AGENT_PLAN` responses were collected before S0 acceptance execution.

Integration decisions:

- The executor write scopes are disjoint because each executor returned a
  read-only plan. The lead owns all S0 doc edits and evidence consolidation.
- No executor plan touches runtime code, deploys, mutates candidate data, sends
  SMS, or changes product semantics.
- Shared files are read-only. The only writes are S0 planning docs and optional
  S0 artifacts.
- The six v1.9 sanity checks plus branch/dirty-state and doc cross-reference
  checks are sufficient for S0 because S0 is a baseline verification sprint, not
  an implementation sprint.
- The Test Harness plan used the prior functions count 1143/1143. The fresh S0
  closeout command supersedes that with 1168/1168 after additional committed
  tests on `main`.
- `.planning/V2-GOAL-PROMPT.md` is included in final doc cross-reference
  verification because canonical docs point to it.
- The execution wave order for S0 is: update plan ledger, run local tests, run
  curl checks, run doc consistency check, update acceptance/summary, then land
  the S0 closeout branch.
