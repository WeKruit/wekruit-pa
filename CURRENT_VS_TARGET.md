# Current vs Target

## Already Exists

| Area | Current state |
| --- | --- |
| Dashboard | Vite app in `apps/dashboard-web`; Firebase Hosting target is `wekruit-pa`. |
| Mac worker | `apps/macos-imessage-worker` reads local iMessage and sends through Photon/iMessage. |
| Firestore namespace | `pa_users`, `pa_sessions`, `pa_messages`, `pa_agents`, `pa_remote_config`, `pa_outbound`. |
| Agent runtime | `packages/agent-runtime` can run a single OpenAI-compatible turn. |
| Memory | `packages/memory` loads Firestore transcript and optional Mem0 search/writeback. |
| Agent registry | `packages/agent-registry` seeds and resolves default agents. |
| Health | Worker exposes local health endpoint. |
| E2E evidence | Phone and email iMessage inbound paths have been exercised manually. |

## Partial But Not Product-Ready

| Area | Current behavior | Product gap |
| --- | --- | --- |
| Per-user memory | Mem0 calls use `userId`, and Firestore transcript is keyed by `userId` + `sessionId`. | No explicit memory namespace policy, retention, inspection UI, memory delete/export, or memory write safety filter. |
| Session management | `pa_sessions` exists and the worker can create one session per channel handle. | No session lifecycle, multi-device/channel merge policy, turn state, resumed turn handling, or session-level rate policy. |
| Agent runtime | Single turn wrapper can call OpenAI-compatible providers. | No orchestrator, tool loop, handoffs, turn state machine, connector routing, or guardrail pipeline. |
| Outbound queue | `pa_outbound` supports pending -> sending -> sent/failed. | No inbound queue equivalent, no lease expiry, no dead-letter flow, no operator retry surface. |

## Missing For Target Product

| Area | Missing |
| --- | --- |
| Broker | Durable `pa_inbound_events`, `pa_agent_turns`, retries, leases, dead letters. |
| Runtime | Full turn orchestrator, tool loop, policy context, structured runtime events. |
| Connectors | Registry, schemas, policy engine, audit trail, matching/FindX/scoring connectors. |
| Safety | Rate limits, prompt injection checks, memory write filters, connector allowlists. |
| Dashboard | Queue views, turn views, connector calls, abuse events, retry controls. |
| Memory ops | Production Mem0 deployment, degradation visibility, memory inspection. |
| Ops | Runbook for worker process manager, alerting, crash recovery, restart-resume E2E. |
| Tests | CI-safe tests for broker, runtime, identity, idempotency, connectors, policy. |

## Priority Order

1. Broker and turn state.
2. Runtime orchestration.
3. Dashboard queue and turn visibility.
4. Safety and rate limits.
5. Connector platform.
6. Mem0 production deployment.
7. Launch runbook and monitoring.
