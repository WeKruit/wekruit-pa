# CharacterEval 12-metric subprocess — execution attempt (v1.5 unblock)

**Status:** BLOCKED — three independent blockers confirmed. Cannot execute on this host. Defer remains warranted; this doc records what was tried and what's needed.

## Subprocess command attempted

The runner emitted (for `claire-stack` arm):

```
python -m characterval \
  --base-url=https://api.siliconflow.cn/v1 \
  --model=Qwen/Qwen2.5-7B-Instruct \
  --output-dir=results/character-eval-claire-stack \
  --num-chars=77 --prompts-per-char=5
```

This command is **not directly runnable**: the `characterval` Python module does not exist. The CharacterEval repo (`apps/eval/external-benchmarks/vendor/character-eval/`) provides four scripts, not a module:

1. `get_response.py` — read `data/test_data.jsonl` + `data/character_profiles.json`, generate per-row response, write `results/generation.jsonl`
2. `transform_format.py` — sparse-metric assignment via `data/id2metric.jsonl` → `results/generation_trans.jsonl`
3. `run_char_rm.py` — load **BaichuanCharRM** reward model (HuggingFace `morecry/BaichuanCharRM`), score every row, write `results/evaluation.jsonl`
4. `compute_score.py` — average per-metric to produce 12-metric scores

The runner's spec was a placeholder, not an end-to-end driver.

## 12 metric scores

**None produced.** Below is the schema this benchmark would have populated. Empty cells = blocked.

| Dimension | Metric (en) | Metric (zh) | claire-stack | qwen-7b-raw | qwen-72b-raw |
|---|---|---|---|---|---|
| Conversational ability | Fluency | 流畅性 | — | — | — |
| Conversational ability | Coherence | 一致性 | — | — | — |
| Conversational ability | Consistency | 连贯性 | — | — | — |
| Character consistency | Knowledge exposure | 知识暴露 | — | — | — |
| Character consistency | Knowledge accuracy | 知识准确率 | — | — | — |
| Character consistency | Knowledge hallucination | 知识幻觉 | — | — | — |
| Character consistency | Persona behaviour | 人设行为 | — | — | — |
| Character consistency | Persona utterance | 人设话语 | — | — | — |
| Role-playing attractiveness | Human-likeness | 拟人性 | — | — | — |
| Role-playing attractiveness | Communication skills | 交流技巧 | — | — | — |
| Role-playing attractiveness | Expression diversity | 表达多样性 | — | — | — |
| Role-playing attractiveness | Empathy | 共情能力 | — | — | — |

(Reference layout from CharacterEval paper §3.2, leaderboard cross-checked against `vendor/character-eval/Predefined Annotated Examples of CharacterEval.pdf`.)

## claire-stack vs qwen-7b-raw comparison

**Cannot be produced.** All three arms have only `sample_calls_answered = 77/77` from the JS runner. No `model_output` text was captured for any of the 385 calls per arm. See `apps/eval/external-benchmarks/results/character-eval-{arm}.json`.

## Blockers (full list)

### Blocker 1 — runner did not persist response bodies

`runners/character-eval.mjs` lines 91–108 generate 77 calls per arm with the prompt `角色 #${c+1}：请自我介绍一下。`, but only increments an `answered` counter; the `r.text` strings are discarded. The CharacterEval pipeline needs each row in the shape of `vendor/character-eval/results/generation_trans_qwen_7b.jsonl` (id / role / novel_name / context / model_output / metric_en / metric_zh, 8032 rows). What we generated cannot be rehydrated — the calls happened with a generic intro prompt, not the per-character contexts from `data/test_data.jsonl`. **Re-running the generation step is required**, against the real `test_data.jsonl` rows, not the placeholder prompt.

### Blocker 2 — no CUDA host

`run_char_rm.py` line 23 hardcodes `.cuda()` and line 33 `.cuda()` for input tensors. Local Python is `/Users/adam/anaconda3/bin/python` 3.11.4 with `torch 2.0.1` reporting `cuda=False, mps=True`. CharacterRM cannot be ported to MPS without code changes (Baichuan tokenization + custom kernel paths in `BaichuanCharRM/modeling_baichuan.py`).

### Blocker 3 — reward model not downloaded

`BaichuanCharRM/` directory does not exist under `vendor/character-eval/`. `~/.cache/huggingface/` does not exist either. The `morecry/BaichuanCharRM` checkpoint (~14 GB) would need a manual `huggingface-cli download` — out of scope for a Mac host that can't run it anyway.

## Path to unblock (for v1.5 sprint planning)

**Option A — official scorer (preferred, ~$0 LLM spend, GPU only).** Requires:

1. Patch `runners/character-eval.mjs` to load `vendor/character-eval/data/test_data.jsonl` and `character_profiles.json`, iterate per row, persist response bodies in the `generation_trans_*.jsonl` schema. Estimated +1 day eng, +~$1 SiliconFlow spend per arm at 8,032 rows × ~300 output tokens.
2. Provision a CUDA host (any 24 GB GPU — A10/A6000/4090/L4 sufficient for 7B bf16). Cloud burst e.g. RunPod A10G ~$0.40/hr × 2 hr = $0.80/arm.
3. `pip install -r vendor/character-eval/requirements.txt` (`transformers==4.36.2`, `torch==2.0.1`).
4. `huggingface-cli download morecry/BaichuanCharRM --local-dir vendor/character-eval/BaichuanCharRM`.
5. Run `get_response.py` → `transform_format.py` → `run_char_rm.py` → `compute_score.py` for each arm.

Total: ~1 dev-day + ~$3 cloud GPU + ~$3 SiliconFlow generation = **<$10 all-in**.

**Option B — LLM-judge approximation.** Same step 1, then judge each row with Qwen-72B against a 12-axis rubric. Loses third-party benchmark credibility, ~$5 budget, ~2 dev-days for rubric calibration. Not recommended unless v1.5 needs the directional comparison and step (3)–(5) is blocked further.

## Recommendation

Defer remains correct. v1.4 ship validation rests on BotChat (+71% humanlikeness) + ESConv + EmpatheticDialogues — none of which are CharacterEval-dependent. CharacterRM scoring should be scheduled as a half-sprint task in v1.5 once a CUDA host is available; budget GPU + SiliconFlow regen ≤ $10 per arm, total ≤ $30 across all three arms.

The `character-eval-{arm}.json` files in `apps/eval/external-benchmarks/results/` carry `metrics_pending_subprocess: 1` flags and remain accurate. No data needs to be invalidated; this doc supersedes the original `CHARACTEREVAL-RUNBOOK.md` only in capturing the third blocker (runner did not persist responses).

## Files referenced

- `apps/eval/external-benchmarks/runners/character-eval.mjs` (runner, lines 91–108 — non-persistence)
- `apps/eval/external-benchmarks/CHARACTEREVAL-RUNBOOK.md` (original deferral rationale)
- `apps/eval/external-benchmarks/vendor/character-eval/run_char_rm.py` (CUDA hardcode)
- `apps/eval/external-benchmarks/vendor/character-eval/data/test_data.jsonl` (8,032 rows we'd need to drive generation against)
- `apps/eval/external-benchmarks/results/character-eval-{claire-stack,qwen-7b-raw,qwen-72b-raw}.json` (JS-runner stub outputs, all `metrics_pending_subprocess: 1`)
