# Leader Handoff Prompt

You are the engineering leader for WeKruit PA. Lead a multi-P9 team to deliver the production personal assistant platform in this repository.

## Mission

Build a multi-user AI personal assistant platform where users message WeKruit directly, receive assistant replies, and keep private per-user memory. The platform must support iMessage first, then future channels. It must have durable queues, session management, agent runtime orchestration, memory, safety controls, downstream connectors, and an operator dashboard.

## Repository

GitHub: `https://github.com/WeKruit/wekruit-pa`

Important files:

- `ARCHITECTURE.md`
- `CURRENT_VS_TARGET.md`
- `PLAN.md`
- `SEQUENCE.md`
- `apps/macos-imessage-worker`
- `apps/dashboard-web`
- `packages/agent-runtime`
- `packages/memory`
- `packages/core-types`

## Current Reality

Already exists:

- Dashboard app in `apps/dashboard-web`.
- Mac iMessage worker in `apps/macos-imessage-worker`.
- Firestore collections: `pa_users`, `pa_sessions`, `pa_messages`, `pa_agents`, `pa_remote_config`, `pa_outbound`.
- `packages/agent-runtime` can run one OpenAI-compatible turn.
- `packages/memory` can load Firestore transcript and optionally call Mem0.
- Phone and email iMessage inbound paths have been manually exercised.

Not production-ready:

- No durable inbound broker yet.
- No `pa_agent_turns` state machine yet.
- Agent runtime is not an orchestrator.
- No connector platform yet.
- No safety layer beyond basic kill switch concepts.
- Per-user memory exists only as `userId` passed to Mem0; memory namespace, retention, inspection, deletion, and write filtering are missing.
- Session management exists only as basic Firestore session rows.
- Dashboard lacks queue, turn, connector, safety, and memory control surfaces.

## Non-negotiable Architecture Decisions

1. Firestore is the source of truth for transcript and operational state.
2. Mem0 is optional long-term memory, never the only copy of conversation history.
3. The Mac worker is a channel adapter, not the agent brain.
4. Every inbound message must become a durable event before agent work.
5. Every assistant reply must be written to transcript before outbound send.
6. Every connector call must go through a registry, schema, policy check, and audit log.
7. Prompt safety cannot rely only on system prompts.
8. User memory must be isolated by stable `userId` or explicit `mem0UserId`, never by raw text or shared global memory.

## Recommended Open-source Leverage

Use open source where it removes mechanics, but keep WeKruit identity, queues, policies, and audit state in Firebase.

Recommended:

- OpenAI Agents SDK TypeScript for tool calling, handoffs, MCP integration, tracing, and guardrail hooks.
- Firebase broker first for state and queues; evaluate Cloud Tasks or Inngest if Firestore lease/retry code becomes too custom.
- Promptfoo for red-team regression tests against prompt injection, tool abuse, jailbreaks, and cross-session leaks.
- Guardrails AI or NeMo Guardrails for heavier input/output validation if rule-based safety is insufficient.
- Zod for all connector schemas and runtime payload validation.

Do not:

- Let the model call arbitrary HTTP endpoints.
- Put real business state inside framework-private memory.
- Add connectors before policy and audit exist.
- Ship Mem0 writeback without memory filtering and deletion/export path.

## P9 Team Topology

### P9-A: Platform And Repository

Owns:

- repo hygiene
- Firebase deploy targets
- secrets and env injection
- local and production runbooks
- worker process manager plan

Acceptance:

- repo installs from clean clone
- no secrets committed
- dashboard deploy target remains `wekruit-pa`
- worker start command is documented

### P9-B: Backend Broker

Owns:

- `pa_inbound_events`
- `pa_agent_turns`
- leases, retries, dead letter
- idempotency keys
- migration away from direct worker orchestration

Acceptance:

- worker restart during a turn does not lose the message
- duplicate inbound event does not create duplicate assistant replies
- failed turn is retryable or dead-lettered with reason

### P9-C: Agent Runtime

Owns:

- orchestrator package
- prompt builder
- OpenAI-compatible provider adapter
- tool call loop
- structured turn logs
- integration with selected agent framework

Acceptance:

- runtime can claim pending events independently of Mac worker
- runtime writes `pa_agent_turns` state transitions
- runtime can call a fake connector through tool router

### P9-D: Memory And Session

Owns:

- per-user memory namespace
- `mem0UserId` policy
- session lifecycle
- session merge/link model
- memory inspection/deletion/export
- memory write safety filter

Acceptance:

- each user has isolated memory
- phone and email sessions can remain separate or be explicitly linked
- Mem0 outage degrades without blocking replies
- unsafe memory writebacks are blocked and audited

### P9-E: Connector Platform

Owns:

- connector registry
- schemas
- policy engine
- audit events
- first connectors: `wekruit-matching`, `findx`, `scoring`
- automation connector skeleton

Acceptance:

- every connector call is typed and audited
- connector policy can block a tool call
- fake connector E2E passes before real downstream integration

### P9-F: Dashboard Control Plane

Owns:

- user list and detail
- transcript view
- agent assignment
- inbound/outbound queue view
- agent turn detail
- connector call detail
- memory view
- safety/abuse events
- retry controls

Acceptance:

- operator can debug one conversation without terminal logs
- operator can see failed turn and retry/dead-letter state
- operator can inspect user memory and session links

### P9-G: Trust And Safety

Owns:

- user/channel rate limits
- prompt injection checks
- connector allowlists
- per-agent tool budgets
- memory write filtering
- audit schema
- red-team tests

Acceptance:

- rate limit blocks abusive user
- prompt injection cannot trigger privileged connector
- cross-session leak test fails closed
- promptfoo red-team baseline is committed

### P9-H: QA And Ops

Owns:

- E2E matrix
- phone iMessage test
- email iMessage test
- outbound queue test
- restart-resume test
- runbook
- observability checklist

Acceptance:

- full E2E can be run by an operator from docs
- worker crash during processing is recoverable
- launch checklist has no terminal-only blind spots

## Execution Order

1. Freeze schemas for `pa_inbound_events`, `pa_agent_turns`, `pa_tool_calls`, `pa_audit_events`, `pa_rate_limits`, `pa_abuse_events`.
2. Move direct worker turn handling behind broker events.
3. Build runtime orchestrator with one fake connector.
4. Add memory/session policy and dashboard visibility.
5. Add connector registry and first real downstream connector.
6. Add safety layer and red-team tests.
7. Complete operator dashboard and E2E runbook.
8. Run acceptance tests on real Mac worker.

## Final Acceptance

A user sends an iMessage. The platform:

1. writes a durable inbound event
2. resolves user and session
3. enforces rate limits and safety
4. loads Firestore transcript and optional Mem0 memory
5. runs the assigned agent
6. optionally calls approved connectors
7. writes assistant response to transcript
8. enqueues outbound reply
9. sends iMessage
10. shows the full lifecycle in dashboard
11. can resume safely if the worker or runtime crashes midway

The project is not done until this works for phone and email iMessage handles, with one fake connector and one real downstream connector.

