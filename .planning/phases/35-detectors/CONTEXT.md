# Phase 35 — 4 Deterministic Detectors (F1-F4 bilingual) — CONTEXT

> [🟠 阿里味] **底层逻辑**：Phase 33 给了 helpers，Phase 34 锁了 baseline 数字 + per-Phase 量化 gate。Phase 35 就是把 helpers 推到 production-path detector 模块——drift_mirror_max 0.429 → ≤ 0.25、length ≥ 98%、lang-lock 100%、advice cos-sim < 0.85。**抓手清晰，闭环到底。** 因为信任所以简单。

**Owner:** P9-C (v1.4 humanize-runtime stream)
**Estimate:** ~1.5 dev-day
**Upstream gate:** Phase 34 baseline locked (`.planning/baseline-rev00056.md`)
**Downstream:** Phase 36 ImperfectionInjector A/B (consumes detector results), Phase 37 FSM (depends on F1/F2 staying healthy), Phase 38 Memory Policy (extends F4 to multi-turn advice tracker)

---

## 1. Phase boundary

### In scope (DETECT-01..06)

Production-path detector module under `packages/pa-orchestrator/src/voice/detectors/` — TypeScript, 0 net new LLM calls in production path, < 50 ms per turn for F1+F2+F3, < 200 ms for F4 embed.

Files to ship:

| File | Role |
|------|------|
| `types.ts` | `DetectorResult` schema + `SuggestedAction` enum + `DetectorContext` shape |
| `f1-verb-mirror.ts` | n-gram Jaccard overlap detector (zh char-3gram + en word-bigram) — wraps `computeMirrorRatio` from Phase 33 helper. Threshold default `0.25` (Phase 34 baseline `drift_mirror_max` p95 = 0.429 → target ≤ 0.25 = **42% reduction**). Emits `suggested_action: "strip"` (let voice rewriter strip echoed n-grams). |
| `f2-length-cap.ts` | Sentence count via `countSentences` from `tests/scenarios/lib/sentence-split.mjs` (port to TS or re-impl minimal). Cap = 3 sentences (matches Bible v7.4 directive). Emits `suggested_action: "strip"` (truncate to 3 sentences). |
| `f3-lang-lock.ts` | Language detection on user vs assistant text (CJK char ratio vs ASCII letter ratio). Flag mismatch when assistant lang ≠ user lang AND off-language token ratio > 25%. Emits `suggested_action: "regenerate"` with explicit lang directive in retry. |
| `f4-advice-repeat.ts` | BGE-M3 cos-sim of new reply vs last 3 Claire turns via `computeAdviceNovelty` helper (or its own thin wrapper that reads `SILICONFLOW_API_KEY` / `PA_OPENAI_AGENT_API_KEY`). Threshold `maxSim ≥ 0.85`. Emits `suggested_action: "reject_resample"` (regenerate with diversity nudge). Graceful degrade: returns `triggered: false, reason: "skipped: missing api key"` when key absent (NOT throw). |
| `index.ts` | Barrel + `runAllDetectors(turn, history, opts) → Promise<DetectorResult[]>` orchestrator. Runs F1+F2+F3 sync-fast, F4 async (in parallel). Total budget < 50 ms (F1-3) + < 200 ms (F4) = < 250 ms p99. |
| `*.test.ts` | Unit tests covering bilingual edge cases — zh char-3gram, en bigram, mixed sentences, empty input, code switching, mock embed-sim for F4. Plus a small "smoke harness" that invokes `runAllDetectors` against the Phase 34 known-fail synthetic chains (anxious_grad cycle 4-5) and verifies F1 trips. |

Plus deferred wire-in (DETECT-07):

