# WeKruit PA operator runbook

## Runtime processes

1. Install and build from a clean clone:

```bash
npm install
npm run build
```

2. Run the Mac channel adapter:

```bash
cd apps/macos-imessage-worker
PA_BROKER_MODE=primary npm run start
```

3. Run the independent agent runtime:

```bash
npm run orchestrator
```

Use `PA_BROKER_MODE=shadow` during migration if you want the worker to write `pa_inbound_events` while still executing the legacy direct path.

## Critical environment

| Variable | Process | Purpose |
|----------|---------|---------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` | worker, orchestrator | Firestore source of truth. |
| `PA_BROKER_MODE` | worker | `legacy`, `shadow`, or `primary`. Production target is `primary`. |
| `PA_ORCHESTRATOR_POLL_MS` | orchestrator | Poll interval for pending inbound events. |
| `PA_RATE_LIMIT_PER_WINDOW` / `PA_RATE_LIMIT_WINDOW_MS` | orchestrator | Per-user/channel throttling. |
| `OPENAI_API_KEY` / gateway equivalents | orchestrator | LLM provider. If absent, orchestrator degrades to echo reply. |
| `MEM0_API_KEY` / `MEM0_BASE_URL` | orchestrator | Optional long-term memory. |
| `PA_MATCHING_URL` / `PA_MATCHING_TOKEN` | orchestrator | First real downstream connector. |

## Operator debugging path

Open dashboard → **Operations**:

- `pa_inbound_events`: durable inbound queue, leases, retry/dead-letter.
- `pa_agent_turns`: turn state transitions and transcript/outbound links.
- `pa_tool_calls`: connector policy, status, result summary.
- `pa_audit_events`: safety, policy, and connector audit trail.
- `pa_abuse_events`: rate limit and prompt-injection blocks.
- `pa_memory_events`: Mem0 writes, degradation, filter blocks.

Open dashboard → **User detail**:

- transcript view from `pa_messages`
- active agent assignment
- memory events for that user

## E2E matrix

| Test | Expected |
|------|----------|
| Phone iMessage inbound | Worker creates `pa_inbound_events`; orchestrator writes user+assistant transcript; outbound sends. |
| Email iMessage inbound | Same as phone; session remains separate unless linked explicitly. |
| Outbound queue | Dashboard-created `pa_outbound` moves `pending` → `sending` → `sent` or `failed`. |
| Restart-resume | Kill orchestrator during a turn; after lease expiry another run reclaims or dead-letters. |
| Duplicate inbound | Same iMessage row/idempotency key does not create duplicate assistant replies. |
| Fake connector | Message containing `fake connector` creates audited `fake-echo` tool call for an allowlisted agent. |
| Real connector | `wekruit-matching` executes only when allowlisted and configured with `PA_MATCHING_URL`. |

## Launch checklist

- Firestore rules and indexes deployed.
- Dashboard hosting target remains `pa-dashboard` / site `wekruit-pa`.
- No service account JSON or `.env` files committed.
- Mac host has Full Disk Access for Messages database.
- Worker health endpoint is reachable by operators (tunnel or VPN).
- Promptfoo baseline exists at `tests/promptfoo/promptfooconfig.yaml`.
