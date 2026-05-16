# Voice Smoke Suite (v2.1 S6)

Tools that drive 10 internal voice calls through the v2.1 outbound stack
(S2 worker + S3 dispatch + S4 metrics + S5 TCPA observed-mode) and produce
a ship-readiness report.

## Files

| File | Purpose |
|---|---|
| `runner.mjs` | Drive **one** scenario end-to-end (booking → poll → metrics → result row). |
| `smoke-driver.mjs` | Drive **all 10** scenarios + aggregate + write report. |
| `pii-audit.mjs` | Scan transcript for pre-consent PII leaks (SSN, DOB, email, phone, $, URL, full street address). |
| `archive-spot-check.mjs` | Random-sample 3 GCS recordings + verify retrievable. |
| `scenarios/*.yaml` | 10 deterministic scenarios (PASS / NOT_PASS / hangup / multilingual / edge). |
| `lib/scenario-loader.mjs` | YAML scenario loader. |
| `lib/firestore-adapter.mjs` | Firebase Admin adapter (live + mock backends). |
| `lib/metrics-adapter.mjs` | S4 metrics fetcher (`voice-call-metrics` + `paAdminVoiceTelemetryAggregate`). |

## Quick start (mock mode)

```bash
node tests/voice-smoke/smoke-driver.mjs --mock --count 10
```

Mock mode bypasses real Firestore + LiveKit + GCS. Useful for unit
testing the runner and aggregation logic.

## Live mode (requires Adam-provisioned secrets)

```bash
# Pre-flight: all 4 secrets + GCS SA must be set
export LIVEKIT_API_SECRET=...
export TWILIO_SIP_PASSWORD=...
export DEEPGRAM_API_KEY=...
export PA_VOICE_WEBHOOK_SECRET=...
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/gcs-sa.json
export WEKRUIT_VOICE_RECORDINGS_BUCKET=wekruit-voice-recordings
# PA team phone numbers (referenced from scenarios)
export PA_TEAM_NUMBER_ALICE=+1...
export PA_TEAM_NUMBER_BOB=+1...
# Run live sweep
node tests/voice-smoke/smoke-driver.mjs --live --count 10 \
  --out .planning/v2.1/sprints/S6/smoke-runs/$(date +%Y%m%d-%H%M%S).json
```

The driver:
1. Refuses `--live` if any secret missing.
2. Creates 10 `outbound-bookings` docs (one per scenario).
3. Polls each booking for terminal state with a 5-minute timeout.
4. Fetches per-call metrics + aggregate.
5. Runs `pii-audit.mjs` on each transcript.
6. Runs `archive-spot-check.mjs` against 3 random recordings.
7. Computes threshold compliance.
8. Overwrites `.planning/v2.1/sprints/S6/SMOKE-REPORT.md` body with
   results.

## Done-criteria thresholds (asserted)

| Metric | Threshold |
|---|---|
| Pass rate | >= 8/10 |
| PII leaks | == 0 |
| p50 TTFA | < 1500 ms |
| Cost per call | < $1.00 |
| False-commit rate | < 10% |
| False-interrupt rate | < 5% |

## Lock compliance

- L1 — never imports `@pa/agent-runtime` internals; reads outputs only.
- L2 — never imports `PreScreenPipeline.runTurn`; reads `voiceOutcome` only.
- L7 — relies on event handlers already registered in S2.
- L8 — PII audit treats `voice.consent_prompt_spoken` event as boundary.
- L12 — recording archive via LiveKit Egress (managed), no Docker.
