# S2 Voice Bridge — EXECUTOR-PLANS (Task Prompt draft, refine post-S1)

> P10 will revise after S1A + S1C SUMMARY.md report concrete signatures.
> This is the 6-element prompt skeleton P10 hands to the S2 sub-agent.

## 6-Element Task Prompt — S2

### 1. Objective
Build the LiveKit Agents worker that bridges a SIP-connected outbound call to `PreScreenPipeline.runTurn`. The worker boots locally for dev and deploys to **LiveKit Cloud managed agent hosting**. Each user turn (committed via Silero VAD + MultilingualModel adaptive turn detection) becomes one `runTurn` invocation; the resulting agent text is streamed through the S1C shim and spoken via Deepgram Aura-2.

### 2. Context
- Locks (verbatim from `.planning/V21-VOICE-PRESCREEN-GOAL-PROMPT.md`):
  - L1 agent-runtime frozen; use S1A `runAgentTurnStream` only via the S1C shim.
  - L2 `PreScreenPipeline.runTurn` = single scoring source.
  - L3 PA profiles always LiveKit.
  - L6 No PII via voice (SMS handoff for any field that PreScreenPipeline marks PII-bearing).
  - L7 Adaptive turn model + register all 7 event handlers — NO `minEndpointingDelay` hardcode.
  - L8 Recording consent prompt at call start; storage `WEKRUIT_VOICE_RECORDINGS_BUCKET=wekruit-voice-recordings`.
  - L12 LiveKit deployment = **LiveKit Cloud only**.
- S1A shipped (2026-05-15): `runAgentTurnStream` exported from `@pa/agent-runtime` workspace (`packages/agent-runtime/`). S2 must set `PA_AGENT_RUNTIME_STREAM_ENABLED=true` in worker env. Stream pipes through S1C HTTP shim (NOT direct import in S2). Do not buffer chunks pre-TTS.
- Voice stack (locked): Deepgram Nova-3 STT + Aura-2 TTS, `openai.LLM` plugin → `WEKRUIT_LLM_SHIM_URL`, Silero VAD + MultilingualModel, LiveKit Cloud SIP → Twilio trunk `wekruit-prescreen-outbound`.
- Identity bridge (S0 → S3): room metadata carries `bookingId`; loaders S1B map `bookingId` → `paUserId` → user profile + `paJobId` → job brief + prescreen config.

### 3. Constraints
- NEW worker package (suggested path `apps/voice-agent/`); do NOT touch `apps/functions/`, `packages/pa-orchestrator/agent-runtime/`, or `PreScreenPipeline`.
- Agent entrypoint must be deployable to LiveKit Cloud (single Python or Node entry per LiveKit Cloud docs — pick whichever ecosystem maps to current repo language; if a fit doesn't exist, ship a new package).
- 7 event handlers MUST be registered. List by name in `AGENT_PLAN.md`; one test per handler that the registration occurred.
- Adaptive turn detection: configure `MultilingualModel` instance; assert in test that no literal `minEndpointingDelay` number appears in source.
- No outbound dial logic in S2 — S3 owns that.
- No metrics writes — only emit via S4-owned handler hooks (S4 lands later; S2 must expose a register-listener API).
- Atomic commits: worker bootstrap → STT/TTS wiring → turn loop → event handlers → tests.

### 4. Deliverables
- `apps/voice-agent/` (or chosen path) with worker entrypoint.
- LiveKit Cloud agent dispatch config (`livekit.toml` or equivalent).
- Local dev launcher script.
- Unit tests:
  - turn loop: mock STT-commit fires → mock loaders fed → mock shim called → response received → TTS called
  - 7 event handlers registered (1 test each)
  - no hardcoded endpointing-delay literal (lint-style check)
  - graceful close on `participant_disconnected`
  - graceful close on `ErrorEvent`
- Integration smoke (manual ok, document in SUMMARY): boot agent, dispatch to local LiveKit room, hear synthesized response from mock prescreen pipeline.
- `AGENT_PLAN.md` BEFORE code.
- `.planning/v2.1/sprints/S2/SUMMARY.md` on completion.

### 5. Verification
```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/v21-S2-voice-bridge
pnpm --filter pa-orchestrator test
pnpm --filter pa-functions test
node tests/scenarios/runner-prescreen.mjs pass.yaml
node tests/scenarios/runner-prescreen.mjs fail.yaml
node tests/scenarios/runner-prescreen.mjs hard-stop.yaml
node tests/scenarios/runner-prescreen.mjs pause.yaml
pnpm --filter voice-agent test   # or chosen filter
```
All green. NO `--no-verify`.

### 6. Done-criteria
- [ ] `AGENT_PLAN.md` first
- [ ] Worker boots locally, joins room
- [ ] LiveKit Cloud deploy doc'd (commands captured in SUMMARY)
- [ ] All 7 event handlers registered + tested
- [ ] No `minEndpointingDelay` literal
- [ ] Regression gate green
- [ ] Branch pushed
- [ ] SUMMARY.md filled
- [ ] Report to P10: branch, commits, deploy command, dial-readiness for S3
