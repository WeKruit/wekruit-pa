# Voice ⇆ Prescreen Interface

**Date:** 2026-05-16. **Owner:** next P10. **Branch base:** `feat/wekruit-open-integration` @ merged-from-main `3bc395d`.

## 1. Principle — 共用大脑

This refactor adds **one new interface**. It does **NOT** rebuild any brain content.

| 项 | 共用还是新建 | 来源 |
|---|---|---|
| `PreScreenPipeline` 4-gate state machine | **共用** | `packages/pa-orchestrator/src/prescreen/pipeline.ts` |
| Pipeline 单测 (54 个) | **共用** | `packages/pa-orchestrator/src/prescreen/__tests__/` |
| Prescreen scenario YAML | **共用** | `tests/scenarios/prescreen/*.yaml` |
| KeywordSetJudge + LLM caller (gpt-5.4-nano) | **共用** | `prescreen-turn-handler.ts` → 抽到 runner |
| Clarify composer prompt + round guidance | **共用** | 同上 |
| `pa-canonical-tags` vocab | **共用** | `packages/shared-tags` |
| Eval framework + QA evaluator weekly | **共用** | `paQaEvaluatorWeekly` CF |
| Voice-smoke YAML scenarios (10 个) | **共用** | `tests/voice-smoke/scenarios/` |
| Voice context loaders | **共用** | `apps/functions/src/voice/context-loaders/` |
| `runPrescreenTurn(ctx, deps)` core | **新建** (Layer A) | `packages/pa-orchestrator/src/prescreen/runner.ts` |
| `PrescreenSessionFinder` iface + impl | **新建** | 抽 `findActiveSession` + `findRecentTerminalSession` |
| `PrescreenTurnRecorder` iface + impl | **新建** | 抽 turn-record 写入逻辑 |
| Channel text hint (SMS 360 char / voice TTS-natural) | **新建** | 单 string transformer 各一 |
| Parity runner | **新建** | `tests/scenarios/runner-parity.mjs` |

**Forbidden**:
- ❌ New `@pa/prescreen-contract` package (pa-orchestrator already exports all types)
- ❌ New dashboard observability page (existing `/admin/prescreen-sessions/:sessionId` covers it)
- ❌ Re-implement KeywordSetJudge / pipeline / composer in voice tree
- ❌ Re-declare `VoiceCallContext` types in pa-orchestrator (voice-agent already mirrors S1B types intentionally)
- ❌ Modify `prescreen-session-start.ts` / `prescreen-terminal-action.ts` (+ `.test.ts` siblings) — Adam editing in parallel

## 2. Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Layer A — Channel-Agnostic Prescreen Core                  │
│   @pa/pa-orchestrator/prescreen/runner.ts                  │
│   runPrescreenTurn(ctx, deps) → PrescreenRunResult         │
│                                                            │
│   Owns: lifecycle (active / expired / recent_terminal /    │
│         user_exit / stale_terminal) + state persistence +  │
│         pipeline.runTurn + turn record write.              │
│   Knows: nothing about SMS or voice transport.             │
└────────────────────────────────────────────────────────────┘
                    ↑                          ↑
        ┌───────────┘                          └───────────┐
        │                                                  │
┌────────────────────────────┐         ┌──────────────────────────────┐
│ Layer B-SMS                │         │ Layer B-Voice                │
│ apps/functions/src/        │         │ apps/voice-agent/src/        │
│   prescreen-turn-handler   │         │   worker.ts (buildPipeline)  │
│   ~120 lines               │         │   turn-loop.ts (already DI)  │
│                            │         │                              │
│ - call runPrescreenTurn    │         │ - call runPrescreenTurn      │
│ - sendImessage(text)       │         │ - redactForVoice (PII)       │
│ - dispatch terminal action │         │ - session.say(speakText)     │
└────────────────────────────┘         └──────────────────────────────┘
```

## 3. Layer A Interface

```ts
// packages/pa-orchestrator/src/prescreen/runner.ts (NEW)

export interface PrescreenRunContext {
  sessionId: string         // SMS: resolve via sessionFinder.findForUser(userId); Voice: bookingId
  userId: string
  reply: string
  lang: "zh" | "en"
  nowIso: string
  channel: "sms" | "voice"  // composer hint ONLY — never branches lifecycle
  log?: (event: string, payload: Record<string, unknown>) => void
}

