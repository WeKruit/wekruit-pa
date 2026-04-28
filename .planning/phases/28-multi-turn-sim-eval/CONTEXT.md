# Phase 28 — LLM-vs-LLM Dialog Simulation Eval — CONTEXT

**Owner P9:** P9-Sim-Eval (to be spawned; orthogonal to P9-SelfEvolve)
**Spawned:** 2026-04-28 by P10 strategic addition.
**ROADMAP entry:** v1.3 milestone table (alongside Phase 26 / 27).

## 底层逻辑

Phase 24 baseline = `golden-50` single-turn fixed-question eval. Real conversations are **multi-turn**, with mode switches (vent → celebrate → ask), memory scaffolding, and context accumulation. Single-turn eval cannot catch:

- Voice drift across 5+ turns when prompt budget is dominated by user content
- Mode-switch fluidity (does Claire pivot from vent-mode to celebrate-mode naturally, or robotically?)
- Probe regression (does the coach-mode probe come back at turn 6 once the few-shot anchors are out of attention?)
- 油腻 accumulation (per-turn rewriter may pass while the *cumulative* register feels saccharine)
- First-person opener density across turns (one self-anchor per turn is fine; ten is creepy)
- Memory scaffolding triggers (does Claire re-anchor to user-stated facts when the user references them later?)

Solution: an **N-round LLM-vs-LLM simulator**. One LLM plays the user (5 personas, each with system prompt + behavior rules). Claire plays Claire (existing orchestrator path). Run K turns alternately (default K=8). DeepEval `ConversationalGEval` judges the **whole transcript**.

This is orthogonal regression coverage. It's useful even pre-launch because it's a property test, not a labeled-data test — the personas are deterministic-ish, the scoring is rubric-driven.

## Relationship to Phase 24 / 25 / 27

| Phase | What it covers | Phase 28 relation |
|---|---|---|
| 24 baseline | Single-turn rubric on golden-50 | Phase 28 reuses judges + threshold infra |
| 25 review dashboard | Human-rated single turns | Orthogonal — sim-eval doesn't need human labels |
| 27 self-evolve cron | Reads human reviews → Bible patches | Phase 28 runs as additional CI gate; if a self-evolve patch breaks multi-turn voice, sim-eval catches it where golden-50 wouldn't |

Phase 28 can run **before** Phase 27 self-evolve cron unlocks. It doesn't depend on the gate. Land it whenever bandwidth allows — gives extra coverage immediately.

## 5 user personas (locked spec — P9 may refine wording, not roster)

| Persona id | Profile | Behavior rule (1-line) | Opening style |
|---|---|---|---|
| `anxious_grad` | Grad student job-hunting, low confidence | Always ends turn with a follow-up question; spirals if Claire is too breezy | "claire 我又被拒了 😭" |
| `formal_em` | Senior eng manager, register-rigid | Uses 您, full sentences, tries to maintain register even when Claire is casual; pivot test | "你好 想问下 …" |
| `chatty_curious` | Tech-curious peer, rambles | 3-4 sentence turns; jumps topic mid-stream; uses zh-en mix | "卧槽 你看那个 a16z 的新 podcast 没" |
| `vent_seeker` | Just had a bad day, wants sit-with not solve | Vents, rejects suggestions explicitly ("不要安慰我"); tests anti-coach | "今天太烂了 不想上班" |
| `hype_announcer` | Got good news, wants celebration | Short bursty turns; tests Claire's celebrate-mode (not deflection, not lukewarm) | "我 offer 拿了!!" |

Each persona has:
- `systemPrompt` (~150 tokens)
- `openingMessage`
- `behaviorRules[]` — 3-5 rules
- `expectedClaireMode` per turn (vent / celebrate / ask / chat) — used by judge to score mode-switch fluidity

## Multi-turn metrics (DeepEval `ConversationalGEval` extension)

5 metrics judged on the full transcript (not per-turn):

