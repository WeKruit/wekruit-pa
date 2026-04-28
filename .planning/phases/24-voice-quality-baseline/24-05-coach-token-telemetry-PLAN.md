---
phase: 24-voice-quality-baseline
plan: 05
type: execute
wave: 3
depends_on: ["24-02"]
files_modified:
  - packages/pa-orchestrator/src/voice/coach-token-monitor.ts
  - packages/pa-orchestrator/src/voice/coach-token-monitor.test.ts
  - packages/pa-orchestrator/src/index.ts
autonomous: true
requirements:
  - VOICE-05

must_haves:
  truths:
    - "New module `coach-token-monitor.ts` exports `tapCoachTokens` + `detectCoachTokens`."
    - "Monitor logs hits to `pa.voice.coach_token.observed` with `{turnId, userId, tokens, replyLength}`."
    - "Monitor performs NO transformation — pure observation. Reply text is unchanged."
    - "Monitor is fail-closed on regex error: returns reply unchanged + logs error."
    - "Pattern set covers zh coach verbs / en coach verbs / bullet lists / numbered lists / 4+ subordinate-clause heuristic."
    - "Integration: monitor fires AFTER reply trim, BEFORE rewriteIfOff (sequential, sub-millisecond)."
    - "False-positive rate on golden-50 clean (PASS-labeled) cases < 5%."
  artifacts:
    - path: "packages/pa-orchestrator/src/voice/coach-token-monitor.ts"
      provides: "Telemetry-only regex tap"
      exports: ["tapCoachTokens", "detectCoachTokens", "CoachTokenHit"]
    - path: "packages/pa-orchestrator/src/voice/coach-token-monitor.test.ts"
      provides: "Unit tests covering 5 pattern categories + fail-closed behavior"
  key_links:
    - from: "packages/pa-orchestrator/src/index.ts"
      to: "packages/pa-orchestrator/src/voice/coach-token-monitor.ts"
      via: "tapCoachTokens called between reply trim and rewriteIfOff"
      pattern: "tapCoachTokens"
    - from: "tapCoachTokens"
      to: "structured log emit"
      via: "store.log('pa.voice.coach_token.observed', {...})"
      pattern: "pa\\.voice\\.coach_token\\.observed"
---

