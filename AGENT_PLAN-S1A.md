# S1A — runtime stream — AGENT_PLAN

Worktree: `.claude/worktrees/v21-S1A-runtime-stream`
Branch: `claude/v21-S1A-runtime-stream`
Owner: P8 sub-agent (this thread)
Parent: P10 v2.1 voice prescreen sprint

## Source-of-truth corrections to P10 brief

1. The P10 brief points at `packages/pa-orchestrator/src/agent-runtime/`. That
   directory does NOT exist. The real `agent-runtime` package lives at
   `packages/agent-runtime/` (workspace name `@pa/agent-runtime`). All new
   code + tests will go there. `pa-orchestrator` imports `runAgentTurn` via
   `import { ... } from "@pa/agent-runtime"`, so the export surface to extend
   is `packages/agent-runtime/src/index.ts`.
2. The brief regression command `pnpm --filter pa-orchestrator test` resolves
   to `pnpm --filter @pa/pa-orchestrator test`. I will also run
   `pnpm --filter @pa/agent-runtime test` (the package my code lives in)
   before commit so the new unit tests gate.
3. The brief mentions `pnpm --filter pa-functions test`; the workspace name
   is `@pa/functions`. I'll filter on that.

## Function signature (LOCKED on first impl commit — S1C codes against this)

```ts
// packages/agent-runtime/src/types.ts (additive — no edit to existing types)
export interface AgentTurnStreamChunk {
  /**
   * Incremental token text. May be empty string on heartbeat / role-only
   * chunks. Concatenating all `delta` values in order reproduces the full
   * assistant text exactly as `runAgentTurn` would have returned in `text`.
   */
  delta: string

  /**
   * Populated ONLY on the terminal chunk. `"stop"` = clean finish,
   * `"length"` = max_tokens cutoff, `"error"` = upstream error mid-stream.
   * Absent on every intermediate chunk.
   */
  finishReason?: "stop" | "length" | "error"

  /**
   * Best-effort usage stats, present only on terminal chunk when provider
   * surfaces them. Shape mirrors `RunAgentTurnUsage`.
   */
  usage?: RunAgentTurnUsage
}

// packages/agent-runtime/src/stream.ts (new file)
export function runAgentTurnStream(
  ctx: AgentTurnContext
): AsyncGenerator<AgentTurnStreamChunk, void, void>

// re-export from packages/agent-runtime/src/index.ts
export { runAgentTurnStream } from "./stream.js"
export type { AgentTurnStreamChunk } from "./types.js"
```

