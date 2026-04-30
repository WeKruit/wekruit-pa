# Phase 38 — Memory Policy (advice-tracker + contradiction) — CONTEXT

> [🟠 阿里味] **底层逻辑**：Phase 35 F4 给了 in-session sliding-window cos-sim。Phase 38 把它延伸到 cross-session Firestore advice tracker (`pa-advice-tracker/{userId}/items/{turnId}`) + Mem0 fact-diff contradiction detector + Phase 3 prompt-inject "已经给过的建议". 让 Claire 不再 self-repeat 同一句建议、不再忘记用户说过的事。**抓手清晰**：50-turn synthetic advice repeat <5% (BGE-M3 cos-sim>0.85) + contradiction recall ≥9/10 on seeded fixtures + extractor pinned Qwen-7B+ + S3 sync (read pa-personas Firestore not inline). 0 net new LLM calls in production path. **因为信任所以简单**：Phase 33 embed-sim helper 给你了，Mem0 layer 给你了，Phase 35 BGE-M3 wrapper 给你了，baseline 数字给你了。证据说话。

**Owner:** P9-C (v1.4 humanize-runtime stream)
**Estimate:** ~1 dev-day
**Upstream gate:** Phase 35 F4 detector built (in-session window) + Phase 33 `embed-sim.mjs` helper + `packages/memory/src/mem0.ts` Mem0 OSS layer
**Downstream:** Phase 39 External Auto Benchmarks (memory policy active in benchmarked stack), Phase 40 Bible v7.5 + Ship (umbrella `PA_HUMANIZE_RUNTIME_ENABLED` gates `PA_MEMORY_POLICY_ENABLED`)

---

## 1. Phase boundary

### In scope (MEMORY-01..06 + D5)

Standalone module under `packages/pa-orchestrator/src/voice/memory-policy/` — TypeScript, **0 net new LLM calls in production path** (BGE-M3 = embedding tier free; Mem0 fact extract uses existing Qwen call), < 200ms per turn for advice-query + contradiction-check combined, bilingual zh + en + mixed.

Files to ship:

| File | Role |
|------|------|
| `types.ts` | `AdviceTrackerEntry` + `ContradictionResult` + `MemoryPolicyContext` + `MemoryPolicyResult` schemas + `AdviceTrackerDeps` for testability |
| `extractor-config.ts` | Mem0 extractor pinning (D5). Reads `MEM0_LLM_MODEL` env; rejects 1.5B / smaller models; logs warning when extractor < Qwen-7B class. Exports `verifyExtractorPinned()` + `pinnedExtractorModel()` |
| `advice-tracker.ts` | `trackAdvice(userId, claireReply, turnId, deps?): Promise<void>` + `recentAdvice(userId, n=3, deps?): Promise<AdviceTrackerEntry[]>` + `repeatScore(reply, recent[], deps?): Promise<{ maxSim, mostSimilar, sims }>`. Firestore persistence at `pa-advice-tracker/{userId}/items/{turnId}` with BGE-M3 embed stored as Float32 array (1024 dims). Graceful degrade when Firestore deps absent (in-mem fallback for tests). |
| `contradiction-detector.ts` | `detectContradiction(reply, userFacts, deps?): ContradictionResult`. Rule-based fact-vs-reply diff using lexicon overlay (vegetarian → meat, cat → dog, allergic → contains, no/never → suggestions). Reads `userFacts` from Mem0 search wrapper passed in `deps`. **Read-only on Mem0** — does NOT trigger new fact extract calls in production path; uses what Mem0 already extracted. |
| `prompt-injector.ts` | `buildAdviceInjection(recent, opts?): string`. Generates Phase 3 prompt section "已经给过的建议" (zh) / "Already-given advice" (en) injecting last 3 advice items as a NEVER-repeat directive. Bilingual gloss switch on `opts.userLang`. |
| `index.ts` | Barrel + `runMemoryPolicy(turn, userId, history, deps?): Promise<MemoryPolicyResult>` orchestrator. Single entry point for wire-in caller. Pipeline: load-recent-advice → repeat-score (BGE-M3) → load-user-facts (Mem0) → contradiction-check → build-injection. |
| `*.test.ts` per file | Unit tests covering bilingual edge cases + 50-turn synthetic repeat-rate gate + contradiction-recall gate + S3 persona-sync verification + latency budget. |
| `__fixtures__/contradictions.json` | 10 hand-crafted contradiction pairs covering bilingual (5 zh + 5 en) — `{ id, lang, user_fact, claire_reply, expected_contradiction, contradiction_type, expected_violated_term }` |
| `__fixtures__/synthetic-advice-corpus.mjs` | Test-only corpus generator that mocks Claire emitting near-duplicate advice across 50 turns; used by `synthetic-repeat-rate.test.ts` to verify post-policy repeat rate < 5% (gate from baseline-rev00056.md) |

