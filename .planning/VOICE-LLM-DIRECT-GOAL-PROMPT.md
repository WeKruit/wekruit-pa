# Voice LLM Direct — Goal Prompt

**Date:** 2026-05-17. **Mode:** serial (one agent, 3 commits). **Base:** `main` post PR #92/#93/#94.

## Mission

Replace the HTTP shim path between LiveKit Agents and `@pa/agent-runtime` with an in-process `WekruitLLM` class that extends LK's `abstract class LLM`. Zero HTTP boundary. Faster TTFA. No Cloud Run / shim service to operate.

## The single hard rule — 共用大脑 / zero rebuild

**`runAgentTurnStream` is the brain.** Wrap it. Do not rebuild it. The new `WekruitLLM` class is one thin adapter file — everything it depends on (`@pa/agent-runtime`, `@pa/agent-registry`, `@pa/memory`, OpenAI provider) is `import`-and-use.

If you find yourself re-implementing OpenAI streaming, agent selection, system-prompt composition, memory hooks, or persona loading — STOP. That's the v2.1 D-anti-pattern. Reuse `runAgentTurnStream`.

## Adam-locked files — DO NOT EDIT

- `apps/functions/src/prescreen-session-start.ts` (+ `.test.ts`)
- `apps/functions/src/prescreen-terminal-action.ts` (+ `.test.ts`)
- `apps/functions/src/prescreen-turn-handler.ts` (Adam edits post-PR-92)

Read-only reference fine.

## Read first (in order)

1. `.planning/VOICE-LLM-DIRECT.md` — full design + risks + done criteria
2. `CLAUDE.md` — deploy authority, D1-D16 locks
3. `node_modules/.pnpm/@livekit+agents@*/dist/llm/llm.d.ts` — `LLM` + `LLMStream` abstract classes (the interface to extend)
4. `packages/agent-runtime/src/stream.ts` — `runAgentTurnStream` signature + `AgentTurnContext` shape (read-only)
5. `apps/voice-agent/src/worker.ts` — current `openai.LLM(base_url=…)` wiring at line ~162 (replace target)
6. `apps/voice-llm-shim/src/runtime/orchestrator-backend.ts` — existing reference adapter (for ChatContext mapping shape)

## Commits (serial, atomic, ship-able alone)

| # | Branch op | Scope | Tests |
|---|---|---|---|
| **W1** | new commit on new branch | `apps/voice-agent/src/wekruit-llm.ts` — `WekruitLLM` + `WekruitLLMStream` + `mapChatCtxToAgentMessages`. Imports `@pa/agent-runtime`, `@pa/agent-registry`. | ≥10 unit tests in `__tests__/wekruit-llm.test.ts` |
| **W2** | next commit | `apps/voice-agent/src/worker.ts` swaps `new openaiPluginMod.LLM(...)` → `new WekruitLLM()` inside the production branch (line ~162). Tests inject `opts.defineAgent` to skip. | new integration test confirming session.llm provider==="wekruit-orchestrator" |
| **W3** | next commit | Cleanup: drop `WEKRUIT_LLM_SHIM_URL` from `livekit.toml` agent.env, drop `openaiPluginMod` import + lazy-load from worker.ts, mark `apps/voice-llm-shim` README as DEV-ONLY (do not delete the package) | n/a |

Each commit independently mergeable. Baselines守住 between commits.

## Workflow per commit

1. Snapshot baselines: `pnpm --filter voice-agent test`, `pnpm --filter pa-orchestrator test`, `pnpm --filter @pa/functions test`.
2. Write tests first.
3. Implement.
4. Re-run baselines + new tests. Drop → revert.
5. Atomic commit. No `--no-verify`.
6. Update `.planning/VOICE-LLM-DIRECT.md` only if assumptions changed.

## Deploy authority (per CLAUDE.md)

After W3 merge:
- Functions: nothing changes (voice CFs unaffected).
- Voice-agent: `pnpm --filter voice-agent build` then `lk agent create --secrets ...` (Adam-supplied LK creds + Firebase service account JSON + DEEPGRAM_API_KEY + PA_VOICE_CF_SECRET).
- DO NOT redeploy SMS path. DO NOT touch firebase functions.

## Live verify (Adam-gated)

- `node tests/voice-smoke/smoke-driver.mjs --scenario 01-happy-path-pass` dialing **only** `+14243201960` (CLAUDE.md dev-phone authorization). Any other number = ask Adam first.
- Read transcript; confirm TTFA on `voice.session_usage_updated` log < 1500ms.

## Done = closed loop

1. W1+W2+W3 merged to `main`.
2. `voice-agent` tests +12 (10 W1 + 2 W2) green.
3. `livekit.toml` zero references to `WEKRUIT_LLM_SHIM_URL`.
4. `apps/voice-llm-shim` package retained, README updated to "DEV-ONLY (local testing); production uses in-process `WekruitLLM`".
5. Voice worker boots cleanly without shim service.

## Stop conditions

- Baseline drops → revert, diagnose, no `--no-verify` shortcut.
- Adam-locked file touched → revert immediately.
- `runAgentTurnStream` requires Firestore but voice worker has no creds → surface to Adam, do not bypass with `try/catch return ""`. Real fix: pass `FIREBASE_SERVICE_ACCOUNT_JSON` via LK Cloud secret. Block W2 merge until verified locally.
- Tool calling shows up in ChatContext → assert + log; out of scope for this initiative.

## Anti-patterns to avoid (recorded from past failures)

- ❌ Re-implementing OpenAI streaming inside voice-agent (use `runAgentTurnStream`; D1).
- ❌ Hardcoding model names in `WekruitLLM` (route through `agent.defaultModel` or `opts.model`).
- ❌ Adding parallel memory write paths (mem0 hooks live inside `runAgentTurnStream`; don't duplicate).
- ❌ Deleting `apps/voice-llm-shim` in this initiative (keep for dev path; out of scope).
- ❌ Writing 200+ line goal prompts (Adam: "too long").
- ❌ Telling Adam to deploy (iter23 directive — you deploy).
