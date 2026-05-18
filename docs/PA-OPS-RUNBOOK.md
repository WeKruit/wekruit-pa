# WeKruit PA Operator Runbook

## Runtime Architecture

Candidate-visible messages have one production path:

```text
Sendblue inbound webhook
  -> pa-inbound-events
  -> Claire runtime
  -> runtime-approved pa-outbound
  -> paSendblueOutbox
  -> Sendblue send-message
```

Webhook/event producers must not send directly. They may write inbound runtime events or call runtime-approved broker helpers only after runtime has made the send decision. `paSendblueOutbox` blocks `pa-outbound` rows without `runtimeApproved: true`.

## Critical Environment

| Variable | Process | Purpose |
|----------|---------|---------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` | functions/scripts | Firestore source of truth. |
| `PA_RATE_LIMIT_PER_WINDOW` / `PA_RATE_LIMIT_WINDOW_MS` | runtime | Per-user/channel throttling. |
| `OPENAI_API_KEY` / gateway equivalents | runtime | LLM provider. |
| `MEM0_API_KEY` / `MEM0_BASE_URL` | runtime | Optional long-term memory. |
| `PA_MATCHING_URL` / `PA_MATCHING_TOKEN` | runtime | Matching connector. |

## Operator Debugging Path

Open dashboard -> Operations:

- `pa-inbound-events`
- `pa-agent-turns`
- `pa-tool-calls`
- `pa-audit-events`
- `pa-abuse-events`
- `pa-memory-events`
- `pa-outbound`

Open dashboard -> User detail:

- transcript from `pa-messages`
- outbound delivery rows
- memory events for that user

## Launch Checklist

- Node 24 for tests and deploy.
- Firestore rules and indexes deployed.
- Dashboard hosting target remains `pa-dashboard` / site `wekruit-pa`.
- No service account JSON or `.env` files committed.
- Real iMessage QA reads the visible transcript plus Firestore lifecycle rows before calling a flow healthy.
