# S4 Turn Telemetry + Cost Ceiling — ACCEPTANCE

## Functional

- [ ] One `voice-call-metrics/{voiceCallSid}/turns/{i}` row per turn for sim run.
- [ ] TTFA computed correctly (assert against fixture).
- [ ] False-commit / false-interrupt flags populated.
- [ ] Cost aggregation matches `session_usage_updated` payload.
- [ ] Cost ceiling watchdog signals close at $1.00.

## Lock compliance

- [ ] L11 cost ceiling enforced.
- [ ] No S2 worker source modified.
- [ ] No modification to `PreScreenPipeline.runTurn`.

## Done-criteria coverage

- [ ] Aggregate query path returns thresholds usable in S6 smoke gate.

## Regression gate

- [ ] Standard 6 commands green
- [ ] S4 unit tests green
