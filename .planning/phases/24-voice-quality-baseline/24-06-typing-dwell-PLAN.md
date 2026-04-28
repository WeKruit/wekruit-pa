---
phase: 24-voice-quality-baseline
plan: 06
type: execute
wave: 3
depends_on: ["24-02"]
files_modified:
  - apps/functions/src/sendblue/typing-indicator.ts
  - apps/functions/src/sendblue/typing-indicator.test.ts
  - apps/functions/src/sendblue/outbox.ts
autonomous: true
requirements:
  - VOICE-04

must_haves:
  truths:
    - "New helper `computeTypingDwellMs(replyLength)` exported from typing-indicator.ts."
    - "Dwell scaling: ≤30 chars → 1000ms; 31-100 → 2000ms; 101-200 → 3000ms; >200 → 4000ms."
    - "outbox.ts step 5 replaces fixed `PA_TYPING_DWELL_MS=2500` with `computeTypingDwellMs(body.length)`."
    - "Dwell capped at 8000ms maximum (existing safeguard preserved)."
    - "PA_TYPING_DWELL_MS env var becomes optional override; if set, takes precedence over computed value."
    - "Fire-on-reasoning-start documented as known limitation — out of scope for Phase 24 (architectural change)."
    - "Unit tests cover 4 length bands + override behavior."
  artifacts:
    - path: "apps/functions/src/sendblue/typing-indicator.ts"
      provides: "computeTypingDwellMs helper"
      exports: ["sendTypingIndicator", "isSendblueTypingIndicatorEnabled", "computeTypingDwellMs"]
    - path: "apps/functions/src/sendblue/typing-indicator.test.ts"
      provides: "Unit tests for dwell computation"
    - path: "apps/functions/src/sendblue/outbox.ts"
      provides: "Step 5 uses dynamic dwell"
      contains: "computeTypingDwellMs"
  key_links:
    - from: "apps/functions/src/sendblue/outbox.ts"
      to: "apps/functions/src/sendblue/typing-indicator.ts"
      via: "import computeTypingDwellMs + call with body.length"
      pattern: "computeTypingDwellMs"
---

<objective>
Wave 1 sub-task T1E from 24-CONTEXT.md: dynamic typing dwell 1-4s scaled by reply length. Replaces fixed `PA_TYPING_DWELL_MS=2500` (current outbox.ts:196) with computed dwell from body length.

**Scope clarification (per 24-RESEARCH.md Open Question 4):** "Fire on reasoning start" is OUT OF SCOPE for Phase 24 — it requires an event from the orchestrator CF to the outbox CF (architectural change). Phase 24 keeps current behavior: typing fires immediately before Sendblue REST POST in outbox step 5. Dwell length scales with reply length so the user sees "typing..." for a duration roughly proportional to reading time before the bubble arrives.

Purpose: VOICE-04 carryover (success criterion 6 in MILESTONE-v1.2.md) — dynamic typing dwell.
Output: New `computeTypingDwellMs` helper, outbox.ts integration, unit tests, documented limitation.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/MILESTONE-v1.2.md
@.planning/phases/24-voice-quality-baseline/24-CONTEXT.md
@.planning/phases/24-voice-quality-baseline/24-RESEARCH.md
@apps/functions/src/sendblue/typing-indicator.ts
@apps/functions/src/sendblue/outbox.ts
</context>

<interfaces>
Existing typing-indicator.ts shape (verified 2026-04-27 lines 1-58):
- `sendTypingIndicator(input, creds, log)` — fires Sendblue REST POST to /api/send-typing-indicator
- `isSendblueTypingIndicatorEnabled()` — gates on PA_TYPING_INDICATOR=1

Existing outbox.ts step 5 (lines 192-203):
```typescript
if (isTypingIndicatorEnabled()) {
  try {
    await deps.sendblueClient.sendTypingIndicator({ to: toPeer })
    const dwellMs = Number(process.env.PA_TYPING_DWELL_MS ?? "2500")
    if (Number.isFinite(dwellMs) && dwellMs > 0) {
      await new Promise((r) => setTimeout(r, Math.min(dwellMs, 8000)))
    }
  } catch {}
}
```
- `body` (the reply content string) is available in scope at outbox.ts:114
- 8000ms safeguard cap MUST be preserved
- try/catch swallow MUST be preserved

