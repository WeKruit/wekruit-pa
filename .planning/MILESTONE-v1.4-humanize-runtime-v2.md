# Milestone v1.4 — Humanize-Runtime v2 (Bilingual, Eval-First)

**Spawned:** 2026-04-29 after v1.3 P10 cut. Replaces earlier v1.4 drafts (DIAGRAM-PROMPT, RESEARCH-PROMPT, NARRATIVE, humanize-runtime.md).

**Goal in one sentence:** On Qwen-7B + no-finetune + Bible-driven path, push Claire's bilingual (zh+en) conversational humanness to **70-80% of Pi-level** by attacking 4 production failure modes with deterministic detectors + ImperfectionInjector + ESConv-FSM + memory policy — **eval-first**, 0 net new LLM calls in production path.

**Estimate:** ~7.5 dev-days (8 phases, 33-40).

---

## Why this milestone

Two independent Deep Research reports (Compass + DR-2) cross-validated the original v1.4 architecture and converged on:
- Verdict: **PROCEED-WITH-MODIFICATIONS** (both reports independently)
- Critical: drop Reflexion-lite critic loop (5 peer-reviewed papers show LLM-as-judge bias on subjective style amplifies the same failures it tries to fix)
- Critical: Plutchik decorative-not-load-bearing for Chinese (no clean mapping for 委屈/心疼/心累/不甘)
- Critical: 9-LLM-call worst case unrealistic at SiliconFlow tail latencies vs 12s p99 budget
- Confirmed: explicit affect/state control beats free-running generation (XiaoIce MDP CPS=23, FiSMiness beats Self-Refine on ESConv)
- Confirmed: Mem0 within noise vs Letta/Zep on LoCoMo; backend swap not justified

**Eval-first ordering** (user explicit decision 2026-04-29): no runtime module work until baseline 5-metric report is locked. This is the architectural commitment — every module merge is gated by quantitative improvement vs Phase 34 baseline.

---

## 5 success metrics (target → measure pre + post)

| # | Metric | Baseline | Target | Measurement |
|---|--------|----------|--------|-------------|
| 1 | AI tell-tale rate (`作为AI` / `as an AI` / template openers) | TBD Phase 34 | < 1% | regex on 1000-turn synthetic + filler-blacklist |
| 2 | 50-turn drift score (F1 mirror + F4 repeat compounded) | TBD Phase 34 | > 50% reduction | drift-score.mjs over 50-turn synthetic run |
| 3 | Tone shift hit rate (user emotion shift → Claire tone shift) | TBD Phase 34 | > 70% | strategy_fit axis (LLM judge) on 100-turn labeled |
| 4 | Length compliance (>3 sentences per turn) | TBD Phase 34 | < 10% | sentence-cap detector on outputs |
| 5 | Repeat advice rate (BGE-M3 cos-sim > 0.85 vs last 3 Claire turns) | TBD Phase 34 | < 5% | advice-repeat detector |

**External validation** (Phase 39): Claire ≥ Qwen-72B raw on at least 1 of 5 public benchmarks (BotChat / CharacterEval / EmpatheticDialogues / ESConv / RoleLLM).

---

## Decision Log (16 P10 decisions, locked — do not re-litigate)

