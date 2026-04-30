# Final 5-Metric Audit — Phase 40 (Bible v7.5 + Crisis + Ship)

**Generated:** 2026-04-30T22:50:29.398Z
**Phase:** v1.4 Phase 40 (FINAL)
**Methodology:** re-runs Phase 34 baseline corpus + applies Phase 35-38 simulated post-treatment (F1 mirror-strip + F2 sentence-truncate + F4 diversity-nudge proxy).
**Reproducibility:** `node .planning/phases/40-bible-v7.5-ship/final-audit.mjs`
**Raw outputs:** `.planning/phases/40-bible-v7.5-ship/raw-runs/`

## Corpus

| Source | N scenarios | N turns |
|--------|-------------|---------|
| Smoke fixtures | 3 | (varies) |
| Synthetic 50-turn chains | 3 | (varies) |
| **Total** | **6** | **155** |

## 5-Metric Gate Status

| # | Metric | Baseline (rev-00056) | Post-treatment | Target | Gate |
|---|--------|----------------------|----------------|--------|------|
| 1 | AI tell-tale rate (% turns) | 0.0% / p95 0.0% | mean 0.00% / p95 0.00% | ≤ 1.0% | ✅ PASS |
| 2 | drift_score p95 (compounded F1+F4) | mean 2.6% / p95 9.7% | mean 0.99% / p95 3.77% | p95 ≤ 4.9% (50% reduction) | ✅ PASS |
| 3 | tone shift hit rate (judge-required) | DEFERRED | DEFERRED — preview only | ≥ 70% | ⚠️ DEFERRED (Adam P0 LLM judge $0.50-$2 budget) |
| 4 | length compliance (≤ 3 sentences) | mean 100% | mean 100.00% | ≥ 98% | ✅ PASS |
| 5 | repeat advice rate (embed-required) | DEFERRED — proxy 0.0% | DEFERRED — proxy 0.00% | < 5% (cos-sim version) | ⚠️ DEFERRED (Adam P1 BGE_API_KEY env wiring) |

## Phase 35-38 Post-Treatment Simulation

Each Claire turn was processed through:

1. **F1 mirror-strip** — when `computeMirrorRatio(prev_user, claire) >= 0.25`, strip longest shared substring (≥ 3 chars).
2. **F2 sentence-truncate** — when `splitSentences(claire).length > 3`, truncate to first 3.
3. **F3 lang-lock** — N/A on synthetic corpus (in-language; production-only).
4. **F4 diversity-nudge proxy** — when prior-3-turn Jaccard proxy max ≥ 0.5, strip longest shared substring against highest-overlap prior turn. Embed cos-sim 0.85 version requires BGE_API_KEY.

## Drift Mirror Detail

| Metric | Baseline | Post-treatment | Δ |
|--------|----------|----------------|---|
| drift_mirror_max p95 | 42.9% | 21.43% | -21.47pp |
| drift_mirror_avg | 13.3% | 0.99% | -12.31pp |
| repeat_advice_proxy mean | 0.0% | 0.00% | 0.00pp |

## Adam decisions owed (post-Phase-40)

| # | Priority | Action | Cost | Unblocks |
|---|----------|--------|------|----------|
| 1 | P0 | Approve LLM judge budget ($0.50-$2) for metric 3 baseline + cross-validation | $0.50-$2 | metric 3 final number, ship gate signoff |
| 2 | P1 | Wire `BGE_API_KEY` env in CFs (or confirm `PA_SILICONFLOW_API_KEY` already present) | $0 (env) | metric 5 cos-sim 0.85 final number |
| 3 | P0 | Apply WIRE-IN-PATCH.md (consolidates Phase 35+36+37+38+40 wire-ins) | dev time | live activation of all v1.4 modules |
| 4 | P0 | Run `npx tsx apps/functions/scripts/migrate-bible-v7.5-to-handbook.ts --live` | $0 | handbook v2 in Firestore |
| 5 | P0 | Append SEED_FLAGS `paHumanizeRuntimeEnabled` entry + run `paAdminBootstrap?action=seedFlags` | $0 | flag installed in Firestore |
| 6 | P0 | Phase 1 (1% canary) per FLAG-SPEC.md §2.2 | $0 | first prod traffic on v1.4 humanize stack |
| 7 | P1 | Review crisis red-team scenarios (5+5 hand-eyeball check) | dev time | Adam confidence signoff before production |

## Summary

✅ **All 3 deterministic hard gates met** (metrics 1 + 2 + 4). v1.4 milestone READY for ship-build signoff.

Metrics 3 + 5 explicitly deferred per Phase 34 baseline doc — they require Adam P0/P1 prerequisites. Both deferrals tracked in this report and in WIRE-IN-PATCH.md cookbook for handoff.

**Next:** `/gsd:audit-milestone v1.4` for milestone-level signoff, then v1.5 spawn.
