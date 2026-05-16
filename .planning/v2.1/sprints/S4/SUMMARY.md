# S4 — Turn Telemetry + Cost Ceiling — SUMMARY

Branch: `claude/v21-S4-turn-telemetry`
Worktree: `.claude/worktrees/v21-S4-turn-telemetry`
Status: **DELIVERED** (awaiting S2 conformance + S6 smoke-gate consumer)
Date: 2026-05-15

## Commits

1. `7b7ee92` docs(v2.1/S4): AGENT_PLAN with VoiceCallTelemetryHook interface
2. `f67bf01` feat(voice/telemetry): VoiceCallTelemetryHook + lifecycle types (S2 contract)
3. `71690a8` feat(voice/telemetry): per-turn writer + lifecycle doc
4. `e1c8b8e` feat(voice/telemetry): $1/call cost ceiling watchdog (Lock L11)
5. `d03cd9a` feat(voice/telemetry): paAdminVoiceTelemetryAggregate callable + index wire

## What shipped

| Module | Purpose |
|---|---|
| `apps/functions/src/voice/telemetry/types.ts` | `VoiceCallTelemetryHook` interface (S2 contract), `VoiceTurnMetric`, `VoiceCallLifecycle`, `CostCeilingCallback`, L11 thresholds, TTL constant |
| `apps/functions/src/voice/telemetry/metricsWriter.ts` | `createTelemetryHookBundle` factory — hook + state-patch handle; writes `voice-call-metrics/{sid}` lifecycle doc and `voice-call-metrics/{sid}/turns/{i}` per-turn rows |
| `apps/functions/src/voice/telemetry/costCeiling.ts` | `createCostCeilingWatchdog` — decorates the writer hook with L11 state machine ($0.90 warn / $1.00 hard); fires the registered close-callback exactly once on ceiling-exceed |
| `apps/functions/src/voice/telemetry/aggregateQuery.ts` | `paAdminVoiceTelemetryAggregate` admin-gated callable + `runVoiceTelemetryAggregate` pure aggregator |
| `apps/functions/src/voice/telemetry/__tests__/*.test.ts` | 14 unit tests across 3 files, all green |
| `apps/functions/src/index.ts` | wires `paAdminVoiceTelemetryAggregate` export |
| `apps/functions/package.json` | adds `voice/telemetry/__tests__/*.test.ts` glob to functions test runner |

## Test results

- **S4 tests:** 14/14 green.
- **Full functions suite:** 1532/1532 green.
- **Orchestrator suite:** 1498/1498 green.
- **Prescreen scenarios:**
  - `pass.yaml` — PASS (3/3)
  - `pause.yaml` — PAUSE
  - `fail.yaml`, `hard-stop.yaml` — pre-existing baseline failures on the S0 parent branch (verified via `git stash`-baselining). S4 adds zero regressions.

## S2 hook interface (locked contract)

```ts
export interface VoiceCallTelemetryHook {
  onSessionStart(args: SessionStartArgs): Promise<void>
  onUserSpeechCommitted(args: UserSpeechCommittedArgs): void
  onAgentFirstAudio(args: AgentFirstAudioArgs): void
  onAgentTurnEnded(args: AgentTurnEndedArgs): Promise<void>
  onFalseInterruption(args: FalseInterruptionArgs): void
  onSessionUsageUpdated(args: SessionUsageUpdatedArgs): Promise<void>
  onSessionClose(args: SessionCloseArgs): Promise<void>
}

export type CostCeilingCallback = (args: {
  voiceCallSid: string
  reason: "cost_ceiling_exceeded"
  finalCostUsd: number
}) => void | Promise<void>
```

Full arg shapes in `apps/functions/src/voice/telemetry/types.ts`.

## S2 wiring recipe