Plus deferred wire-in:

| File | Role |
|------|------|
| `.planning/phases/38-memory-policy/WIRE-IN-PATCH.md` | Markdown spec for `voice/llm-rewriter.ts` showing where to call `runMemoryPolicy` BEFORE `callRewriter` (so directive can be appended to system prompt) + post-gen `trackAdvice` write + telemetry. **No code change to llm-rewriter.ts in this phase** (Adam working tree collision-avoidance per P10 brief — `llm-rewriter.ts` + `.test.ts` + admin-bootstrap.ts modified per `git status`). |

### Out of scope (deferred)

| Item | Defer to | Why |
|------|----------|-----|
| **Wire-in to `voice/llm-rewriter.ts`** | Adam manual apply via `WIRE-IN-PATCH.md` | Adam still has uncommitted `llm-rewriter.{ts,test.ts}` + `admin-bootstrap.ts`. P9-C MUST NOT touch them. Same protocol as Phase 35/36/37. |
| **LLM-based fact contradiction classifier** | Out of scope v1.4 | D6: no Reflexion-lite / LLM judge in runtime. Rule-based lexicon + Mem0-extracted facts is the locked path. |
| **Strategy-aware advice-repeat skipping** (Question repeat is fine, Suggestion repeat is bad) | Phase 40 ship-gate | Phase 38 = generic cos-sim across all reply types. Phase 40 may pass FSM `current_strategy` to skip repeat-check on Question/Restatement turns. Phase 37 `FsmResult` already exposes `strategy_fit` for this. |
| **Persistent embed cache across cold-starts** | Phase 40 ship-gate (if F4 + tracker p95 > 200ms) | Phase 38 LRU cache is per-process. If prod traffic shows tail-latency spikes, add Firestore-persisted embed cache keyed on text hash. |
| **GDPR delete API** for `pa-advice-tracker` | v1.5 | Same retention semantics as `pa-turns`; user deletion cascades through that channel in v1.5. |
| **Mem0 fact extract retry on contradiction** | Out of scope | Read-only consumption of Mem0; retraining fact extractor is Phase 39+ benchmark scope. |
| **Cross-session FSM `last_ux_state` / `last_strategy` persistence** | Phase 40 (or v1.5) | Phase 38 ships advice-tracker only; FSM cross-session persistence is the next tracker added on this collection if needed. |

---

## 2. Methodology — extend Phase 35 F4 to cross-session + Mem0 read-only fact-diff

**Decision (locked):**

