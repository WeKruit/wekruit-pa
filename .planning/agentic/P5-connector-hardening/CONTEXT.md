# P5 — Connector reducer hardening · CONTEXT

**Branch/worktree:** `claude/agentic-P5-connector-hardening` @ `.claude/worktrees/agentic-P5-connector-hardening`. Base: P0 tip `02c3e826`. Retarget to main once P0 merges.

## Goal (V3-AGENTIC-GOAL-PROMPT.md P5 + LIVE-SMOKE-2026-05-28-RECEIPT.md)
- **Lock-#5 (the concrete, gated core):** "avoid X" → a STRUCTURED `negativeIndustrySector` the matcher SUBTRACTS (not open `relevantTags:["avoid_*"]`, not a POSITIVE industrySector = surface-attribution). "only product / avoid SWE" → REPLACE the role set (drop software_engineering). "full-time only" → `targetJobType=["full_time"]`.
- Connector hardening: every `connector.execute` returns the verdict shape `{ok,action,reason,detail}`; dedup + policy gate (vocab/confidence floor); PII-website-lock connector (`pii_change_request` → portal link, no chat PII write); every change narrated ("tell them").

## The gate (already RED in P0)
`apps/eval/conversation-experience/llm-fixtures/negative-axis-baseline.json` (marked `baseline_red`) asserts `final_tags_includes: {negativeIndustrySector:["crypto_web3_blockchain"]}`. **P5 turns it GREEN** (extractor must emit negativeIndustrySector for "avoid X"). The avoid-swe-removal fixture (replace + full_time) is also lock-#5 territory.

## Implementation (research in flight — agent a46812413)
1. Add `negativeIndustrySector` (string[]) to the canonical user-tag schema (shared-tags / core-types). Precedent: existing `companyNegativeList` / `roleFunctionNegativeList` (from set-matching-preferences).
2. Extractor: add `negativeIndustrySector` to `ConversationExtractResultSchema.tagPatch` (conversation-extractor.ts ~213) + a prompt instruction so "avoid X" emits the NEGATIVE axis (not positive industrySector / relevantTags). Also REPLACE-role-set + capture full_time guidance. → turns negative-axis-baseline GREEN.
3. Confirm `applyPartialUserTags`/`mergeUserTags` pass the new field through.
4. Matcher (V16): SUBTRACT `negativeIndustrySector` (drop/penalize jobs in avoided sectors), mirroring how `roleFunctionNegativeList`/`companyNegativeList` are subtracted. **Flag-gate the matcher-subtract behavior for safe ramp.**

## Approach (P1–P4 pattern)
Gate = the negative-axis-baseline fixture (RED→GREEN via the extractor). Schema + extractor changes are additive (new optional field). Matcher-subtract = flag-gated default-OFF (production matching behavior change → Adam-gated ramp). Verify: negative-axis-baseline GREEN + avoid-swe-removal + process-intact 5/5 + regression 1803/2028.

## Status
Worktree + build initiated; research dispatched (negative-axis path). Implementation next cycle off the research map.
