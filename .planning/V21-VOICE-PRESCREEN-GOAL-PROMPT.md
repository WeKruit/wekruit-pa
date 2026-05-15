# V2.1 Voice Prescreen — P10 Goal Prompt (transcribed from /goal invocation 2026-05-15)

> Source: this file is the verbatim `/goal` body Adam fired on 2026-05-15. P10
> uses this as the operating contract for the whole v2.1 cycle. Anything not
> spelled out here is `[NEEDS-ADAM-LOCK]` until Adam confirms.

You are P10 lead for WeKruit v2.1 voice prescreen.

## Mission

Build OUTBOUND voice for existing pre-screen pipeline, ship to internal
dev/test smoke by Week 7. Do NOT modify agent-runtime or PreScreenPipeline.

- **v2.1 = outbound only, internal numbers only.**
- **Inbound + external + production launch = v2.2.**

## Required Reading (load before any sprint work)

1. `.planning/V21-VOICE-PRESCREEN-GOAL-PROMPT.md` (this file — locks, org, checklist, risk register, full spec)
2. `.planning/MILESTONE-v2.1-voice-prescreen.md` (sprints S0–S7, owners, worktrees, acceptance, regression gate)
3. `.planning/v2.1/research/*.md` (7 research files)
4. `.env.template`, `CLAUDE.md`, `README.md`, `AGENTS.md`, `.planning/AUTONOMOUS-SPRINT-HARNESS.md`

## Worktree Rules

- Every sprint: own worktree `.claude/worktrees/v21-S<N>-<slug>`, branch
  `claude/v21-S<N>-<slug>`, from updated `main`:
  ```bash
  git fetch origin && git checkout main && git pull --ff-only origin main
  git worktree add .claude/worktrees/v21-S<N>-<slug> -b claude/v21-S<N>-<slug> main
  ```
- **S1 = THREE parallel worktrees**: `S1A-runtime-stream`, `S1B-context-loaders`, `S1C-llm-shim`. Spawn 3 sub-agents, each own worktree.
- **S2** after S1A + S1C merged.
- **S3 + S4** parallel with S2.
- **S5** after S2 + S3 + S4 substantially done.
- **S6** parallel with S5.
- **S7** final.
- Cross-worktree edits forbidden. Atomic commits. NO `--no-verify`, NO force-push. `git worktree remove` AFTER merge.

## Per-sprint artifacts

Inside `.planning/v2.1/sprints/S<N>-<slug>/`:

- `CONTEXT.md` — what this sprint inherits + what it consumes
- `PLAN.md` — sprint-internal task graph
- `EXECUTOR-PLANS.md` — 6-element Task Prompts (Objective / Context / Constraints / Deliverables / Verification / Done-criteria)
- `ACCEPTANCE.md` — concrete pass criteria
- `SUMMARY.md` — what was delivered (filled at land time)

## Loop

`SYNC MAIN → CREATE WORKTREE → READ → SELECT → CONTEXT → PLAN → ASK EXECUTOR
PLANS → INTEGRATE → EXECUTE → VERIFY → SUMMARIZE → LAND → ADVANCE`

Waves A–E: schemas → services → UI → eval → cleanup.

## Regression Gate (before any merge to main)

- `pnpm --filter pa-orchestrator test`
- `pnpm --filter pa-functions test`
- `node tests/scenarios/runner-prescreen.mjs {pass,fail,hard-stop,pause}.yaml`

Full regression list lives in MILESTONE.

## Voice Stack

- STT: **Deepgram Nova-3**
- TTS: **Deepgram Aura-2** (Cartesia under eval, `CARTESIA_*` env pending)
- LLM: **`openai.LLM` plugin → `WEKRUIT_LLM_SHIM_URL`** (S1C output)
- VAD + turn detection: **Silero VAD + MultilingualModel**
- Telephony: **LiveKit Cloud SIP → Twilio Trunk `wekruit-prescreen-outbound`**
- Outbound caller IDs: `+14157075057`, `+16468594057`

## Key Locks (full 11 are P10-authoritative; the 7 below are the goal-body excerpt)

1. **agent-runtime frozen**; ADD `runAgentTurnStream` (new export only, no edit of existing exports)
2. **`PreScreenPipeline.runTurn` = single scoring source** (voice path consumes same scoring)
3. **PA profiles always LiveKit**; legacy Retell via per-profile flag
4. **TCPA = production gate NOT dev gate** (`PA_TCPA_GATE_ENFORCED=false` in dev)
5. **Identity bridge first** (`outbound-bookings.paUserId` / `paJobId`)
6. **No PII via voice** (SMS handoff for PII-laden questions)
7. **DO NOT hardcode `minEndpointingDelay`** — use adaptive turn model + register event handlers:
   - `user_speech_committed`
   - `conversation_item_added`
   - `agent_false_interruption`
   - `participant_disconnected`
   - `ErrorEvent`
   - `session_usage_updated`
   - `close`

> Locks 8–11: `[NEEDS-ADAM-LOCK]` — Adam to fill before S2 begins. Best-guess
> candidates (do NOT execute until Adam confirms):
> - L8 candidate: recording storage policy (`WEKRUIT_VOICE_RECORDINGS_BUCKET` lifecycle, consent capture)
> - L9 candidate: hangup reconciliation idempotency contract
> - L10 candidate: outbound-bookings state machine (queued → dialing → connected → completed → failed → reconciled)
> - L11 candidate: cost ceiling enforcement ($1/call hard stop + observable)

## Done Criteria (S7 ship-gate)

- All S0–S7 `SUMMARY.md` filled
- ≥ 8/10 internal smoke PASS (PA team + dev numbers)
- 0 PII leaks (audit recordings)
- p50 TTFA < 1.5s
- Cost per call < $1
- TCPA plumbing complete with flag off in dev / on in prod
- Turn telemetry: < 10% false-commit, < 5% false-interrupt
- Hangup reconciliation idempotent
- v2.2 hand-off doc (`.planning/v2.2/HANDOFF-from-v2.1.md`) listing what is intentionally deferred (inbound, external, prod launch)

## Steps (P10 boot sequence)

1. Verify artifacts:
   ```
   ls .planning/V21-VOICE-PRESCREEN-GOAL-PROMPT.md \
      .planning/MILESTONE-v2.1-voice-prescreen.md \
      .planning/v2.1/research/*.md
   ```
   Missing → STOP.
2. Verify `.env` creds:
   ```
   grep -E "^(LIVEKIT_(URL|API_KEY|API_SECRET)|TWILIO_SIP_(TRUNK_SID|TERMINATION_URI|USERNAME|PASSWORD)|TWILIO_OUTBOUND_CALLER_IDS|DEEPGRAM_API_KEY)=" .env
   ```
   Missing → STOP, tell Adam.
3. Spawn 3 parallel sub-agents for S1 (S1A/S1B/S1C). Each gets full read of this file + their MILESTONE sprint section + worktree commands + 6-element Task Prompt P10 authors + strict instruction: own worktree only, `AGENT_PLAN` before code.
4. Monitor S1. After all three merged, advance to S2.
5. STOP and ask Adam ONLY if credential or research file missing. Do NOT block on legal.

Begin.
