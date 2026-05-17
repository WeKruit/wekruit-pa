# Voice ⇆ Prescreen Interface — Handoff

**Date:** 2026-05-16. **Status:** all 5 commits shipped on `feat/wekruit-open-integration`. Final commit `5d0fc83` (C4) + parity (C5, pending commit).

## What landed

Shared brain for SMS + voice prescreen via `runPrescreenTurn(ctx, deps)`. Five atomic commits, each ship-able alone:

| # | SHA | Title | Net LOC |
|---|---|---|---|
| C1 | `8ddb3af` | `feat(prescreen): extract SessionFinder + TurnRecorder ifaces` | +1345 |
| C2 | `01a9a80` | `feat(prescreen): runPrescreenTurn channel-agnostic core` | +952 |
| C3 | `c461e5c` | `refactor(prescreen): SMS handler delegates to runPrescreenTurn` | -290 |
| C4 | `5d0fc83` | `feat(voice): wire runPrescreenTurn + cli.runApp registration` | +584 |
| C5 | this commit | `test(prescreen): cross-channel parity gate` | +200 |

## Baselines after the refactor

| Suite | Before | After |
|---|---|---|
| `pa-orchestrator` | 1508/1508 | **1562/1562** (+54: 28 from C1, 26 from C2) |
| `@pa/functions` | 1711/1711 | **1711/1711** (preserved — SMS adapter delegates without behavior change) |
| `voice-agent` | 60/60 | **68/68** (+8 worker-defaults integration tests) |
| Predeploy smoke | 1 check | 2 checks (+ cross-channel parity gate) |

## The contract

```
                       ┌──────────────────────────────────────┐
                       │ @pa/pa-orchestrator/prescreen/runner │
                       │  runPrescreenTurn(ctx, deps)         │
                       │                                      │
                       │  ALL 6 lifecycle outcomes live here: │
                       │   • no_active_session                │
                       │   • active_turn (pipeline runs)      │
                       │   • session_expired                  │
                       │   • recent_terminal_guard            │
                       │   • user_exit                        │
                       │   • stale_terminal                   │
                       └──────────────────────────────────────┘
                                   ▲                ▲
                                   │                │
          ┌────────────────────────┘                └────────────────────────┐
          │                                                                  │
┌────────────────────────────────┐                  ┌────────────────────────────────┐
│ SMS adapter                    │                  │ voice adapter                  │
│ apps/functions/src/            │                  │ apps/voice-agent/src/worker.ts │
│   prescreen-turn-handler.ts    │                  │   defaultBuildPipeline →       │
│                                │                  │   paVoicePrescreenTurn CF →    │
│   runPrescreenTurnIfActive     │                  │   runPrescreenTurn(channel:    │
│   → runPrescreenTurn(channel:  │                  │     "voice")                   │
│     "sms")                     │                  │                                │
│                                │                  │  Worker stays free of          │
│   sendImessage + terminal-     │                  │  firebase-admin + @pa/*        │
│   action dispatch happen here  │                  │  deps; the CF is the bridge.   │
└────────────────────────────────┘                  └────────────────────────────────┘
```

## Where future agent changes go

| Change | Single edit point |
|---|---|
| Add a new clarify-round opener | `packages/pa-orchestrator/src/prescreen/runner.ts` (or `apps/functions/src/prescreen-deps.ts` for the LLM caller side) |
| Add a new user-exit keyword | `runner.ts::isUserExitPrescreenReply` |
| Change a lifecycle window (expired/recent-terminal) | `session-finder.ts` constants |
| New terminal kind ("INCOMPLETE") | `runner.ts` PrescreenRunResult.terminalAction union + `prescreen-terminal-action.ts` (Adam-locked) |
| Change the keyword-scoring prompt | `prescreen-deps.ts::makeProductionKeywordSetCaller` (shared between SMS and voice CFs) |
| Change the clarify-composer prompt | `prescreen-deps.ts::makeProductionClarifyComposer` |
| New question type | `packages/pa-orchestrator/src/onboarding/question.ts` + `prescreen/pipeline.ts` (already shared) |
| SMS-only formatting tweak | `prescreen-turn-handler.ts::smsChannelTextHint` |
| Voice-only TTS-friendly tweak | `voice/voice-prescreen-callable.ts::voiceChannelTextHint` |

**Anti-rule**: if a change requires editing both `prescreen-turn-handler.ts` AND `voice/voice-prescreen-callable.ts`, the contract is wrong — that change belongs in `runner.ts` or `prescreen-deps.ts`.

## Parity gate

`tests/scenarios/runner-parity.mjs` drives 3 scenarios (active_turn / strong-PASS, active_turn / weak-clarify, user_exit / "stop") through both SMS and voice deps via the shared runner. Asserts:

- `lifecycle.kind` identical
- `terminalAction.terminal` identical
- `pipelineResult.state.terminal` + `.score` + `.action.kind` identical (active_turn only)
- Text differs ONLY by channel-hint envelope (`[sms]…` vs `[voice]…`)

Wired into `apps/functions/scripts/predeploy-smoke.mjs`; any drift → `firebase deploy` aborts.

## Deploy gate — voice prerequisites

Before voice goes live on LK Cloud:

```bash
# 1. Set the shared secret functions side
firebase functions:secrets:set PA_VOICE_CF_SECRET --project wekruit-5f89b
# 2. Deploy CFs (paVoiceCallContext + paVoicePrescreenTurn included)
cd apps/functions && pnpm run deploy
# 3. Set worker env on LK Cloud
lk agent env set WEKRUIT_VOICE_CONTEXT_URL=https://...paVoiceCallContext
lk agent env set WEKRUIT_VOICE_PRESCREEN_TURN_URL=https://...paVoicePrescreenTurn
lk agent env set PA_VOICE_CF_SECRET=<same secret>
# 4. Deploy worker
cd apps/voice-agent && pnpm build && lk agent deploy
# 5. Live smoke (Adam-gated; only +14243201960 per CLAUDE.md)
node tests/voice-smoke/smoke-driver.mjs --scenario 01-happy-path-pass
```

## What stayed Adam-locked

Untouched by this refactor (Adam was editing them in parallel):

- `apps/functions/src/prescreen-session-start.ts` + `.test.ts`
- `apps/functions/src/prescreen-terminal-action.ts` + `.test.ts`

Boundaries: the runner sits strictly between session-start (creates session, runs first opener) and terminal-action (post-decision side effects like Level 1 reveal + auto job recs). When `runPrescreenTurn` emits a `terminalAction`, the channel adapter calls into `runPrescreenTerminalAction` exactly as before.

## Pre-existing tech debt (not addressed by this refactor)

- `tests/scenarios/runner-prescreen.mjs` requires the `yaml` package which is not installed at the workspace root. The parity runner (`runner-parity.mjs`) is dependency-free so it doesn't hit this. Optionally add `yaml` as a root dev-dep later — orthogonal to the shared-brain interface.

## What was deliberately not built

- ❌ New `@pa/prescreen-contract` package (pa-orchestrator already exports the right types).
- ❌ New `/admin/prescreen-observability` dashboard route (existing `/admin/prescreen-sessions/:sessionId` covers it; turn records still write through the new `FirestoreTurnRecorder`).
- ❌ Voice-side duplicate of `KeywordSetJudge` / `PreScreenPipeline` / clarify composer — both channels call the same `runPrescreenTurn` instance.
- ❌ Feature flag for the C3 SMS handler cutover — baselines守住 (1711/1711) was the凭据.