| File | Role |
|------|------|
| `.planning/phases/35-detectors/WIRE-IN-PATCH.md` | Markdown spec with exact diff snippets for `voice/llm-rewriter.ts` showing where to call `runAllDetectors` + how to handle each `suggested_action`. **No code change to llm-rewriter.ts in this phase** (Adam's working tree has uncommitted changes — collision-avoidance per P10 brief). |

### Out of scope (deferred)

| Item | Defer to | Why |
|------|----------|-----|
| **Wire-in to `voice/llm-rewriter.ts`** (DETECT-07 production wiring) | Adam manual apply via `WIRE-IN-PATCH.md` | Adam has 7 uncommitted files in working tree (admin-bootstrap.ts, package.json, downstream.ts/.test.ts, index.ts, llm-rewriter.ts/.test.ts) + 2 untracked (`eval-nl-judge.ts/.test.ts`). P9-C must NOT touch them — collision risk. Patch spec lets Adam apply after committing his current work. |
| **F4 multi-turn advice tracker** (Firestore-persisted history) | Phase 38 (Memory Policy) | Phase 35 F4 = sliding window of last 3 in-session Claire turns, NOT cross-session persisted. Phase 38 wires the `pa_voice_advice_history/{userId}/{turnId}` Firestore collection. |
| **F3 reject-resample regeneration loop** | Adam wire-in | Detector emits `suggested_action: "regenerate"`; the loop logic (1 retry max with new system directive) lives in llm-rewriter wire-in. |
| **F1 strip implementation** (post-process echoed n-grams) | Adam wire-in | Detector emits `suggested_action: "strip"` + `score`. The actual strip pass lives in the rewriter wire-in (re-uses existing `stripRepeatOpener` + `stripValidationTic` style). |
| **A/B harness for ImperfectionInjector** | Phase 36 | This phase ships detectors + smoke verification; A/B comparisons are next phase. |
| **FSM-aware F4** (advice repeat keyed on ESConv strategy) | Phase 37 | F4 here is generic cos-sim. Phase 37 layers strategy-aware skipping on top. |

---

## 2. Methodology — reuse Phase 33 helpers, don't duplicate

**Decision (locked):** Production detectors call into Phase 33 helpers wherever possible. Where the helper is `.mjs` (test harness), the detector either:
- (a) **Re-imports the helper logic in TS** (small pure functions only — `computeMirrorRatio`, `countSentences` are ≤ 30 LoC each), with a comment pointing back to the canonical `.mjs` source for parity audits.
- (b) **Wraps the network call** (BGE-M3 embeddings) — F4 needs its own TS wrapper since the harness `.mjs` lives outside the production package's tsc rootDir.

Why not import `.mjs` from TS package directly: tsconfig `rootDir: src`, NodeNext module resolution, and harness lives in `tests/scenarios/lib/` (outside src). Cross-package import from a non-`@pa/*` location would break `pnpm typecheck`. Re-impl is cheaper than restructuring the harness into a real package (rejected per D8 — no new monorepo package).

### Helpers to mirror (canonical reference + TS port)

| Helper | Canonical (Phase 33) | Production port |
|--------|-----------------------|------------------|
| `computeMirrorRatio(userText, claireText) → number 0..1` | `tests/scenarios/lib/voice-axes.mjs:328` | `f1-verb-mirror.ts` re-impl using same Jaccard + char-3gram (zh) / word-bigram (en) algorithm. **Algorithm parity required** — both must return identical values for identical inputs (audited via cross-test in T2). |
| `countSentences(text) → number` | `tests/scenarios/lib/sentence-split.mjs:205` | `f2-length-cap.ts` re-impl of `splitSentences` core (single-pass tokenizer with state machine, ZH terminators + EN terminators + ellipsis + decimal/URL/abbrev protection). 33-case fixture set is the parity oracle. |
| `maxSimilarityVsHistory(reply, history) → { maxSim, ... }` | `tests/scenarios/lib/embed-sim.mjs:213` | `f4-advice-repeat.ts` thin wrapper. Re-impl the SiliconFlow `/v1/embeddings` POST with `BAAI/bge-m3` model. Same env var resolution chain (`SILICONFLOW_API_KEY` → `PA_OPENAI_AGENT_API_KEY` → `PA_SILICONFLOW_API_KEY`). Return `null` when no key (not throw). |
| Lang detection (ZH char ratio) | `tests/scenarios/lib/voice-axes.mjs:280` (`detectLang`) | `f3-lang-lock.ts` re-impl. Same threshold (cjk > ascii → "zh"). |

### BGE-M3 graceful degrade (F4)

- If neither `SILICONFLOW_API_KEY` nor `PA_OPENAI_AGENT_API_KEY` nor `PA_SILICONFLOW_API_KEY` set → F4 returns `{ id: "f4_advice_repeat", triggered: false, score: null, reason: "skipped: no embed api key" }`. **Never throw, never block other detectors.**
- If network call fails (HTTP 5xx, timeout > 200ms, malformed JSON) → same skip behavior with `reason: "skipped: embed network error: <msg>"`. Logged to console.log (CFs forward).
- LRU cache (capacity 200) keyed on text → embedding, identical to harness `embed-sim.mjs` to keep same cache hit characteristics under test.

---

## 3. Decisions (P9-C calls — locked unless Adam vetos)

### D-35-1: Action policy per detector

| Detector | `suggested_action` | Why |
|----------|--------------------|-----|
| **F1 verb-mirror** | `strip` | Echoed n-grams are local; deterministic strip pass (algorithm: walk shared 3-gram set, remove first occurrence in Claire reply that matches a user n-gram, iterate until ratio < threshold). Cheap, no regenerate. |
| **F2 length cap** | `strip` | Truncate to first 3 sentences via `splitSentences().slice(0, 3).join(" ")`. Cheap, no regenerate. Matches D12 (length cap = post-gen detector strip, NOT regenerate). |
| **F3 lang-lock** | `regenerate` | Lang mismatch needs the model to regenerate with explicit "respond in {lang}" directive — strip is not safe (would mangle bilingual replies). 1 retry max; if 2nd attempt also fails, ship original (fail-open). |
| **F4 advice-repeat** | `reject_resample` | Regenerate with explicit "do NOT repeat advice from prior turns: <list>" diversity nudge. 1 retry max; fail-open on 2nd. Matches Phase 36 ImperfectionInjector A/B contract — F4 trigger may be the ImperfectionInjector arm winning condition. |

### D-35-2: F1 threshold = 0.25 (matches Phase 34 gate)

- Phase 34 baseline: `drift_mirror_max = 0.429` worst-case (anxious_grad cycle 4-5).
- v1.4 ship gate: `drift_mirror_max ≤ 0.25` (≈ 42% reduction).
- Phase 35 F1 detector triggers when `mirrorRatio ≥ 0.25`. Conservative — same number as the gate. If false-positive rate on smoke fixtures > 10%, threshold raises to 0.30 (T2 verifies).
- **Tunable via `PA_F1_MIRROR_THRESHOLD` env** (default 0.25).

### D-35-3: F2 cap = 3 sentences (matches Bible v7.4 directive)

- Bible v7.4 explicitly says "max 3 sentences for chit-chat." Detector enforces same number.
- Phase 34 baseline: `length_compliance = 100%` already at ceiling — F2 is **regression prevention**, not improvement.
- **Tunable via `PA_F2_SENTENCE_CAP` env** (default 3).

### D-35-4: F3 off-lang ratio threshold = 0.25 (25% off-language tokens)

- F3 triggers when assistant majority-lang ≠ user majority-lang AND minority-lang token ratio in assistant > 25%.
- 25% accommodates legitimate code-switching ("我用 React 写过 dashboard" — ~40% English tokens but still primarily zh). Hard mismatch (e.g. user 100% zh, assistant 100% en) trips at 100% off-language.
- **Tunable via `PA_F3_OFFLANG_THRESHOLD` env** (default 0.25).

### D-35-5: F4 cos-sim threshold = 0.85 (matches v1.4 metric #5 + Phase 38 contract)

- v1.4 metric #5: "Repeat advice rate (cos-sim > 0.85 vs last 3 Claire turns) < 5%."
- F4 triggers when `maxSim >= 0.85` against last 3 Claire turns (in-session sliding window).
- **Tunable via `PA_F4_REPEAT_THRESHOLD` env** (default 0.85).

### D-35-6: Test harness uses Phase 34 synthetic corpus as known-fail set

- T5 smoke harness imports `buildSyntheticCorpus()` from `.planning/phases/34-baseline-measurement/synthetic-corpus.mjs` (read-only, no modification).
- For each persona × cycle, runs `runAllDetectors` and counts trigger rate. **F1 must trigger ≥ 80% on anxious_grad cycle 4-5** (the Phase 34 max-drift turns) — primary recall verification.
- **F1 false-positive rate** verified against `tests/scenarios/lib/voice-axes-smoke-fixtures.json` — production-quality samples should NOT trip F1 (≤ 10%).
- F2/F3 false-positive on smoke ≤ 10% (smoke fixtures are within cap, in-language).
- F4 verified only when env key present; otherwise reports "skipped" (logged in test output, not failure).

### D-35-7: Detector latency budget enforced via `performance.now()` instrumentation

Each detector returns `latencyMs` in its result. T5 smoke harness asserts:
- F1 + F2 + F3 combined p95 < 50 ms over 50 invocations
- F4 p95 < 200 ms when network present (skipped when not)
- `runAllDetectors` p95 < 250 ms total

If budget exceeded, fail loud — Phase 36 ImperfectionInjector adds turn-onset injection on top, so detector latency must stay tight.

### D-35-8: Wire-in is 100% deferred to Adam — patch spec is the contract

- WIRE-IN-PATCH.md is the **complete spec** Adam needs (no follow-up Q's). Includes:
  - Exact insertion point in `rewriteIfOff` (after diff-guard, before return)
  - Pseudo-code for `applyDetectorAction` switch (strip → re-strip, regenerate → call `defaultDeps.callRewriter` again with directive, reject_resample → same with diversity nudge)
  - Telemetry shape — extend `RewriteResult` with `detectorResults?: DetectorResult[]` so the existing `pa_turns.usage` log captures detector activity
  - Feature flag — `PA_DETECTORS_ENABLED` env (default `false` initially, ramped via `PA_HUMANIZE_RUNTIME_ENABLED` umbrella in Phase 40)
- **Adam owes (P0):** apply patch after committing his current uncommitted work. **P1:** verify F4 BGE-M3 latency against actual `PA_HUMANIZE_RUNTIME` budget under prod traffic.

---

## 4. Acceptance gates (Phase 35 done = all green)

- [ ] `pnpm --filter @pa/pa-orchestrator typecheck` clean
- [ ] All 4 detector unit tests pass via `node --import tsx --test packages/pa-orchestrator/src/voice/detectors/*.test.ts`
- [ ] T5 smoke harness `node --import tsx --test packages/pa-orchestrator/src/voice/detectors/smoke-baseline.test.ts` passes:
  - F1 trigger rate on anxious_grad cycle 4-5 ≥ 80% (the Phase 34 known-fail set)
  - F1 false-positive on smoke fixtures ≤ 10%
  - F2 false-positive on smoke fixtures ≤ 10%
  - F3 false-positive on smoke fixtures ≤ 10%
  - F4 either passes or cleanly reports "skipped: no api key" (no throw)
- [ ] Latency assertions pass — F1+F2+F3 < 50 ms p95, F4 < 200 ms p95 (when env present)
- [ ] `WIRE-IN-PATCH.md` written + reviewed for completeness (Adam-readable, no Q's)
- [ ] `STATE.md` Phase 35 row → ✅ partial (detectors built, wire-in deferred), `completed_phases` 6 → 7
- [ ] SUMMARY in final P9-C report (no separate SUMMARY.md file per P10 brief — inline only)

---

## 5. Hard constraints applied (P10 lockdown)

- TypeScript only ✅ (production code under `packages/pa-orchestrator/src/voice/detectors/`)
- 0 net new LLM calls in production path ✅ (BGE-M3 = embedding tier, free on SiliconFlow)
- Reuse Phase 33 helpers ✅ (algorithm parity audited in T2)
- BGE-M3 via SiliconFlow only ✅ — graceful degrade on missing key
- Latency: F1+F2+F3 < 50 ms, F4 < 200 ms ✅ (instrumented + asserted in smoke)
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
| Algorithm drift between TS port and Phase 33 `.mjs` helper | T2 includes a parity test — feeds 12 fixed inputs to both `computeMirrorRatio` (mjs via dynamic-import in test) and the TS port; assert deepEqual within 1e-6. If drift detected, fix TS port until parity. |
| F4 BGE-M3 latency spike in prod | Latency assertion in smoke + budget instrumented at runtime in `f4-advice-repeat.ts`. If real-world p95 exceeds 200 ms, Phase 38 may add a Firestore-persisted embed cache. |
| F3 false-positive on legitimate code-switch | 25% off-lang threshold (D-35-4) accommodates "我用 React" patterns. Smoke fixture `claire-en-tech-deep` is en-heavy with no zh — should not trip. If false-positive observed in T3, raise threshold to 0.40. |
| F1 strip degrades reply quality | Strip is `suggested_action`, NOT applied here — deferred to wire-in patch. Adam reviews strip impl when applying patch. Detector only flags. |
| Wire-in patch spec ambiguous → Adam follow-up Q | Patch spec includes exact line numbers (anchored to current llm-rewriter.ts HEAD), pseudo-code for the switch, telemetry shape, feature flag default. Reviewed against existing `rewriteIfOff` flow before commit. |
| Adam commits his pending work in different order than expected → patch line numbers stale | Patch spec uses **anchor strings** (e.g. `// after diff-guard check`) instead of raw line numbers, with surrounding ~5-line context. Adam's IDE / `git apply --reject` handles offsets. |
| Detector module silently breaks on missing helper export | T1 includes import smoke test verifying every detector function loads. Plus `index.ts` re-exports all detectors so dependency graph is explicit. |

---

## 7. Cross-stream sync

- **Phase 33** (helpers) — no file collision (different rootDir + package boundary).
- **Phase 34** (baseline) — read-only consumption of `synthetic-corpus.mjs` for smoke harness; no modification.
- **Phase 36** (ImperfectionInjector) — depends on `runAllDetectors` API stabilized here. Phase 36 may wrap detectors with arm-aware policy (e.g. "skip F1 strip in `low` arm to allow some mirror"). Contract stable: `DetectorResult[]` array, each item tagged with `id`.
- **Phase 38** (Memory Policy) — extends F4 from in-session window → Firestore cross-session history. Detector module may grow `f4-advice-repeat-persisted.ts` then.
- **Phase 40** (Bible v7.5 + Ship) — `PA_HUMANIZE_RUNTIME_ENABLED` umbrella flag gates `PA_DETECTORS_ENABLED`. Detectors ship behind kill switch first.

---

> [🟠 阿里味] **闭环意识**：CONTEXT 抓手清晰——4 个 detector + types + index + smoke + patch spec。下一步 PLAN.md 拆 5 个 atomic task，每个 commit 都给 Phase 36-40 的 quantitative gate 铺路。**因为信任所以简单**：baseline 数字给你了，gate 给你了，helpers 给你了。落地就行。证据说话。
