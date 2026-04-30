---
gsd_state_version: 1.0
milestone: v1.4
milestone_name: Humanize-Runtime v2 (Bilingual, Eval-First)
status: defining_requirements
last_updated: "2026-04-29T17:00:00.000Z"
last_activity: 2026-04-29
progress:
  total_phases: 8
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
---

# Milestone state

## Active milestone: v1.4 — Humanize-Runtime v2 (spawned 2026-04-29)

See [`MILESTONE-v1.4-humanize-runtime-v2.md`](./MILESTONE-v1.4-humanize-runtime-v2.md).

**Goal:** Push Claire's bilingual (zh+en) conversational humanness to ~70-80% of Pi-level on 5 quantified metrics by attacking 4 production failure modes (verb-mirror / length escalation / code-switch drift / self-repeat advice) via deterministic detectors + ImperfectionInjector + ESConv-FSM + memory policy. Eval-first: no module work until baseline locked. 0 net new LLM calls in production path.

**Status:** Defining requirements (REQUIREMENTS.md + ROADMAP.md being written).

**Phases:** 29 (Eval Harness Extension) → 30 (Baseline Measurement) → 31 (Detectors) → 32 (ImperfectionInjector A/B) → 33 (FSM) → 34 (Memory Policy) → 35 (External Auto Benchmarks) → 36 (Bible v7.5 + Ship).

**Estimate:** ~7.5 dev-days.

**v1.3 carryover:** Phases 24.5 / 25 / 26 / 27 / 28 status preserved; v1.4 spawn does not block existing v1.3 phases. Coordination via STATE.md manual review per phase transition.

## Current Position

Phase: 29 (Eval Harness Extension) — NOT STARTED
Plan: 0 of 0 (planning pending — `/gsd:plan-phase 29` to start)
Status: Defining requirements (this turn)
Last activity: 2026-04-29 — milestone v1.4 spawned, P10 顶层设计 locked 16 decisions

## Adam's blocking decisions (none currently)

All 16 P10 decisions locked in `MILESTONE-v1.4-humanize-runtime-v2.md` Decision Log. No pending Adam questions for v1.4 spawn. First Adam decision point arrives end of Phase 30 (baseline interpretation).

## Recommended execution order

1. `/clear` then `/gsd:plan-phase 29` — Eval Harness Extension (must finish before Phase 30)
2. `/gsd:execute-phase 29` — wire 4 new axes + bilingual sentence splitter + new scenarios
3. `/gsd:plan-phase 30` then `/gsd:execute-phase 30` — Baseline measurement (locks 5-metric report; gates all subsequent phases)
4. `/gsd:plan-phase 31` then execute — Detectors
5. Phases 32-34 in roadmap order; Phase 35 (benchmarks) can parallelize with 33-34
6. Phase 36 ships behind feature flag `PA_HUMANIZE_RUNTIME_ENABLED`

## Milestone goal

Quantitative voice quality improvement: 5 metrics measurably better vs rev-00056 baseline + Claire stack ≥ Qwen-72B raw on ≥1 of 5 public benchmarks. No new LLM calls in production path. Latency stays under 12s p99.

## Accumulated Context (carried from v1.0/v1.1/v1.2/v1.3)

### v1.0/v1.1 baseline shipped

(see prior STATE.md history for detail; preserved below for context)

- Phase 1-9: Broker correctness + Dashboard shell + Memory evol + Scheduler + Phase 2/3 production hardening
- Phase 10/10.5: Agents SDK runtime cutover (gpt-5.4-nano default via Responses API)
- Phase 11.1: Persona card injection (closed 2026-04-27)
- Phase 14: Companion eval harness (LLM-as-judge + cost ceiling, 23 scenarios pass) — **REUSED for v1.4 D13**
- Phase 18-23: Voice v1 + Mirror + Normalizer + Sendblue + Proactive + Beta onboarding
- Phase 21: Sendblue cutover (shipped 2026-04-27)
- Phase 24: Voice quality baseline (executing in v1.2)
- Phases 24.5/25/26/27/28: v1.3 Productionize (planned/executing)

### v1.4-specific accumulated context

- **Two independent Deep Research reports** cross-validated original v1.4 architecture; both verdicts: PROCEED-WITH-MODIFICATIONS
- **Critic loop dropped** from architecture: 5 peer-reviewed papers show LLM judge bias on subjective style amplifies the same failures it tries to fix
- **Plutchik demoted** to internal scaffold: no clean Chinese mapping for 委屈/心疼/心累/不甘
- **Eval harness verified intact**: `tests/scenarios/{runner.mjs,pairwise-runner.mjs,judge.mjs,lib/voice-axes.mjs,lib/pairwise.mjs}` + 20+ scenarios + 33 zh + 15 en filler blacklist already exist — D13 locks reuse
- **Embedding stack verified**: `BAAI/bge-m3` already wired in `packages/memory/src/mem0.ts` via SiliconFlow — D14 locks no OpenAI embedding swap
- **External benchmarks verified open**: BotChat, CharacterEval, EmpatheticDialogues, ESConv, RoleLLM all 200 OK (Phase 35)
- **No prefix cache exists**: `atm-llm-runtime.ts:62` "cache" is profile credential TTL only — D7 locks adding SiliconFlow prefix cache POC

### Locked architecture decisions (carry forward, all v1.4 D-series in MILESTONE-v1.4-humanize-runtime-v2.md)

- ONE agent runtime = OpenAI Agents SDK; default LLM = gpt-5.4-nano via Responses API (v1.0)
- SiliconFlow gated fallback (`PA_AGENT_LLM_PROVIDER=siliconflow`)
- Mem0/Qdrant remains memory empowerment layer (Mem0 LLM/embedder = SiliconFlow Qwen + bge-m3)
- Sendblue is pure transport (v1.1)
- v1.4 D1-D16 (see milestone doc) — locked, do not re-litigate

### Adam-locked v1.4 constraints

- No model escalation (Qwen-7B class only)
- No fine-tuning
- 0 net new LLM calls in production path
- < 12s p99 per turn
- No LangGraph, no DSPy, no Reflexion-lite critic
- No new monorepo package — extend `packages/pa-orchestrator/src/voice/`
- Embedding = `BAAI/bge-m3` via SiliconFlow

### v1.4 backlog (explicit deferrals)

- Jones & Bergen 2024 5-min Turing test human-rater replication (~$300 + 7d, demographic mismatch) → v1.5
- TexturePool recruitment (10-user × 2h interview) → v1.5
- Big5-Chat trait scoring engineering → defer
- Reflexion-lite critic resurrection → would need new evidence
- LoCoMo memory benchmark → repo offline; revisit if reappears
- 250 hand-curated texture facts → v1.5
- EvoEmo full GA training pipeline → not borrowed (only MDP abstraction)
