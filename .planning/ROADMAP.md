# Roadmap: Agent SDK Runtime + Job Companion

This roadmap is intentionally numeric so GSD phase tooling can discover and execute it.

| # | Phase | Goal | Requirements | Status |
|---|-------|------|--------------|--------|
| 1 | Broker correctness + echo suppression | Make the green iMessage E2E path reliable and non-polluting. | P0.1, P0.4 | Complete |
| 2 | Reliability, safety, and tests | Add CI-safe coverage for rate limits, broker lifecycle, orchestrator paths, and worker behavior. | P0.1, P1 | Complete |
| 3 | Dashboard shell + design system | Replace the raw admin feel with a coherent operator shell and reusable UI primitives. | P0.2, P1 | Complete |
| 4 | Operations and conversation workbench | Give operators a useful conversation/queue/debug workflow without tailing logs. | P0.2, P0.4 | Complete |
| 5 | Agent registry + persona controls | Upgrade agent management from row editing to versioned/published agent and persona control. | P0.3 | Complete |
| 6 | Memory evol map + Mem0 compatibility | Add Firestore persona/evolution memory and support Mem0 self-host compatibility as optional recall. | P0.5 | Complete |
| 7 | Scheduler and platform runtime | Add durable scheduled jobs, stuck job recovery, retry/backoff, and runtime heartbeats. | P0.1, P1 | Complete |
| 8 | Reviews, polish, and ship readiness | Run engineering/design reviews, close gaps, and produce final verification evidence. | P1 | Complete |
| 9 | Phase 2/3 production hardening | Make production verification repeatable and expose semantic memory safely in dashboard. | P0.1, P0.2, P0.4, P0.5 | Mostly complete |
| 10 | Agents SDK current-info connector | Answer recent/latest questions through Agents SDK hosted web search without stale model guesses. | P0.6, P0.7 | Complete (connector path only) |
| 10.5 | Agents SDK runtime cutover | Make Agents SDK the only agent runtime; default agent uses Responses API + gpt-5.4-nano (SiliconFlow demoted to env-gated fallback); allowlisted connectors + SDK webSearchTool; FirestoreSession owns history; regex pre-routers deleted (keep `__PA_RESET__`). Mem0 stays as memory empowerment. | P0.6, P0.7 | Complete |
| 11 | Persona + identity/memory injection | Restore persona facts, resolve memory identity semantics, and inject PA-owned context into agent turns. | P0.3, P0.5, P0.7, P0.9 | 11.1 complete; 11.3 not started |
| 12 | Job companion scheduled outreach | Add permissioned recruiter-style follow-up: project/status nudges, cooldowns, audit, and outbound policy. | P0.1, P0.8 | Not started |
| 13 | Job matching connector path | Add an auditable platform-managed path for matched-role notifications. | P0.4, P0.8 | Not started |
| 14 | Companion eval + harness expansion | Add scenario/eval coverage for current-info live search, persona, proactive outreach, and match rationale. | P0.6, P0.7, P0.8, P1 | Not started |
| 15 | Typing indicator / delivery feel | Improve iMessage delivery feel using Photon typing if available or chunk/delay simulation. | P1 | Not started |

## Phase 1: Broker correctness + echo suppression

**Goal:** Make the green iMessage E2E path reliable and non-polluting.
Requirements: P0.1, P0.4
**Success Criteria**:
1. Broker-managed outbound `out-imessage-in-*` does not create duplicate `role=user` transcript rows.
2. Worker tests prove broker-managed outbound is not appended as operator/user transcript.
3. `npm run build`, worker tests, and typecheck pass.
4. Manual iMessage test shows inbound user + assistant reply only, no assistant-as-user echo.

## Phase 2: Reliability, safety, and tests

**Goal:** Add automated coverage and close lifecycle correctness gaps that do not require a real Mac.
Requirements: P0.1, P1
**Success Criteria**:
1. Broker tests cover inbound idempotency, claim, fail, complete, dead-letter, and error clearing.
2. Safety tests cover rate limit allow/block, audit events, and abuse events.
3. Orchestrator tests cover happy path, no-key fallback, safety block, duplicate idempotency, and connector allow/deny.
4. Outbound stuck-job and allowlist failure behavior is explicit and tested.

## Phase 3: Dashboard shell + design system

**Goal:** Create a product-grade operator shell with shared components instead of page-local raw tables.
Requirements: P0.2, P1
**Success Criteria**:
1. App has responsive shell, active navigation, page headers, status badges, cards, data table, empty/error/loading states.
2. Overview route summarizes worker/orchestrator health, recent failures, queue counts, and next actions.
3. UI copy explains operator actions in product language rather than raw collection language.
4. `gstack-design-review` or equivalent visual audit is run and findings are captured.

## Phase 4: Operations and conversation workbench

**Goal:** Make a single conversation debuggable and manageable from the UI.
Requirements: P0.2, P0.4
**Success Criteria**:
1. Conversation list supports search/filter and shows latest message, active agent, and last error.
2. Conversation detail shows transcript, turns, outbound, connector calls, audit/safety, and memory events in linked sections.
3. Operations has tabs/filters/detail view and safe retry/dead-letter with confirmation and reason capture.
4. UI smoke tests cover route rendering and key action wiring.

## Phase 5: Agent registry + persona controls

