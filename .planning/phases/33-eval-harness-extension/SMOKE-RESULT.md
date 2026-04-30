# Phase 33 — T5 SMOKE-RESULT

**Run date:** 2026-04-29
**Owner:** P9-C
**Test command:** `node --test tests/scenarios/lib/voice-axes-smoke.test.mjs`
**Result:** 7/7 pass

---

## Fixture corpus

3 hand-crafted Claire-voice replies stored in
`tests/scenarios/lib/voice-axes-smoke-fixtures.json`:

| id | scenario alignment | turns | language |
|----|--------------------|-------|----------|
| `claire-zh-quiet-support` | mirrors `eval-voice-emo-support-zh.yaml` | 1 | zh |
| `claire-en-tech-deep` | mirrors `eval-voice-tech-deep-en.yaml` | 1 | en |
| `claire-multi-turn-mirror-trap` | synthetic 3-turn drift fixture | 3 | zh + emoji |

These are intentionally short (≤3 turns) so the env-missing branches and
the mocked-fetch branches both exercise quickly. Phase 34 baseline run
on the 5 new full scenario YAMLs is the next-phase verification.

---

## Per-axis smoke result

### length_compliance — deterministic, never null

| Fixture | turns | within cap | overCapTurns | compliance |
|---------|-------|------------|--------------|------------|
| claire-zh-quiet-support | 1 | 1 | [] | 1.0 |
| claire-en-tech-deep | 1 | 1 | [] | 1.0 |
| claire-multi-turn-mirror-trap | 3 | 3 | [] | 1.0 |

**HARNESS-04 contract met:** numeric float ∈ [0, 1] always.

### drift_resistance — `mirrorMax` deterministic, `repeatMax` async

| Fixture | env | mirrorMax | repeatMax | driftScore |
|---------|-----|-----------|-----------|------------|
| claire-zh-quiet-support | missing | finite (mirror computed) | null | finite |
| claire-en-tech-deep | missing | finite | null | finite |
| claire-multi-turn-mirror-trap | missing | finite | null | finite |
| claire-multi-turn-mirror-trap | mocked | finite | finite | finite |

**HARNESS-04 contract met:** `driftScore` always finite; `repeatMax`
documented as null when env missing (graceful degrade).

### advice_novelty — env-gated

| Fixture | env | history len | result |
|---------|-----|-------------|--------|
| claire-zh-quiet-support | missing | 0 | `{ noveltyScore: 1, ... }` (no history baseline) |
| claire-en-tech-deep | missing | 0 | `{ noveltyScore: 1, ... }` |
| claire-multi-turn-mirror-trap | missing | 2 | `null` (env-missing skip) |
| claire-multi-turn-mirror-trap | mocked | 2 | `{ noveltyScore: finite ∈ [0, 1], ... }` |

**HARNESS-04 contract met:** numeric float ∈ [0, 1] when env present;
explicit `null` when env missing AND history present (so callers know
to record `"skipped: missing api key"` rather than treat 0 as failure).

### strategy_fit — keyword classifier never null

| Fixture | inferred strategies | matched keywords |
|---------|---------------------|------------------|
| claire-zh-quiet-support | `Reflection` (turn 1) | "听起来" |
| claire-en-tech-deep | `Information` (turn 1, fallback) | none → length-based fallback |
| claire-multi-turn-mirror-trap | `Reflection`, `Other` (short emoji-y), `Suggestion` | "听起来", "—", "试" |

**HARNESS-04 contract met:** classifier returns a strategy string for
every non-empty reply; `isAllowedStrategy()` returns boolean.

---

## Anomalies / observations

1. **`claire-en-tech-deep` falls back to `Information`** because the en
   keyword bank doesn't include factual-content markers (by design — the
   ESConv `Information` strategy covers any non-tagged factual content).
   This matches the keyword-priority classifier specification in
   CONTEXT.md §2.3 and is the intended fallback. Phase 37 FSM will
   replace this with a proper rule-based classifier for production use.

2. **`mirrorMax` for `claire-multi-turn-mirror-trap`** is non-trivial
   even though Claire's replies are *not* verbatim mirrors. This is
   expected — the n-gram Jaccard catches partial overlap (shared
   particles like "今", "唉", etc.). The threshold for "actual mirror
   detection" is calibrated in Phase 35 against the rev-00056 known
   fails per DETECT-07.

3. **No NaN / Infinity** observed across any fixture in either env-
   missing or mocked-fetch path. All scoring boundaries are clamped via
   `Math.max(0, ...)` / `Math.min(1, ...)` in the helpers.

4. **Auto-fail short-circuit not exercised here** — fixtures use clean
   Claire voice. Phase 34 baseline run will hit the auto-fail path
   organically; T4 already wired axes to return `null` (not 0) for the
   4 new axes when filler-blacklist or iMessage-render trips.

---

## HARNESS-04 acceptance verdict

**PASS.** All 4 new axes return either a finite numeric value or an
explicit `null` (with documented reason) on every fixture. Zero
NaN/Infinity. Phase 34 baseline measurement run is unblocked.

---

## Phase 34 readiness checklist

- [x] `tests/scenarios/lib/sentence-split.mjs` shipped (T1)
- [x] `tests/scenarios/lib/embed-sim.mjs` shipped (T1)
- [x] `tests/scenarios/lib/voice-axes.mjs` extended with V2 + 4 helpers (T2)
- [x] 5 new scenario YAMLs added (T3)
- [x] `runner.mjs` + `judge.mjs` wired for V2 axes + aggregates (T4)
- [x] Smoke verified — all 4 axes numeric on 3 fixtures (T5)
- [ ] Phase 34: run `pairwise-runner.mjs --scenarios "eval-*"` against rev-00056 with `PA_RUN_EVAL=1` + real `PA_OPENAI_AGENT_API_KEY` + `SILICONFLOW_API_KEY` to lock baseline numbers in `.planning/baseline-rev00056.md`.
- [ ] Phase 34: extend `pairwise-runner.mjs` to optionally call `runVoiceJudge({ useV2Axes: true })` so V2 axis scores show up in pairwise output too (small extension; not Phase 33 scope per CONTEXT §1).

---

> [🟠 阿里味] **闭环意识**：smoke 跑完了，数字铺好了。Phase 34 baseline 测量直接接上，**因为信任所以简单**。
