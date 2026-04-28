---
phase: 24-voice-quality-baseline
plan: 04
type: execute
wave: 3
depends_on: ["24-02"]
files_modified:
  - packages/pa-orchestrator/src/voice/llm-rewriter.ts
  - packages/pa-orchestrator/src/voice/llm-rewriter.test.ts
  - apps/functions/.env.example
autonomous: true
requirements:
  - VOICE-04

must_haves:
  truths:
    - "Default rewriter model is `Qwen/Qwen3-8B` on SiliconFlow free tier (NOT Qwen3.5-4B — not in SF catalog as of 2026-04-27)."
    - "Rewriter v2 system prompt includes positive replacement table, in-prompt failure exemplar (wekruit投递 case), and pass-through exemplar."
    - "Rewriter v2 strips `<think>...</think>` blocks from model output BEFORE diff-guard runs (Qwen3 thinking mode hazard)."
    - "Diff guard rejects rewrite when output is >1.6× input length OR <40% input length; returns original with reason `rewrite_unsafe`."
    - "Temperature bumped 0.2 → 0.4."
    - "Fail-open semantics preserved: any error/timeout returns original text unchanged."
    - "Fallback chain: PA_LLM_REWRITE_MODEL → PA_LLM_REWRITE_FALLBACK_MODEL → fail-open."
    - "p95 latency ≤ 1.5s (existing timeout cap preserved)."
  artifacts:
    - path: "packages/pa-orchestrator/src/voice/llm-rewriter.ts"
      provides: "Rewriter v2 implementation"
      contains: "Qwen/Qwen3-8B"
    - path: "packages/pa-orchestrator/src/voice/llm-rewriter.test.ts"
      provides: "Unit tests covering diff guard, think-strip, fail-open, exemplar pass-through"
    - path: "apps/functions/.env.example"
      provides: "Documented env vars: PA_LLM_REWRITE_MODEL, PA_LLM_REWRITE_FALLBACK_MODEL"
  key_links:
    - from: "packages/pa-orchestrator/src/voice/llm-rewriter.ts"
      to: "SiliconFlow Qwen3-8B endpoint"
      via: "process.env.PA_LLM_REWRITE_MODEL default Qwen/Qwen3-8B"
      pattern: "Qwen/Qwen3-8B"
    - from: "packages/pa-orchestrator/src/voice/llm-rewriter.ts"
      to: "diff guard rejection"
      via: "rewrite_unsafe reason"
      pattern: "rewrite_unsafe"
    - from: "packages/pa-orchestrator/src/voice/llm-rewriter.ts"
      to: "<think> block stripper"
      via: "regex strip before diff guard"
      pattern: "</?think>"
---

<objective>
Wave 1 sub-task T1C from 24-CONTEXT.md: Rewriter v2 on SF free Qwen3-8B (default — Qwen3.5-4B is NOT in SiliconFlow catalog as of 2026-04-27 per 24-RESEARCH.md critical finding 1; document Qwen3.5-4B as future swap).

Replaces existing Phase 21 rewriter v1 (currently `gpt-5.4-nano` per `llm-rewriter.ts:72`) with:
1. New default model env: `PA_LLM_REWRITE_MODEL=Qwen/Qwen3-8B`
2. Positive-replacement-table v2 system prompt (per 24-RESEARCH.md Pattern 7)
3. `<think>...</think>` block stripper for Qwen3 thinking-mode output
4. Diff guard: reject if `out > 1.6× in` OR `out < 0.4× in`
5. Temp 0.2 → 0.4
6. Fallback model env: `PA_LLM_REWRITE_FALLBACK_MODEL=Qwen/Qwen2.5-7B-Instruct` (paid)

Purpose: VOICE-04 — Rewriter v2 with diff guard + think-mode strip + free Qwen3-8B base.
Output: Updated `llm-rewriter.ts`, comprehensive unit tests, env docs.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/MILESTONE-v1.2.md
@.planning/phases/24-voice-quality-baseline/24-CONTEXT.md
@.planning/phases/24-voice-quality-baseline/24-RESEARCH.md
@packages/pa-orchestrator/src/voice/llm-rewriter.ts
</context>

