# P1 — Vertical slice: job-search through agent-core · CONTEXT

**Branch / worktree:** `claude/agentic-P1-jobsearch-slice` @ `.claude/worktrees/agentic-P1-jobsearch-slice`.

**Base decision (deviation, documented):** Branched off the **P0 tip** (`claude/agentic-P0-eval-foundation`, PR #251), NOT bare `origin/main`. Reason: P1's eval gate ("P0 suite green") requires P0's `process-intact-runner.mjs` + fixtures + predeploy wiring, which are not yet merged to `main`. This follows the precedent the goal set for the #245 seed ("if not merged, carry the dependency forward rather than wait"). When P0 merges, P1 rebases onto `main`. This is a stacked PR, not branch reuse.

## Goal (from V3-AGENTIC-GOAL-PROMPT.md P1)

- Let `run(agent)` drive job-search via the `find-match` connector.
- DELETE the job_search branch of `decideConversationTurnOwner` + `handleCompletedUserJobSearchRequest` + `FIND_MATCH_NARRATION` templates for this path.
- Rewrite the `find-match` connector `description` as a Hermes-style routing boundary (WHAT + positive trigger verbatim phrases incl. Chinese + "Do NOT call when ...").
- Keep the deterministic commit in `execute` (dedup already-recommended jobs, verdict, `pa-tool-calls` ledger, trace completion).
- **Eval gate:** P0 suite green (no regression vs baseline) + the stale-tag canary passes with a real model.

## Why this is the vertical slice

Per AGENTIC-ARCHITECTURE.md §12, P1 takes ONE flow end-to-end through agent-core to **prove the pattern**, then later phases generalize. Job-search is chosen because it is the flow whose regression (the Adam-bug) motivated the whole rebuild, and its eval canary already exists (#245).

## Architecture locks most relevant to P1

- **#0 KEYSTONE:** routing (which connector) → LLM; the `execute` reducer (dedup + commit + verdict + ledger) stays deterministic. Do NOT move the commit into the model; do NOT leave job-search routing in regex.
- **#1:** single agent, dynamic mode-scoping; find-match is a triage-mode write/action tool.
- **#4:** connector.execute = reducer = state commit + dedup + policy gate + structured verdict.
- **#5:** every dedup/redirect/change narrated to the user ("tell them").
- **#8:** keep the output normalizer; this slice does not yet touch the voice/ stack.

## Known facts (from reading source)

- `find-match` connector (`packages/pa-connectors/src/match-connectors.ts:108`): `execute` delegates the deterministic match to `ctx.hooks.findMatch` (KEEP). `narration: FIND_MATCH_NARRATION` (L82-94) = the templates to delete for this path. `description` (L114-117) = rewrite Hermes-style. `FindMatchInputSchema` has optional fields → the Agents-SDK strict-schema 400 P0 surfaced; P1 must resolve (strict-compatible schema or adapter strict:false) for the live tool call to work.
- P0 baseline (the contract this phase must not regress): process-intact 5/5; BFCL tool-choice 2/3 (EN job-search under-call — P1's description rewrite targets this), abstention 2/2, delivery 2/2; extraction 3/3.

## Open input
Routing/integration map (inbound dispatch, owner switch, handler internals, run(agent) wiring point, eval canary location) — produced by the P1 research agent; consumed by PLAN.md.
