# S6 Smoke + Recordings — EXECUTOR-PLANS

## 6-Element Task Prompt — S6

### 1. Objective
Run 10 internal voice smoke calls end-to-end (S2 worker via S3 dispatch with S4 metrics + S5 observed-mode gate), archive recordings + transcripts, run PII-leak audit, produce ship-readiness report.

### 2. Context
- Smoke targets internal numbers only (PA team + dev numbers Adam will provide).
- Done-criteria: ≥8/10 PASS, 0 PII leaks, p50 TTFA <1.5s, cost <$1.
- Recording archive bucket: `wekruit-voice-recordings`.

### 3. Constraints
- Smoke runner under `tests/voice-smoke/` (new dir). Uses live LiveKit Cloud + Twilio (real dial).
- PII-leak audit reuses existing audit patterns from `apps/functions/scripts/` if present; otherwise add new audit lib.
- Recording archive is automatic via LiveKit Egress (configure in S6) OR manual fetch from LiveKit Cloud + upload to GCS.
- Smoke report Markdown at `.planning/v2.1/sprints/S6/SMOKE-REPORT.md`.
- Atomic commits: runner → audit → archive → report.

### 4. Deliverables
- `tests/voice-smoke/runner.mjs` (10-call runner with seedable scenarios)
- `tests/voice-smoke/pii-audit.mjs`
- LiveKit Egress config for recording → GCS
- `.planning/v2.1/sprints/S6/SMOKE-REPORT.md` ship-readiness report
- `.planning/v2.1/sprints/S6/SUMMARY.md`
- `AGENT_PLAN.md` BEFORE running

### 5. Verification
Smoke report shows ≥8/10 PASS + 0 PII + p50 TTFA <1.5s + cost <$1. Regression gate green.

### 6. Done-criteria
- [ ] 10 real dial calls executed
- [ ] All Done-criteria thresholds met
- [ ] PII-leak audit clean
- [ ] Recording archive verified by spot-check (3 random calls retrievable)
- [ ] Regression gate green
- [ ] SUMMARY + SMOKE-REPORT filled