1. **VoiceConsistency** — does Claire's voice (tone, slang, length cap) hold across 8 turns?
2. **ModeSwitchFluidity** — when persona pivots vent→celebrate→ask, does Claire pivot with them naturally?
3. **NoProbeRegression** — does the coach-mode probe come back after turn 4? (Pass if zero `我建议你 / Maybe you should` appearances.)
4. **NoOilinessCumulative** — register doesn't drift saccharine. Pass if no 接住你 / hold space / saccharine emoji escalation.
5. **FirstPersonOpenerDensity** — first-person openers (我 / I) appear in ≤30% of Claire turns. (Voice anchor exists but isn't crowding.)
6. **MemoryScaffoldingTrigger** — when persona references an earlier-stated fact (e.g. "上次说的那个 PM"), Claire acknowledges it without re-asking.

Score per `(persona × metric)` cell. Target ≥3.5/5 (0.7 normalized) average.

## Architectural decisions (locked)

- **Persona LLM** = same gpt-5.4-nano (Adam-locked model). System prompt + temperature 0.8 simulates a real-ish user. No external persona model.
- **Claire side** = existing orchestrator path via in-process import. No HTTP round-trip; simulator instantiates the orchestrator and feeds turns.
- **K turns default = 8.** Configurable per scenario file.
- **Persistence** = `pa_voice_sim_runs/{runId}` Firestore collection with full transcript + per-metric scores + persona id + Bible version snapshot.
- **Dashboard tab** = `/voice` page gets a new "N-round Sim Eval" tab listing runs, drill into transcript, per-turn judge scores.
- **CI integration** = run on PR with label `run-voice-sim` (similar to existing `voice-eval` workflow). Not on every PR — runs are slow + costly.

## Out-of-scope (forever)

- ❌ More than 5 personas in v1 (add later if coverage gap proven)
- ❌ Real human users in the simulator — purely LLM-vs-LLM
- ❌ Auto-failing the build below threshold for arbitrary PRs (label-gated only)
- ❌ Model upgrade for the persona side (gpt-5.4-nano locked, same as production)
- ❌ Persona-LLM replaying real user data (privacy + leakage risk)

## Dependencies

- `apps/eval/voice/judges/claude_judge.py` + `openai_nano_judge.py` (Phase 24, complete)
- `apps/eval/voice/test_voice_baseline.py` (Phase 24, complete) — paradigm reference
- Existing orchestrator entry point that accepts a turn + returns Claire's reply (already used by golden-50)
- `pa_voice_reviews` schema NOT required (phase 28 doesn't write to it; orthogonal)
- Phase 24.5 feature flag SDK NOT required (sim-eval is dev/CI only, not runtime-gated)

## Success criteria (target state)

1. 5 personas defined in `packages/pa-orchestrator/src/eval/sim-personas/` with system prompts + opening message + behavior rules
2. Simulator runner orchestrates persona-LLM × Claire alternately for K=8 turns; captures full transcript
3. DeepEval `ConversationalGEval` extended to multi-turn with 6 metrics above
4. Per-(persona × metric) cell scored ≥3.5/5 average across 5×6 = 30 cells
5. Results persisted to `pa_voice_sim_runs/{runId}` Firestore
6. Dashboard `/voice` "N-round Sim Eval" tab lists runs, drills into transcript with per-turn judge scores
7. CI workflow `.github/workflows/voice-sim.yml` runs sim-eval when PR has `run-voice-sim` label

## Estimated time

~3.5 dev-day. Single P8 sequential (no parallel paths — each task feeds the next).

## Spawn checklist

- [ ] Adam approves persona roster (5 personas above) — minor wording refinements OK
- [ ] Adam confirms K=8 default
- [ ] Adam confirms ≥3.5/5 target threshold
- [ ] Adam confirms label-gated CI (not always-on)
- [ ] P9 writes Task Prompts per sub-task (T1-T5)
- [ ] P9 spawns 1 P8 sequential (T1 → T2 → T3 → T4 → T5)
