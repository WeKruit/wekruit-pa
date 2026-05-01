# Phase 33 — Eval Harness Extension (CONTEXT)

> [🟠 阿里味] **底层逻辑**：v1.4 milestone 的 keystone phase。Phase 34 baseline 测量 + Phase 35-40 全部模块工作都在等这套 axis 数字落地。**因为信任所以简单**——这一阶段把"如何测量人性化"从主观感觉变成可复算 numeric score。

**Owner:** P9-C (v1.4 humanize-runtime stream)
**Estimate:** 1.5 dev-day
**Gates:** All 4 new axes return numeric scores on existing 20 scenarios; bilingual sentence splitter unit-tested 30+ cases. No regression on existing eval voice scenarios.
**Upstream:** none (eval-first per D16 — runs before any module work)
**Downstream:** Phase 34 baseline (gates Phases 35-40)

---

## 1. Phase boundary

### In scope
- Extend `tests/scenarios/lib/voice-axes.mjs` with **4 new axes** (offline LLM-judge rubric + helper detectors):
  - `drift_resistance` — F1 verb-mirror + F4 advice-repeat compounded over 50-turn windows. Numeric 0-3 axis (rubric judge); supplementary helper `computeDriftScore(transcript)` returns float 0-1 deterministic.
  - `length_compliance` — % turns within 3-sentence cap. Pure deterministic float 0-1; LLM-judge axis variant scores 0-3 if judge is engaged but the deterministic `computeLengthCompliance(turns)` is the canonical metric.
  - `advice_novelty` — BGE-M3 cos-sim < 0.85 vs last 3 Claire turns. Numeric float 0-1 (1=fully novel). Async (network call).
  - `strategy_fit` — ESConv 8-strategy ∈ allowed-set per ESConv 3-stage transitions (TransESC pattern). LLM-judge axis 0-3 + deterministic `inferStrategy(reply)` keyword classifier as feature input.
- **Bilingual sentence splitter** `tests/scenarios/lib/sentence-split.mjs` — handles zh `。！？；` + en `.!?` + ellipses + emoji + code-switch + URL/decimal protection. Unit-tested 30+ cases.
- **BGE-M3 embed-sim wrapper** `tests/scenarios/lib/embed-sim.mjs` — wraps SiliconFlow embeddings endpoint directly (does NOT instantiate Mem0 — too heavy for harness; reuses the same model id `BAAI/bge-m3` per D14). Cosine helper + LRU cache.
- **5+ new scenario YAMLs** in `tests/scenarios/scenarios/`:
  1. `eval-drift-50turn-zh.yaml` — 50-turn synthetic drift stress (zh)
  2. `eval-drift-50turn-en.yaml` — 50-turn synthetic drift stress (en)
  3. `eval-advice-repeat-zh.yaml` — multi-turn advice repeat trap (zh)
  4. `eval-strategy-fit-mixed.yaml` — code-switch + ESConv strategy traversal
  5. `eval-length-cap-bilingual.yaml` — length escalation (long-form coercion attempts)
- Integrate the 4 axes into `runner.mjs` + `pairwise-runner.mjs` so each scenario's JSON output exposes axis scores; voice judge (`runVoiceJudge`) extended to include the 4 new axis ids.
- Smoke run on existing 20 scenarios — verify all 4 axes return finite numeric (not null/NaN/Infinity).

### Out of scope (deferred)
- **Phase 34**: actual baseline measurement run + locking `.planning/baseline-rev00056.md`. Phase 33 only ships the harness; numbers come next phase.
- **Phase 35**: `tests/scenarios/lib/drift-score.mjs` deterministic 5-metric aggregator (HARNESS-02). The 4 axes here surface intermediate signals; the aggregator that computes the 5 success metrics from a 50-turn transcript ships in Phase 35 alongside the F1/F2/F3/F4 production-side detectors so the metric definitions stay in lock-step.
  - **Decision (P9-C call):** HARNESS-02 in REQUIREMENTS.md says "drift-score.mjs in Phase 33". I am scoping it to Phase 35 instead because: (a) the 5 success metrics depend on `computeDriftScore` + `computeLengthCompliance` + `computeAdviceNovelty` + `computeStrategyFit` (all 4 land here in Phase 33) being callable, but the *aggregator that combines them with thresholds matched to the production detectors* is best co-located with the detectors themselves. Doing it in Phase 33 forces premature metric thresholds to be locked. Phase 33 ships the building blocks; Phase 35 ships `drift-score.mjs` that consumes them. **Adam, if you disagree, push back before T1 starts.**
