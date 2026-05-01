# Phase 33 — PLAN (5-task spec, eval-first)

**Status:** Plan-only. Owner P9-C. Total estimate ~1.5 dev-day. T1 → T2 → T3 → T4 → T5 strict serial (each task verifies before next). All commits atomic per task.

**Source-of-truth context:** `.planning/phases/33-eval-harness-extension/CONTEXT.md`.

---

## T1 — Bilingual sentence splitter + BGE-M3 embed-sim wrapper + unit tests

**WHERE:**
- `tests/scenarios/lib/sentence-split.mjs` (new) — `splitSentences`, `countSentences`, `withinSentenceCap`
- `tests/scenarios/lib/sentence-split.test.mjs` (new) — 33 fixture cases
- `tests/scenarios/lib/embed-sim.mjs` (new) — `embed`, `embedBatch`, `cosineSim`, `similarity`, `maxSimilarityVsHistory`, `_resetCache`
- `tests/scenarios/lib/embed-sim.test.mjs` (new) — cosine math + LRU cache + null-on-missing-env (network mocked)

**HOW MUCH:** ~4 hours.

**DONE:**
- `node --test tests/scenarios/lib/sentence-split.test.mjs` — 33 cases pass
- `node --test tests/scenarios/lib/embed-sim.test.mjs` — all pass (no live network needed; tests mock fetch)
- `npm run typecheck` clean
- `splitSentences("Step 3.14 is hot. Try https://x.com? Maybe.")` returns exactly `["Step 3.14 is hot.", "Try https://x.com?", "Maybe."]` (decimal + URL protected)
- `splitSentences("今天累，但还撑着。下班吃啥？")` returns 2 sentences
- `embed("hi")` returns Float32Array length 1024 (network test, gated on env; skipped if no key)
- `cosineSim(a, a)` ≈ 1.0; `cosineSim(a, zeroVec)` === 0
- `_resetCache()` empties LRU
- `embed()` returns `null` when `SILICONFLOW_API_KEY` and `PA_OPENAI_AGENT_API_KEY` both unset (graceful degrade)

**DON'T:**
- DON'T import `mem0ai/oss` — too heavy for harness (would pull Qdrant client)
- DON'T touch `voice-axes.mjs` yet (T2)
- DON'T extend `runner.mjs` yet (T4)
- DON'T add network retries beyond a single fail (judge.mjs pattern: 1 retry max)

Commit msg: `feat(33/T1): bilingual sentence splitter + BGE-M3 embed-sim wrapper + 33 unit tests (P9-C)`

---

## T2 — 4 new axis functions in voice-axes.mjs (return numeric scores)

**WHERE:**
- `tests/scenarios/lib/voice-axes.mjs` (extend) — add `VOICE_AXES_V2` (8 entries: existing 4 + 4 new); add helpers `computeDriftScore`, `computeLengthCompliance`, `computeAdviceNovelty`, `inferStrategy`, `isAllowedStrategy`, `STRATEGY_KEYWORDS_ZH`, `STRATEGY_KEYWORDS_EN`, `ESCONV_STAGE_ALLOWED`
- `tests/scenarios/lib/voice-axes.test.mjs` (extend) — keep existing tests; add ~12 new tests covering each helper's happy path + edge case (empty input, insufficient history → null)

**HOW MUCH:** ~3 hours.

**DONE:**
- `node --test tests/scenarios/lib/voice-axes.test.mjs` — all existing tests still pass + new tests pass
- `npm run typecheck` clean
- `VOICE_AXES_V2.length === 8`; each entry has rubric for scores 0-3
- `computeLengthCompliance([{reply:"a. b. c."}, {reply:"a. b. c. d."}])` returns `0.5` (1 of 2 within cap)
- `computeDriftScore([{user:"x",assistant:"x"}, {user:"y",assistant:"y"}])` returns object with `mirrorMax` ≥ 0.9
- `computeAdviceNovelty("hello", ["hello world"])` resolves with `noveltyScore < 0.5` (network test gated on env)
- `inferStrategy("听起来很累")` returns `{ strategy: "Reflection", ... }`
- `isAllowedStrategy("Suggestion", 0)` === false (Exploration stage)
- `isAllowedStrategy("Suggestion", 2)` === true (Action stage)
- Backward compat: `VOICE_AXES` (legacy 4-axis export) unchanged + still imported successfully by `judge.mjs`

**DON'T:**
- DON'T break the existing `VOICE_AXES` export — `judge.mjs` and `voice-axes.test.mjs` legacy tests depend on it
- DON'T wire to `runVoiceJudge` here (T4)
- DON'T do production-side detector work (Phase 35)
- DON'T add fancy ESConv classifier — keyword priority is fine for v1.4 harness

