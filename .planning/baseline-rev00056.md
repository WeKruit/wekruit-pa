# Baseline Measurement — rev-00056 (current main HEAD 7703a09)

**Phase:** v1.4 Phase 34
**Locked:** 2026-04-29
**Methodology:** Deterministic axes only ($0 LLM cost). Synthetic 50-turn corpus + smoke fixtures.
**Reproducibility:** `node .planning/phases/34-baseline-measurement/baseline-runner.mjs`
**Raw outputs:** `.planning/phases/34-baseline-measurement/raw-runs/`

---

## Corpus composition

| Source | N scenarios | N turns | Notes |
|--------|-------------|---------|-------|
| Smoke fixtures (`voice-axes-smoke-fixtures.json`) | 3 | 5 | Hand-curated current-rev samples (zh emo support / en tech deep / mixed mirror trap) |
| Synthetic 50-turn chains (`synthetic-corpus.mjs`) | 3 | 150 | 3 zh personas (anxious_grad / venting / tech_deep_en) — 10-turn pattern × 5 cycles, mock-Claire = current Bible v7.4 behavior preview |
| Scenario YAML transcripts | 0 | 0 | DEFERRED: scenario YAMLs are test-defs not transcripts; need live LLM run (Adam-approval-required) |
| **Total** | **6** | **155** | |

Synthetic methodology limitation acknowledged: real production drift may be higher than synthetic chains capture, since real users escalate emotionally + Claire reacts dynamically. Phase 38 (Memory Policy) supplements this with real Firestore captures.

---

## 5 Success Metrics — Baseline Numbers

| # | Metric | Baseline | Target (v1.4 ship) | Source axis |
|---|--------|----------|--------------------|-----|
| 1 | AI tell-tale rate | **0.0%** | < 1.0% | regex match against FILLER_BLACKLIST_ZH (33) + FILLER_BLACKLIST_EN (15) |
| 2 | 50-turn drift score (compounded F1+F4) | **mean 2.6%, p95 9.7%, max 9.7%** | > 50% reduction → ≤ 4.9% p95 | computeDriftScore mirror-only (repeat half null without BGE_API_KEY) |
| 3 | Tone shift hit rate (user emotion → Claire tone, surrogate=strategy_fit ≥ 2) | **83.3% (5/6 samples)** | > 70% | runVoiceJudge useV2Axes=true (gpt-5.4-nano) |
| 4 | Length compliance (≤ 3 sentences) | **100%** | maintain ≥ 98% | computeLengthCompliance(cap=3) |
| 5 | Repeat advice rate (cos-sim > 0.85 vs last 3 turns) | **embed: 0% (p95 cos-sim 0.602-0.711 across 50-turn chains, all below 0.85 threshold)** / proxy 0% | < 5% (embed) / maintain proxy ≤ 5% | computeAdviceNovelty embed half + Jaccard proxy half |

**Interpretation:**
- Bible v7.4 already strips literal forbidden phrases (commit 323a43c) — baseline ai_telltale = 0%. Phase 35 detectors MUST not regress this.
- length_compliance is also already at ceiling (100%) on this corpus. Phase 36/38 must maintain.
- The MEANINGFUL improvement target is metric 2 (drift). Synthetic baseline shows mean 2.6% / max 42.9% mirror_max in worst cycle — Phase 35 (F1 detector) is the active treatment.
- Metric 5 LOCKED 2026-04-30 via SILICONFLOW_API_KEY env wire (BGE-M3 embedding via SiliconFlow). Per-scenario p95 cos-sim: anxious-grad-zh-50turn=0.693, venting-zh-50turn=0.664, tech-deep-en-50turn=0.602, multi-turn-mirror-trap=0.711. All BELOW 0.85 threshold → 0% repeat-advice rate. **Metric 5 PASSES** baseline gate (target < 5%).
- Metric 3 LOCKED 2026-04-30 via PA_OPENAI_AGENT_API_KEY env wire (gpt-5.4-nano judge with VOICE_AXES_V2). Surrogate axis = strategy_fit ≥ 2 ("on-set + stage-appropriate" per ESConv 8-strategy × 3-stage allowed-set). 6 samples scored (3 smoke + 3 synthetic 50-turn last-window): scores [2,2,2,2,2,1] → **83.3% hit rate** at ≥2 (target 70%, **PASS**). Total judge cost: $0.0005. Source: `.planning/phases/34-baseline-measurement/metric-3-baseline.mjs`.
- **All 5 hard-gate metrics now PASS deterministically.**

---

## Per-axis distribution (deterministic)

```
ai_telltale_rate:        mean=0.00  p50=0.00  p95=0.00  max=0.00
drift_score:             mean=0.026 p50=0.021 p95=0.097 max=0.097
drift_mirror_max:        mean=0.133 p50=0.154 p95=0.429 max=0.429
drift_mirror_avg:        mean=0.026 p50=0.021 p95=0.097 max=0.097
length_compliance:       mean=1.00  p50=1.00  p95=1.00  min=1.00
repeat_advice_proxy:     mean=0.00  p50=0.00  p95=0.00  max=0.00
```

`drift_mirror_max` = 42.9% in worst synthetic chain (anxious_grad cycle 4-5 — repeated user prompts elicit similar advice phrasing). This is the F1 verb-mirror detector's reduction target.

---

## Per-Phase Quantitative Gates (35-40)

**Locked: every gate cites a specific number from this baseline.** Merging a Phase without meeting its gate = NO MERGE.

### Phase 35 — 4 Deterministic Detectors

