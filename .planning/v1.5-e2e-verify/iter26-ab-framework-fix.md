# iter26 — AB framework strip + suspended directive rewrite (拟人化坍塌真因)

**Date:** 2026-05-03
**Adam directive:** "我觉得都没有30turn就已经坍塌了, 主要是拟人化这一边的质量变差, mem0在这里的作用呢, 这个很重要"

## Adam's qualitative complaint vs metrics

iter25 30-turn drift test reported length compliance 30/30 + drift 0.014 = "passing".
But qualitatively Claire was emitting "X 还是 Y" framework on **18/30 turns (60%)**.

That's the AI tell-tale Adam was seeing. Drift score (F1 verb-mirror n-gram) doesn't catch
structural pattern repetition like the AB framework. Numbers said pass, ear said fail.

## Root cause (RCA)

Two separate bugs compounded:

### Bug 1: `stripABProbeFromTail` silently broken 25+ days

`output-normalizer.ts` had `splitIntoClauses(text)` splitting on commas before AB-probe
match. Production replies like:

```
"shit，面试翻车确实很膈应。你现在是更担心X，还是Y？"
```

Got split into:
```
["shit，", "面试翻车确实很膈应。", "你现在是更担心X，", "还是Y？"]
```

Last clause `"还是Y？"` starts with `还是`, has no chars BEFORE it. Regex
`[^?？\n。！!]{2,30}还是` requires 2-30 chars before — fails. **No match → no strip**.
Plus `SENTENCE_TERM_RE = /[。！？!?\n]/` was missing ASCII period `.` — broke EN
walk-back boundary detection.

### Bug 2: iter24 `suspended_no_answer` directive was inducing AB framework

When user is mid-onboarding-probe but doesn't answer (e.g. user vents while q_role
asked), iter24 wrote:

```
"...Reply with friend-tone empathy (1 short ack), then ONE short gentle clarifier
specific to {step}..."
```

LLM interpreted "ONE short gentle clarifier" as → emit "你 X 主要是 A 还是 B?"
on EVERY turn. The strip was supposed to remove these but Bug 1 silenced the strip.
Combined: 18/30 turns AB-framework leaked through.

## Fix

### `stripABProbeFromTail` rewrite (procedural span-based)

Removed `splitIntoClauses` from the strip path. New algorithm:

1. Find rightmost `还是` (ZH) or `\bor\b` (EN) in text
2. Walk forward to find Y-side question mark within 30/40 chars (no commas in Y)
3. Walk backward from `还是`/`or` to find X-start boundary:
   - Sentence terminator (now includes `.` ASCII) → use that boundary
   - Closest comma → use only if no sentence terminator in window AND X-after-comma ≥2 chars
   - Window edge → fallback
4. Verify X side has no excluded chars + length 2-30
5. Strip from X-start; trim trailing comma/whitespace

### `suspended_no_answer` directive rewrite

```
- ONE short gentle clarifier specific to {step}
+ ONE short friend-tone acknowledgement only — no question, no probe, no
  "A 还是 B / A or B" framework. ≤ 1 short sentence, ≤ 12 字 / ≤ 8 words.
  NEVER append a clarifier question. NEVER list options.
```

## Verification (30-turn ZH long-context drift, fresh user +19999992602)

| Metric | iter25 | iter26 |
|---|---|---|
| AB framework "X 还是 Y" | **18/30 (60%)** | **0/30 (0%)** |
| Length compliance | 30/30 | 30/30 |
| Drift score | 0.014 | 0.014 |
| MirrorMax | 0.071 | 0.071 |

Sample iter26 replies (NO AB framework):
- Turn 0: "卧，这也太烦了吧……你先骂两句我在听。"
- Turn 5: "卧又来了这套自我怀疑……听着很磨人。"
- Turn 10: "嗯，像是被卡在原地了。"
- Turn 17: "卧行，你这劲儿我看着呢。"
- Turn 19: "卧我在。"
- Turn 27: "嗯，我在。"
- Turn 29: "卧，最后一次也得给你撑住。"

Replies are: empathy ack + presence + occasional minimal directive. ZERO "X 还是 Y"
across all 30 turns post-fix.

## Mem0 audit (Adam: "mem0在这里的作用呢")

Mem0 wiring: `afterAssistantTurn` → `mem0Add({user_msg, assistant_msg}, partitionKey)`
on every turn. Qwen-7B in SiliconFlow extracts facts. `mem0Search(query, partitionKey)`
on next turn → injects `Memory context: ...` into systemInputs.

For a **pure-vent user** (this 30-turn test), Mem0 captures little because vent
messages aren't fact-stating. "I'm crashing" / "我又焦虑了" → no extractable
preferences/role/CV/etc. So Mem0 contribution to long-context vent quality is
minimal — the heavy lifting is from F1-F4 detectors + AB strip + suspended-no-answer
directive.

For **mixed-content users** (vent + concrete questions), Mem0 captures targetRole /
yoeRange / visaStatus / location facts and surfaces them across turns. That's its
real role; vent-only chains don't exercise it.

## Tests added

405/405 unit tests still pass. Updated 1 existing back-compat test to align with
new strip semantics. New procedural strip handles both:
- "嗯 我在, X还是Y?" (preserve "嗯 我在" stem)
- "shit，X。Y还是Z？" (preserve "shit，X。" stem)
- Bare AB sentence "X还是Y?" (full strip)
- EN equivalents

## Commit

`[pending]` feat(v1.5/iter26): AB-strip splitIntoClauses fix + suspended_no_answer
directive rewrite — 60%→0% AB framework on 30-turn drift