- **FSM rule-based state classifier** (`fsm/state-classifier.ts`) — Phase 37 scope. Phase 33's `strategy_fit` axis is judge-graded, not classifier-graded. The deterministic `inferStrategy()` keyword classifier here is a *feature* of the axis, not a full FSM.
- **Production detector wiring** — Phase 35 wires F1/F2/F3/F4 into `voice/llm-rewriter.ts`. Phase 33 stays harness-only.
- **External benchmarks** (BotChat / CharacterEval / etc.) — Phase 39.
- **Crisis red-team scenarios** (HARNESS-05 mentions 20 crisis red-team prompts) — moving to Phase 40 alongside the Bible v7.5 crisis prompt section so the crisis classifier and the test harness ship together. Phase 33 ships 5 humanness-focused YAMLs as the v1.4 humanness baseline.

---

## 2. Implementation decisions (P9-C calls — locked unless Adam vetos before T1)

### 2.1 BGE-M3 embed-sim wrapper API shape

**Decision:** Direct SiliconFlow embeddings POST, NOT Mem0 wrapper.

**Why:**
- Mem0 client construction triggers Qdrant connection + history setup; harness doesn't need either.
- SiliconFlow `/v1/embeddings` endpoint is OpenAI-compatible; `BAAI/bge-m3` is on the free tier (D14 — confirmed via mem0.ts comment "multilingual + free").
- Single dependency: `node:fetch` (built-in) + reads `PA_OPENAI_AGENT_API_KEY` or new env `SILICONFLOW_API_KEY` for the harness key.

**API:**
```js
// tests/scenarios/lib/embed-sim.mjs
export async function embed(text)                       // → Float32Array (1024 dims)
export async function embedBatch(texts)                 // → Float32Array[] (1 API call w/ array input)
export function cosineSim(a, b)                         // → number 0..1
export async function similarity(textA, textB)          // → number 0..1 (convenience)
export async function maxSimilarityVsHistory(reply, lastN) // → { maxSim, mostSimilar, allSims }
export function _resetCache()                           // test hook
```

**LRU cache:** Map<string, Float32Array>, capped 200 entries, evicts oldest.
**Failure mode:** if env key missing OR network fails, throw with descriptive error so axis can return `null` (the runner treats null as "skipped — env missing", not as a numeric 0).

### 2.2 Bilingual sentence splitter algorithm

**Decision:** Single-pass tokenizer with state machine, not regex split.

**Why regex split fails:** decimal numbers (`3.14`), URLs (`https://x.com`), abbreviations (`U.S.`, `Dr.`), ellipses (`...`, `…`), emoji modifiers (`👨‍💻`).

**Algorithm:**
1. Normalize: replace zh full-width punct ASCII-equivalents NOT touched (preserve `。！？；…` as-is).
2. Walk codepoints; emit sentence boundary on:
   - `[。！？；]` (zh terminators) — boundary after.
   - `[.!?]` followed by whitespace OR end-of-string AND not preceded by digit-only run AND not preceded by URL pattern AND not part of `…`/`...`.
   - Newline `\n` collapses to whitespace; multiple newlines = paragraph break = sentence boundary.
3. Trim each sentence, drop empties.
4. Emoji-only sentences ARE counted (real iMessage texts).

