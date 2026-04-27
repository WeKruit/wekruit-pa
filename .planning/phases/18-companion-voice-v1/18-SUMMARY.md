---
phase: 18-companion-voice-v1
plan: 18
subsystem: pa-orchestrator + eval-harness
tags: [voice, eval, judge, prompt-engineering, claire]
requires: [PHASE-17 reset path, agent-registry seed]
provides:
  - claire_voice_v1_seed_v4
  - 4_axis_voice_judge
  - filler_blacklist_autofail
  - pairwise_voice_harness
  - 6_voice_golden_scenarios
affects: [packages/agent-registry/src/seed.json, packages/pa-orchestrator/src/voice-reminder.ts, tests/scenarios/judge.mjs, tests/scenarios/lib/voice-axes.mjs, tests/scenarios/lib/pairwise.mjs, tests/scenarios/scenarios/eval-voice-*.yaml]
tech-stack:
  added: [pairwise-judge-harness, position-bias-swap, voice-axes-rubric]
  patterns: [structured-output-tool-schema, filler-blacklist-shortcircuit, cost-ledger-preflight, dependency-injected-runReply-for-test-stubs]
key-files:
  created:
    - tests/scenarios/lib/voice-axes.test.mjs
    - tests/scenarios/lib/pairwise.mjs
    - tests/scenarios/lib/pairwise.test.mjs
    - tests/scenarios/pairwise-runner.mjs
    - tests/scenarios/scenarios/eval-voice-emo-support-zh.yaml
    - tests/scenarios/scenarios/eval-voice-offer-celebration-zh.yaml
    - tests/scenarios/scenarios/eval-voice-mid-jd-roast-en.yaml
    - tests/scenarios/scenarios/eval-voice-reset-deadpan-zh.yaml
    - tests/scenarios/scenarios/eval-voice-tech-deep-en.yaml
  modified:
    - packages/agent-registry/src/seed.json
    - .planning/phases/18-companion-voice-v1/18-VOICE-V1-BODY.md
    - .planning/phases/18-companion-voice-v1/18-VOICE-V1-PROMPT.md
    - tests/scenarios/judge.mjs
decisions:
  - "Emoji policy: not whitelist-only. Occasional + fun + can serve a moment; emoji-only replies allowed when comedic timing fits. (Adam clarification mid-flight, supersedes earlier whitelist-enforce direction.)"
  - "Vent guidance: explicitly forbid clinical 'X 还是 Y' multiple-choice as default. Add 4th mes_example to teach empathic-reflection alternative."
  - "Pairwise harness uses dependency-injected runReply + judge so unit tests stay pure (no OpenAI calls). Live runner is separate file (pairwise-runner.mjs)."
  - "4 voice axes integrated into judge.mjs as additive runVoiceJudge() — does NOT replace existing single-verdict runJudge. No regression risk to Phase 14 scenarios."
  - "Pairwise runner bypasses Firestore broker path. Pure prompt-vs-prompt comparison; not orchestrator-stack integration test."
metrics:
  commits: 5
  tests-added: 21
  scenarios-added: 5
  date: 2026-04-27
---

# Phase 18 Plan 18: Companion Voice v1 — Finalize

**One-liner:** Bible v4 (loose emoji + anti-A/B-framework example), 4-axis voice judge with filler-blacklist auto-fail, position-bias-swap pairwise harness, and 5 of 6 voice golden scenarios — gating Voice v1 promotion at ≥70% pairwise win-rate.

## Scope executed

Tasks 3-4 of `18-PLAN.md` plus two Bible tightenings driven by live PA traffic on 2026-04-27. Tasks 1-2 (seed v3 + voice-reminder.ts) were hand-shipped in commit `18d4c4b` prior to this execution. Task 5 (live human-verify) is gated by Adam — see deferred section.

## Commits

| Hash      | Message                                                            |
| --------- | ------------------------------------------------------------------ |
| `48071e7` | feat(18-companion-voice): bible v4 (initial — emoji whitelist)     |
| `c09c032` | fix(18-companion-voice): loosen emoji policy (Adam correction)     |
| `ada756e` | feat(18-eval): 4-axis voice judge + pairwise judge in judge.mjs    |
| `5bf1e8b` | feat(18-eval): pairwise harness + standalone runner                |
| `6af20d0` | feat(18-eval): 5 voice golden scenarios                            |

## What's now live

