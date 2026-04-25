# Milestone state

- **Previous E2E gap closure:** complete locally. Worker health passes, Firestore Admin smoke passes, iMessage inbound/outbound E2E completed, OpenAI direct runtime works.
- **Current phase:** Complete — PA Control Plane + Personality Memory milestone implementation pass.
- **Completed code fix:** broker-managed outbound (`out-imessage-in-*`) is no longer appended by the outbox as `role=user`.
- **Completed reliability fix:** expired `processing` inbound leases are now listed by the scanner so the orchestrator can reclaim stuck work.
- **Current test baseline:** root `npm test` runs all package tests; current total is 33 passing tests across worker, agent registry, memory, broker, orchestrator, and safety.
- **Completed UI step:** `/` now renders an operator Overview; prior Users list moved to `/conversations`; side nav has active state and responsive shell styling.
- **Completed workbench step:** Conversations support search/filter/latest/error columns; detail links transcript, turns, outbound, connectors, audit/safety, and memory; Operations has tabs, filters, reasoned retry/dead-letter, scheduled jobs, and heartbeats.
- **Completed agent/persona step:** Agent schema supports status, persona controls, model probe state, lifecycle timestamps, publish/rollback snapshots, and guarded default switching.
- **Completed memory step:** Firestore persona facts feed deterministic persona cards; Mem0 supports cloud/OSS modes; surprise protocol has opt-in/cooldown/sensitivity guardrails.
- **Completed runtime step:** Firestore scheduled jobs and runtime heartbeats have broker helpers, tests, and dashboard visibility.
- **Known model gap:** official model slug is `gpt-5.4-nano`; the earlier failed probe used the wrong `gpt5.4nano` string. Keep current live default stable until a probe for the official slug passes in the configured provider/ATM path.
- **Known ATM gap:** `ATM_BASE_URL` and `VALET_ATM_TOKEN` are set, but default PA profile path returns `Unsupported runtime profile "personal-assistant-default"`.
- **Review constraint:** Full `gstack-design-review` atomic screenshot/fix loop still requires a clean working tree and explicit commit permission. Equivalent code-level review notes are captured in Phase 8.
- **Known bundle gap:** dashboard production build passes but Vite warns the main chunk is larger than 500 kB.
