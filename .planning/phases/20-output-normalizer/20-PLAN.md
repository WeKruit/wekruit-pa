---
phase: 20-output-normalizer
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/pa-orchestrator/src/output-normalizer.ts
  - packages/pa-orchestrator/src/output-normalizer.test.ts
  - packages/pa-orchestrator/src/chunker.ts
  - packages/pa-orchestrator/src/index.ts
  - tests/scenarios/judge.mjs
  - tests/scenarios/output-normalizer.yaml
autonomous: true
requirements:
  - NORM-01
  - NORM-02
  - NORM-03
  - NORM-04
  - NORM-05
  - NORM-06
  - NORM-07
  - NORM-08

must_haves:
  truths:
    - "Markdown emphasis tokens (** * __ _ ` ```) never appear in pa_outbound.text at orchestrator exit"
    - "Markdown link syntax [text](url) never appears in pa_outbound.text; URLs appear as bare URLs"
    - "UTM/tracking query params (utm_*, gclid, fbclid, mc_*, ref, ref_src, _hsenc, _hsmi) are stripped from all URLs"
    - "List bullets render as '· ' (CJK middle dot) on both zh and en clients"
    - "Whitespace collapsed: ≥3 blank lines → 2; trailing whitespace trimmed"
    - "Replies >600 chars split into ≤3 chunks via Phase 15 chunker; or graceful truncate if no clean split"
    - "Eval harness auto-fails any scenario whose final assistant message matches markdown regex"
    - "Normalizer is idempotent: normalize(normalize(x)) === normalize(x)"
  artifacts:
    - path: "packages/pa-orchestrator/src/output-normalizer.ts"
      provides: "normalizeForIMessage() module with 6 normalization rules"
      exports: ["normalizeForIMessage", "NormalizeOpts", "NormalizeResult", "STRIP_PARAMS"]
      min_lines: 120
    - path: "packages/pa-orchestrator/src/output-normalizer.test.ts"
      provides: "8+ unit test cases covering documented edge cases"
      min_lines: 200
    - path: "packages/pa-orchestrator/src/chunker.ts"
      provides: "Phase 15 chunker copied/extracted into pa-orchestrator package"
      exports: ["planChunks", "ChunkPlan"]
    - path: "packages/pa-orchestrator/src/index.ts"
      provides: "normalizeForIMessage() called on every outbound before enqueue"
      contains: "normalizeForIMessage"
    - path: "tests/scenarios/judge.mjs"
      provides: "5th rubric axis 'iMessage_render_safe' with auto-fail regex"
      contains: "iMessage_render_safe"
    - path: "tests/scenarios/output-normalizer.yaml"
      provides: "Golden scenario reproducing the 2026-04-27 Tesla markdown leak case"
  key_links:
    - from: "packages/pa-orchestrator/src/index.ts"
      to: "packages/pa-orchestrator/src/output-normalizer.ts"
      via: "import normalizeForIMessage; called immediately before enqueueOutbound on every turn (reactive + proactive)"
      pattern: "normalizeForIMessage\\("
    - from: "packages/pa-orchestrator/src/output-normalizer.ts"
      to: "packages/pa-orchestrator/src/chunker.ts"
      via: "import planChunks; invoked when normalized.length > 600"
      pattern: "planChunks\\("
    - from: "tests/scenarios/judge.mjs"
      to: "5th rubric axis"
      via: "regex auto-fail on \\*\\*.+?\\*\\* and \\[.+?\\]\\(.+?\\) in final assistant message"
      pattern: "iMessage_render_safe"
---

<objective>
Implement channel-agnostic output normalization at orchestrator exit so iMessage (and future channels) never render literal markdown / UTM-tracked URLs / over-length blobs.

Purpose: Close the visible "robotic" gap (literal `**bold**`, `[text](url)`, `?utm_source=openai` leaking through to user iMessage threads) that Phase 18's positive prompt instruction alone cannot guarantee. Normalizer is the deterministic safety net under Phase 18's stylistic carrot.

Output: `output-normalizer.ts` module + 8+ unit tests + orchestrator integration + 5th eval rubric axis + golden scenario for the witnessed Tesla case.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/20-output-normalizer/20-CONTEXT.md
@apps/macos-imessage-worker/src/chunker.ts
@packages/pa-orchestrator/src/index.ts
@tests/scenarios/judge.mjs

<interfaces>
<!-- Phase 15 chunker contracts (to be copied into packages/pa-orchestrator/src/chunker.ts) -->

