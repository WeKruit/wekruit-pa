# apps/eval/thin-claire — thin Claire eval contract

## Design-spec regression contract (this dir, now)

`poc-v1-core.mjs`, `poc-v2-delivery.mjs`, `poc-v3-full.mjs` are copied verbatim from
`.planning/thin-claire/poc/`. They are the **proven runnable spec** — real
`gpt-5.4-nano`, in-process side-effect asserts, zero deploy. The production build must
not regress them.

```bash
source ~/.zshrc && nvm use 24
node apps/eval/thin-claire/run-evals.mjs     # v1 + v2(4/4) + v3(7/7, best-of-3)
```

The runner symlinks `node_modules → ../../../packages/agent-runtime/node_modules`
(where `@openai/agents` + `zod` live) and reads `PA_OPENAI_AGENT_API_KEY` from repo-root
`.env`. A worktree must have a `.env` (symlink the main repo's) or export the key.

### Known real-model flake (the harden targets)

`poc-v3` has two assertions that flake at the margins with the real model:
1. **C prescreen "all Qs scored"** — the model occasionally ends its turn after one
   question instead of advancing. (In production each candidate reply is a separate
   inbound turn, so the model only handles ONE question per turn — far more reliable.)
2. **A delivery "bare 'sure' → tapback"** — the model occasionally texts a low-info ack.

The reducer GUARANTEES integrity regardless (no-skip, commit-once); the flake is only
"did the model progress this turn," recoverable next turn. The production L3 eval (the
real-backend mirror, Wave A/B) hardens both via prompt scaffolding + mode directives so
it can gate strictly with `pass^k`.

## Production L3 mirror (Wave A/B — TODO)

The poc-v3 contract gets a production mirror here that swaps the in-memory stubs for
real backend wiring (`applyPartialUserTags`, `queryMatchingJobsV16`, `FirestoreSession`
over an emulator/stub, the prescreen config + judge), asserting the SAME environment
end-state. That mirror is the load-bearing CI gate (L3). See
`.planning/thin-claire/THIN-CLAIRE-SWARM-GOAL.md` → EVAL STACK.
