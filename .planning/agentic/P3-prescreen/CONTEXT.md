# P3 — Prescreen migration · CONTEXT

**Branch/worktree:** `claude/agentic-P3-prescreen` @ `.claude/worktrees/agentic-P3-prescreen`. Base: P0 tip `02c3e826` (carries the two-layer eval; orthogonal to P1/P2). Retarget to main once P0 merges.

## Goal (V3-AGENTIC-GOAL-PROMPT.md P3)
- **Scoped prescreen agent:** write-tools scoped (`record_answer`/`advance_fsm`); read-context + answer tools GLOBAL every turn (cross-process context bridging).
- **Reducer-FSM iterates the playbook question set deterministically** (the LLM asks each question naturally + extracts the answer; the reducer decides "next pending question" + ends only when all required answered — LLM cannot declare "done").
- **Cross-process context bridging + durable pending-step re-surface.** Terminal idempotency (PASS/FAIL once).
- **Eval gate:** process-intact (all questions asked, no skip, PASS/FAIL once) — ALREADY GREEN via P0 fixtures 01/02/05 — + a NEW tangent fixture (mid-prescreen unrelated question answered, then resumes).

## Architecture locks (P3-relevant)
- #0 KEYSTONE: the LLM owns HOW (ask each question naturally, extract, handle follow-ups); the reducer owns WHAT (question set + order + rubric + terminal). LLM CANNOT declare the interview done.
- #1 mode-scoping (NOT handoffs): a deterministic reducer reads `workSession.kind === "job_prescreen"` → scoped write-tools + scoped prompt + pending step; read-context + answer/recall tools stay GLOBAL.
- #5 §6: max-flexible interrupt + always resumable; only guard = terminal idempotency. Context bridges via global read context + durable pending-step re-surface.

## What already exists (P0 + prior)
- PreScreenPipeline FSM (`prescreen/{pipeline,transitions,state}.ts`): `runTurn` drives 4 gates, `findNextUnansweredQId` (no-skip), terminal via `evalFinal`/`setTerminal`. KEPT (the reducer rail).
- Terminal idempotency: `applyCandidateJobEvent` + `pa-audit-events` guard — P0 fixture 05 asserts commit-once + dedup.
- P0 process-intact fixtures 01 (full-question-set, PASS once) + 02 (hard-stop no-skip) already gate the FSM.

## Net-new (to confirm via the background research agent afd5f86e)
1. The mode-selector seam (read `workSession.kind` → scope the agent's write-tools/prompt). 
2. The scoped prescreen agent tools: `record_answer`/`advance_fsm` (write, scoped) + global answer tools (`explain_prescreen_outcome`).
3. Move question-ASKING from deterministic prompt → LLM (natural ask + extract); reducer still iterates + terminates.
4. The cross-process tangent handling + pending-step re-surface.
5. Eval: add a tangent fixture (mid-prescreen unrelated Q → answered via global tool → resumes pending Q).

## Approach (P1/P2 pattern): flag-gate the scoped-agent prescreen path (e.g. `paAgenticPrescreenEnabled`, default OFF) so the existing deterministic prescreen stays the default until the eval (process-intact + tangent + a real-LLM ask/extract canary) proves the agent self-does it; then ramp + stage the deletion of any deterministic asking layer the eval proves redundant.

## Status
Worktree + build initiated; research dispatched (background). Implementation next cycle off the research map.