Dwell scaling thresholds (24-RESEARCH.md Pattern 6):
- ≤30 chars → 1000ms
- 31-100 chars → 2000ms
- 101-200 chars → 3000ms
- >200 chars → 4000ms
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add computeTypingDwellMs helper + unit tests</name>
  <read_first>
    - apps/functions/src/sendblue/typing-indicator.ts (existing implementation lines 1-58)
    - apps/functions/src/sendblue/outbox.ts:185-205 (step 5 — current static dwell logic)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Pattern 6 verbatim)
    - apps/functions/src/sendblue/ (find any *.test.ts for test pattern reference)
  </read_first>
  <behavior>
    - Test 1: computeTypingDwellMs(0) returns 1000
    - Test 2: computeTypingDwellMs(15) returns 1000
    - Test 3: computeTypingDwellMs(30) returns 1000 (boundary inclusive)
    - Test 4: computeTypingDwellMs(31) returns 2000 (boundary inclusive on next band)
    - Test 5: computeTypingDwellMs(75) returns 2000
    - Test 6: computeTypingDwellMs(100) returns 2000
    - Test 7: computeTypingDwellMs(101) returns 3000
    - Test 8: computeTypingDwellMs(150) returns 3000
    - Test 9: computeTypingDwellMs(200) returns 3000
    - Test 10: computeTypingDwellMs(201) returns 4000
    - Test 11: computeTypingDwellMs(500) returns 4000
    - Test 12: computeTypingDwellMs(-1) returns 1000 (negative input → minimum tier)
  </behavior>
  <files>
    apps/functions/src/sendblue/typing-indicator.ts,
    apps/functions/src/sendblue/typing-indicator.test.ts
  </files>
  <action>
    Edit `apps/functions/src/sendblue/typing-indicator.ts` to add the helper. Keep existing exports (`sendTypingIndicator`, `isSendblueTypingIndicatorEnabled`) intact.

    Append at end of file (after `isSendblueTypingIndicatorEnabled`):

    ```typescript
    /**
     * Phase 24 T1E — dynamic typing dwell.
     *
     * Replaces fixed PA_TYPING_DWELL_MS=2500 (Phase 21) with reply-length-
     * scaled dwell so longer replies feel like the AI is actually composing.
     *
     * Per 24-RESEARCH.md Pattern 6:
     *   ≤30 chars → 1000ms (one-liner reaction)
     *   31-100   → 2000ms (short reply)
     *   101-200  → 3000ms (medium reply)
     *   >200     → 4000ms (long technical reply)
     *
     * Capped at 4000ms — Sendblue's typing indicator auto-fades after ~3s on
     * recipient device anyway (24-RESEARCH.md "Architecture note"). Re-firing
     * mid-dwell is a Wave 2 polish item, deferred.
     */
    export function computeTypingDwellMs(replyLength: number): number {
      if (replyLength <= 30) return 1000
      if (replyLength <= 100) return 2000
      if (replyLength <= 200) return 3000
      return 4000
    }
    ```

    Create `apps/functions/src/sendblue/typing-indicator.test.ts` using `node:test`:
    ```typescript
    import { test } from "node:test"
    import assert from "node:assert/strict"
    import { computeTypingDwellMs } from "./typing-indicator.js"

    // 12 cases per behavior block
    test("dwell ≤30 chars → 1000ms", () => { assert.equal(computeTypingDwellMs(0), 1000) })
    test("dwell 15 chars → 1000ms", () => { assert.equal(computeTypingDwellMs(15), 1000) })
    // ... 10 more
    ```

    Verify type-check + tests pass.
  </action>
  <verify>
    <automated>cd apps/functions && pnpm tsc --noEmit && node --test src/sendblue/typing-indicator.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - typing-indicator.ts exports computeTypingDwellMs (grep)
    - typing-indicator.test.ts has ≥12 test blocks (grep `test(` count >= 12)
    - All tests pass
    - All 4 boundary thresholds (30/100/200) tested explicitly with both inclusive and exclusive cases
    - Type-check green
  </acceptance_criteria>
  <done>computeTypingDwellMs helper + tests committed.</done>
</task>

