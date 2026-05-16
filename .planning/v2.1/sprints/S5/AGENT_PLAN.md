# S5 TCPA Plumbing — AGENT_PLAN

**Branch:** `claude/v21-S5-tcpa`
**Base:** `claude/v21-S2-voice-bridge` @ `d9dd56c`
**Worktree:** `.claude/worktrees/v21-S5-tcpa`

## Goal

Wire TCPA gate plumbing so that in **prod** mode (`PA_TCPA_GATE_ENFORCED=true`) outbound dial is blocked on DNC / quiet-hours / consent-missing, while in **dev** mode the gate is **observed-only** (logs the would-block, allows dial). Confirm recording consent prompt plays at call start (already L8-wired by S2 commit `1c78411`; we add a TCPA-aware audit log line and a test that asserts it remains the first utterance).

## Lock invariants (do not violate)

- **L1** No `agent-runtime` edits. (Confirmed — all new code is under `apps/functions/src/voice/tcpa/`; voice-agent edits are additive to the existing S2 worker.)
- **L2** No `PreScreenPipeline.runTurn` edits. (Confirmed — gate runs strictly outside the pipeline, before dial dispatch.)
- **L4** TCPA = prod gate, not dev gate. Default in dev: `PA_TCPA_GATE_ENFORCED=false` (observed mode logs but allows).
- **L8** Recording consent prompt at call start. Already satisfied by S2 `apps/voice-agent/src/consent-prompt.ts` + `worker.ts` first-utterance `session.say(consentLine)`. S5 adds an audit log event hook only.
- **L12** No Docker / k8s / self-host. LiveKit Cloud only.

## Sequencing decision: S3 integration

S5 is based on **S2** (`d9dd56c`), not S3. S3's `dialOutbound.ts` does not exist on this branch — it lives only on `origin/claude/v21-S3-twilio-sip-bookings`. Per workflow contract, I will **not** merge S3 into S5 (those branches diverge structurally — S3 deletes the `context-loaders/` dir that S2 created via S1B, so a merge would conflict and is P10's integration call).

**Strategy:** Build the gate as a **self-contained module** exporting `runTcpaGate({ bookingId, paUserId, phoneE164, now, fs, mode }) → GateDecision`, plus an integration helper `applyTcpaGate(decision, bookingRef, now)` that performs the booking-row failure write in `blocking` mode. P10 will insert a single call to `runTcpaGate(...)` inside S3's `handleDialOutbound` (between identity validation and `sipClient.createSipParticipant`) during merge. The exact integration recipe is documented in `SUMMARY.md` for the integration agent.

This keeps S5 atomic and testable on its own branch; the S3 hook is one wrapper-line away.

## Commit sequence (atomic, in dep order)

1. **AGENT_PLAN.md** (this commit, before any feature code).
2. `feat(voice/s5): types + DNC check + tests` — `tcpa/types.ts` (GateDecision, GateMode, etc.) + `tcpa/dncCheck.ts` (reads `voice-dnc/{phoneE164}` Firestore doc) + unit tests.
3. `feat(voice/s5): quiet-hours check + tests` — `tcpa/quietHours.ts` inline table for 5 US states (CA, NY, TX, IL, FL) with timezone-aware computation. 21:00–08:00 local block per FCC default.
4. `feat(voice/s5): consent check + tests` — `tcpa/consentCheck.ts` reads `pa-users/{userId}.consent.voiceRecording` boolean + `voiceRecordingConsentAt` timestamp.
5. `feat(voice/s5): gate orchestrator + audit write + tests` — `tcpa/gate.ts` runs all 3 sub-checks, returns `GateDecision`, writes audit row to `voice-tcpa-checks/{bookingId}_<runId>`. Both modes (observed + blocking) covered. Includes `applyTcpaGate()` helper that performs the booking-failure write in blocking mode.
6. `feat(voice/s5): mode plumbing via PA_TCPA_GATE_ENFORCED env + S3 integration helper` — `tcpa/mode.ts` reads env, exports `readGateMode()`. `tcpa/index.ts` barrel.
7. `feat(voice-agent/s5): TCPA consent-spoken audit log event` — additive log line in `apps/voice-agent/src/worker.ts` (or new `consent-audit.ts` helper) so S5 captures the consent-spoken moment for audit. No behavior change. (Does NOT touch agent-runtime per L1.)
8. `chore(functions/s5): wire tcpa test paths into pnpm test script` — extend `apps/functions/package.json` test glob.
9. `docs(v2.1/s5): SUMMARY.md + S3 integration recipe + S6 hand-off notes`.

## Files (planned)

