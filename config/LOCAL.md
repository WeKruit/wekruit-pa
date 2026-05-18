# Local Development

The current candidate-visible messaging path is cloud/runtime owned:

1. Sendblue webhook writes `pa-inbound-events`.
2. Claire runtime processes the event.
3. Runtime-approved rows are written to `pa-outbound`.
4. `paSendblueOutbox` sends approved rows through Sendblue.

There is no supported local Mac iMessage worker or broker mode. Do not add one back for candidate-visible sends.

## Requirements

- Node 24.
- Firebase Admin credentials through `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`.
- Dashboard browser env from Firebase web config.

## Build

```bash
npm install
npm run build
```

## Dashboard

```bash
cd apps/dashboard-web
npm run dev
```

Use a signed-in `@wekruit.com` operator account. Candidate pages stay on `candidate.wekruit.com`; admin stays on `wekruit-pa.web.app`.

## Runtime Debugging

For live iMessage behavior, inspect Firestore and deployed functions:

- `pa-inbound-events`: inbound webhook/runtime handoff queue.
- `pa-agent-turns`: runtime turn state.
- `pa-messages`: transcript.
- `pa-outbound`: approved outbound queue only.
- `pa-audit-events`, `pa-abuse-events`, `pa-memory-events`: policy, safety, memory.

To test candidate-visible messaging, use the deployed Sendblue webhook/outbox functions against the test number allowlist. Local-only tests are not proof that a real candidate transcript is coherent.
