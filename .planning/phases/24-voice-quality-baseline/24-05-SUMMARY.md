---
phase: 24-voice-quality-baseline
plan: "05"
subsystem: pa-orchestrator/voice
tags: [telemetry, regex, coach-token, voice-quality, phase-24]
dependency_graph:
  requires: ["24-02"]
  provides: ["coach-token-monitor.ts", "tapCoachTokens", "detectCoachTokens", "CoachTokenHit"]
  affects: ["packages/pa-orchestrator/src/index.ts", "apps/eval/voice/scripts/"]
tech_stack:
  added: []
  patterns: ["telemetry-only regex tap", "fail-closed IIFE pattern", "/u flag CJK Unicode"]
key_files:
  created:
    - packages/pa-orchestrator/src/voice/coach-token-monitor.ts
    - packages/pa-orchestrator/src/voice/coach-token-monitor.test.ts
    - apps/eval/voice/scripts/validate-coach-monitor-fp.mjs
  modified:
    - packages/pa-orchestrator/src/index.ts
decisions:
  - "tapCoachTokens takes log as 3rd arg (default console.log); production adapter is (evt, payload) => store.log(evt, payload) — keeps module dep-free from orchestrator store type"
  - "FP rate deferred to plan 07: golden-50.jsonl not yet populated (plan 02 bootstrap)"
  - "Type errors in index.ts at prefixFewShotToHistory lines are from parallel plan 24-03 — out-of-scope, not introduced by this plan"
metrics:
  duration_min: 15
  completed: "2026-04-27"
  tasks_completed: 3
  tasks_total: 3
  files_created: 3
  files_modified: 1
---

# Phase 24 Plan 05: Coach-Token Telemetry SUMMARY

**One-liner:** Telemetry-only regex tap (5-pattern, /u flag, fail-closed) emitting `pa.voice.coach_token.observed` between reply trim and rewriteIfOff — pure observation, no transform.

---

## What Was Built

### coach-token-monitor.ts — 5-Pattern Telemetry Module

New module at `packages/pa-orchestrator/src/voice/coach-token-monitor.ts` exports:

| Export | Type | Purpose |
|--------|------|---------|
| `CoachTokenHit` | type | `{ token: string; pattern: string }` |
| `detectCoachTokens(text)` | function | Runs all 5 patterns, returns hits array |
| `tapCoachTokens(reply, ctx, log)` | function | Reads reply, logs if hits, returns void |

### 5 Pattern Categories

| Pattern Name | Regex (abbreviated) | Sample Trigger |
|---|---|---|
| `zh_coach_verb` | `/我建议你\|我推荐\|你应该\|听起来你\|保持积极心态\|…/u` | `我建议你把投递时间记一下` |
| `en_coach_verb` | `/I suggest\|Maybe you should\|I recommend\|I hear you\|I understand/u` | `I suggest you take a break` |
| `bullet_list` | `/^\s*[-*•]/mu` | `- step 1\n- step 2` |
| `numbered_list` | `/^\s*\d+[.)、]/mu` | `1. first\n2. second` |
| `subordinate_chain_4plus` | `/(然后\|接着\|再\|and then).*(…).*(…)/u` | `先这样, 然后那样, 接着再这样, 然后最后那样` |

All patterns use `/u` flag for CJK Unicode correctness. `bullet_list` and `numbered_list` use `/mu` for multiline anchoring.

### Fail-Closed Pattern

Pattern set initialized in an IIFE wrapped in try/catch. If any regex fails to compile: `console.error` + return `[]`. The orchestrator never crashes.

### Orchestrator Wiring (index.ts)

Execution order confirmed at lines 592-599:
```
line 592: reply = stripLeadingIsoTimestamp(...)   // trim
line 593: // Phase 24 T1D comment
line 594: tapCoachTokens(reply, {turnId, userId, replyLength}, store.log adapter)  // NEW
line 605: rewritten = await rewriteIfOff(reply)   // existing
```

