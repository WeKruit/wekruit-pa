# WeKruit PA — frozen Firestore schemas and idempotency

Operational source of truth lives in Firestore. This document defines **idempotency key conventions** and collection purposes. Field-level detail is encoded in `@pa/core-types` (Zod schemas).

## Idempotency keys

| Key pattern | Used on | Purpose |
|-------------|---------|---------|
| `imessage-in-{messageRowId}` | `pa_messages` (user), `pa_inbound_events` | One user turn per iMessage row; duplicate adapter delivery is ignored. |
| `out-{inboundIdempotencyKey}` | `pa_messages` (assistant), `pa_outbound` | One assistant reply per inbound idempotency key. |
| `out-{inboundIdempotencyKey}-kill` | `pa_messages` | Kill-switch canned reply (same uniqueness rule). |
| `turn-{inboundEventId}` | `pa_agent_turns.id` (recommended) | One turn document per inbound event. |
| `tool-{turnId}-{nanoid}` | `pa_tool_calls` | Unique tool invocation ledger rows. |
| `audit-{timestamp}-{random}` | `pa_audit_events` | Append-only audit rows. |

## Collections

| Collection | Owner | Notes |
|------------|-------|-------|
| `pa_users` | Core | Includes optional `mem0UserId` for Mem0 namespace isolation. |
| `pa_sessions` | Core | Optional `lifecycle`, `lastInboundAt`, `lastOutboundAt`. |
| `pa_messages` | Core | Transcript source of truth; always `userId` + `sessionId`. |
| `pa_agents` | Core | Agent def + `memoryMode`, `toolPolicy`. |
| `pa_remote_config` | Core | Kill switch, model overrides. |
| `pa_outbound` | Broker | Pending → sending → sent/failed; optional `imessageChatId` for Photon. |
| `pa_inbound_events` | Broker | Durable inbound; `pending` → `processing` → `completed` / `failed` / `dead_letter`. |
| `pa_agent_turns` | Runtime | Turn state machine + steps + links to transcript/outbound. |
| `pa_tool_calls` | Connectors | Typed tool ledger; policy allow/deny. |
| `pa_audit_events` | Platform | Immutable audit trail. |
| `pa_rate_limits` | Safety | Counter buckets per window. |
| `pa_abuse_events` | Safety | Throttle / injection / abuse signals. |
| `pa_session_links` | Memory | Explicit merge of sessions (e.g. phone + email). |
| `pa_memory_events` | Memory | Memory write/delete/export/filter audit. |

## Lease / reclaim

- `pa_inbound_events.claimedBy` + `leaseUntil`: orchestrator sets lease; expired leases return to claimable `pending` (or `failed` with retry) per broker logic.
- `pa_agent_turns` may use the same pattern for long-running turns.

## Related docs

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [SEQUENCE.md](./SEQUENCE.md)
