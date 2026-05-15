# S4 Turn Telemetry + Cost Ceiling — SUMMARY (P10 transcription)

> Agent harness blocked direct write. P10 transcribed final report.

**Branch:** `claude/v21-S4-turn-telemetry` (pushed)
**Base:** `claude/v21-S0-foundation`

## Commits (6)

| SHA | Subject |
|---|---|
| `7b7ee92` | AGENT_PLAN + S2 hook interface design doc |
| `f67bf01` | `VoiceCallTelemetryHook` + lifecycle types |
| `71690a8` | per-turn `metricsWriter` + 6 tests |
| `e1c8b8e` | $1/call cost ceiling watchdog (L11) + 4 tests |
| `d03cd9a` | `paAdminVoiceTelemetryAggregate` admin callable + 4 tests + index wire |
| `fd11dde` | SUMMARY.md |

## S2 hook interface (locked)

```ts
interface VoiceCallTelemetryHook {
  onSessionStart(args): Promise<void>;
  onUserSpeechCommitted(args): void;
  onAgentFirstAudio(args): void;
  onAgentTurnEnded(args): Promise<void>;
  onFalseInterruption(args): void;
  onSessionUsageUpdated(args): Promise<void>;
  onSessionClose(args): Promise<void>;
}
type CostCeilingCallback = (args: {
  voiceCallSid: string;
  reason: "cost_ceiling_exceeded";
  finalCostUsd: number;
}) => void | Promise<void>;
```

S2 instantiates via `createTelemetryHookBundle({ db })` + `createCostCeilingWatchdog({ inner, state })`. Wires LiveKit events into `watchdog.hook.*`. Full arg shapes in `apps/functions/src/voice/telemetry/types.ts`.

## S6 aggregate query response shape (locked)

```ts
{
  windowMinutes, callsConsidered, turnsConsidered,
  falseCommitPct,     // target < 10
  falseInterruptPct,  // target < 5
  ttfaP50Ms,          // target < 1500
  ttfaP95Ms,
  avgCostUsd,         // target < 1.00
  costCeilingHits,    // L11 enforcement counter
  agentTalkRatio,
}
```

S6 invokes `paAdminVoiceTelemetryAggregate({ windowMinutes: 60 })`. Empty window → null thresholds + zero counts (graceful gate fallthrough).

## Test summary

- S4 unit tests: 14/14 green
- `@pa/functions`: 1532/1532 green
- `@pa/pa-orchestrator`: 1498/1498 green
- `runner-prescreen` pass.yaml + pause.yaml ✓; fail.yaml + hard-stop.yaml red on S0 base (task #11 — NOT S4-caused)

## Lock compliance

- **L11** cost ceiling enforced — close-callback fires exactly once at $1.00
- No S2 worker source touched (S2 not yet landed; defined the contract instead)
- No `PreScreenPipeline.runTurn` modification
- No `agent-runtime` modification (L1)
- Atomic commits, no `--no-verify`, no force-push

## Adam-action

- Set Firestore TTL on `voice-call-metrics` collection + `voice-call-metrics/*/turns` subcollection, field `expiresAt`. Default 90 days per L8 (`VOICE_TELEMETRY_TTL_MS` constant in `types.ts`).