<interfaces>
Existing llm-rewriter.ts contract (verified 2026-04-27):
```typescript
export type RewriteReason =
  | "rewritten" | "no_change" | "empty_rewrite"
  | "timeout" | "error" | "disabled"

export type RewriteResult = { text: string; rewriteApplied: boolean; reason: RewriteReason }

export async function rewriteIfOff(rawText: string, opts?: RewriteOpts): Promise<RewriteResult>
```

CRITICAL — must extend RewriteReason with `"rewrite_unsafe"` for the new diff-guard rejection (do NOT break existing consumer in `index.ts:586` which logs `rewritten.reason`).

Default model BEFORE this plan (line 72): `process.env.PA_LLM_REWRITE_MODEL?.trim() || "gpt-5.4-nano"`
Default model AFTER: `process.env.PA_LLM_REWRITE_MODEL?.trim() || "Qwen/Qwen3-8B"`

SiliconFlow base URL chain (existing lines 109-114):
```typescript
const baseURL =
  process.env.PA_LLM_REWRITE_BASE_URL?.trim() ||
  process.env.PA_OPENAI_AGENT_BASE_URL?.trim() ||
  process.env.OPENAI_BASE_URL?.trim() ||
  undefined
```
Already routes to SiliconFlow when `OPENAI_BASE_URL=https://api.siliconflow.cn/v1` (Phase 10.5 wiring).

API key chain (existing lines 104-108): `PA_LLM_REWRITE_API_KEY` → `PA_OPENAI_AGENT_API_KEY` → `OPENAI_API_KEY`. SF key wired via `SILICONFLOW_API_KEY` is mapped to `OPENAI_API_KEY` in functions runtime — verify this in `.env.example`.

Qwen3 thinking mode caveat (24-RESEARCH.md Pitfall 2): output may contain `<think>...</think>` blocks. Strip BEFORE diff-guard runs — if not stripped, the long thinking text trips the 1.6x guard and rejects valid rewrites.

Anchor diff-guard test cases (must be in unit tests):
- `out.length / in.length > 1.6` → reject reason `rewrite_unsafe`
- `out.length / in.length < 0.4 AND in.length > 10` → reject reason `rewrite_unsafe`
- think block stripped before measurement (`<think>X</think>actual` → measure only `actual`)
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add diff-guard + think-strip helpers + extend RewriteReason</name>
  <read_first>
    - packages/pa-orchestrator/src/voice/llm-rewriter.ts (existing v1 implementation lines 1-201)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Pattern 7 + Pitfall 2 verbatim)
    - packages/pa-orchestrator/src/voice (sibling test file shape — check if any *.test.ts exists)
  </read_first>
  <behavior>
    - Test 1: stripThinkBlocks("hello") returns "hello" unchanged
    - Test 2: stripThinkBlocks("<think>plan</think>actual") returns "actual"
    - Test 3: stripThinkBlocks("a<think>x</think>b<think>y</think>c") returns "abc"
    - Test 4: stripThinkBlocks("<think>unclosed") returns "<think>unclosed" (graceful — only complete pairs stripped)
    - Test 5: isDiffSafe(input="abc def ghi" 11 chars, output="abc def ghi jkl mno pqr stu" 27 chars) returns false (27 > 1.6*11 = 17.6)
    - Test 6: isDiffSafe(input="hello world this is the input" 30 chars, output="hi" 2 chars) returns false (2 < 0.4*30 = 12)
    - Test 7: isDiffSafe(input="hi" 2 chars, output="x" 1 char) returns true (input ≤ 10 chars — guard skipped)
    - Test 8: isDiffSafe(input="hello world", output="hello") returns true (5 < 0.4*11=4.4 false; check edges)
  </behavior>
  <files>
    packages/pa-orchestrator/src/voice/llm-rewriter.ts,
    packages/pa-orchestrator/src/voice/llm-rewriter.test.ts
  </files>
  <action>
    Add two pure helpers + extend RewriteReason in `llm-rewriter.ts`. Keep helpers exported for testability.

    Step 1: Extend RewriteReason union (top of file):
    ```typescript
    export type RewriteReason =
      | "rewritten" | "no_change" | "empty_rewrite"
      | "timeout" | "error" | "disabled"
      | "rewrite_unsafe" // Phase 24 — diff-guard rejected (length ratio out of bounds)
    ```

    Step 2: Add helper near top of file (after imports, before existing constants):
    ```typescript
    /**
     * Phase 24 — strip Qwen3 thinking-mode blocks. Qwen3 / Qwen3.5 emit
     * <think>...</think> blocks by default. We tell the model not to in the
     * v2 system prompt, but defense-in-depth strips them here too — otherwise
     * the diff-guard sees abnormally long output and rejects valid rewrites
     * (Pitfall 2 in 24-RESEARCH.md).
     */
    export function stripThinkBlocks(s: string): string {
      // Greedy match across lines — Qwen typically emits one block but defend
      // against multiple. Only complete <think>...</think> pairs stripped.
      return s.replace(/<think>[\s\S]*?<\/think>/g, "")
    }

    /**
     * Phase 24 diff guard — reject implausible rewrites:
     * - >1.6× length growth = model padded / hallucinated
     * - <40% length when input > 10 chars = model truncated
     * Returns true if the rewrite is plausibly safe to ship.
     */
    export function isDiffSafe(inputText: string, outputText: string): boolean {
      const inLen = inputText.trim().length
      const outLen = outputText.trim().length
      if (outLen > 1.6 * inLen) return false
      if (inLen > 10 && outLen < 0.4 * inLen) return false
      return true
    }
    ```

    Step 3: Create `packages/pa-orchestrator/src/voice/llm-rewriter.test.ts` using node:test with the 8 behavior cases above. Use exact numeric inputs from the behavior spec so tests are deterministic.

    Type-check passes. Tests pass.
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && pnpm tsc --noEmit && node --test src/voice/llm-rewriter.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - llm-rewriter.ts exports `stripThinkBlocks` and `isDiffSafe` (grep both)
    - RewriteReason union includes literal `"rewrite_unsafe"` (grep)
    - llm-rewriter.test.ts exists with at least 8 test blocks (grep `test(` or `it(` count >= 8)
    - All tests pass
    - Type-check green
  </acceptance_criteria>
  <done>Helpers + reason union extension committed and tested.</done>
