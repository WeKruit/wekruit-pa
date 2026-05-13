# Autonomous Sprint Harness for v2.0

**Status:** Planning contract, 2026-05-13.
**Applies to:** WeKruit v2.0 candidate retention marketplace work.
**Canonical product memory:** `README.md` -> "Product Blueprint: Candidate Retention Marketplace".
**Roadmap:** `.planning/MILESTONE-v2.0-candidate-retention-marketplace.md`.

This document defines how a single-point lead agent should turn the v2.0 roadmap
into autonomous, executable sprints that can be driven by a `/goal`-style command.

The point is not to generate a long prompt. The point is to make the work
self-contained, observable, restartable, and safe enough that a lead agent can
run a team without repeatedly asking Adam for implementation details that are
already locked.

## 1. Harness Principles

1. Plan before implementation. The lead must produce or update the sprint
   `PLAN.md` before touching product code.
2. Ask executors for plans before asking them for code. Every executor must
   return an `AGENT_PLAN` first.
3. The lead owns integration. Executors own disjoint write scopes.
4. Every sprint is vertical: product outcome, UIUX, backend, data lifecycle,
   eval, HITL, safety, and verification must all be covered.
5. Every sprint must be restartable from files in the repo. No hidden thread
   context is required.
6. Every sprint must produce observable behavior, not just code that compiles.
7. Evals and tests are not postscript. They are part of the sprint objective.
8. Dry-run first for harnesses that spend money, contact candidates, call live
   services, mutate production data, or send outbound messages.
9. Human approval is required only for grey-area product decisions, budgeted
   live runs, externally visible outreach, destructive migrations, or changes
   that violate a locked invariant.
10. If a sprint cannot pass its acceptance harness, the lead writes the exact
    blocker and next verification step before stopping.

## 2. Research Basis

The harness is based on local WeKruit precedent plus official agent/eval
guidance:

- Codex works best with explicit goal, context, constraints, and "done when"
  criteria. Large repo prompts should name files and verification.
- Codex execution plans should be self-contained living documents with progress,
  decision log, discoveries, outcomes, exact commands, and observable acceptance.
- Codex subagent workflows should be explicitly requested and should specify how
  to divide work, whether to wait, and what summary/output to return.
- Agent workflows should start with traces while debugging behavior, then move
  to datasets/eval runs once "good" is defined.
- Trace grading is useful because it evaluates the end-to-end workflow, including
  model calls, tool calls, guardrails, handoffs, and failure modes.
- Evals should be task-specific, run early and often, log everything, automate
  when possible, and maintain agreement with human feedback.
- Guardrails must be placed at workflow/tool boundaries. Deterministic reducers
  should own state transitions; LLMs may extract, judge, and compose.
- Existing WeKruit harness precedent favors opt-in evals, dry-run cost
  projection, hard budget caps, no accidental live network spend in tests, and
  summary artifacts with exact commands.

## 3. Directory Layout

Every sprint must branch from current `main` and run in an isolated worktree.
Do not keep extending a previous sprint branch unless the sprint is explicitly a
resume of that same branch.

Required branch/worktree setup:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git worktree add .claude/worktrees/v2-S<N>-<slug> -b codex/v2-S<N>-<slug> main
cd .claude/worktrees/v2-S<N>-<slug>
```

Rules:

- Branch name format: `codex/v2-S<N>-<slug>`.
- Worktree path format: `.claude/worktrees/v2-S<N>-<slug>`.
- `main` is the integration base and source of truth.
- A sprint branch may merge to `main` only after its acceptance harness is green
  or the lead records an explicit blocker and Adam approves partial landing.
- Do not start S<N+1> from S<N>'s branch. Start S<N+1> from updated `main`.

Every v2.0 sprint should get its own directory:

```text
.planning/v2.0/sprints/SN-short-slug/
  CONTEXT.md
  PLAN.md
  EXECUTOR-PLANS.md
  ACCEPTANCE.md
  SUMMARY.md
  artifacts/
