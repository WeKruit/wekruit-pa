# v2.1 S6 Smoke Report — TEMPLATE (Pending-Adam-Secrets)

> This is the **pre-staged template**. The body below is overwritten by
> `tests/voice-smoke/smoke-driver.mjs` when the live 10-call sweep is
> executed. Until Adam provisions the secrets listed at the bottom of
> this file, the table values are placeholders and the ship-gate row is
> intentionally left blank.

- **Mode**: pending
- **Run at**: pending
- **Sample size**: 10 (target)
- **Pass rate**: pending

## Threshold compliance

| Metric | Threshold | Actual | Pass |
|---|---|---|---|
| Pass rate | >= 8/10 | pending | pending |
| PII leaks | == 0 | pending | pending |
| p50 TTFA | < 1500 ms | pending | pending |
| Cost / call | < $1.00 | pending | pending |
| False-commit | < 10% | pending | pending |
| False-interrupt | < 5% | pending | pending |

## Recording archive spot-check

- Sampled: pending
- OK: pending

## Per-call results

| # | Scenario | Expected | Actual | TTFA ms | Cost $ | Pass |
|---|---|---|---|---|---|---|
| 1 | 01-happy-path-pass | PASS | pending | - | - | pending |
| 2 | 02-not-pass-low-score | NOT_PASS | pending | - | - | pending |
| 3 | 03-hangup-mid-call | HANGUP | pending | - | - | pending |
| 4 | 04-yes-no-en | PASS | pending | - | - | pending |
| 5 | 05-yes-no-zh | PASS | pending | - | - | pending |
| 6 | 06-multilingual-switch | PASS | pending | - | - | pending |
| 7 | 07-noisy-background | PASS | pending | - | - | pending |
| 8 | 08-fast-talker | PASS | pending | - | - | pending |
| 9 | 09-long-pause | PASS | pending | - | - | pending |
| 10 | 10-edge-late-consent | PASS | pending | - | - | pending |

## Ship-readiness

- **Ship gate**: PENDING-LIVE-RUN

## How to run the live sweep

```bash
# 1) Confirm secrets pre-flight passes:
export LIVEKIT_API_SECRET=...
export TWILIO_SIP_PASSWORD=...
export DEEPGRAM_API_KEY=...
export PA_VOICE_WEBHOOK_SECRET=...
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/wekruit-voice-recordings-sa.json
export WEKRUIT_VOICE_RECORDINGS_BUCKET=wekruit-voice-recordings
# 2) Confirm Twilio status-callback URL on trunk `wekruit-prescreen-outbound`
#    points at the deployed CF `paVoiceTwilioStatusWebhook`.
# 3) Export PA team test phone numbers (used by scenarios):
export PA_TEAM_NUMBER_ALICE=+1...
export PA_TEAM_NUMBER_BOB=+1...
export PA_TEAM_NUMBER_CHARLIE=+1...
export PA_TEAM_NUMBER_DAVE=+1...
export PA_TEAM_NUMBER_ERIN=+1...
export PA_TEAM_NUMBER_FIONA=+1...
export PA_TEAM_NUMBER_GREG=+1...
export PA_TEAM_NUMBER_HARRY=+1...
export PA_TEAM_NUMBER_IRENE=+1...
export PA_TEAM_NUMBER_JANE=+1...
# 4) Run the sweep:
node tests/voice-smoke/smoke-driver.mjs --live --count 10
```

## Adam-secrets unblock checklist

- [ ] `LIVEKIT_API_SECRET` set (LiveKit Cloud project secret).
- [ ] `TWILIO_SIP_PASSWORD` set (Twilio trunk credentials).
- [ ] `DEEPGRAM_API_KEY` set (Nova-3 STT + Aura-2 TTS).
- [ ] `PA_VOICE_WEBHOOK_SECRET` set (Twilio status-callback signing).
- [ ] Twilio status-callback URL configured on trunk `wekruit-prescreen-outbound` -> CF `paVoiceTwilioStatusWebhook`.
- [ ] GCS bucket `wekruit-voice-recordings` created.
- [ ] GCS service-account JSON exported as `GOOGLE_APPLICATION_CREDENTIALS` with `roles/storage.objectAdmin` on the bucket.
- [ ] `WEKRUIT_VOICE_RECORDINGS_BUCKET=wekruit-voice-recordings` set.
- [ ] Internal PA team test numbers exported as `PA_TEAM_NUMBER_*` env vars.
- [ ] DNC test fixture seeded into `voice-dnc-list` collection (S5 dependency).

## Mock dry-run

The driver also runs cleanly in mock mode (no secrets required):

```bash
node tests/voice-smoke/smoke-driver.mjs --mock --count 10
```

Mock mode synthesizes a 10/10 PASS report from each scenario's
`mock.outcome` + `mock.metrics` blocks. This is intended to verify the
report-generation plumbing end-to-end without touching real telephony
or GCS. Validated 2026-05-15.