</task>

<task type="auto">
  <name>Task 2: Replace v1 system prompt with v2 (positive replacement + failure exemplar) + change default model</name>
  <read_first>
    - packages/pa-orchestrator/src/voice/llm-rewriter.ts (v1 prompt lines 82-94 to be replaced)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Pattern 7 — REWRITER_V2_SYSTEM verbatim)
  </read_first>
  <files>
    packages/pa-orchestrator/src/voice/llm-rewriter.ts
  </files>
  <action>
    Edit 1: change DEFAULT_MODEL fallback at line 72 from `"gpt-5.4-nano"` to `"Qwen/Qwen3-8B"`. Keep env var override logic identical. Add a comment block above the constant:
    ```typescript
    // Phase 24 default — SiliconFlow free tier. Qwen3.5-4B is the documented
    // target but NOT in SF catalog as of 2026-04-27 (24-RESEARCH.md critical
    // finding 1). Swap to Qwen/Qwen3.5-4B via PA_LLM_REWRITE_MODEL env when
    // SF adds it. Fallback chain via PA_LLM_REWRITE_FALLBACK_MODEL.
    ```

    Edit 2: Add fallback model constant near the top:
    ```typescript
    const FALLBACK_MODEL = process.env.PA_LLM_REWRITE_FALLBACK_MODEL?.trim() || "Qwen/Qwen2.5-7B-Instruct"
    ```

    Edit 3: Replace `REWRITER_SYSTEM_PROMPT` (lines 82-94) with `REWRITER_V2_SYSTEM` per 24-RESEARCH.md Pattern 7 verbatim. Key elements that MUST appear:

    - Opening line: "You are a style normalizer for Claire (柯莱儿 / 小柯). Do not think out loud. Output ONLY the rewritten reply text."
    - Tone modes block: [reactive] / [casual] / [planning]
    - "POSITIVE REPLACEMENTS (apply these, do not just delete):"
      - `'我建议你 X' → '你试试 X' / '要不要 X'`
      - `'你应该 X' → '感觉 X 可能会好一点' / drop entirely`
      - `'X 还是 Y?' (binary choice) → single open question, or drop`
      - Pop-therapy (接住你/硬撑着/hold space) → plain empathy
    - "FAILURE EXAMPLE → CLAIRE REWRITE:" using the wekruit投递 case from MILESTONE-v1.2.md:
      - DRAFT: 听起来有点闷，…我建议你把投递时间记一下，然后等到下一周中后段再看要不要 follow up。
      - CLAIRE: 可能下周回. 也可能默拒. 别先 emo.
    - "PASS-THROUGH EXAMPLE (return unchanged):"
      - DRAFT: 拒得快说明他们没准备好你. next.
      - CLAIRE: 拒得快说明他们没准备好你. next.
    - Closing line: "Output ONLY the reply. No preface, no explanation."

    Edit 4: bump temperature 0.2 → 0.4 in `defaultDeps.callRewriter` (line 131). Update the inline comment to reflect new value:
    ```typescript
    // Phase 24 — temp 0.4 (was 0.2). More natural rewrites, less mechanical
    // echo. Diff guard catches over-creative outputs (rewrite_unsafe).
    temperature: 0.4,
    ```

    Edit 5: Rename constant from `REWRITER_SYSTEM_PROMPT` to `REWRITER_V2_SYSTEM_PROMPT` (or keep old name with comment "v2 prompt"). Update the reference in `defaultDeps.callRewriter` to match.
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && pnpm tsc --noEmit && grep -q "Qwen/Qwen3-8B" src/voice/llm-rewriter.ts && grep -q "POSITIVE REPLACEMENTS" src/voice/llm-rewriter.ts && grep -q "可能下周回. 也可能默拒. 别先 emo" src/voice/llm-rewriter.ts && grep -q "拒得快说明他们没准备好你" src/voice/llm-rewriter.ts && grep -q "PA_LLM_REWRITE_FALLBACK_MODEL" src/voice/llm-rewriter.ts && grep -q "temperature: 0.4" src/voice/llm-rewriter.ts</automated>
  </verify>
  <acceptance_criteria>
    - DEFAULT_MODEL fallback changed to `Qwen/Qwen3-8B` (grep)
    - FALLBACK_MODEL constant defined with `PA_LLM_REWRITE_FALLBACK_MODEL` env (grep)
    - System prompt contains "POSITIVE REPLACEMENTS" header (grep)
    - System prompt contains the wekruit投递 failure exemplar verbatim (grep `可能下周回` and `别先 emo`)
    - System prompt contains the pass-through exemplar `拒得快说明他们没准备好你` (grep)
    - Temperature is 0.4 (grep `temperature: 0.4`)
    - Type-check green
  </acceptance_criteria>
  <done>Rewriter v2 system prompt + default model swap committed.</done>
