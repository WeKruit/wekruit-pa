# Phase 38 — PLAN (4 atomic tasks)

**Status:** Plan-only. Owner P9-C. Total estimate ~1 dev-day. T1 → T2 → T3 → T4 strict serial. Atomic commit per task.

**Source-of-truth context:** `.planning/phases/38-memory-policy/CONTEXT.md`.

**Production code dir:** `packages/pa-orchestrator/src/voice/memory-policy/` (NEW).

**Files NOT touched** (Adam working-tree collision avoidance — full list in CONTEXT §5).

---

## T1 — Types + advice-tracker SDK + Firestore + tests

**WHERE:**
- `packages/pa-orchestrator/src/voice/memory-policy/types.ts` (new) — `AdviceTrackerEntry` + `RepeatScoreResult` + `ContradictionType` + `ContradictionResult` + `MemoryPolicyContext` + `MemoryPolicyResult` + `AdviceTrackerDeps`
- `packages/pa-orchestrator/src/voice/memory-policy/advice-tracker.ts` (new) — `trackAdvice(userId, claireReply, turnId, deps?)` Firestore writer + `recentAdvice(userId, n=3, deps?)` Firestore reader + `repeatScore(reply, recent, deps?)` BGE-M3 cos-sim. Re-imports `cosineSim` from Phase 35 F4. Graceful degrade on missing API key (text-only persistence).
- `packages/pa-orchestrator/src/voice/memory-policy/advice-tracker.test.ts` (new) — Firestore mock + bilingual edge cases + cos-sim parity vs Phase 35 + LRU cache hit/miss + missing-API-key degrade

