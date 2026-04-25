# Phase 6 Plan: Memory evol map + Mem0 compatibility

## Tasks

1. Add Firestore collections/types for memory facts, evolution events, and surprise events.
2. Build deterministic persona cards from confirmed, non-high-sensitivity facts.
3. Add opt-in/cooldown/sensitivity checks for surprise protocol.
4. Support Mem0 cloud and OSS/self-host auth/response shapes.

## Verification

- `npm run test --workspace=@pa/memory`
- `npm run typecheck --workspace=@pa/memory`