<task type="auto">
  <name>Task 2: Replace static dwell in outbox.ts step 5 with dynamic computation</name>
  <read_first>
    - apps/functions/src/sendblue/outbox.ts:185-205 (step 5 location)
    - apps/functions/src/sendblue/typing-indicator.ts (just-added helper)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Pattern 6 outbox change verbatim)
  </read_first>
  <files>apps/functions/src/sendblue/outbox.ts</files>
  <action>
    Edit `apps/functions/src/sendblue/outbox.ts`:

    1. Add import to existing import block at top (around line 27):
       ```typescript
       import { sendTypingIndicator as defaultSendTypingIndicator, computeTypingDwellMs } from "./typing-indicator.js"
       ```
       (Modify the existing typing-indicator import line — currently `import { sendTypingIndicator as defaultSendTypingIndicator } from "./typing-indicator.js"`.)

    2. Replace step 5 block (lines 192-203) with:

       ```typescript
       // ---- 5. Optional typing indicator (D-06) -----------------------------
       // Phase 24 T1E — dynamic dwell scaled by reply length (1-4s by body.length).
       // PA_TYPING_DWELL_MS env override still honored if set (operator escape hatch).
       if (isTypingIndicatorEnabled()) {
         try {
           await deps.sendblueClient.sendTypingIndicator({ to: toPeer })
           const overrideRaw = process.env.PA_TYPING_DWELL_MS
           const overrideMs = overrideRaw != null && overrideRaw !== "" ? Number(overrideRaw) : NaN
           const dwellMs = Number.isFinite(overrideMs) && overrideMs > 0
             ? overrideMs
             : computeTypingDwellMs(body.length)
           // 8000ms safeguard preserved (defensive cap on extreme env values)
           await new Promise((r) => setTimeout(r, Math.min(dwellMs, 8000)))
         } catch {
           // Already best-effort inside the helper; defensive double-swallow.
         }
       }
       ```

    3. Verify `body` variable is in scope at this point in the function — it is, declared at line 114 (`const body = String(data.body ?? "").trim()`). No new variable needed.

    4. Document Phase 24 limitation: add a comment block near step 5 (before the if block):
       ```typescript
       // KNOWN LIMITATION (24-RESEARCH.md Open Question 4): typing fires here,
       // immediately before the REST POST — NOT at orchestrator reasoning start.
       // True "fire on reasoning start" requires an orchestrator→outbox event
       // (architectural change), deferred from Phase 24. Phase 25 may revisit.
       ```

    5. Type-check + build:
       ```bash
       cd apps/functions && pnpm tsc --noEmit
       ```
  </action>
  <verify>
    <automated>cd apps/functions && pnpm tsc --noEmit && grep -q "computeTypingDwellMs" src/sendblue/outbox.ts && grep -q "body.length" src/sendblue/outbox.ts && grep -q "KNOWN LIMITATION" src/sendblue/outbox.ts</automated>
  </verify>
  <acceptance_criteria>
    - outbox.ts imports computeTypingDwellMs from typing-indicator.js (grep)
    - outbox.ts calls computeTypingDwellMs(body.length) in step 5 (grep `body.length`)
    - PA_TYPING_DWELL_MS env override behavior preserved (grep `overrideMs`)
    - 8000ms safeguard preserved (grep `8000`)
    - Known limitation comment present (grep `KNOWN LIMITATION`)
    - try/catch swallow preserved
    - Type-check green
  </acceptance_criteria>
  <done>Static dwell replaced with dynamic. Env override honored. Limitation documented.</done>
</task>