- Advice tracker = Firestore-persisted entries `{ userId, turnId, text, lang, embedding, ts }` at `pa-advice-tracker/{userId}/items/{turnId}`. Embed = BGE-M3 1024-dim Float32 array stored as Firestore array of numbers (or omitted when API key absent — degraded mode).
- Cos-sim repeat-check identical algorithm to Phase 35 F4 (`cosineSim` on Float32Array). Re-import F4's `cosineSim` from `../detectors/f4-advice-repeat.js` for parity (not duplicated).
- Mem0 read-only: contradiction detector calls `mem0Search(config, query, userId)` to fetch existing facts (no new extract call). Lexicon-driven overlay flags reply ↔ fact contradictions.
- Extractor pinning (D5): `extractor-config.ts` reads `MEM0_LLM_MODEL` env + asserts it's Qwen-7B-Instruct or larger. Rejects: empty, "Qwen/Qwen2.5-1.5B-Instruct", any model with "1.5B" / "0.5B" / "0.6B" / "<7B" in name. Default fallback per existing stack: `Qwen/Qwen2.5-72B-Instruct` (`packages/memory/src/mem0.ts:40`).
- S3 sync (P10 brief): when contradiction-detector needs persona-set facts (e.g. "Claire is vegetarian" if persona declares it), it reads from `pa-personas/{slug}` via `composePersonaPromptFromDoc` (Phase 32 W3) — NOT inline persona strings in `admin-bootstrap.ts`. Verified via test that mock Firestore fixture overrides default persona facts.

### Reused assets (verified existing)

| Asset | Source | Use in Phase 38 |
|-------|--------|-----------------|
| `cosineSim(a, b)` | `packages/pa-orchestrator/src/voice/detectors/f4-advice-repeat.ts:97` | Same Float32Array cos-sim — re-export, no duplicate |
| BGE-M3 SiliconFlow embed POST | `packages/pa-orchestrator/src/voice/detectors/f4-advice-repeat.ts:postEmbeddings` | Re-implemented with same env var resolution + LRU cache pattern. Algorithm parity audited via shared smoke test. |
| Mem0 client + `mem0Search` | `packages/memory/src/mem0.ts` + `stacked.ts:mem0ConfigFromEnv` | Read-only `mem0Search(query, userId)` for contradiction-check; **never** call `mem0Add` from this module (write-back stays in `stacked.ts:applyAfterTurn`). |
| Firestore `Firestore` type + `getFirestore` | `packages/firebase-admin/src/index.ts` | Persist advice tracker entries; same pattern as `downstream.ts` + `playbook-cache.ts` (caller injects `Firestore`, no module-level singleton). |
| Persona Firestore reader | `packages/agent-registry/src/personas.ts:getPersona` + `composePersonaPromptFromDoc` | S3 sync — when contradiction-check needs persona-set facts, read via `getPersona(db, "claire")` not inline string. |
| Phase 35 F4 graceful-degrade pattern | `f4-advice-repeat.ts` "skipped: no embed api key" branches | Identical fall-back semantics; never throws on missing API key / network error. |

### BGE-M3 graceful degrade (T1-T2)

- Missing `SILICONFLOW_API_KEY` / `PA_OPENAI_AGENT_API_KEY` / `PA_SILICONFLOW_API_KEY` → `trackAdvice` writes entry WITHOUT embedding (text only); `repeatScore` returns `{ maxSim: null, mostSimilar: null, sims: [] }` with `reason: "skipped: no embed api key"`. NEVER throws.
- Network error / non-200 → same skip behavior with `reason: "skipped: embed network error: <msg>"`. Logged to `console.log` (CFs forward).
- LRU cache (capacity 200) keyed on text → embedding, identical to F4 detector cache.

### Latency budget (CONTEXT §3 D-38-7)

- `recentAdvice(userId, n=3)` Firestore read: < 50ms p95 (warm path, indexed by ts desc)
- `repeatScore` (BGE-M3 batch embed of 1 reply + 3 history): < 150ms p95 (cache hit on warm path → < 5ms)
- `detectContradiction` (rule-based): < 5ms p95
- `runMemoryPolicy` total: < 200ms p95 — instrumented + asserted in smoke test

---

## 3. Decisions (P9-C calls — locked unless Adam vetos)

### D-38-1: Firestore schema = `pa-advice-tracker/{userId}/items/{turnId}`

