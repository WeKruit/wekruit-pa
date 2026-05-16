# S2 Voice Bridge — ACCEPTANCE

Sprint passes when ALL of the below are true and SUMMARY.md is written.

## Functional

- [ ] LiveKit Agent worker process exits 0 on `--help`.
- [ ] Worker connects to LiveKit room when dispatched, identifies as `voice-prescreen`.
- [ ] STT (Deepgram Nova-3) consumes microphone-track audio; transcripts surface on `user_speech_committed`.
- [ ] TTS (Deepgram Aura-2) plays agent reply audio.
- [ ] Turn loop: 1 user utterance → 1 `PreScreenPipeline.runTurn` invocation → 1 agent reply.
- [ ] Recording consent prompt plays as the first agent utterance (L8).
- [ ] Worker terminates gracefully on `participant_disconnected` and on uncaught `ErrorEvent`.

## Lock compliance

- [ ] L1 `agent-runtime` exports unchanged (no diff vs `claude/v21-S1A-runtime-stream` baseline).
- [ ] L2 `PreScreenPipeline.runTurn` is the only scoring call site invoked by the worker.
- [ ] L7 All 7 event handlers registered: `user_speech_committed`, `conversation_item_added`, `agent_false_interruption`, `participant_disconnected`, `ErrorEvent`, `session_usage_updated`, `close`.
- [ ] L7 No literal `minEndpointingDelay` constant in source.
- [ ] L12 Deployment target = LiveKit Cloud (no k8s manifest, no Dockerfile for self-host, no docker-compose).

## Regression gate

- [ ] `pnpm --filter pa-orchestrator test` green
- [ ] `pnpm --filter pa-functions test` green
- [ ] `node tests/scenarios/runner-prescreen.mjs pass.yaml` green
- [ ] `node tests/scenarios/runner-prescreen.mjs fail.yaml` green
- [ ] `node tests/scenarios/runner-prescreen.mjs hard-stop.yaml` green
- [ ] `node tests/scenarios/runner-prescreen.mjs pause.yaml` green
- [ ] New voice-agent package unit tests green

## Hand-off to S3/S4

- [ ] Worker exposes documented `bookingId` ingress via room metadata for S3 dial bridge.
- [ ] Worker exposes per-turn metric-event listener hook (no writer) for S4.
- [ ] SUMMARY.md captures the LiveKit Cloud deploy command for S6 smoke runs.