</task>

<task type="auto">
  <name>Task 3: Wire diff-guard + think-strip into rewriteIfOff main flow + fallback chain</name>
  <read_first>
    - packages/pa-orchestrator/src/voice/llm-rewriter.ts (after task 1+2 edits — main rewriteIfOff flow lines ~153-200)
    - packages/pa-orchestrator/src/voice/llm-rewriter.test.ts (existing tests from task 1)
  </read_first>
  <files>
    packages/pa-orchestrator/src/voice/llm-rewriter.ts,
    packages/pa-orchestrator/src/voice/llm-rewriter.test.ts
  </files>
  <action>
    Edit the `rewriteIfOff` function body (lines 153-200) to insert think-strip + diff-guard.

    Current decision block (lines 184-200):
    ```typescript
    if (timeoutHit) return ...
    if (upstreamError || modelText == null) return ...
    if (modelText.trim().length === 0) return ... // empty_rewrite
    if (modelText.trim() === rawText.trim()) return ... // no_change
    return { text: modelText.trim(), rewriteApplied: true, reason: "rewritten" }
    ```

    NEW flow (insert AFTER timeoutHit/error/empty/no_change checks, but BEFORE returning rewritten):

    Step A: Strip think blocks immediately after we have a non-null modelText:
    ```typescript
    if (timeoutHit) return { text: rawText, rewriteApplied: false, reason: "timeout" }
    if (upstreamError || modelText == null) return { text: rawText, rewriteApplied: false, reason: "error" }

    // Phase 24 — strip Qwen3 thinking blocks BEFORE any length check (Pitfall 2)
    const cleaned = stripThinkBlocks(modelText).trim()

    if (cleaned.length === 0) return { text: rawText, rewriteApplied: false, reason: "empty_rewrite" }
    if (cleaned === rawText.trim()) return { text: rawText, rewriteApplied: false, reason: "no_change" }

    // Phase 24 diff guard — reject implausible rewrites
    if (!isDiffSafe(rawText, cleaned)) {
      return { text: rawText, rewriteApplied: false, reason: "rewrite_unsafe" }
    }

    return { text: cleaned, rewriteApplied: true, reason: "rewritten" }
    ```

    Step B (optional, time permitting): implement fallback chain. After the primary `callRewriter` errors or returns empty/unsafe, retry once with FALLBACK_MODEL. To keep scope contained, implement as a SECOND `defaultDeps.callRewriter` invocation with a second model parameter, OR document as deferred to plan 07.

    For Phase 24, KEEP it simple: do NOT implement fallback retry within `rewriteIfOff` — instead, document that fallback is handled at deploy time by swapping `PA_LLM_REWRITE_MODEL` env value. Add a comment in the file explaining the env-level fallback strategy. Code-level retry is a future optimization.

    Step C: Add tests to llm-rewriter.test.ts for the integrated flow:
    - Test 9: rewriteIfOff with deps that return `<think>x</think>actual reply` returns `{ text: "actual reply", reason: "rewritten" }` (think stripped, then accepted as rewrite)
    - Test 10: rewriteIfOff with deps that return text 2x the input length returns `{ text: <original>, reason: "rewrite_unsafe" }`
    - Test 11: rewriteIfOff with deps that return `<think>verbose</think>` (only think, nothing else) returns `{ text: <original>, reason: "empty_rewrite" }`
    - Test 12: existing fail-open semantics preserved — deps throw → reason: "error" returns original

    Use the `RewriterDeps` indirection (already in the file at line ~62) to inject mock `callRewriter` for these tests.
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && pnpm tsc --noEmit && node --test src/voice/llm-rewriter.test.ts && grep -q "stripThinkBlocks" src/voice/llm-rewriter.ts && grep -q "isDiffSafe" src/voice/llm-rewriter.ts && grep -q "rewrite_unsafe" src/voice/llm-rewriter.ts</automated>
  </verify>
  <acceptance_criteria>
    - rewriteIfOff calls stripThinkBlocks before length checks
    - rewriteIfOff calls isDiffSafe and returns reason `rewrite_unsafe` on rejection
    - At least 4 new tests added (think-strip integration, diff-guard reject, think-only empty, fail-open preserved) — total test count >= 12
    - All tests pass
    - Type-check green
  </acceptance_criteria>
  <done>Rewriter v2 diff guard + think-strip integrated and tested.</done>