```
pa-advice-tracker (collection)
  └── {userId} (doc — empty parent for subcollection root)
        └── items (subcollection)
              └── {turnId} (doc)
                    fields:
                      userId: string                  // denormalized for query
                      turnId: string                  // doc id
                      text: string                    // Claire reply (raw, post-rewriter)
                      lang: "zh" | "en" | "mixed"
                      embedding: number[] (1024 floats) | null  // null when API key absent
                      embeddedAt: ISO string | null
                      strategy: string | null         // FSM-inferred ESConv strategy (Phase 37); null pre-FSM-wire-in
                      uxState: string | null          // FSM ux state; null pre-FSM-wire-in
                      ts: ISO string                  // server timestamp
                      schemaVersion: 1
```

**Composite index** (Adam-owed P1 to verify in Firestore console): `items` collection group, ordered by `ts DESC`, where `userId == ?` (denormalized for query-without-parent). Without this, `recentAdvice` falls back to per-user subcollection scan (still works, just slower at scale).

**Retention:** unbounded in v1.4. v1.5 adds TTL. Single Claire reply ≈ 4kb (text + 1024 floats) — 50 turns × 1000 users = 200MB. Acceptable for v1.4 closed beta scale.

### D-38-2: Repeat threshold = 0.85 (matches Phase 35 F4 + v1.4 metric #5)

- v1.4 metric #5: "Repeat advice rate (BGE-M3 cos-sim > 0.85 vs last 3 Claire turns) < 5%."
- `repeatScore(reply, recent)` triggers `triggered: true` when `maxSim >= 0.85`. Same number as Phase 35 F4.
- **Tunable via `PA_MEMORY_REPEAT_THRESHOLD` env** (default 0.85).

### D-38-3: Contradiction detector = rule-based lexicon overlay (10 fixture types)

10 hand-crafted contradiction types cover the bilingual seed set:

| # | Type | zh example | en example |
|---|------|-----------|-----------|
| 1 | dietary (vegetarian/vegan/halal) | user "我吃素" + Claire "试试这家牛排" | user "I'm vegan" + Claire "try this steakhouse" |
| 2 | allergy (peanut/dairy/gluten) | user "我对花生过敏" + Claire "花生酱是个好选择" | user "I'm allergic to peanuts" + Claire "peanut butter is great" |
| 3 | pet preference (cat/dog) | user "我家养猫" + Claire "你家狗一定喜欢这个" | user "I have a cat" + Claire "your dog will love this" |
| 4 | location (city) | user "我在北京" + Claire "上海这家店超棒" | user "I'm in NYC" + Claire "great Seattle coffee shop" |
| 5 | relationship/family | user "我单身" + Claire "和你老婆商量一下" | user "I'm single" + Claire "ask your spouse" |
| 6 | profession | user "我是医生" + Claire "和你的程序员同事聊聊" | user "I'm a doctor" + Claire "your engineer colleagues" |
| 7 | preference (no/never) | user "我从不喝咖啡" + Claire "试试这家咖啡店" | user "I never drink coffee" + Claire "try this coffee shop" |
| 8 | health condition (diabetes/HTN) | user "我有糖尿病" + Claire "甜点放开吃" | user "I'm diabetic" + Claire "indulge in dessert" |
| 9 | language preference | user "我只说中文" + Claire reply majority en | user "English only" + Claire reply majority zh |
| 10 | persona-locked fact (S3 sync) | persona "Claire is vegetarian" + Claire "我推荐红烧肉" | persona "Claire prefers tea" + Claire "I'm a coffee snob" |

