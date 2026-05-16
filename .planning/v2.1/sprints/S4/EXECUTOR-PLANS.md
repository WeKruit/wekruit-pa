# S4 Turn Telemetry + Cost Ceiling — EXECUTOR-PLANS

## 6-Element Task Prompt — S4

### 1. Objective
Capture per-turn voice telemetry into `voice-call-metrics/{voiceCallSid}` and enforce the $1/call cost ceiling (L11). Provide an aggregate query path for operators.

### 2. Context
- Voice worker (S2) emits per-turn events via a register-listener hook.
- LiveKit Agents emits `session_usage_updated` and `agent_false_interruption`; S2 wires these handlers; S4 owns the writer.
- L11 cost ceiling: at $1/call → graceful hangup. Implementation = aggregate `session_usage_updated.cost` over call; cross threshold → signal worker close.
- Done-criteria target: <10% false-commit, <5% false-interrupt, p50 TTFA <1.5s.

### 3. Constraints
- Writer code under `apps/functions/src/voice/telemetry/` (new dir).
- Do NOT modify S2 worker source — only consume its exposed hook.
- Firestore writes batched per call; high cardinality OK because TTL on collection (90d default until Adam sets retention policy).
- Aggregate query is read-only Cloud Function callable, gated to admin claim.
- Cost ceiling signal flows back to S2 worker via a session-level callback the worker registered at start; do NOT cross-write or stream-cancel directly.
- Atomic commits: schema → writer → cost-ceiling watchdog → aggregate query → tests.

### 4. Deliverables
- `apps/functions/src/voice/telemetry/metricsWriter.ts`.
- `apps/functions/src/voice/telemetry/costCeiling.ts`.
- `apps/functions/src/voice/telemetry/aggregateQuery.ts` callable CF.
- Tests:
  - `metricsWriter persists one row per turn`
  - `metricsWriter computes ttfaMs from user_speech_committed → first agent audio`
  - `costCeiling warns at $0.90, blocks at $1.00`
  - `costCeiling idempotent on duplicate session_usage_updated events`
  - `aggregateQuery returns false-commit %, false-interrupt %, p50 TTFA`
  - `aggregateQuery admin-claim gated`
- `AGENT_PLAN.md` BEFORE code.
- `.planning/v2.1/sprints/S4/SUMMARY.md`.

### 5. Verification
Regression gate + S4-specific tests green. Simulation runner: 10-turn mock call → ≥10 rows + aggregate-query returns values.

### 6. Done-criteria
- [ ] `AGENT_PLAN.md`
- [ ] Per-turn rows written for sim run
- [ ] Cost ceiling signals worker close at $1.00
- [ ] Aggregate query returns thresholds checkable against Done-criteria
- [ ] Regression gate green
- [ ] Branch pushed, SUMMARY.md filled