export type PrescreenLifecycle =
  | { kind: "no_active_session" }
  | { kind: "session_expired";       sessionId: string; jobId: string }
  | { kind: "recent_terminal_guard"; sessionId: string; jobId: string; terminal: string; alreadyAcked: boolean }
  | { kind: "user_exit";             sessionId: string; jobId: string }
  | { kind: "stale_terminal";        sessionId: string; terminal: string | null }
  | { kind: "active_turn";           sessionId: string; jobId: string; pipelineResult: RunTurnResult }

export interface PrescreenRunResult {
  lifecycle: PrescreenLifecycle
  text: string | null      // null = nothing to say this turn
  persisted: boolean
  terminalAction?: { terminal: "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"; reason: string }
}

export interface PrescreenRunnerDeps {
  store: PreScreenStateProvider
  sessionFinder: PrescreenSessionFinder
  llmCaller: KeywordSetLlmCaller
  composeClarify: PreScreenClarifyComposer
  turnRecorder: PrescreenTurnRecorder
  channelTextHint?: (input: { text: string; channel: "sms" | "voice"; action: RunTurnAction }) => string
  now?: () => Date
}

export interface PrescreenSessionFinder {
  findForUser(userId: string, opts?: { nowMs?: number }): Promise<
    | { kind: "none" }
    | { kind: "active"; sessionId: string; jobId: string }
    | { kind: "expired"; sessionId: string; jobId: string }
    | { kind: "recent_terminal"; sessionId: string; jobId: string; terminal: string; alreadyAcked: boolean }
  >
  // Voice path: when sessionId is already known from bookingId, skip user-lookup.
  loadById(sessionId: string): Promise<{ jobId: string; terminal: string | null; activeQId: string | null } | null>
}

export interface PrescreenTurnRecorder {
  record(sessionId: string, turn: {
    qId: string
    reply: string
    scored?: ScoredCellSnapshot
    action: PrescreenTurnRecordAction
    ts: string
  }): Promise<void>
  markPostTerminalAck(sessionId: string, nowIso: string): Promise<void>
}

