# S1A — PLAN (sprint-internal task graph)

1. AGENT_PLAN.md → file targets, signature, test names, provider choice
2. Lock signature commit: export `runAgentTurnStream` + `AgentTurnStreamChunk` type, throw on flag-off
3. Implementation commit: stream provider call (current `runAgentTurn` provider, add streaming code path), wire flag
4. Tests commit:
   - chunk-emit test (≥3 chunks)
   - flag-off throws
   - finishReason on last chunk
   - golden snapshot of `runAgentTurn` byte-output
5. Regression gate: orchestrator + functions + 4 prescreen scenarios
6. Push branch, write SUMMARY.md, report
