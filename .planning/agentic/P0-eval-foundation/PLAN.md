# P0 — Two-layer eval foundation · PLAN

## Goal (from V3-AGENTIC-GOAL-PROMPT.md P0)

Extend `apps/eval/conversation-experience` into a two-layer eval; author fixtures; run BOTH against current code and record the baseline receipt; wire process-intact into `firebase.json` predeploy as a blocking gate (advisory LLM grader stays non-blocking).

## Design

### Layer 1 — process-intact (deterministic gate)
New `process-intact-runner.mjs` drives the REAL production reducers (never a re-implementation), dispatched by fixture `kind`:

- **prescreen_fsm** → real `PreScreenPipeline.runTurn` + `InMemoryPreScreenStore`, stub `judgeScored` supplies deterministic scores. Asserts: all questions asked, no-skip (advance adjacency in `qOrder`), terminal value, terminal-once + post-terminal idempotent.
- **onboarding_slots** → real `SHARED_ONBOARDING_QUESTIONS` + `resolveNextSharedOnboardingQuestionId` + `projectSharedOnboardingAnswer`. Asserts canonical 5-slot order, no-skip, completion, durable projection.
- **trigger** → extract the production `PRESCREEN_RE` literal from source (no firebase import), assert parse + routing.
- **candidate_job_idempotency** → real `applyCandidateJobEvent` over a faithful in-memory Firestore double (mirror of pa-persistence's own test double). Assert terminal-commit-once + dedup (illegal restart rejected).

Shared helpers in `harness-lib.mjs`. Exit code is the gate.

### Layer 2 — conversation-quality (real-LLM, advisory)
- New `bfcl-runner.mjs` → real `@openai/agents` loop + real `connectorRegistry` tool surface + recorder `execute`. Scores tool-choice (AST `{name}`), abstention (no-call when correct), delivery (tapback/text/no-reply). Exits 0 always; prints a scorecard.
- Keep `llm-runner.mjs` (real extraction / answer-capture + advisory grader).

### Gate wiring
Add `process-intact-runner.mjs` + `runner.mjs` to `firebase.json` functions predeploy, after the workspace dist build and before predeploy-smoke. Advisory runners stay out of predeploy.

## Waves
- **A (schemas/fixtures/failing-tests):** author `process-fixtures/*` + `bfcl-fixtures/*`; `harness-lib.mjs`.
- **B (drivers):** `process-intact-runner.mjs` (4 drivers) + `bfcl-runner.mjs`.
- **D (eval/harness):** run both layers vs current code; freeze baseline; wire predeploy.
- **E (cleanup/docs/acceptance):** README two-layer section; planning docs; SELF-REVIEW; PR.

(No B-connectors / C-interaction code waves — P0 adds NO product behavior, only eval scaffolding. Nothing is deleted in P0.)

## Out of scope (P0)
- Any deletion of voice/ or regex routers (that is P1+ and is GATED by this baseline).
- Driving the real `onPaInbound` handler end-to-end (needs firebase/openai/mem0/sendblue mocks — explicitly out per the seed README).
