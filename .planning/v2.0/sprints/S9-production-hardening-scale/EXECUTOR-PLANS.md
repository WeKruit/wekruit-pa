# S9 Executor Plans - Production Hardening + Scale

Executor plans are pending. Use this prompt shape before implementation:

```text
You are not alone in the codebase. Other executors may work in parallel.
Do not revert unrelated changes. Do not edit outside your assigned write scope.
Return AGENT_PLAN only. Do not implement yet.

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

## Planned Executors

| Executor | Objective | Exclusive write scope | Status |
|---|---|---|---|
| A | Contracts + privacy data | `packages/core-types`, `packages/pa-persistence` | PENDING |
| B | Functions + stop gates | `apps/functions/src/*launch*`, `*privacy*`, outreach stop gate changes | PENDING |
| C | Admin launch readiness UI | `apps/dashboard-web/src/pages/*Launch*`, admin wrapper/tests, `App.tsx` route/nav | PENDING |
| D | Candidate privacy controls | `apps/pa-landing/src/**` privacy UI/wrapper/tests | PENDING |
| E | Smoke/load/eval harness | `tests/eval/s9-production-hardening-scale/**`, `tests/scenarios/s9-production-hardening-scale/**`, artifacts | PENDING |