**Goal:** Make agents manageable as versioned runtime configs instead of fragile Firestore rows.
Requirements: P0.3
**Success Criteria**:
1. Agent default uniqueness is enforced.
2. Agents support draft/published version metadata and rollback/audit.
3. Model field supports provider validation and does not switch live default to `gpt-5.4-nano` without a passing runtime probe.
4. Persona controls separate tone/style/boundaries/goals from freeform system prompt.

## Phase 6: Memory evol map + Mem0 compatibility

**Goal:** Add auditable personality memory without making Mem0 a hard dependency.
Requirements: P0.5
**Success Criteria**:
1. Firestore schemas/constants exist for memory profiles, facts, evolution events, and surprise events.
2. Prompt context can include a deterministic persona card from confirmed Firestore facts.
3. Mem0 supports cloud and OSS/self-host API modes behind env configuration.
4. Surprise protocol is opt-in, cooldown-bound, sensitivity-aware, and fully logged.

## Phase 7: Scheduler and platform runtime

**Goal:** Add durable runtime mechanics for delayed work, retries, and operational health.
Requirements: P0.1, P1
**Success Criteria**:
1. Scheduled jobs support `dueAt`, status, attempt count, max attempts, and backoff.
2. Inbound/outbound stuck processing jobs can be reclaimed or surfaced.
3. Worker/orchestrator heartbeat data is visible in Operations/Overview.
4. Tests cover retry/backoff and stuck-job recovery.

## Phase 8: Reviews, polish, and ship readiness

**Goal:** Finish with engineering, UI, and verification evidence.
Requirements: P1
**Success Criteria**:
1. `gstack-plan-eng-review` or equivalent engineering review is run against the plan/work.
2. `gstack-design-review` or equivalent visual review is run against the live dashboard.
3. `gsd-review` or external review is run for high-risk phase plans.
4. Final build/typecheck/test/manual E2E evidence is captured, and remaining gaps are documented.

## Phase 9: Phase 2/3 production hardening

**Goal:** Make the PA production path verifiable without manual iMessage spam and expose semantic memory safely.
Requirements: P0.1, P0.2, P0.4, P0.5
**Status:** Mostly complete.
**Success Criteria**:
1. Scenario harness injects broker events and defaults to `suppressOutbound`.
2. Runner verifies no accidental `pa_outbound` rows for harness events.
3. Recall, reset, multilingual, and current-info boundary scenarios exist.
4. Memory Admin dashboard can list/search/delete Qdrant semantic memory and clear a user only after explicit operator action.
5. Overview separates pending/running from historical failures to avoid false “waiting” alarms.

## Phase 10: Agents SDK current-info connector

**Goal:** Let PA answer “recent/latest/today” external information questions through OpenAI Agents SDK hosted `web_search` while retaining fail-closed behavior.
Requirements: P0.6, P0.7
**Status:** In progress.
**Success Criteria**:
1. `current-info` connector uses `@openai/agents` hosted `web_search`, not a hand-written Responses fetch wrapper.
2. Orchestrator invokes current-info before LLM stale-answer path.
3. Connector attempts are visible in `pa_tool_calls` and audit events.
4. Missing or failing connector falls back to boundary reply.
5. Production functions bind `PA_OPENAI_AGENT_API_KEY`, deploy on Node 22, and pass current-info production harness with `pa_outbound=0`.

## Phase 11: Persona + identity/memory injection

**Goal:** Restore persona facts, resolve memory identity semantics, and inject PA-owned identity/memory context into agent turns.
Requirements: P0.3, P0.5, P0.7, P0.9
**Status:** Not started.
**Success Criteria**:
1. Firestore persona facts are injected into runtime prompt again.
2. `mem0UserId` advisory regression is resolved or explicitly removed.
3. Agent turns receive identity and memory context from WeKruit stores, not opaque ChatGPT product memory.
4. Persona/human-feel changes are evaluated through scenarios rather than prompt guessing.

## Phase 12: Job companion scheduled outreach

**Goal:** Add permissioned recruiter-style follow-up for recent projects and job-search status.
Requirements: P0.1, P0.8
**Status:** Not started.
**Success Criteria**:
1. Scheduled outreach jobs can ask about recent projects/job-search status with cooldowns and max attempts.
2. Outbound policy blocks proactive messages without required user/session consent state.
3. Every proactive outreach has audit context visible in dashboard.

## Phase 13: Job matching connector path

**Goal:** Add a platform-managed path for matched-role notifications.
Requirements: P0.4, P0.8
**Status:** Not started.
**Success Criteria**:
1. Matching connector input/output schemas include role source, match rationale, and user fit facts.
2. Matched-role notifications require auditable connector results before outbound enqueue.
3. Dashboard exposes why a match notification was sent or suppressed.

## Phase 14: Companion eval + harness expansion

**Goal:** Make current-info, persona, proactive outreach, and match rationale testable before broad dogfood.
Requirements: P0.6, P0.7, P0.8, P1
**Status:** Not started.
**Success Criteria**:
1. Live current-info scenario verifies sourced answers when `PA_OPENAI_AGENT_API_KEY` is configured.
2. Boundary scenario still verifies fail-closed behavior when the hosted tool is unavailable.
3. Persona and proactive outreach scenarios verify no accidental outbound in harness mode.

## Phase 15: Typing indicator / delivery feel

**Goal:** Improve iMessage perceived responsiveness.
Requirements: P1
**Status:** Not started.
**Success Criteria**:
1. Photon typing support is researched.
2. If true typing is unavailable, chunked message + delay behavior is implemented without duplicate outbound or harness leakage.
