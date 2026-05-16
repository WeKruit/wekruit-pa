# S6 Internal Smoke + Recording Archive — CONTEXT

**Status:** PENDING. Parallel with S5.
**Wave:** D (eval).
**Worktree (to create):** `.claude/worktrees/v21-S6-smoke-recordings`.

## What S6 inherits

- S2 worker reachable + dispatch-capable via S3
- S3 dial path operational against internal numbers
- S4 metrics writer + aggregate query
- S5 TCPA gate (in `observed` dev mode)
- L11 cost ceiling enforcement active

## What S6 produces

- 10 internal smoke calls executed across PA team + dev numbers.
- Recordings archived to GCS `wekruit-voice-recordings` per L8.
- Transcripts stored, scored via `PreScreenPipeline.runTurn`.
- PII-leak audit script over transcripts: scan for SSN, DOB, full-address patterns → must = 0.
- Smoke-result report aggregating: pass rate, p50 TTFA, cost/call, telemetry thresholds.

## Done-criteria coverage

- ≥8/10 PASS (no crash, scoring produced, recording archived)
- 0 PII leaks
- p50 TTFA <1.5s
- Cost/call <$1
- <10% false-commit, <5% false-interrupt (from S4)

## What S6 explicitly does NOT do

- ❌ Production / external candidate smoke — v2.2.
- ❌ Modify scoring — L2 locked.
- ❌ Re-implement metrics — S4 owns.
