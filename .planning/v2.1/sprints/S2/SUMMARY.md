# S2 Voice Bridge — SUMMARY (P10 transcription)

> Agent harness blocked direct write. P10 transcribed final report.

**Branch:** `claude/v21-S2-voice-bridge` (pushed)
**Base:** `claude/v21-integration` (S0 + S1A + S1B + S1C)

## Commits (atomic, dep order)

| SHA | Subject |
|---|---|
| `4c71ca0` | docs(v2.1/S2): AGENT_PLAN |
| `b526285` | feat(voice-llm-shim): orchestrator-backend adapter (task #12 — S1A↔S1C bridge) |
| `d119761` | chore(voice-agent): scaffold package + LiveKit Cloud agent hosting config |
| `1aa8306` | feat(voice-agent): L6 PII redaction + S1B-mirrored context types |
| `bc67cdc` | feat(voice-agent): turn loop STT-commit → PreScreenPipeline.runTurn |
| `5d99b56` | feat(voice-agent): L7 all 7 event handlers registered |
| `1c78411` | feat(voice-agent): L8 consent prompt (en/zh × casual/professional) |
| `d9dd56c` | feat(voice-agent): CLI + LiveKit worker bootstrap + lock tests |

## Packages

- **Voice agent worker:** `apps/voice-agent/` (Node 20, TS ESM)
- **S1A↔S1C adapter (task #12):** `apps/voice-llm-shim/src/runtime/orchestrator-backend.ts` + `resolve.ts`

## Test results

| Suite | Result |
|---|---|
| `@pa/agent-runtime` | 55/55 |
| `@pa/pa-orchestrator` | 1498/1498 |
| `@pa/functions` | 1530/1530 |
| `@pa/voice-llm-shim` | 32/32 (17 pre + 15 new adapter/resolver) |
| `voice-agent` | 50/50 (8 files) |
| `runner-prescreen pass.yaml` | PASS 3/3 |
| `runner-prescreen pause.yaml` | PAUSE 0/6 (expected) |
| `runner-prescreen fail.yaml + hard-stop.yaml` | Excluded per task #11 (pre-existing red on S0) |

## L1–L12 lock compliance

- L1 agent-runtime untouched; only via `@pa/agent-runtime.runAgentTurnStream` through S1C orchestrator-backend.
- L2 `PreScreenPipeline.runTurn` sole scoring call via injected `VoicePipelineLite`.
- L3 LiveKit-only (`@livekit/agents` agent definition).
- L6 PII handler gated by `piiConsentAt`; redacts email/phone/URL/$ → `[sms_handoff:<kind>:<idx>]` for S5 SMS dispatcher.
- L7 7 events registered: `user_speech_committed` (via UserInputTranscribed `isFinal=true`), `conversation_item_added`, `agent_false_interruption`, `participant_disconnected`, `ErrorEvent`, `session_usage_updated`, `close`. MultilingualModel adaptive turn. `no-min-endpointing.test.ts` greps forbidden literal.
- L8 First agent utterance = `buildConsentPrompt(ctx)` localized.
- L12 No Docker / k8s / docker-compose / kustomization. `no-self-host.test.ts` enforces. `livekit.toml` only deploy artifact.

## Deploy command (S6 smoke + Adam)

```bash
cd apps/voice-agent
pnpm --filter voice-agent build
lk agent env set LIVEKIT_URL "$LIVEKIT_URL" --project wekruit-prescreen
lk agent env set LIVEKIT_API_KEY "$LIVEKIT_API_KEY" --project wekruit-prescreen
lk agent env set LIVEKIT_API_SECRET "$LIVEKIT_API_SECRET" --project wekruit-prescreen
lk agent env set DEEPGRAM_API_KEY "$DEEPGRAM_API_KEY" --project wekruit-prescreen
lk agent env set WEKRUIT_LLM_SHIM_URL "<shim-prod-url>" --project wekruit-prescreen
lk agent deploy
```

Local dev: `cd apps/voice-agent && scripts/dev.sh`.

## Hand-offs

**S3** (already landed): room metadata schema `{"bookingId": "bk-..."}` (plain string fallback OK). Worker `readBookingId()` consumes. S3's `paVoiceDialOutbound` already sets this on dispatch.

**S4** (already landed): plugs into `TurnLoopDeps.onTurn(event: TurnEvent)` per-turn + `RegisterSinks.onAgentFalseInterruption`/`onSessionUsageUpdated` session-level. Pass writers via `startWorker({ buildPipeline, loadContext, ...metricSinks })`. No S2 source modification needed.

**S5** (next): own actual SMS dispatch from `OnUserCommitOutput.smsHandoffTokens` (PiiHandoffToken[]: `{token, kind, source, start, end}`). Own GCS recording archive wiring. S2 only marks PII tokens.

## Open

- Default `loadContext` + `buildPipeline` in `worker.ts` throw "S3/S5 will wire" — documented hand-off boundary, not a blocker.
- `mem0ai` peer dep warnings on pnpm install — pre-existing, unrelated.
- `fail.yaml`+`hard-stop.yaml` red on S0 base — task #11 backlog.