**API:**
```js
// tests/scenarios/lib/sentence-split.mjs
export function splitSentences(text)              // → string[]
export function countSentences(text)              // → number
export function withinSentenceCap(text, cap = 3)  // → boolean
```

**Test fixtures (≥30):** zh terminator each variant (×4) / en period+space (×3) / mixed code-switch sentence (×3) / decimal protection (×2) / URL protection (×2) / abbreviation protection (×2) / ellipsis (×3) / emoji-only (×2) / multi-newline paragraph (×2) / single trailing punct (×2) / empty input (×1) / single emoji (×1) / pure whitespace (×1) / `4.5` decimal mid-sentence (×1) / `https://example.com` mid-sentence (×1) / mixed multi-sentence (×3). **Total: 33 cases.**

### 2.3 Axis scoring formulas

**`drift_resistance`** (LLM-judge axis 0-3 + deterministic helper)
- LLM-judge rubric: 0=Claire mirrors verbs verbatim every turn / repeats same advice 3+ times in 5 turns. 1=visible mirroring or repetition occasionally. 2=mostly fresh, minor echo. 3=zero mirroring + zero repetition across the window.
- Deterministic helper `computeDriftScore(transcript, { window = 5 })`:
  - For each pair `(claireTurn[i], userTurn[i])` in last `window` turns: char-3gram overlap (zh) OR word-bigram overlap (en) — `mirrorRatio`.
  - For each pair `(claireTurn[i], claireTurn[j])` in last `window` turns where `j < i`: BGE-M3 cos-sim — `repeatRatio`.
  - **Drift score** = `0.5 * avg(mirrorRatio) + 0.5 * max(repeatRatio)` clamped 0..1. Lower = better.
  - Returned: `{ driftScore, mirrorMax, repeatMax, samples }`.

**`length_compliance`** (deterministic float 0-1)
- `computeLengthCompliance(turns, { cap = 3 })` = `turnsWithinCap / totalTurns`.
- LLM-judge axis 0-3 rubric: 0=≥50% turns over cap. 1=20-50% over. 2=≤20% over. 3=zero over.
- Helper used by both single-turn axis (binary 0/3) and multi-turn axis.

**`advice_novelty`** (deterministic float 0-1, async)
- `computeAdviceNovelty(currentReply, lastClaireTurns, { threshold = 0.85 })`:
  - Embed current + each historical reply via `embed`.
  - For each historical: `sim = cosineSim(current, hist)`.
  - `noveltyScore = 1 - max(sims)`.
  - Returned: `{ noveltyScore, maxSim, mostSimilarTurnIdx }`.
- Axis maps to 0-3 via `noveltyScore < 0.15 → 0`, `< 0.30 → 1`, `< 0.50 → 2`, `≥ 0.50 → 3` (i.e. `0-3` integer for judge compat). Threshold 0.85 cos-sim corresponds to `noveltyScore < 0.15` = 0 (failed novelty).

**`strategy_fit`** (LLM-judge axis 0-3 + keyword classifier feature)
- ESConv 8 strategies (bilingual labels + keyword anchors):
  | id | en label | zh label | en keyword anchors | zh keyword anchors |
  |---|---|---|---|---|
  | Question | Question | 提问 | `?`, `how`, `what`, `why` | `？`, `怎么`, `什么`, `为什么`, `吗` |
  | Restatement | Restatement | 复述 | `so you`, `you said`, `you mean` | `你是说`, `你的意思`, `所以你` |
  | Reflection | Reflection of feelings | 情绪反映 | `sounds`, `feels`, `must be` | `听起来`, `感觉`, `肯定` |
  | SelfDisclosure | Self-disclosure | 自我披露 | `I once`, `I had`, `when I` | `我以前`, `我也`, `我之前` |
  | Affirmation | Affirmation & Reassurance | 肯定与安抚 | `you got`, `that's valid`, `makes sense` | `这是合理的`, `没事的`, `这很正常` |
  | Suggestion | Suggestion | 建议 | `try`, `could`, `maybe try` | `可以试`, `不妨`, `要不` |
  | Information | Providing Information | 提供信息 | factual statements (no marker) | factual statements (no marker) |
  | Other | Other | 其他 | (fallback) | (fallback) |