<objective>
Wave 1 sub-task T1D from 24-CONTEXT.md: Telemetry-only coach-token monitor (Claude-Code-cursing-log style — observe, don't transform).

Inserts a sub-millisecond regex tap between reply trim (orchestrator line ~580) and `rewriteIfOff` (line ~586). When patterns match, emits `pa.voice.coach_token.observed` log with token list. **Never modifies the reply text.** Feeds Phase 25 self-evolve as input signal.

Why telemetry-only and NOT transform: Adam's locked constraint — "no negative-instruction blacklists" extends to runtime stripping. The rewriter (plan 04) already handles voice normalization. This monitor is the dataset-collection layer for the v1.3 self-evolve cycle.

Purpose: VOICE-05 — telemetry-only regex log feeding v1.3 self-evolve.
Output: New `coach-token-monitor.ts`, tests, orchestrator wiring.
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
@packages/pa-orchestrator/src/index.ts
</context>

<interfaces>
Coach-token pattern set (24-RESEARCH.md Pattern 5 + CONTEXT.md Wave 1.D):

zh coach verbs: `我建议你 / 我推荐 / 你应该 / 听起来你 / 保持积极心态 / 你的感受是合理的 / 我们一步一步来 / 不妨试试 / 总之要相信自己 / 加油哦~ / 宝~ / 亲~`
en coach verbs: `I suggest / Maybe you should / I recommend / I hear you / I understand` (when used as opener)
Bullet markers: `^\s*[-*•]` multiline
Numbered markers: `^\s*\d+[.)、]` multiline
Subordinate-clause chain (4+): three or more occurrences of `然后/接着/再/and then` connectives

Output schema (verified Pattern 5):
```typescript
export type CoachTokenHit = { token: string; pattern: string }
```

Log format:
```typescript
log("pa.voice.coach_token.observed", { turnId, userId, tokens: hits, replyLength })
```

Existing orchestrator integration point — `packages/pa-orchestrator/src/index.ts:580-586`:
```typescript
const reply = stripLeadingIsoTimestamp(text.trim()) || "我暂时没有生成有效回复，请稍后再试。"
// ← INSERT tapCoachTokens HERE (line ~585)
const rewritten = await rewriteIfOff(reply)
```

The `store.log(...)` function is the existing structured-log emitter (verified at index.ts:546-549, used for `pa.voice.mirror.injected`).

`turnId` and `userId` are in scope at line 580 (verifiable: `grep -n "turnId\|event.userId" packages/pa-orchestrator/src/index.ts | head -5`).
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Build coach-token-monitor.ts module + comprehensive tests</name>
  <read_first>
    - packages/pa-orchestrator/src/voice/llm-rewriter.ts (sibling module pattern reference for style)
    - packages/pa-orchestrator/src/voice/mirror-snippet.ts (sibling module — log-emit pattern)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Pattern 5 verbatim)
  </read_first>
  <behavior>
    - Test 1: detectCoachTokens("我建议你把投递时间记一下") returns ≥1 hit with pattern="zh_coach_verb"
    - Test 2: detectCoachTokens("I suggest you take a break") returns ≥1 hit with pattern="en_coach_verb"
    - Test 3: detectCoachTokens("- step 1\n- step 2") returns ≥1 hit with pattern="bullet_list"
    - Test 4: detectCoachTokens("1. first\n2. second") returns ≥1 hit with pattern="numbered_list"
    - Test 5: detectCoachTokens("先这样, 然后那样, 接着再这样, 然后最后那样") returns ≥1 hit with pattern="subordinate_chain_4plus"
    - Test 6: detectCoachTokens("拒得快说明他们没准备好你. next.") returns 0 hits (clean Claire reply — false-positive guard)
    - Test 7: detectCoachTokens("可能下周回. 也可能默拒. 别先 emo.") returns 0 hits (clean Claire reply)
    - Test 8: detectCoachTokens("来. 喘一下.") returns 0 hits (clean Claire reply)
    - Test 9: tapCoachTokens called with hits invokes log function with "pa.voice.coach_token.observed" + payload
    - Test 10: tapCoachTokens called with no hits does NOT invoke log function
    - Test 11: tapCoachTokens does NOT mutate or return the reply (signature returns void)
    - Test 12: detectCoachTokens token property is truncated to ≤40 chars (slice(0,40) per Pattern 5)
  </behavior>
  <files>
    packages/pa-orchestrator/src/voice/coach-token-monitor.ts,
    packages/pa-orchestrator/src/voice/coach-token-monitor.test.ts
  </files>
  <action>
    Implement EXACTLY per 24-RESEARCH.md Pattern 5 code block, with these concrete bindings:

    1. Module docstring (top):
       ```
       /**
        * Phase 24 — telemetry-only coach-token monitor (T1D).
        *
        * NO TRANSFORM. Pure observation + log. Adam-locked: no negative-
        * instruction blacklists in runtime — this only collects training
        * signal for Phase 25 self-evolve cycle.
        *
        * Fail-closed: regex compile error → empty pattern set, returns
        * empty hits + console.error log. Never throws.
        */
       ```

    2. Pattern set (use `/u` flag for CJK Unicode correctness, multiline `m` flag for line-anchored bullet/numbered patterns):
       ```typescript
       const COACH_PATTERNS: [RegExp, string][] = (() => {
         try {
           return [
             [/我建议你|我推荐|你应该|听起来你|保持积极心态|你的感受是合理的|我们一步一步来|不妨试试|总之要相信自己|加油哦~?|宝~|亲~/u, "zh_coach_verb"],
             [/I suggest|Maybe you should|I recommend|I hear you|I understand/u, "en_coach_verb"],
             [/^\s*[-*•]/mu, "bullet_list"],
             [/^\s*\d+[.)、]/mu, "numbered_list"],
             [/(然后|接着|再|and then).*(然后|接着|再|and then).*(然后|接着|再|and then)/u, "subordinate_chain_4plus"],
           ]
         } catch (e) {
           console.error("[pa.voice.coach_token_monitor] regex compile error", e)
           return []
         }
       })()
       ```

    3. Exports:
       ```typescript
       export type CoachTokenHit = { token: string; pattern: string }
       export function detectCoachTokens(text: string): CoachTokenHit[] { ... }
       export function tapCoachTokens(reply, ctx, log = console.log): void { ... }
       ```

    4. detectCoachTokens implementation: iterate COACH_PATTERNS, run `re.exec(text)`, push `{token: match[0].slice(0,40), pattern: name}` for each truthy match. Return all hits.

    5. tapCoachTokens implementation: call detectCoachTokens; if hits.length > 0, call `log("pa.voice.coach_token.observed", { ...ctx, tokens: hits })`. NEVER throw.

    6. Test file `coach-token-monitor.test.ts`: implement all 12 behavior cases above using `node:test`. Use mock log function `(...args) => calls.push(args)` to assert tapCoachTokens behavior. Critical: tests 6/7/8 (false-positive guard on clean replies) MUST pass — they sanity-check that regex doesn't fire on valid Claire output from the golden-50 anchor cases.
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && pnpm tsc --noEmit && node --test src/voice/coach-token-monitor.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - coach-token-monitor.ts exports `detectCoachTokens`, `tapCoachTokens`, type `CoachTokenHit` (grep all 3)
    - 5 pattern categories present (grep `zh_coach_verb`, `en_coach_verb`, `bullet_list`, `numbered_list`, `subordinate_chain_4plus`)
    - All 12 tests pass via node --test
    - False-positive guard tests (6/7/8) pass with the 3 anchor regression replies
    - Type-check green
  </acceptance_criteria>
  <done>Coach-token monitor module + tests committed.</done>