**Algorithm** (per type):
1. Fetch user-stated facts via `mem0Search(query, userId)` — query = first sentence of Claire reply (or empty for no-context case).
2. Tokenize each fact + reply via simple regex (zh chars + ascii words + punct).
3. For each contradiction type's lexicon (e.g. dietary: `{ veg_terms: [素, vegetarian, vegan], meat_terms: [牛排, steak, chicken, 鸡, 牛, 猪, 羊, beef, pork, mutton, 鱼, fish] }`), check fact for `veg_terms` ∩ AND reply for `meat_terms` ∩ → flag contradiction.
4. Type 9 (language) cross-checks lang detection from F3 detector pattern.
5. Type 10 (persona-locked) reads `pa-personas/{slug}` via `getPersona(db, slug)` if `deps.db` provided; default slug = `"claire"` (configurable via `MEMORY_POLICY_PERSONA_SLUG` env).

Returns `ContradictionResult = { violated: boolean, type: ContradictionType | null, violatedTerm: string | null, factSnippet: string | null, replySnippet: string | null, confidence: number }`.

### D-38-4: Prompt-inject format = bilingual NEVER-repeat directive

```
[MEMORY-POLICY]
already_given_advice (do NOT repeat or paraphrase):
  1. <recent[2]>      <- most recent first
  2. <recent[1]>
  3. <recent[0]>
note: 已经给过的建议 — 不要重复或换皮重说，给新角度。  (zh when userLang=zh)
note: Already-given advice — don't repeat or paraphrase; bring a fresh angle.  (en when userLang=en)
[/MEMORY-POLICY]
```

Empty when `recent.length === 0` → directive is empty string (caller skips appending). When `recent.length > 0` AND no embed available, items still listed (text-only repeat avoidance).

### D-38-5: Extractor pinning (D5) = Qwen-7B+ tier minimum

- `verifyExtractorPinned()` reads `process.env.MEM0_LLM_MODEL` (set in `apps/functions/src/index.ts:435` to `Qwen/Qwen2.5-72B-Instruct` default).
- Rejects empty + any model whose name contains: `1.5B`, `0.5B`, `0.6B`, `0.6b`, `0.5b`, `1.5b`, `mini`, `tiny`, `small`.
- Returns `{ pinned: boolean, model: string, warning: string | null }`. When NOT pinned, logs warning + still returns model (caller decides hard-fail vs soft-warn). v1.4 ship-gate is soft-warn (log + continue); v1.5 may hard-fail.
- **Tunable via `PA_MEMORY_EXTRACTOR_HARDFAIL=true`** to convert warn → throw at module-load.

### D-38-6: S3 sync = read pa-personas Firestore, NOT inline strings

- `contradiction-detector.ts` Type 10 (persona-locked fact) reads `await getPersona(db, slug)` (slug from env or default "claire").
- Test verifies: when mock Firestore returns persona `{ soul: "Claire is vegetarian and prefers tea" }`, contradiction detector flags Claire reply "I recommend the steak" as `{ violated: true, type: "persona_locked_dietary", violatedTerm: "steak" }`.
- When `deps.db` absent (test or wire-in caller chose to skip), Type 10 silently skipped (other 9 types still run).
- **No fallback to inline persona strings** — Phase 32 W3 made Firestore canonical; reading inline strings would re-create the divergence Phase 32 closed.

### D-38-7: Latency budget < 200ms total per turn

| Step | Budget |
|------|--------|
| `recentAdvice` Firestore read | < 50ms p95 (single subcollection-ordered query, n=3) |
| `repeatScore` BGE-M3 embed batch (1 reply + 3 history) | < 150ms p95 (cold), < 5ms (warm cache) |
| `detectContradiction` (incl. Mem0 search) | < 200ms p95 (Mem0 read = network) — **falls outside the 200ms turn budget if cold**; Phase 38 caches the user's facts in-process per session via `deps.factsCache` injection |
| `runMemoryPolicy` total | < 200ms p95 wall-clock ON warm path (cache + Mem0 hot); cold path documented as < 500ms acceptable for first turn |

If hot-path budget exceeded, fall-back: skip contradiction-check (rule-based degrades silently), keep advice-repeat. Smoke test asserts both paths.

