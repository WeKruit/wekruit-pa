# v2.2 Voice — Pattern-Integration Handoff Prompt (Adam → next P10)

**Status:** READY for /goal invocation.
**Predecessor:** v2.1 internal smoke shipped 2026-05-16 (one live PSTN call validated end-to-end audio loop: dial → Twilio → LK Cloud → agent worker → Deepgram STT → openai.LLM-plugin → voice-llm-shim → Deepgram TTS → hangup). Plumbing proven. Real-pattern integration deferred to v2.2 per Adam directive.
**Owner of v2.2:** next P10 lead.

---

## Adam directive (2026-05-16)

> "i can hear it now. but I think the agent is not doing the right thing... give me a handoff prompt & merge everything gracefully to main so I can have the integration for each pattern in audio? Right now it's live but it's not running the actual integration with the pattern that we've had in the sms, long/short term memory / job prescreen / onboard / layoff onboard etc."

Verbatim Chinese paraphrase for record: **C-端 voice 必须复用 SMS 端已经成型的 4 套 pattern**：

1. **Job pre-screen** (PreScreenPipeline.runTurn, lock L2 single scoring source)
2. **Layoff onboarding** (Claire layoff CF, pa-orchestrator layoff sessions)
3. **General candidate onboarding** (Level 1 PII pipeline, mergeUserTags, resume-parser v2)
4. **Long + short term memory** (mem0 + sessionMemory + iMessage thread mem0 hooks)

**No new pipelines.** Voice = transport layer that swaps Sendblue iMessage for LiveKit + Deepgram + Twilio SIP. Conversation runtime + reducer + scoring + memory + tags = same code path as SMS.

---

## Current state (what v2.1 leaves you)

### Working end-to-end (proven via live call to +14243201960)

| Component | Status | Evidence |
|---|---|---|
| Outbound SIP dial via Twilio | ✅ | callSid `SCL_ZPnW3LPTpKXS` |
| LK Cloud outbound trunk | ✅ | `ST_DM7SuwYmgXKV` (created via `lk sip outbound create`) |
| Agent worker registration (`cli.runApp` pattern) | ✅ | workerId `AW_o43aCmCMNtqY` via `apps/voice-agent/src/live-smoke-agent.ts` |
| Deepgram Nova-3 STT | ✅ | "Yeah. I can hear you." captured |
| openai.LLM plugin → voice-llm-shim → fake/echo backend | ✅ | "echo: Yeah. I can hear you." replied |
| Deepgram Aura-2 TTS | ✅ | aura-2-thalia-en voice heard by Adam |
| Silero VAD endpointing | ✅ | EOU detected, 316ms preemptive lead time |
| Participant disconnect → session.close | ✅ | CLIENT_INITIATED hangup at +52s |
| Firestore `outbound-bookings` schema (paUserId / paJobId / phoneE164 / voiceState reducer) | ✅ | L10 state machine + idempotent reducer |
| TCPA gate plumbing (dev observe-mode, prod enforce-mode) | ✅ | S5 4 checks (DNC, quiet-hours, consent, mode) + audit |
| Cost-ceiling watcher ($1/call) | ✅ | S4 telemetry |
| Hangup webhook (`paVoiceSipWebhook`) | ✅ deployed | URL `https://us-central1-wekruit-5f89b.cloudfunctions.net/paVoiceSipWebhook` |

### Known v2.1 sharp edges → v2.2 to fix

1. **`apps/voice-agent/src/worker.ts` never registers as a worker** — `startWorker()` calls `defineAgent` but skips `cli.runApp(new WorkerOptions({...}))`. As shipped, the production worker file is unreachable from LK Cloud dispatch. v2.1 paved over this with `live-smoke-agent.ts` for plumbing validation. **v2.2 must graft `cli.runApp` onto the real worker.**
2. **LK Cloud webhook → `paVoiceSipWebhook` not wired**, so `outbound-bookings.voiceState` stays `dialing` even after a successful call. Reconciliation runs only when the agent worker writes its own metric row. Need LK Cloud dashboard / `lk` SIP webhook config to point at `https://us-central1-wekruit-5f89b.cloudfunctions.net/paVoiceSipWebhook` with header `X-Wekruit-Voice-Webhook-Secret: 6461ff28a67081525c3b756a9175713186471d1638e261c5bebf76870f2e9a4a`.
3. **No GCS recording bucket** — `WEKRUIT_VOICE_RECORDINGS_BUCKET=wekruit-voice-recordings` set in env but `gsutil mb gs://wekruit-voice-recordings -p wekruit-5f89b -l us-central1` not run. Egress is fire-and-forget so calls don't fail, but recordings aren't captured. Pure adam-action: 1 `gsutil` command.
4. **voice-llm-shim still on `WEKRUIT_LLM_SHIM_BACKEND=fake`** (echo). Switching to `orchestrator` requires firebase-admin auth on the shim process + `PA_AGENT_RUNTIME_STREAM_ENABLED=true`. Shim was test-passed against orchestrator backend in unit tests but never exercised live.
5. **Adaptive turn detection (L7 lock)** — `@livekit/agents@1.4.2` does **NOT** export `voice.MultilingualModel`. The original `worker.ts` referenced it. live-smoke-agent dropped it. v2.2 needs to either upgrade `@livekit/agents` to a version that ships MultilingualModel (≥1.6.x?), or remove the L7 lock requirement and document Silero VAD as the endpointing policy.
6. **Live-smoke harness coverage** — only **1/10** scenarios executed (the happy-path-pass via echo backend). 9 scenarios still pending. Mock-mode 10/10 PASS in `.planning/v2.1/sprints/S6/SMOKE-REPORT.md` is the only existing aggregate metric.

