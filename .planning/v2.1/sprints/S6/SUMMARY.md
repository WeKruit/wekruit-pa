# S6 Smoke + Recording Archive — SUMMARY

> Sprint: v2.1 S6
> Branch: `claude/v21-S6-smoke-recording` (from `claude/v21-S0-foundation` after S2+S3+S4+S5 ready)
> Worktree: `.claude/worktrees/v21-S6-smoke-recording` (removed post-merge)
> Status: Code-complete, mock-mode 10/10 PASS green. **Live-mode pending Adam unblocks (Twilio status-callback wired to LK Cloud, GCS bucket created, dial approval).**

## What landed

10-scenario smoke driver + threshold-aware report composer + PII-leak audit tool + LiveKit Egress → GCS recording archive + spot-check tooling.

| Commit | Subject |
|---|---|
| ba8d866 | docs(v21-S6): AGENT_PLAN for smoke + recording archive |
| 655a19e | feat(v21-S6): scenario runner skeleton + 10 smoke scenarios + adapter libs |
| 70d4164 | feat(v21-S6): PII-leak audit tool + 12 unit tests |
| b825855 | feat(v21-S6): LiveKit Egress GCS recording + archive spot-check |
| 2f23f1b | feat(v21-S6): 10-call smoke driver + threshold-aware report composer |
| 085d260 | docs(v21-S6): SMOKE-REPORT template + smoke-runs/ output dir |
| d8475e4 | smoke(v2.1/S6): mock-mode 10/10 PASS — all 5 thresholds green |

## Files added

- `tests/voice-smoke/smoke-driver.mjs` — 10-call driver; `--mock` synthesizes turn telemetry + cost; `--live` writes real `outbound-bookings` rows.
- `tests/voice-smoke/scenarios/*.yaml` — 10 scenario fixtures (pass / pause / fail / hard-stop / mid-call hangup / etc.).
- `tests/voice-smoke/pii-audit.mjs` — scans transcripts + Firestore writes for PII regex (emails, SSN-shape, phone, address-shape). 12 unit tests.
- `tests/voice-smoke/report.mjs` — composes `SMOKE-REPORT.md` against 5 thresholds (≥8/10 PASS, p50 TTFA <1500ms, cost <$1/call, false-commit <10%, false-interrupt <5%).
- `apps/voice-agent/src/egress.ts` — `startRecordingEgress({ roomName, bookingId })`; uses LK Cloud Egress API with GCS sink `WEKRUIT_VOICE_RECORDINGS_BUCKET`.
- `apps/voice-agent/src/__tests__/egress.test.ts` — env-gated fire-and-forget + error containment tests.
- `tests/voice-smoke/archive-spot-check.mjs` — verifies recording lands in GCS bucket post-call.
- `.planning/v2.1/sprints/S6/smoke-runs/2026-05-16T06-35-56-294Z.json` — first mock-mode run artifact.
- `.planning/v2.1/sprints/S6/SMOKE-REPORT.md` — current mock-mode report (all 5 thresholds green).

## Mock-mode thresholds (10/10 PASS)

| Threshold | Target | Mock result |
|---|---|---|
| Smoke PASS rate | ≥8/10 | **10/10** |
| p50 TTFA | <1500ms | **1040ms** |
| Cost / call | <$1.00 | **$0.47** |
| False-commit rate | <10% | **0%** |
| False-interrupt rate | <5% | **0%** |

## Locks held

- **L11** smoke driver writes real `outbound-bookings/{id}` rows; the S2 worker + S3 dispatcher consume them unchanged.
- **L9** archive spot-check verifies hangup reconciliation is idempotent (same recording fetched twice = same blob hash).

## Hand-off

Live-mode execution requires Adam confirms:
1. LiveKit Cloud Outbound Trunk status-callback wired to `paVoiceSipWebhook`.
2. `gsutil mb gs://wekruit-voice-recordings -p wekruit-5f89b -l us-central1` (+ grant `roles/storage.objectAdmin` to compute SA).
3. Dial approval for `+14243201960`.
4. LiveKit Cloud Agent worker boot (local `pnpm dev` or LK Cloud managed deploy).

Once unblocked: `node tests/voice-smoke/smoke-driver.mjs --live --count 1` → review reply transcript end-to-end → if green, `--count 10` → regenerate `SMOKE-REPORT.md` with real thresholds.
