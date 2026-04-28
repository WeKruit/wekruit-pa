---
phase: 24-voice-quality-baseline
plan: "04"
subsystem: voice-rewriter
tags: [llm-rewriter, qwen3, diff-guard, think-strip, siliconflow, phase-24]
dependency_graph:
  requires: ["24-02"]
  provides: ["rewriter-v2", "stripThinkBlocks", "isDiffSafe", "rewrite_unsafe-reason"]
  affects: ["packages/pa-orchestrator/src/voice/llm-rewriter.ts", "apps/functions env vars"]
tech_stack:
  added: []
  patterns:
    - "Qwen3 think-block strip (defense-in-depth against <think>...</think> leakage)"
    - "Diff guard (1.6× upper / 0.4× lower ratio, input >10 chars threshold)"
    - "Positive replacement table in rewriter prompt (not blacklist)"
    - "Fail-open on every error path (timeout / upstream error / empty / diff-unsafe)"
key_files:
  created:
    - apps/functions/.env.example
  modified:
    - packages/pa-orchestrator/src/voice/llm-rewriter.ts
    - packages/pa-orchestrator/src/voice/llm-rewriter.test.ts
    - apps/functions/.env.template
decisions:
  - "Default model Qwen/Qwen3-8B (SiliconFlow free): Qwen3.5-4B not in SF catalog as of 2026-04-27 (Pitfall 1). Env var PA_LLM_REWRITE_MODEL makes swap trivial."
  - "Code-level retry deferred: fallback handled at deploy-time by swapping PA_LLM_REWRITE_MODEL. Single active user in closed beta makes env-level strategy sufficient."
  - "Temperature 0.4 (was 0.2): diff guard catches over-creative outputs; higher temp yields more natural rewrites."
  - "Diff guard thresholds 1.6× / 0.4×: symmetric around ±60% change, small-input guard (>10 chars) avoids false rejects on 1-2 word replies."
metrics:
  duration_seconds: 262
  tasks_completed: 4
  tasks_total: 4
  files_modified: 4
  tests_added: 13
  tests_total: 22
  completed_date: "2026-04-28T03:34:59Z"
---

# Phase 24 Plan 04: Rewriter v2 Summary

**One-liner:** Rewriter v2 with Qwen/Qwen3-8B free-tier default, Qwen3 think-block strip, 1.6×/0.4× diff guard, positive-replacement v2 system prompt, and 22 passing tests.

## What Was Built

### Default model swap: gpt-5.4-nano → Qwen/Qwen3-8B (SF free)

`PA_LLM_REWRITE_MODEL` env var defaults to `Qwen/Qwen3-8B` on SiliconFlow free tier. The planned `Qwen/Qwen3.5-4B` target is NOT in SiliconFlow's catalog as of 2026-04-27 (24-RESEARCH.md critical finding 1). Once SiliconFlow adds Qwen3.5-4B, it's an env-var-only swap — no code change needed. Fallback constant: `Qwen/Qwen2.5-7B-Instruct` via `PA_LLM_REWRITE_FALLBACK_MODEL`.

### Think-block stripper (`stripThinkBlocks`)

Exported helper strips complete `<think>...</think>` pairs from model output BEFORE diff-guard runs. Defense-in-depth: the v2 system prompt already says "Do not think out loud" but Qwen3 instruct post-training doesn't always suppress thinking mode. Unclosed tags are preserved (only complete pairs stripped). This prevents Pitfall 2 (24-RESEARCH.md): unstripped think blocks trip the 1.6× length guard and reject valid rewrites.

### Diff guard (`isDiffSafe`)

Exported pure helper:
- `outLen > 1.6 * inLen` → `false` (model padded / hallucinated)
- `inLen > 10 && outLen < 0.4 * inLen` → `false` (model truncated)
- Otherwise → `true`

The `inLen > 10` threshold prevents false rejects on very short inputs (e.g., 2-char "hi" → 1-char "x" is fine). Integrated into `rewriteIfOff` after think-strip, before returning `rewritten`. Returns `reason: "rewrite_unsafe"` on guard rejection.

### Rewriter v2 system prompt