---

## v2.2 mission (≤ 5 sprints)

**Goal:** Voice transport runs the SAME conversation patterns SMS already runs. Adam can pick up a Twilio-dialed call and have Claire conduct: (a) a job prescreen with PASS/PAUSE/FAIL terminal + memory write-back, (b) a layoff onboarding session, (c) a general Level-1 onboarding session — all using the existing PreScreenPipeline, Claire layoff CF, mergeUserTags, mem0, sessionMemory infrastructure.

**Locked invariants:**

- **L0 (NEW)** Voice is a transport, not a pipeline. Adding a "voice-specific" reducer or "voice-specific" prescreen-config schema = automatic rollback. The reducer is reused; only the *input adapter* (STT-committed transcripts → existing inbound-message shape) and *output adapter* (orchestrator reply → TTS chunks) are new.
- **L2** PreScreenPipeline.runTurn unchanged (v2.1 lock, carried forward).
- **L7** adaptive endpointing — re-evaluate after SDK upgrade.
- **L8** consent disclosure spoken first (existing live-smoke-agent does this implicitly via `session.say()` before any prescreen turn; new worker must call `buildConsentPrompt(callContext)` then `emitConsentSpokenAudit`).
- **No PII via voice channel** (L6, v2.1). When PreScreenPipeline hits a PII-collection turn, voice path must hand off to SMS for the actual answer capture — `triggerSmsHandoff(bookingId, phoneE164, reason)` writes an `imessage-out` doc and the agent says "I'll text you the link to fill that in." Same iMessage delivery infra as today.
- **PA_AGENT_RUNTIME_STREAM_ENABLED=true** on the shim process. The S1A streaming adapter is the only sanctioned way to drive turns. Direct `PreScreenPipeline.runTurn(...)` from inside the agent worker is forbidden — must go through the shim → S1A adapter → runtime.

**Out of scope for v2.2** (still v2.3+):

- Inbound call answer (candidate dials in).
- External candidate launch (real prod numbers).
- Production TCPA enforce-mode flip.
- Cartesia TTS swap.
- Multi-leg / call transfer.
- Operator voice analytics dashboard.

---

## Sprint plan (suggested, ≤ 5)

### S0 — pattern audit

Read each SMS pattern's entry-point and identify the message-in / message-out boundary. Write `.planning/v2.2/PATTERN-MAP.md` mapping:

| Pattern | SMS entry | Reducer | State store | Memory hook | Terminal write-back |
|---|---|---|---|---|---|
| Prescreen | `paSendblueWebhook` → `routeInbound` → `PreScreenPipeline.runTurn` | PreScreenPipeline | `outbound-bookings/{id}.prescreenSession` | `mem0/sessionMemory.appendTurn` | `voiceOutcome: PASS/NOT_PASS/PAUSE` + `paUsers.tags.prescreenHistory` |
| Layoff onboarding | `paLayoffOnboardingTrigger` → `ClaireLayoffPipeline.runTurn` | Claire layoff | `pa-users/{uid}.layoffOnboarding` | same | `tags.layoffStatus` + mem0 |
| General onboarding | `paOnboardingTrigger` → `OnboardingPipeline.runTurn` (Level 1 PII) | Onboarding | `pa-users/{uid}.onboardingProgress` | same | `tags.onboardingComplete` + `tags.<level1 fields>` |
| Memory | mem0 + sessionMemory | (writes via reducer post-turn) | mem0 cloud + Firestore | n/a | n/a |

If any of these are NOT actually exported as a "runTurn"-shape pipeline, S0 also identifies the smallest refactor to expose them through one common interface.

### S1 — graft `cli.runApp` onto `worker.ts`

Refactor `apps/voice-agent/src/worker.ts`:

