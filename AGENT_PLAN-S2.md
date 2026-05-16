# S6 Internal Smoke + Recording Archive — AGENT_PLAN

> Worktree: `.claude/worktrees/v21-S6-smoke`
> Branch: `claude/v21-S6-smoke`
> Base: `claude/v21-S2-voice-bridge` @ `d9dd56c`
> Author: P8 sub-agent (Opus 4.7), spawned by P10.

## 1. Mission (one-liner)

Build smoke runner + PII-leak audit + recording archive plumbing for 10
internal voice calls so the moment Adam provisions LiveKit/Twilio/Deepgram
secrets + GCS bucket service-account, `node tests/voice-smoke/smoke-driver.mjs
--live --count 10` produces the ship-readiness report.

## 2. Lock compliance posture

| Lock | Compliance |
|---|---|
| L1 — agent-runtime frozen | No edits. Smoke tools read state, do not modify orchestrator. |
| L2 — `PreScreenPipeline.runTurn` frozen | Smoke tools call scoring transitively via the voice path; no scoring code edits. |
| L7 — 7 event handlers | Already registered in S2; smoke runner only reads `voice-call-metrics`. |
| L8 — consent prompt | Already wired in S2; PII audit relies on the consent-spoken event boundary. |
| L11 — $1/call ceiling | Cost threshold asserted by runner from S4 aggregate. |
| L12 — LK Cloud managed agent hosting | Recording archive uses LiveKit Egress (managed) → GCS, **no Docker/k8s/docker-compose**. |

## 3. Inheritance map (what's pre-existing)

- S2 worker (`apps/voice-agent/src/worker.ts`) — fires `session.start`, speaks consent.
- S3 (not yet shipped; SUMMARY absent) — `outbound-bookings` doc + dispatch CF + caller-id rotation. Smoke runner assumes the documented schema (`paUserId`, `paJobId`, `voiceCallSid`, `voiceState`, `voiceStartedAt`, `voiceEndedAt`, `voiceOutcome`) per `MILESTONE-v2.1`.
- S4 (not yet shipped; SUMMARY absent) — `voice-call-metrics/{callSid}` writer + `paAdminVoiceTelemetryAggregate` callable. Smoke runner consumes the documented aggregate shape (`p50TtfaMs`, `falseCommitRate`, `falseInterruptRate`, `costPerCallUsd`).
- S5 (parallel) — TCPA gate, observed mode in dev.

Where S3/S4 contracts are unfinalized, the smoke runner builds against the
documented MILESTONE schema and isolates that mapping in a single adapter
module so the moment S3/S4 SUMMARYs settle, only one file may need a
rename.

## 4. File plan + atomic commit sequence

### Commit 1 — runner skeleton + scenarios
- `tests/voice-smoke/README.md` — how to use, secrets pre-flight, live vs
  mock mode.
- `tests/voice-smoke/lib/scenario-loader.mjs` — load YAML scenarios.
- `tests/voice-smoke/lib/firestore-adapter.mjs` — abstraction over
  Firebase Admin SDK with `--mock` flag toggling to in-memory backend.
- `tests/voice-smoke/lib/metrics-adapter.mjs` — fetches
  `voice-call-metrics/{callSid}` + invokes
  `paAdminVoiceTelemetryAggregate` (S4); mock variant returns canned
  rows.
- `tests/voice-smoke/runner.mjs` — drives a single scenario end-to-end.
  CLI: `node runner.mjs --scenario <file> [--mock] [--timeout 300]`.
- `tests/voice-smoke/scenarios/01-happy-path-pass.yaml`
- `tests/voice-smoke/scenarios/02-not-pass-low-score.yaml`
- `tests/voice-smoke/scenarios/03-hangup-mid-call.yaml`
- `tests/voice-smoke/scenarios/04-yes-no-en.yaml`
- `tests/voice-smoke/scenarios/05-yes-no-zh.yaml`
- `tests/voice-smoke/scenarios/06-multilingual-switch.yaml`
- `tests/voice-smoke/scenarios/07-noisy-background.yaml`
- `tests/voice-smoke/scenarios/08-fast-talker.yaml`
- `tests/voice-smoke/scenarios/09-long-pause.yaml`
- `tests/voice-smoke/scenarios/10-edge-late-consent.yaml`
- `tests/voice-smoke/__tests__/runner.test.mjs` — unit-test against
  in-memory mock; asserts booking doc created, terminal-state polling,
  metrics fetched, result row composed.

### Commit 2 — PII audit
- `tests/voice-smoke/pii-audit.mjs` — CLI:
  `node pii-audit.mjs --booking <bookingId> [--mock]`. Scans transcript
  for SSN (`\d{3}-\d{2}-\d{4}`), DOB (`\d{1,2}/\d{1,2}/\d{2,4}`),
  full-street-address (`\d+\s+\w+\s+(St|Ave|Blvd|Rd|Way|Dr|Ln|Ct)\b`),
  email, E.164 phone, dollar amount, URL — flagged only if uttered by
  **the agent** **before** the `voice.consent_prompt_spoken` event OR
  by user before the PII consent boundary. Exit 0 = clean, exit 1 =
  leak.
- `tests/voice-smoke/__tests__/pii-audit.test.mjs` — synthetic clean +
  leaked fixtures + post-consent-allowed fixture; ensures detector
  flags only pre-consent leaks.

### Commit 3 — Recording archive (LiveKit Egress + GCS)
- `apps/voice-agent/src/egress.ts` — module exporting
  `startRecordingEgress({ roomName, bookingId, bucket, log })`. Lazy
  imports `EgressClient` from `livekit-server-sdk` (already a transitive
  dep). Calls `startRoomCompositeEgress` with `output: { fileType:
  ENCODED_FILE_TYPE_MP4, filepath: 'voice/{bookingId}/{room}.mp4',
  gcp: { credentials: ... , bucket } }`. Returns `{ egressId }` for
  reconciliation.