**HOW MUCH:** ~2.5 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/memory-policy/advice-tracker.test.ts` — all pass
- `types.ts` exports:
  - `AdviceTrackerEntry = { userId, turnId, text, lang, embedding, embeddedAt, strategy, uxState, ts, schemaVersion }`
  - `RepeatScoreResult = { triggered, maxSim, mostSimilarIdx, sims, threshold, reason, latencyMs }`
  - `ContradictionType = "dietary"|"allergy"|"pet"|"location"|"relationship"|"profession"|"preference_negation"|"health"|"language"|"persona_locked"`
  - `ContradictionResult = { violated, type, violatedTerm, factSnippet, replySnippet, confidence, latencyMs }`
  - `MemoryPolicyContext = { userId, turnId, claireReply, userLang, currentStrategy?, currentUxState?, factsCache? }`
  - `MemoryPolicyResult = { advice: { recent, repeatScore, injection }, contradiction, latencyMs }`
  - `AdviceTrackerDeps = { db?: Firestore, embedFn?: (texts: string[]) => Promise<(Float32Array|null)[]|null>, mem0Search?: (query, userId) => Promise<string[]>, getPersona?: (slug) => Promise<{ soul, style, examples } | null> }`
- `advice-tracker.ts`:
  - `trackAdvice(userId, claireReply, turnId, deps)` — embeds via `deps.embedFn` (default = local SiliconFlow batch); writes Firestore doc at `pa-advice-tracker/{userId}/items/{turnId}`. NEVER throws — logs + continues on Firestore error.
  - `recentAdvice(userId, n=3, deps)` — reads `pa-advice-tracker/{userId}/items` ordered by `ts DESC`, limit n. Returns `AdviceTrackerEntry[]` oldest-first (sorted ascending after fetch). Empty array on missing deps.
  - `repeatScore(reply, recent, deps)` — embeds reply + recent texts via `deps.embedFn` batched (1 call), computes max cos-sim, returns `RepeatScoreResult`. Threshold default 0.85 from `PA_MEMORY_REPEAT_THRESHOLD` env. Graceful degrade on missing key → `{ triggered: false, maxSim: null, reason: "skipped: no embed api key" }`.
- BGE-M3 wrapper:
  - `_defaultEmbedFn(texts)` — same env-var resolution chain as Phase 35 F4 (`SILICONFLOW_API_KEY` → `PA_OPENAI_AGENT_API_KEY` → `PA_SILICONFLOW_API_KEY`); same base URL + model id `BAAI/bge-m3`; same LRU cache (200) + Float32Array shape; returns `null[]` on missing key (caller branches)
  - `_resetEmbedCache()` exposed for tests
  - `_setEmbedFetchImpl(fn | null)` exposed for tests
  - Re-imports `cosineSim` from `../detectors/f4-advice-repeat.js` (parity with Phase 35; no duplicate)
- Firestore mock pattern: tests use `makeMockFirestore()` returning collection/doc/get/set/where/orderBy/limit chain (mirror `downstream.test.ts` style). No real Firestore in tests.
- Bilingual edge cases verified:
  - zh: `trackAdvice("u1", "你应该多锻炼", "t1", deps)` → entry persisted with `lang: "zh"` (auto-detected)
  - en: `trackAdvice("u1", "you should exercise more", "t2", deps)` → entry persisted with `lang: "en"`
  - mixed: `trackAdvice("u1", "你应该 try yoga", "t3", deps)` → `lang: "mixed"`
  - cos-sim repeat: `repeatScore("you should exercise more", [{ text: "you should exercise daily", embedding: <vec> }], deps)` with mock embed returning identical vectors → `maxSim ≈ 1.0` triggered
- Cache hit verification: 100 calls with same text → only 1 network call (counted via mock fetch invocation count)
- Missing API key: `getApiKey` returns null → `repeatScore` returns `{ triggered: false, maxSim: null, reason: "skipped: no embed api key" }`

**DON'T:**
- DON'T import any of the no-touch files (CONTEXT §5)
- DON'T add Mem0 search call in this task (T2 owns)
- DON'T add contradiction detector (T2)
- DON'T add prompt-injector (T3)
- DON'T touch `f4-advice-repeat.ts` (re-import only)

Commit msg: `feat(38/T1): memory-policy types + advice-tracker SDK + Firestore + BGE-M3 + tests (P9-C)`

---

## T2 — Contradiction detector + 10 fixtures + recall ≥ 9/10

**WHERE:**
- `packages/pa-orchestrator/src/voice/memory-policy/contradiction-detector.ts` (new) — `detectContradiction(reply, ctx, deps?)` rule-based 10-type lexicon overlay. Reads user facts via `deps.mem0Search` and persona facts via `deps.getPersona`. Returns `ContradictionResult`.
- `packages/pa-orchestrator/src/voice/memory-policy/__fixtures__/contradictions.json` (new) — 10 hand-crafted contradiction pairs (5 zh + 5 en) per CONTEXT D-38-3 + 5 "no contradiction" negative-control fixtures
- `packages/pa-orchestrator/src/voice/memory-policy/contradiction-detector.test.ts` (new) — runs all 15 fixtures, asserts recall ≥ 9/10 on positive set + ≤ 1 false positive on negative set + S3 sync verification (Type 10 with mock `getPersona`)

**HOW MUCH:** ~3 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/memory-policy/contradiction-detector.test.ts` — all pass
- `contradiction-detector.ts`:
  - `detectContradiction(reply, ctx, deps)` — pipeline: tokenize reply → for each ContradictionType, run lexicon match → first violated type wins (priority order: persona_locked > allergy > health > dietary > preference_negation > pet > location > relationship > profession > language)
  - Lexicon banks bilingual (zh + en + mixed):
    - `dietary: { veg_terms: [素食, 吃素, vegetarian, vegan, plant-based, 不吃肉], meat_terms: [牛排, 牛肉, 猪肉, 鸡肉, 羊肉, 鱼, beef, steak, pork, chicken, bacon, mutton, fish, salmon, lamb] }`
    - `allergy: { allergy_pattern: [对X过敏, allergic to X], common_allergens: [花生, 牛奶, 乳制品, 鸡蛋, 麸质, peanut, dairy, milk, egg, gluten, shellfish, 海鲜, 坚果, nut] }`
    - `pet: { cat_terms: [猫, 喵, cat, kitten], dog_terms: [狗, 犬, dog, puppy] }`
    - `location: { city_zh: [北京, 上海, 广州, 深圳, 杭州, 成都], city_en: [NYC, New York, LA, Los Angeles, SF, San Francisco, Seattle, Boston, Chicago, Austin] }`
    - `relationship: { single_terms: [单身, 没对象, 没结婚, single, unmarried, not married], partner_terms: [老婆, 老公, 妻子, 丈夫, 男朋友, 女朋友, 对象, spouse, husband, wife, boyfriend, girlfriend, partner] }`
    - `profession: { professions: [医生, 律师, 程序员, 工程师, 老师, 设计师, doctor, lawyer, engineer, teacher, designer, nurse, accountant] }`
    - `preference_negation: { negation_zh: [不, 从不, 从来不, 不喜欢, 讨厌], negation_en: [never, don't, dont, do not, hate, dislike, can't, won't] }`
    - `health: { conditions: [糖尿病, 高血压, 心脏病, 哮喘, diabetic, diabetes, hypertension, asthma, heart disease], avoid: [甜, 糖, 蛋糕, sugar, dessert, cake, sweets, candy, sodium, salt] }`
    - `language: detect via CJK char ratio vs ASCII ratio (mirrors F3 detector port)`
    - `persona_locked: read persona soul/style/examples → run dietary/preference checks against persona-stated facts`
  - Each type returns `{ violated: bool, violatedTerm: string|null, factSnippet, replySnippet, confidence }`. Confidence = 1.0 for direct hit, 0.5 for fuzzy
