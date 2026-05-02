# CharacterEval 12-metric subprocess runbook

**Status**: D blocked on local GPU + CharacterEval-Reward-7B model checkpoint (~14GB). Documenting handoff.

## Why P10 didn't run inline

CharacterEval (`apps/eval/external-benchmarks/vendor/character-eval/`) computes 12 character-consistency metrics via a custom 7B reward model loaded with `transformers==4.36.2 + torch==2.0.1` on CUDA hardware. P10 session ran on Mac (no CUDA GPU available locally). Our existing runner generated 77 character × 5 prompt answers via SiliconFlow Qwen-7B, but the official scoring requires the dedicated reward model.

## What our runner already produced

- 77/77 sample calls answered for all 3 arms (claire-stack / qwen-7b-raw / qwen-72b-raw)
- Saved as `apps/eval/external-benchmarks/results/character-eval-{arm}.json` with `sample_calls_answered: 77, metrics_pending_subprocess: 1`
- Per-call response NOT persisted in CharacterEval's expected `generation_trans_{model}.jsonl` shape — runner currently captures only the call count, not response bodies

## Two paths to close D

### Path A — Official CharacterEval scorer (preferred for credibility)

1. Run on a CUDA-capable host
2. Modify our runner to persist per-call response in `vendor/character-eval/results/generation_trans_claire_stack.jsonl` shape (see existing `generation_trans_qwen_7b.jsonl` for schema)
3. Run their `python -m run_char_rm` to score against CharacterEval-Reward-7B
4. Run `python compute_score.py`

Estimated effort: ~3hr setup + ~1hr inference per arm. Cost: GPU time only.

### Path B — LLM-judge approximation (~$5 budget, loses credibility)

Use Qwen-72B (or gpt-5.4-nano with cheaper budget) to score each response on the 12 axes via prompt-engineered judge. Loses third-party benchmark credibility but produces a directional comparison.

Recommended only if the headline `+71% BotChat humanlikeness` win is enough for v1.4 ship — CharacterEval was the secondary validation.

## Recommendation (P10 cut)

**Defer to v1.5 milestone.** v1.4 has BotChat (+71% humanlikeness) + ESConv coverage + EmpatheticDialogues coverage as the main quantitative validation. CharacterEval would add ZH role-consistency rigor but is non-blocking. Re-tackle when GPU host or BYO-judge budget approval lands.
