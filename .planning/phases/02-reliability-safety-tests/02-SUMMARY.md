# Phase 2 Summary: Reliability, safety, and tests

## Completed

- Broker lifecycle tests now cover idempotent create, claim refusal for active leases, fail-to-dead-letter, and complete clearing stale errors.
- Orchestrator tests cover no-key fallback, injected LLM happy path, prompt-injection block, duplicate idempotency, connector deny, and connector allow.
- Worker outbound tests cover allowlist mismatch becoming `failed` instead of stuck `sending`.
- Worker outbound supports reclaiming stuck `sending` rows back to `pending`.

## Verification

- Root `npm test` includes worker, memory, broker, orchestrator, and safety suites.
- Build and typecheck pass after the reliability changes.

## Deferred

- Browser-level UI smoke tests move to the dashboard/workbench phases.
- Live Mac E2E remains manual because CI should not depend on iMessage.