```
apps/functions/src/voice/tcpa/
├── types.ts                          # GateMode, GateDecision, sub-check result types
├── dncCheck.ts                       # checkDnc(phoneE164, fs) → DncResult
├── quietHours.ts                     # checkQuietHours(phoneE164, nowUtc) → QuietHoursResult
├── consentCheck.ts                   # checkConsent(paUserId, fs) → ConsentResult
├── gate.ts                           # runTcpaGate(input, deps) → GateDecision + writeAudit
├── mode.ts                           # readGateMode() reads PA_TCPA_GATE_ENFORCED
├── index.ts                          # barrel
└── __tests__/
    ├── dnc-check.test.ts
    ├── quiet-hours.test.ts
    ├── consent-check.test.ts
    ├── gate.test.ts                  # gate orchestrator: both modes, all decisions
    ├── gate-audit.test.ts            # audit row written every check
    └── apply-gate.test.ts            # applyTcpaGate writes booking failure in blocking mode

apps/voice-agent/src/
├── consent-audit.ts                  # NEW — emitConsentSpokenAudit() (additive)
└── worker.ts                         # MODIFIED — calls emitConsentSpokenAudit after say()

.planning/v2.1/sprints/S5/
├── AGENT_PLAN.md                     # this file
└── SUMMARY.md                        # written at end
```

## Test plan (every test injected via deps; no real Firestore)

### dncCheck
- `dnc_present` — `voice-dnc/+14155551234` doc exists → `{ blocked: true, reason: "dnc_listed" }`
- `dnc_absent` — no doc → `{ blocked: false }`
- `dnc_normalization` — phoneE164 leading-spaces trimmed before lookup

### quietHours
- `quiet_ca_2300_pt` — phone `+1415*` at 2026-05-15T07:00:00Z (= 00:00 PT) → `{ blocked: true, state: "CA" }` (between 21:00–08:00 local)
- `quiet_ca_1500_pt` — same phone at 2026-05-15T22:00:00Z (= 15:00 PT) → `{ blocked: false }`
- `quiet_ny_2200_et` — phone `+1212*` at 2026-05-15T02:00:00Z (= 22:00 ET) → `{ blocked: true, state: "NY" }`
- `quiet_tx_0700_ct` — phone `+1214*` at 2026-05-15T12:30:00Z (= 07:30 CT) → `{ blocked: true, state: "TX" }`
- `quiet_unknown_area_code` — phone `+1000*` → `{ blocked: false, state: "unknown" }` (default ALLOW unknown; surfaced for HITL via reason code)
- `quiet_non_us` — phone `+447xxx` → `{ blocked: false, state: "non_us" }`

### consentCheck
- `consent_present` — `pa-users/{uid}.consent.voiceRecording = true` + `voiceRecordingConsentAt` ISO → `{ blocked: false }`
- `consent_missing_field` — no `consent` map → `{ blocked: true, reason: "consent_missing" }`
- `consent_false` — `voiceRecording = false` → `{ blocked: true, reason: "consent_denied" }`
- `consent_user_not_found` — no `pa-users/{uid}` doc → `{ blocked: true, reason: "user_not_found" }`

### gate orchestrator
- `gate_allow` — all 3 checks pass → `{ decision: "allow", mode: <mode> }`
- `gate_block_observed_dnc` — DNC blocks, mode=observed → `{ decision: "block_observed", reason: "dnc_listed" }` (booking NOT failed)
- `gate_block_enforced_dnc` — DNC blocks, mode=blocking → `{ decision: "block_enforced", reason: "dnc_listed" }`
- `gate_block_enforced_quiet` — quiet-hours blocks, mode=blocking
- `gate_block_enforced_consent` — consent missing, mode=blocking
- `gate_first_block_wins` — DNC + quiet both block → returns DNC reason (priority order)

### audit
- `audit_row_written_allow` — every run writes to `voice-tcpa-checks` with all sub-check results + decision + mode + timestamp
- `audit_row_written_block_observed` — observed-mode block still writes audit row
- `audit_row_written_block_enforced` — blocking-mode block writes audit row + flips booking to failed
- `audit_idempotent_per_run` — multiple gate runs on same booking write separate audit rows (one per `runId`)

### applyTcpaGate (integration helper)
- `apply_observed_no_booking_write` — observed-mode block does NOT touch booking row
- `apply_blocking_writes_failure` — blocking-mode block writes `voiceState: "failed"`, `voiceOutcome: "failed:tcpa_gate:<reason>"`, `voiceLastError: "tcpa_gate:<reason>"`, `voiceEndedAt: <iso>`
- `apply_allow_no_booking_write` — allow decision does NOT touch booking row

## Verification

```bash
# Targeted (run after each commit):
pnpm --filter pa-functions test -- --test-name-pattern="tcpa"

# Full regression (run before push):
pnpm --filter @pa/pa-orchestrator test
pnpm --filter pa-functions test
cd packages/pa-orchestrator && node tests/scenarios/runner-prescreen.mjs pass.yaml
cd packages/pa-orchestrator && node tests/scenarios/runner-prescreen.mjs pause.yaml
```

(Exclude `fail.yaml` + `hard-stop.yaml` per S5 charter — those are task #11 pre-existing baseline.)

## S6 hand-off (preview)

S6 smoke harness will need:
- DNC test seed: `voice-dnc/+15558675309` doc (any payload — presence = blocked)
- Consent flip helper: ability to set `pa-users/{testUid}.consent.voiceRecording = false` to trigger consent-missing path
- Env flag: `PA_TCPA_GATE_ENFORCED=true` for blocking-mode smoke, `false` for observed-mode smoke

## Adam-action items (if any)

- None new. `PA_TCPA_GATE_ENFORCED` env defaults to `false` (observed mode) when unset, so prod functions deploy is safe without setting it. Adam flips to `true` only when production rollout starts.
