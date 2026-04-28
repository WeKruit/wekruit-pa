---
phase: 24-voice-quality-baseline
plan: 01
subsystem: testing
tags: [deepeval, promptfoo, claude-opus-4-5, qwen3-8b, siliconflow, github-actions, voice-eval]

# Dependency graph
requires: []
provides:
  - apps/eval/voice/ Python workspace with 4-layer architecture (dataset x rubric x target x runner)
  - ClaudeOpus45Judge locked to claude-opus-4-5 model ID via DeepEvalBaseLLM contract
  - ClaireVoice + NoCoachMode ConversationalGEval metrics with HITL-ready pass-rate gates
  - 4 rubrics: _judge.yaml (model lock), claire-voice.yaml (LLM-judge), length-2sent.js (deterministic), slang-coverage.js (deterministic)
  - promptfoo A/B config for Qwen3-8B vs Qwen3.5-4B comparison on SiliconFlow
  - GitHub Actions voice-eval.yml CI gate (opt-in via run-voice-eval label, daily cron)
  - pnpm test:voice + test:voice:anchors scripts in root package.json
  - golden-50.template.jsonl (3-row placeholder, real cases come in plan 02)
affects:
  - 24-02-golden-dataset (consumes fixture schema + judge wrapper)
  - 24-03-bible-v6 (eval runner gates Bible v6 regression)
  - 24-04-rewriter-v2 (promptfoo A/B harness)
  - 24-05-few-shot (eval runner for few-shot migration)
  - 24-06-telemetry (coach-token monitor needs eval foundation for false-positive rate)
  - 24-07-verification (final eval run uses this foundation)

# Tech tracking
tech-stack:
  added:
    - deepeval==3.9.8 (ConversationalGEval, DeepEvalBaseLLM)
    - anthropic>=0.52 (claude-opus-4-5 judge)
    - instructor>=1.0 (structured outputs for judge)
    - python-dotenv>=1.0 (local .env loading)
    - promptfoo (A/B harness, already in repo toolchain)
  patterns:
    - DeepEvalBaseLLM wrapper pattern for locked judge model (no `latest` aliases)
    - PA_RUN_EVAL=1 guard to prevent accidental Claude API spend on npm test
    - ConversationalTestCase with Turn[] for multi-turn voice eval
    - Deterministic JS rubrics (length, slang) layered with LLM-judge rubrics
    - Opt-in CI via PR label (run-voice-eval) never runs on every PR

key-files:
  created:
    - apps/eval/voice/requirements.txt
    - apps/eval/voice/conftest.py
    - apps/eval/voice/judges/__init__.py
    - apps/eval/voice/judges/claude_judge.py
    - apps/eval/voice/README.md
    - apps/eval/voice/test_voice_baseline.py
    - apps/eval/voice/rubrics/_judge.yaml
    - apps/eval/voice/rubrics/claire-voice.yaml
    - apps/eval/voice/rubrics/length-2sent.js
    - apps/eval/voice/rubrics/slang-coverage.js
    - apps/eval/voice/fixtures/golden-50.template.jsonl
    - apps/eval/voice/fixtures/adversarial-100.jsonl
    - apps/eval/voice/promptfoo/rewriter-ab.yaml
    - .github/workflows/voice-eval.yml
  modified:
    - package.json (added test:voice + test:voice:anchors scripts)

key-decisions:
  - "Judge locked to claude-opus-4-5 (hardcoded, no 'latest' alias) — model drift risk per 24-RESEARCH.md Pitfall 3"
  - "PA_RUN_EVAL=1 env guard prevents accidental Claude API spend during npm test / CI general runs"
  - "apps/eval/voice/ is NOT added to pnpm workspaces — eval is opt-in, never auto-runs"
  - "promptfoo A/B covers Qwen3-8B (working) + Qwen3.5-4B (404 until SiliconFlow adds it — expected)"
  - "ANTHROPIC_API_KEY GitHub secret provisioning deferred to plan 07 (verification phase)"
  - "ClaireVoice pass-rate threshold: 0.75 in CI, overridable via CLAIRE_VOICE_THRESHOLD env var"

patterns-established:
  - "Pattern: Locked judge model ID — always hardcode specific model version, never use aliases"
  - "Pattern: Opt-in eval CI — PR label gate (run-voice-eval) prevents Claude API spend on every PR"
  - "Pattern: Fallback fixture — test_voice_baseline.py falls back to golden-50.template.jsonl if golden-50.jsonl missing, so collection never breaks before HITL labeling"
  - "Pattern: 4-layer eval architecture — dataset x rubric x target x runner (all substitutable independently)"

requirements-completed:
  - VOICE-01

# Metrics
duration: 45min (T1-T3) + T4 checkpoint approval
completed: 2026-04-28
---

# Phase 24 Plan 01: Eval Foundation Summary

**DeepEval voice-quality regression net with ClaudeOpus45Judge, 4 rubrics, promptfoo A/B config, and opt-in GitHub Actions CI gate — all 13 files scaffolded, pnpm test:voice wired**

## Performance

- **Duration:** ~45 min (Tasks 1-3) + T4 human-verify checkpoint (approved by Adam)
- **Started:** 2026-04-28
- **Completed:** 2026-04-28
- **Tasks:** 4 (3 auto + 1 checkpoint:human-verify, approved)
- **Files modified:** 15 (14 created, 1 modified)

## Accomplishments