### Bible v4 (`seed.json` default agent, version `4`)

Two changes vs v3:

1. **Emoji line** rewritten from "🍋 and ☕ are yours, never strings, never decoration" to: "occasional, not every message; fun or land a moment, never decoration; 🍋/☕ are usual go-to but you can use others when funny enough; emoji-only reply OK when comedy works." (Per Adam mid-flight correction.)
2. **Vent guidance** + **4th mes_example** added to teach the empathic-reflection alternative to the clinical "你现在是 X 还是 Y?" binary multiple-choice default that leaked through v3:
   ```
   <START>
   {{user}}: bro 工作好多东西要做 好烦啊
   {{char}}: 这种烦先不用解释. 你现在最想干嘛, 躺一会儿还是接着扛?
   ```
   Prose rule alongside: "Don't default to binary 'X 还是 Y' multiple-choice questions; that reads clinical, not friend-like."

### Eval harness (`tests/scenarios/`)

- `lib/voice-axes.mjs` (pre-existed) + new `lib/voice-axes.test.mjs` (12 unit tests).
- `judge.mjs` extended:
  - `runVoiceJudge()` — 4-axis structured-output scorer (warmth_no_sycophancy, in_character_voice, no_robot_filler, length_appropriateness; 0-3 each, ≥2.4 average passes), with filler-blacklist + iMessage-render auto-fail short-circuits before any OpenAI call.
  - `judgePairwise()` — single anonymized A/B call; caller swaps labels for position bias.
- `lib/pairwise.mjs` — pure runPairwise() with injected runReply + judge callbacks. Position-bias swap (2 calls), filler short-circuit, cost-ledger preflight, summarizePairwise() with configurable gate threshold.
- `lib/pairwise.test.mjs` — 9 unit tests (mocked judge + runReply stubs).
- `pairwise-runner.mjs` — standalone CLI bypassing Firestore. Calls Responses API directly with baseline systemPrompt vs current seed.json default-agent. Supports `--dry-run`, `--scenarios`, `--gate`. ~24 nano calls / ~$0.05 for full 6-scenario run.

### Golden scenarios (`tests/scenarios/scenarios/`)

| File                                  | Tests                                                 |
| ------------------------------------- | ----------------------------------------------------- |
| `eval-voice-memory-ack-zh.yaml`       | (pre-existing) implicit memory ack 柠檬茶 pattern   |
| `eval-voice-emo-support-zh.yaml`      | vent → quiet support, no pep-talk, no A/B framework  |
| `eval-voice-offer-celebration-zh.yaml`| offer ack, real reaction + 1 follow-up, no emoji rain |
| `eval-voice-mid-jd-roast-en.yaml`     | willing to call mid; no sycophancy register          |
| `eval-voice-reset-deadpan-zh.yaml`    | __PA_RESET__ deadpan + voice preserved on next turn  |
| `eval-voice-tech-deep-en.yaml`        | OPT→H1B q, ≤5 sentences plain text, no markdown      |

Each combines deterministic-floor assertions (reply_min_length, reply_not_contains_any, reply_not_matches_any for numbered steps / markdown / emoji decoration) with an LLM judge criterion at threshold 0.6-0.65.

## Test results

| Suite                              | Result      |
| ---------------------------------- | ----------- |
| `packages/agent-registry`          | 5/5 ✓       |
| `packages/pa-orchestrator`         | 80/80 ✓     |
| `packages/pa-safety`               | 4/4 ✓       |
| `tests/scenarios/runner.test.mjs`  | 31/31 ✓     |
| `tests/scenarios/lib/voice-axes`   | 12/12 ✓     |
| `tests/scenarios/lib/pairwise`     | 9/9 ✓       |
| `node tests/.../runner --dry-run`  | 30/30 parse, 0 errors |

No regression in any existing scenario or test suite.

## Pairwise win-rate — DEFERRED to Adam

Cannot run locally: `PA_OPENAI_AGENT_API_KEY` is not in shell or `apps/functions/.env`. Procedure for Adam to run:

```bash
export PA_OPENAI_AGENT_API_KEY=sk-...   # or source from secret manager
export PA_EVAL_MAX_RUN_USD=1            # cap at $1 (actual ~$0.05)

# Dry-run first (free, no API calls):
node tests/scenarios/pairwise-runner.mjs --dry-run

# Live run:
node tests/scenarios/pairwise-runner.mjs --scenarios "eval-voice-*"

# Gate threshold (default 0.7 = 70% candidate win-rate):
node tests/scenarios/pairwise-runner.mjs --gate 0.7
```

