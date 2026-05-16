# S6 Smoke + Recordings — ACCEPTANCE

## Done-criteria gates

- [ ] ≥8/10 smoke calls PASS (no agent crash, scoring produced, recording archived)
- [ ] 0 PII leaks (audit script clean)
- [ ] p50 TTFA <1.5s
- [ ] Cost per call <$1
- [ ] <10% false-commit rate (S4 aggregate)
- [ ] <5% false-interrupt rate (S4 aggregate)

## Functional

- [ ] LiveKit Egress writes recordings to `wekruit-voice-recordings`
- [ ] Recordings spot-check retrievable (3 random calls)
- [ ] Transcripts stored alongside recordings
- [ ] SMOKE-REPORT.md produced

## Regression gate

- [ ] Standard 6 commands green