export async function runPrescreenTurn(
  ctx: PrescreenRunContext,
  deps: PrescreenRunnerDeps,
): Promise<PrescreenRunResult>
```

## 4. 5-Commit Sequence

Each commit independently ship-able. SMS regression baselines守住后才能下一步。

| # | Commit | Adds | SMS baseline | Voice baseline |
|---|---|---|---|---|
| **C1** | `feat(prescreen): extract SessionFinder + TurnRecorder ifaces + Firestore impls` | `session-finder.ts`, `turn-recorder.ts` + 单测 ~15 | 1139/1139 (unchanged — still uses inline) | 8/8 (unchanged) |
| **C2** | `feat(prescreen): runPrescreenTurn channel-agnostic core` | `runner.ts` + 单测 ≥25 | 1139/1139 (still inline) | 8/8 |
| **C3** | `refactor(prescreen): SMS handler delegates to runPrescreenTurn` | `prescreen-turn-handler.ts` 738→~120 行 | **1139/1139 守住** + 10/10 existing handler tests | 8/8 |
| **C4** | `feat(voice): wire defaultLoadContext + defaultBuildPipeline + cli.runApp` | Voice callable CF for context + worker pipeline factory + cli.runApp registration | 1139/1139 | 8/8 + new voice prescreen integration tests ≥6 |
| **C5** | `test(prescreen): cross-channel parity gate + predeploy hook` | `runner-parity.mjs` + predeploy entry | 1139/1139 | 8/8 + parity 100% on 4+ yaml |

## 5. QA — 7-Layer Matrix

```
┌──────────────────────────────────────────────────────────────────┐
│ L7  Live Smoke (Adam-gated)                                      │
│     Sendblue real + LK Cloud real + SIP only +14243201960        │
├──────────────────────────────────────────────────────────────────┤
│ L6  ★ Cross-Channel Parity Gate (NEW — CI red/green)             │
│     Same YAML → SMS adapter + voice adapter → diff verdicts      │
│     Fails predeploy if drift detected.                           │
├──────────────────────────────────────────────────────────────────┤
│ L5  E2E Scenario (shared YAML)                                   │
│     runner-prescreen.mjs --channel sms|voice                     │
├──────────────────────────────────────────────────────────────────┤
│ L4  Voice Regression                                             │
│     voice-agent tests + voice-smoke --mock 10/10                 │
├──────────────────────────────────────────────────────────────────┤
│ L3  SMS Regression                                               │
│     functions tests 1139/1139 + 4 yaml scenarios                 │
├──────────────────────────────────────────────────────────────────┤
│ L2  Contract Unit (NEW — runner.ts)                              │
│     ≥25 tests across 5 lifecycle kinds × pass-through            │
├──────────────────────────────────────────────────────────────────┤
│ L1  Pipeline Unit (existing — UNCHANGED)                         │
│     PreScreenPipeline 54 tests                                   │
└──────────────────────────────────────────────────────────────────┘
```

### L6 Parity Runner spec

`tests/scenarios/runner-parity.mjs`:

```
for each tests/scenarios/prescreen/*.yaml:
  inMemDepsSms = makeInMemDeps({ channelTextHint: smsHint })
  inMemDepsVoice = makeInMemDeps({ channelTextHint: voiceHint })

  smsResult = runPrescreenTurn(ctx{channel:"sms", ...}, inMemDepsSms)
  voiceResult = runPrescreenTurn(ctx{channel:"voice", ...}, inMemDepsVoice)

  assert smsResult.lifecycle.kind === voiceResult.lifecycle.kind
  if (active_turn) {
    assert smsResult.lifecycle.pipelineResult.state.terminal
           === voiceResult.lifecycle.pipelineResult.state.terminal
    assert smsResult.lifecycle.pipelineResult.state.score
           === voiceResult.lifecycle.pipelineResult.state.score
    assert smsResult.lifecycle.pipelineResult.action.kind
           === voiceResult.lifecycle.pipelineResult.action.kind
  }
  assert smsResult.terminalAction?.terminal
         === voiceResult.terminalAction?.terminal
  // text 可以差异 — channel hint allowed to differ
```

Adds to `apps/functions/scripts/predeploy-smoke.mjs` so deploy aborts on drift.

### Baseline numbers — capture before C1

```bash
pnpm --filter pa-orchestrator test 2>&1 | tail -3   # expected: 1458/1458
pnpm --filter @pa/functions test 2>&1 | tail -3     # expected: 1139/1139
pnpm --filter voice-agent test 2>&1 | tail -3       # expected: capture actual
node tests/scenarios/runner-prescreen.mjs tests/scenarios/prescreen/
```

Each commit's CI MUST hit baseline minimums. Drop = revert commit.

### L7 Live Smoke (Adam-gated only)

- `node tests/voice-smoke/smoke-driver.mjs --scenario 01-happy-path-pass`
  - Real Sendblue + real LK Cloud + real SIP
  - Dial target: **only `+14243201960`** unless Adam confirms per-call (CLAUDE.md `dev_phone_dial_authorization` memory)
- `node tests/scenarios/runner-prescreen.mjs tests/scenarios/prescreen/{pass,pause}.yaml` (live Sendblue dev)

## 6. Adam-locked Files (DO NOT EDIT)

- `apps/functions/src/prescreen-session-start.ts`
- `apps/functions/src/prescreen-session-start.test.ts`
- `apps/functions/src/prescreen-terminal-action.ts`
- `apps/functions/src/prescreen-terminal-action.test.ts`

Read-only reference fine. The runner operates strictly between session-start (creates session — Adam owns) and terminal-action (post-decision side effects — Adam owns). Clean boundary.

## 7. Open Assumptions (Adam-confirm if wrong)

1. **Execution mode = serial** (one agent, C1→C5 in sequence). NOT P9-spawned-parallel.
2. **No feature flag for C3 cutover.** Baseline守住 (1139/1139 + 10/10) is the凭据. Flag = tech debt.
3. **Worktree base** = current `feat/wekruit-open-integration` (post merge). Atomic commits land here. PR to main at C5 completion.
4. **Channel hint composer scope** = pure string post-processor (char cap + iMessage-isms strip). NOT a second LLM call.
5. **Voice context callable CF** = new function `paVoiceCallContext` (HTTP callable, admin-only auth via LK signing key). Worker invokes from `defaultLoadContext`.

## 8. Done Definition

1. All 5 commits merged to `feat/wekruit-open-integration` then PR'd to `main`.
2. Baselines: orchestrator ≥1458/1458 + 25 new runner tests, functions 1139/1139 + parity, voice-agent prior + ≥6 new integration.
3. `runner-parity.mjs` 100% green on all `tests/scenarios/prescreen/*.yaml`.
4. Parity gate wired into `apps/functions/scripts/predeploy-smoke.mjs`.
5. Voice worker deployed to LK Cloud (`lk agent deploy`) and dials `+14243201960` once Adam-confirmed.
6. `.planning/VOICE-PRESCREEN-INTERFACE-HANDOFF.md` written summarizing changes + how the next agent change propagates.

## 9. The Single Hard Rule

**Any future change to prescreen agent behavior (questions, clarify wording, LLM model, lifecycle reducer, user-exit pattern) MUST land in Layer A only.** If a change requires editing both Layer B-SMS and Layer B-Voice, the interface is wrong — redesign before merge.