Notes for S1C consumers:
- Async iterator: `for await (const chunk of runAgentTurnStream(ctx)) {...}`
- Generator returns `void` after the terminal chunk yields.
- Generator is `async` so `ctx.signal` AbortSignal cancellation propagates.
- Errors mid-stream throw out of the generator (caller's `for await` rejects).
- Feature-flag-off mode: generator's first `.next()` call rejects with
  `Error("PA_AGENT_RUNTIME_STREAM_ENABLED=false")` exactly. (We throw inside
  the generator body before the first yield so callers don't accidentally
  observe a partial stream when the flag is off.)

## Files to touch

| File | Action |
|---|---|
| `packages/agent-runtime/src/types.ts` | ADD `AgentTurnStreamChunk` interface. No edits to existing exported types. |
| `packages/agent-runtime/src/stream.ts` | NEW. Contains `runAgentTurnStream` impl + provider streaming call. |
| `packages/agent-runtime/src/openai-stream-provider.ts` | NEW. Helper that wraps `client.chat.completions.create({ stream: true })` into the chunk shape. Reuses memoized client from `openai-provider.ts` via the same `defaultClient`. |
| `packages/agent-runtime/src/index.ts` | ADD export lines for `runAgentTurnStream` + `AgentTurnStreamChunk`. |
| `packages/agent-runtime/src/stream.test.ts` | NEW. Unit tests for stream behavior. |
| `packages/agent-runtime/src/run-golden.test.ts` | NEW. Golden snapshot test: stub agents-sdk + chat-completions to return fixed text and assert `runAgentTurn` returns byte-identical `{ text, usage }` shape. |

Zero edits to: `run.ts`, `openai-agents-adapter.ts`, `openai-provider.ts`
(except as needed to expose a shared `defaultClient` — if needed, will add a
NEW named export `getMemoizedOpenAIClient(agent)` without altering existing
signatures or behavior).

## Provider choice

`runAgentTurn` today routes through two paths:
1. Default: OpenAI Agents SDK `runOpenAIAgentsTurn` (Responses API,
   `gpt-5.4-nano`).
2. Fallback / test-injected: `runOpenAITurn` → `client.chat.completions`.

For streaming v1, I will use **OpenAI Chat Completions streaming**
(`client.chat.completions.create({ ..., stream: true })`) for these reasons:
- Chat-completions streaming is the simplest stable streaming API in the
  OpenAI SDK v4 (which is what's pinned in `package.json`).
- LiveKit's `openai.LLM` plugin expects an OpenAI-compatible streaming
  endpoint — Chat Completions SSE is the canonical wire format S1C will
  proxy.
- Agents SDK Responses streaming is async-event-based (`stream_events()`),
  shape-mismatched with what S1C needs to forward to LiveKit. Wrapping it
  into our chunk type would add an extra translation layer with no benefit
  for the voice path.
- This decision is local to streaming; non-streaming `runAgentTurn` keeps
  using the Agents SDK default path. No drift between the two.

If a future requirement needs Responses-API streaming (e.g. hosted tools
mid-stream), we add a second provider path. v2.1 voice does not need tools
mid-stream.

## Feature flag rollout

- Env var: `PA_AGENT_RUNTIME_STREAM_ENABLED` (default `false`).
- Read at call time inside `runAgentTurnStream` (not at module load), so
  tests can flip per-case.
- When `false`: generator throws `Error("PA_AGENT_RUNTIME_STREAM_ENABLED=false")`
  on first `.next()`. Import sites can `try/catch` to detect.
- When `true`: stream is live.
- Default OFF until S1C + S2 are integrated. S1C tests flip it on locally.

## Test plan (must all pass before commit)

1. `stream.test.ts`:
   - `runAgentTurnStream throws when flag disabled` — first `.next()`
     rejects with the exact `Error("PA_AGENT_RUNTIME_STREAM_ENABLED=false")`
     message.
   - `runAgentTurnStream emits chunked deltas` — mock OpenAI client yields
     ≥3 chunks. Concatenated `delta` equals expected full text.
   - `runAgentTurnStream finishReason populated on last chunk` —
     intermediate chunks have `finishReason === undefined`; terminal chunk
     has `finishReason === "stop"`.
   - `runAgentTurnStream surfaces upstream errors as iterator rejection` —
     mock client throws mid-stream → `for await` rejects with same error.
   - `runAgentTurnStream propagates AbortSignal` — abort before second
     chunk → iterator rejects with AbortError-shaped error.

2. `run-golden.test.ts`:
   - Snapshot test of `runAgentTurn` against a stub that returns a fixed
     `{ text: "golden", usage: { provider: "openai", model: "gpt-5.4-nano" } }`.
     Recorded snapshot string compared byte-identical. Lives in same file
     (inline expected literal) so a regression in `runAgentTurn` output
     shape would fail this test.

3. Existing `run.test.ts`, `messages.test.ts`, `firestore-session.test.ts`,
   `openai-agents-adapter.test.ts`, `openai-provider.test.ts` must remain
   100% unchanged + green.

4. Regression gate (P10 brief):
   - `pnpm --filter @pa/agent-runtime test`
   - `pnpm --filter @pa/pa-orchestrator test`
   - `pnpm --filter @pa/functions test`
   - `node tests/scenarios/runner-prescreen.mjs pass.yaml`
   - `node tests/scenarios/runner-prescreen.mjs fail.yaml`
   - `node tests/scenarios/runner-prescreen.mjs hard-stop.yaml`
   - `node tests/scenarios/runner-prescreen.mjs pause.yaml`

   The four scenario runners hit live LLM providers; if creds missing,
   I will report which credential is unavailable rather than block.

## Commit sequence (atomic, imperative ≤72-char subjects)

1. `feat(agent-runtime): add AgentTurnStreamChunk + runAgentTurnStream stub`
   - Adds type + stub function that throws when flag off.
   - Adds export lines in `index.ts`.
   - Adds `runAgentTurnStream throws when flag disabled` test (passes).
   - **Signature locks here so S1C can mock against it.**

2. `feat(agent-runtime): implement OpenAI chat-completions streaming impl`
   - Adds `openai-stream-provider.ts`.
   - Implements `runAgentTurnStream` body behind flag.
   - Adds remaining stream unit tests.
   - Adds golden snapshot for `runAgentTurn`.

3. `docs(v2.1): SUMMARY.md for S1A and update sprint scaffolding`
   - Writes `.planning/v2.1/sprints/S1A-runtime-stream/SUMMARY.md`.
   - No code changes.

Push: `git push -u origin claude/v21-S1A-runtime-stream` after final commit.

## Risks / things that may block S2

- If OpenAI Chat Completions Responses-API drift forces Agents SDK
  streaming, S1C wire format may need to change. Mitigation: stream chunk
  shape is provider-neutral; S1C only sees `AgentTurnStreamChunk`.
- Memoized client + prefix-cache wrapping (`wrapWithPrefixCache`) does not
  currently support streaming. For v1, the streaming path bypasses prefix
  cache (acceptable for voice TTFA — prefix cache helps text turns, voice
  turns are short and cache-miss anyway). I will note this in SUMMARY.
- Streaming TTFA depends on LiveKit Cloud → OpenAI latency. Not measurable
  here in S1A; S4 telemetry phase will measure end-to-end.

## Done-criteria checklist

- [x] AGENT_PLAN.md written first (this file)
- [ ] Signature exported on first impl commit
- [ ] New tests pass; existing tests unchanged
- [ ] Golden snapshot of `runAgentTurn` proves byte-identical
- [ ] Regression gate (6 commands) green
- [ ] Commits pushed to `claude/v21-S1A-runtime-stream`
- [ ] `.planning/v2.1/sprints/S1A-runtime-stream/SUMMARY.md` written
- [ ] Final report to P10