### D-38-8: 50-turn synthetic repeat-rate gate < 5% (matches baseline-rev00056.md)

- `synthetic-repeat-rate.test.ts` mocks Claire emitting near-duplicate advice across 50 turns + runs each through `runMemoryPolicy`.
- Mock Claire = exact 10-turn pattern × 5 cycles from `synthetic-corpus.mjs:tile50` (re-imported via dynamic-import — same canonical source as Phase 34/35).
- Without policy: cos-sim repeat-rate ≈ 100% (by construction of synthetic).
- With policy + injection-respecting-mock-Claire: target < 5%. Since this test uses a mock that may NOT actually respect injection, the gate measures: **for each generated reply, would the policy have flagged this reply as repeat?** I.e. measure trigger rate of `repeatScore.triggered` over 50 turns under the policy. Inverted-gate semantics: trigger rate is the indicator of how often the rewriter SHOULD reject + retry. With diversity nudge wired (Adam-owed), trigger rate after 1 retry should drop < 5%. Phase 38 measures the **detector's ability to flag** (∼100% on synthetic), since the actual reduction depends on rewriter wire-in (Adam-owed P0).
- **Operational gate**: trigger rate measured WITHOUT diversity-nudge ≥ 90% (detector recall is high) — confirms the tracker would reject all the duplicates if wired. Adam's wire-in patch then provides the rewriter loop that reduces actual emit rate < 5%.
- Documented in test header + WIRE-IN-PATCH.

### D-38-9: Contradiction recall ≥ 9/10 on seeded fixtures

- `contradictions.test.ts` runs all 10 fixtures through `detectContradiction`.
- Per fixture: assert `result.violated === true` AND `result.type === expected_contradiction_type` AND `result.violatedTerm` ∈ `expected_violated_term` synonyms set.
- Gate: ≥ 9/10 fixtures pass. ≤ 1 false negative tolerated (allows for keyword bank evolution; Adam reviews any FN).
- False positives measured separately: 5 hand-crafted "no contradiction" fixtures must return `violated: false` for at least 4/5.

### D-38-10: Wire-in 100% deferred — patch spec is the contract

Same protocol as Phase 35/36/37. WIRE-IN-PATCH.md must include:

- Insertion point: BEFORE `callRewriter` (so injection appears in system prompt) + AFTER `cleaned` is computed (write `trackAdvice` post-gen)
- New optional `RewriteContext.userId?: string` + `RewriteContext.turnId?: string` + `RewriteContext.userFactsCache?: string[]` fields
- New optional `RewriteResult.memoryPolicyResult?: MemoryPolicyResult` telemetry
- Feature flag: `PA_MEMORY_POLICY_ENABLED` (default `false`; ramped via `PA_HUMANIZE_RUNTIME_ENABLED` umbrella in Phase 40)
- Anchor strings (not line numbers) — patch survives Adam's pending edits
- Adam-owed P0: apply patch after committing pending llm-rewriter.ts work + ensuring Phase 35-37 wire-ins land first
- Adam-owed P1: verify Firestore composite index `pa-advice-tracker` items ordered by ts DESC where userId == ?

---

## 4. Acceptance gates (Phase 38 done = all green)

