# S4 — AGENT_PLAN (P8 executor)

Owner: P8 sub-agent (this worktree)
Worktree: `.claude/worktrees/v21-S4-turn-telemetry`
Branch: `claude/v21-S4-turn-telemetry` (off `claude/v21-S0-foundation`)
Date: 2026-05-15

## 1. Objective restatement

Capture per-turn voice telemetry into `voice-call-metrics/{voiceCallSid}` and
enforce the $1/call cost ceiling (L11). Provide an aggregate query callable
that returns false-commit %, false-interrupt %, p50/p95 TTFA, avg cost/call
for an N-minute window. Must not touch S2 voice worker source — S2 will
import the hook interface defined here.

## 2. Inheritance & dependencies

S2 voice worker has not landed yet. S4 must:

- Define `VoiceCallTelemetryHook` interface that the S2 LiveKit Cloud Agent
  will conform to at start-of-call.
- Build the writer + cost ceiling + aggregate query against that interface
  with no runtime coupling to S2.
- Document the hook interface clearly so S2 can wire `session.on(...)`
  pass-throughs.

Inputs (from S0/S2/S3, used at runtime):

| Field | Source | Use |
|---|---|---|
| `voiceCallSid` | S3 booking row, also LiveKit room name | Firestore doc id |
| `paUserId` / `paJobId` | S3 identity bridge | Joined for aggregate query filters |
| `session_usage_updated` event | LiveKit Cloud Agent (S2 forwards) | Cost aggregation source |
| `agent_false_interruption` event | LiveKit Cloud Agent (S2 forwards) | False-interrupt flag |
| `user_input_transcribed` final + agent first-audio | S2 derives, exposes as `userSpeechCommitted` + `agentFirstAudio` callbacks | TTFA computation |
| `conversation_item_added` | S2 forwards | Turn boundary + transcript metadata |
| `close` | S2 forwards | Finalize call-level aggregate |

(Note: `user_speech_committed` was the v0 event name. LiveKit v1 emits
`user_input_transcribed` with `is_final`. S2 will normalize whichever it
uses and emit `userSpeechCommitted` to our hook — the hook stays stable
across LiveKit SDK versions.)

## 3. Public interface for S2 (lock for cross-sprint contract)

`apps/functions/src/voice/telemetry/types.ts` exports:

```ts
export interface VoiceTurnMetric {
  voiceCallSid: string
  turnIndex: number               // 0-based within the call
  startedAt: number               // unix ms
  endedAt: number                 // unix ms
  ttfaMs: number | null           // user_speech_committed -> first agent audio
  userUtteranceMs: number | null
  agentResponseMs: number | null
  falseCommit: boolean            // user kept talking after STT commit
  falseInterruption: boolean      // agent_false_interruption fired this turn
  costUsd: number                 // turn slice of session_usage_updated
  llmTokensIn: number
  llmTokensOut: number
  sttSeconds: number
  ttsSeconds: number
  transcriptUser: string | null   // optional, may be PII-redacted
  transcriptAgent: string | null
}

export interface VoiceCallLifecycle {
  voiceCallSid: string
  paUserId: string | null
  paJobId: string | null
  startedAt: number
  endedAt: number | null
  turnCount: number
  totalCostUsd: number
  status: "in_progress" | "completed" | "failed:cost_ceiling" | "failed:other"
}

/**
 * The runtime hook S2 wires up at start-of-call. S2 calls these methods in
 * response to LiveKit `session.on(...)` events; S4 owns the actual Firestore
 * writes + watchdog logic.
 */
export interface VoiceCallTelemetryHook {
  /** Called once when the agent session starts. */
  onSessionStart(args: {
    voiceCallSid: string
    paUserId: string | null
    paJobId: string | null
    startedAt: number
  }): void

  /** Final STT segment for the current user turn. */
  onUserSpeechCommitted(args: {
    voiceCallSid: string
    at: number
    transcript: string | null
  }): void

  /** Earliest agent audio sample for current turn. */
  onAgentFirstAudio(args: {
    voiceCallSid: string
    at: number
  }): void

  /** Agent finished speaking (TTS end), turn closes. */
  onAgentTurnEnded(args: {
    voiceCallSid: string
    at: number
    transcript: string | null
    sttSeconds: number
    ttsSeconds: number
    llmTokensIn: number
    llmTokensOut: number
  }): void

  /** agent_false_interruption event from LiveKit. */
  onFalseInterruption(args: {
    voiceCallSid: string
    at: number
  }): void

  /** session_usage_updated event from LiveKit (running totals). */
  onSessionUsageUpdated(args: {
    voiceCallSid: string
    at: number
    runningCostUsd: number     // S2 computes from model_usage list + rate card
    runningLlmTokensIn: number
    runningLlmTokensOut: number
    runningSttSeconds: number
    runningTtsSeconds: number
  }): Promise<void>

  /** close event from LiveKit. */
  onSessionClose(args: {
    voiceCallSid: string
    at: number
    reason: "completed" | "failed:cost_ceiling" | "failed:other"
  }): Promise<void>
}

/**
 * Adam-locked cost ceiling helper. S2 calls `registerCostCeilingCallback`
 * at session start; ceiling watchdog invokes the callback exactly once when
 * cost crosses $1.00. S2 then performs the graceful hangup.
 */
export type CostCeilingCallback = (args: {
  voiceCallSid: string
  reason: "cost_ceiling_exceeded"
  finalCostUsd: number
}) => void | Promise<void>
```