From apps/macos-imessage-worker/src/chunker.ts:
```typescript
export type ChunkPlan = {
  chunks: string[]
  delaysMs: number[]
}

export type PlanChunksOptions = {
  maxChunks?: number          // default 3
  minChunkableLen?: number    // default 60
  minDelayMs?: number         // default 800
  maxDelayMs?: number         // default 1500
  random?: () => number
}

export function planChunks(text: string, opts?: PlanChunksOptions): ChunkPlan
```

Hard invariants (preserve when extracting):
  - Never split inside a fenced code block (``` ... ```)
  - Never split inside a markdown link [label](url)
  - Length ≤ minChunkableLen (60) → single chunk
  - No clean split → single chunk
  - Chunks capped at maxChunks (3)
  - delaysMs.length === chunks.length - 1
</interfaces>

<new_module_api>
<!-- Locked signature for output-normalizer.ts -->

```typescript
export type NormalizeOpts = {
  /** Length cap before chunk-split kicks in. Default 600. */
  maxLength?: number
  /** Override the strip list (advanced; prefer default). */
  stripParams?: ReadonlyArray<string>
  /** If true, never chunk-split; truncate to maxLength with "…" suffix. Default false. */
  forceSingleMessage?: boolean
}

export type NormalizeResult = {
  /** The normalized single-message text. If chunks present, this is chunks.join("\n\n"). */
  text: string
  /** Present only when input exceeded maxLength AND chunker found ≥2 clean chunks. */
  chunks?: string[]
  /** Names of tracking params dropped from URLs (for audit logging). */
  droppedTracking: string[]
  /** True if the original input exceeded maxLength. */
  wasOverLength: boolean
}

export const STRIP_PARAMS: ReadonlyArray<string>  // exhaustive utm_* / gclid / fbclid / mc_* / ref / ref_src / _hsenc / _hsmi list

export function normalizeForIMessage(input: string, opts?: NormalizeOpts): NormalizeResult
```