- [ ] `pnpm --filter @pa/pa-orchestrator typecheck` clean
- [ ] `pnpm --filter @pa/memory typecheck` clean (if mem0 import surface touched — should not be)
- [ ] All memory-policy module tests pass via `node --import tsx --test packages/pa-orchestrator/src/voice/memory-policy/*.test.ts`
- [ ] Contradiction detector recall ≥ 9/10 on `__fixtures__/contradictions.json` (asserted in `contradiction-detector.test.ts`)
- [ ] 50-turn synthetic advice repeat-DETECTION rate ≥ 90% (gate per D-38-8: detector flags ≥ 45/50 of synthetic duplicates) — asserted in `synthetic-repeat-rate.test.ts`
- [ ] `runMemoryPolicy` p95 latency < 200ms over 50 invocations (warm path, mocked Mem0 + mocked embed) — asserted in `index.test.ts`
- [ ] Extractor pinning audit passes — `verifyExtractorPinned()` returns `{ pinned: true }` when `MEM0_LLM_MODEL=Qwen/Qwen2.5-72B-Instruct` (default in `apps/functions/src/index.ts:435`); rejects "Qwen/Qwen2.5-1.5B-Instruct"
- [ ] S3 sync verified: `contradictions.test.ts` Type 10 fixture passes with mock Firestore persona returning `{ soul: "Claire is vegetarian..." }`; same fixture without mock Firestore (no `deps.db`) silently skips Type 10 (other 9 still pass)
- [ ] Graceful-degrade verified: when no `BGE_API_KEY` / `PA_SILICONFLOW_API_KEY` set, `runMemoryPolicy` still returns a valid result with `repeatScore.maxSim === null` + `reason: "skipped: no embed api key"` and contradiction-check still runs
- [ ] `WIRE-IN-PATCH.md` written + reviewed for completeness (Adam-readable, no Q's)
- [ ] `STATE.md` Phase 38 row → ✅ partial (memory policy built, wire-in deferred), `completed_phases` 9 → 10
- [ ] SUMMARY in final P9-C report (no separate SUMMARY.md per P10 brief — inline only)

---

## 5. Hard constraints applied (P10 lockdown)

- TypeScript only ✅ (production code under `packages/pa-orchestrator/src/voice/memory-policy/`)
- BGE-M3 via SiliconFlow only ✅ (D14) — graceful degrade on missing key
- Mem0 extractor pinned to Qwen-7B+ tier ✅ (D5) via `extractor-config.ts` audit
- 0 net new LLM calls in production path ✅ (BGE-M3 = embedding tier free; Mem0 fact extract uses EXISTING Qwen call already issued by `stacked.ts:applyAfterTurn`)
- Latency: < 200ms per turn for advice query + contradiction-check ✅ (instrumented + asserted in smoke)
- S3 sync ✅ — reads `pa-personas/{slug}` Firestore (not inline strings); test verifies Type 10 fixture
- Graceful degrade on missing API key ✅ (skip embed-based axes, log warning)
- No new monorepo package (D8) ✅ — module under existing `pa-orchestrator/src/voice/`
- **Files NOT touched** (Adam uncommitted-work collision avoidance per P10 brief):
  - `apps/functions/src/admin-bootstrap.ts`
  - `packages/pa-orchestrator/package.json`
  - `packages/pa-orchestrator/src/downstream.ts` + `.test.ts`
  - `packages/pa-orchestrator/src/index.ts`
  - `packages/pa-orchestrator/src/voice/llm-rewriter.ts` + `.test.ts`
  - `packages/pa-orchestrator/src/eval-nl-judge.ts` + `.test.ts` (untracked)

---

## 6. Risks + mitigations

| Risk | Mitigation |
|------|------------|
| BGE-M3 cold-path latency spike causes turn-budget breach | LRU cache (200 entries, identical to Phase 35 F4); `recentAdvice` cap n=3 → at most 4-element batch embed; warm path < 5ms via cache. Smoke asserts p95 < 200ms total. Cold path documented as acceptable first-turn one-time cost. |
| Mem0 search returns stale facts that contradict new state | Read-only consumption; Mem0 itself manages fact updates via `mem0Add` (called by `stacked.ts` post-turn). Phase 38 surfaces what Mem0 has — staleness is Mem0's responsibility, not Phase 38's. |
| Rule-based contradiction detector keyword bank doesn't generalize | 10 fixtures cover most common types (dietary/allergy/pet/etc); recall ≥ 9/10 is the gate. ≤ 1 false negative tolerated. Adam reviews any FN in P1. |
| Persona-set facts diverge between inline string + Firestore | S3 sync test enforces Firestore-only read path. Inline strings in `admin-bootstrap.ts` are seed data (Phase 32 W3 cutover); `personas.ts:getPersona` is canonical. Test fails if accidentally falls back to inline. |
| Extractor pinning rejects legitimate config | `verifyExtractorPinned()` is soft-warn by default (log + continue). `PA_MEMORY_EXTRACTOR_HARDFAIL=true` opt-in for stricter env. v1.5 may flip default. |
| Firestore composite index missing → query fallback timeout | `recentAdvice` uses subcollection-only query (parent `pa-advice-tracker/{userId}/items` ordered by ts DESC); subcollection ordering doesn't need composite index. Adam-owed P1 verifies on real Firestore at wire-in time. |
| Wire-in patch spec drifts from Adam's pending llm-rewriter changes | WIRE-IN-PATCH.md uses anchor strings (not line numbers); section-by-section apply order; pseudo-code for switch; telemetry shape. Reviewed against current llm-rewriter.ts HEAD before commit. |
| 50-turn synthetic test depends on `synthetic-corpus.mjs` which is `.mjs` (cross-rootDir) | Test dynamic-imports `.mjs` from `.test.ts` (same pattern as Phase 35 smoke `smoke-baseline.test.ts`). No production import — only test-time. |
| Contradiction Type 10 (persona-locked) requires Firestore mock in test | Test injects mock `Firestore` via `deps.db` parameter (same DI pattern as `downstream.ts` tests). No real Firestore in test. |

---

## 7. Cross-stream sync

- **Phase 33** (helpers) — read-only consumption: `embed-sim.mjs` algorithm referenced in T1 BGE-M3 wrapper; no file collision.
- **Phase 34** (baseline) — read-only consumption: `synthetic-corpus.mjs` re-imported in 50-turn synthetic-repeat-rate test (dynamic-import from `.test.ts`); no file modification.
- **Phase 35** (detectors) — re-export `cosineSim` from `f4-advice-repeat.ts`. Phase 38 advice tracker = Firestore-persistent extension of Phase 35 F4's in-session window. F4 stays unchanged; Phase 38 layers on top via wire-in (in production, F4 + memory policy run in parallel with overlap on the embed cache LRU).
- **Phase 36** (injector) — independent post-gen pipeline. No interaction with memory policy.
- **Phase 37** (FSM) — Phase 38 advice tracker entry schema includes optional `strategy` + `uxState` fields; populated by wire-in caller from `FsmResult` (Phase 37 surface). Pre-FSM-wire-in, fields are null. No build-time dependency on Phase 37.
- **Phase 32 W3** (Personas Firestore CRUD) — S3 sync gate. `contradiction-detector.ts` Type 10 reads `getPersona(db, slug)` from `@pa/agent-registry/personas`. Test mock verifies persona-locked contradiction works against Firestore source-of-truth.
- **Phase 39** (External Auto Benchmarks) — memory policy is part of "Claire stack" measured against Qwen-72B raw. Phase 38 ships standalone module; Phase 39 wire-in benchmarks the full stack post-Adam-apply.
- **Phase 40** (Bible v7.5 + Ship) — `PA_HUMANIZE_RUNTIME_ENABLED` umbrella gates `PA_MEMORY_POLICY_ENABLED`. Memory policy ships behind kill switch first; ramps 1% → 10% → 50% → 100% per Phase 40 plan.

---

> [🟠 阿里味] **闭环意识**：CONTEXT 抓手清晰——5 module files + types + extractor pinning + 10 contradiction fixtures + 50-turn synthetic test + WIRE-IN-PATCH。下一步 PLAN.md 拆 4 个 atomic task，每个 commit 都给 Phase 39-40 quantitative gate 铺路。**因为信任所以简单**：Phase 33 embed-sim 给你了，Phase 35 F4 cosineSim 给你了，Mem0 给你了，Firestore persona 给你了。落地就行。证据说话。
