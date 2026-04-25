# Phase 5 Plan: Agent registry + persona controls

## Tasks

1. Extend agent schema with draft/published/archived status, persona controls, timestamps, and model probe status.
2. Add agent lifecycle helpers for default uniqueness, publish snapshots, rollback, and persona prompt composition.
3. Block default switching when a model probe is known failed.
4. Add dashboard persona controls.

## Verification

- `npm run test --workspace=@pa/agent-registry`
- `npm run typecheck --workspace=@pa/agent-registry`
- Dashboard build/typecheck.