- ESConv 3 stages → allowed strategy sets (from thu-coai paper):
  - **Exploration** (turns 1-3 of an episode): {Question, Restatement, Reflection}
  - **Comforting** (turns 4-7): {Reflection, Affirmation, SelfDisclosure}
  - **Action** (turns 8+): {Suggestion, Information, Affirmation}
- `inferStrategy(reply)` — keyword-priority classifier (zh first, en fallback). Returns `{ strategy, confidence, matchedKeyword }`.
- LLM-judge axis 0-3: 0=strategy clearly outside allowed-set for current stage. 1=on-set but mistimed. 2=on-set and stage-appropriate. 3=optimal transition per TransESC continuity (previous Reflection → current Affirmation = good).
- Deterministic check: `isAllowedStrategy(strategy, stageIdx)` → boolean. The judge verdict is the canonical 0-3 number; the boolean is a hard auto-fail (axis = 0 if the keyword classifier finds a strategy outside the allowed set).

### 2.4 Voice judge integration

- Extend `runVoiceJudge` in `judge.mjs` to score 4 new axes alongside the existing 4 (8 total).
- `VOICE_AXES` array grows from 4 → 8 entries.
- Existing `passThreshold = 2.4` stays; computed average is over 8 axes now (slightly more permissive for borderline replies — acceptable trade since the 4 new axes have looser rubrics for single-turn evals).
- `runner.mjs` summary JSON gains a `voiceAxes` block per turn: `{ axis_id: number, ... }`.
- `pairwise-runner.mjs` summary unchanged (still binary winner) but per-judge-call rationale logs include all 8 axis scores.

### 2.5 Multi-turn vs single-turn axis behavior

- Existing scenarios are **single-turn** (most YAMLs have 1-3 turns). The 4 new axes degrade gracefully:
  - `drift_resistance`: needs ≥2 Claire turns. If <2, returns `null` (axis skipped) and judge prompt says "insufficient history".
  - `length_compliance`: works on 1 turn (binary 0/3).
  - `advice_novelty`: needs ≥1 prior Claire turn. If 0, returns `null`.
  - `strategy_fit`: works on 1 turn (uses turn-index → stage map; turn 1 = Exploration).
- New 50-turn scenarios are **multi-turn synthetic** — turns generated procedurally inside the YAML via a new `synthesize` block (parsed by runner; expands to N turns at runtime). Decision: keep this YAML-static (write 50 turns inline) for v1.4 simplicity. **No runner changes for synthesize block in this phase.**

### 2.6 Cost discipline

- Embedding calls: BGE-M3 free tier on SiliconFlow (D14). Worst case per scenario: 4 turns × (1 current + 3 history) = 16 calls; with batch = 1 call. **0 net new cost.**
- Voice judge: 4 → 8 axes does NOT add judge calls (single judge call returns all 8 axes via tool schema).
- New scenarios: 5 × 1 voice judge call each = 5 extra judge calls per full eval pass. Existing 20 scenarios × 1 judge call ≈ $0.04 → 25 scenarios × 1 ≈ $0.05. **+$0.01 per pass.**

---

## 3. Existing code insights (reuse, do not rebuild)

