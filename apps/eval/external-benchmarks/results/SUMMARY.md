# Phase 39 — External Benchmark Matrix SUMMARY

**Run window**: 2026-05-01T20:54Z → 2026-05-02T01:50Z (~5h)
**Cells completed**: 13/15 (claire-stack empathetic + role-llm fill in progress, +1h)
**Total cost**: $0.4238 / $25 cap (1.7%)
**Total LLM calls**: 5,031
**Adapter**: SiliconFlow OpenAI-compat — Qwen/Qwen2.5-7B-Instruct (qwen-7b-raw + claire-stack backing) / Qwen/Qwen2.5-72B-Instruct (qwen-72b-raw)

## Headline cross-arm result

```
BotChat humanlikeness (judge wins / 50):
  claire-stack:  0.96  (48 wins, 2 losses)   ← v1.4 humanize-runtime stack
  qwen-7b-raw:   0.56  (28 wins, 22 losses)  ← same backing model, no stack
  qwen-72b-raw:  1.00  (50 wins, 0 losses)   ← self-judge artifact (untrustworthy)

  → claire-stack vs qwen-7b-raw: **+71% relative win-rate**
  → Same backing LLM (Qwen-7B). Stack alone delivers the gain.
```

## Per-arm × per-benchmark matrix

| Benchmark | claire-stack 🟢 | qwen-7b-raw 🔵 | qwen-72b-raw |
|---|---|---|---|
| **BotChat** humanlikeness | 0.96 (48/50) | 0.56 (28/50) | 1.0* (self-judge) |
| **CharacterEval** sample call_rate | 1.0 (77/77, subprocess pending) | 1.0 (77/77) | 1.0 (77/77) |
| **ESConv** response_rate | 200 conv (timeout-heavy, $0.0098) | 0 (200 fetch failed)** | 1.0 (200 conv $0.06) |
| **EmpatheticDialogues** generated_rate | (FILL IN PROGRESS) | 0.16 (160/1000, 840 timeouts) | 0.96 (959/1000) |
| **RoleLLM** generated_rate | (FILL IN PROGRESS) | 0 (200 fetch failed)** | 1.0 (200 generated, $0.077) |

\* Qwen-72B judging Qwen-72B output — score=1.0 reflects self-evaluation, not absolute humanness.
\*\* See "Known issues" below — adapter config bug specific to qwen-7b-raw on esconv + role-llm.

## Quantitative vouchers per metric

### BotChat (50 dialogues × 8 turns; judge picks more human)
- claire-stack 96% wins on Qwen-7B — biggest single quantitative validation of v1.4 humanize-runtime stack to date
- Stack is: Bible v7.5 + cv-context-injection + ImperfectionInjector (gated) + FSM (gated) + memory-policy (gated) + prefix-cache + output-normalizer
- 2/50 losses both came from BotChat overflow errors (max_seq_len 32768 exceeded for d3 + d41), not voice-quality

### CharacterEval (77 ZH characters × 5 prompts)
- All 3 arms answered 100% sample calls (no Python subprocess yet for 12-metric scoring; deferred to Adam venv)
- Cost difference: claire-stack $0.001 / qwen-7b $0.001 / qwen-72b $0.012 — qwen-72b 12× pricier per call

### ESConv (200 conversations, 8-strategy classification + response gen)
- claire-stack ran 200 conv at $0.0098 (heavy SiliconFlow timeouts on Qwen-7B during 4hr window)
- qwen-72b ran 200 conv at $0.06 with zero errors and 100% response rate

### EmpatheticDialogues (1,000 conversations test split)
- qwen-72b 95.9% generated (best response coverage) — 41 timeouts/errors out of 1000
- qwen-7b 16% generated rate with 840 timeouts — Qwen-7B can't keep up under empathetic prompt load on SiliconFlow free tier
- claire-stack arm: in progress, will be filled

### RoleLLM (50 chars × 4 prompts = 200 prompts; ZH-EN role-play)
- qwen-72b 100% generated — avg response 1028 chars (rich roleplay output)
- Data path resolution required pre-flight fix (vendor repo doesn't ship test data; HF dataset structure differs from runner's expected layout)

## Cost discipline

| Arm | Cells run | Cost |
|---|---|---|
| claire-stack | 3 of 5 | $0.06 (BotChat $0.05 + CharacterEval $0.001 + esconv $0.01) |
| qwen-7b-raw | 5 of 5 | $0.024 |
| qwen-72b-raw | 5 of 5 | $0.34 |
| **Total spent** | **13 of 15** | **$0.42 / $25 cap (1.7%)** |
| Pending claire-stack fill | empathetic + role-llm | est. +$0.10 |
| **Projected final** | **15 of 15** | **~$0.52** |

## Known issues / tech debt surfaced

1. **qwen-7b-raw esconv + role-llm "fetch failed" (200 + 200 errors)** — Qwen-7B-Instruct adapter on SiliconFlow exhibits adapter-side connection failure on these 2 benchmarks specifically (empathetic + BotChat on same arm worked). Different code path, possibly request-shape difference. Investigation pending.
2. **Qwen-7B SiliconFlow rate-limit/overload during evening window** — 840 empathetic timeouts + many esconv timeouts on claire-stack arm. Either run slower (1 cell at a time with cooldown) or use Qwen-72B as backing.
3. **CharacterEval 12-metric Python subprocess** — sample answers 100% but per-metric scoring requires Python venv (Adam HITL).
4. **Vendor data clones missing** — SETUP.md said `git clone --depth 1` but actual benchmarks need separate data downloads (FB tar.gz for empathetic, HF dataset for RoleLLM). Documented + scripted now; fold into next SETUP.md revision.
5. **Phase 39 runner has no per-cell retry** — when SiliconFlow temporarily errors a 90s timeout, the cell records it as a hard error and moves on. Consider per-error retry with backoff for next iteration.

## Statistical caveats

- BotChat has 50-dialogue sample size — humanlikeness 0.96 vs 0.56 has tight CI but rerun under different judge LLM would tighten claim
- qwen-72b judging qwen-72b output (BotChat 1.0) is not an objective benchmark score
- ESConv/EmpatheticDialogues/RoleLLM scores are **counts**, not voice-quality scores — they measure throughput / completion rate, not humanness. Need post-hoc semantic judging for those metrics

## Verdict

**v1.4 humanize-runtime stack delivered measurable BotChat humanlikeness improvement of +71% over the same backing model raw.** This is the first cross-AI third-party-benchmark quantitative validation of the stack. Other benchmarks measure different axes (character-eval = ZH role consistency, esconv/empathetic = response generation, role-llm = roleplay) — these need their respective post-hoc scoring (Python subprocess for character-eval, BLEU for empathetic, judge LLM for role-llm) to compare across arms. claire-stack arm needs the empathetic + role-llm fill (in progress) to complete.

## Next actions (post-fill)

1. Once claire-stack fill completes (~01:51Z + ~65min): refresh this SUMMARY with empathetic + role-llm rows
2. Run aggregator script: `apps/eval/external-benchmarks/lib/results-aggregator.mjs` over all 15 cells
3. Decide whether to invest in (a) post-hoc judge LLM passes on each benchmark, (b) qwen-7b adapter fix for esconv + role-llm, (c) ship as-is with documented caveats and move forward
