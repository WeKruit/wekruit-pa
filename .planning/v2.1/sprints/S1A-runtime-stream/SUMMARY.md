# S1A Runtime Stream — SUMMARY (P10 transcription)

> Agent harness blocked direct SUMMARY write ("subagents should return findings
> as text, not write report files"). P10 transcribed the agent's final report
> verbatim. Source: completion notification 2026-05-15.

**Branch:** `claude/v21-S1A-runtime-stream` (pushed to origin)
**Commits:**
- `c97de39 feat(agent-runtime): add runAgentTurnStream streaming export (S1A)`
- `4be5e61 docs(v2.1/S1A): plan runAgentTurnStream streaming export`

## Locked signature (S1C / S2 contract)

```ts
// @pa/agent-runtime
export type AgentTurnStreamChunk = {
  delta: string;
  finishReason?: "stop" | "length" | "error";
  usage?: RunAgentTurnUsage;
};

export function runAgentTurnStream(
  ctx: AgentTurnContext
): AsyncGenerator<AgentTurnStreamChunk, void, void>;
```

Flag-off contract: first `.next()` rejects with exactly `Error("PA_AGENT_RUNTIME_STREAM_ENABLED=false")`.

## Source-of-truth correction (apply to MILESTONE)

Brief referenced `packages/pa-orchestrator/src/agent-runtime/`. Actual package: `packages/agent-runtime/` (workspace `@pa/agent-runtime`). `pa-orchestrator` consumes via `import { runAgentTurnStream } from "@pa/agent-runtime"`. Update downstream sprint docs.

## Files touched

- `packages/agent-runtime/src/types.ts` — additive `AgentTurnStreamChunk` type
- `packages/agent-runtime/src/stream.ts` — new `runAgentTurnStream` async generator with `__forTesting` seam
- `packages/agent-runtime/src/openai-stream-provider.ts` — new chat-completions streaming impl
- `packages/agent-runtime/src/index.ts` — two new export lines only
- `packages/agent-runtime/src/stream.test.ts` — 7 unit tests
- `packages/agent-runtime/src/run-golden.test.ts` — 3 golden-snapshot tests proving `runAgentTurn` byte-identical
- `AGENT_PLAN.md` (worktree root)

Zero edits to: `run.ts`, `openai-agents-adapter.ts`, `openai-provider.ts`, `messages.ts`, `firestore-session.ts`, or any existing test. L1 (agent-runtime frozen) held.

## Test summary

- `pnpm --filter @pa/agent-runtime test` — **55/55 green** (10 new)
- `pnpm --filter @pa/pa-orchestrator test` — **1498/1498 green**
- `pnpm --filter @pa/functions test` — **1518/1518 green**
- `runner-prescreen.mjs pass.yaml` — green
- `runner-prescreen.mjs pause.yaml` — green
- `runner-prescreen.mjs fail.yaml` — **pre-existing failure** on S0 base `249dfa4` (clean-stash rerun confirms). Not caused by S1A. Tracked as P10 backlog item.
- `runner-prescreen.mjs hard-stop.yaml` — **pre-existing failure** on S0 base. Same situation. Same backlog item.

## Design notes (provider + flag + cache)

- **Provider**: OpenAI Chat Completions streaming (`stream: true`, `stream_options: { include_usage: true }`). Picked over Agents-SDK Responses streaming so S1C can proxy chunks as canonical OpenAI SSE. Non-stream `runAgentTurn` keeps using the Agents SDK path. No drift.
- **Feature flag** `PA_AGENT_RUNTIME_STREAM_ENABLED` read at call time (not module load) so tests can flip per-case. Default OFF. Voice bridge env must flip `"true"`. iMessage CF env unchanged.
- **Prefix cache bypass**: streaming does not use the prefix-cache-wrapped client (cache wrapper has no streaming path). Voice turns TTFA-bound + cache-miss anyway. Non-stream cache stats preserved.
- **Hosted tools mid-stream**: not supported (mirrors existing SiliconFlow path limitation). Voice prescreen v2.1 does not need them.
- **Per-call client construction**: acceptable for v2.1 voice cadence (1 per `user_speech_committed`). Underlying `openai` SDK has global pool.

## Watch-outs handed to S2

- Flag flip on voice bridge env only.
- Don't buffer chunks pre-TTS — pipe straight through.
- Measure end-to-end TTFA at S2/S4 boundary, not at S1A primitive.

## Hand-off

- S1C: mock against locked signature; consume `AsyncGenerator<AgentTurnStreamChunk>`; forward to LiveKit `openai.LLM` SSE.
- S2: import `runAgentTurnStream` from `@pa/agent-runtime`; flip flag in worker env; pipe through S1C shim.
- P10: log pre-existing `fail.yaml` + `hard-stop.yaml` failures as backlog (done — task #11).