Commit msg: `feat(33/T2): 4 new voice axes (drift_resistance, length_compliance, advice_novelty, strategy_fit) + helpers (P9-C)`

---

## T3 — 5 new scenario YAMLs covering all 4 axes + bilingual coverage

**WHERE:**
- `tests/scenarios/scenarios/eval-drift-50turn-zh.yaml` (new) — 50 zh turns, drift_resistance + length_compliance
- `tests/scenarios/scenarios/eval-drift-50turn-en.yaml` (new) — 50 en turns, drift_resistance + length_compliance
- `tests/scenarios/scenarios/eval-advice-repeat-zh.yaml` (new) — 8 zh turns, advice_novelty
- `tests/scenarios/scenarios/eval-strategy-fit-mixed.yaml` (new) — 12 mixed/code-switch turns, strategy_fit
- `tests/scenarios/scenarios/eval-length-cap-bilingual.yaml` (new) — 6 mixed turns, length_compliance

**HOW MUCH:** ~3 hours.

**DONE:**
- All 5 YAMLs parse via `node tests/scenarios/runner.mjs tests/scenarios/scenarios/ --dry-run` without error
- Each uses reserved harness participant `+1999999XXXX` (passes `assertScenarioParticipant`)
- Each declares `testMode: true`, `agentId: default`, `turnTimeoutMs: 120000`
- 50-turn YAMLs use a deterministic synthetic user-turn pattern (e.g. paraphrase variants of a base question with index suffix); inline, no `synthesize:` runner directive needed
- Each YAML's `assert.voice_axes_full: true` opt-in (new flag T4 will wire) — runner emits the 8-axis block for these
- `--dry-run` plan output `scenarios.length === 25` (20 existing + 5 new)
- New YAMLs have descriptive `description` block (≥2 lines) explaining the trap + expected axis target

**DON'T:**
- DON'T add crisis red-team prompts (Phase 40)
- DON'T add tone-shift labeled set (Phase 34)
- DON'T touch existing 20 YAMLs (zero regression risk)
- DON'T use real phone numbers — only `+1999999XXXX` reserved range

Commit msg: `feat(33/T3): 5 new eval scenarios (50-turn drift × 2 / advice repeat / strategy fit / length cap) (P9-C)`

---

## T4 — Integrate 4 axes into runner.mjs + judge.mjs (axes appear in JSON output + judge prompt)

**WHERE:**
- `tests/scenarios/judge.mjs` (extend) — `runVoiceJudge` accepts `{ useV2Axes: true }` flag; when set, uses `VOICE_AXES_V2` (8 axes) for tool schema + system prompt; existing 4-axis path stays the default for back-compat
- `tests/scenarios/runner.mjs` (extend) — when `scenario.assert?.voice_axes_full === true`, after the regular judge completes, also compute deterministic helpers (`computeLengthCompliance`, `computeDriftScore`, `computeAdviceNovelty` over `result.turns`) and merge into per-scenario `result.voiceAxesAggregate` block; also emit `result.turns[i].voiceAxesV2` when judge is run with v2
- `tests/scenarios/runner.mjs` (extend) — `dryRunPlan` reports new field `voiceAxesV2Scenarios` count
- `tests/scenarios/lib/voice-axes.test.mjs` or `tests/scenarios/runner.test.mjs` — add a test that `dryRunPlan` recognizes the new flag (NO live API call)

**HOW MUCH:** ~3 hours.

**DONE:**
- `npm run typecheck` clean
- Existing `runVoiceJudge` calls (no `useV2Axes`) return identical shape as before — zero regression on legacy scenarios
- New `runVoiceJudge({ useV2Axes: true })` returns `axes` object with all 8 keys (4 legacy + 4 new); average computed over the 8
- `tests/scenarios/runner.mjs --dry-run tests/scenarios/scenarios/` reports new `voiceAxesV2Scenarios: 5`
- `runner.mjs` per-turn JSON output gains `voiceAxesV2: { ... }` block when scenario opts in
- `result.voiceAxesAggregate` block contains `{ driftScore, lengthCompliance, adviceNovelty, samples }` for opt-in scenarios
- Auto-fail (filler blacklist) still short-circuits before judge call — new axes return `null` in that case (not 0)

**DON'T:**
- DON'T break `pairwise-runner.mjs` — it uses `judgePairwise` (binary), not `runVoiceJudge`. No changes needed there.
- DON'T touch `packages/pa-orchestrator/src/index.ts` (P9-A T4 collision zone)
- DON'T modify the legacy 4-axis judge path semantics — only add the v2 path behind a flag
- DON'T introduce a global `--v2` CLI flag — opt-in is per-scenario via `assert.voice_axes_full: true` so existing scenarios stay frozen