</task>

<task type="auto">
  <name>Task 4: Document env vars in .env.example + verify orchestrator integration intact</name>
  <read_first>
    - apps/functions/.env.example (or equivalent — find with `find apps -name ".env*" -type f`)
    - packages/pa-orchestrator/src/voice/llm-rewriter.ts (after edits — env names referenced)
    - packages/pa-orchestrator/src/index.ts:586 (existing rewriteIfOff call site)
  </read_first>
  <files>
    apps/functions/.env.example
  </files>
  <action>
    Find the .env.example file (likely `apps/functions/.env.example`; if absent, create it as documentation-only — does NOT affect runtime).

    Append (or merge into existing) the following block:
    ```
    # ── Phase 24 — Voice Rewriter v2 (T1C) ──────────────────────────────────
    # Default rewriter model (SiliconFlow free tier).
    # Swap to Qwen/Qwen3.5-4B once SiliconFlow adds it to their catalog
    # (target as of 24-RESEARCH.md 2026-04-27 — currently 404s on SF).
    PA_LLM_REWRITE_MODEL=Qwen/Qwen3-8B
    PA_LLM_REWRITE_FALLBACK_MODEL=Qwen/Qwen2.5-7B-Instruct

    # SiliconFlow base URL (rewriter inherits from OPENAI_BASE_URL chain;
    # set explicitly for clarity).
    PA_LLM_REWRITE_BASE_URL=https://api.siliconflow.cn/v1

    # SiliconFlow API key (provisioned in GCP Secret Manager as SILICONFLOW_API_KEY;
    # mapped to OPENAI_API_KEY in functions runtime — already wired).

    # Rollback flag — set to "true" to bypass the rewriter and ship raw nano output.
    # PA_LLM_REWRITE_DISABLED=true
    ```

    Then verify the orchestrator call site at `packages/pa-orchestrator/src/index.ts:586` still works (no signature change to rewriteIfOff). Specifically verify that the `rewritten.reason` log line at index.ts:592 will accept the new `"rewrite_unsafe"` reason without TypeScript errors — RewriteReason is a union, so the consumer should accept any of the literal strings.

    Run: `cd packages/pa-orchestrator && pnpm tsc --noEmit` — must exit 0.

    Optional: scan for any other consumers of RewriteReason that might need updating with `grep -rn "RewriteReason\|rewriteReason\|rewriteApplied" packages/`. Update any switch-statement that exhaustively handles all reasons to include `"rewrite_unsafe"`.
  </action>
  <verify>
    <automated>test -f apps/functions/.env.example && grep -q "PA_LLM_REWRITE_MODEL=Qwen/Qwen3-8B" apps/functions/.env.example && grep -q "PA_LLM_REWRITE_FALLBACK_MODEL" apps/functions/.env.example && cd packages/pa-orchestrator && pnpm tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - apps/functions/.env.example exists and documents PA_LLM_REWRITE_MODEL=Qwen/Qwen3-8B (grep)
    - apps/functions/.env.example documents PA_LLM_REWRITE_FALLBACK_MODEL (grep)
    - apps/functions/.env.example documents PA_LLM_REWRITE_BASE_URL pointing at siliconflow.cn (grep siliconflow.cn)
    - Type-check green across orchestrator (rewrite_unsafe accepted in consumer)
  </acceptance_criteria>
  <done>Env vars documented. Orchestrator integration intact with new RewriteReason variant.</done>
