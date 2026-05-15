# S2 Voice Bridge — CONTEXT

**Status:** PENDING. Blocked by S1A merge + S1C merge.
**Wave:** B (services).
**Worktree (to create):** `.claude/worktrees/v21-S2-voice-bridge` from `claude/v21-S1A-runtime-stream` merged with `claude/v21-S1C-llm-shim` (P10 integrates first).

## What S2 inherits

| Source sprint | Artifact | How S2 uses it |
|---|---|---|
| S1A | `runAgentTurnStream` export in `pa-orchestrator` agent-runtime | Indirect — voice bridge talks to LLM only through S1C shim |
| S1B | `loadUserProfileForVoice` / `loadJobBriefForVoice` / `loadPrescreenConfigForVoice` | Per-turn context assembly before `PreScreenPipeline.runTurn` |
| S1C | OpenAI-compatible LLM shim at `WEKRUIT_LLM_SHIM_URL` | Configures `openai.LLM(base_url=...)` LiveKit plugin |
| S0 | 12 confirmed locks, MILESTONE charter | Hard constraints |

## What S2 produces (consumed by S3/S4/S5)

- LiveKit Agent worker entrypoint, deployable to **LiveKit Cloud managed agent hosting (L12)**.
- Per-room session lifecycle bound to `outbound-bookings/{bookingId}` (identity bridge from S0 → S3).
- Per-turn flow: `user_speech_committed` → `PreScreenPipeline.runTurn(loaders, transcript)` → response chunked through shim → Aura-2 TTS → audio out.
- 7 event handlers wired (S0 GOAL-PROMPT lock L7): `user_speech_committed`, `conversation_item_added`, `agent_false_interruption`, `participant_disconnected`, `ErrorEvent`, `session_usage_updated`, `close`.
- Adaptive turn detection via Silero VAD + MultilingualModel — NO hardcoded `minEndpointingDelay`.

## What S2 explicitly does NOT do

- ❌ Place outbound calls — that is S3 (`paVoiceDialOutbound` CF on `outbound-bookings` transition).
- ❌ Emit telemetry metrics — that is S4 (event handlers fire, S2 just exposes the hook; S4 owns the writer).
- ❌ Enforce TCPA — that is S5.
- ❌ Modify `PreScreenPipeline.runTurn` — locked.

## Open questions for Adam at S2 spawn time

- Deployment region for LiveKit Cloud agent? (US east default unless Adam says otherwise.)
- Agent worker concurrency cap per LiveKit Cloud instance? (Default 1 if not set; revisit after S6 smoke.)
- Cartesia eval — start S2 with Aura-2 only and defer Cartesia swap to v2.2? (Default: yes.)