<task type="auto">
  <name>Task 3: Manual smoke test instructions + summary</name>
  <read_first>
    - apps/functions/src/sendblue/outbox.ts (after task 2 edits)
    - apps/functions/src/sendblue/typing-indicator.ts (after task 1 edits)
  </read_first>
  <files>
    apps/eval/voice/MANUAL-SMOKE-TYPING.md
  </files>
  <action>
    Create `apps/eval/voice/MANUAL-SMOKE-TYPING.md` with Adam-runnable verification steps. This is documentation Adam reads in plan 07 (verification phase) — NOT a checkpoint that blocks plan 06.

    Content:
    ```markdown
    # Manual Smoke — Dynamic Typing Dwell (Phase 24 T1E)

    ## What to verify
    Sendblue typing indicator dwell scales with reply length. Visible 1-4s "..."
    animation before bubble arrives, longer for longer replies.

    ## Setup
    1. Deploy CF: `pnpm -C apps/functions deploy`
    2. Confirm `PA_TYPING_INDICATOR=1` in functions env
    3. Confirm `PA_TYPING_DWELL_MS` is UNSET (or 0/empty) so dynamic computation kicks in

    ## Test cases
    Send messages from sandbox iMessage line that elicit different reply lengths:

    ### Case 1: short reaction (≤30 chars expected)
    Send: `lol`
    Expected reply: short like `干嘛.` or `咋了.`
    Expected dwell: ~1s typing animation
    PASS criterion: typing visible briefly, bubble arrives < 2s after typing starts

    ### Case 2: medium reply (31-100 chars expected)
    Send: `我又被拒了 emo 中`
    Expected reply: anchor case `拒得快说明他们没准备好你. next.` (~21 chars — actually case 1 band)
    Expected dwell: ~1s
    Alt input for case 2: `你能帮我看下这个 JD 吗 感觉有点 mid 但是 base 还行`
    Expected reply: medium ~80 chars
    Expected dwell: ~2s

    ### Case 3: long technical (>200 chars expected)
    Send: `详细解释一下 OPT 转 H1B 的时间线`
    Expected reply: long technical 200+ chars
    Expected dwell: ~4s
    PASS criterion: typing animation persists noticeably longer than case 1

    ### Case 4: env override sanity
    Set `PA_TYPING_DWELL_MS=500`, redeploy.
    Send any message.
    Expected dwell: always 500ms regardless of reply length.
    PASS criterion: env override takes precedence over computed value.

    ## Anti-test (no double-bubble)
    During all 3 cases, verify only ONE assistant bubble appears per reply
    (no race between typing animation and send producing duplicates).

    ## Rollback
    Set `PA_TYPING_INDICATOR=0` (disables typing entirely).
    ```

    This doc is consumed in plan 07 (Adam smoke test).
  </action>
  <verify>
    <automated>test -f apps/eval/voice/MANUAL-SMOKE-TYPING.md && grep -q "1s typing" apps/eval/voice/MANUAL-SMOKE-TYPING.md && grep -q "PA_TYPING_DWELL_MS" apps/eval/voice/MANUAL-SMOKE-TYPING.md</automated>
  </verify>
  <acceptance_criteria>
    - MANUAL-SMOKE-TYPING.md exists with 4 test cases (short / medium / long / env override) and rollback instruction
    - References both PA_TYPING_INDICATOR and PA_TYPING_DWELL_MS env vars
  </acceptance_criteria>
  <done>Smoke test guide ready for Adam in plan 07.</done>
</task>

</tasks>

<verification>
1. `cd apps/functions && pnpm tsc --noEmit` exits 0
2. `cd apps/functions && node --test src/sendblue/typing-indicator.test.ts` exits 0 with ≥12 tests passing
3. `grep -q "computeTypingDwellMs" apps/functions/src/sendblue/outbox.ts` exits 0
4. `grep -q "body.length" apps/functions/src/sendblue/outbox.ts` exits 0
5. Manual smoke doc exists at `apps/eval/voice/MANUAL-SMOKE-TYPING.md`
</verification>

<success_criteria>
- computeTypingDwellMs helper with 4 length bands (≤30, 31-100, 101-200, >200 → 1/2/3/4 seconds)
- outbox.ts step 5 uses dynamic dwell with body.length input
- PA_TYPING_DWELL_MS env override preserved as escape hatch
- 8000ms cap preserved
- Known limitation (no fire-on-reasoning-start) documented in code
- 12+ unit tests pass
- Manual smoke guide ready for Adam plan 07 verification
</success_criteria>

<output>
Create `.planning/phases/24-voice-quality-baseline/24-06-SUMMARY.md` with:
- Dwell formula: 4 bands (≤30 / 31-100 / 101-200 / >200 → 1/2/3/4 seconds)
- Env override behavior (PA_TYPING_DWELL_MS takes precedence if set)
- Documented limitation: typing fires before REST POST (NOT at reasoning start) — architectural deferral
- Adam-side: redeploy CF, run MANUAL-SMOKE-TYPING.md in plan 07
</output>
