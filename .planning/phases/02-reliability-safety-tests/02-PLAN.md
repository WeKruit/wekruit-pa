# Phase 2 Plan: Reliability, safety, and tests

## Goal

Add CI-safe coverage for the queue lifecycle, orchestrator behavior, safety helpers, and worker outbound failure modes.

## Tasks

1. Expand broker tests for create, claim, fail, complete, dead-letter, and stale error clearing.
2. Add orchestrator tests using a small dependency seam for OpenAI runtime calls.
3. Cover no-key fallback, LLM path, safety block, duplicate idempotency, connector allow, and connector deny.
4. Make outbound allowlist failure explicit and test stuck `sending` reclaim behavior.

## Verification

- `npm run test --workspace=@pa/pa-broker`
- `npm run test --workspace=@pa/pa-orchestrator`
- `npm run test --workspace=@pa/macos-imessage-worker`
- `npm test`
- `npm run build`
- `npm run typecheck`
