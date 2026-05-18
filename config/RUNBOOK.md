# Operations Runbook

Candidate-visible messaging is runtime-gated.

## Production Path

1. `paSendblueWebhook` receives signed Sendblue inbound webhooks.
2. It writes inbound/audit rows and never sends candidate-visible replies directly.
3. `onPaInbound` / coalescer invokes Claire runtime.
4. Runtime-approved message rows are written to `pa-outbound` with `runtimeApproved: true`.
5. `paSendblueOutbox` is the only Sendblue message transport.

Any producer that wants to message a candidate must hand context to runtime first or use the runtime-approved broker helper. Unapproved `pa-outbound` rows fail closed.

## Debugging

- `pa-inbound-events`: inbound queue, runtime handoffs, leases, retry/dead-letter.
- `pa-agent-turns`: turn lifecycle and runtime decisions.
- `pa-messages`: transcript.
- `pa-outbound`: approved outbound queue and Sendblue delivery state.
- `pa-audit-events`: policy/runtime decisions.
- `pa-abuse-events`: rate limits and blocks.
- `pa-memory-events`: memory writes and filters.

## Deploy

Use Node 24 and deploy changed Firebase functions directly. Keep dashboard hosting on target `pa-dashboard` / site `wekruit-pa`.