```

File responsibilities:

| File | Required role |
|---|---|
| `CONTEXT.md` | Current repo state, product decisions, relevant files, upstream/downstream dependencies. |
| `PLAN.md` | Self-contained executable sprint plan. Must be updated as work proceeds. |
| `EXECUTOR-PLANS.md` | One `AGENT_PLAN` per executor before implementation starts. |
| `ACCEPTANCE.md` | Commands, evals, live smoke steps, expected outputs, and pass/fail ledger. |
| `SUMMARY.md` | Final outcome, files changed, tests/evals run, known gaps, next sprint trigger. |
| `artifacts/` | Screenshots, curl output, eval JSON, dry-run plans, logs, trace ids, exported reports. |

The milestone roadmap is strategic. The sprint directory is operational.

## 4. Sprint Lifecycle

### Phase 0: Select Sprint

The lead reads:

1. `README.md`
2. `CLAUDE.md`
3. `AGENTS.md`
4. `.planning/MILESTONE-v2.0-candidate-retention-marketplace.md`
5. `.planning/AUTONOMOUS-SPRINT-HARNESS.md`
6. The previous sprint `SUMMARY.md`, if one exists

Then the lead chooses the next unblocked sprint from the roadmap and writes
`CONTEXT.md`.

The lead must not start from a stale branch assumption. It must record:

- current branch/worktree
- dirty files and whether they are in-scope
- last known green checks
- deployed/live state if relevant
- exact product invariant being advanced

### Phase 1: Draft Sprint Plan

The lead writes `PLAN.md` before code changes. It must include:

1. Purpose / Big Picture
2. Observable user outcome
3. Current repo orientation
4. Locked invariants and non-goals
5. Data model and ownership
6. UI surface map
7. Backend/API/service map
8. Executor topology and disjoint write scopes
9. Agent plan handshake
10. Milestones
11. Concrete steps
12. Verification harness
13. HITL and flywheel events
14. Safety and privacy checks
15. Idempotence and recovery
16. Progress
17. Decision Log
18. Surprises and Discoveries
19. Outcomes and Retrospective

If a section cannot be filled, the lead must write the blocker and either resolve
it from code/docs or ask Adam a specific product question.

### Phase 2: Ask Executors For Plans

Before implementation, the lead asks each executor for an `AGENT_PLAN`.

The executor prompt must say:

```text
You are not alone in the codebase. Other executors may work in parallel.
Do not revert unrelated changes. Do not edit outside your assigned write scope.
Return AGENT_PLAN only. Do not implement yet.
```

Each `AGENT_PLAN` must use this exact shape:

```text
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

The lead appends all executor plans to `EXECUTOR-PLANS.md`.

### Phase 3: Integrate Plans

The lead reviews all `AGENT_PLAN` outputs and writes an integration note in
`PLAN.md`.

The note must answer:

1. Are file write scopes disjoint?
2. Are shared files sequenced behind one owner?
3. Are data contracts consistent?
4. Does every backend primitive have UI visibility or operator debug state?
5. Does every LLM behavior have eval or trace coverage?
6. Does every HITL edit produce a correction/flywheel event?
7. Does any executor plan violate product invariants?
8. What is the execution wave order?

Only after this integration note exists can implementation start.

### Phase 4: Execute In Waves

Execution should use waves:

- Wave A: schemas, reducers, fixtures, and failing tests
- Wave B: service/API implementation
- Wave C: UI surfaces and operator debug state
- Wave D: eval, simulation, HITL, and live-smoke harness
- Wave E: integration cleanup, docs, and acceptance

Parallel work is allowed only when write scopes are disjoint. If two executors
need the same file, the lead assigns one owner and forces the other executor to
consume the resulting interface.

### Phase 5: Verify

Each sprint must run the narrowest sufficient verification harness plus the
standing v1.9 regression checks.

Minimum layers:

1. Type/schema tests for new data contracts.
2. Reducer/state-machine tests for transitions.
3. Service tests for API behavior.
4. UI smoke or screenshot checks for new surfaces.
5. Eval or simulation for LLM-driven behavior.
6. Dry-run for any outbound, batch, or costed workflow.
7. Live smoke only when the sprint changes a live user journey and the action is
   approved.
8. Existing v1.9 journey regression remains green.

For v2.0, acceptance cannot be "tests pass" alone. It must show the marketplace
loop improved or stayed intact.

### Phase 6: Summarize And Advance

At the end, the lead writes `SUMMARY.md`:

- sprint outcome
- files changed
- commands run and exact pass/fail result
- eval/harness artifacts created
- product decisions made
- unresolved gaps
- next sprint trigger

The lead updates:

- sprint `PLAN.md` progress
- milestone roadmap if scope or ordering changed
- `README.md` only if canonical product memory changed
- `CLAUDE.md` / `AGENTS.md` only if operating rules changed