S2 instantiates ONE hook + ONE callback at room start, holds it for the
session, and tears down at close.

## 4. Module layout

```
apps/functions/src/voice/telemetry/
  types.ts                       # interfaces above
  metricsWriter.ts               # createTelemetryHook factory
  costCeiling.ts                 # createCostCeilingWatchdog factory
  aggregateQuery.ts              # paAdminVoiceTelemetryAggregate callable CF
  __tests__/
    metricsWriter.test.ts
    costCeiling.test.ts
    aggregateQuery.test.ts
```

Firestore layout:

- `voice-call-metrics/{voiceCallSid}` — call-level lifecycle doc (`VoiceCallLifecycle` shape).
- `voice-call-metrics/{voiceCallSid}/turns/{turnIndex}` — per-turn `VoiceTurnMetric` rows.

Default retention: 90 days TTL (per L8). Field for TTL: `expiresAt` on
both docs; collection-level TTL policy set as Firestore-config note in
SUMMARY.md (Adam-action item — not a code task).

## 5. Cost ceiling design

L11: $1/call hard stop. Behavior:

- `onSessionUsageUpdated` always carries the running total cost (S2 sums
  the `session_usage_updated.usage.model_usage[]` list against rate card).
- Watchdog evaluates `runningCostUsd`. State machine:
  - `< $0.90` → no signal.
  - `>= $0.90 && < $1.00` → emit `voice-call-metrics/{sid}.costWarningAt`
    + log once. Idempotent (already-warned flag).
  - `>= $1.00` → invoke `CostCeilingCallback` exactly once, mark
    `costExceededAt`, set lifecycle `status="failed:cost_ceiling"`.
- Idempotency: callback fires at most once per call even if duplicate
  `session_usage_updated` events arrive with cost > $1.

## 6. TTFA computation

For each turn:

1. `onUserSpeechCommitted` records `userSpeechCommittedAt`.
2. `onAgentFirstAudio` records `agentFirstAudioAt`.
3. `ttfaMs = agentFirstAudioAt - userSpeechCommittedAt` (clamped >= 0).
4. If `onFalseInterruption` fires BETWEEN commit and first audio, mark
   `falseCommit=true` for that turn (the STT commit was premature — user
   kept talking and the agent had to back off).
5. `onAgentTurnEnded` flushes the turn row to
   `voice-call-metrics/{sid}/turns/{turnIndex}`.

## 7. Aggregate query