- `apps/voice-agent/src/__tests__/egress.test.ts` — mock
  `EgressClient`; asserts (a) called with bucket + filepath, (b) skipped
  when `WEKRUIT_VOICE_RECORDINGS_BUCKET` unset, (c) retries on transient
  err.
- `apps/voice-agent/src/worker.ts` — additive only: after
  `session.start?.({ agent, room })`, call `startRecordingEgress` when
  `WEKRUIT_VOICE_RECORDINGS_BUCKET` env present. Wrapped in try/catch so
  a recording-archive failure never crashes the call.
- `tests/voice-smoke/archive-spot-check.mjs` — CLI:
  `node archive-spot-check.mjs --bucket wekruit-voice-recordings
  --count 3 [--mock]`. Lists `voice/*/` prefixes, picks 3 random,
  fetches each, asserts size > 0. Exit 0 = ok, exit 1 = retrieval fail.
- `tests/voice-smoke/__tests__/archive-spot-check.test.mjs` — mock GCS;
  asserts random sampling, retrieval, size assertion.

### Commit 4 — Smoke driver (10-call sweep)
- `tests/voice-smoke/smoke-driver.mjs` — CLI:
  `node smoke-driver.mjs [--live] [--mock] [--count 10] [--out <path>]`.
  Workflow:
  1. Secrets pre-flight check (refuse `--live` without all 4 env literals + GCS SA).
  2. Load all 10 scenarios.
  3. For each: invoke `runner.mjs --scenario <file>` as a child process.
  4. Aggregate per-call results into a JSON file under
     `.planning/v2.1/sprints/S6/smoke-runs/<timestamp>.json`.
  5. Compute pass-rate, threshold compliance, generate filled
     SMOKE-REPORT.md (overwrites template body, keeps header).
- `tests/voice-smoke/__tests__/smoke-driver.test.mjs` — mock child
  process; asserts aggregation, threshold computation, output writing.

### Commit 5 — SMOKE-REPORT template + run dir
- `.planning/v2.1/sprints/S6/SMOKE-REPORT.md` — placeholders for live run.
- `.planning/v2.1/sprints/S6/smoke-runs/.gitkeep`

### Commit 6 — SUMMARY
- `.planning/v2.1/sprints/S6/SUMMARY.md`

## 5. Scenario YAML shape (deterministic + minimal)

```yaml
id: 01-happy-path-pass
description: Happy-path PASS with affirmative SWE answers.
voice:
  toNumber: "${PA_TEAM_NUMBER_ALICE}"   # env literal; never raw PII in repo
  fromCallerId: "+14157075057"           # S3 rotates; fixed here for replay
  expectedOutcome: PASS                  # PASS | NOT_PASS | PAUSE | HANGUP
  expectedTerminalReasonContains: "score_met"
context:
  paUserId: "smoke-user-01"
  paJobId: "smoke-job-swe"
thresholds:
  ttfaMaxMs: 1500
  costMaxUsd: 1.00
seed: 42                                 # deterministic when --mock
```

Live mode uses real LiveKit dial. Mock mode runs the runner against
canned metric rows + a stubbed booking transition.

## 6. Adam-secrets blocker statement

For live 10-call sweep:
1. `LIVEKIT_API_SECRET` (LK Cloud project secret).
2. `TWILIO_SIP_PASSWORD` (trunk credentials).
3. `DEEPGRAM_API_KEY` (Nova-3 + Aura-2).
4. `PA_VOICE_WEBHOOK_SECRET` (Twilio status-callback signing).
5. Twilio status-callback URL configured on trunk
   `wekruit-prescreen-outbound` → CF `paVoiceTwilioStatusWebhook`.
6. GCS bucket `wekruit-voice-recordings` created + service-account JSON
   with `roles/storage.objectAdmin` exported as
   `GOOGLE_APPLICATION_CREDENTIALS` + `WEKRUIT_VOICE_RECORDINGS_BUCKET=wekruit-voice-recordings`.
7. Test PA team phone numbers exported as `PA_TEAM_NUMBER_*` env vars
   (referenced from scenarios).
8. DNC test fixtures seeded into `voice-dnc-list` (S5 dependency).

Pre-staged: every tool above, secrets pre-flight, mock-mode green tests,
scenarios authored.

Run command once unblocked:

```bash
node tests/voice-smoke/smoke-driver.mjs --live --count 10 \
  --out .planning/v2.1/sprints/S6/smoke-runs/$(date +%Y%m%d-%H%M%S).json
```

## 7. Verification

- All unit tests via `node --test tests/voice-smoke/__tests__/*.test.mjs`.
- All unit tests for voice-agent egress via
  `pnpm --filter voice-agent test` (new test file appended to existing
  test list in `package.json`).
- Regression gate:
  - `pnpm --filter @pa/pa-orchestrator test`
  - `pnpm --filter pa-functions test`
  - `cd packages/pa-orchestrator && node tests/scenarios/runner-prescreen.mjs pass.yaml`
  - `cd packages/pa-orchestrator && node tests/scenarios/runner-prescreen.mjs pause.yaml`
- Mock smoke-driver dry-run:
  `node tests/voice-smoke/smoke-driver.mjs --mock --count 10` →
  produces a fake report with `[mock]` watermark.

## 8. Out-of-scope handoff

- Real telephony provisioning (Adam).
- LK Cloud / GCS service-account creation (Adam).
- Inbound call answer (v2.2).

— end plan —
