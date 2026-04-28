---
phase: 24-voice-quality-baseline
plan: "06"
subsystem: sendblue-outbox
tags: [typing-indicator, dwell, voice-quality, ux]
dependency_graph:
  requires: ["24-02"]
  provides: ["dynamic-typing-dwell", "computeTypingDwellMs-helper"]
  affects: ["apps/functions/src/sendblue/outbox.ts", "apps/functions/src/sendblue/typing-indicator.ts"]
tech_stack:
  added: []
  patterns: ["length-band-scaling", "env-override-with-computed-fallback", "8s-hard-cap"]
key_files:
  created:
    - apps/functions/src/sendblue/__tests__/typing-indicator.test.ts
    - apps/eval/voice/MANUAL-SMOKE-TYPING.md
  modified:
    - apps/functions/src/sendblue/typing-indicator.ts
    - apps/functions/src/sendblue/outbox.ts
decisions:
  - "Test file placed in __tests__/ subdirectory (existing project convention) rather than co-located — required for test runner glob: src/sendblue/__tests__/*.test.ts"
  - "computeTypingDwellMs returns raw ms for band (not capped at 4000); 8000ms cap is applied at call site in outbox.ts only, preserving helper purity"
  - "fire-on-reasoning-start deferred — documented as KNOWN LIMITATION in outbox.ts code comment"
metrics:
  duration_minutes: 5
  completed_date: "2026-04-28"
  tasks_completed: 3
  tasks_total: 3
  files_created: 2
  files_modified: 2
  tests_added: 12
  tests_passing: 12
requirements:
  - VOICE-04
---

# Phase 24 Plan 06: Dynamic Typing Dwell Summary

**One-liner:** `computeTypingDwellMs(replyLength)` exports 4-band dwell (≤30→1s, 31-100→2s, 101-200→3s, >200→4s); outbox step 5 uses `body.length` to drive it, replacing fixed `PA_TYPING_DWELL_MS=2500`.

## What Was Built

### Task 1: computeTypingDwellMs helper + unit tests

Added `computeTypingDwellMs(replyLength: number): number` to `typing-indicator.ts`. The function applies 4 length bands:

| Reply length | Dwell |
|---|---|
| ≤30 chars | 1000ms (one-liner reaction) |
| 31-100 chars | 2000ms (short reply) |
| 101-200 chars | 3000ms (medium reply) |
| >200 chars | 4000ms (long technical reply) |

12 unit tests in `__tests__/typing-indicator.test.ts` covering all 4 bands, all boundary thresholds (30/100/200, inclusive on lower and upper sides), negative input edge case, and all 3 explicit lower-boundary cases (31/101/201).

### Task 2: outbox.ts static dwell replaced

`outbox.ts` step 5 now:
1. Calls `computeTypingDwellMs(body.length)` as the computed dwell
2. Checks `PA_TYPING_DWELL_MS` env var first — if set and valid positive number, it wins (operator escape hatch preserved)
3. Applies `Math.min(dwellMs, 8000)` cap (8000ms safeguard preserved)
4. Contains `// KNOWN LIMITATION` comment block explaining fire-on-reasoning-start deferral

### Task 3: Manual smoke test guide

`apps/eval/voice/MANUAL-SMOKE-TYPING.md` documents 4 test cases for Adam to run in plan 07:
- Case 1: short reaction (~1s dwell)
- Case 2: medium reply (~2s dwell)
- Case 3: long technical reply (~4s dwell)
- Case 4: env override sanity (`PA_TYPING_DWELL_MS=500` always wins)
- Anti-test: no double-bubble race condition

## Dwell Formula

```
replyLength <= 30  → 1000ms
replyLength <= 100 → 2000ms
replyLength <= 200 → 3000ms
replyLength > 200  → 4000ms

Hard cap: Math.min(dwellMs, 8000)
Env override: PA_TYPING_DWELL_MS takes precedence if set
```

## Documented Limitation

Fire-on-reasoning-start is OUT OF SCOPE for Phase 24. Typing fires immediately before the Sendblue REST POST in outbox step 5. True fire-at-reasoning-start requires an orchestrator→outbox event (architectural change). Documented in code comment at outbox.ts step 5:

```
// KNOWN LIMITATION (24-RESEARCH.md Open Question 4): typing fires here,
// immediately before the REST POST — NOT at orchestrator reasoning start.
// True "fire on reasoning start" requires an orchestrator→outbox event
// (architectural change), deferred from Phase 24. Phase 25 may revisit.
```

## Commits

| Task | Hash | Message |
|---|---|---|
| T1 | af1f3da | feat(24-06): add computeTypingDwellMs helper + unit tests (T1E) |
| T2 | f393597 | feat(24-06): replace static PA_TYPING_DWELL_MS=2500 with dynamic dwell (T2) |
| T3 | 2159ef7 | docs(24-06): add MANUAL-SMOKE-TYPING.md for plan 07 verification (T3) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test file placed in __tests__/ not co-located**
- **Found during:** Task 1
- **Issue:** Plan specified `apps/functions/src/sendblue/typing-indicator.test.ts` (co-located). Existing test runner glob is `src/sendblue/__tests__/*.test.ts` — co-located file would not run.
- **Fix:** Placed test at `apps/functions/src/sendblue/__tests__/typing-indicator.test.ts` to match project convention and runner pattern.
- **Files modified:** `apps/functions/src/sendblue/__tests__/typing-indicator.test.ts`
- **Commit:** af1f3da

## Adam-Side Actions (Plan 07)

1. Deploy CF: `pnpm -C apps/functions deploy`
2. Ensure `PA_TYPING_INDICATOR=1` and `PA_TYPING_DWELL_MS` unset in Cloud Functions env
3. Run MANUAL-SMOKE-TYPING.md cases 1-4 from sandbox iMessage line
4. Verify dwell visibly scales with reply length

## Known Stubs

None — all functionality fully wired. Dynamic dwell computation is live end-to-end.

## Self-Check: PASSED

Files exist:
- apps/functions/src/sendblue/typing-indicator.ts — FOUND
- apps/functions/src/sendblue/__tests__/typing-indicator.test.ts — FOUND
- apps/functions/src/sendblue/outbox.ts — FOUND
- apps/eval/voice/MANUAL-SMOKE-TYPING.md — FOUND

Commits exist:
- af1f3da — FOUND
- f393597 — FOUND
- 2159ef7 — FOUND