`paAdminVoiceTelemetryAggregate({ windowMinutes })` callable, admin-claim
gated using `authorizeAdminCallable` from `promote-sandbox-tag.ts`.

Returns:

```ts
{
  windowMinutes: number,
  callsConsidered: number,
  turnsConsidered: number,
  falseCommitPct: number,       // 0..100
  falseInterruptPct: number,    // 0..100
  ttfaP50Ms: number | null,
  ttfaP95Ms: number | null,
  avgCostUsd: number | null,
  costCeilingHits: number,
  agentTalkRatio: number | null // total agentResponseMs / (agentResponseMs + userUtteranceMs)
}
```

Reads call docs first (filter by `startedAt >= now - windowMs`), then
gathers turn subcollections in parallel for the matching calls. Caps:
read at most 1000 calls per query, return null thresholds if zero
samples (S6 smoke gate then knows to fall through).

## 8. Test plan (all listed in done-criteria)

`metricsWriter.test.ts`:

1. Persists one row per turn for 10-turn mock.
2. Computes TTFA from commit-time → first-agent-audio.
3. Records `falseCommit=true` when `agent_false_interruption` arrives
   between commit and first audio.
4. Persists call-level lifecycle doc with cumulative turnCount and
   totalCostUsd.

`costCeiling.test.ts`:

5. Warns at $0.90 (sets `costWarningAt` exactly once).
6. Triggers close-callback at $1.00.
7. Idempotent across duplicate `session_usage_updated` deliveries.

`aggregateQuery.test.ts`:

8. Returns false-commit %, false-interrupt %, p50/p95 TTFA, avg cost.
9. Rejects non-admin caller (HttpsError permission-denied).
10. Returns null thresholds + zero counts when no rows in window.

## 9. Commit slicing (atomic)

1. Types + AGENT_PLAN.md — pure interface + plan, no impl.
2. metricsWriter + lifecycle doc + per-turn writer + 4 unit tests.
3. costCeiling watchdog + 3 unit tests.
4. aggregateQuery callable + admin gate + 3 unit tests + wire into
   `apps/functions/src/index.ts` export.
5. SUMMARY.md + push.

No `--no-verify`. No force-push. Predeploy gate must stay green.

## 10. Verification commands (S4 sprint)

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/v21-S4-turn-telemetry
pnpm --filter pa-orchestrator test
pnpm --filter pa-functions test
node tests/scenarios/runner-prescreen.mjs pass.yaml
node tests/scenarios/runner-prescreen.mjs fail.yaml
node tests/scenarios/runner-prescreen.mjs hard-stop.yaml
node tests/scenarios/runner-prescreen.mjs pause.yaml
```

All green. NO `--no-verify`.

## 11. S2 hand-off note (to be repeated in SUMMARY.md)

S2 owners: at room start, build hook + callback once. Wire LiveKit events:

```python
hook = VoiceCallTelemetryHook(...)  # imported from telemetry package OR rebuilt as RPC client
ceiling_close = build_close_callback(...)
register_cost_ceiling_callback(voiceCallSid, ceiling_close)

session.on("user_input_transcribed", lambda e: hook.onUserSpeechCommitted({
  voiceCallSid, at=now_ms(), transcript=e.transcript if e.is_final else None
}) if e.is_final else None)
session.on("agent_false_interruption", lambda e: hook.onFalseInterruption({...}))
session.on("session_usage_updated", lambda e: hook.onSessionUsageUpdated({
  voiceCallSid, at=now_ms(), runningCostUsd=compute_cost(e.usage.model_usage), ...
}))
session.on("conversation_item_added", route_to_user_or_agent_turn_end)
session.on("close", lambda: hook.onSessionClose({..., reason=...}))
```

Functions-side hook impl is TypeScript; S2 (Python LiveKit Agent) calls
the hook either by (a) inlining a thin Firestore writer with the same
schema, or (b) calling a small CF that wraps the writer. S2 owners pick;
this S4 deliverable provides the canonical schema + TypeScript writer +
watchdog so the data shape is locked.