## 5. `/goal` Compatibility Contract

A `/goal` command should be able to hand this repo to a lead agent with one
objective. The lead agent must have enough structure here to run autonomously.

The lead must follow this loop:

```text
SYNC MAIN -> CREATE WORKTREE -> READ -> SELECT -> CONTEXT -> PLAN -> ASK EXECUTOR PLANS -> INTEGRATE -> EXECUTE -> VERIFY -> SUMMARIZE -> LAND -> ADVANCE
```

The lead must not:

- start coding before `PLAN.md` exists
- spawn implementation executors before `EXECUTOR-PLANS.md` has their plans
- allow two executors to write the same file without sequencing
- use match score to block the first interview
- move candidate flow back to admin domain
- make candidate durable data job-specific
- expose non-passed candidates to employers
- branch a new sprint from a previous sprint worktree
- send live outbound without explicit approval or existing approved policy
- run live costed evals without dry-run projection and budget cap

The lead may decide autonomously:

- internal implementation details that follow existing repo patterns
- test fixture structure
- schema names when they do not conflict with existing collections
- executor wave sequencing
- whether a sprint needs one executor or multiple
- whether a grey area is small enough to record as an assumption

The lead must ask Adam:

- product behavior not settled by README/CLAUDE/AGENTS/roadmap
- employer-visible scope expansion
- destructive migration or data deletion
- external outreach beyond approved dry-run
- paid eval/live run budget
- privacy or legal scope expansion
- any decision that would re-litigate v1.6 locked decisions

## 6. Sprint Plan Template

Every sprint `PLAN.md` should use this template.

```text
# S<N> - <Sprint Name>

This is an autonomous sprint plan for WeKruit v2.0. It follows
`.planning/AUTONOMOUS-SPRINT-HARNESS.md` and must be kept current while work
proceeds.

## Purpose / Big Picture

Explain what someone can do after this sprint that they cannot do now.

## Observable Outcome

Describe the concrete UI, API, eval, or workflow evidence that proves the sprint
worked.

## Current Repo Orientation

List the relevant files and modules. Explain how they fit together.

## Locked Invariants And Non-Goals

State product rules that cannot be violated and scope that is intentionally not
being built.

## Data Model And Ownership

Define new or changed collections, fields, types, lifecycle, owner, audit trail,
and retention assumptions.

## UI Surface Map

Define candidate UI, employer/admin UI, operator debug state, empty/error/loading
states, and mobile requirements.

## Backend/API/Service Map

Define functions, services, queues, scheduled jobs, reducers, and integration
points.

## Executor Topology

List executors, responsibilities, exclusive write scopes, shared read scopes,
and execution waves.

## Agent Plan Handshake

Record each `AGENT_PLAN` request and response.

## Milestones

Describe independently verifiable milestones in narrative form.

## Concrete Steps

State exact edits and exact commands. Use repo-relative paths.

## Verification Harness

List unit tests, integration tests, evals, simulations, dry-runs, UI checks,
curl checks, and live smoke checks with expected outputs.

## HITL And Flywheel

Define where human corrections happen, what event they write, and how those
events feed evals, ranking, tagging, or future recommendations.

## Safety And Privacy

Define PII handling, opt-out/cooldown rules, authorization checks, logging
redaction, and stop conditions.

## Idempotence And Recovery

Explain how to retry safely, what can be re-run, and what rollback means.

## Progress

- [ ] Timestamped progress entry.

## Decision Log

- Decision:
  Rationale:
  Date/Author:

## Surprises And Discoveries

- Observation:
  Evidence:

## Outcomes And Retrospective

Summarize outcome, gaps, and next sprint trigger.
```

## 7. Acceptance Harness Template

Every sprint `ACCEPTANCE.md` should define a pass/fail ledger:

```text
# S<N> Acceptance

## Required Checks

| Check | Command or action | Expected result | Actual result | Status |
|---|---|---|---|---|
| Unit tests | <command> | <expected pass count> | | |
| Integration tests | <command> | <expected pass count> | | |
| Eval dry-run | <command> | no network spend, valid plan | | |
| UI smoke | <command/browser steps> | page renders target state | | |
| Live curl | <curl> | exact status/body | | |
| v1.9 regression | <commands> | no regression | | |

## Hard Fail Conditions

- Candidate route appears on admin domain.
- First interview is blocked by match score.
- Employer sees a not-passed candidate.
- Raw PII is used as public document id.
- Live outbound is sent without approved policy.
- Costed eval/live run starts without dry-run and budget cap.
- State transition is controlled only by LLM free text with no deterministic reducer.

## Evidence

Paste short transcripts, artifact paths, trace ids, screenshots, or eval run ids.
```

