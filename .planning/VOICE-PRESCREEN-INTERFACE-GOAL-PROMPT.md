# Voice ⇆ Prescreen Interface — Goal Prompt

**Date:** 2026-05-16. **Mode:** serial (one agent, no P9 fan-out). **Base:** `feat/wekruit-open-integration` post-merge `3bc395d`.

## Mission

Extract one channel-agnostic core (`runPrescreenTurn`) so SMS + voice share the same prescreen brain. Future agent changes (questions, clarify wording, lifecycle reducers, LLM models) land in Layer A only and propagate to both channels automatically.

## The Single Hard Rule — 共用大脑 / Zero Rebuild

**Pipeline / scenarios / tag vocab / eval framework / pa-canonical-tags / pa-resume-parser are brain content. DO NOT duplicate them.** Add ONE new interface (`runner.ts`) + two new ifaces it depends on (`SessionFinder`, `TurnRecorder`) + a parity runner. Everything else is `import { ... } from "@pa/pa-orchestrator"` / `from "@pa/shared-tags"` / existing files.

If you find yourself writing a second copy of `PreScreenPipeline`, `KeywordSetJudge`, `findActiveSession`, a new tag taxonomy, or a parallel observability page — STOP. That's the v1.6 D8 anti-pattern. Single source.

## Adam-locked files — DO NOT EDIT

- `apps/functions/src/prescreen-session-start.ts` (+ `.test.ts`)
- `apps/functions/src/prescreen-terminal-action.ts` (+ `.test.ts`)

Read-only reference fine.

## Read first (in this order)

1. `.planning/VOICE-PRESCREEN-INTERFACE.md` — full design
2. `CLAUDE.md` — deploy authority, D1-D16 locks, reuse mandate, Adam-locked files
3. `apps/functions/src/prescreen-turn-handler.ts` — SMS path source of truth (738 lines, what gets shrunk)
4. `packages/pa-orchestrator/src/prescreen/pipeline.ts` — pipeline contract (read-only)
5. `apps/voice-agent/src/worker.ts` — `defaultLoadContext` + `defaultBuildPipeline` stubs (throw today)
6. `apps/voice-agent/src/turn-loop.ts` — already DI'd via `VoicePipelineLite`
7. `apps/functions/src/voice/context-loaders/index.ts` — existing context loaders to invoke from voice callable CF
8. `tests/scenarios/runner-prescreen.mjs` — existing scenario driver to extend

## Commits (serial, atomic, each independently ship-able)

| # | Branch op | Scope | Tests required |
|---|---|---|---|
| **C1** | new commit on current branch | `packages/pa-orchestrator/src/prescreen/session-finder.ts` (iface + `FirestoreSessionFinder` impl) + `turn-recorder.ts` (iface + `FirestoreTurnRecorder` impl) | ≥15 unit tests; orchestrator baseline stays ≥1458/1458 + 15 |
| **C2** | new commit | `runner.ts` + `runPrescreenTurn(ctx, deps)`. Hoist 5 lifecycle reducers from SMS handler (active / expired / recent_terminal_guard / user_exit / stale_terminal). | ≥25 unit tests; SMS handler still uses inline (1139/1139 unchanged) |
| **C3** | new commit | `prescreen-turn-handler.ts` 738 → ~120 lines: delegates to `runPrescreenTurn`. Same external surface (`runPrescreenTurnIfActive` signature unchanged). | **1139/1139 守住** + existing handler tests 10/10 + `tests/scenarios/prescreen/{pass,fail,hard-stop,pause}.yaml` green |
| **C4** | new commit | `apps/functions/src/voice/voice-call-context.ts` (HTTPS callable CF wrapping S1B loaders) + `worker.ts::defaultLoadContext` invokes it + `defaultBuildPipeline` wires `runPrescreenTurn` via `VoicePipelineLite` adapter + `cli.runApp(new WorkerOptions(...))` registration. | voice-agent baseline + ≥6 voice integration tests; `--mock` voice-smoke 10/10 |
| **C5** | new commit | `tests/scenarios/runner-parity.mjs` + hook into `apps/functions/scripts/predeploy-smoke.mjs` | parity 100% on all 4 yaml |

## Workflow per commit

1. Read baselines via `pnpm --filter <pkg> test`. Snapshot exact pass count.
2. Write tests first (TDD nudge — runner is a contract, contract tests come first).
3. Implement.
4. Re-run baselines + new tests. Drop → revert commit, diagnose.
5. `git add -A && git commit` (atomic, no `--no-verify`, no force-push).
6. Update `.planning/VOICE-PRESCREEN-INTERFACE.md` if assumptions changed.
7. Move to next commit.

## Deploy authority (per CLAUDE.md)

Predeploy gate green = ship. After C5:

```bash
cd apps/functions && pnpm run deploy   # SMS handler refactored + paVoiceCallContext new CF
# Voice worker:
cd apps/voice-agent && pnpm build && lk agent deploy   # LK Cloud managed
```

DO NOT tell Adam to deploy. You deploy. (iter23 directive.)

## Live verify (Adam-gated only)

- `node tests/voice-smoke/smoke-driver.mjs --scenario 01-happy-path-pass` dialing **only** `+14243201960` (CLAUDE.md `dev_phone_dial_authorization` memory). Any other number = ask Adam first.
- Read transcript. "PASS" status not enough — read actual reply text (CLAUDE.md iter23).

## Done = closed loop

1. C1-C5 all green + merged to `feat/wekruit-open-integration`.
2. PR to `main` with title `feat(prescreen): shared brain interface — voice + SMS via runPrescreenTurn`.
3. Parity gate wired into predeploy-smoke.
4. Voice worker deployed + dial-test against `+14243201960` Adam-verified.
5. `.planning/VOICE-PRESCREEN-INTERFACE-HANDOFF.md` written — describes what next-agent should do when changing prescreen behavior (answer: edit `runner.ts` only).

## Stop conditions

- Baseline drops mid-commit → revert, diagnose root cause (no `--no-verify` shortcut).
- Adam-locked file touched → revert immediately.
- Parity gate red after C5 → C5 incomplete, do not deploy.
- Live dial requested for non-`+14243201960` number → ask Adam first.

## Anti-patterns to avoid (recorded from past failure)

- ❌ Spawning P7 sub-agents that duplicate `pa-orchestrator/prescreen/*` types (prior S1 failure).
- ❌ Creating new dashboard page when `/admin/prescreen-sessions/:sessionId` exists (prior S4 failure).
- ❌ Creating new `@pa/prescreen-contract` package (premature — pa-orchestrator already publishes the types).
- ❌ Writing 273-line goal prompts (Adam: "too long").
- ❌ Telling Adam to deploy ("你可以 deploy 不要再说让我 deploy").
- ❌ Editing `prescreen-session-start.ts` / `prescreen-terminal-action.ts` (Adam editing in parallel).