```ts
const bundle = createTelemetryHookBundle({ db: getFirestore() })
const watchdog = createCostCeilingWatchdog({
  inner: bundle.hook,
  state: bundle.state,
})
watchdog.registerCloseCallback(voiceCallSid, async ({ finalCostUsd }) => {
  await gracefulHangup(voiceCallSid, finalCostUsd)
})

// Route LiveKit events into watchdog.hook (NOT bundle.hook directly):
session.on("user_input_transcribed", (e) => {
  if (e.is_final) {
    watchdog.hook.onUserSpeechCommitted({
      voiceCallSid, at: Date.now(), transcript: e.transcript,
    })
  }
})
session.on("agent_false_interruption", () =>
  watchdog.hook.onFalseInterruption({ voiceCallSid, at: Date.now() }),
)
session.on("session_usage_updated", async (e) => {
  const cost = computeCostFromUsage(e.usage.model_usage) // S2 rate-card math
  await watchdog.hook.onSessionUsageUpdated({
    voiceCallSid, at: Date.now(),
    runningCostUsd: cost,
    runningLlmTokensIn: sumTokensIn(e.usage.model_usage),
    runningLlmTokensOut: sumTokensOut(e.usage.model_usage),
    runningSttSeconds: sttSecs(e.usage.model_usage),
    runningTtsSeconds: ttsSecs(e.usage.model_usage),
  })
})
session.on("close", (e) =>
  watchdog.hook.onSessionClose({
    voiceCallSid, at: Date.now(),
    reason: e.reason === "cost_ceiling" ? "failed:cost_ceiling" : "completed",
  }),
)
```

LiveKit Agents Python is the runtime; S2 may need either a tiny TS shim
CF or an equivalent inline Firestore writer matching the schema in
`types.ts`. The schema is the canonical contract.

## Aggregate query response shape (S6 contract)

```ts
{
  windowMinutes: number
  callsConsidered: number
  turnsConsidered: number
  falseCommitPct: number | null      // Done-criteria target: < 10
  falseInterruptPct: number | null   // Done-criteria target: < 5
  ttfaP50Ms: number | null           // Done-criteria target: < 1500
  ttfaP95Ms: number | null
  avgCostUsd: number | null          // Done-criteria target: < 1.00
  costCeilingHits: number            // L11 enforcement counter
  agentTalkRatio: number | null      // 0..1
}
```

S6 reads via `paAdminVoiceTelemetryAggregate` (callable,
`{ windowMinutes: 60 }` typical). Empty window returns null thresholds +
zero counts so the gate can fall through gracefully on first runs.

## Firestore retention (Adam-action item, NOT code)

Per L8, default 90-day TTL on `voice-call-metrics`. Both lifecycle docs
and per-turn rows populate an `expiresAt` field. Console steps:

```
Firestore Console > TTL > Add Policy
  Collection group: voice-call-metrics       (and: voice-call-metrics/*/turns)
  Field: expiresAt
```

If Adam wants a different retention, change `VOICE_TELEMETRY_TTL_MS` in
`types.ts` and re-deploy. New rows pick up the new TTL; no migration.

## Lock compliance

- [x] **L11** cost ceiling enforced; close-callback fires exactly once at $1.00.
- [x] **No S2 worker source modified** — S2 doesn't exist yet; this sprint defined the interface S2 conforms to.
- [x] **No modification to `PreScreenPipeline.runTurn`**.
- [x] **agent-runtime not modified.**
- [x] Atomic commits (5).
- [x] No `--no-verify`. No force-push.

## Open follow-ups (NOT S4 scope)

- **S2 owner:** implement the hook in the LiveKit Cloud Agent. Either inline a Firestore writer matching the schema, or call a thin CF wrapper.
- **S6 owner:** read `paAdminVoiceTelemetryAggregate` for the smoke-gate thresholds.
- **Adam-action:** set Firestore TTL policy on `voice-call-metrics`.
- **v2.2:** PII redaction of `transcriptUser` / `transcriptAgent` before persist.
