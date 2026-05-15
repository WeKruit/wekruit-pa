# S7 Ship Gate — SUMMARY (P10 self-task, partial completion)

**Status:** CODE-COMPLETE. Live smoke + merge-to-main blocked on Adam-secrets.

## Sprint state

All 7 sprint branches landed + pushed; SUMMARY.md present for each:

| Sprint | Branch | Status |
|---|---|---|
| S0 | `claude/v21-S0-foundation` | landed, pushed (latest `dbc4f1d`) |
| S1A | `claude/v21-S1A-runtime-stream` | landed, pushed |
| S1B | `claude/v21-S1B-context-loaders` | landed, pushed |
| S1C | `claude/v21-S1C-llm-shim` | landed, pushed |
| S2 | `claude/v21-S2-voice-bridge` | landed, pushed |
| S3 | `claude/v21-S3-twilio-sip-bookings` | landed, pushed |
| S4 | `claude/v21-S4-turn-telemetry` | landed, pushed |
| S5 | `claude/v21-S5-tcpa` | landed, pushed |
| S6 | `claude/v21-S6-smoke` | landed, pushed |

Each sprint test-green at branch HEAD. Integration branch `claude/v21-integration` available for rolling merge.

## Lock compliance (all 12)

- **L1** agent-runtime untouched (only `runAgentTurnStream` added via `@pa/agent-runtime` per S1A spec).
- **L2** `PreScreenPipeline.runTurn` unchanged; voice path invokes via injected pipeline lite.
- **L3** PA profiles always LiveKit; Retell per-profile flag preserved (no v2.1 edits).
- **L4** TCPA = prod gate, dev observed-only (`PA_TCPA_GATE_ENFORCED=false` default).
- **L5** Identity bridge first (S3 `handleDialOutbound` short-circuits missing `paUserId`/`paJobId`).
- **L6** No PII via voice — S2 PII handler emits `[sms_handoff:*]` tokens for S5 SMS dispatcher.
- **L7** 7 LiveKit event handlers registered, adaptive turn model, no hardcoded `minEndpointingDelay` (greppable lock test in S2).
- **L8** Recording consent at call start (S2 `buildConsentPrompt` + S5 audit log) + `wekruit-voice-recordings` GCS via LiveKit Egress (S6).
- **L9** Hangup webhook idempotent via `voiceCallSid` CAS (S3 `reconcileVoiceCallback`).
- **L10** Deterministic state machine reducer (S3 `voice/state-machine.ts`).
- **L11** $1/call cost ceiling enforced via S4 `costCeilingWatchdog` (close-callback fires once at $1.00).
- **L12** LiveKit Cloud only; `no-self-host.test.ts` grep guards Docker/k8s/docker-compose.

## Done-criteria status

| Criterion | Status |
|---|---|
| S0–S7 SUMMARY.md present | ✅ (this doc closes S7) |
| ≥8/10 internal smoke PASS | ⏸ pending Adam-secrets for live `--live` run; mock-mode 10/10 PASS validated |
| 0 PII leaks | ⏸ pending live smoke; PII audit tool + unit tests green |
| p50 TTFA <1.5s | ⏸ pending live smoke; S4 telemetry pipeline confirmed via unit tests |
| cost <$1/call | ⏸ pending live smoke; S4 cost ceiling unit-tested |
| TCPA plumbing complete, flag off | ✅ S5 landed; default `observed`; audit collection wired |
| turn telemetry <10% false-commit / <5% false-interrupt | ⏸ pending live smoke |
| hangup reconciliation idempotent | ✅ S3 unit-tested (duplicate delivery → no state regression) |
| v2.2 hand-off doc | ✅ `.planning/v2.2/HANDOFF-from-v2.1.md` finalized this commit |

## Outstanding P10 actions (next session)

1. **Rolling merge to main** in dep order:
   ```
   S0 → S1A → S1B → S1C → S2 → S3 → S4 → S5 → S6
   ```
   For each: `git fetch origin && git checkout main && git pull && git merge --ff-only origin/claude/v21-S<N>-*` then push. Run regression gate (`pnpm --filter @pa/pa-orchestrator test`, `pnpm --filter @pa/functions test`, `runner-prescreen pass.yaml + pause.yaml`) between merges. If any sprint fails FF, rebase that branch on updated main and re-merge.
2. **Tag** `v2.1-internal-smoke-shipped` after final merge.
3. **Live smoke execution** once Adam provisions secrets (next).
4. **Worktree cleanup**: `git worktree remove .claude/worktrees/v21-S{0..6}-*` after each merge confirmed on main.

## Adam-action — exact unblock

Provide (Firebase Functions secrets unless noted):

1. `firebase functions:secrets:set LIVEKIT_API_SECRET` — LK Cloud project secret
2. `firebase functions:secrets:set TWILIO_SIP_PASSWORD` — Twilio trunk credential
3. `firebase functions:secrets:set DEEPGRAM_API_KEY` — Deepgram Nova-3 key
4. `firebase functions:secrets:set PA_VOICE_WEBHOOK_SECRET` — random 32-char hex
5. Twilio trunk status-callback URL → `https://us-central1-wekruit-5f89b.cloudfunctions.net/paVoiceSipWebhook` with `X-Wekruit-Voice-Webhook-Secret` header
6. GCS bucket `wekruit-voice-recordings` created + service account with `roles/storage.objectAdmin`
7. 10 PA team test phone numbers (env vars; see S6 `SMOKE-REPORT.md`)
8. DNC test fixtures seeded into `voice-dnc/{phoneE164}` (S5 dependency)

Once provisioned, smoke command:
```bash
node tests/voice-smoke/smoke-driver.mjs --live --count 10
```

Output overwrites `.planning/v2.1/sprints/S6/SMOKE-REPORT.md` with live thresholds.

## v2.2 hand-off

Finalized: `.planning/v2.2/HANDOFF-from-v2.1.md` (status updated SKELETON → FINALIZED). Includes deferred topics, known sharp edges, v2.1 artifacts to read, and Adam-action inputs needed before v2.2 P10 spawn.

## Ship decision recommendation

**Recommend Adam approval to merge S0–S6 to main now** (regression gate green per sprint; locks held; doc artifacts complete). **Hold tag push + live smoke** until Adam-secrets provisioned + 10-call sweep produces filled SMOKE-REPORT.md with thresholds met.