</task>

<task type="auto">
  <name>Task 2: Wire tapCoachTokens into orchestrator main turn flow</name>
  <read_first>
    - packages/pa-orchestrator/src/index.ts:540-600 (call site context — reply trim at 580, rewriteIfOff at 586)
    - packages/pa-orchestrator/src/voice/coach-token-monitor.ts (just built)
    - packages/pa-orchestrator/src/voice/mirror-snippet.ts (for store.log usage pattern reference)
  </read_first>
  <files>packages/pa-orchestrator/src/index.ts</files>
  <action>
    Edit `packages/pa-orchestrator/src/index.ts`:

    1. Add import alongside other voice imports near line 50-60:
       ```typescript
       import { tapCoachTokens } from "./voice/coach-token-monitor.js"
       ```

    2. Insert call at line ~585 (between `const reply = stripLeadingIsoTimestamp(...)` and `const rewritten = await rewriteIfOff(reply)`):

       ```typescript
       // Phase 24 T1D — telemetry-only coach-token monitor. Pure observation.
       // Hits feed Phase 25 self-evolve dataset. NO transform on `reply`.
       tapCoachTokens(
         reply,
         { turnId, userId: event.userId, replyLength: reply.length },
         (event, payload) => store.log(event, payload)
       )
       ```

       Note: the third argument adapts the log signature. `store.log` may take `(event: string, payload: unknown)` per existing usage at line 546. Verify the exact signature by reading existing `store.log` calls (`grep -n "store.log" packages/pa-orchestrator/src/index.ts | head -10`) and match it.

    3. Confirm execution order:
       - Line 580: reply trim
       - Line 585 (NEW): tapCoachTokens (sub-millisecond, no transform)
       - Line 586: rewriteIfOff (existing — Phase 21 + plan 04 v2)
       - Line 597+: rest of pipeline

    4. Run `cd packages/pa-orchestrator && pnpm tsc --noEmit` — must exit 0.
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && pnpm tsc --noEmit && grep -q "tapCoachTokens" src/index.ts && grep -q "from \"./voice/coach-token-monitor" src/index.ts</automated>
  </verify>
  <acceptance_criteria>
    - packages/pa-orchestrator/src/index.ts imports tapCoachTokens (grep)
    - tapCoachTokens called between reply trim (line ~580) and rewriteIfOff (line ~586) — verified by line proximity grep
    - Type-check green
    - No transformation on `reply` variable between trim and rewriteIfOff (the variable name is unchanged when passed to rewriteIfOff)
  </acceptance_criteria>
  <done>Orchestrator wired. Hits will land in BigQuery via existing store.log pipeline within 24h.</done>
</task>