| ID | Decision | Why |
|----|----------|-----|
| D1 | Drop Reflexion-lite critic loop default path | Huang ICLR2024 + Xu 2402.11436 + Hu 2407.01085 + Wataoka 2410.21819 + Feuer SOS-Bench: LLM judge bias on subjective style amplifies F2/F4 |
| D2 | Plutchik demoted to internal scaffold; use 大连理工 7-class 21-subclass for ZH, GoEmotions for EN | Chinese affect words (委屈/心疼/心累/不甘) have no clean Plutchik mapping; Lingua Sinica research |
| D3 | ImperfectionInjector via 3-arm A/B (0/15/30%), position-constrained turn-onset only | Lameris 2412.12710 over-produces 77% even fine-tuned; Pinguet 2023 mid-clause reduces confidence |
| D4 | Crisis routing via Bible prompt section, no separate classifier | FTC complaint Replika + Senate inquiry Character.AI = regulatory liability if missing; prompt is sufficient |
| D5 | Mem0 keep, pin extractor to Qwen-7B+ tier | Mem0/Letta/Zep dispute = noise; extractor model bounds Chinese affect quality |
| D6 | FiSMiness baseline arm in eval harness | Zhao 2504.11837 single-call FSM beats Self-Refine on ESConv — must control for it |
| D7 | Add SiliconFlow prefix cache | Verified no existing prompt cache (`atm-llm-runtime.ts` cache is profile credentials only); ~20-40% latency win at zero quality cost |
| D8 | No new monorepo package; extend `packages/pa-orchestrator/src/voice/` | YAGNI — module scope fits in existing voice/ subdir |
| D9 | Bilingual focus zh + en + mixed (not Chinese-only) | Claire users = bilingual zh+en + slang; English coverage non-negotiable |
| D10 | Borrow ESConv 8 strategies + TransESC transition graph + genagents reflection pattern | Verified open repos: thu-coai/Emotional-Support-Conversation, circle-hit/TransESC, joonspk-research/genagents |
| D11 | Chinese affect lexicon = 大连理工 7-class 21-subclass | Replaces western Plutchik claim; standard ZH sentiment taxonomy |
| D12 | Length cap = prompt directive + post-gen detector strip (no regenerate) | Cheaper than regenerate; preserves user-facing latency |
| D13 | Eval harness lives in `tests/scenarios/` (extend existing) | Verified: runner.mjs + pairwise-runner.mjs + judge.mjs + voice-axes.mjs already exist; reuse not rebuild |
| D14 | Embedding stack = `BAAI/bge-m3` via SiliconFlow | Already wired in `packages/memory/src/mem0.ts` (DEFAULT_EMBED_MODEL); multilingual + free; matches OpenAI text-embedding-3-large on MIRACL |
| D15 | All 5 external auto benchmarks run | BotChat (open-compass) + CharacterEval + EmpatheticDialogues + ESConv + RoleLLM; ~$25 total |
| D16 | Eval-first phase ordering — harness + baseline before any runtime module | User explicit 2026-04-29: no module merges until baseline locked |

---

## Hard constraints (Adam-locked, non-negotiable)

- Stack: TypeScript / Node / Firebase Cloud Functions
- Model: Qwen-7B class via SiliconFlow OpenAI-compat (no escalation to Sonnet/Opus)
- No fine-tuning (no anchor data yet)
- Memory: Mem0 (vendor-neutral interface), embedding via `BAAI/bge-m3`
- Per-turn budget: < 12s p99
- Production path: 0 net new LLM calls vs current architecture
- No LangGraph, no DSPy import, no Reflexion-lite critic loop
- No new monorepo package — extend `packages/pa-orchestrator/src/voice/`

---

## Out of Scope / Backlog (explicit deferrals)

- **Jones & Bergen 2024 5-min Turing test human-rater replication** — ~$300 + 7d, demographic mismatch (MTurk Western vs Chinese mobile users); revisit v1.5
- **TexturePool recruitment** (10-user × 2h interview protocol) — defer to v1.5
- **Big5-Chat trait scoring engineering** — Claire persona sufficient for v1.4
- **Reflexion-lite critic resurrection** — would need new evidence not in current literature
- **LoCoMo memory benchmark** — repo offline as of 2026-04; revisit if reappears
- **Texture pool 250 hand-curated facts** — defer to v1.5
- **EvoEmo full GA training pipeline** — borrowed MDP abstraction only, not training apparatus
- **Plutchik 8-dim layer engineering** — internal scaffold only; FSM 5-state + ESConv 8-strategy is the actual control surface

---

## Phase Roadmap (8 phases, 33-40)

| # | Phase | Goal | Quantitative Gate (no merge unless met) | Days |
|---|-------|------|----------------------------------------|------|
| 33 | Eval Harness Extension | 4 new axes (drift_resistance, length_compliance, advice_novelty, strategy_fit) wired into existing voice-axes.mjs + 5 new scenario YAMLs | All 4 axes return numeric scores on existing 20 scenarios; bilingual sentence splitter unit-tested | 1.5 |
| 34 | Baseline Measurement | Run all eval scenarios + sim-audit on rev-00056, lock 5-metric report | `.planning/baseline-rev00056.md` committed with 5 metric numbers + per-phase gates | 0.5 |
| 35 | 4 Deterministic Detectors (F1-F4 bilingual) | Verb-mirror n-gram + length cap + lang-lock + advice-repeat (BGE-M3 cos-sim) | Detector recall ≥ 80% on rev-00056 known fails; false positive rate ≤ 10% | 1.5 |
| 36 | ImperfectionInjector + 3-arm A/B | 0/15/30% firing arms, turn-onset only, bilingual policies (zh + en) | A/B winner determined via pairwise-runner statistical significance; chosen arm beats 0% baseline on humanness axes | 1 |
| 37 | FSM (5 UX × ESConv 8 strategies) | State classifier + transition table + Phase 3 prompt directive | ux_state classifier accuracy ≥ 70%; strategy_fit ∈ allowed-set 100% | 1 |
| 38 | Memory Policy (advice-tracker + contradiction) | BGE-M3 advice tracker + contradiction detector + Phase 3 context injection | 50-turn synthetic advice repeat rate < 5%; contradiction detector ≥ 90% on seeded fixtures | 1 |
| 39 | External Auto Benchmarks (5 benchmarks) | BotChat + CharacterEval + EmpatheticDialogues + ESConv + RoleLLM, Qwen-7B raw vs Claire stack | Claire stack ≥ Qwen-72B raw on ≥ 1 of 5; total spend ≤ $25 | 1 |
| 40 | Bible v7.5 + Crisis Red-team + Ship | Bilingual NEVER + slang bank + crisis prompt + 3-sentence directive + feature flag | 20 crisis red-team prompts → safety branch 100%; final audit — all 5 metrics meet target vs Phase 34 baseline | 1 |

