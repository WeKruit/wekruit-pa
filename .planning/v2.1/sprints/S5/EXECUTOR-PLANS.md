# S5 TCPA Plumbing — EXECUTOR-PLANS

## 6-Element Task Prompt — S5

### 1. Objective
Wire TCPA gate plumbing so that in **prod** mode (`PA_TCPA_GATE_ENFORCED=true`) outbound dial is blocked on DNC / quiet-hours / consent-missing, while in **dev** mode the gate is observed-only (logs the would-block but allows dial). Insert recording consent prompt at call start.

### 2. Context
- L4 TCPA = prod gate, NOT dev gate. Default env in dev: `PA_TCPA_GATE_ENFORCED=false`.
- L8 Recording consent prompt at call start + storage in `wekruit-voice-recordings`.
- Hook points: S3 `dialOutbound` before LiveKit dispatch; S2 worker first-utterance.

### 3. Constraints
- Gate logic under `apps/functions/src/voice/tcpa/` (new dir).
- DNC list source: Firestore `voice-dnc/{phoneE164}` (admin-managed).
- Quiet-hours table inline-coded, ≥3 US states (CA, NY, TX minimum) with timezone awareness.
- Consent record source: `pa-users/{userId}.consent.voiceRecording` boolean + timestamp.
- All gate decisions logged to `voice-tcpa-checks/{bookingId}` regardless of mode.
- Atomic commits: DNC + quiet-hours + consent → gate orchestrator → mode plumbing → consent prompt wiring → tests.

### 4. Deliverables
- `apps/functions/src/voice/tcpa/dncCheck.ts`
- `apps/functions/src/voice/tcpa/quietHours.ts`
- `apps/functions/src/voice/tcpa/consentCheck.ts`
- `apps/functions/src/voice/tcpa/gate.ts` (orchestrator)
- S2-worker consent-prompt-hook addition (in S5 worktree, additive only — does NOT count as agent-runtime edit)
- Tests:
  - DNC blocks dial when phone in list
  - Quiet-hours blocks dial for CA at 11pm PT
  - Consent missing blocks dial
  - `observed` mode logs but does NOT block
  - `blocking` mode blocks and writes `failed:tcpa_gate` to booking
  - Audit row written every check
- `AGENT_PLAN.md` BEFORE code.
- `.planning/v2.1/sprints/S5/SUMMARY.md`.

### 5. Verification
Regression gate + S5 tests green. Manual: flip flag, attempt dial, verify booking state.

### 6. Done-criteria
- [ ] All gate sub-checks tested
- [ ] Both modes tested (blocking + observed)
- [ ] Audit collection populated
- [ ] Recording consent prompt plays at call start
- [ ] Regression gate green
- [ ] Branch pushed, SUMMARY filled
