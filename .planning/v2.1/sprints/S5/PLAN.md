# S5 — PLAN

1. AGENT_PLAN.md
2. `voice-dnc/{phoneE164}` Firestore collection + admin write path
3. `dncCheck.ts`
4. `quietHours.ts` with CA / NY / TX baseline (timezone-aware)
5. `consentCheck.ts` reads `pa-users/{userId}.consent.voiceRecording`
6. `gate.ts` orchestrator
7. Mode plumbing (`PA_TCPA_GATE_ENFORCED` env)
8. Hook: gate-call inserted in S3 `dialOutbound` before LiveKit dispatch
9. Hook: recording consent prompt as S2 worker first utterance
10. `voice-tcpa-checks/{bookingId}` audit-write per call
11. Tests
12. Regression gate
13. Push, SUMMARY.md
