# P0 — Two-layer eval foundation · CONTEXT

**Branch / worktree:** `claude/agentic-P0-eval-foundation` @ `.claude/worktrees/agentic-P0-eval-foundation`, off `origin/main` (`883d7d45`).
**Seed:** PR #245 (extractor scalar→array coercion + real-LLM harness) — already merged to `main`, so the harness foundation (`apps/eval/conversation-experience/{runner,llm-runner}.mjs` + fixtures) and the planning docs are present on `main`. No rebase needed.

## Why this phase

Per `.planning/AGENTIC-ARCHITECTURE.md`, the rebuild moves CONVERSATION behavior into model+prompt+tools and keeps only load-bearing deterministic code (process integrity, state commit, safety, idempotency). The lesson from PRs #237/#238/#239/#242 — "passed eval, shipped regression" — is that eval scored what Claire *said*, not what she *did*. Before deleting any hand-written layer we need an eval that:

1. **Grades the database, not the words** (process-intact, deterministic) — the HARD gate that protects process integrity across every later phase.
2. **Measures the model's routing/abstention** with a real LLM (BFCL-style) — the advisory receipt that justifies deleting the regex routers once it proves the model is the better abstention detector.

P0 builds both layers, runs them against CURRENT code, and freezes a **baseline receipt** that is the contract for P1..P8.

## Architecture locks honored (subset most relevant to P0)

- **#0 KEYSTONE** — eval is split exactly along the Conversation/Process seam: process-intact (deterministic, WHAT) is the gate; conversation-quality (LLM, HOW) is advisory.
- **#10 Eval-first** — two-layer eval gates every phase; process-intact = blocking (exit code, wired to predeploy), conversation-quality = advisory (non-deterministic, flags follow-ups, never blocks CI).
- **Do not delete a hand-written layer until a real-LLM eval proves the model+prompt self-does it** — P0 records the baseline that makes those deletions evidence-backed.

## Inputs read

- `.planning/AGENTIC-ARCHITECTURE.md` (locked design) · `.planning/V3-AGENTIC-GOAL-PROMPT.md` (the /goal)
- `apps/eval/conversation-experience/{runner,llm-runner}.mjs` + README (the #245 seed)
- process rails: `packages/pa-orchestrator/src/prescreen/*`, `shared-onboarding.ts`; `packages/pa-persistence/src/marketplace.ts`; `apps/functions/src/sendblue/triggers/prescreen.ts`
- agent core: `packages/agent-runtime/src/openai-agents-adapter.ts`, `packages/pa-connectors/src/index.ts`, `buildTurnTools` in `packages/pa-orchestrator/src/index.ts`
