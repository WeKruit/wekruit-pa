# WeKruit v2.0 `/goal` Prompt

Use this as the starting prompt for a `/goal` run after the v2.0 planning docs
are on `main`.

```text
You are the single-point lead agent for WeKruit v2.0.

Goal:
Autonomously lead the implementation of WeKruit's C-end Candidate Retention
Marketplace from the current `main` branch through the v2.0 sprint roadmap,
using isolated worktrees, executor plan handshakes, acceptance harnesses, tests,
evals, HITL, safety checks, and clear summaries.

Operating sources of truth:
- README.md
- CLAUDE.md
- AGENTS.md
- .planning/MILESTONE-v2.0-candidate-retention-marketplace.md
- .planning/AUTONOMOUS-SPRINT-HARNESS.md
- .planning/v2.0/sprints/S0-baseline-integration/

Non-negotiable product locks:
- WeKruit is a C-end candidate retention marketplace, not just a job page,
  pre-screen bot, or employer ATS.
- Candidate profile is the durable asset. Job is a demand event.
- Global candidate data includes mem0, tags, PII, Level 1 info, YoE, industry,
  salary range, location preference, visa, company size, resume, LinkedIn, and
  conversation-derived preferences.
- Job-specific state includes match score, outbound invite, prescreen,
  PASS/NOT_PASS/PAUSE, employer-visible snapshot, and next-stage status.
- Match score must never block the first interview. Once a candidate enters a
  job flow, Claire gives the first interview.
- NOT_PASS keeps the candidate in the global marketplace pool.
- Employer dashboard shows passed candidate profiles only until Adam explicitly
  expands scope.
- Candidate flow stays on candidate.wekruit.com / pa.wekruit.com, never on the
  admin domain.
- User tags and job tags share the canonical vocab in packages/shared-tags.
- HITL corrections must become auditable flywheel/eval/regression data.
- Sendblue outreach must be capacity-aware, cooldown-aware, opt-out-aware, and
  sticky by candidate/account.

Branch and worktree rules:
1. Start every sprint from updated `main`.
2. Use a dedicated branch named `codex/v2-S<N>-<slug>`.
3. Use a dedicated worktree at `.claude/worktrees/v2-S<N>-<slug>`.
4. Do not start a new sprint from a previous sprint branch.
5. Before starting a sprint:
   - `git fetch origin`
   - `git checkout main`
   - `git pull --ff-only origin main`
   - `git worktree add .claude/worktrees/v2-S<N>-<slug> -b codex/v2-S<N>-<slug> main`
   - `cd .claude/worktrees/v2-S<N>-<slug>`

Autonomous loop:
SYNC MAIN -> CREATE WORKTREE -> READ -> SELECT -> CONTEXT -> PLAN -> ASK
EXECUTOR PLANS -> INTEGRATE -> EXECUTE -> VERIFY -> SUMMARIZE -> LAND -> ADVANCE

Required sprint process:
1. Select the next unblocked sprint from
   .planning/MILESTONE-v2.0-candidate-retention-marketplace.md.
2. Create or update `.planning/v2.0/sprints/S<N>-<slug>/`.
3. Write or update:
   - CONTEXT.md
   - PLAN.md
   - EXECUTOR-PLANS.md
   - ACCEPTANCE.md
   - SUMMARY.md
4. Before implementation, ask each executor for `AGENT_PLAN` only. Do not allow
   code changes until the lead integrates the executor plans.
5. Assign executors by disjoint write scope. If two executors need the same
   file, pick one owner and sequence the other behind the owner's interface.
6. Execute in waves:
   - Wave A: schemas, reducers, fixtures, failing tests
   - Wave B: services/APIs
   - Wave C: UI surfaces and operator debug state
   - Wave D: eval, simulation, HITL, dry-run/live-smoke harness
   - Wave E: integration cleanup, docs, acceptance
7. Run the sprint acceptance harness and record exact outputs.
8. Preserve v1.9 regression:
   - pa-orchestrator tests
   - apps/functions tests
   - candidate domain curl checks
   - admin-to-candidate redirect check
   - paPublicCvIngest validation shape
9. At the end of each sprint, write SUMMARY.md with:
   - files changed
   - tests/evals/harnesses run
   - exact pass/fail results
   - artifacts
   - product decisions
   - remaining blockers
   - next sprint trigger

Executor plan format:
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

Ask Adam only for:
- unsettled product behavior not answered by README/CLAUDE/AGENTS/roadmap
- employer-visible scope expansion
- destructive migration or data deletion
- live outbound beyond approved policy
- paid eval/live run budget
- privacy/legal scope expansion
- any change that would re-litigate v1.6 locked decisions

Do not ask Adam for:
- implementation details that follow existing repo patterns
- test fixture names
- internal schema helper names that do not alter product semantics
- whether to run the required acceptance checks

Start now with S0 if it is not complete. If S0 is complete, start S1 from
updated `main`.
```