## 8. Executor Prompt Template

The lead should use this shape when asking for executor plans:

```text
You are Executor <name> for WeKruit v2.0 sprint <S<N>>.

Read:
- README.md
- CLAUDE.md
- AGENTS.md
- .planning/MILESTONE-v2.0-candidate-retention-marketplace.md
- .planning/AUTONOMOUS-SPRINT-HARNESS.md
- .planning/v2.0/sprints/S<N>-<slug>/CONTEXT.md
- .planning/v2.0/sprints/S<N>-<slug>/PLAN.md

Your responsibility:
<one bounded responsibility>

Exclusive write scope:
<paths>

Shared files you may read but not edit:
<paths>

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

The lead approves, edits, or rejects executor plans before implementation.

## 9. Harness Scorecard

The lead should score each sprint before marking it complete.

| Category | Points | Requirement |
|---|---:|---|
| Product invariant preserved | 20 | No locked rule violated. |
| Observable user outcome | 15 | Candidate, employer, or operator can see the new behavior. |
| Backend source of truth | 15 | Data lifecycle, reducer, ownership, and audit trail are explicit. |
| UIUX completeness | 10 | Loading, empty, error, mobile, and debug states are covered where relevant. |
| Eval/regression | 15 | Deterministic tests plus LLM eval/simulation where applicable. |
| HITL/flywheel | 10 | Corrections/outcomes feed future data. |
| Safety/privacy/reliability | 10 | PII, opt-out, budget, idempotence, and recovery are handled. |
| Evidence quality | 5 | Summary has commands, outputs, artifacts, and next step. |

Minimum completion score: 85/100.

Hard fail overrides score:

- privacy leak
- unauthorized live outreach
- candidate domain regression
- employer sees non-passed candidate
- first interview blocked by match score
- eval/cost spend without dry-run and cap

## 10. Mapping To v2.0 Sprints

Every roadmap sprint must be converted into a sprint directory before execution:

| Roadmap sprint | Required first artifact |
|---|---|
| S0 Baseline Integration | `.planning/v2.0/sprints/S0-baseline-integration/PLAN.md` |
| S1 Marketplace Data Foundation | `.planning/v2.0/sprints/S1-marketplace-data-foundation/PLAN.md` |
| S2 Identity + Candidate Claim | `.planning/v2.0/sprints/S2-identity-candidate-claim/PLAN.md` |
| S3 Bulk Resume Intake | `.planning/v2.0/sprints/S3-bulk-resume-intake/PLAN.md` |
| S4 Job Enrichment | `.planning/v2.0/sprints/S4-job-enrichment/PLAN.md` |
| S5 Two-Way Matching | `.planning/v2.0/sprints/S5-two-way-matching/PLAN.md` |
| S6 Outreach Platform | `.planning/v2.0/sprints/S6-outreach-platform/PLAN.md` |
| S7 First Interview + Passed Surface | `.planning/v2.0/sprints/S7-first-interview-passed-surface/PLAN.md` |
| S8 Flywheel + HITL + Eval | `.planning/v2.0/sprints/S8-flywheel-hitl-eval/PLAN.md` |
| S9 Production Hardening + Scale | `.planning/v2.0/sprints/S9-production-hardening-scale/PLAN.md` |

## 11. First Autonomous Sprint Setup

The first autonomous sprint should be S0 because it makes the rest safe.

S0 lead sequence:

1. Create `.planning/v2.0/sprints/S0-baseline-integration/`.
2. Write `CONTEXT.md` with current branch, dirty state, v1.9 sanity checks, and
   deploy/domain state.
3. Write `PLAN.md` from the template above.
4. Ask executor plans for:
   - Repo State executor
   - Test Harness executor
   - Domain/Deploy State executor
   - Roadmap Consistency executor
5. Integrate executor plans into `EXECUTOR-PLANS.md`.
6. Run only read-only or docs/test-safe work until the plan is coherent.
7. Run acceptance checks and write `SUMMARY.md`.

S0 is done when a future `/goal` agent can start S1 from files alone without
asking what branch, tests, domains, or product invariants are current.