- Move `defineAgent({ entry })` to module-top-level (file becomes the LK agent module).
- Add `cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }))` block guarded by `process.argv[1]` test.
- Make `defaultLoadContext(bookingId)` actually load via S1B `loadUserProfileForVoice` + `loadJobBriefForVoice` + `loadPrescreenConfigForVoice` (currently throws).
- Make `defaultBuildPipeline()` wire to **either** PreScreenPipeline / ClaireLayoffPipeline / OnboardingPipeline based on `outbound-bookings.purpose` (`"prescreen" | "layoff-onboarding" | "onboarding"`).
- Keep `live-smoke-agent.ts` as a diagnostic. Mark it `// diagnostic-only` in the header.

### S2 — wire shim orchestrator backend

- Flip `WEKRUIT_LLM_SHIM_BACKEND=orchestrator` on the shim runtime.
- Provide firebase-admin auth to the shim process (same FIREBASE_SERVICE_ACCOUNT_JSON pattern).
- Verify the `runAgentTurnStream` adapter (already shipped in `apps/voice-llm-shim/src/runtime/orchestrator-backend.ts`) drives turns end-to-end via a unit test that pipes a canned `messages[]` through and asserts the SSE shape carries deltas from a real PreScreenPipeline reducer.

### S3 — handoff bridges

- **Voice → SMS handoff for PII**: `triggerSmsHandoff(bookingId, phoneE164, reason)` lib + agent-side `say("I'll text you the link…")` + dispatcher `paSendblueOutbound` write.
- **Voice → mem0 + sessionMemory**: after each turn, the orchestrator backend already writes (via existing pa-orchestrator code). Verify the path. Add `voice.turn_persisted` audit log.
- **Voice → Level-1 onboarding state**: pass-through `mergeUserTags()` called by the reducer (no voice-specific code).

### S4 — 10-scenario live smoke (real backend)

Re-run `tests/voice-smoke/smoke-driver.mjs --live --count 10` with `+14243201960` as the toNumber (per `dev_phone_dial_authorization` memory). Capture real metrics into `.planning/v2.2/sprints/S4/SMOKE-REPORT.md`:

- ≥8/10 PASS across mixed scenarios (3 prescreen-pass, 3 prescreen-fail/pause, 2 layoff onboarding, 2 general onboarding).
- p50 TTFA < 1.5s
- cost < $1/call
- false-commit < 10%, false-interrupt < 5%
- 0 PII leaks (audit transcripts via existing `pii-audit.mjs`)

### S5 — adam-action closeouts + ship

- Wire LK Cloud webhook → `paVoiceSipWebhook` (dashboard or `lk` CLI).
- Create GCS bucket `wekruit-voice-recordings`.
- Tag `v2.2-voice-pattern-integrated`.
- Write `.planning/v2.3/HANDOFF-from-v2.2.md` (inbound + external launch deferred).

---

## Pre-flight checklist (run before S0)

```bash
# 1. Sync main, create v2.2 worktree
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree add .claude/worktrees/v22-S0-pattern-audit -b claude/v22-S0-pattern-audit main

# 2. Verify v2.1 artifacts present
ls .planning/v2.1/sprints/S{0..7}*/SUMMARY.md
ls .planning/v2.2/HANDOFF-from-v2.1.md

# 3. Verify .env still carries v2.1 voice creds
grep -E "^(LIVEKIT_|TWILIO_SIP_|DEEPGRAM_API_KEY|PA_VOICE_)" .env

# 4. Verify deployed CFs reflect v2.1 state
firebase functions:list --project wekruit-5f89b | grep -i voice

# 5. Verify LK Cloud trunk + worker plumbing
set -a && source <(grep -E "^LIVEKIT_" .env) && set +a
lk sip outbound list  # expect ST_DM7SuwYmgXKV

# 6. Regression gate
pnpm --filter pa-orchestrator test
pnpm --filter @pa/functions test
pnpm --filter voice-agent test
node tests/scenarios/runner-prescreen.mjs tests/scenarios/prescreen/pass.yaml
node tests/scenarios/runner-prescreen.mjs tests/scenarios/prescreen/pause.yaml
```

If any of the above fail → STOP and tell Adam **before** writing any v2.2 code.

---

## Dev phone authorization (carry forward)

**`+14243201960`** has standing dial-out approval for v2.2 voice work (Adam directive 2026-05-16, memory file `dev_phone_dial_authorization.md`). Any other recipient phone → STOP, ask Adam per-dial.

---

## Single hard rule

If your S0 pattern audit shows that gluing voice into an existing pattern would require modifying a reducer or scoring path, **stop and surface to Adam**. v2.2 is integration, not redesign. The transport changes; the reducer doesn't.
