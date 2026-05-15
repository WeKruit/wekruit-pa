# Milestone v2.1 — Voice Prescreen (Outbound, Internal Only)

> P10 lead: Claude (Opus 4.7, 1M context). Loop-driven autonomous sprint.
> Source contract: [`V21-VOICE-PRESCREEN-GOAL-PROMPT.md`](./V21-VOICE-PRESCREEN-GOAL-PROMPT.md).
> Status: **S0 IN PROGRESS** (foundation scaffold).
> Last refresh: 2026-05-15.

This milestone delivers **outbound voice prescreen** for existing WeKruit
candidates booked via `outbound-bookings`. Voice path produces the same
`PreScreenResult` shape (`PASS` / `NOT_PASS` / `PAUSE`) that text already
produces. **`agent-runtime` and `PreScreenPipeline.runTurn` MUST NOT be
modified.** Voice = a new transport that bridges into the existing scoring
brain.

## Scope (what ships in v2.1)

| Included | Excluded → v2.2 |
|---|---|
| Outbound call placement (LiveKit SIP → Twilio) | Inbound call answer |
| Internal dev/test phone numbers only | External candidate-facing launch |
| `runAgentTurnStream` new export, agent-runtime frozen | Any edit to existing agent-runtime exports |
| Voice path consuming `PreScreenPipeline.runTurn` verbatim | Alternative voice-only scoring |
| PA profiles → LiveKit always; Retell behind per-profile flag | Retell deprecation |
| TCPA plumbing complete, dev gate OFF, prod gate ON | Real TCPA-compliant production sends |
| Identity bridge: `outbound-bookings.paUserId` / `paJobId` | Cross-account voice merge |
| SMS handoff for PII collection | PII over voice |
| Turn telemetry (false-commit / false-interrupt rates) | Voice analytics dashboard |
| Hangup reconciliation idempotent | Multi-leg / transfer support |
| v2.2 hand-off doc | Production launch |

## Sprint Topology (S0–S7)

```
                  ┌────────────┐
                  │ S0 Foundation │ ← (this sprint) spec lock, env, identity
                  └──────┬─────┘
                         │ (merged)
        ┌────────────────┼────────────────┐
        │                │                │
   ┌────▼────┐      ┌────▼────┐     ┌────▼────┐
   │ S1A     │      │ S1B     │     │ S1C     │
   │ runtime │      │ context │     │ llm     │
   │ stream  │      │ loaders │     │ shim    │
   └────┬────┘      └────┬────┘     └────┬────┘
        │ (S1A merged)   │ (S1B merged)  │ (S1C merged)
        └──────┐         │       ┌───────┘
               │         │       │
               ▼         │       ▼
            ┌────────────▼────────┐
            │ S2 Voice Bridge     │ ← needs S1A + S1C
            │ (LiveKit agent +    │
            │  PreScreenPipeline) │
            └──────┬──────────────┘
                   │
        ┌──────────┼──────────┐
        │          │          │
   ┌────▼─────┐    │     ┌────▼─────┐
   │ S3 Twilio │   │     │ S4 Turn   │
   │ SIP /     │   │     │ Telemetry │
   │ Outbound  │   │     │ + Adaptive│
   │ Booking   │   │     │ VAD       │
   └────┬──────┘   │     └────┬──────┘
        │ (S2 + S3 + S4 substantially done)
        └──────────┬──────────┘
                   ▼
              ┌──────────┐         ┌──────────┐
              │ S5 TCPA  │ ◀────── │ S6 Smoke │
              │ + Compl. │   ║     │ + Recordg│
              └─────┬────┘   ║     └────┬─────┘
                    │   parallel       │
                    └────────┬─────────┘
                             ▼
                       ┌──────────┐
                       │ S7 Ship  │  → ≥8/10 PASS, Done-criteria, v2.2 handoff
                       └──────────┘
```

## Sprint Charters

### S0 — Foundation [IN PROGRESS]

- **Owner**: P10 (this loop)
- **Worktree**: `.claude/worktrees/v21-S0-foundation` → `claude/v21-S0-foundation`
- **Deliverables**:
  - `V21-VOICE-PRESCREEN-GOAL-PROMPT.md` (done)
  - `MILESTONE-v2.1-voice-prescreen.md` (this file)
  - `.planning/v2.1/sprints/S{0..7}/` skeletons
  - `.planning/v2.1/research/*.md` stubs (7 files, contents `[NEEDS-RESEARCH]` until S1 agents or Adam fill)
  - `.env` voice block (10 keys; LIVEKIT_API_SECRET, TWILIO_SIP_PASSWORD, DEEPGRAM_API_KEY still need Adam literal values)
  - Identity bridge schema sketch in S2 CONTEXT.md
