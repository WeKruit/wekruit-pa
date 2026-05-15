# S5 TCPA Plumbing — SUMMARY (P10 transcription)

> Agent harness blocked direct write. P10 transcribed final report.

**Branch:** `claude/v21-S5-tcpa` (pushed to origin)
**Base:** `claude/v21-S2-voice-bridge` @ `d9dd56c`
**Status:** Code complete. Regression gate green. Awaiting P10 integration with S3.

## Commits

| SHA | Subject |
|---|---|
| `6288c2f` | docs(voice/s5): AGENT_PLAN before code |
| `310dee6` | feat(voice/s5): types + DNC check + tests |
| `dd09e08` | feat(voice/s5): quiet-hours check (CA/NY/TX/IL/FL) + tests |
| `540584d` | feat(voice/s5): consent check + tests |
| `23dcfa5` | feat(voice/s5): gate orchestrator + audit + applyTcpaGate + mode + tests |
| `90bfe68` | feat(voice-agent/s5): TCPA consent-spoken audit log event (additive) |
| `4289862` | chore(functions/s5): wire tcpa test paths into pnpm test glob |

## Test results

| Suite | Result |
|---|---|
| `@pa/pa-orchestrator` | 1498 / 1498 |
| `@pa/functions` | 1590 / 1590 (+60 new TCPA tests) |
| `voice-agent` | 55 / 55 (+5 new consent-audit tests) |
| `runner-prescreen pass.yaml` | PASS 3/3 |
| `runner-prescreen pause.yaml` | PAUSE 0/6 (expected) |

`fail.yaml` + `hard-stop.yaml` excluded per task #11.

## Lock compliance

- **L1** clean — all TCPA in `apps/functions/src/voice/tcpa/`; voice-agent edit purely additive.
- **L2** clean — gate runs strictly pre-dial.
- **L4** — `readGateMode()` defaults `observed` when env unset.
- **L8** — voice-agent emits `voice.tcpa.consent_spoken` structured log.
- **L12** — runs in existing Firebase Functions runtime.

## Files

### Added — `apps/functions/src/voice/tcpa/`
- `types.ts`, `dncCheck.ts`, `quietHours.ts` (NANPA→state, IANA-tz local-hour, FCC 21:00–08:00), `consentCheck.ts`, `gate.ts` (`runTcpaGate` + `applyTcpaGate`), `mode.ts`, `index.ts`
- `__tests__/`: dnc(5) + quiet-hours(15) + consent(8) + gate(11) + gate-audit(5) + apply(4) + mode(12) = 60

### Added — `apps/voice-agent/src/`
- `consent-audit.ts` — `buildConsentSpokenAudit` + `emitConsentSpokenAudit`; FNV-1a 32-bit prompt-hash
- `__tests__/consent-audit.test.ts` (5)

### Modified
- `apps/voice-agent/src/worker.ts` — 2 lines after `session.say(consentLine)`
- `apps/voice-agent/package.json`, `apps/functions/package.json` — test glob

## S3 integration recipe (for P10 merge)

S5 based on S2, not S3 (S3's `dialOutbound.ts` not on S2 branch). When P10 merges S5+S3, **one call site** inside `handleDialOutbound`:

```ts
import { runTcpaGate, applyTcpaGate, readGateMode } from "../tcpa/index.js"

// After identity validation, BEFORE sipClient.createSipParticipant:
const decision = await runTcpaGate(
  { bookingId, paUserId, phoneE164 },
  { fs: deps.fs, mode: readGateMode(), now: deps.now, log: deps.log },
)
const applied = await applyTcpaGate(decision, bookingRef, { now: deps.now })
if (applied.shouldShortCircuit) {
  log("warn", "dialOutbound:tcpa_block", { bookingId, reason: decision.reason, mode: decision.mode })
  return { action: "failed:tcpa_gate", bookingId, errorMessage: `tcpa_gate:${decision.reason}` }
}
```

Steps: insert snippet → add `"failed:tcpa_gate"` to `DialOutboundResult.action` union → add `fs: Firestore` to `DialOutboundDeps`. No env wiring; `readGateMode()` reads `process.env.PA_TCPA_GATE_ENFORCED` directly.

## S6 hand-off

1. **DNC seed**: `voice-dnc/+15558675309` with `{ addedBy: "smoke", reason: "smoke_test" }`
2. **Consent flip**: set `pa-users/{testUid}.consent.voiceRecording = false`/`true`
3. **Env flags**:
   - `PA_TCPA_GATE_ENFORCED=true` → blocking smoke (booking failed + audit row)
   - unset/`false` → observed smoke (proceeds to `dialing` + audit row `mode=observed`)
4. **Audit assertion**: query `voice-tcpa-checks where bookingId == <smokeBooking>` → exactly one row
5. **Consent-spoken log**: structured `voice.tcpa.consent_spoken` with `bookingId`, `paUserId`, `lang`, `voiceMode`, `spokenAt`, `promptHash`

## Adam-action

- **None blocking.** Defaults `observed`; safe to deploy.
- **Prod enforce path**: set `PA_TCPA_GATE_ENFORCED=true`. Recommended: dev observed → staging observed 1wk → prod observed 2wk (review audit volume) → prod blocking.

## Deferred to v2.2

- Number portability (carrier CTZ lookup)
- Multi-tz coarse-only (TX→CT, FL→ET, IL→CT)
- State coverage limited to CA/NY/TX/IL/FL (~80 NPAs)
- No EBR / time-bound consent model
- No admin UI for `voice-dnc/` or `voice-tcpa-checks/`
