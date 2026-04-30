# Phase 34 — Baseline Measurement (CONTEXT)

**Owner:** P9-C Wave 2 → P10 main session (BG agent failed policy filter on first attempt; switched to in-session execution)
**P10 strategy:** v1.4 D16 eval-first ordering — locks 5-metric report before any module work in Phase 35-40.
**Spawned:** 2026-04-29

## 底层逻辑

Phase 33 just shipped 8-axis VOICE_AXES_V2 + bilingual sentence splitter + BGE-M3 embed-sim wrapper + 5 new scenarios + 140/140 tests. The harness can MEASURE; this phase RUNS that measurement to lock pre-treatment numbers.

Without a baseline, Phase 35-40 quantitative gates ("merge if F1 mirror improves by Y%") are unfounded. The number is the gate.

## Phase boundary

**In scope:**
- Run deterministic axes (length_compliance, drift_resistance via mirror-only, ai_telltale via FILLER_BLACKLIST regex, advice repeat-via-text-only) on:
  - 3 smoke fixtures from `voice-axes-smoke-fixtures.json` (current rev sample)
  - 25+ existing scenario YAML transcripts treated as corpus
  - Synthetic 50-turn echo chains (programmatic extension to surface drift behavior at length)
- Write `baseline-rev00056.md` (project root .planning/) with per-axis distributions
- Define per-Phase quantitative gates (Phase 35-40) tied to specific numbers

**Out of scope (deferred per PUA blast-radius):**
- Judge-based axes (in_character_voice / warmth_no_sycophancy / strategy_fit LLM-judged) — require LLM budget; flag for Adam approval before Phase 35 entry
- BGE-M3 embedding-based advice_novelty — requires SiliconFlow `BGE_API_KEY` env; runner gracefully degrades to null for that half if missing
- Live conversation captures from production Firestore — defer to Phase 38 (memory policy uses real transcripts)

## 顶层设计

```
.planning/phases/34-baseline-measurement/
  ├── CONTEXT.md            (this file)
  ├── PLAN.md               (3 atomic tasks)
  ├── baseline-runner.mjs   (T1 — deterministic axes over corpus)
  ├── synthetic-corpus.mjs  (T1 — generates 50-turn drift chains from fixtures)
  └── raw-runs/
      ├── per-scenario.json  (T2 — every scenario, every axis)
      └── aggregate.json     (T2 — distribution per axis)

.planning/baseline-rev00056.md   (T2 — locked baseline doc with 5 metrics + gates)
```

## Architectural decisions (P10-locked, applied)

- **Baseline-of-record**: current `main` HEAD (commit 7703a09 at start of Phase 34) is the baseline. "rev-00056" was a label; v1.4 phases 33+34 add only eval harness, do NOT change orchestrator output, so current main = rev-00056 production behavior for measurement purposes.
- **Deterministic-first**: all 5 metrics expressed as deterministic computation where possible. LLM-judge only where deterministic insufficient (tone_shift_hit, semantic advice_novelty).
- **Synthetic 50-turn corpus**: real production has 1-3 turn scenarios. Drift requires 50-turn windows. Build synthetic chains by repeating user-prompt patterns from existing scenarios + capturing what current Bible would do in a fixed-Claire mock — surfaces verb-mirror + length-escalation tendency without LLM cost.
- **Cost ceiling**: $0 budget for Phase 34 (deterministic only). Adam approval required for follow-up judge-based pass.
- **Gates expressed as deltas**: "Phase 35 must reduce F1 mirror_max by ≥40%" not "≥X absolute" — deltas are fair regardless of baseline noise.

## Reuse manifest (from Phase 33)

| Asset | File | Use |
|-------|------|-----|
| VOICE_AXES_V2 | `tests/scenarios/lib/voice-axes.mjs` | 8-axis schema |
| computeLengthCompliance | same | metric 4 (length_compliance) |
| computeDriftScore | same | metric 2 (50-turn drift) — mirror half deterministic, repeat half network-degrades |
| computeMirrorRatio | same | F1 baseline preview (Phase 35) |
| computeAdviceNovelty | same | metric 5 (repeat advice) — embed-required, degrades to null |
| inferStrategy + stageForTurn | same | metric 3 (tone shift) preview — basic ESConv fit, full hit-rate needs labeled corpus |
| FILLER_BLACKLIST_ZH (33) + FILLER_BLACKLIST_EN (15) | same | metric 1 (AI tell-tale rate) |
| sentence-split.mjs | `tests/scenarios/lib/sentence-split.mjs` | length detection |
| smoke fixtures | `tests/scenarios/lib/voice-axes-smoke-fixtures.json` | seed corpus |
| scenarios YAML | `tests/scenarios/scenarios/eval-*.yaml` | extended corpus |

## 5 success metrics (re-locked from MILESTONE doc)

| # | Metric | Phase 34 Measurement Approach | Pre-Treatment Goal |
|---|--------|-------------------------------|--------------------|
| 1 | AI tell-tale rate | regex match against FILLER_BLACKLIST_ZH (33) + FILLER_BLACKLIST_EN (15) on assistant turns across corpus | capture % |
| 2 | 50-turn drift score | computeDriftScore over 50-turn synthetic chains, mirror-only (repeat=null without network) | capture max + avg |
| 3 | Tone shift hit rate | inferStrategy + stageForTurn over scenario sequences; partial — full requires labeled corpus, defer | capture preview |
| 4 | Length compliance | computeLengthCompliance with cap=3 across all assistant turns | capture % |
| 5 | Repeat advice rate | computeAdviceNovelty if BGE_API_KEY else null + flag deferral to follow-up | capture if env present |

## Quantitative gates (per-phase, locked at end of T2)

To be filled in baseline-rev00056.md based on captured numbers. Format:
- Phase 35 (Detectors): F1 mirror_max ≤ X (50% reduction from baseline N)
- Phase 36 (ImperfectionInjector A/B): chosen arm ≥10pp better than 0% control on humanness axes
- Phase 37 (FSM): strategy_fit ∈ allowed-set 100%; classifier accuracy ≥70% on labeled subset
- Phase 38 (Memory Policy): repeat advice rate < 5% (cos-sim > 0.85 vs last 3 turns)
- Phase 39 (External Benchmarks): Claire stack ≥ Qwen-72B raw on ≥1 of 5 public benchmarks
- Phase 40 (Bible v7.5 + Ship): all 5 metrics meet target vs baseline

## Risks

- **R1**: Synthetic corpus doesn't reflect real production drift patterns → measurement overestimates or underestimates baseline. Mitigation: document synthetic methodology in baseline doc; Phase 38+ supplements with real Firestore captures.
- **R2**: BGE_API_KEY absent → metric 5 undefined. Mitigation: explicit deferral with Adam-approval-required flag in SUMMARY.
- **R3**: ai_telltale rate baseline = 0% (Bible v7.4 already strips literal forbidden phrases per commit 323a43c) → leaves no improvement target. Mitigation: also count near-miss patterns + log "current production already good on this axis, Phase 35-40 must NOT regress".
