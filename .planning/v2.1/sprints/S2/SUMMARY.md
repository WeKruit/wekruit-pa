# S2 Voice Bridge — SUMMARY

> Sprint: v2.1 S2
> Branch: `claude/v21-S2-voice-bridge` (from `claude/v21-S0-foundation` after S1A+S1C merged)
> Worktree: `.claude/worktrees/v21-S2-voice-bridge` (removed post-merge)
> Status: Code-complete, tests green, integrated into `claude/v21-integration`.

## What landed

LiveKit Cloud-hosted agent worker bridging Deepgram STT → `PreScreenPipeline.runTurn` (single scoring source per L2) → Deepgram TTS. All 7 mandated LiveKit event handlers registered; no `minEndpointingDelay` hardcoded — adaptive `MultilingualModel` owns endpointing (L7).

| Commit | Subject |
|---|---|
| d119761 | chore(voice-agent): scaffold package with LiveKit Cloud agent hosting config |
| 1aa8306 | feat(voice-agent): L6 PII redaction handler + S1B-mirrored context types |
| bc67cdc | feat(voice-agent): turn loop bridging STT-commit → PreScreenPipeline.runTurn |
| 5d99b56 | feat(voice-agent): L7 event handlers — all 7 mandated events registered |
| 1c78411 | feat(voice-agent): L8 recording consent prompt (en/zh × casual/professional) |
| d9dd56c | feat(voice-agent): CLI + LiveKit worker bootstrap + lock-enforcement tests |

## Files added (`apps/voice-agent/`)

- `livekit.toml` — LK Cloud Agent manifest (L12: managed hosting only).
- `package.json` — `@livekit/agents` + plugins (`deepgram`, `silero`, `openai`); dynamic-imported in `startWorker()` so unit tests run without SDK install.
- `src/worker.ts` — main entry; loads context, builds `AgentSession` with `MultilingualModel` turn detection, registers all 7 event handlers, calls `session.start()`, fires-and-forgets `startRecordingEgress()`, speaks `buildConsentPrompt()` first.
- `src/turn-loop.ts` — bridge: `onUserCommit` → `pipeline.runTurn` (S1A `runAgentTurnStream` adapter via shim).
- `src/event-handlers.ts` — registers `user_speech_committed`, `conversation_item_added`, `agent_false_interruption`, `participant_disconnected`, `ErrorEvent`, `session_usage_updated`, `close`.
- `src/pii-handler.ts` — L6 redaction; voice path never speaks PII (SMS handoff only).
- `src/consent-prompt.ts` + `src/consent-audit.ts` — L8 recording disclosure with `lang × tone` matrix.
- `src/egress.ts` — `startRecordingEgress({roomName, bookingId})` (S6 wires GCS bucket).
- `src/cli.ts` — `voice-agent --help` + `start` entrypoint.
- `src/__tests__/*` — 10 test files including `no-min-endpointing.test.ts` (lock enforcement) + `no-self-host.test.ts` (L12 enforcement) + 7 handler tests.

## Locks held

- **L2** PreScreenPipeline.runTurn unchanged — `turn-loop.ts` calls it as black box.
- **L7** No `minEndpointingDelay` numeric anywhere — verified by `no-min-endpointing.test.ts`.
- **L8** Consent line spoken before any prescreen turn (`worker.ts:249-255`).
- **L12** LK Cloud managed hosting — verified by `no-self-host.test.ts` + `livekit.toml` ships agent manifest.

## Tests

`apps/voice-agent` test suite: 55/55 green at integration HEAD.

## Hand-off

S3 dials → S2 worker entrypoint fires per `outbound-bookings/{id}` room metadata. S5 TCPA gate runs ahead of dispatch. S6 smoke-driver writes test bookings against this worker.
