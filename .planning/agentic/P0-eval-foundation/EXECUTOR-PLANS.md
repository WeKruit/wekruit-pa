# P0 — EXECUTOR-PLANS

P0 is eval scaffolding concentrated in one directory (`apps/eval/conversation-experience/`) with strong sequential dependencies (map → build → run → freeze). The lead executed the build directly to keep cross-file coherence, and parallelized the **read-only investigation** (the part that genuinely splits by disjoint read scope and protects the lead's context against the ~7k-line `index.ts`). No two writers touched the same file.

## AGENT_PLAN — Executor I1 (process-rail mapper) · read-only
- Objective: map prescreen FSM + terminal idempotency + triggers + dedup + onboarding slots to file:line + Firestore/field shapes.
- Exclusive write scope: none (investigation).
- Output consumed by: `process-intact-runner.mjs` driver design + `prescreen`/`onboarding`/`trigger` fixtures.
- Result: delivered the exact reducers (`prescreen/{config,transitions,pipeline,state}.ts`, `shared-onboarding.ts`, `marketplace.ts:applyCandidateJobEvent`, `triggers/prescreen.ts:PRESCREEN_RE`).

## AGENT_PLAN — Executor I2 (agent-core + connectors mapper) · read-only
- Objective: how to call the real `@openai/agents` loop + connector registry from a standalone script and capture tool `{name,args}`.
- Result: model `gpt-5.4-nano`, key `PA_OPENAI_AGENT_API_KEY||OPENAI_API_KEY`, `buildSdkTools` template, recorder-`execute` recipe → `bfcl-runner.mjs`.

## AGENT_PLAN — Executor I3 (voice/router LOC baseline) · read-only
- Objective: real `wc -l` baseline of delete-targets vs keeps.
- Result: `voice/` = **9,586 LOC** (matches the doc), delete-targets enumerated, `output-normalizer.ts` (420) = KEEP. Frozen in SUMMARY for the collapse tracker.

## AGENT_PLAN — Executor I4 (idempotency-driver recipe) · read-only
- Objective: runnable recipe for driving `applyCandidateJobEvent` (firestore double, event path, idempotency flags, dedup signal).
- Result: faithful in-memory double + `candidate_matched→prescreen_started→prescreen_review_pending→prescreen_passed` path + `idempotent`/`changed` flags → `candidate_job_idempotency` driver.

## Lead (build waves A/B/D/E)
- Exclusive write scope: `apps/eval/conversation-experience/**` (new: `harness-lib.mjs`, `process-intact-runner.mjs`, `bfcl-runner.mjs`, `process-fixtures/*`, `bfcl-fixtures/*`; README append), `firebase.json` (2 predeploy lines), `.planning/agentic/P0-eval-foundation/**`.
- No product source (`packages/**`, `apps/functions/**`) modified — P0 adds zero behavior.