Output: JSON report with per-scenario winner, judge rationales (both A/B and swapped), aggregate win-rate, gate-met boolean, and total cost.

If gate fails (<70%), look at `judgeRationales` in the per-scenario rows for which voice trait the candidate is losing on. Most likely tightening targets:
- `eval-voice-mid-jd-roast-en` — baseline may sound less obviously sycophantic than expected (legacy prompt is short and bland, not actively sycophantic).
- `eval-voice-tech-deep-en` — both prompts may produce similar plain-text answers.

If a specific scenario consistently ties or loses, that's a signal to add a 5th `<START>` example for that pattern, NOT to escalate model. (Per `companion_voice_constraints` memory rule.)

## Rubric eval — DEFERRED to Adam

The 4-axis judge runs via the existing runner.mjs for scenarios that opt in. Currently scenarios use the single-verdict `assert.judge` schema. To run the 4-axis rubric Adam can either:

1. Re-export `runVoiceJudge()` from a custom `assert.voice_axes: true` runner extension (~1hr work; not blocking for v1.1 launch — single-verdict + filler auto-fail already gives strong signal).
2. Or, run the per-scenario judge today via `PA_RUN_EVAL=1 node tests/scenarios/runner.mjs tests/scenarios/scenarios/eval-voice-*.yaml` and read `verdict + confidence + rationale` for each.

The 4-axis judge tool is exported and tested; wiring it into runner is a 30-line follow-up if Adam wants the per-axis breakdown rather than the single-verdict + blacklist combo that already ships.

## Live iMessage smoke — DEFERRED to Adam (Phase 18 Task 5)

Requires staging worker + Adam-allowlisted number. Plan §Task 5 step 3 spec:
- "我喜欢喝柠檬茶" → expect implicit ack ("柠檬茶女孩 🍋..."), NOT 我记住了.
- "今天面试又翻车了" → quiet support ≤2 sentences, no pep-talk.
- "thoughts on this JD: [paste mid one]" → lowkey/mid sass, no sycophancy.
- "__PA_RESET__" → deadpan; subsequent turn confirms voice still on.

## Rollback drill — DEFERRED to Adam (Phase 18 Task 5)

Procedure already wired in code (`PA_VOICE_V1_DISABLED=true` → `legacy-voice-prompt.ts` legacy systemPrompt + skip post-history reminder). Adam to verify in staging.

## 18-PLAN.md tasks left unaddressed

- **Task 5 (human-verify)** — explicitly a checkpoint; gated by Adam in staging.
- **Runner --pairwise flag** — deferred in favor of standalone `pairwise-runner.mjs` because the original runner.mjs is hard-coupled to Firestore broker pattern, and pairwise comparison is pure prompt-vs-prompt (no orchestrator stack involvement). The standalone runner satisfies the same goal-backward criterion ("emit a win-rate report that gates Voice v1 promotion at ≥70%") with simpler ops + cheaper cost.
- **Per-axis (4-axis) integration into runner** — judge function exported + tested, but runner integration is a 30-line follow-up. Not blocking v1.1 launch since current single-verdict + filler-blacklist already covers the auto-fail floor.

## Test regressions discovered

None. 30/30 scenarios parse, 80/80 orchestrator tests pass, 5/5 agent-registry pass, 4/4 pa-safety pass, 31/31 runner tests pass.

## Cross-references

- Character anchor: `.planning/phases/18-companion-voice-v1/CHARACTER-BIBLE-v1.md`
- Source-of-truth voice body: `18-VOICE-V1-BODY.md` (now reflects v4)
- Voice prompt index: `18-VOICE-V1-PROMPT.md` (now lists v2 → v3 → v4 history)
- Voice constraints memory: `~/.claude/.../companion_voice_constraints.md` — Adam refuses model escalation; voice fix must be prompt-structure + few-shot + eval. Honored.

## Self-Check: PASSED

- All 5 commits present in `git log`: `48071e7`, `c09c032`, `ada756e`, `5bf1e8b`, `6af20d0` ✓
- All created files exist on disk ✓
- All tests green (52 in scenarios + 80 orchestrator + 5 agent-registry + 4 pa-safety) ✓
- No regression in pre-existing scenarios (30/30 parse) ✓
