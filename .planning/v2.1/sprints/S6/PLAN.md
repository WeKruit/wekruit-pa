# S6 — PLAN

1. AGENT_PLAN.md (smoke target list from Adam)
2. `tests/voice-smoke/runner.mjs` — 10 calls, seedable scenarios
3. LiveKit Egress configuration → GCS bucket `wekruit-voice-recordings`
4. `tests/voice-smoke/pii-audit.mjs` — SSN/DOB/address regex scan over transcripts
5. Smoke execution (10 calls)
6. Aggregate via S4 query: p50 TTFA, cost/call, false-commit %, false-interrupt %
7. `.planning/v2.1/sprints/S6/SMOKE-REPORT.md` ship-readiness report
8. Spot-check 3 random recordings retrievable from GCS
9. Regression gate
10. SUMMARY.md