Commit msg: `feat(33/T4): wire 8-axis voice judge + deterministic aggregates into runner + judge.mjs (P9-C)`

---

## T5 — Smoke run on existing 20 scenarios + verify all 4 axes return numeric (not null/NaN)

**WHERE:**
- `tests/scenarios/lib/voice-axes-smoke.test.mjs` (new) — calls each new axis helper against 3 representative existing scenarios' replies (loaded from a static fixture file) and asserts numeric (or explicit-null with reason) — NO live API calls
- `tests/scenarios/lib/voice-axes-smoke-fixtures.json` (new) — 3 sample reply transcripts copied from `eval-runs/` golden runs (or hand-crafted if no recent run); used as input to smoke test
- `.planning/phases/33-eval-harness-extension/SMOKE-RESULT.md` (new) — capture: which axes returned numeric vs null, axis values, any anomalies, and whether Phase 34 baseline run is unblocked

**HOW MUCH:** ~2 hours.

**DONE:**
- `node --test tests/scenarios/lib/voice-axes-smoke.test.mjs` passes
- For each of 3 fixtures: `length_compliance` returns numeric float (never null); `drift_resistance` returns numeric or `null` with `reason: "insufficient history"`; `advice_novelty` returns numeric or `null` with `reason: "missing api key"` (test runs without env); `strategy_fit` keyword classifier returns one of the 8 strategy ids (never null)
- All deterministic helpers handle empty/single-turn input without throwing
- `SMOKE-RESULT.md` documents the smoke output + confirms HARNESS-04 acceptance gate (all 4 axes return numeric on existing scenarios)
- `npm run typecheck` clean (full repo, not just tests/)
- Commit hook: `git diff --stat` shows ONLY files in `tests/scenarios/` + `.planning/phases/33-eval-harness-extension/` (zero collision with P9-A scope)

**DON'T:**
- DON'T do a real PA_RUN_EVAL=1 live judge run here — that's Phase 34 baseline measurement
- DON'T attempt to also run the 5 new 50-turn YAMLs end-to-end against the orchestrator — Firestore broker round-trip × 50 turns × 2 langs = ~30min. Save for Phase 34.
- DON'T modify `eval-runs/` historical artifacts
- DON'T tag or git-push (Adam ships)

Commit msg: `test(33/T5): smoke verify all 4 new voice axes return numeric on 3 fixture replies + HARNESS-04 acceptance (P9-C)`

---

## Sub-task summary

| ID | Title | Dep | Time | Files touched |
|----|-------|-----|------|---------------|
| T1 | Sentence splitter + BGE-M3 embed-sim + unit tests | none | 4h | 4 new files in `tests/scenarios/lib/` |
| T2 | 4 new axis functions + helpers | T1 | 3h | extend `voice-axes.mjs` + `voice-axes.test.mjs` |
| T3 | 5 new scenario YAMLs | none (parallelizable w/ T1+T2) | 3h | 5 new files in `tests/scenarios/scenarios/` |
| T4 | Wire 8-axis judge + aggregates into runner + judge | T2, T3 | 3h | extend `runner.mjs`, `judge.mjs`, possibly `runner.test.mjs` |
| T5 | Smoke verify + SMOKE-RESULT.md | T4 | 2h | 3 new files (smoke test + fixtures + report) |

Total **~1.5-2 dev-day** (15h with buffer).

After T5: write `SUMMARY.md`, update `STATE.md` Phase 33 → complete, return STRUCTURED REPORT to P10.

## Adam decisions still owed (P9-C surfaces these BEFORE T1 starts)

- [ ] **Confirm HARNESS-02 (drift-score.mjs aggregator) defers to Phase 35** — REQUIREMENTS.md lists it under Phase 33; CONTEXT.md §1 argues for Phase 35 co-location with detectors. P9-C call: defer. Adam veto if disagree.
- [ ] **Confirm crisis red-team scenarios defer to Phase 40** — HARNESS-05 lists them under Phase 33; CONTEXT.md §1 argues Phase 40 (ship with Bible v7.5 crisis section). P9-C call: defer. Adam veto if disagree.
- [ ] **Confirm `assert.voice_axes_full: true` per-scenario opt-in** vs runner-wide `--axes-v2` CLI flag. P9-C call: per-scenario opt-in (keeps existing 20 scenarios frozen). Adam veto if disagree.

If no veto by start of T1, proceed with documented decisions.
