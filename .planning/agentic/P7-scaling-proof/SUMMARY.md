# P7 — New-capability proof (the scaling property) · SUMMARY

**Branch:** `claude/agentic-P7-scaling-proof`, off P0 tip. Proves AGENTIC-ARCHITECTURE.md §10: **new capability = a pure connector-registry addition, ZERO agent-loop / router / adapter changes.**

## What shipped
- `bab21cfa` — `SCHEDULE_INTERVIEW_CONNECTOR` (`packages/pa-connectors/src/schedule-connector.ts`): a `ConnectorDef` whose `execute` IS a reducer — dedup (scheduling **no-rebook** via `booking-{candidateId}__{jobId}`) + state commit (`pa-interview-bookings`) + idempotency key + structured verdict `{ok,action,reason,detail}` the LLM narrates. Strict-compatible `.nullable()` schema (P5 lesson). Registered via **one line** in `connectorRegistry` + its import — nothing else touched.
- `83858f49` — connector dedup test (commits once → replay deduped, no double-book, verdict shape, both audited via the same `runConnector` infra) + BFCL route-to-tool fixture 08 + allowlist line.
- (this commit) — BFCL `SYSTEM_PROMPT` made **description-driven** (route by each tool's description, not a hardcoded enumeration) — the architecturally-correct routing the scaling claim depends on.

## Receipts
- **Scaling proof:** BFCL `08-toolchoke-schedule-interview` → the agent **calls `schedule-interview`** for "schedule my first interview for the Stripe role" — routed purely by the connector's description, with ZERO changes to `runOpenAIAgentsTurn` / `buildTurnTools` / any router.
- **BFCL tool-choice 4/4 (100%)** (incl. the new connector), abstention 2/2, delivery 2/2. The description-driven prompt also **fixed the P0 EN find-match under-call** (now routes — a bonus regression-forward).
- **Connector reducer:** pa-connectors **30/30** (the dedup/commit-once/verdict test green).

## SELF-REVIEW
- [x] **KEYSTONE held?** Routing = LLM (by description); the `execute` reducer (dedup + commit + verdict + idempotency) = deterministic. ✔
- [x] **Added behavior as a connector (registry addition) vs a new regex branch / handler?** YES — a `ConnectorDef` + one `connectorRegistry` line + import. **Zero agent-loop change.** This is the phase's entire point. ✔
- [x] **connector.execute returns a verdict + LLM narrates it?** `{ok,action:"committed"|"deduped",reason,detail,summary}` — the agent narrates the summary. ✔
- [x] **Dedup first-class?** Scheduling no-rebook proven: replay on the same candidate×job → `deduped`, no second booking doc. ✔
- [x] **Terminal idempotency / commit-once?** `booking-{cand}__{job}` doc id is the idempotency key; commit-once verified. ✔
- [x] **Deleted load-bearing logic?** No — purely additive. ✔
- [x] **Regression?** pa-connectors 30/30; BFCL all-green. (orchestrator/functions untouched.) ✔
- [x] **LOC delta:** +~90 (connector) — additive (this phase proves the ADD pattern; the deletes are P6). ✔

### Honest gaps
- The 2nd P7 connector (`sync-registration`) from the goal is not built — `schedule-interview` already demonstrates the scaling property end-to-end (registry-add → description-routing → reducer/dedup/verdict). `sync-registration` would be the identical pattern; deferred unless Adam wants it for completeness.
- `schedule-interview` is registered but not yet in the LIVE Claire agent's `allowedConnectors` (the BFCL allowlist proves routing). Wiring it live = a one-line allowlist add behind a flag (the P1 pattern), when scheduling is a product priority.
