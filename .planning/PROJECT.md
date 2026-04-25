# Jobless / PA Platform

Monorepo: Mac **Photon iMessage worker** + Firestore **`pa_*`** + **PA Console** (Vite, `wekruit-pa.web.app`). Auth: Google; Firestore rules: `@wekruit.com` + allowlisted Gmail (see `config/firebase/firestore.rules`).

## Current milestone (brownfield)

**Goal:** Turn the working local iMessage E2E into a usable PA control plane: broker correctness, reliable operations, product-grade dashboard UX, agent/persona management, conversation management, and an auditable memory foundation.

The local E2E path is green: real iMessage inbound creates durable `pa_inbound_events`, orchestrator completes turns, transcript writes, `pa_outbound` sends, and OpenAI direct runtime is configured. The next milestone is about making that path reliable, visible, and operator-manageable.

### Product direction

- **iMessage worker remains a channel adapter**: no agent brain and no duplicate transcript writes for broker-managed outbound.
- **Firestore remains the control plane**: durable queues, transcripts, agent configs, operation state, persona/evolution facts, and audit trails.
- **OpenAI runtime is direct-key first** until ATM exposes a valid PA runtime profile. Official target slug is `gpt-5.4-nano`; the earlier failed probe used the wrong `gpt5.4nano` string, so the official slug still needs a runtime probe before becoming default.
- **Mem0 is optional semantic recall**: self-hosting is a future capability, not a hard dependency for core replies.
- **Dashboard must become an operator product**, not a raw Firestore table viewer.

See `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`.
