# Execution Plan

## Strategic Direction

Build WeKruit PA as an event-driven assistant platform. Sendblue transport is only a channel adapter, not the brain. Firebase is the broker and source of truth. Agent runtime owns turn orchestration. Connectors are explicit tools behind policy, schemas, and audit logs.

## Success Criteria

- 100 concurrent users can send messages without losing turns when the worker restarts.
- Every inbound message has durable state from receipt to reply or dead letter.
- Each user has isolated transcript and memory.
- Operators can see users, agents, messages, health, queues, failed turns, and connector calls.
- Connectors can call WeKruit downstream systems only through approved policies.
- Abuse controls block or throttle unsafe usage without taking down the whole assistant.

## Phases

### Phase 1: Repository And Baseline

Owner: Platform P9

Deliverables:

- push current PA code to `github.com/WeKruit/wekruit-pa`
- preserve Firebase Hosting target `wekruit-pa`
- preserve dashboard workspaces and runtime/transport boundaries
- document current architecture and target architecture

Done:

- repo builds locally after `npm install`
- no local env files or service account keys committed
- architecture docs are present

### Phase 2: Broker And Durable Turn State

Owner: Backend Broker P9

Deliverables:

- `pa_inbound_events` schema
- `pa_agent_turns` schema
- event claim transaction
- retry and dead-letter state
- idempotency keys for inbound, turn, outbound, tool calls
- migration path from direct worker handling to broker handling

Done:

- worker restart during a turn does not lose the message
- duplicate inbound row does not duplicate assistant reply
- failed LLM or connector call is visible and retryable

### Phase 3: Agent Runtime Orchestrator

Owner: Agent Runtime P9

Deliverables:

- turn orchestrator package
- prompt builder with transcript + memory + policy context
- provider adapter boundary
- tool call loop
- structured runtime events
- model override and kill switch support

Done:

- worker only enqueues inbound events and sends outbound events
- runtime can process pending turns independently
- runtime emits `pa_agent_turns` state transitions

### Phase 4: Memory And Personalization

Owner: Memory P9

Deliverables:

- final `memoryMode` semantics
- Mem0 deployment plan and runbook
- Mem0 connector with degradation behavior
- memory write filter
- user memory inspection in dashboard

Done:

- `firestore_only` works without Mem0
- `mem0` and `both` read and write memory when configured
- Mem0 outage does not block replies
- logs and dashboard show memory degradation reason

### Phase 5: Connector Platform

Owner: Connector P9

Deliverables:

- connector registry
- connector input/output schemas
- connector policy engine
- connector audit log
- first connectors: `wekruit-matching`, `findx`, `scoring`
- automation connector skeleton

Done:

- model cannot call arbitrary code
- every connector call has an audit event
- operators can see connector result and failure state

### Phase 6: Dashboard Control Plane

Owner: Dashboard P9

Deliverables:

- user list and user detail
- agent registry and assignment
- transcript view
- inbound/outbound queue view
- agent turn detail view
- connector call detail view
- health and degraded mode indicators
- abuse and rate-limit event view

Done:

- operator can diagnose one conversation without reading terminal logs
- failed turn can be retried or marked resolved
- worker health is visible from deployed dashboard through a public tunnel or production endpoint

### Phase 7: Safety And Abuse Controls

Owner: Trust And Safety P9

Deliverables:

- user/channel rate limits
- prompt injection classifier/rules
- connector allowlists
- per-agent tool budgets
- memory write filtering
- PII-safe logging policy
- global and per-agent kill switches

Done:

- abusive users are throttled
- prompt injection cannot directly trigger privileged connectors
- unsafe memory writebacks are blocked
- all blocks and degradations are auditable

### Phase 8: E2E, Ops, And Launch Readiness

Owner: QA/Ops P9

Deliverables:

- phone inbound E2E
- email iMessage inbound E2E
- outbound queue E2E
- restart-resume E2E
- connector E2E with fake downstream
- launchd/pm2 worker runbook
- alerting and incident playbook

Done:

- one operator can run the full system from runbook
- worker crash during message processing is recoverable
- dashboard shows enough state to debug production issues

## Team Topology

- Platform P9: repo, deploy, Firebase Hosting, secrets, environment strategy
- Backend Broker P9: Firebase queues, schemas, idempotency, retry, dead letter
- Agent Runtime P9: orchestration, prompt builder, provider adapters, tool loop
- Memory P9: Firestore transcript context, Mem0, degradation, memory filtering
- Connector P9: matching, FindX, scoring, automation connector platform
- Dashboard P9: operator console and health/control surfaces
- Trust/Safety P9: rate limits, injection defense, tool policy, audit
- QA/Ops P9: E2E matrix, runbooks, monitoring, launch readiness

## Decisions

- Firebase remains the broker for this phase.
- iMessage remains Mac-worker based until a production-grade provider is chosen.
- Firestore remains transcript source of truth.
- Mem0 is optional and never the only copy of user history.
- Connectors are explicit and audited, not raw model plugins.
- The worker should become thinner over time.