**Total: ~7.5 dev-days.**

---

## Reuse manifest (verified existing assets)

| Asset | File | Use |
|-------|------|-----|
| Scenario runner | `tests/scenarios/runner.mjs` | Run scenarios via Firestore broker |
| Pairwise A/B runner | `tests/scenarios/pairwise-runner.mjs` | A/B compare baseline vs candidate prompts |
| LLM judge | `tests/scenarios/judge.mjs` | gpt-5.4-nano structured-verdict judge with cost ledger |
| Voice axes rubric | `tests/scenarios/lib/voice-axes.mjs` | warmth_no_sycophancy + in_character_voice + 33 zh + 15 en filler blacklist |
| Pairwise lib | `tests/scenarios/lib/pairwise.mjs` | Position-bias mitigation via swap |
| Existing scenarios | `tests/scenarios/scenarios/eval-voice-*.yaml` | 20+ scenarios including bilingual voice + persona drift |
| Mem0 wiring | `packages/memory/src/mem0.ts` | Already configured with `BAAI/bge-m3` + Qwen via SiliconFlow |
| Sim users | `/tmp/sim-{en,zh,mixed}.json` | Bilingual personas for stress test |

---

## External research repos (verified 200 OK)

| Repo | What | Borrow |
|------|------|--------|
| [thu-coai/Emotional-Support-Conversation](https://github.com/thu-coai/Emotional-Support-Conversation) | ESConv ACL 2021 — 8 strategies + 3 stages | Strategy enum + dataset |
| [circle-hit/TransESC](https://github.com/circle-hit/TransESC) | ACL 2023 — turn-level emotion transition | Transition graph design |
| [joonspk-research/genagents](https://github.com/joonspk-research/genagents) | NeurIPS 2024 — 1000-agent simulation | Reflection module pattern |
| [open-compass/BotChat](https://github.com/open-compass/BotChat) | Bilingual LLM-judged Turing-style auto | Phase 39 baseline |
| [morecry/CharacterEval](https://github.com/morecry/CharacterEval) | Chinese 77-character role-play, 12 metrics | Phase 39 |
| [InteractiveNLP-Team/RoleLLM-public](https://github.com/InteractiveNLP-Team/RoleLLM-public) | English 100-character role-play | Phase 39 |
| [facebookresearch/EmpatheticDialogues](https://github.com/facebookresearch/EmpatheticDialogues) | English 25k empathy convs | Phase 39 |

---

## Realistic ceiling (set expectations honestly)

| ❌ Won't achieve | ✅ Will achieve |
|-----------------|----------------|
| Pi / Replika unbounded humanness | ~70-80% of Pi-level on 5 quantified metrics |
| Pass classical Turing test | Beat Qwen-7B raw on humanness benchmarks |
| One-shot perfection | A/B-data-driven 1-2 iteration cycles |
| 0 latency increase | +50-100ms (detectors fast but non-zero) |
| ImperfectionInjector guaranteed effective | A/B may show 0% control wins — also a valid result |

---

## Refs (canonical research files for this milestone)

- `MILESTONE-v1.4-humanize-runtime-NARRATIVE.md` — original architecture narrative (superseded by this doc but kept for context)
- `MILESTONE-v1.4-RESEARCH-PROMPT.md` — Deep Research prompt sent for cross-validation
- Compass cross-validation report (~/Downloads/compass_artifact*.md) — independent peer review
- Deep-research-report.md (~/Downloads) — second independent peer review

Both reports converged on PROCEED-WITH-MODIFICATIONS verdict; v1.4 v2 incorporates all critical recommendations.
