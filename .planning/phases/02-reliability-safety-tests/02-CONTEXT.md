# Phase 2: Reliability, safety, and tests - Context

**Gathered:** 2026-04-24
**Status:** In progress

<domain>
## Phase Boundary

Add CI-safe tests and close reliability gaps that do not require a real Mac/iMessage environment.

</domain>

<decisions>
## Implementation Decisions

### Test Harness
- Use Node's built-in test runner with `tsx`, matching the existing `packages/memory` convention.
- Add workspace-local `test` scripts and aggregate them via root `npm test`.
- Avoid live Firestore in unit tests; use small in-memory fakes for Firestore-shaped behavior.

### Reliability First
- Prioritize durable queue correctness before UI expansion.
- Expired `processing` inbound leases should be discoverable by the scanner because claim logic already supports reclaiming them.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/pa-broker/src/inbound.ts` has transactional claim/fail/complete helpers.
- `packages/pa-safety/src/index.ts` has rate limit, prompt injection, memory write, and connector policy helpers.
- `packages/memory/src/stacked.test.ts` demonstrates the local test runner pattern.

### Established Patterns
- Firestore access is encapsulated behind package helpers, which are testable with narrow fakes.
- `pa_abuse_events` and `pa_audit_events` record safety decisions.

### Integration Points
- Orchestrator depends on `listClaimableInboundIds` to discover what work is available.
- If expired `processing` events are omitted from that list, they can remain stuck after a crash.

</code_context>

<specifics>
## Specific Ideas

- Add tests proving expired `processing` events are claimable and active `processing` events are skipped.
- Add tests proving rate limit blocks write one abuse event and one audit event.
- Keep broader orchestrator and outbound lease tests for the next Phase 2 pass.

</specifics>

<deferred>
## Deferred Ideas

- Full Firestore emulator integration tests.
- Dashboard UI smoke test harness.
- Outbound leases/backoff implementation.

</deferred>