Rule application order (deterministic, top-to-bottom — order matters for idempotence):
  1. **Code fences first**: ```lang\nX\n``` → X (preserve content, drop fence syntax). Process triple-backtick before single-backtick.
  2. **Inline code**: `X` → X
  3. **Markdown links**: [text](url) → handle 3 cases:
       a. text === url (or text is url-prefix) → emit just stripped url
       b. url is short (≤30 chars after UTM strip) → "text url"
       c. url is long → "text (url)" with bare parens, no brackets
     UTM strip applied to URL inside this step (parse with URL constructor).
  4. **Bare URLs**: detect http(s)://... and apply UTM strip.
  5. **Markdown emphasis**: **X** → X, __X__ → X, *X* → X, _X_ → X. Process double before single (so **X** doesn't leave residual *X*).
  6. **List markers**: per-line "^[\-\*]\s+" → "· "; numbered lists "^\d+\.\s" left untouched.
  7. **Whitespace**: collapse runs of ≥3 blank lines to 2; trim trailing whitespace per line; trim outer.
  8. **Length cap**: if result.length > maxLength, call planChunks; if chunks ≥ 2 emit chunks; else truncate to maxLength-1 + "…".
</new_module_api>

<utm_strip_list>
<!-- Exhaustive params stripped from URL query strings (case-insensitive) -->

```typescript
export const STRIP_PARAMS = [
  // Google / generic UTM
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  // Google Ads
  "gclid", "gclsrc", "dclid",
  // Facebook
  "fbclid",
  // Mailchimp
  "mc_cid", "mc_eid",
  // HubSpot
  "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp",
  // Generic referrer leakage
  "ref", "ref_src", "ref_url", "source",
] as const
```

Implementation: `URL` constructor + `searchParams.delete(p)` for each param (case-insensitive iteration). If URL parse throws, return original string unchanged (resilient default).
</utm_strip_list>

<eval_rubric_extension>
<!-- 5th axis added to tests/scenarios/judge.mjs -->

```yaml
axes:
  - warmth_no_sycophancy        # Phase 18
  - in_character_voice          # Phase 18
  - no_robot_filler             # Phase 18
  - length_appropriateness      # Phase 18
  - iMessage_render_safe        # Phase 20 (this phase)

iMessage_render_safe:
  type: auto_fail
  description: "Final assistant message must not contain markdown emphasis or markdown link syntax"
  fail_patterns:
    - regex: "\\*\\*.+?\\*\\*"
      message: "markdown bold detected"
    - regex: "\\[.+?\\]\\(.+?\\)"
      message: "markdown link syntax detected"
    - regex: "^[\\-\\*]\\s"
      flags: "m"
      message: "markdown list marker detected (normalizer should have replaced with '· ')"
  on_match: score = 0, hard_fail = true
```
</eval_rubric_extension>

</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Extract chunker into pa-orchestrator + implement output-normalizer module</name>
  <files>
    packages/pa-orchestrator/src/chunker.ts,
    packages/pa-orchestrator/src/output-normalizer.ts,
    packages/pa-orchestrator/src/output-normalizer.test.ts
  </files>
  <behavior>
    Per D-02, D-04, D-05, D-08 — define test cases first (RED), then implement.

    Required unit tests in `output-normalizer.test.ts` (≥8 cases):

    1. **mixed markdown** — input `"**特斯拉一季度业绩上升** ([axios.com](https://axios.com/2026/04/26/tesla-q1?utm_source=openai&utm_medium=referral))"` → expected output contains `特斯拉一季度业绩上升`, contains `https://axios.com/2026/04/26/tesla-q1`, does NOT contain `**`, `[`, `](`, `utm_source`, `utm_medium`. `droppedTracking` includes `["utm_source", "utm_medium"]`.
    2. **UTM-only** — input `"check this https://example.com/x?utm_source=newsletter&id=42"` → output `"check this https://example.com/x?id=42"`. `droppedTracking` === `["utm_source"]`. The non-tracking `id=42` param is preserved.
    3. **nested emphasis** — input `"***bold-italic***"` → output `"bold-italic"`. No residual asterisks. Verify rule order (double-asterisk before single).
    4. **fenced code block** — input ` "```js\nconsole.log('hi')\n```" ` → output `"console.log('hi')"`. Fence syntax stripped, content preserved verbatim including the inner quotes.
    5. **very long input (>600 chars)** — input is 800-char paragraph with 2 sentence boundaries → `wasOverLength === true`, `chunks` present with length 2 or 3, `chunks.every(c => c.length <= 600)`.
    6. **empty input** — input `""` and `"   \n  \n"` → both return `{ text: "", droppedTracking: [], wasOverLength: false, chunks: undefined }`.
    7. **all-Chinese input** — input `"- 第一项\n- 第二项\n- 第三项"` → output `"· 第一项\n· 第二项\n· 第三项"`. No markdown emphasis. List markers converted.
    8. **pure code-fence with no content around** — input ` "```python\ndef f(): pass\n```" ` → output `"def f(): pass"`. Identical to test 4 but isolates the fence-only case.
    9. **idempotence** — for every input above: `normalize(normalize(x)).text === normalize(x).text`.
    10. **markdown link with text equal to URL** — input `"[https://example.com](https://example.com)"` → output `"https://example.com"` (single bare URL, not duplicated).
    11. **numbered list preserved** — input `"1. first\n2. second"` → output unchanged (no `· ` substitution).
    12. **triple+ blank lines** — input `"a\n\n\n\nb"` → output `"a\n\nb"`.

    All tests use `vitest`/`jest` matching the existing `packages/pa-orchestrator/` test runner (whichever is configured — check `package.json`).
  </behavior>
  <action>
    Phase A — Extract chunker (D-03):
    1. Copy `apps/macos-imessage-worker/src/chunker.ts` to `packages/pa-orchestrator/src/chunker.ts` verbatim. Keep the comment header noting it's a Phase 15 derivative scheduled for shared-package consolidation in Phase 21.
    2. Do NOT modify the worker's copy — both copies coexist until Phase 21 deprecates the worker.
    3. Adjust import paths only (no logic change). Re-export `planChunks` and `ChunkPlan` types.

    Phase B — Implement output-normalizer (RED → GREEN):
    1. Write `output-normalizer.test.ts` with all 12 test cases above. Run tests → MUST FAIL (no implementation yet).
    2. Implement `normalizeForIMessage()` in `output-normalizer.ts` following the rule application order documented in `<new_module_api>`:
       - Step 1: Strip triple-backtick fences (regex `/```[a-zA-Z0-9]*\n?([\s\S]*?)\n?```/g` → `$1`)
       - Step 2: Strip inline backticks (regex `/`([^`]+)`/g` → `$1`)
       - Step 3: Markdown links — regex `/\[([^\]\n]*)\]\(([^)\n]+)\)/g`. For each match, parse URL via `new URL(url)`; iterate `STRIP_PARAMS`, `searchParams.delete(p)` (case-insensitive), record dropped names. Decide replacement format per D-02 sub-rules a/b/c.
       - Step 4: Bare URL UTM strip — regex `/https?:\/\/[^\s)\]]+/g`, parse + strip + replace.
       - Step 5: Emphasis — apply `**X**` → `X` BEFORE `*X*` → `X` (run `**` regex first, then `*`). Same for `__` then `_`.
       - Step 6: List markers — regex `/^[\-\*][ \t]+/gm` → `· `. Numbered list regex `/^\d+\.[ \t]/m` left untouched.
       - Step 7: Whitespace — regex `/\n{3,}/g` → `\n\n`; per-line trailing whitespace trim; outer trim.
       - Step 8: Length cap — if `out.length > maxLength`: call `planChunks(out, { maxChunks: 3, minChunkableLen: 60 })`. If `chunks.length >= 2`, set result.chunks. Else truncate to `maxLength - 1 + "…"`.
    3. Implement `STRIP_PARAMS` as the exhaustive const list per D-04.
    4. Run tests → MUST PASS.
    5. Verify idempotence test passes (Step 9 in test list).

    Per D-01: module lives at `packages/pa-orchestrator/src/output-normalizer.ts` (channel-agnostic location).
    Per D-08: empty input returns the documented passthrough shape.
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && npm test -- output-normalizer</automated>
  </verify>
  <done>
    All 12 unit tests pass. `normalizeForIMessage()` exported with locked signature. `STRIP_PARAMS` exported. `chunker.ts` copy compiles. `npm run typecheck` (workspace root) passes. Idempotence test green.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Wire normalizer into orchestrator exit + golden scenario + 5th eval rubric axis</name>
  <files>
    packages/pa-orchestrator/src/index.ts,
    tests/scenarios/judge.mjs,
    tests/scenarios/output-normalizer.yaml
  </files>
  <behavior>
    Per D-06, D-07 — wire the integration and extend the eval rubric.

    Integration test: orchestrator turn that produces markdown-laden assistant text MUST be normalized before `pa_outbound` enqueue.

    Test cases (added to existing orchestrator test file or new `index.test.ts` slice):
    1. **reactive turn normalization** — mock LLM returns `"**hi** [link](https://x.com?utm_source=foo)"`. After turn, captured `pa_outbound.text` does not contain `**` or `[`. `pa_audit_events` has a row with `droppedTracking: ["utm_source"]`.
    2. **proactive turn normalization** (Phase 22 prep) — same assertion via the proactive code path. (If the proactive path doesn't yet exist, add a TODO comment + fail-safe assertion: any future `enqueueOutbound` call site must go through normalizer. Use a single internal helper `enqueueNormalized()` so it's structurally impossible to bypass.)
    3. **chunk path** — mock LLM returns 800-char text. After turn, ≥2 `pa_outbound` rows enqueued, each ≤600 chars, ordered by sequence.

    Golden scenario `tests/scenarios/output-normalizer.yaml` — replay of the 2026-04-27 Tesla case:
    - User input: `"特斯拉最近怎么样"`
    - Mocked tool result: returns markdown-formatted citation (the actual axios case)
    - Expected: final assistant message has zero `**`, zero `[…](…)`, zero `utm_*` params, contains the bare axios URL with non-tracking params preserved.
  </behavior>
  <action>
    Phase A — Single chokepoint integration (per D-07):
    1. In `packages/pa-orchestrator/src/index.ts`, locate every call site that enqueues `pa_outbound` rows (current call site for reactive turn; reserved location for proactive turn from Phase 22).
    2. Refactor: introduce private helper `enqueueNormalized(text, ctx)` that internally calls `normalizeForIMessage(text)`, then enqueues either single row (`result.text`) or N rows (`result.chunks`). Audit `result.droppedTracking` to `pa_audit_events` if non-empty (event type `output_tracking_stripped`, payload `{ params: [...] }`).
    3. Replace every direct `enqueueOutbound(...)` call in this file with `enqueueNormalized(...)`. Only ONE internal helper exists; this is the chokepoint.
    4. Add a code comment marking this as the Phase 20 boundary so future agents don't bypass.

    Phase B — Eval rubric extension (per D-06, NORM-07):
    1. Open `tests/scenarios/judge.mjs`. Find the rubric axes definition.
    2. Add 5th axis `iMessage_render_safe` with auto-fail semantics per the `<eval_rubric_extension>` block in context. Auto-fail (not soft score) on any of:
       - regex `/\*\*.+?\*\*/` (markdown bold)
       - regex `/\[.+?\]\(.+?\)/` (markdown link syntax)
       - regex `/^[\-\*]\s/m` (markdown list marker)
    3. The judge must short-circuit and return `{ score: 0, hardFail: true, axis: "iMessage_render_safe", reason: "<which-pattern-matched>" }` when any fail pattern matches the final assistant message.
    4. Run existing eval scenarios. If any existing scenario fails the new axis, that's a real bug — investigate. (Do NOT mass-update baselines without inspecting each failure.)

    Phase C — Golden scenario:
    1. Create `tests/scenarios/output-normalizer.yaml` reproducing the 2026-04-27 Tesla case. Use the harness's existing scenario format (look at sibling `.yaml` files in `tests/scenarios/`).
    2. Mock the `current-info` tool result to return markdown-formatted citation with `utm_source=openai&utm_medium=referral` params.
    3. Assertion block: final assistant message passes all 5 rubric axes including `iMessage_render_safe`, AND `pa_audit_events` contains the `output_tracking_stripped` event.

    Phase D — Run full suite:
    1. `npm run test --workspaces` for unit tests.
    2. `node tests/scenarios/runner.mjs --scenario output-normalizer` for the golden case.
    3. `node tests/scenarios/runner.mjs` (full eval suite) to verify the 5th axis didn't break existing scenarios.
  </action>
  <verify>
    <automated>npm run test -w packages/pa-orchestrator -- index && node tests/scenarios/runner.mjs --scenario output-normalizer</automated>
  </verify>
  <done>
    `enqueueNormalized()` is the single chokepoint in orchestrator (no other `enqueueOutbound` direct calls). Golden Tesla scenario passes with zero markdown / zero UTM. Eval judge has 5th axis with auto-fail. Existing scenarios still pass (or any failures triaged as real markdown leaks worth fixing). `pa_audit_events` records `droppedTracking` when non-empty.
  </done>
</task>

</tasks>

<verification>
**Plan-level verification (after both tasks complete):**

1. `npm run typecheck` — workspace passes.
2. `npm run test --workspaces` — all packages green.
3. `node tests/scenarios/runner.mjs` — full eval suite passes (5 axes × all scenarios).
4. **Manual production audit (post-deploy):**
   - Read last 50 `pa_outbound.text` rows in Firestore.
   - Grep for: `\*\*`, `[\[]`, `utm_`, `gclid`, `fbclid`. Expected: zero matches.
   - If any match: regression — file follow-up gap-closure task.
5. **Idempotence sanity:** unit test `normalize(normalize(x)) === normalize(x)` green for all 12 cases.
6. **Goal-backward truth check:**
   - T1 (no markdown emphasis) ↔ Task 1 tests 1, 3, 4, 8
   - T2 (no link syntax, bare URLs only) ↔ Task 1 tests 1, 2, 10
   - T3 (no UTM) ↔ Task 1 tests 1, 2 + Task 2 golden scenario
   - T4 (· bullets) ↔ Task 1 test 7, 11
   - T5 (whitespace collapse) ↔ Task 1 test 12
   - T6 (length cap + chunk) ↔ Task 1 test 5
   - T7 (eval auto-fail) ↔ Task 2 Phase B
   - T8 (idempotence) ↔ Task 1 test 9
</verification>

<success_criteria>
1. `normalizeForIMessage(input, opts?)` exported from `packages/pa-orchestrator/src/output-normalizer.ts` with locked `NormalizeResult` shape (NORM-01).
2. Six normalization rules implemented in documented order: code fences → inline code → markdown links → bare URL UTM strip → emphasis → list markers → whitespace → length cap (NORM-02, NORM-03, NORM-04, NORM-05, NORM-06).
3. ≥8 unit tests passing — actually 12 in this plan (NORM-08).
4. Orchestrator calls normalizer via `enqueueNormalized()` chokepoint immediately before every `pa_outbound` enqueue, including reserved proactive turn path (NORM-01).
5. Eval rubric judge.mjs has 5th axis `iMessage_render_safe` with hard auto-fail on documented regex patterns (NORM-07).
6. Golden scenario `output-normalizer.yaml` reproducing the 2026-04-27 Tesla case passes.
7. `STRIP_PARAMS` const exhaustively covers utm_*, gclid, fbclid, mc_cid, mc_eid, _hsenc, _hsmi, ref, ref_src, source, dclid, gclsrc, __hssc, __hstc, __hsfp (NORM-03).
8. Length cap behavior: >600 chars → planChunks (≤3 chunks, min 60 chars) → if no clean split, graceful truncate to 599+`…` (NORM-06).
9. Idempotence: `normalize(normalize(x)) === normalize(x)` for all test cases (T8).
10. 50-turn production audit post-deploy: zero markdown leakage, zero UTM leakage (v1.1 launch gate).
</success_criteria>

<output>
After completion, create `.planning/phases/20-output-normalizer/20-01-SUMMARY.md` documenting:
  - Final API signature shipped
  - Test count + edge cases covered
  - Production audit results (50-turn grep)
  - Any deviations from plan + rationale
  - Forward note: chunker is duplicated between worker + pa-orchestrator pending Phase 21 cleanup
</output>