Replaced `REWRITER_SYSTEM_PROMPT` (v1) with `REWRITER_V2_SYSTEM_PROMPT` (v2). Key additions:
- Opening: "Do not think out loud. Output ONLY the rewritten reply text." (think-mode suppression)
- Tone modes: `[reactive]` / `[casual]` / `[planning]`
- POSITIVE REPLACEMENTS table: `我建议你 X → 你试试 X / 要不要 X`, etc.
- FAILURE EXAMPLE → CLAIRE REWRITE: wekruit投递 case (canonical failure)
- PASS-THROUGH EXAMPLE: 拒得快说明他们没准备好你. next. (model learns when NOT to rewrite)
- Temperature 0.4 (was 0.2) — more natural rewrites; diff guard catches over-creative output

### New RewriteReason: `rewrite_unsafe`

Extended union without breaking the existing consumer at `index.ts:605` (which logs `reason` as a string — no exhaustive switch).

### Env var documentation

- Created `apps/functions/.env.example` (new, documentation-only)
- Updated `apps/functions/.env.template` with Phase 24 block
- Documents: `PA_LLM_REWRITE_MODEL`, `PA_LLM_REWRITE_FALLBACK_MODEL`, `PA_LLM_REWRITE_BASE_URL`, `PA_LLM_REWRITE_DISABLED`

## Test Coverage Delta

| Category | Before | After |
|----------|--------|-------|
| Phase 21 existing tests | 9 | 9 (updated 2 for diff-guard compat) |
| Phase 24 — stripThinkBlocks helpers | 0 | 4 |
| Phase 24 — isDiffSafe helpers | 0 | 4 |
| Phase 24 — integrated flow | 0 | 5 |
| **Total** | **9** | **22** |

All 22 tests pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Phase 21 tests assumed no diff guard**
- **Found during:** Task 3 integration (GREEN phase)
- **Issue:** Two Phase 21 tests passed fake rewriter outputs with dramatic length reduction (e.g., 19-char input → 5-char output = 26% ratio). The new diff guard correctly rejects these as `rewrite_unsafe`. Tests were updated to use outputs within safe ratio bounds (≥40% of input length) while preserving test intent.
- **Tests modified:**
  - "pop-therapy phrase 接住你 stripped" — output changed from "听着挺累的." to "听着挺累的. 还好吗." (within ratio)
  - "productivity-coach probe removed" — output changed to a within-ratio cleaned version
- **Commit:** 7756fba

**2. [Rule 2 - Missing doc] .env.example file missing**
- **Found during:** Task 4
- **Issue:** `apps/functions/.env.example` did not exist (only `.env.template`). Plan specifies `.env.example`.
- **Fix:** Created `.env.example` as documentation-only. Also updated `.env.template` for consistency.
- **Commit:** 4cf730b

### Pre-existing Type Errors (Out of Scope)

`packages/pa-orchestrator/src/index.ts:572,583` has type errors introduced by parallel plan 24-03 (few-shot relocation). These are NOT caused by this plan's changes and are outside scope. Deferred to 24-03 resolution.

## Adam-Side Actions Required

1. **Redeploy Cloud Function**: `apps/functions` build + deploy to pick up new `llm-rewriter.ts` with Qwen3-8B default.
2. **Verify SiliconFlow API key**: `SILICONFLOW_API_KEY` in GCP Secret Manager (already wired per 24-RESEARCH.md). Confirm Qwen3-8B responds at `https://api.siliconflow.cn/v1`.
3. **Monitor rewriter telemetry**: `pa.voice.llm_rewriter.applied` logs — watch for `reason: "rewrite_unsafe"` spikes (sign of Pitfall 2 / think mode leaking) or `reason: "error"` spikes (sign of Pitfall 1 / model 404).
4. **Future swap**: When SiliconFlow adds Qwen3.5-4B, set `PA_LLM_REWRITE_MODEL=Qwen/Qwen3.5-4B` and redeploy — no code change needed.

## Commits

- `7756fba` — feat(24-04): rewriter v2 — Qwen3-8B default, think-strip, diff-guard, v2 prompt
- `4cf730b` — chore(24-04): document rewriter v2 env vars in .env.example and .env.template

## Self-Check: PASSED

Files exist:
- `packages/pa-orchestrator/src/voice/llm-rewriter.ts` — FOUND
- `packages/pa-orchestrator/src/voice/llm-rewriter.test.ts` — FOUND
- `apps/functions/.env.example` — FOUND

Commits exist:
- `7756fba` — FOUND
- `4cf730b` — FOUND

Tests: 22/22 pass.
