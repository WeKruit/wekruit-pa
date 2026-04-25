# Phase 1: Broker correctness + echo suppression - Context

**Gathered:** 2026-04-24
**Status:** Ready for verification

<domain>
## Phase Boundary

Make the green local iMessage E2E path reliable enough for future agent/persona work by preventing broker-managed assistant replies from being duplicated into the transcript as `role=user`.

</domain>

<decisions>
## Implementation Decisions

### Transcript Ownership
- The orchestrator owns transcript writes for broker-managed inbound turns.
- The iMessage worker outbox remains a channel adapter and must not write duplicate transcript rows for `out-imessage-in-*` jobs.
- Dashboard playground outbound may still append its operator-origin transcript message.

### Model Handling
- Keep the live default model stable until the official target slug `gpt-5.4-nano` passes a runtime probe; the earlier failed probe used the wrong `gpt5.4nano` string.
- Revisit model switching after ATM/gateway exposes a verified profile.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/macos-imessage-worker/src/outbox.ts` owns `pa_outbound` send behavior.
- `packages/pa-orchestrator/src/index.ts` already writes assistant transcript rows before enqueueing outbound.

### Established Patterns
- Node built-in `node:test` with `tsx` is already used in `packages/memory`.
- Workspace test scripts are package-local and can be aggregated by root `npm test`.

### Integration Points
- `pa_outbound.idempotencyKey` identifies broker-managed jobs using `out-imessage-in-*`.
- The worker health endpoint confirms the restarted local worker is running current code.

</code_context>

<specifics>
## Specific Ideas

Prevent exactly the observed screenshot bug: after an assistant sends a reply, the transcript should not gain an additional `user` row containing the assistant's text.

</specifics>

<deferred>
## Deferred Ideas

- Full outbound lease/reclaim/backoff belongs to Phase 2.
- Full UI redesign belongs to Phases 3-4.

</deferred>
