# Voice LLM Direct — replace HTTP shim with in-process WekruitLLM class

**Date:** 2026-05-17. **Owner:** next P10. **Base branch:** `main` (post PR #92/#93/#94 merge).

## 1. Principle — 共用大脑, zero rebuild

`@pa/agent-runtime.runAgentTurnStream` is the brain. This refactor **wraps** it, does **NOT** rebuild it.

| 项 | 共用还是新建 | 来源 |
|---|---|---|
| `runAgentTurnStream` AsyncGenerator | **共用** | `packages/agent-runtime/src/stream.ts` |
| Agent registry + handbook + persona | **共用** | `@pa/agent-registry` |
| Memory + mem0 hooks | **共用** | `@pa/memory` |
| OpenAI provider streaming impl | **共用** | `packages/agent-runtime/src/providers/chat-completions.ts` |
| Prescreen runner (`runPrescreenTurn`) | **共用** | shipped in PR #92 |
| Voice CFs (paVoiceCallContext + paVoicePrescreenTurn) | **共用** | shipped + deployed |
| **`WekruitLLM extends llm.LLM` class** | **新建** | `apps/voice-agent/src/wekruit-llm.ts` |
| **`WekruitLLMStream extends llm.LLMStream`** | **新建** | same file |
| ChatContext ↔ AgentTurnContext.messages adapter | **新建** | same file |

**Forbidden**:
- ❌ Re-implement OpenAI provider in voice-agent (use `runAgentTurnStream`)
- ❌ Bypass `@pa/agent-registry` (use `getDefaultAgent` / `getAgentById`)
- ❌ Branch on prescreen vs Claire — `runAgentTurnStream` already routes
- ❌ Touch SMS handler / runner.ts / voice CFs (this is voice-worker-only)
- ❌ Edit Adam-locked `prescreen-session-start.ts` / `prescreen-terminal-action.ts`

## 2. Why this exists

After PR #92 the voice **transport** is wired to the orchestrator brain via paVoicePrescreenTurn for prescreen turns. The LK AgentSession still requires an `LLM` constructor arg for non-prescreen branches (post-terminal Claire chat, hard-filter clarifies that fall through to LLM-generated text, future use cases).

Currently `worker.ts:162` plugs `openai.LLM({ base_url: WEKRUIT_LLM_SHIM_URL })`. That requires running `apps/voice-llm-shim` as a separate HTTP service so LK's plugin can POST `/v1/chat/completions`. Two HTTP boundaries (LK→shim→OpenAI→shim→LK) add 50-150ms TTFA + ops surface for no value — `runAgentTurnStream` already streams; we just need to wire the stream through.

## 3. Architecture

### Today (HTTP shim)
```
LK worker process
   ├─ AgentSession
   │    └─ openai.LLM(base_url=$WEKRUIT_LLM_SHIM_URL)
   │         └─ POST /v1/chat/completions (HTTP)
   │
   ├─ separate shim process (or Cloud Run)
   │    └─ runAgentTurnStream → OpenAI HTTPS
   │
   └─ SSE response → LK plugin → ChatChunk
```

### After (direct in-process)
```
LK worker process
   ├─ AgentSession
   │    └─ new WekruitLLM()
   │         └─ chat() returns WekruitLLMStream
   │              └─ for-await runAgentTurnStream({...})
   │                    └─ OpenAI HTTPS  (only network hop)
   │              → AsyncIterableQueue<ChatChunk>
```

Zero HTTP shim. Zero Cloud Run. Bundle grows but ops surface shrinks.

## 4. The class

Real signatures discovered during W1 implementation differed from the initial
sketch — `AgentTurnContext` is `{ agent, systemPrompt, userMessage, history }`
(NOT `{ agent, messages, model }`); the `LLMStream` base class drives `run()`
inside a retry-aware `mainTask` (DON'T call `run()` from the constructor).
The shipped shape:

```ts
// apps/voice-agent/src/wekruit-llm.ts

import { llm, DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from "@livekit/agents"
import { runAgentTurnStream, type AgentTurnContext, type RunAgentTurnUsage } from "@pa/agent-runtime"
import type { AgentDef, ChatMessage as PaChatMessage } from "@pa/core-types"
import { randomUUID } from "node:crypto"

export interface WekruitLLMOptions {
  agent?: AgentDef                  // inject full AgentDef (no Firestore round-trip)
  model?: string                    // override model on default AgentDef
  systemPromptFallback?: string     // used when ChatContext has no system msg
  __runAgentTurnStream?: typeof runAgentTurnStream  // test seam
}

export class WekruitLLM extends llm.LLM {
  constructor(readonly opts: WekruitLLMOptions = {}) { super() }
  label() { return "wekruit" }
  get model() { return this.opts.agent?.model ?? this.opts.model ?? "gpt-4o-mini" }
  get provider() { return "wekruit-orchestrator" }
  chat(args: { chatCtx: llm.ChatContext; connOptions?: APIConnectOptions }): llm.LLMStream {
    return new WekruitLLMStream(this, args.chatCtx, this.opts, args.connOptions)
  }
}

export class WekruitLLMStream extends llm.LLMStream {
  constructor(parent: WekruitLLM, chatCtx: llm.ChatContext, opts: WekruitLLMOptions, conn?: APIConnectOptions) {
    super(parent, { chatCtx, connOptions: conn ?? DEFAULT_API_CONNECT_OPTIONS })
    // base class invokes run() via mainTask — DO NOT call manually.
  }
  protected async run() {
    const ctx = mapChatCtxToAgentTurnContext(this.chatCtx, /*agent*/..., /*fallback*/...)
    for await (const chunk of (opts.__runAgentTurnStream ?? runAgentTurnStream)(ctx)) {
      if (chunk.delta) this.queue.put({ id, delta: { role: "assistant", content: chunk.delta } })
      if (chunk.usage) finalUsage = chunk.usage
      if (chunk.finishReason) { emitFinalUsageChunk(...); return }
    }
  }
}

// mapChatCtxToAgentTurnContext mirrors apps/voice-llm-shim/src/runtime/orchestrator-backend.ts —
// leading system msgs → joined systemPrompt; last user msg → userMessage; in-between → history;
// FunctionCall / FunctionCallOutput / AgentHandoff / AgentConfigUpdate items are dropped.
```

No Firestore import. `makeDefaultVoiceAgent` (inline) provides a minimal
`AgentDef` so the OpenAI provider path works with just `OPENAI_API_KEY` in
env — see Risk #1 below for why this resolves the Firestore-creds concern.

## 5. Commit sequence (3 atomic commits)

| # | Commit | Tests | Baseline |
|---|---|---|---|
| **W1** | `feat(voice-agent): WekruitLLM class wrapping runAgentTurnStream` — new file + adapter + unit tests | ≥10 unit tests | voice-agent +10 |
| **W2** | `refactor(voice-agent): worker.ts uses WekruitLLM instead of openai.LLM shim` — wire into AgentSession constructor; behind env flag `PA_VOICE_USE_DIRECT_LLM=true` (default true after W3) | worker integration test confirms WekruitLLM is the session's LLM | voice-agent baseline + 2 |
| **W3** | `chore(voice-agent): remove WEKRUIT_LLM_SHIM_URL from livekit.toml + worker.ts; mark voice-llm-shim deprecated` — cleanup once W2 verified live | n/a | unchanged |

Each commit ship-able. SMS path 1719/1719 untouched. Orchestrator 1585/1585 untouched.

## 6. Bundle impact

`voice-agent` deps before this refactor:
- `@livekit/agents` + 3 plugins
- (post W1) `@pa/agent-runtime`
- transitive: `openai` SDK, `firebase-admin`, `@pa/agent-registry`, `@pa/memory`

Bundle estimate: ~50MB → ~150MB compressed → ~250MB on LK Cloud build. Still well under LK's per-agent quota (~1GB).

Trade-off accepted: bundle bloat once, latency win every TTFA forever.

## 7. Risks + mitigations

| Risk | Mitigation |
|---|---|
| ~~`runAgentTurnStream` requires Firestore for mem0/audit~~ | **RESOLVED (W1 verified):** `runAgentTurnStream` in `packages/agent-runtime/src/stream.ts` only calls `assertProviderKey` + `streamOpenAIChatCompletions`. No Firestore/mem0/audit on the stream path. Voice worker only needs `OPENAI_API_KEY`. |
| ~~`getDefaultAgent` requires handbook load~~ | **RESOLVED (W1):** Sidestepped via inline `makeDefaultVoiceAgent` — no `@pa/agent-registry` import in the production path. Callers can still inject a full `AgentDef` via `opts.agent` for custom system prompts / personas. |
| Memory writes from voice context might dupe SMS path | Voice writes use same mem0 key; mem0 dedupes. Verify in W2 integration test. |
| LK ChatContext shape changes between SDK versions | Pin `@livekit/agents` to current `^1.4.2`; document in `wekruit-llm.ts` doc-comment. |
| Tool calling support — if Claire emits tool calls in voice context, must propagate as `FunctionCall` to LK | Out of scope for v2.2; assert tool calls absent in voice context for now. |
| Cold start regression — first call after deploy slow due to bundle init | Acceptable; LK Cloud `prewarm()` hook exists; revisit in W3. |
| Shim package becomes dead code | Leave package in repo for dev (local 127.0.0.1:8787) until W4 future cleanup; not deleted in this initiative. |

## 8. Tests required

W1 unit tests (`apps/voice-agent/src/__tests__/wekruit-llm.test.ts`, ≥10):
- chat() returns LLMStream instance
- stream emits ChatChunk shape with id + delta.role="assistant" + delta.content
- mapChatCtxToAgentMessages preserves system → user → assistant order
- mapChatCtxToAgentMessages drops tool_calls (out of scope)
- mapChatCtxToAgentMessages handles empty context
- mapChatCtxToAgentMessages systemOverride prepends
- run() catches errors and emits llm_error event
- run() closes queue on completion
- model + provider + label getters
- opts.agentId routing to getAgentById

W2 integration test (`apps/voice-agent/src/__tests__/worker-llm-wiring.test.ts`):
- startWorker without opts.defineAgent constructs session with WekruitLLM (not openai.LLM)
- session.llm.model returns "claire-default" (or opts.model)

W3 smoke: existing `tests/voice-smoke/runner.mjs --mock` 10/10 still green.

## 9. Adam-locked files (DO NOT EDIT)

Unchanged from PR #92:
- `apps/functions/src/prescreen-session-start.ts` + `.test.ts`
- `apps/functions/src/prescreen-terminal-action.ts` + `.test.ts`

Plus:
- `apps/functions/src/prescreen-turn-handler.ts` (Adam owns post-PR-92; this refactor is voice-only)

## 10. Done criteria

1. W1+W2+W3 merged to `main` via PR(s).
2. `pnpm --filter voice-agent test` green (baseline + 10 new).
3. `pnpm --filter pa-orchestrator test` 1585/1585 unchanged.
4. `pnpm --filter @pa/functions test` 1719/1719 unchanged.
5. `livekit.toml` no longer references `WEKRUIT_LLM_SHIM_URL`.
6. Voice worker builds clean (`pnpm --filter voice-agent build`).
7. Optional: `lk agent create` + live smoke against +14243201960 (Adam-gated).

## 11. The single hard rule

**The voice worker's LLM brain MUST be the same `runAgentTurnStream` the rest of WeKruit uses.** If a voice-only LLM bypass appears (custom prompts that don't go through agent-registry, hard-coded model strings outside opts), that's drift — fix in this layer, not by adding parallel infrastructure.
