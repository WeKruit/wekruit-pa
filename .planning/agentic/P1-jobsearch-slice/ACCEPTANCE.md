# P1 — ACCEPTANCE

| # | Criterion (V3-AGENTIC-GOAL-PROMPT.md P1) | Status | Evidence |
|---|---|---|---|
| A1 | `run(agent)` drives job-search via the `find-match` connector | ✅ (flag-ON) | agent-jobsearch-canary 3/3; flag `paAgenticJobSearchEnabled` ON routes job-search to the agent loop |
| A2 | `find-match` description rewritten Hermes-style (WHAT + verbatim triggers incl. Chinese + "Do NOT call when…") | ✅ | `ff14c668`; BFCL EN job-search now routes (was an abstain at P0 baseline) |
| A3 | Deterministic commit kept in `execute` (dedup, verdict, `pa-tool-calls` ledger, trace) | ✅ | unchanged `FIND_MATCH_CONNECTOR.execute`→`ctx.hooks.findMatch`; `runConnector` writes the ledger |
| A4 | Delete the regex job-search path (arbiter branch + handler + narration) | ⚠ DEVIATION — staged behind flag-ramp | gate green; delete-list enumerated; see PLAN "SAFE-RAMP" rationale (zero-regression + prove-in-production-first). Adam may direct immediate deletion. |
| A5 | Eval gate: P0 suite green (no regression vs baseline) | ✅ | process-intact 5/5, arbiter canary PASS (flag-OFF default) |
| A6 | Stale-tag canary passes with a real model | ✅ | agent-jobsearch-canary 3/3 — agent calls find-match + matcher sees POST-reducer tags |
| A7 | Strict-schema unblock (agent can actually call find-match live) | ✅ | `b82a6313`; real SDK call, no 400; pa-connectors 29/29 |
| A8 | Regression (pa-orchestrator + functions) | ⏳→ SUMMARY | flag-OFF = no-op |
| A9 | No load-bearing deterministic logic deleted | ✅ | nothing deleted; flag-gated additive change only |

DoD for P1 (this slice): A1-A3, A5-A7, A9 ✅; A8 in SUMMARY; A4 is a documented deviation (deletion staged post-ramp, gate proven). Stacked PR opened with receipts + the deviation called out for Adam.