- `__fixtures__/contradictions.json` (15 entries):
  - 10 positive (`expected_contradiction: true`):
    - 5 zh: dietary, allergy, pet, preference_negation, health
    - 5 en: dietary, allergy, pet, location, profession
    - Each `{ id, lang, user_fact, claire_reply, expected_contradiction: true, expected_type, expected_violated_term: [synonyms] }`
  - 5 negative (`expected_contradiction: false`):
    - "I'm vegetarian" + "great salad spot" → no violation
    - "我吃素" + "试试这家素菜馆" → no violation
    - "I have a cat" + "your cat would love this toy" → no violation
    - "我在北京" + "北京有家不错的店" → no violation
    - "I'm a doctor" + "as a medical professional you'd appreciate" → no violation
- Test gates:
  - **Positive recall**: ≥ 9/10 fixtures correctly flag `violated: true` AND `type` matches `expected_type`. Asserted via `assert.ok(positivePassed >= 9, ...)`.
  - **Negative false-positive rate**: ≤ 1/5 fixtures incorrectly flag `violated: true`. Asserted via `assert.ok(negativeFailed <= 1, ...)`.
  - **S3 sync**: Type 10 persona_locked test — mock `getPersona` returns `{ soul: "Claire is vegetarian and prefers tea over coffee" }` (NOT inline string). Reply "I recommend the steak" → `{ violated: true, type: "persona_locked", violatedTerm: "steak" }`. Same fixture WITHOUT `getPersona` in deps → `{ violated: false }` (silently skipped). Asserted in dedicated test case.
- Latency: each `detectContradiction` call < 5ms (rule-based + Mem0 search mocked). Asserted over 50 invocations.

**DON'T:**
- DON'T add LLM-based fallback (D6)
- DON'T modify Mem0 surface (read-only — `mem0Search` only)
- DON'T trigger new Mem0 fact extracts in production path (only existing search)
- DON'T import inline persona strings from `admin-bootstrap.ts` (S3 violation)
- DON'T touch `f4-advice-repeat.ts` or other detectors

Commit msg: `feat(38/T2): contradiction detector + 10 fixtures + S3 sync verification (P9-C)`

---

## T3 — Prompt-injector + extractor-config + tests

**WHERE:**
- `packages/pa-orchestrator/src/voice/memory-policy/prompt-injector.ts` (new) — `buildAdviceInjection(recent, opts?)` per CONTEXT D-38-4. Bilingual gloss switch.
- `packages/pa-orchestrator/src/voice/memory-policy/extractor-config.ts` (new) — `verifyExtractorPinned()` + `pinnedExtractorModel()` per CONTEXT D-38-5. Reads `MEM0_LLM_MODEL` env. Soft-warn default; `PA_MEMORY_EXTRACTOR_HARDFAIL=true` opt-in throws.
- `packages/pa-orchestrator/src/voice/memory-policy/prompt-injector.test.ts` (new) — directive serialization + bilingual gloss + empty-recent edge case
- `packages/pa-orchestrator/src/voice/memory-policy/extractor-config.test.ts` (new) — env-var combinations: empty, "Qwen/Qwen2.5-72B-Instruct", "Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen2.5-1.5B-Instruct" (rejected), "qwen-mini" (rejected), default fallback to `Qwen/Qwen2.5-72B-Instruct`