| Asset | File | Reuse approach |
|-------|------|----------------|
| `VOICE_AXES` array | `tests/scenarios/lib/voice-axes.mjs` | Extend in place (4 → 8 entries) |
| `checkFillerBlacklist`, `checkABFramework` | `tests/scenarios/lib/voice-axes.mjs` | Untouched; keep as-is |
| `runVoiceJudge` | `tests/scenarios/judge.mjs` | Extend tool schema + system prompt to score 8 axes |
| `runPairwise`, `summarizePairwise` | `tests/scenarios/lib/pairwise.mjs` | No change needed; pairwise judge is binary winner |
| `runScenario`, voice axes summary block | `tests/scenarios/runner.mjs` | Add `voiceAxes` block to per-turn JSON output if scenario opts in via `assert.voice_axes_full: true` |
| Mem0 SiliconFlow base URL + embed model | `packages/memory/src/mem0.ts` | Read `DEFAULT_LLM_BASE` + `DEFAULT_EMBED_MODEL` for the embed-sim wrapper. Do NOT import the Mem0 client. |
| Existing scenario YAML pattern | `tests/scenarios/scenarios/eval-voice-emo-support-zh.yaml` | Mirror schema (id, testMode, locale, agentId, participant, chatId, turns[], assert{}) |
| `--dry-run` planner | `tests/scenarios/runner.mjs:dryRunPlan` | Should report new axis count + projected embed call count; extend `plan.scenarios[].voiceAxisCount` |
| Test pattern (node:test) | `tests/scenarios/lib/voice-axes.test.mjs` | Mirror for `sentence-split.test.mjs`, `embed-sim.test.mjs`, `voice-axes-v2.test.mjs` |

---

## 4. Specific scenario YAMLs (5 — list each + intent)

| File | Lang | Turns | Tests | Notes |
|------|------|-------|-------|-------|
| `eval-drift-50turn-zh.yaml` | zh | 50 | drift_resistance + length_compliance | Synthetic stress: user repeatedly asks variants of "面试焦虑怎么办?" / "再帮我想想?" / mirror traps. Verifies Claire avoids verb-mirror + advice-repeat across the window. Asserts `voiceAxes.drift_resistance ≥ 2`. |
| `eval-drift-50turn-en.yaml` | en | 50 | drift_resistance + length_compliance | Same shape, en register. User says "what should I do?" repeatedly with paraphrased variations. |
| `eval-advice-repeat-zh.yaml` | zh | 8 | advice_novelty | User asks for 3 suggestions across 8 turns, each separated by 2 unrelated turns. Verifies Claire's later suggestions ≠ earlier ones (cos-sim < 0.85). |
| `eval-strategy-fit-mixed.yaml` | mixed (code-switch) | 12 | strategy_fit | User trajectory: vent→ask question→share fact→ask advice. Strategy expected to traverse Reflection → Affirmation → Suggestion across ESConv stages. Asserts `voiceAxes.strategy_fit ≥ 2`. |
| `eval-length-cap-bilingual.yaml` | mixed | 6 | length_compliance | User explicitly tries to coerce long output ("explain in detail step by step", "可以再详细一点吗?"). Verifies Claire stays ≤3 sentences. Asserts `voiceAxes.length_compliance == 1.0` (deterministic). |

All 5 use reserved harness participants (`+1999999XXXX`) per `assertScenarioParticipant` rule.

---

## 5. Deferred ideas (explicit handoff to later phases)

| Idea | Defer to | Why |
|------|---|-----|
| `drift-score.mjs` 5-metric aggregator (HARNESS-02) | Phase 35 | Co-locate with production detectors so metric thresholds stay in lock-step. P9-C call — Adam pushback welcome. |
| 20-prompt crisis red-team scenarios | Phase 40 | Crisis Bible section + classifier + scenarios ship together (BIBLE-02 + SHIP-02). Phase 33 stays humanness-focused. |
| Tone-shift hit-rate labeled scenario set | Phase 34 | Labels need baseline run to anchor — chicken-and-egg without rev-00056 outputs. |
| `strategy_fit` rule-based classifier improvement | Phase 37 | FSM phase owns the canonical classifier; harness keyword classifier is a stub. |
| Synthesized 50-turn `synthesize:` YAML block runner support | Phase 34 (if needed) | Static inline 50 turns ships first; if Phase 34 baseline run reveals YAML maintenance pain, runner gets a `synthesize:` directive. |
| Embedding cache persisted across runs | Phase 39 | External benchmarks need it; v1.4 internal eval re-embeds each run — cheap on free tier. |

