# P4 — Onboarding migration · CONTEXT

**Branch/worktree:** `claude/agentic-P4-onboarding` @ `.claude/worktrees/agentic-P4-onboarding`. Base: P0 tip `02c3e826` (eval foundation; orthogonal to P1/P2/P3). Retarget to main once P0 merges.

## Goal (V3-AGENTIC-GOAL-PROMPT.md P4)
"Onboarding migration. Same pattern as P3 for shared-onboarding slots." → a SCOPED onboarding agent: LLM asks each slot naturally + extracts; the deterministic reducer iterates `SHARED_ONBOARDING_QUESTIONS` (5 slots) + advances via `resolveNextSharedOnboardingQuestionId` + projects durable tags via `projectSharedOnboardingAnswer`. LLM cannot skip a slot or complete. Cross-process tangent bridging. Flag-gated (`paAgenticOnboardingEnabled`, default OFF, fail-open).

## Architecture locks
- #0 KEYSTONE: LLM owns HOW (natural ask + extract); reducer owns WHAT (slot order + projection + completion).
- #1 mode-scoping: read `sharedOnboarding.currentQuestionId`/`workSession.kind` → scope write-tools (record_onboarding_answer) ; read/answer tools global.

## Already in place (P0 + research)
- Pure reducer: `SHARED_ONBOARDING_QUESTIONS` (main_goal→culture_stage→industry_interest→location_relocation→special_context), `resolveNextSharedOnboardingQuestionId`, `projectSharedOnboardingAnswer` (→ memoryFact + tags + statedPreferences). Write path: `writeSharedOnboardingAnswer` (index.ts:3056 → applyPartialUserTags + sets sharedOnboarding.currentQuestionId).
- **P0 process-intact fixture 03 already asserts slot-order no-skip + durable projection** (deterministic gate GREEN).

## P4 deliverables
1. Process-intact slot-order no-skip — ALREADY GREEN (P0 fixture 03).
2. Real-LLM scoped-onboarding canary (`agent-onboarding-canary.mjs`): answer→record (reducer advances slot + projects tags); tangent→explain (slot held). [THIS COMMIT]
3. Live injection: flag-gated scoped onboarding agent into the shared-onboarding reply handler (mirror P3's prescreen injection) behind `paAgenticOnboardingEnabled` default-OFF, fail-open; reducer stays controller (slot advance + projection OUTSIDE the toolset). [next, research the handler seam: handleSharedOnboardingUserReply / writeSharedOnboardingAnswer dispatch]
4. Regression + PR.

## Approach: identical to P3 (gate green → flag-gated injection default-OFF → stage regex/template deletions behind ramp).
