# S5 TCPA Plumbing — SUMMARY

> Sprint: v2.1 S5
> Branch: `claude/v21-S5-tcpa-plumbing` (from `claude/v21-S0-foundation`)
> Worktree: `.claude/worktrees/v21-S5-tcpa-plumbing` (removed post-merge)
> Status: Code-complete, tests green, integrated into `claude/v21-integration`. **Flag off in dev (`PA_TCPA_GATE_ENFORCED=false`); blocking in prod.**

## What landed

Pre-dispatch TCPA gate orchestrator + 4 independent checks (DNC, quiet-hours, prior consent, dual-mode enforcement) + audit log of the consent-spoken moment from voice-agent. Plumbing complete; production flip = v2.2 launch gate.

| Commit | Subject |
|---|---|
| 6288c2f | docs(voice/s5): AGENT_PLAN before code |
| 310dee6 | feat(voice/s5): types + DNC check + tests |
| dd09e08 | feat(voice/s5): quiet-hours check (CA/NY/TX/IL/FL) + tests |
| 540584d | feat(voice/s5): consent check + tests |
| 23dcfa5 | feat(voice/s5): gate orchestrator + audit + applyTcpaGate + mode + tests |
| 90bfe68 | feat(voice-agent/s5): TCPA consent-spoken audit log event (additive) |
| 4289862 | chore(functions/s5): wire tcpa test paths into pnpm test glob |

## Files added (`apps/functions/src/voice/tcpa/`)

- `types.ts` — `TcpaCheckResult`, `TcpaGateMode = "enforce" | "observe"`, `TcpaGateDecision`.
- `dncCheck.ts` — reads `voice-dnc/{phoneE164}`; blocks if registered.
- `quietHoursCheck.ts` — state-aware (CA/NY/TX/IL/FL stricter window) + default 8am–9pm recipient-local.
- `consentCheck.ts` — reads `voice-tcpa-checks/{paUserId}_{paJobId}` for prior explicit consent record.
- `gate.ts` — `applyTcpaGate(booking)` orchestrator; runs all 4 checks; `mode` from `PA_TCPA_GATE_ENFORCED` env (default `"observe"` = audit-only).
- `audit.ts` — writes `voice-tcpa-audit/{bookingId}_<runId>` with full check breakdown for every dispatch attempt.
- `__tests__/*.test.ts` — 31 unit tests across the 4 checks + orchestrator + mode toggle + audit shape.

## Files added (`apps/voice-agent/src/`)

- `consent-audit.ts` — `emitConsentSpokenAudit(callContext, line, log)`; called from `worker.ts` after `session.say(consentLine)`.
- `__tests__/consent-audit.test.ts` — verifies shape + structured log line emission.

## Locks held

- **L4 dual-mode (TCPA = production gate, NOT dev gate)** — `applyTcpaGate` returns `{ allowed: true, reasons: [...] }` in observe mode regardless of check failures. `PA_TCPA_GATE_ENFORCED=true` flips to blocking with `allowed: false`. Test `gate.test.ts` covers both branches.
- **L8 consent disclosure spoken** — voice-agent speaks consent line first (`worker.ts:249-255`), then emits `voice.tcpa.consent_spoken` audit.

## Firestore collections added

- `voice-dnc/{phoneE164}` — `{ registeredAt, source: "internal" | "ftc_import" | "candidate_request" }`
- `voice-tcpa-checks/{paUserId}_{paJobId}` — `{ consentGivenAt, channel: "sms" | "web" | "manual", evidence }`
- `voice-tcpa-audit/{bookingId}_<runId>` — `{ ts, mode, allowed, reasons[], dncResult, quietHoursResult, consentResult, callerId, recipientPhoneHash }`

## Tests

`apps/functions` tcpa test glob: 31/31 green. `apps/voice-agent/consent-audit.test.ts`: 4/4 green.

## Hand-off

S3 `dialOutbound.ts` calls `applyTcpaGate(booking)` ahead of LiveKit SIP dispatch. In dev (`PA_TCPA_GATE_ENFORCED=false`) we audit-only → smoke tests proceed regardless. Production v2.2 flips env to `true` after consent flows audited.
