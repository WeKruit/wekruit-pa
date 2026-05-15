# S6 Smoke + Recording Archive — SUMMARY (P10 transcription)

> Sub-agent harness blocked direct SUMMARY.md write. P10 transcribed final report.

**Branch:** `claude/v21-S6-smoke` (pushed to origin)
**Base:** `claude/v21-S2-voice-bridge` @ `d9dd56c`

## Commits

| SHA | Subject |
|---|---|
| `ba8d866` | docs(v21-S6): AGENT_PLAN for smoke + recording archive |
| `655a19e` | feat(v21-S6): scenario runner skeleton + 10 smoke scenarios + adapter libs |
| `70d4164` | feat(v21-S6): PII-leak audit tool + 12 unit tests |
| `b825855` | feat(v21-S6): LiveKit Egress GCS recording + archive spot-check |
| `2f23f1b` | feat(v21-S6): 10-call smoke driver + threshold-aware report composer |
| `085d260` | docs(v21-S6): SMOKE-REPORT template + smoke-runs/ output dir |

## Test results

| Suite | Pass/Total |
|---|---|
| `tests/voice-smoke/__tests__/runner.test.mjs` | 21/21 |
| `tests/voice-smoke/__tests__/pii-audit.test.mjs` | 12/12 |
| `tests/voice-smoke/__tests__/archive-spot-check.test.mjs` | 7/7 |
| `tests/voice-smoke/__tests__/smoke-driver.test.mjs` | 8/8 |
| `voice-agent` (incl. 5 new egress) | 55/55 |
| `@pa/pa-orchestrator` | 1498/1498 |
| `@pa/functions` | 1530/1530 |
| `runner-prescreen pass.yaml` | PASS 3/3 |
| `runner-prescreen pause.yaml` | PAUSE 0/6 |

Total new unit tests: 53. Mock-mode end-to-end driver dry-run validated.

## Smoke execution

**Pre-staged (blockers: Adam-secrets).** Driver refuses `--live` unless 6 env keys set. Mock-mode `--mock` works end-to-end today.

## SMOKE-REPORT path

`.planning/v2.1/sprints/S6/SMOKE-REPORT.md` — template with `pending` placeholders + Adam-secrets unblock checklist + run command snippet. Driver overwrites body on live sweep.

## Files

**New:**
- `AGENT_PLAN.md`, `tests/voice-smoke/README.md`
- `tests/voice-smoke/{runner,pii-audit,archive-spot-check,smoke-driver}.mjs`
- `tests/voice-smoke/lib/{scenario-loader,firestore-adapter,metrics-adapter}.mjs`
- `tests/voice-smoke/scenarios/01..10.yaml` (10 deterministic, mock blocks)
- `tests/voice-smoke/__tests__/*.test.mjs` (4 suites)
- `apps/voice-agent/src/egress.ts` + `__tests__/egress.test.ts`
- `.planning/v2.1/sprints/S6/SMOKE-REPORT.md` (template)
- `.planning/v2.1/sprints/S6/smoke-runs/.gitkeep`

**Modified (additive):**
- `apps/voice-agent/src/worker.ts` — invokes `startRecordingEgress` after `session.start`; errors caught so call never crashes
- `apps/voice-agent/package.json` — adds egress test file

## Adam-action — exact unblock for live sweep

```bash
export LIVEKIT_API_SECRET=<lk-cloud-project-secret>
export TWILIO_SIP_PASSWORD=<twilio-trunk-cred>
export DEEPGRAM_API_KEY=<deepgram-key>
export PA_VOICE_WEBHOOK_SECRET=<random-32-char-hex>
export GOOGLE_APPLICATION_CREDENTIALS=$PWD/wekruit-voice-recorder.json
export WEKRUIT_VOICE_RECORDINGS_BUCKET=wekruit-voice-recordings
# 10 PA team test numbers (see SMOKE-REPORT.md)
# Twilio status-callback → paVoiceTwilioStatusWebhook
# GCS bucket created + SA with roles/storage.objectAdmin
# DNC test fixtures seeded (S5 dependency)
node tests/voice-smoke/smoke-driver.mjs --live --count 10
```

## Open / follow-ups

- S3/S4 SUMMARYs not on S6 base; runner models documented MILESTONE schemas. Schema divergence → only `tests/voice-smoke/lib/` adapters need adjust.
- `paAdminVoiceTelemetryAggregate` (S4) — currently local aggregate from rows; swap to callable for env-bound aggregation.
- Egress = MP4 composite; v2.2 candidate: OGG audio-only (~10x GCS cost reduction).

## Lock compliance

- L1, L2, L7, L8, L11, L12 all green.
- `no-self-host.test.ts` still green; egress is LK Cloud managed feature.
- No `--no-verify`, no force-push.