`reply` variable is read-only between tap and rewriteIfOff — no mutation possible.

### Log Emit Format

```typescript
log("pa.voice.coach_token.observed", {
  turnId,
  userId: event.userId,
  replyLength: reply.length,
  tokens: [{ token: "我建议你", pattern: "zh_coach_verb" }, ...]
})
```

### BigQuery Verification Query (next-day check)

```sql
SELECT
  JSON_VALUE(payload, '$.tokens') AS tokens,
  JSON_VALUE(payload, '$.turnId') AS turn_id,
  JSON_VALUE(payload, '$.userId') AS user_id,
  timestamp
FROM logs
WHERE event = 'pa.voice.coach_token.observed'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
LIMIT 50
```

---

## Test Coverage (12 tests, all passing)

| Test # | Category | Input | Expected |
|--------|----------|-------|---------|
| 1 | zh_coach_verb | `我建议你把投递时间记一下` | ≥1 hit, pattern=zh_coach_verb |
| 2 | en_coach_verb | `I suggest you take a break` | ≥1 hit, pattern=en_coach_verb |
| 3 | bullet_list | `- step 1\n- step 2` | ≥1 hit, pattern=bullet_list |
| 4 | numbered_list | `1. first\n2. second` | ≥1 hit, pattern=numbered_list |
| 5 | subordinate_chain | `先这样, 然后那样, 接着再这样, 然后最后那样` | ≥1 hit, pattern=subordinate_chain_4plus |
| 6 | FP guard | `拒得快说明他们没准备好你. next.` | 0 hits |
| 7 | FP guard | `可能下周回. 也可能默拒. 别先 emo.` | 0 hits |
| 8 | FP guard | `来. 喘一下.` | 0 hits |
| 9 | tap log | coach reply | log called with "pa.voice.coach_token.observed" |
| 10 | tap no-op | clean reply | log NOT called |
| 11 | no mutation | any | returns void, reply unchanged |
| 12 | truncation | match[0] > 40 chars | token.length ≤ 40 |

**False-positive guard tests 6/7/8 pass on all 3 anchor regression cases from 24-CONTEXT.md.**

---

## FP Rate Validation

**Status: Deferred — insufficient PASS data**

`apps/eval/voice/fixtures/golden-50.jsonl` not yet populated (plan 02 bootstrap pending Adam labeling). The validation script at `apps/eval/voice/scripts/validate-coach-monitor-fp.mjs` exists and handles this gracefully (exits 0 with deferral message).

Gate: Re-run after plan 02 populates golden-50 with ≥10 PASS cases.

---

## Deviations from Plan

### Out-of-scope: Type errors from parallel plan 24-03

**Found during:** Task 2 verification
**Issue:** `src/index.ts` lines 572/583 have type errors from `prefixFewShotToHistory` (plan 24-03's code) — `FewShotTurn[]` return type incompatible with `ChatMessage[]`. These errors were present before my changes and are not caused by this plan.
**Action:** Logged to deferred items. Not fixed (architectural decision for plan 24-03 to resolve).
**My changes type-check clean:** `grep "coach-token-monitor" | pnpm tsc` produces no errors for my module.

No other deviations. Plan executed exactly as written.

---

## Self-Check: PASSED

Files created:
- `packages/pa-orchestrator/src/voice/coach-token-monitor.ts` — FOUND
- `packages/pa-orchestrator/src/voice/coach-token-monitor.test.ts` — FOUND
- `apps/eval/voice/scripts/validate-coach-monitor-fp.mjs` — FOUND

Commits:
- `5c0ef7e` — feat(24-05): coach-token-monitor module + 12 unit tests — FOUND
- `2da76f3` — feat(24-05): wire tapCoachTokens into orchestrator turn flow — FOUND
- `cee9a01` — feat(24-05): false-positive validation script for coach-token monitor — FOUND

Tests: 12/12 pass.