</task>

</tasks>

<verification>
1. `cd packages/pa-orchestrator && pnpm tsc --noEmit` exits 0
2. `cd packages/pa-orchestrator && node --test src/voice/llm-rewriter.test.ts` exits 0 with at least 12 tests passing
3. `grep -c "Qwen/Qwen3-8B" packages/pa-orchestrator/src/voice/llm-rewriter.ts apps/functions/.env.example` >= 2
4. `grep -q "rewrite_unsafe" packages/pa-orchestrator/src/voice/llm-rewriter.ts` exits 0
5. `grep -q "stripThinkBlocks" packages/pa-orchestrator/src/voice/llm-rewriter.ts` exits 0
</verification>

<success_criteria>
- Rewriter v2 default model is Qwen/Qwen3-8B (SF free tier)
- v2 system prompt has positive replacement table + failure exemplar + pass-through exemplar
- `<think>...</think>` blocks stripped before any length measurement
- Diff guard rejects out > 1.6× in OR (in > 10 AND out < 0.4× in)
- New reason `rewrite_unsafe` returned on diff-guard rejection
- Temperature 0.4 (was 0.2)
- Fail-open semantics preserved (timeout / error / empty)
- Env vars documented in .env.example
- 12+ unit tests pass (helpers + integrated flow)
- Build + type-check green
</success_criteria>

<output>
Create `.planning/phases/24-voice-quality-baseline/24-04-SUMMARY.md` with:
- Default model swap: gpt-5.4-nano → Qwen/Qwen3-8B (SF free)
- Documented Qwen3.5-4B as future swap (env-var-only change once SF adds it)
- Diff-guard thresholds: >1.6× growth OR <40% truncation when in > 10 chars
- Think-strip regex pattern + rationale (Pitfall 2)
- New RewriteReason variant `rewrite_unsafe`
- Test coverage delta: +N test cases
- Adam-side: redeploy CF + verify SiliconFlow API key in Secret Manager (already wired per 24-RESEARCH.md)
</output>