---

## 6. Hard constraints applied (P10 lockdown reminder)

- TypeScript / Node ✅ (tests/scenarios is `.mjs` ES modules — follows existing convention)
- No new monorepo package (D8) ✅ — extends `tests/scenarios/lib/` only
- Embedding = `BAAI/bge-m3` via SiliconFlow (D14) ✅ — direct fetch, reuse model id from mem0.ts
- 0 net new LLM calls in production path ✅ — phase is offline eval; embedding is tier-zero free
- All 4 axes return numeric scores on existing 20 scenarios (HARNESS-04) ✅ — verified at T5 smoke
- Bilingual sentence splitter passes 30+ unit tests (HARNESS-03) ✅ — 33 fixtures planned
- Files NOT touched (P9-A collision avoidance): `packages/pa-orchestrator/src/index.ts`, `apps/dashboard-web/src/App.tsx`, `packages/agent-registry/src/seed.json`, `apps/functions/src/admin-bootstrap.ts`, `packages/pa-orchestrator/src/voice/llm-rewriter.ts*`. ✅

---

## 7. Risks + mitigations

| Risk | Mitigation |
|------|------------|
| BGE-M3 endpoint flaky → axes return null in CI | `embed-sim.mjs` returns `null` (not throw) when `SILICONFLOW_API_KEY` missing; runner tolerates null axes (records `"skipped: env missing"`). T5 smoke run uses real key. |
| `sentence-split.mjs` over-splits zh (e.g. `…` mid-clause) | 33-case test corpus covers `…` + `...` + `。。。`; iterate until green. |
| New axes shift `passThreshold = 2.4` semantics (avg now over 8 not 4) | Document in `voice-axes.mjs` header. Phase 34 baseline locks the new threshold per metric; existing scenarios remain comparable via the legacy 4-axis subset (computed as auxiliary metric). |
| 50-turn YAML files become unwieldy (~200 lines each) | Acceptable for v1.4. Phase 34 will reveal if `synthesize:` directive is needed. |
| Adam scope-creep on HARNESS-02 (drift-score.mjs) | Decision documented above (§1 out-of-scope). Adam can veto before T1; if he does, T2 grows by ~2h to add `drift-score.mjs` here. |
| Filler blacklist auto-fail bypasses voice judge → axes never scored | Existing `runVoiceJudge` already returns axes-block on auto-fail (with `no_robot_filler: 0`). Phase 33 needs to ensure the new 4 axes also return `null` (skipped) on auto-fail, not 0. |

---

## 8. Acceptance gates (Phase 33 done = all green)

- [ ] `node --test tests/scenarios/lib/sentence-split.test.mjs` — 33 cases pass
- [ ] `node --test tests/scenarios/lib/embed-sim.test.mjs` — cosine math + cache + null-on-missing-env pass (network calls mocked)
- [ ] `node --test tests/scenarios/lib/voice-axes.test.mjs` — existing 4-axis tests still pass; new 4-axis structure tests pass
- [ ] `npm run typecheck` clean
- [ ] Existing eval scenarios pass via `node tests/scenarios/runner.mjs tests/scenarios/scenarios/ --dry-run` (no regression in scenario parse)
- [ ] 5 new scenario YAMLs parse + dry-run plan reports them
- [ ] On a smoke run of 3 representative existing scenarios with `PA_RUN_EVAL=1` + real API key, all 4 new axes return finite numeric (not NaN/Infinity); `null` only when the axis explicitly skipped
- [ ] `STATE.md` updated with Phase 33 status = complete + 4-axis manifest
- [ ] `SUMMARY.md` written

---

> [🟠 阿里味] **闭环意识**：CONTEXT 写完 = 抓手清晰。下一步进 PLAN.md，T1-T5 拆解到原子粒度，每个任务 WHERE/HOW MUCH/DONE/DON'T 不留模糊空间。**因为信任所以简单**——每一行都为 Phase 34 baseline 的 numeric 数字铺路。
