# wekruit-pa

Personal assistant platform for WeKruit.

This repository contains:

- `apps/macos-imessage-worker`: Mac iMessage channel worker
- `apps/dashboard-web`: operator dashboard
- `packages/agent-runtime`: current LLM provider wrapper, target home for turn orchestration
- `packages/memory`: Firestore transcript context and optional Mem0
- `packages/core-types`: shared Firestore schemas
- `packages/firebase-admin`: Admin SDK helper
- `packages/agent-registry`: agent seed and lookup
- `config`: runbooks, Firebase rules, deployment docs

Important docs:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [PLAN.md](PLAN.md)
- [SEQUENCE.md](SEQUENCE.md)
- [CURRENT_VS_TARGET.md](CURRENT_VS_TARGET.md)
- [LEADER_HANDOFF.md](LEADER_HANDOFF.md)
- [config/E2E-MAC-FIREBASE-DASHBOARD.md](config/E2E-MAC-FIREBASE-DASHBOARD.md)
- [config/MEM0-SELF-HOST.md](config/MEM0-SELF-HOST.md)

Current production Firebase project: `wekruit-5f89b`.

Dashboard hosting target: `wekruit-pa`.