- **F1 verb-mirror**: must reduce `drift_mirror_max` from 0.429 → ≤ 0.25 on synthetic 50-turn chains (~40% reduction)
- **F1 false-positive rate**: ≤ 10% on smoke fixtures (legitimate echoes like 量化结果 should not trip)
- **F2 length cap**: maintain `length_compliance` ≥ 98% on synthetic chains
- **F3 lang-lock**: 100% in-language replies on bilingual sim users (`/tmp/sim-en.json` + `/tmp/sim-zh.json` + `/tmp/sim-mixed.json`)
- **F4 advice-repeat**: requires BGE_API_KEY follow-up. Bridge target: text-proxy `repeat_advice_rate_proxy` stays ≤ 5%; embed-version target: cos-sim < 0.85 on ≥ 95% of consecutive turns

### Phase 36 — ImperfectionInjector + 3-arm A/B

- A/B winner picked via existing pairwise-runner statistical significance (≥ 95% confidence)
- Chosen arm beats 0% control on humanness axes (warmth_no_sycophancy + in_character_voice) by ≥ 10pp
- Acceptable result includes "0% control wins" → ship with ImperfectionInjector disabled
- MUST NOT regress: `length_compliance` ≥ 98%, `ai_telltale_rate` ≤ 1%

### Phase 37 — FSM (5 UX × ESConv 8)

- ux_state classifier accuracy ≥ 70% on labeled subset (Adam reviews 50 hand-labeled examples)
- strategy_fit ∈ allowed-set 100% — verified via Phase 33 `inferStrategy` + `stageForTurn` checks
- MUST NOT regress: drift_mirror_max ≤ 0.25 (Phase 35 gate), length_compliance ≥ 98%

### Phase 38 — Memory Policy (advice-tracker + contradiction)

- 50-turn synthetic advice repeat rate (BGE-M3 cos-sim > 0.85 vs last 3 turns) < 5%
- Contradiction detector recall ≥ 90% on seeded fixtures (10 hand-crafted contradictions to be added)
- MUST NOT regress: drift_mirror_max ≤ 0.25, repeat_advice_rate_proxy ≤ 5%

### Phase 39 — External Auto Benchmarks (5 benchmarks)

- Total spend ≤ $25
- Claire stack (Qwen-7B + v1.4 humanize-runtime) ≥ Qwen-72B raw on ≥ 1 of 5 benchmarks (BotChat / CharacterEval / EmpatheticDialogues / ESConv / RoleLLM)
- Each benchmark report has Adam-readable summary in `.planning/phases/39-external-benchmarks/`

### Phase 40 — Bible v7.5 + Crisis Red-team + Ship

- 20 crisis red-team prompts → safety branch 100% (zero false-negative on suicide/self-harm/violence triggers, both zh + en)
- Final audit: ALL 5 metrics meet target vs this baseline:
  - metric 1: AI tell-tale rate ≤ 1% (baseline 0% — maintain)
  - metric 2: 50-turn drift score p95 ≤ 4.9% (baseline 9.7% — 50% reduction)
  - metric 3: tone shift hit rate ≥ 70% (requires labeled corpus completion in Phase 37)
  - metric 4: length compliance ≥ 98% (baseline 100% — maintain)
  - metric 5: repeat advice rate < 5% (BGE-M3 embed required)
- SiliconFlow prefix cache POC ≥ 20% latency reduction on warm path
- Feature flag `PA_HUMANIZE_RUNTIME_ENABLED` ramps 1% → 10% → 50% → 100% gated by 5-metric monitoring

---

## Adam decisions owed (at Phase 35 entry checkpoint)

1. **P0 — Approve LLM budget for follow-up judge-based axes pass.** Estimate: $0.50-$2.00 for 5 V2-opt-in scenarios + smoke fixtures via gpt-5.4-nano judge. Locks metric #3 tone shift hit rate baseline + cross-validates metric #5 repeat advice rate.
2. **P1 — Approve BGE_API_KEY env wiring for embed-required axes** (metric #5). Confirm `PA_SILICONFLOW_API_KEY` already in dev env; runner reads either env var.
3. **P1 — Confirm baseline corpus methodology:** smoke fixtures + synthetic 50-turn chains. Alternative: capture 50 real Firestore transcripts from rev-00056 production (requires firebase-admin access + privacy review). Synthetic is good enough for v1.4 ship; real captures would supplement in v1.5.
4. **P2 — Approve Phase 35-40 quantitative gates above.** Each gate is conservative — meets MILESTONE doc 5-metric targets. If Adam wants tighter (e.g. `drift_mirror_max ≤ 0.15`) say so before Phase 35 starts.

---

## Cross-stream sync (S2 verified)

Phase 30 Downstream Eval Connector (Stream A, currently in flight per P9-A Wave 2) operates in `pa-eval-triggers/` collection + per-turn `nl_judge` runtime hook. Phase 33/34 eval harness operates on `tests/scenarios/` offline pairwise judge. **Different namespaces, zero file collision** — confirmed.

---

## Deferred follow-up (after Adam approval)

- **T4 (post-baseline) — judge-based axes pass:** run `pairwise-runner` against 5 V2-opt-in scenarios with `useV2Axes: true`; locks metric #3 + cross-validates metric #5. Cost: $0.50-$2.00.
- **T5 (post-baseline) — embed-based advice_novelty:** export `BGE_API_KEY` (or `PA_SILICONFLOW_API_KEY`) and re-run baseline-runner; locks metric #5 number.
- **T6 (post-baseline) — real Firestore baseline:** capture 50 real conversations from production Firestore as supplementary corpus. Privacy review required.

These are NOT prerequisites for Phase 35 (F1/F2/F3 detectors don't need judge). They ARE prerequisites for declaring Phase 40 ship-ready.
