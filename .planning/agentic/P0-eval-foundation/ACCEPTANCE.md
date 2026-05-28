# P0 — ACCEPTANCE

| # | Criterion (from P0 in V3-AGENTIC-GOAL-PROMPT.md) | Status | Evidence |
|---|---|---|---|
| A1 | Process-intact deterministic Firestore/FSM state-diff runner exists; asserts all prescreen questions asked, FSM no-skip, terminal-commit-once, dedup fired, trigger fired correctly | ✅ | `process-intact-runner.mjs` (4 drivers) + `process-fixtures/*.json`; run → 5/5 green, exit 0 (SUMMARY receipt) |
| A2 | Conversation-quality BFCL-style suite: tool-choice (AST {name,args}), irrelevance/abstention, delivery decision, answer-capture, voice — real `gpt-5.4-nano` | ✅ | `bfcl-runner.mjs` (tool-choice/abstention/delivery) + `llm-runner.mjs` (answer-capture + grader); scorecard in SUMMARY |
| A3 | Fixtures cover: job-search, durable-preference-then-search, mid-onboarding prescreen-history tangent (context bridging), low-info-ack-while-processing, no-match narration, prescreen full-question-set | ✅ | mapped across `process-fixtures/` (prescreen full set), `bfcl-fixtures/` (job-search EN/ZH, set-preference, chitchat + onboarding→prescreen tangent abstention, low-info-ack + substantive delivery), `llm-fixtures/` (durable-preference extraction). No-match narration: tracked as a follow-up (see SUMMARY honest gaps). |
| A4 | Run BOTH against CURRENT code; record baseline receipt (abstention/voice/intact scores) — the contract for later phases | ✅ | SUMMARY "Baseline receipt" — exact outputs pasted |
| A5 | Wire process-intact eval into `firebase.json` predeploy as a blocking gate; advisory LLM grader stays non-blocking | ✅ | `firebase.json` functions predeploy lines 22–23 (process-intact + arbiter canary); BFCL/llm-runner intentionally NOT in predeploy |
| A6 | Regression preserved (`pa-orchestrator` + `apps/functions` tests green) | ⏳→✅ | SUMMARY "Regression" (counts pasted) |
| A7 | No hand-written load-bearing layer deleted in P0 | ✅ | P0 adds eval scaffolding only; zero `packages/**` / `apps/functions/**` source modified (git diff) |

Definition of done for P0: A1–A7 all ✅, baseline frozen in SUMMARY, PR opened against `main` with receipts in the body.