- Voice eval Python workspace at `apps/eval/voice/` with all 4 architectural layers ready
- `ClaudeOpus45Judge` wrapper locks `claude-opus-4-5` — no model drift mid-cycle
- `ClaireVoice` + `NoCoachMode` ConversationalGEval metrics capturing the core anti-油腻 rubric
- `voice-eval.yml` CI gate: opt-in via `run-voice-eval` label, daily cron at 04:30 UTC, fails on pass-rate < 75%
- `pnpm test:voice` and `pnpm test:voice:anchors` scripts wired in root `package.json`
- All future Wave 1 plans (03/04/05/06) can run target evals against this foundation immediately

## Task Commits

1. **Task 1: Scaffold apps/eval/voice/ workspace + Python deps + judge wrapper** - `7179a4e` (feat)
2. **Task 2: Rubrics + DeepEval test runner + promptfoo A/B config + adversarial fixtures** - `bd4bebe` (feat)
3. **Task 3: GitHub Actions voice-eval.yml CI gate** - `34e8ce2` (feat)
4. **Task 4: Adam confirms eval foundation scaffolding** - checkpoint approved (no code changes)

## File Tree

```
apps/eval/voice/
├── requirements.txt          # deepeval==3.9.8 + anthropic>=0.52 + instructor + pydantic + dotenv
├── conftest.py               # PA_RUN_EVAL=1 guard + ClaudeOpus45Judge singleton fixture
├── README.md                 # Local run + CI instructions + cost guard note
├── test_voice_baseline.py    # ClaireVoice + NoCoachMode ConversationalGEval parametrized test
├── judges/
│   ├── __init__.py
│   └── claude_judge.py       # ClaudeOpus45Judge(DeepEvalBaseLLM) locked to claude-opus-4-5
├── rubrics/
│   ├── _judge.yaml           # Judge model lock (claude-opus-4-5, temp 0, verified 2026-04-27)
│   ├── claire-voice.yaml     # LLM-rubric: full ClaireVoice criteria, threshold 0.7
│   ├── length-2sent.js       # Deterministic: pass if ≤2 sentences
│   └── slang-coverage.js     # Deterministic: informational slang hit (verified 2025-26 corpus)
├── fixtures/
│   ├── golden-50.template.jsonl  # 3-row placeholder (plan 02 replaces with real HITL labels)
│   └── adversarial-100.jsonl    # Empty placeholder (plan 02 Qwen3-8B generation)
└── promptfoo/
    └── rewriter-ab.yaml      # Qwen3-8B + Qwen3.5-4B A/B (4B will 404 until SF adds it)
```

## Files Created/Modified

- `apps/eval/voice/requirements.txt` — Python deps pinned (deepeval==3.9.8, anthropic>=0.52, instructor>=1.0)
- `apps/eval/voice/judges/claude_judge.py` — DeepEvalBaseLLM wrapper, claude-opus-4-5 hardcoded
- `apps/eval/voice/conftest.py` — PA_RUN_EVAL=1 guard, ANTHROPIC_API_KEY check, JUDGE singleton
- `apps/eval/voice/test_voice_baseline.py` — pytest entry with ClaireVoice + NoCoachMode metrics
- `apps/eval/voice/rubrics/_judge.yaml` — model lock file (reference for promptfoo configs)
- `apps/eval/voice/rubrics/claire-voice.yaml` — LLM-rubric with full ClaireVoice criteria
- `apps/eval/voice/rubrics/length-2sent.js` — deterministic sentence-count rubric
- `apps/eval/voice/rubrics/slang-coverage.js` — deterministic slang-coverage rubric (telemetry only)
- `apps/eval/voice/fixtures/golden-50.template.jsonl` — 3-row placeholder JSONL
- `apps/eval/voice/fixtures/adversarial-100.jsonl` — empty placeholder (comment header)
- `apps/eval/voice/promptfoo/rewriter-ab.yaml` — Qwen3-8B + Qwen3.5-4B A/B config
- `apps/eval/voice/README.md` — workspace docs with cost guard note
- `.github/workflows/voice-eval.yml` — CI gate (opt-in label + daily cron)
- `package.json` — added test:voice + test:voice:anchors scripts

## Decisions Made

- **Judge locked to `claude-opus-4-5`** — hardcoded in both `claude_judge.py` and `_judge.yaml`; no `latest` aliases per 24-RESEARCH.md Pitfall 3 (model drift risk).
- **`PA_RUN_EVAL=1` guard** — prevents accidental Claude API spend when running `npm test` in CI or local dev.
- **`apps/eval/voice/` NOT in pnpm workspaces** — eval is explicitly opt-in; auto-running on every `pnpm install` would be wrong.
- **Qwen3.5-4B expected 404** — documented in promptfoo config header; plan 04 uses Qwen3-8B as default.
- **`ANTHROPIC_API_KEY` secret deferred to plan 07** — workflow YAML exists and is valid; first green CI run waits on secret provisioning.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Outstanding / Next Steps

- **`ANTHROPIC_API_KEY` GitHub secret** — not yet provisioned in GitHub Actions. Deferred to plan 07 (verification phase). Workflow YAML is valid; first green CI run waits on secret.
- **`golden-50.jsonl`** — placeholder template only. Plan 02 (this plan) populates with real Adam-labeled cases.
- **Baseline ClaireVoice pass-rate** — not yet recorded. Will be captured after plan 02 HITL labeling + `pnpm test:voice:anchors`.
- **Qwen3.5-4B** — 404 until SiliconFlow adds it to catalog. Qwen3-8B is the working default for plans 03/04.

## User Setup Required

None for this plan. (Secret provisioning deferred to plan 07.)

---
*Phase: 24-voice-quality-baseline*
*Completed: 2026-04-28*
