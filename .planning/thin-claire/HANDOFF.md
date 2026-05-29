# Thin Claire — Handoff (paste into a fresh `/goal`)

## Where to run (explicit)
- Base branch: **`main`** (this handoff + the goal doc + POCs are merged to main via PR #271).
- The `/goal` run starts from updated `main` and creates its OWN fresh worktree per phase at
  `.claude/worktrees/thin-P<N>` on branch `claude/thin-P<N>` — never reuse another phase's worktree,
  never use the `thin-claire-goal` worktree (that only held this plan).
- Node 24: `source ~/.zshrc && nvm use 24` before every test/build.

## The `/goal` prompt (≤4000 char — paste this)

```text
Build thin Claire (OpenAI Agents SDK rebuild). Spawn a swarm.

Read FIRST, obey literally:
- .planning/thin-claire/THIN-CLAIRE-SWARM-GOAL.md  ← full spec: waves, workstreams, delete/keep, eval gates, self-review
- .planning/thin-claire/poc/README.md + poc-v1-core.mjs + poc-v2-delivery.mjs + poc-v3-full.mjs  ← runnable proven spec; copy their design

Goal: replace the ~12k-LOC regex-router + voice-postprocess Claire with a thin
@openai/agents agent (LLM + description-routed tools + Session memory + delivery
reflexes + reducer-owned onboarding/prescreen). ~12k→~1k LOC. The 3 POCs already
pass against real gpt-5.4-nano with zero deploy — they are the executable spec.

KEYSTONE (never violate): LLM only PROPOSES (text, judge score, tool choice);
deterministic REDUCER code DECIDES every state transition (next question, PASS/FAIL,
commit-once, dedup, out-of-order). Reducer=code; the judgement it consumes=LLM in a tool.

Invariants: one canonical store pa-users.tags via applyPartialUserTags (mem0 enrich-only);
"only X"=replace, "avoid Y"=negativeRoleFunction+remove from positive; single agent,
NO handoff (mid-flow interrupt answered, state durable, pending resumes); voice in
prompt+few-shot not post-processors (keep normalizer + 1 voice-drift outputGuardrail);
mark-read+typing reflexes + tapback/no-reply/status tools (no regex arbiter); terminal
idempotency commit-once.

Eval-first, no deploy to test: every workstream ships a poc-style in-process real-model
eval (real gpt-5.4-nano + stub channel/db + assert side-effects + exit 0/1). A layer is
done only when its eval is green AND the 3 POC evals + unit suites don't regress.

Setup each phase: source ~/.zshrc && nvm use 24; from updated main create a fresh worktree
.claude/worktrees/thin-P<N> on branch claude/thin-P<N>; pnpm install && pnpm -r build.

Run the 3 POC evals FIRST to confirm the green baseline:
  cd .planning/thin-claire/poc && ln -sf ../../../packages/agent-runtime/node_modules ./node_modules
  node poc-v1-core.mjs ; node poc-v2-delivery.mjs --eval ; node poc-v3-full.mjs

Then execute the waves in THIN-CLAIRE-SWARM-GOAL.md:
  Wave 0 (you, inline): scaffold apps/functions/src/claire-agent/ + Firestore Session
    (5 methods over pa-messages) + copy poc-v3 eval to apps/eval/thin-claire/ as the contract.
  Wave A (parallel swarm, disjoint write scope): WS-tools (wrap queryMatchingJobsV16 /
    applyPartialUserTags / mem0 / schedule / privacy as tools), WS-delivery (reflexes+tools),
    WS-process (onboarding+prescreen FSM reducers + LLM-judge scoring), WS-guardrail.
  Wave B (you): prompt.ts + agent.ts assembly + onPaInbound/coalescer cutover behind
    paThinClaireEnabled (default OFF). Deployed-handler two-turn canary green.
  Wave C: flag-on 424 canary (+14243201960, allowlist already set), live-verify, then ramp.

Cutover behind paThinClaireEnabled; legacy path stays until thin is green for the canary cohort.
Done = thin passes the live 424 canary (avoid-SWE→drop-SWE, no hang, reads tags) + all eval
gates green + Firestore/transcript proof. Not done from unit tests alone. Run the per-workstream
SELF-REVIEW in the goal doc each phase.

Start: Wave 0 after confirming the 3 POC baselines are green.
```

## Already done (on main)
- #245 extractor scalar→array fix + real-LLM harness; #265 8 QA root-cause fixes; #269 717 negativeRoleFunction chain + real-seam predeploy gate. All merged + deployed (main `6c6cfa50`, onPaInbound+coalescer live).
- 424 canary flags ON for uids `8fEwIduUrzxZsblHHsNz` + `LF8blURXyFBaeF7bhupu`.
- Live receipts: `.planning/LIVE-SMOKE-2026-05-28-RECEIPT.md`, `.planning/LIVE-SMOKE-2026-05-29-CANARY-RECEIPT.md`.

## Still open (what the swarm builds)
Real `claire-agent/` (empty today), production cutover, 424 canary green, legacy retirement,
the 8 ops-readiness gates in `.planning/AGENT-HARNESS-PRODUCTION-GAPS.md`.
