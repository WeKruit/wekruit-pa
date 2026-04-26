# Jobless / PA Platform

Monorepo: Mac **Photon iMessage worker** + Firestore **`pa_*`** + **PA Console** (Vite, `wekruit-pa.web.app`). Auth: Google; Firestore rules: `@wekruit.com` + allowlisted Gmail (see `config/firebase/firestore.rules`).

## Current milestone (brownfield)

**Goal:** Turn the working local iMessage E2E into an agentic job-search companion: OpenAI Agents SDK as the runtime spine, WeKruit-owned identity/memory/audit controls, safe live current-info retrieval, and proactive recruiter-style follow-up.

The real iMessage path is green: inbound creates durable `pa_inbound_events`, orchestrator completes turns, transcript writes, `pa_outbound` sends, reset works, and cross-turn memory recall has been validated. Phase 2 harness now uses broker injection with `suppressOutbound` so production scenarios do not send real iMessages. Phase 3 Memory Admin is live in PA Console.

Current-info is in transition: stale “recent/latest” questions no longer fall through to old model knowledge, and `main` is moving the `current-info` connector from hand-written Responses API fetches to OpenAI Agents SDK hosted `web_search`. Production enablement uses one general OpenAI agent/tool secret, `PA_OPENAI_AGENT_API_KEY`, plus a functions deploy and live harness verification.

### Current milestone targets

- **OpenAI Agents SDK becomes the runtime spine** for OpenAI-native tools and future agent workflows. Avoid long-lived hand-written Responses fetch wrappers when the Agents SDK exposes the hosted tool directly.
- **One OpenAI agent/tool secret**: use `PA_OPENAI_AGENT_API_KEY` for official OpenAI Agents SDK hosted tools. Do not keep a current-info-specific key name.
- **WeKruit keeps product control**: identity, memory, scheduling, outbound policy, audit, dashboard, and user consent stay in Firestore/PA Console, with context injected into agent turns instead of outsourced to opaque ChatGPT product memory.
- **Mem0/Qdrant + Memory Admin stay**: semantic recall remains inspectable/deletable in PA Console. OpenAI file/vector search can be evaluated later as another provider, not as an immediate replacement.
- **Job companion direction**: PA should become a personal job-search companion/recruiter presence that periodically asks about projects/job-search status and proactively notifies users about matched roles when allowed.

### Product direction

- **iMessage worker remains a channel adapter**: no agent brain and no duplicate transcript writes for broker-managed outbound.
- **Firestore remains the control plane**: durable queues, transcripts, agent configs, operation state, persona/evolution facts, and audit trails.
- **SiliconFlow can remain the OpenAI-compatible model path**, but OpenAI-native hosted tools and agent workflows use OpenAI Agents SDK through `PA_OPENAI_AGENT_API_KEY`.
- **Mem0 is optional semantic recall**: self-hosting is a future capability, not a hard dependency for core replies.
- **Dashboard must become an operator product**, not a raw Firestore table viewer.
- **Current-info must fail closed**: if realtime search is unavailable, PA says it cannot reliably answer rather than giving stale movies/news/weather/prices.
- **Proactive outreach must be permissioned**: scheduled nudges, job-match notifications, and recruiter-style follow-up require cooldowns, audit events, and a clear outbound policy.

See `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`.
