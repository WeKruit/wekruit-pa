# Phase 34 — PLAN (3-task spec)

**Status:** Plan locked. Estimate ~0.5 dev-day, single P9 sequential. Done in main session (P10) due to BG agent policy filter on first spawn.

---

## T1 — Baseline runner + synthetic 50-turn corpus

**WHERE:**
- `.planning/phases/34-baseline-measurement/baseline-runner.mjs` (new) — corpus loader + axis aggregator
- `.planning/phases/34-baseline-measurement/synthetic-corpus.mjs` (new) — generates 50-turn echo chains from smoke fixtures

**HOW MUCH:** ~30 min.

**DONE:**
- `node .planning/phases/34-baseline-measurement/baseline-runner.mjs --dry-run` prints corpus stats (N scenarios, M total assistant turns, K synthetic chains) and exits 0
- Synthetic corpus has 3 personas × 50 turns = 150 turns minimum
- Imports VOICE_AXES_V2 + computeXxx helpers from `tests/scenarios/lib/voice-axes.mjs` (no duplication)
- Reads ai_telltale via FILLER_BLACKLIST_ZH + FILLER_BLACKLIST_EN regex match

**DON'T:**
- DON'T re-implement axis logic (use Phase 33 helpers)
- DON'T add LLM judge calls (T2 may add deterministic-only call to verify baseline; cost = $0)
- DON'T touch production code

Commit: `feat(34/T1): baseline runner + synthetic 50-turn corpus`

---

## T2 — Run baseline + write baseline-rev00056.md

**WHERE:**
- `.planning/phases/34-baseline-measurement/raw-runs/per-scenario.json` (output)
- `.planning/phases/34-baseline-measurement/raw-runs/aggregate.json` (output)
- `.planning/baseline-rev00056.md` (locked baseline doc + per-Phase gates)

**HOW MUCH:** ~30 min (deterministic-only, no LLM cost).

Steps:
1. Run baseline-runner.mjs against full corpus (smoke fixtures + scenario YAMLs + synthetic 50-turn chains)
2. Capture per-scenario raw axis values
3. Aggregate into 5-metric numbers + per-axis distributions
4. Write baseline-rev00056.md with:
   - Methodology section (corpus composition, synthetic chain construction)
   - 5 metrics table (current baseline + target)
   - Per-axis distribution (mean/p50/p95/min/max)
   - Per-Phase quantitative gates (35-40) tied to specific deltas from baseline
   - Deferred items (judge-based axes, BGE_API_KEY-required axes) with Adam-approval-required flag

**DONE:**
- baseline-rev00056.md committed at project root .planning/
- 5 metrics have specific numbers (not "TBD")
- Per-Phase gates each cite ≥1 specific number from baseline (e.g. "Phase 35 must reduce mirror_max from 0.34 → ≤0.20")
- raw-runs/*.json committed for reproducibility

**DON'T:**
- DON'T burn LLM budget without Adam OK (judge-based axes deferred to follow-up)
- DON'T claim baseline tested against rev-00056 git rev — current main is the baseline-of-record (documented in CONTEXT.md)

Commit: `feat(34/T2): lock baseline-rev00056.md with 5-metric + per-Phase gates (P10 measurement)`

---

## T3 — SUMMARY + STATE update

**WHERE:**
- `.planning/phases/34-baseline-measurement/SUMMARY.md` (new)
- `.planning/STATE.md` (update Phase 34 row → ✅ + increment progress.completed_phases)

**HOW MUCH:** ~10 min.

**DONE:**
- SUMMARY captures: status / 5 metric numbers / gates table / deferred items / Adam-actions-owed / sync points
- STATE.md Phase 34 ✅; completed_phases bumped
- last_updated + last_activity bumped to 2026-04-29

Commit: `chore(34): SUMMARY + STATE — Phase 34 baseline locked, gates 35-40 defined`

---

## Sub-task summary

| ID | Title | Dep | Time |
|----|-------|-----|------|
| T1 | baseline-runner + synthetic-corpus | none | 30min |
| T2 | run baseline + lock baseline-rev00056.md | T1 | 30min |
| T3 | SUMMARY + STATE | T2 | 10min |

Total **~70 min**.

## Adam decisions owed (at Phase 35 entry checkpoint)

- [ ] Approve LLM budget ($0.50-$2 estimate) for follow-up judge-based axes pass on 5 V2-opt-in scenarios + smoke fixtures (would lock metric #3 tone shift hit rate + cross-validate metric #5 repeat advice)
- [ ] Confirm baseline corpus is acceptable (smoke fixtures + scenario YAMLs + synthetic chains) — alternative is to capture real Firestore transcripts from rev-00056 production (requires firebase-admin access + privacy review)
- [ ] Confirm synthetic chain methodology: programmatic echo / repeat patterns extending existing fixture user prompts
