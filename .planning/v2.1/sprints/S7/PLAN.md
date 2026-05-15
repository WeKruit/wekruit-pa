# S7 — PLAN

1. Read S0..S6 SUMMARY.md + S6 SMOKE-REPORT.md
2. Verify 12 locks held (diff scan: no agent-runtime or PreScreenPipeline.runTurn edits)
3. Verify 7 Done-criteria checkboxes (smoke pass, PII, TTFA, cost, TCPA, telemetry, hangup)
4. If any criterion fails → STOP, open follow-up sprint
5. Finalize `.planning/v2.2/HANDOFF-from-v2.1.md` from S0 skeleton
6. Merge to main in dep order: S0 → S1A → S1B → S1C → S2 → S3 → S4 → S5 → S6
7. After each merge: regression gate against main, `git worktree remove`
8. Tag `v2.1-internal-smoke-shipped` on main HEAD
9. SUMMARY.md
10. Adam ship approval request
