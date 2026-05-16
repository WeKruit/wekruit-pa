# S4 — PLAN

1. AGENT_PLAN.md
2. `voice-call-metrics/{voiceCallSid}/turns/{i}` schema
3. `metricsWriter` subscriber on S2 hook
4. TTFA computation (assert against fixture)
5. False-commit / false-interrupt flag derivation from `agent_false_interruption` + STT events
6. Cost aggregation from `session_usage_updated`
7. `costCeiling` watchdog $0.90 warn / $1.00 block (L11)
8. `aggregateQuery` callable CF (admin-claim gated)
9. Tests per piece
10. Regression gate
11. Push, SUMMARY.md, report