**HOW MUCH:** ~2 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/memory-policy/prompt-injector.test.ts` — all pass
- `node --import tsx --test packages/pa-orchestrator/src/voice/memory-policy/extractor-config.test.ts` — all pass
- `prompt-injector.ts`:
  - `buildAdviceInjection(recent: AdviceTrackerEntry[], opts?: { userLang?: "zh"|"en"|"mixed"; max?: number }) → string`
  - When `recent.length === 0` → returns `""` (caller skips)
  - When recent items present → wraps in `[MEMORY-POLICY]` block per CONTEXT D-38-4
  - Format includes header `already_given_advice (do NOT repeat or paraphrase):`, numbered list (most recent first), and `note:` line in zh OR en per `opts.userLang`
  - Items truncated to first 200 chars (avoid prompt bloat)
  - Default `max` = 3
- `extractor-config.ts`:
  - `pinnedExtractorModel(): string` — reads `process.env.MEM0_LLM_MODEL?.trim()`; returns trimmed value, or default `Qwen/Qwen2.5-72B-Instruct` if empty
  - `verifyExtractorPinned(): { pinned: boolean, model: string, warning: string | null }` — checks model name does NOT contain rejected substrings (`1.5B`, `0.5B`, `0.6B`, lowercase variants, `mini`, `tiny`, `small`); returns warning text on rejection
  - `assertExtractorPinnedOrThrow()` — throws when `PA_MEMORY_EXTRACTOR_HARDFAIL === "true"` AND `verifyExtractorPinned().pinned === false`. Otherwise console.log warns + returns.
  - Logged warning text is informative (lists current model + valid alternatives)
- Tests verify:
  - Default (empty `MEM0_LLM_MODEL`) → `pinnedExtractorModel() === "Qwen/Qwen2.5-72B-Instruct"`, `verifyExtractorPinned().pinned === true` (default is acceptable)
  - `MEM0_LLM_MODEL=Qwen/Qwen2.5-7B-Instruct` → `pinned: true`
  - `MEM0_LLM_MODEL=Qwen/Qwen2.5-1.5B-Instruct` → `pinned: false`, warning includes "1.5B"
  - `MEM0_LLM_MODEL=qwen-mini` → `pinned: false`, warning includes "mini"
  - `MEM0_LLM_MODEL=` (whitespace) → falls back to default `Qwen/Qwen2.5-72B-Instruct`
  - `assertExtractorPinnedOrThrow()` with `PA_MEMORY_EXTRACTOR_HARDFAIL=true` + bad model → throws
  - `assertExtractorPinnedOrThrow()` with hard-fail unset + bad model → does NOT throw (logs only)
- Bilingual prompt-injector test:
  - `buildAdviceInjection([entry1, entry2, entry3], { userLang: "zh" })` → output contains `已经给过的建议`, NOT `Already-given advice`
  - `buildAdviceInjection([entry1], { userLang: "en" })` → output contains `Already-given advice`, NOT `已经给过的建议`
  - `buildAdviceInjection([], { userLang: "zh" })` → returns empty string

**DON'T:**
- DON'T add additional injection types (only "already-given advice")
- DON'T modify Mem0 stack config (`stacked.ts`) — extractor-config is read-only audit
- DON'T touch `f4-advice-repeat.ts`
- DON'T add Phase 39 benchmark hooks

Commit msg: `feat(38/T3): memory-policy prompt-injector + extractor-config audit + tests (P9-C)`

---

## T4 — Index/runMemoryPolicy + 50-turn synthetic smoke + WIRE-IN-PATCH

**WHERE:**
- `packages/pa-orchestrator/src/voice/memory-policy/index.ts` (new) — barrel re-export + `runMemoryPolicy(ctx, deps?) → Promise<MemoryPolicyResult>` orchestrator. Single entry point for wire-in caller.
- `packages/pa-orchestrator/src/voice/memory-policy/index.test.ts` (new) — smoke tests covering happy paths + latency assertion (`runMemoryPolicy` p95 < 200ms over 50 invocations on warm path)
- `packages/pa-orchestrator/src/voice/memory-policy/synthetic-repeat-rate.test.ts` (new) — 50-turn synthetic test per CONTEXT D-38-8: dynamic-imports `buildSyntheticCorpus` from `.planning/phases/34-baseline-measurement/synthetic-corpus.mjs`; runs each persona's 50 turns through `runMemoryPolicy` with mocked embed (cosine ≈ 1.0 for repeated patterns by construction) + asserts detector trigger rate ≥ 90% (45/50)
- `.planning/phases/38-memory-policy/WIRE-IN-PATCH.md` (new) — full patch spec for `voice/llm-rewriter.ts` (Adam manual apply)

**HOW MUCH:** ~2 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/memory-policy/*.test.ts` — full suite green
- `runMemoryPolicy` end-to-end:
  - Input: `MemoryPolicyContext` + `AdviceTrackerDeps`
  - Pipeline: `recentAdvice(userId, 3, deps)` → `repeatScore(reply, recent, deps)` → `detectContradiction(reply, ctx, deps)` → `buildAdviceInjection(recent, opts)`
  - Output: `MemoryPolicyResult { advice: { recent, repeatScore, injection }, contradiction, latencyMs }`
  - Latency p95 < 200ms over 50 invocations (warm path: cached embed + mocked Firestore + mocked Mem0)
