# Voice Eval — Phase 24 / Milestone v1.2

Voice eval foundation for Phase 24 / Milestone v1.2 (Anti-油腻, Voice 拟人化).

## What This Is

A reusable 4-layer eval workspace (dataset × rubric × target × runner) using
[DeepEval](https://deepeval.com) ConversationalGEval. Default judge is
`gpt-5.4-nano` (same model as agent base — cost-gated default per Adam
2026-04-27). Override to `claude-opus-4-5` via `PA_VOICE_JUDGE=claude` when
ANTHROPIC_API_KEY is provisioned. Measures ClaireVoice pass-rate across
golden-50 labeled cases.

## Directory Structure

```
apps/eval/voice/
├── requirements.txt          # deepeval==3.9.8 + anthropic>=0.52 + instructor
├── conftest.py               # judge singleton, PA_RUN_EVAL guard, fixture loader
├── test_voice_baseline.py    # main pytest entry: golden-50 + ClaireVoice + NoCoachMode
├── judges/
│   └── claude_judge.py       # DeepEvalBaseLLM wrapper (claude-opus-4-5, LOCKED)
├── rubrics/
│   ├── _judge.yaml           # promptfoo judge model lock
│   ├── claire-voice.yaml     # 4-axis ClaireVoice promptfoo rubric
│   ├── length-2sent.js       # deterministic: ≤2 sentences
│   └── slang-coverage.js     # deterministic: verified 2026 slang presence
├── fixtures/
│   ├── golden-50.template.jsonl   # placeholder (3 rows) — replaced in plan 02
│   └── adversarial-100.jsonl     # LLM-generated coach-trigger queries (plan 02)
└── promptfoo/
    └── rewriter-ab.yaml      # A/B matrix: Qwen3-8B vs Qwen3.5-4B (future)
```

## Local Run

```bash
# 1. Install Python dependencies (one-time)
cd apps/eval/voice
pip install -r requirements.txt

# 2. Set required env vars (default judge = gpt-5.4-nano)
export OPENAI_API_KEY=sk-...
# (optional) export OPENAI_BASE_URL=https://your-gateway.example/v1

# 2b. To use claude-opus-4-5 judge instead:
# export PA_VOICE_JUDGE=claude
# export ANTHROPIC_API_KEY=sk-ant-...

# 3. Run full suite
PA_RUN_EVAL=1 deepeval test run test_voice_baseline.py -n 4

# 4. Run anchor regression cases only (~30s, cheaper)
PA_RUN_EVAL=1 deepeval test run test_voice_baseline.py -k regression-anchor
```

Or from repo root using the npm script:

```bash
pnpm test:voice
pnpm test:voice:anchors
```

## CI

Triggered by the `run-voice-eval` label on PRs. Daily cron at 04:30 UTC tracks drift.
See `.github/workflows/voice-eval.yml`.

**Fails when** ClaireVoice pass-rate drops below 75% (`CLAIRE_VOICE_THRESHOLD=0.75`).

## Cost Guard

50 cases × `claude-opus-4-5` as judge = small but real API cost per run (~$0.50-2.00
depending on reply length). NEVER run on every PR. Use the `run-voice-eval` label
(opt-in) or the daily cron for drift tracking.

## Judge Model — Switchable

Default: `gpt-5.4-nano` via `judges/openai_nano_judge.py` (selected when
`PA_VOICE_JUDGE` is unset or `nano`). Alt: `claude-opus-4-5` via
`judges/claude_judge.py` (selected when `PA_VOICE_JUDGE=claude`). Both model
IDs are HARDCODED — never use `latest` aliases.

Score distributions are NOT comparable across judges. When swapping the
default judge in CI, mark a milestone bump in eval history. See
`24-RESEARCH.md Pitfall 3` for model-ID drift risk.

Why nano default: cost-gated decision 2026-04-27. Trade-off: judge has
identical blind spots as agent base (both gpt-5.4-nano). Acceptable for v1.2
to prove eval loop works; revisit when ANTHROPIC_API_KEY is provisioned.

## Rewriter A/B

```bash
cd apps/eval/voice/promptfoo
npx promptfoo eval -c rewriter-ab.yaml
```

Note: `Qwen/Qwen3.5-4B` will 404 until SiliconFlow adds it to their catalog
(see `24-RESEARCH.md` critical finding 1). Default rewriter uses `Qwen3-8B`.
