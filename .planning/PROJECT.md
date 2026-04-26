# Jobless / PA Platform

Monorepo: Mac **Photon iMessage worker** + Firestore **`pa_*`** + **PA Console** (Vite, `wekruit-pa.web.app`). Auth: Google; Firestore rules: `@wekruit.com` + allowlisted Gmail (see `config/firebase/firestore.rules`).

## Current milestone (brownfield)

**Goal:** Turn the working local iMessage E2E into a usable PA control plane: broker correctness, reliable operations, product-grade dashboard UX, agent/persona management, conversation management, an auditable memory foundation, and safe current-info retrieval.

The real iMessage path is green: inbound creates durable `pa_inbound_events`, orchestrator completes turns, transcript writes, `pa_outbound` sends, reset works, and cross-turn memory recall has been validated. Phase 2 harness now uses broker injection with `suppressOutbound` so production scenarios do not send real iMessages. Phase 3 Memory Admin is live in PA Console.

Current-info is partially complete: stale “recent/latest” questions no longer fall through to old model knowledge, and `main` contains a `current-info` connector backed by OpenAI Responses API web search. Production enablement still requires the dedicated Firebase secret `PA_CURRENT_INFO_OPENAI_API_KEY` plus a functions deploy and harness verification.

### Product direction

- **iMessage worker remains a channel adapter**: no agent brain and no duplicate transcript writes for broker-managed outbound.
- **Firestore remains the control plane**: durable queues, transcripts, agent configs, operation state, persona/evolution facts, and audit trails.
- **SiliconFlow remains the primary LLM runtime** for deployed PA functions. Current-info web search uses a separate `PA_CURRENT_INFO_OPENAI_API_KEY` secret so it does not collide with the OpenAI-compatible SiliconFlow env path.
- **Mem0 is optional semantic recall**: self-hosting is a future capability, not a hard dependency for core replies.
- **Dashboard must become an operator product**, not a raw Firestore table viewer.
- **Current-info must fail closed**: if realtime search is unavailable, PA says it cannot reliably answer rather than giving stale movies/news/weather/prices.

See `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`.