- 50-turn synthetic test:
  - Dynamic-imports `.planning/phases/34-baseline-measurement/synthetic-corpus.mjs` (test-time only, NOT production import)
  - For each ZH persona (3 personas × 50 turns), runs `runMemoryPolicy` with mock `embedFn` that returns near-identical vectors for similar texts (deterministic hash → vector)
  - Mock embed uses simple text-hash → 1024-dim Float32Array projection that gives cos-sim ≈ 1.0 for identical texts and ≈ 0.7+ for the synthetic corpus's repeated patterns
  - Counts trigger rate per persona; asserts `triggerRate >= 0.9` (≥45/50) on synthetic — confirms detector recall is high enough that wire-in's diversity nudge will reduce actual emit rate < 5%
  - Test header documents this as "detector-recall gate" not "ship-rate gate" (the latter requires Adam wire-in)
- `WIRE-IN-PATCH.md` written, contains:
  - "Apply order" preface (Adam commits pending llm-rewriter.ts work first; applies AFTER Phase 35 + 36 + 37 wire-ins)
  - Section 1: Add `import { runMemoryPolicy, trackAdvice, type MemoryPolicyResult } from "./memory-policy/index.js"` near existing imports
  - Section 2: Extend `RewriteContext` with `userId?: string` + `turnId?: string` + `userLang?: "zh"|"en"|"mixed"` (already added by Phase 37 patch — note overlap)
  - Section 3: Extend `RewriteResult` with `memoryPolicyResult?: MemoryPolicyResult` (alongside Phase 35's `detectorResults` + Phase 37's `fsmResult`)
  - Section 4: Compute memory policy directive BEFORE `callRewriter` (so injection appears in system prompt). Wire pattern same as Phase 37 FSM directive — append to system prompt addendum.
  - Section 5: AFTER `cleaned` computed + post-detector strip (Phase 35 patch insertion point), call `trackAdvice(userId, finalText, turnId, deps)` — fire-and-forget with `void` (don't block return)
  - Section 6: Telemetry shape — `pa_turns.usage.memory_policy` (`{ recent_count, repeat_triggered, repeat_max_sim, contradiction_violated, contradiction_type, latencyMs }`)
  - Section 7: Feature flag `PA_MEMORY_POLICY_ENABLED` (default `false`); umbrella under `PA_HUMANIZE_RUNTIME_ENABLED` for Phase 40
  - Section 8: Anchor strings (resilient to Adam's nearby edits)
  - Adam-owed P0: apply patch after committing pending uncommitted work + after Phase 35-37 wire-ins land
  - Adam-owed P1: verify Firestore composite index `pa-advice-tracker/{userId}/items` ordered by `ts DESC` (in console; subcollection ordering doesn't strictly need composite but verify scan plan)
- All previous task tests still pass: `node --import tsx --test packages/pa-orchestrator/src/voice/memory-policy/*.test.ts` — full memory-policy suite green
- STATE.md updated: Phase 38 row → ✅ partial (memory policy built, wire-in deferred), `completed_phases` 9 → 10

Final commit (after smoke green):

`chore(38): SUMMARY + STATE — Phase 38 Memory Policy built, wire-in patch for Adam`

Commit msg for T4 main: `feat(38/T4): memory-policy runMemoryPolicy orchestrator + 50-turn synthetic + WIRE-IN-PATCH (P9-C)`

---

## Execution discipline

- **One task = one commit.** No mixing T1 and T2 in same commit.
- **Run typecheck + tests after EVERY task.** Red task = STOP, fix, then proceed.
- **S3 sync gate is non-negotiable.** Type 10 contradiction MUST read from `getPersona` Firestore source, not inline strings. Test enforces via mock injection.
- **Latency assertion lives in tests.** `index.test.ts` owns `runMemoryPolicy` p95 < 200ms gate over 50 invocations on warm path.
- **Patch spec drift risk:** anchor strings, not line numbers. Re-read llm-rewriter.ts immediately before T4 to confirm anchors still match (Adam may have committed new code in the interim, OR Phase 35-37 wire-ins may have landed first).
- **Fixture honesty:** 10 contradiction fixtures hand-crafted by P9-C using D-38-3 type definitions — NO fudging to artificially hit recall ≥ 9/10. Adam reviews any false negative in P1.

> [🟠 阿里味] **抓手清晰**：4 task × 4 commit, 每个 task 都给 Phase 39-40 quantitative gate 铺路。**因为信任所以简单。**