- **Acceptance**: this file + GOAL-PROMPT.md committed on `claude/v21-S0-foundation`, regression gate green (no code touched so all should remain green), Adam approval to advance.

### S1A — runtime stream

- **Owner**: P8 sub-agent (P10 spawns)
- **Worktree**: `.claude/worktrees/v21-S1A-runtime-stream` → `claude/v21-S1A-runtime-stream`
- **Mandate**: Add `runAgentTurnStream` export to `packages/pa-orchestrator/src/agent-runtime/` that yields token-by-token output via async iterator. Do NOT modify any existing export. Behind feature flag `PA_AGENT_RUNTIME_STREAM_ENABLED=true` opt-in.
- **Acceptance**:
  - `pnpm --filter pa-orchestrator test` green
  - new test: `runAgentTurnStream emits token chunks` (≥3 chunks for a 50-token response)
  - existing `runAgentTurn` byte-identical output preserved (golden snapshot)
  - regression gate: scenario runner 4/4 PASS

### S1B — context loaders

- **Owner**: P8 sub-agent
- **Worktree**: `.claude/worktrees/v21-S1B-context-loaders` → `claude/v21-S1B-context-loaders`
- **Mandate**: Build typed context loaders for voice path — `loadUserProfileForVoice(userId)`, `loadJobBriefForVoice(jobId)`, `loadPrescreenConfigForVoice(jobId)`. Read-only Firestore reads, no writes. Output stable shape consumed by S2 voice bridge.
- **Acceptance**:
  - `pnpm --filter pa-functions test` green
  - new tests: 3 loaders × {happy path, missing doc, partial doc}
  - no edits to existing functions
  - regression gate green

### S1C — LLM shim

- **Owner**: P8 sub-agent
- **Worktree**: `.claude/worktrees/v21-S1C-llm-shim` → `claude/v21-S1C-llm-shim`
- **Mandate**: HTTP shim that LiveKit `openai.LLM` plugin can call, internally routes to `runAgentTurnStream`. Endpoint: `POST /v1/chat/completions` OpenAI-compatible. Env: `WEKRUIT_LLM_SHIM_URL`. Stateless; turn state lives in PreScreenPipeline.
- **Acceptance**:
  - shim binary boots, responds 200 to `openai.LLM` mock requests
  - chunked SSE matches OpenAI stream format
  - integration test: openai SDK → shim → fake runtime returns expected text
  - regression gate green

### S2 — voice bridge (needs S1A + S1C)

- **Owner**: P8 sub-agent
- **Worktree**: `.claude/worktrees/v21-S2-voice-bridge`
- **Mandate**: LiveKit Agents worker. Subscribes to room, uses Deepgram Nova-3 STT + Aura-2 TTS + Silero VAD + MultilingualModel. Each user_speech_committed → call `PreScreenPipeline.runTurn` (via context loaders + shim). NO new scoring logic.
- **Acceptance**:
  - voice agent boots locally, joins room, hears mock SIP participant
  - turn round-trip: user audio → STT → runTurn → shim → TTS audio out
  - registered all 7 mandated event handlers
  - no `minEndpointingDelay` hardcoded — adaptive turn model active
  - regression gate green

### S3 — Twilio SIP + outbound-bookings (parallel with S2)

- **Owner**: P8 sub-agent
- **Worktree**: `.claude/worktrees/v21-S3-twilio-sip-bookings`
- **Mandate**: Cloud Function `paVoiceDialOutbound` triggered on `outbound-bookings/{id}` state transition. Uses LiveKit Cloud SIP → Twilio trunk `wekruit-prescreen-outbound`. Caller ID rotation across `+14157075057` / `+16468594057`. Booking schema gains `paUserId`, `paJobId`, `voiceCallSid`, `voiceState`, `voiceStartedAt`, `voiceEndedAt`, `voiceOutcome`.
- **Acceptance**:
  - schema migration script idempotent
  - dial test against internal dev number succeeds end-to-end (no scoring yet)
  - hangup webhook reconciles booking row exactly once (replay-safe)
  - regression gate green

### S4 — turn telemetry + adaptive VAD (parallel with S2/S3)

- **Owner**: P8 sub-agent
- **Worktree**: `.claude/worktrees/v21-S4-turn-telemetry`
- **Mandate**: Emit per-turn metrics: false-commit rate, false-interrupt rate, TTFA, agent-talk-ratio, cost-per-call estimate. Wire `session_usage_updated` + `agent_false_interruption` handlers. Storage: `voice-call-metrics/{callSid}`.
- **Acceptance**:
  - 10-turn sim run produces ≥10 metric rows
  - dashboard query path returns aggregate (false-commit %, false-interrupt %, p50 TTFA)
  - regression gate green

### S5 — TCPA plumbing + compliance (needs S2 + S3 + S4)

