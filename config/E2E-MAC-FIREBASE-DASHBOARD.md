# E2E: Sendblue + Firebase + Dashboard

The supported live path is deployed Sendblue webhook/functions, not a local Mac worker.

## Preconditions

| Item | Expected |
|------|----------|
| Firebase project | `wekruit-5f89b` |
| Node | 24 |
| Candidate-visible sender | Sendblue functions only |
| Test number | allowlisted test number only |

## Inbound Conversation Test

1. Send a real test iMessage/SMS to the configured Sendblue number.
2. Confirm `pa-sendblue-webhook-raw` has the signed webhook audit row.
3. Confirm `pa-inbound-events` has the user message or runtime handoff.
4. Confirm `pa-agent-turns` records the runtime decision.
5. Confirm `pa-outbound` is created only with `runtimeApproved: true`.
6. Confirm `paSendblueOutbox` moves the row to `sent`, `delivered`, or `failed`.
7. Read the actual Messages transcript and judge whether Claire's answer is coherent.

## Outbound Gate Test

Create one deliberately unapproved `pa-outbound` row for the test number. Expected result: `status=failed`, `blockedByRuntimeGate=true`, no Sendblue handle.

Passing this gate only proves transport safety. It does not prove the user-visible conversation quality.