<task type="auto">
  <name>Task 3: False-positive validation against golden-50 clean cases</name>
  <read_first>
    - packages/pa-orchestrator/src/voice/coach-token-monitor.ts
    - apps/eval/voice/fixtures/golden-50.jsonl (PASS-labeled cases)
  </read_first>
  <files>
    apps/eval/voice/scripts/validate-coach-monitor-fp.mjs
  </files>
  <action>
    Create a small validation script `apps/eval/voice/scripts/validate-coach-monitor-fp.mjs`:

    ```javascript
    // Phase 24 T1D — false-positive validation.
    // Acceptance per 24-CONTEXT.md: FP rate on golden-50 clean (PASS) replies < 5%.
    import { readFileSync } from "node:fs"
    import { detectCoachTokens } from "../../../packages/pa-orchestrator/dist/voice/coach-token-monitor.js"

    const lines = readFileSync("apps/eval/voice/fixtures/golden-50.jsonl", "utf8").split("\n").filter(Boolean)
    const passes = lines.map(l => JSON.parse(l)).filter(c => c.label === "PASS")
    let fpCount = 0
    for (const c of passes) {
      const lastAssistant = [...c.turns].reverse().find(t => t.role === "assistant")
      if (!lastAssistant) continue
      const hits = detectCoachTokens(lastAssistant.content)
      if (hits.length > 0) {
        console.log(`FP: ${c.id} — hits:`, hits)
        fpCount++
      }
    }
    const rate = fpCount / passes.length
    console.log(`Golden PASS cases: ${passes.length}, FP: ${fpCount}, rate: ${(rate*100).toFixed(1)}%`)
    process.exit(rate < 0.05 ? 0 : 1)
    ```

    Run flow:
    1. Build orchestrator: `cd packages/pa-orchestrator && pnpm build` (or equivalent — must produce dist/ output)
    2. Run: `node apps/eval/voice/scripts/validate-coach-monitor-fp.mjs`
    3. Exit code 0 = FP rate < 5%; exit 1 = FP rate >= 5%

    If FP rate >= 5%:
    - Examine the failing cases — likely hits on legitimate `然后` chains or rare `我建议` in casual context
    - Tighten the regex (e.g. require word boundaries on en_coach_verb, require `^\s*` anchor on zh_coach_verb)
    - Re-run

    Save final FP rate to a comment block at top of `coach-token-monitor.ts`:
    ```
    // FP rate on golden-50 PASS cases (validated YYYY-MM-DD): X.X%
    ```

    If golden-50.jsonl does not yet have ≥10 PASS cases (i.e. plan 02 used a smaller bootstrap), document FP rate as "deferred — insufficient PASS data" and gate FP acceptance to plan 07 verification.
  </action>
  <verify>
    <automated>test -f apps/eval/voice/scripts/validate-coach-monitor-fp.mjs && grep -q "detectCoachTokens" apps/eval/voice/scripts/validate-coach-monitor-fp.mjs && grep -q "FP rate" packages/pa-orchestrator/src/voice/coach-token-monitor.ts</automated>
  </verify>
  <acceptance_criteria>
    - Validation script exists at apps/eval/voice/scripts/validate-coach-monitor-fp.mjs
    - Script imports detectCoachTokens from built orchestrator dist
    - coach-token-monitor.ts has FP rate validation comment (grep "FP rate")
    - FP rate < 5% on PASS-labeled subset of golden-50, OR documented as deferred to plan 07
  </acceptance_criteria>
  <done>FP rate validated < 5% (or deferred). Monitor ready for production.</done>
</task>

</tasks>

<verification>
1. `cd packages/pa-orchestrator && pnpm tsc --noEmit` exits 0
2. `cd packages/pa-orchestrator && node --test src/voice/coach-token-monitor.test.ts` exits 0 with ≥12 tests passing
3. `grep -q "tapCoachTokens" packages/pa-orchestrator/src/index.ts` exits 0
4. `grep -c "pa.voice.coach_token.observed" packages/pa-orchestrator/src/voice/coach-token-monitor.ts` >= 1
5. False-positive validation script exists and runs (or marked deferred)
</verification>

<success_criteria>
- coach-token-monitor.ts module exports detectCoachTokens + tapCoachTokens + CoachTokenHit
- 5 pattern categories: zh_coach_verb, en_coach_verb, bullet_list, numbered_list, subordinate_chain_4plus
- Pure observation — NO transformation of reply text
- Fail-closed on regex error
- Wired into orchestrator between reply trim and rewriteIfOff
- FP rate < 5% on golden-50 PASS cases (or deferral noted)
- 12+ unit tests pass
- Build + type-check green
</success_criteria>

<output>
Create `.planning/phases/24-voice-quality-baseline/24-05-SUMMARY.md` with:
- 5 pattern categories + sample hits per category
- Wired position in orchestrator (line ~585, between trim and rewriteIfOff)
- FP rate measurement (or deferral)
- BigQuery query template for next-day verification: `SELECT JSON_VALUE(payload, '$.tokens') FROM logs WHERE event = 'pa.voice.coach_token.observed' AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) LIMIT 50`
</output>
