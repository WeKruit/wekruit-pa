# S5 TCPA — ACCEPTANCE

## Functional

- [ ] DNC check blocks dial when phone in `voice-dnc/`
- [ ] Quiet-hours blocks CA 11pm PT (+ NY, TX equivalents)
- [ ] Consent-missing blocks dial
- [ ] `observed` mode logs but does not block (env `PA_TCPA_GATE_ENFORCED=false`)
- [ ] `blocking` mode writes booking `voiceState=failed:tcpa_gate` + reason code
- [ ] Audit row written every check regardless of mode

## Lock compliance

- [ ] L4 TCPA = prod gate not dev gate
- [ ] L8 recording consent prompt plays at call start (S2 hook addition only)

## Regression gate

- [ ] Standard 6 commands green
- [ ] S5 unit tests green
