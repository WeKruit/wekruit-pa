# S7 Ship Gate + v2.2 Hand-off — CONTEXT

**Status:** PENDING. Final sprint. Owner: P10.
**Wave:** E (cleanup).
**Worktree (to create):** `.claude/worktrees/v21-S7-ship`.

## What S7 does

- Verify all 8 SUMMARY.md (S0..S6 + S7) filled.
- Verify all 12 locks held.
- Verify Done-criteria from `V21-VOICE-PRESCREEN-GOAL-PROMPT.md`:
  - [ ] ≥8/10 internal smoke PASS (S6 report)
  - [ ] 0 PII leaks (S6 audit)
  - [ ] p50 TTFA <1.5s (S4 aggregate)
  - [ ] Cost <$1/call (S4 aggregate)
  - [ ] TCPA plumbing complete, flag off in dev (S5)
  - [ ] Turn telemetry <10% false-commit, <5% false-interrupt (S4 aggregate)
  - [ ] Hangup reconciliation idempotent (S3 test)
- Finalize `.planning/v2.2/HANDOFF-from-v2.1.md` (skeleton already in S0).
- Merge all `claude/v21-*` branches into `main` in dependency order:
  1. `claude/v21-S0-foundation` → main
  2. `claude/v21-S1A-runtime-stream` → main
  3. `claude/v21-S1B-context-loaders` → main
  4. `claude/v21-S1C-llm-shim` → main
  5. `claude/v21-S2-voice-bridge` → main
  6. `claude/v21-S3-twilio-sip-bookings` → main
  7. `claude/v21-S4-turn-telemetry` → main
  8. `claude/v21-S5-tcpa-compliance` → main
  9. `claude/v21-S6-smoke-recordings` → main
- `git worktree remove` after each merge.
- Tag `v2.1-internal-smoke-shipped` on main HEAD.

## Ship gate decision

P10 reads aggregate from S4 + report from S6. If thresholds hit and Adam approves, push tag and proceed to v2.2 planning. Otherwise create a follow-up sprint with the failing dimension.

## Does NOT

- ❌ Push to production / scale to external candidates — v2.2.
- ❌ Re-run sprints — failures get follow-up sprint, not retry-in-place.
