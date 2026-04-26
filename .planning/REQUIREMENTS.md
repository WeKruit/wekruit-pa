# Milestone requirements (PA Control Plane + Personality Memory)

## P0 — Must have

1. **Broker correctness**
   - Broker-managed outbound must not create duplicate `role=user` transcript rows.
   - Inbound events must be idempotent, claimable, retryable, and recoverable after process restarts.
   - Outbound jobs must not get stuck forever in `sending`; stuck jobs need lease/backoff/retry semantics.
   - Safety terminal states must not spam retries/audit logs every orchestrator tick.

2. **Operator dashboard UX**
   - Replace raw debug tables with a clear information architecture: Overview, Conversations, Agents, Operations, Platform, and E2E Lab.
   - Operators can answer: is the system healthy, which conversations need attention, which queue items failed, and what action is safe next?
   - Dangerous actions such as retry, dead-letter, model override, and kill switch require confirmation, feedback, and audit context.

3. **Agent and persona management**
   - Agents need registry semantics: default uniqueness, model, prompt, tool policy, memory mode, draft/published status, version history, and safe rollback.
   - The requested target model is `gpt-5.4-nano`, but rollout must verify provider support before switching production default.
   - Persona management must be explicit and auditable, not hidden inside one freeform prompt.

4. **Conversation management**
   - Conversations need a workbench with transcript, active agent, memory state, turns, outbound queue, connector calls, and audit/safety timeline.
   - Outbound assistant messages and inbound user messages must remain correctly attributed.
   - Email and phone iMessage identities must not accidentally split or merge sessions without an explicit link.

5. **Memory foundation**
   - Keep `firestore_only` reliable as the baseline.
   - Add an auditable Firestore evol/persona map before making Mem0 required.
   - Mem0 self-host on Fly.io + Supabase can be supported behind `MEM0_BASE_URL` and `MEM0_API_KEY`, with OSS/cloud API compatibility handled explicitly.
   - Surprise/personality behavior must be opt-in, rate-limited/cooldown-based, and logged.

6. **Current-info correctness**
   - Questions about recent/latest/today/news/movies/weather/prices must not be answered from stale model knowledge.
   - The orchestrator must route current-info intents through a platform-managed connector, not an arbitrary LLM tool loop.
   - The connector must record `pa_tool_calls` / audit data and preserve `suppressOutbound` in scenario harness runs.
   - OpenAI web search credentials must be isolated in `PA_CURRENT_INFO_OPENAI_API_KEY`; do not reuse the SiliconFlow/OpenAI-compatible runtime key.
   - If the realtime connector is unavailable, missing credentials, denied, or returns no usable text, the response must fall back to the existing boundary message.

## P1 — Should have

- CI-safe tests for broker lifecycle, rate limits, orchestrator happy/error paths, worker echo suppression, and dashboard smoke.
- Manual Mac/iMessage runbook remains the source of truth for real channel verification.
- Operations should expose queue depth, stuck leases, recent failures, and health summary.
- UI should pass an explicit design review and avoid generic raw-table/admin-console feel.
- Current-info production enablement should include Firebase secret binding, functions deploy, REST/CLI metadata verification, production harness, and `pa_outbound=0` check.

## Out of scope (this milestone)

- Multi-tenant enterprise IAM.
- HA fleet of Mac workers.
- Full autonomous tool loop with arbitrary connectors.
- Surprise/personality behavior enabled broadly before dogfood safety.
