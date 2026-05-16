# S7 Ship Gate — SUMMARY

> Sprint: v2.1 S7 (final)
> Branch: `claude/v21-integration` (PR #81 → main)
> Worktree: `.claude/worktrees/v21-integration`
> Status: Code-complete, documentation closed, regression gate green, **live smoke pending Adam unblocks**.

## Closeout state at 2026-05-16

### Documentation (10/10)

| Sprint | SUMMARY.md |
|---|---|
| S0-foundation | ✅ |
| S1A-runtime-stream | ✅ |
| S1B-context-loaders | ✅ |
| S1C-llm-shim | ✅ |
| S2 | ✅ |
| S3 | ✅ |
| S4 | ✅ |
| S5 | ✅ |
| S6 | ✅ |
| S7 | ✅ (this file) |

### 12 Locks audit (L1–L12)

| Lock | Verified by |
|---|---|
| L1 agent-runtime frozen, add `runAgentTurnStream` only | `git diff main..HEAD -- packages/agent-runtime` — additive only |
| L2 PreScreenPipeline.runTurn single scoring source | `git diff main..HEAD -- packages/pa-orchestrator/.../PreScreenPipeline.ts` — no edits |
| L3 PA profiles always LiveKit; Retell behind per-profile flag | `voice-agent/livekit.toml` ships; Retell unchanged |
| L4 TCPA = production gate; dev flag off | `PA_TCPA_GATE_ENFORCED=false` in `.env`; observe-mode path in `gate.ts` |
| L5 Identity bridge first | `outbound-bookings.paUserId/paJobId` validated in `loadUserProfileForVoice` + `dialOutbound.ts` |
| L6 No PII via voice | `pii-handler.ts` + `pii-audit.mjs` 12 unit tests |
| L7 No `minEndpointingDelay` hardcoded | `no-min-endpointing.test.ts` lock-enforcement test |
| L8 Recording-consent disclosure spoken first | `worker.ts:249-255` + `consent-audit.ts` audit log |
| L9 Hangup reconciliation idempotent | `sipWebhook.ts` CAS-safe reducer; 13 reconciler tests |
| L10 Voice state-machine reducer | `state-machine.ts` `canTransition` / `isForwardTransition` / `assertTransition` |
| L11 Single source of truth for prescreenConfig | `loadPrescreenConfigForVoice` reads `pa-jobs/{jobId}.prescreenConfig` |
| L12 LiveKit Cloud managed hosting (no self-host) | `livekit.toml` + `no-self-host.test.ts` |

### 7 Done-criteria

| # | Criterion | Status |
|---|---|---|
| 1 | S0–S7 SUMMARY.md | ✅ all 10 sprint dirs |
| 2 | ≥8/10 internal smoke PASS | 🟡 mock-mode 10/10 green; **live-mode pending Adam unblocks** |
| 3 | 0 PII leaks | 🟡 12 PII-audit unit tests green; live audit pending live smoke |
| 4 | p50 TTFA <1.5s | 🟡 mock 1040ms; live pending |
| 5 | Cost <$1/call | 🟡 mock $0.47; live pending |
| 6 | False-commit <10% / false-interrupt <5% | 🟡 mock 0%/0%; live pending |
| 7 | Hangup reconciliation idempotent + TCPA plumbing complete flag off | ✅ S5+S3 |

### Regression gate at integration HEAD

```
pnpm --filter pa-orchestrator test          1498/1498 ✅
pnpm --filter pa-functions test             1700/1700 ✅
pnpm --filter voice-agent test                  55/55 ✅
node tests/scenarios/runner-prescreen.mjs pass.yaml    3/3 PASS ✅
node tests/scenarios/runner-prescreen.mjs pause.yaml   0/6 PAUSE ✅
```

`fail.yaml` + `hard-stop.yaml` red on main — pre-existing backlog item (task #11), NOT a v2.1 regression.

### Merge integrity

- PR #81 open: `claude/v21-integration` → `main`. Branch up-to-date with `origin/main` via merge-commit `efe1d60`.
- No `--no-verify`, no force-push.
- Per-sprint worktrees removed (S0/S1A/S1B/S1C/S2/S3/S4/S5/S6).

## Open Adam-action (4 items)

1. **LiveKit Cloud Outbound Trunk** — set status-callback URL on `wekruit-prescreen-outbound` trunk:
   - URL `https://us-central1-wekruit-5f89b.cloudfunctions.net/paVoiceSipWebhook`
   - Header `X-Wekruit-Voice-Webhook-Secret: 6461ff28a67081525c3b756a9175713186471d1638e261c5bebf76870f2e9a4a`
   - via LK Cloud dashboard or `lk sip outbound create / lk sip dispatch create`.
2. **GCS bucket** — approve `gsutil mb gs://wekruit-voice-recordings -p wekruit-5f89b -l us-central1`.
3. **Dial approval** — confirm OK to live-dial `+14243201960` (indolencorlol@gmail.com user, uid `U7AwKT8nLDRa35DkuBxq`).
4. **Worker hosting** — pick local-Mac `pnpm dev` (dev-only) or LK Cloud managed deploy (prod path).

On Adam confirm of all 4, P10 executes: GCS bucket create → start worker → `--count 1` smoke → review → `--count 10` smoke → regenerate `SMOKE-REPORT.md` with live thresholds → merge PR #81 → tag `v2.1-internal-smoke-shipped`.

## v2.2 hand-off

`.planning/v2.2/HANDOFF-from-v2.1.md` finalized (status flipped from SKELETON). Captures intentionally-deferred topics (inbound, external launch, prod TCPA flip, Cartesia swap, multi-leg, voice analytics dashboard, Retell deprecation, non-prescreen voice).
