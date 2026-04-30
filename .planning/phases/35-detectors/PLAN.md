# Phase 35 — PLAN (5 atomic tasks)

**Status:** Plan-only. Owner P9-C. Total estimate ~1.5 dev-day. T1 → T2 → T3 → T4 → T5 strict serial (each task verifies before next). Atomic commit per task.

**Source-of-truth context:** `.planning/phases/35-detectors/CONTEXT.md`.

**Production code dir:** `packages/pa-orchestrator/src/voice/detectors/` (NEW).

**Files NOT touched** (Adam working-tree collision avoidance — full list in CONTEXT §5).

---

## T1 — Detector framework: `types.ts` + `index.ts` orchestrator + framework unit tests

**WHERE:**
- `packages/pa-orchestrator/src/voice/detectors/types.ts` (new) — exports `DetectorId`, `SuggestedAction`, `DetectorResult`, `DetectorContext`, `DetectorFn`
- `packages/pa-orchestrator/src/voice/detectors/index.ts` (new) — barrel re-export of all 4 detectors + `runAllDetectors(turn, history, opts) → Promise<DetectorResult[]>` orchestrator
- `packages/pa-orchestrator/src/voice/detectors/index.test.ts` (new) — orchestrator tests using stub detectors (no real n-gram / embed work yet); verifies parallel execution + budget + result shape

