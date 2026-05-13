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
Pending. Lead must request this from the executor before S0 execution.
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
Pending. Lead must request this from the executor before S0 execution.
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
Pending. Lead must request this from the executor before S0 execution.
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
Pending. Lead must request this from the executor before S0 execution.
```

## Lead Integration Note

Pending. The lead fills this after executor `AGENT_PLAN` responses exist.

