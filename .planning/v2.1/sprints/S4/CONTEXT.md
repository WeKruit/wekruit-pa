# S4 Turn Telemetry + Cost Ceiling — CONTEXT

**Status:** PENDING. Parallel with S2/S3.
**Wave:** B (services).
**Worktree (to create):** `.claude/worktrees/v21-S4-turn-telemetry`.

## What S4 inherits

| Source | Artifact | Use |
|---|---|---|
| S2 | Per-turn event-listener hook on voice worker | Subscribe (not modify) |
| S3 | `voiceCallSid` on booking row | Join key for metrics |
| S0 lock L11 | $1/call hard stop via `session_usage_updated` aggregation | Cost ceiling implementation |
| S0 Done-criteria | <10% false-commit, <5% false-interrupt thresholds | Aggregate thresholds |

## What S4 produces

- `voice-call-metrics/{voiceCallSid}` Firestore collection schema.
- Metric writer (subscriber on S2's event-listener hook).
- Cost-ceiling watchdog (when running aggregate cost crosses $0.90 → emit `cost_ceiling_warning`; cross $1.00 → emit `cost_ceiling_exceeded` → S2 worker hangs up gracefully via L11).
- Aggregate dashboard query path: `getVoiceTurnTelemetryAggregate({windowMinutes})` returns false-commit %, false-interrupt %, p50/p95 TTFA, avg cost/call, agent-talk-ratio.

## Per-turn metric row shape (proposed)

```ts
{
  voiceCallSid: string,
  turnIndex: number,            // 0-based within the call
  startedAt: Timestamp,
  endedAt: Timestamp,
  ttfaMs: number,               // time from user_speech_committed to first agent audio
  userUtteranceMs: number,
  agentResponseMs: number,
  falseCommit: boolean,         // committed but user kept talking
  falseInterruption: boolean,   // agent spoke during user turn
  costUsd: number,              // attributed slice of session_usage_updated
  llmTokensIn: number,
  llmTokensOut: number,
  sttSeconds: number,
  ttsSeconds: number,
}
```

## What S4 explicitly does NOT do

- ❌ Place / dial calls — S3.
- ❌ Modify voice worker — only subscribes to S2's exposed hook.
- ❌ Drive scoring — `PreScreenPipeline.runTurn` is locked.
- ❌ Build operator dashboard UI — operator can read aggregate query; UI is v2.2.