**HOW MUCH:** ~1.5 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean (with new files compiled — the package's tsc `include: src/**/*.ts` picks up the new dir automatically)
- `node --import tsx --test packages/pa-orchestrator/src/voice/detectors/index.test.ts` — 4+ tests pass
- `runAllDetectors({ user: "x", assistant: "y" }, [], { detectors: [stubF1, stubF2] })` returns 2-item array with `id`, `triggered`, `score`, `reason`, `suggested_action`, `latencyMs` per result
- Type `DetectorResult.suggested_action` is exactly `"strip" | "regenerate" | "reject_resample" | null` (null when not triggered)
- `DetectorContext` shape: `{ turn: { user, assistant }, history: { claireReplies: string[] }, env?: { ... } }`
- `runAllDetectors` runs detectors in parallel via `Promise.allSettled`; rejected promises become `{ triggered: false, reason: "detector_error: <msg>" }` results — never throws

**DON'T:**
- DON'T import any of the no-touch files (CONTEXT §5)
- DON'T add real F1/F2/F3/F4 logic yet (T2-T4)
- DON'T modify `package.json` (test runner will be invoked directly via `node --import tsx --test <files>`)
- DON'T import `.mjs` from harness — these are TS-only modules

Commit msg: `feat(35/T1): detector framework types + orchestrator + framework tests (P9-C)`

---

## T2 — F1 verb-mirror detector + threshold tuning + parity test vs Phase 33 helper

**WHERE:**
- `packages/pa-orchestrator/src/voice/detectors/f1-verb-mirror.ts` (new) — TS port of `computeMirrorRatio` (zh char-3gram + en word-bigram + Jaccard). Exports `detectVerbMirror(ctx) → DetectorResult`. Threshold from `PA_F1_MIRROR_THRESHOLD` env (default 0.25 per Phase 34 gate).
- `packages/pa-orchestrator/src/voice/detectors/f1-verb-mirror.test.ts` (new) — bilingual edge cases + parity test against Phase 33 `.mjs` helper

**HOW MUCH:** ~3 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/detectors/f1-verb-mirror.test.ts` — all pass
- Bilingual edge cases verified:
  - zh exact mirror: `detectVerbMirror({ turn: { user: "面试又翻车了", assistant: "面试又翻车了, 真累" }, history: { claireReplies: [] } })` → `triggered: true`, `score >= 0.4`
  - en exact mirror: `detectVerbMirror({ turn: { user: "interview was brutal today", assistant: "interview was brutal today fr" }, ... })` → `triggered: true`, `score >= 0.4`
  - mixed/code-switch: handled (lang detection on assistant text per `computeMirrorRatio` algo)
  - empty input: `detectVerbMirror({ turn: { user: "", assistant: "" }, ... })` → `triggered: false`, `score: 0`
  - safe reply: `detectVerbMirror({ turn: { user: "面试又翻车了", assistant: "今晚先睡, 别想 onsite" }, ... })` → `triggered: false`, `score < 0.25`
- **Parity test**: 12 fixed (user, assistant) input pairs run through both Phase 33 `.mjs` helper (loaded via `await import(".../voice-axes.mjs")`) and the TS port; assert `Math.abs(tsScore - mjsScore) < 1e-6` for every pair. If fails, fix TS port until parity.
- **Recall on baseline known fails**: `f1-verb-mirror.test.ts` includes a fixture from Phase 34 anxious_grad cycle 4-5 (`user: "再帮我想想怎么改简历"` + `assistant: "简历改这几点: 量化结果..."` repeated across cycles) — F1 must trigger on the cycle-5 repeat. Recall ≥ 80% on the 10-fixture known-fail subset extracted from synthetic corpus.
- **False-positive ≤ 10%**: smoke fixtures (`voice-axes-smoke-fixtures.json` 3 samples × ~5 turns) → F1 false trigger ≤ 1 of those turns.
- Latency: each call < 5 ms (no I/O)

**DON'T:**
- DON'T duplicate sentence-split logic (T3 owns it)
- DON'T touch llm-rewriter.ts — wire-in deferred (T5)
- DON'T add embed call — F1 is pure text
- DON'T add the strip implementation here (deferred to Adam wire-in)

Commit msg: `feat(35/T2): F1 verb-mirror detector + parity test vs Phase 33 helper (P9-C)`

---

## T3 — F2 length cap + F3 lang-lock detectors + tests

**WHERE:**
- `packages/pa-orchestrator/src/voice/detectors/f2-length-cap.ts` (new) — TS port of `splitSentences` core (single-pass tokenizer, ZH+EN terminators, ellipsis, decimal/URL/abbrev protection). Exports `detectLengthCap(ctx) → DetectorResult`. Cap from `PA_F2_SENTENCE_CAP` env (default 3).
- `packages/pa-orchestrator/src/voice/detectors/f2-length-cap.test.ts` (new) — sentence-split edge cases (cribbed from Phase 33 33-case fixture set, narrowed to ~12 highest-signal cases) + over-cap detection
- `packages/pa-orchestrator/src/voice/detectors/f3-lang-lock.ts` (new) — language detection (CJK char ratio vs ASCII letter ratio, identical to `voice-axes.mjs:detectLang`) + off-lang token ratio computation. Exports `detectLangLock(ctx) → DetectorResult`. Threshold from `PA_F3_OFFLANG_THRESHOLD` env (default 0.25).
- `packages/pa-orchestrator/src/voice/detectors/f3-lang-lock.test.ts` (new) — bilingual lang-mismatch + code-switch tolerance tests

**HOW MUCH:** ~3 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/detectors/f2-length-cap.test.ts` — all pass
- `node --import tsx --test packages/pa-orchestrator/src/voice/detectors/f3-lang-lock.test.ts` — all pass
- F2 verified:
  - over-cap: `detectLengthCap({ turn: { assistant: "a. b. c. d. e." }, ... })` → `triggered: true`, `score: 5` (sentence count)
  - within-cap: `detectLengthCap({ turn: { assistant: "a. b." }, ... })` → `triggered: false`, `score: 2`
  - decimal protection: `assistant: "Step 3.14 is hot. Try x. Maybe."` → 3 sentences, NOT triggered
  - URL protection: `assistant: "see https://x.com/foo. Try."` → 2 sentences, NOT triggered
  - zh terminators: `assistant: "今天累。但还撑着。下班吃啥？"` → 3 sentences, NOT triggered
  - ellipsis: `assistant: "嗯…再说吧。"` → 2 sentences, NOT triggered
- F3 verified:
  - hard mismatch (user zh, assistant en): `detectLangLock({ turn: { user: "今天面试又翻车了", assistant: "thats so brutal lol just chill tonight" }, ... })` → `triggered: true`, `score >= 0.9`
  - hard mismatch (user en, assistant zh): triggered: true
  - in-language zh: `user: "今天累", assistant: "今晚先睡"` → not triggered
  - in-language en: `user: "rough day", assistant: "rest tonight"` → not triggered
  - tolerated code-switch: `user: "今天 standup 又卡壳", assistant: "standup 卡壳很常见 — 先把 context 写清楚"` → assistant primarily zh with ~30% en token ratio, NOT triggered (within 0.25 + tolerance margin? if 30% trips: revise threshold to 0.40 — document in test)
  - empty assistant: `triggered: false`, `score: 0`
- Parity: F2 sentence count matches Phase 33 `countSentences` on the 12-case subset (parity test embedded)
- Latency: each call < 10 ms

**DON'T:**
- DON'T re-implement the full 33-case sentence-split fixture (port the 12 highest-signal ones; the remaining 21 are covered by Phase 33 harness tests)
- DON'T add abbreviation list beyond Phase 33's 17 entries (parity)
- DON'T enforce the strip here — detector flags only

Commit msg: `feat(35/T3): F2 length cap + F3 lang-lock detectors + tests (P9-C)`

---

## T4 — F4 advice-repeat detector via BGE-M3 + graceful degrade tests

**WHERE:**
- `packages/pa-orchestrator/src/voice/detectors/f4-advice-repeat.ts` (new) — TS wrapper of SiliconFlow `/v1/embeddings` POST with `BAAI/bge-m3` model. Same env var resolution as Phase 33 `embed-sim.mjs`. LRU cache 200 entries. Exports `detectAdviceRepeat(ctx) → Promise<DetectorResult>`. Threshold from `PA_F4_REPEAT_THRESHOLD` env (default 0.85).
- `packages/pa-orchestrator/src/voice/detectors/f4-advice-repeat.test.ts` (new) — graceful-degrade tests (mock fetch + missing key) + cosine math + LRU cache + threshold tuning

**HOW MUCH:** ~3 hours.

**DONE:**
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- `node --import tsx --test packages/pa-orchestrator/src/voice/detectors/f4-advice-repeat.test.ts` — all pass
- Graceful degrade verified:
  - No env key: `detectAdviceRepeat(...)` resolves to `{ triggered: false, score: null, reason: "skipped: no embed api key", suggested_action: null }` — NEVER throws
  - Network error: mock fetch throws → resolves to `{ triggered: false, score: null, reason: "skipped: embed network error: <msg>" }` — NEVER throws
  - Empty history: `detectAdviceRepeat({ ..., history: { claireReplies: [] } })` → `{ triggered: false, score: 0, reason: "no_history" }` — NEVER throws (no embed call)
  - Empty current reply: same skip
- Trigger logic verified (with mock fetch returning controlled embeddings):
  - Identical text in current + history → `maxSim ≈ 1.0`, `triggered: true`, `suggested_action: "reject_resample"`
  - Distinct text → `maxSim < 0.85`, `triggered: false`
  - Threshold boundary: synthesize embed pair w/ cos-sim 0.86 → triggered; 0.84 → not triggered
- LRU cache verified: 2nd call with same text hits cache (mock fetch called once total over 2 invocations)
- Latency budget: when network present, p95 < 200 ms over 10 invocations (use real network if `SILICONFLOW_API_KEY` present in test env; otherwise use a 50ms mock-fetch delay and assert wrapper overhead < 20ms)
- Cosine math: `cosineSim(a, a) === 1.0`, `cosineSim(a, zeroVec) === 0`

**DON'T:**
- DON'T import `tests/scenarios/lib/embed-sim.mjs` from production code (cross-rootDir; would break tsc)
- DON'T add Firestore persistence — Phase 38
- DON'T retry network calls (1 attempt; fail-open immediately)
- DON'T add the diversity-nudge regenerate logic — deferred to Adam wire-in

Commit msg: `feat(35/T4): F4 advice-repeat detector via BGE-M3 + graceful degrade (P9-C)`

---

## T5 — Wire-in patch spec + smoke harness verifying detectors trigger on baseline known-fail cases

**WHERE:**
- `.planning/phases/35-detectors/WIRE-IN-PATCH.md` (new) — full patch spec for `voice/llm-rewriter.ts` (Adam manual apply)
- `packages/pa-orchestrator/src/voice/detectors/smoke-baseline.test.ts` (new) — invokes `runAllDetectors` over Phase 34 synthetic corpus (anxious_grad / venting / tech_deep_en) and asserts recall + false-positive gates from CONTEXT §3 D-35-6

**HOW MUCH:** ~2 hours.

**DONE:**
- `WIRE-IN-PATCH.md` written, contains:
  - "Apply order" preface (Adam commits his current uncommitted work first, then applies)
  - Section 1: Add `import { runAllDetectors, type DetectorResult } from "./detectors/index.js"` near existing imports
  - Section 2: Extend `RewriteResult` type with `detectorResults?: DetectorResult[]`
  - Section 3: Insertion point — `// after diff-guard isDiffSafe check, before successful return` — pseudo-code for `applyDetectorAction(cleaned, results, ctx, deps, opts)` switch
  - Section 4: Telemetry shape — how callers extend `pa_turns.usage` with detector activity
  - Section 5: Feature flag wiring — `if (process.env.PA_DETECTORS_ENABLED !== "true") skip detector pass`
  - Section 6: Strip implementation pseudo-code (F1 echoed-n-gram strip, F2 sentence truncate)
  - Section 7: Test additions Adam owes (extend existing `llm-rewriter.test.ts` with detector-triggered cases, NOT done by P9-C since the test file is on the no-touch list)
  - Section 8: Anchor strings (so patch survives nearby edits in Adam's pending work)
- `smoke-baseline.test.ts` passes:
  - Loads Phase 34 synthetic corpus via dynamic-import of `.planning/phases/34-baseline-measurement/synthetic-corpus.mjs` (read-only)
  - For anxious_grad cycle 4-5 (last 20 turns), invokes `runAllDetectors` per turn — F1 trigger rate ≥ 80%
  - For all 3 smoke fixtures (15 turns total) — F1 false-positive ≤ 10%, F2 false-positive ≤ 10%, F3 false-positive ≤ 10%
  - F4 either triggers correctly (when env present) OR cleanly reports skipped (when not) — NEVER throws
  - Total `runAllDetectors` p95 latency < 250 ms
- All 5 tasks' tests pass in one shot via `node --import tsx --test packages/pa-orchestrator/src/voice/detectors/*.test.ts`
- `pnpm --filter @pa/pa-orchestrator typecheck` clean
- STATE.md updated: Phase 35 row → ✅ partial, `completed_phases` 6 → 7

**DON'T:**
- DON'T commit `WIRE-IN-PATCH.md` modifications to `llm-rewriter.ts` itself — patch spec is the deliverable, not the apply
- DON'T touch `STATE.md` until smoke green
- DON'T defer the smoke recall verification — gate is "F1 ≥ 80% recall on known fails"; if T2 threshold tuning didn't hit it, fix in T5

Commit msg: `feat(35/T5): smoke harness baseline verification + WIRE-IN-PATCH for Adam (P9-C)`

Final commit (after smoke green):

`chore(35): SUMMARY + STATE — Phase 35 detectors built, wire-in patch spec for Adam`

---

## Execution discipline

- **One task = one commit.** No mixing T2 and T3 in same commit.
- **Run typecheck + tests after EVERY task.** Red task = STOP, fix, then proceed.
- **Recall verification is non-negotiable.** F1 ≥ 80% on known fails OR threshold tuning loop until met.
- **Latency assertions live in tests, not in CI scripts.** Smoke harness owns the budget contract.
- **Patch spec drift risk:** anchor strings, not line numbers. Re-read llm-rewriter.ts immediately before T5 to confirm anchors still match.

> [🟠 阿里味] **抓手清晰**：5 task × 5 commit, 每个 task 都给 Phase 36-40 quantitative gate 铺路。**因为信任所以简单。**