- **Owner**: P8 sub-agent
- **Worktree**: `.claude/worktrees/v21-S5-tcpa-compliance`
- **Mandate**: TCPA gate plumbing complete; `PA_TCPA_GATE_ENFORCED` defaults to `false` in dev / `true` in prod. Gate checks: (1) DNC list, (2) state-quiet-hours, (3) prior consent record. Gate **blocking** when on, **observed-only** when off. Recording consent prompt at call start.
- **Acceptance**:
  - gate-on test blocks call when DNC matched
  - gate-off test logs would-block but allows
  - quiet-hours test for at least 3 US states
  - regression gate green

### S6 — internal smoke + recording archive (parallel with S5)

- **Owner**: P8 sub-agent
- **Worktree**: `.claude/worktrees/v21-S6-smoke-recordings`
- **Mandate**: Run 10 internal smoke calls (PA team + dev numbers). Each call: recording stored to GCS bucket `wekruit-voice-recordings`, transcript stored, scored via PreScreenPipeline. PII-leak audit script scans transcripts.
- **Acceptance**:
  - ≥8/10 smoke calls PASS (no agent crash, scoring produced, recording archived)
  - 0 PII leaks
  - p50 TTFA < 1.5s
  - cost per call < $1 (per S4 metrics)
  - regression gate green

### S7 — ship gate + v2.2 hand-off

- **Owner**: P10 (this loop)
- **Worktree**: `.claude/worktrees/v21-S7-ship`
- **Mandate**: Compile S0–S6 `SUMMARY.md` into v2.1 ship report. Author `.planning/v2.2/HANDOFF-from-v2.1.md` listing inbound, external, prod launch deferrals. Merge all `claude/v21-*` branches into `main` in dependency order. `git worktree remove` after each merge.
- **Acceptance**:
  - all 8 SUMMARY.md filled
  - all Done-criteria from GOAL-PROMPT.md confirmed
  - v2.2 hand-off doc reviewed
  - regression gate green
  - Adam ship approval

## Regression Gate (every sprint, before any merge to main)

```bash
# 1. orchestrator unit tests
pnpm --filter pa-orchestrator test

# 2. functions unit tests
pnpm --filter pa-functions test

# 3. prescreen scenario runner — all 4 paths
node tests/scenarios/runner-prescreen.mjs pass.yaml
node tests/scenarios/runner-prescreen.mjs fail.yaml
node tests/scenarios/runner-prescreen.mjs hard-stop.yaml
node tests/scenarios/runner-prescreen.mjs pause.yaml
```

Any red → merge BLOCKED. Investigate root cause. NO `--no-verify`.

## Risk Register

| Risk | Severity | Mitigation | Owner |
|---|---|---|---|
| `agent-runtime` regression from `runAgentTurnStream` addition | HIGH | Golden snapshot of existing `runAgentTurn` byte output; S1A reverts on diff | S1A |
| `PreScreenPipeline.runTurn` semantic drift in voice path | HIGH | Voice bridge calls `runTurn` verbatim with same arg shape; integration test compares text-vs-voice on identical input | S2 |
| LiveKit ↔ Twilio SIP misconfig blocks dial | MED | S3 includes Twilio trunk health probe + LiveKit SIP dispatch dry-run before first real dial | S3 |
| Turn detection false-commit floods scoring with partial answers | HIGH | Adaptive turn model (MultilingualModel) + `agent_false_interruption` handler; S4 metrics gate ≥10% false-commit triggers HITL | S4 |
| PII leaks through voice transcript | CRITICAL | SMS handoff for PII questions; transcript scan in S6; release blocked on 0 leaks | S6 |
| Hangup webhook replay causes double-scoring | HIGH | Idempotency key on `voice-call-metrics/{callSid}` + booking row CAS update | S3 |
| Cost per call exceeds $1 | MED | Per-turn cost estimate from `session_usage_updated`; S4 surfaces; S6 gate enforces | S4 / S6 |
| TCPA misconfiguration sends to consumer numbers | CRITICAL | Internal-only numbers in v2.1 allowlist `TWILIO_OUTBOUND_CALLER_IDS` recipients; gate enforced in prod | S5 |
| Cartesia eval introduces TTS regression | LOW | Aura-2 default; Cartesia behind separate per-profile flag; no in-cycle swap | S2 / S6 |

## Adam-action Outstanding

1. Paste literal values for `LIVEKIT_API_SECRET`, `TWILIO_SIP_PASSWORD`, `DEEPGRAM_API_KEY` into `.env` (P10 pre-staged placeholder lines).
2. Confirm or override the 4 candidate locks L8–L11 listed in GOAL-PROMPT.md.
3. Confirm or override sprint owner topology (currently all P8 sub-agents spawned by P10).
4. Approve research-file strategy (see S0 SUMMARY.md once written).
